package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func webSocketTestServer(t *testing.T, limit int) (*speedServer, *httptest.Server) {
	t.Helper()
	handler := testServer(t, limit)
	server := httptest.NewUnstartedServer(handler)
	server.Config.ConnContext = attachConnectionContext
	server.Start()
	handler.config.PublicOrigin = server.URL
	t.Cleanup(func() { handler.closeWebSockets(); server.Close() })
	return handler, server
}

func dialMeasurement(t *testing.T, server *httptest.Server, query string) (*websocket.Conn, string) {
	t.Helper()
	dialer := websocket.Dialer{HandshakeTimeout: time.Second, EnableCompression: true}
	headers := http.Header{"Origin": []string{server.URL}}
	conn, response, err := dialer.Dial(strings.Replace(server.URL, "http://", "ws://", 1)+"/api/ws?"+query, headers)
	if err != nil {
		t.Fatal(err)
	}
	if response.Header.Get("Sec-WebSocket-Extensions") != "" {
		t.Fatal("measurement WebSocket negotiated compression")
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	messageType, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var ready struct {
		Type         string `json:"type"`
		ConnectionID string `json:"connectionId"`
		Protocol     string `json:"protocol"`
	}
	if err := json.Unmarshal(payload, &ready); err != nil || messageType != websocket.TextMessage || ready.Type != "ready" || ready.ConnectionID == "" || ready.Protocol != "HTTP/1.1" {
		t.Fatalf("invalid WebSocket ready message: %s err=%v", payload, err)
	}
	return conn, ready.ConnectionID
}

func waitForNoMeasurements(t *testing.T, handler *speedServer) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for len(handler.requests) != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("measurement slots leaked: %d", len(handler.requests))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestWebSocketThirtyConnectionsAreThirtyTCPConnections(t *testing.T) {
	handler, server := webSocketTestServer(t, 32)
	session := handler.sessions.create(0, time.Second, time.Now())
	connections := make([]*websocket.Conn, 0, 30)
	defer func() {
		for _, conn := range connections {
			conn.Close()
		}
	}()
	ids := make(map[string]bool)
	for index := range 30 {
		conn, id := dialMeasurement(t, server, "direction=upload&session="+session.id)
		connections = append(connections, conn)
		if ids[id] {
			t.Fatalf("two WebSockets shared TCP id %s", id)
		}
		ids[id] = true
		if index == 7 {
			stats := session.snapshot(time.Now())
			if stats.ActiveTCPConnections != 8 || stats.PeakTCPConnections != 8 || stats.ConnectionsObserved != 8 {
				t.Fatalf("default eight sockets are not eight TCP connections: %+v", stats)
			}
		}
	}
	stats := session.snapshot(time.Now())
	if stats.ActiveRequests != 30 || stats.ActiveTCPConnections != 30 || stats.PeakTCPConnections != 30 || stats.ConnectionsObserved != 30 || stats.Started || stats.MeasuredBytes != 0 {
		t.Fatalf("30 TCP observation/queued byte accounting incorrect: %+v", stats)
	}
	if !handler.sessions.remove(session.id, time.Now()) {
		t.Fatal("session delete failed")
	}
	for _, conn := range connections {
		_, _, err := conn.ReadMessage()
		if !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
			t.Fatalf("session deletion did not close normally: %v", err)
		}
	}
	waitForNoMeasurements(t, handler)
	if stats := session.stats.snapshot(); stats.ActiveTCPConnections != 0 || stats.ActiveRequests != 0 || stats.PeakTCPConnections != 30 {
		t.Fatalf("deleted sockets did not settle: %+v", stats)
	}
}

func TestWebSocketUploadCountsPartialMessageAndFreezes(t *testing.T) {
	handler, server := webSocketTestServer(t, 2)
	session := handler.sessions.create(0, time.Second, time.Now())
	conn, _ := dialMeasurement(t, server, "direction=upload&session="+session.id)
	defer conn.Close()
	writer, err := conn.NextWriter(websocket.BinaryMessage)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(make([]byte, 20480)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for session.snapshot(time.Now()).MeasuredBytes != 16384 {
		if time.Now().After(deadline) {
			t.Fatal("partial WebSocket message was not measured before completion")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// The final fragment is still unsent: measured bytes came from actual body
	// reads, not a complete message event or client queue counter.
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	for session.snapshot(time.Now()).MeasuredBytes != 20480 {
		if time.Now().After(deadline) {
			t.Fatal("final upload fragment was not read")
		}
		time.Sleep(5 * time.Millisecond)
	}
	frozen := session.snapshot(time.Now().Add(2 * time.Second))
	_, _, err = conn.ReadMessage()
	if !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
		t.Fatalf("completed upload session close: %v", err)
	}
	conn.Close()
	waitForNoMeasurements(t, handler)
	if !frozen.Finished || frozen.MeasuredBytes != 20480 || frozen.TotalBytes != 20480 || frozen.MeasurementElapsedMS != 1000 {
		t.Fatalf("frozen WebSocket byte result: %+v", frozen)
	}
}

func TestWebSocketUploadDeadlineClosesNormally(t *testing.T) {
	handler, server := webSocketTestServer(t, 10)
	session := handler.sessions.create(0, time.Second, time.Now())
	defer session.stop()
	connections := make([]*websocket.Conn, 0, 8)
	defer func() {
		for _, conn := range connections {
			conn.Close()
		}
	}()
	for range 8 {
		conn, _ := dialMeasurement(t, server, "direction=upload&session="+session.id)
		connections = append(connections, conn)
		if err := conn.WriteMessage(websocket.BinaryMessage, make([]byte, 8192)); err != nil {
			t.Fatal(err)
		}
	}
	for _, conn := range connections {
		_, _, err := conn.ReadMessage()
		var closeError *websocket.CloseError
		if !errors.As(err, &closeError) || closeError.Code != websocket.CloseNormalClosure || closeError.Text != "session_finished" {
			t.Fatalf("normal upload window deadline produced abnormal closure: %v", err)
		}
		conn.Close()
	}
	waitForNoMeasurements(t, handler)
	frozen := session.snapshot(time.Now())
	if !frozen.Finished || frozen.MeasuredBytes != 8*8192 || frozen.MeasurementElapsedMS != 1000 {
		t.Fatalf("deadline changed authoritative byte counts: %+v", frozen)
	}
}

func TestWebSocketEarlyDisconnectDoesNotFinishUploadSession(t *testing.T) {
	handler, server := webSocketTestServer(t, 2)
	session := handler.sessions.create(0, time.Second, time.Now())
	defer session.stop()
	conn, _ := dialMeasurement(t, server, "direction=upload&session="+session.id)
	if err := conn.WriteMessage(websocket.BinaryMessage, make([]byte, 1024)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for session.snapshot(time.Now()).MeasuredBytes != 1024 {
		if time.Now().After(deadline) {
			t.Fatal("server did not receive upload before disconnect")
		}
		time.Sleep(5 * time.Millisecond)
	}
	conn.Close()
	waitForNoMeasurements(t, handler)
	if snapshot := session.snapshot(time.Now()); snapshot.Finished || snapshot.MeasurementElapsedMS >= 1000 {
		t.Fatalf("early disconnect was falsely marked finished: %+v", snapshot)
	}
}

func TestWebSocketBusyUploadCutoffDeliversNormalClose(t *testing.T) {
	handler, server := webSocketTestServer(t, 10)
	session := handler.sessions.create(0, time.Second, time.Now())
	defer session.stop()
	connections := make([]*websocket.Conn, 0, 8)
	defer func() {
		for _, conn := range connections {
			conn.Close()
		}
	}()
	for range 8 {
		conn, _ := dialMeasurement(t, server, "direction=upload&session="+session.id)
		connections = append(connections, conn)
	}
	payload := make([]byte, 1<<20)
	var writers sync.WaitGroup
	for _, conn := range connections {
		writers.Add(1)
		go func() {
			defer writers.Done()
			for {
				if conn.WriteMessage(websocket.BinaryMessage, payload) != nil {
					return
				}
			}
		}()
	}
	for _, conn := range connections {
		_, _, err := conn.ReadMessage()
		var closeError *websocket.CloseError
		if !errors.As(err, &closeError) || closeError.Code != websocket.CloseNormalClosure || closeError.Text != "session_finished" {
			t.Fatalf("busy upload cutoff lost normal close frame: %v", err)
		}
		conn.Close()
	}
	writers.Wait()
	waitForNoMeasurements(t, handler)
	frozen := session.snapshot(time.Now())
	if !frozen.Finished || frozen.MeasuredBytes <= 0 || frozen.MeasuredBytes != frozen.TotalBytes || frozen.MeasurementElapsedMS != 1000 {
		t.Fatalf("busy cutoff measurement accounting changed: %+v", frozen)
	}
	if after := session.snapshot(time.Now().Add(time.Second)); after.MeasuredBytes != frozen.MeasuredBytes || after.TotalBytes != frozen.TotalBytes {
		t.Fatal("closing transport bytes entered a frozen measurement")
	}
}

func TestWebSocketCloseDrainIsBoundedForNoncooperativePeer(t *testing.T) {
	handler, server := webSocketTestServer(t, 2)
	session := handler.sessions.create(0, time.Second, time.Now())
	defer session.stop()
	conn, _ := dialMeasurement(t, server, "direction=upload&session="+session.id)
	defer conn.Close()
	if err := conn.WriteMessage(websocket.BinaryMessage, make([]byte, 8192)); err != nil {
		t.Fatal(err)
	}
	// Intentionally neither read the closing handshake nor close TCP.
	started := time.Now()
	deadline := started.Add(time.Second + webSocketCloseGrace + 500*time.Millisecond)
	for len(handler.requests) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("noncooperative peer held a measurement slot beyond bounded close grace")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if elapsed := time.Since(started); elapsed < time.Second+webSocketCloseGrace-100*time.Millisecond {
		t.Fatalf("unanswered close was not given its bounded grace: %s", elapsed)
	}
	frozen := session.snapshot(time.Now())
	if !frozen.Finished || frozen.MeasuredBytes != 8192 || frozen.MeasurementElapsedMS != 1000 {
		t.Fatalf("close grace extended the measured window: %+v", frozen)
	}
}

func TestWebSocketProbeAndAdaptiveDownload(t *testing.T) {
	handler, server := webSocketTestServer(t, 2)
	probe, _ := dialMeasurement(t, server, "direction=probe")
	messageType, payload, err := probe.ReadMessage()
	if err != nil || messageType != websocket.BinaryMessage || len(payload) != 4096 {
		t.Fatalf("probe payload: type=%d size=%d err=%v", messageType, len(payload), err)
	}
	_, _, err = probe.ReadMessage()
	if !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
		t.Fatalf("probe closure: %v", err)
	}
	probe.Close()
	waitForNoMeasurements(t, handler)
	conn, _ := dialMeasurement(t, server, "direction=download&run=adaptive")
	defer conn.Close()
	messageType, payload, err = conn.ReadMessage()
	if err != nil || messageType != websocket.BinaryMessage || len(payload) != 4096 {
		t.Fatalf("initial small download message: %d/%d err=%v", messageType, len(payload), err)
	}
	if err := conn.WriteJSON(map[string]any{"type": "resize", "bytes": 1 << 20}); err != nil {
		t.Fatal(err)
	}
	for {
		_, payload, err = conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if len(payload) == 1<<20 {
			break
		}
	}
	conn.Close()
	waitForNoMeasurements(t, handler)
	if stats := handler.runs.get("adaptive", false, time.Now()).snapshot(); stats.PeakTCPConnections != 1 || stats.ActiveRequests != 0 {
		t.Fatalf("download socket lifecycle: %+v", stats)
	}
}

func TestWebSocketOriginMessageLimitAndType(t *testing.T) {
	handler, server := webSocketTestServer(t, 2)
	dialer := websocket.Dialer{HandshakeTimeout: time.Second}
	_, response, err := dialer.Dial(strings.Replace(server.URL, "http://", "ws://", 1)+"/api/ws?direction=probe", http.Header{"Origin": []string{"https://untrusted.example"}})
	if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("untrusted WebSocket origin accepted: %v %v", response, err)
	}
	for _, entry := range []struct {
		name      string
		kind      int
		size      int
		closeCode int
	}{
		{"text-upload", websocket.TextMessage, 8, websocket.CloseUnsupportedData},
		{"oversized-upload", websocket.BinaryMessage, maxWebSocketUploadMessageBytes + 1, websocket.CloseMessageTooBig},
	} {
		t.Run(entry.name, func(t *testing.T) {
			session := handler.sessions.create(0, time.Second, time.Now())
			defer session.stop()
			conn, _ := dialMeasurement(t, server, "direction=upload&session="+session.id)
			defer conn.Close()
			_ = conn.WriteMessage(entry.kind, make([]byte, entry.size))
			_, _, err := conn.ReadMessage()
			if !websocket.IsCloseError(err, entry.closeCode) {
				t.Fatalf("invalid upload close code: %v", err)
			}
			waitForNoMeasurements(t, handler)
		})
	}
}

func TestWebSocketShutdownClosesHijackedConnections(t *testing.T) {
	handler, server := webSocketTestServer(t, 2)
	session := handler.sessions.create(0, time.Second, time.Now())
	conn, _ := dialMeasurement(t, server, "direction=upload&session="+session.id)
	defer conn.Close()
	handler.closeWebSockets()
	_, _, err := conn.ReadMessage()
	if !websocket.IsCloseError(err, websocket.CloseGoingAway) {
		t.Fatalf("hijacked socket did not receive shutdown close: %v", err)
	}
	waitForNoMeasurements(t, handler)
	handler.webSockets.mu.Lock()
	remaining := len(handler.webSockets.connections)
	handler.webSockets.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("shutdown retained %d hijacked sockets", remaining)
	}
}

func TestTrustedWSSCreatesEightIndependentTLS13Connections(t *testing.T) {
	certificateSource := httptest.NewTLSServer(http.NotFoundHandler())
	defer certificateSource.Close()
	certificate := certificateSource.TLS.Certificates[0]
	privateKey, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	config := Config{Addr: "127.0.0.1:0"}
	config.TLSCertFile = filepath.Join(t.TempDir(), "certificate.pem")
	config.TLSKeyFile = filepath.Join(t.TempDir(), "private-key.pem")
	if err := os.WriteFile(config.TLSCertFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.TLSKeyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateKey}), 0600); err != nil {
		t.Fatal(err)
	}
	handler := testServer(t, 10)
	servers, listeners, err := bindServers(config, handler)
	if err != nil {
		t.Fatal(err)
	}
	origin := "https://" + listeners[0].Addr().String()
	handler.config.PublicOrigin = origin
	serverVersions := make(chan uint16, 8)
	servers[0].Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/ws" && r.TLS != nil {
			serverVersions <- r.TLS.Version
		}
		handler.ServeHTTP(w, r)
	})
	go func() { _ = servers[0].ServeTLS(listeners[0], "", "") }()
	defer func() {
		handler.closeWebSockets()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		shutdownServers(ctx, servers)
		for _, listener := range listeners {
			listener.Close()
		}
	}()
	roots := x509.NewCertPool()
	roots.AddCert(certificateSource.Certificate())
	dialer := websocket.Dialer{
		HandshakeTimeout: time.Second,
		TLSClientConfig:  &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13, NextProtos: []string{"http/1.1"}},
	}
	session := handler.sessions.create(0, 10*time.Second, time.Now())
	defer session.stop()
	ids := make(map[string]bool)
	connections := make([]*websocket.Conn, 0, 8)
	defer func() {
		for _, conn := range connections {
			conn.Close()
		}
	}()
	for range 8 {
		conn, _, err := dialer.Dial(strings.Replace(origin, "https://", "wss://", 1)+"/api/ws?direction=upload&session="+session.id, http.Header{"Origin": []string{origin}})
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, conn)
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		var ready struct {
			Type         string `json:"type"`
			ConnectionID string `json:"connectionId"`
			Protocol     string `json:"protocol"`
		}
		if err := conn.ReadJSON(&ready); err != nil {
			t.Fatal(err)
		}
		if ready.Type != "ready" || ready.Protocol != "HTTP/1.1" || ready.ConnectionID == "" || ids[ready.ConnectionID] {
			t.Fatalf("WSS did not create independent HTTP/1.1 connection: %+v", ready)
		}
		ids[ready.ConnectionID] = true
		tlsConn, ok := conn.UnderlyingConn().(*tls.Conn)
		if !ok {
			t.Fatal("WSS connection has no TLS transport")
		}
		state := tlsConn.ConnectionState()
		if state.Version != tls.VersionTLS13 || state.NegotiatedProtocol != "http/1.1" || len(state.VerifiedChains) == 0 {
			t.Fatalf("WSS TLS verification/negotiation incorrect: %+v", state)
		}
		if version := <-serverVersions; version != tls.VersionTLS13 {
			t.Fatalf("server accepted TLS version %x", version)
		}
	}
	if stats := session.stats.snapshot(); stats.ActiveTCPConnections != 8 || stats.PeakTCPConnections != 8 || stats.ConnectionsObserved != 8 {
		t.Fatalf("eight WSS flows did not yield eight TCP connections: %+v", stats)
	}
	for _, conn := range connections {
		if err := conn.WriteMessage(websocket.BinaryMessage, make([]byte, 8192)); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(time.Second)
	for session.snapshot(time.Now()).MeasuredBytes != 8*8192 {
		if time.Now().After(deadline) {
			t.Fatal("TLS upload data was not measured")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Force the authoritative window to finish while TLS readers are blocked.
	// Their timeout errors stay sticky; the closing transport must still send
	// the WS close, TLS close_notify, and TCP FIN in that order.
	session.snapshot(time.Now().Add(11 * time.Second))
	for _, conn := range connections {
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, _, err := conn.ReadMessage()
		var closeError *websocket.CloseError
		if !errors.As(err, &closeError) || closeError.Code != websocket.CloseNormalClosure || closeError.Text != "session_finished" {
			t.Fatalf("TLS normal close delivery lost: %v", err)
		}
		conn.Close()
	}
	waitForNoMeasurements(t, handler)
}
