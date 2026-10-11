package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestUploadSessionMeasuresServerReadsAndFreezesWindow(t *testing.T) {
	now := time.Now()
	session := newUploadSession("measurement", now, 100*time.Millisecond, time.Second)
	defer session.stop()
	if snapshot := session.snapshot(now); snapshot.Started || snapshot.MeasuredBytes != 0 || snapshot.MeasurementElapsedMS != 0 {
		t.Fatalf("session started before body arrival: %+v", snapshot)
	}
	session.record(100, now)
	session.record(200, now.Add(50*time.Millisecond))
	session.record(800, now.Add(200*time.Millisecond))
	session.record(1200, now.Add(500*time.Millisecond))
	snapshot := session.snapshot(now.Add(500 * time.Millisecond))
	if !snapshot.Started || snapshot.Finished || snapshot.TotalBytes != 2300 || snapshot.MeasuredBytes != 2000 || snapshot.MeasurementElapsedMS != 400 || snapshot.Mbps != .04 {
		t.Fatalf("warmup or arrival measurement incorrect: %+v", snapshot)
	}
	snapshot = session.snapshot(now.Add(2 * time.Second))
	if !snapshot.Finished || snapshot.MeasurementElapsedMS != 1000 || snapshot.Mbps != .016 {
		t.Fatalf("completed measurement did not use fixed duration: %+v", snapshot)
	}
	if _, accepting := session.record(9999, now.Add(3*time.Second)); accepting {
		t.Fatal("completed session accepted more measurement bytes")
	}
	if after := session.snapshot(now.Add(5 * time.Second)); after.MeasuredBytes != snapshot.MeasuredBytes || after.TotalBytes != snapshot.TotalBytes || after.Mbps != snapshot.Mbps {
		t.Fatalf("completed measurement changed: before=%+v after=%+v", snapshot, after)
	}
}

func TestConcurrentUploadCountersFreezeWithoutLosingAcceptedReads(t *testing.T) {
	now := time.Now()
	session := newUploadSession("concurrent", now, 0, time.Second)
	defer session.stop()
	var accepted atomic.Int64
	var workers sync.WaitGroup
	started := make(chan struct{}, 24)
	for range 24 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range 20000 {
				_, accepting := session.record(4096, now)
				if accepting {
					accepted.Add(4096)
				}
				if index == 0 {
					started <- struct{}{}
				}
				if !accepting {
					return
				}
			}
		}()
	}
	for range 24 {
		<-started
	}
	frozen := session.snapshot(now.Add(2 * time.Second))
	workers.Wait()
	if !frozen.Finished || frozen.MeasuredBytes != accepted.Load() || frozen.TotalBytes != accepted.Load() {
		t.Fatalf("finish lost accepted concurrent arrival counts: snapshot=%+v accepted=%d", frozen, accepted.Load())
	}
	if after := session.snapshot(now.Add(10 * time.Second)); after.MeasuredBytes != frozen.MeasuredBytes || after.Mbps != frozen.Mbps {
		t.Fatalf("atomic result changed after finish: before=%+v after=%+v", frozen, after)
	}
}

func TestSessionCapacityExpirationAndDeletion(t *testing.T) {
	now := time.Now()
	sessions := &uploadSessions{entries: make(map[string]*uploadSession), limit: 1}
	first := sessions.create(0, time.Second, now)
	if first == nil || sessions.create(0, time.Second, now) != nil {
		t.Fatal("session capacity was not enforced")
	}
	if sessions.get(first.id, now.Add(sessionTTL)) != nil || first.ctx.Err() == nil {
		t.Fatal("expired session was not removed and cancelled")
	}
	second := sessions.create(0, time.Second, now.Add(sessionTTL))
	if second == nil || !sessions.remove(second.id, now.Add(sessionTTL)) || second.ctx.Err() == nil {
		t.Fatal("deleted session was not cancelled")
	}
}

func TestUploadSessionRoutesValidateSettingsAndLimits(t *testing.T) {
	server := testServer(t, 2)
	server.sessions.limit = 1
	for _, body := range []string{
		`{"durationMs":999,"warmupMs":0}`,
		`{"durationMs":60001,"warmupMs":0}`,
		`{"durationMs":1000,"warmupMs":10001}`,
		`{"durationMs":1000,"warmupMs":-1}`,
		`{"durationMs":1000.5,"warmupMs":0}`,
		`{"durationMs":1000,"unknown":true}`,
		`{"durationMs":1000} {"durationMs":2000}`,
		`[1,2,3]`,
	} {
		if w := request(server, http.MethodPost, "/api/upload-sessions", strings.NewReader(body)); w.Code != http.StatusBadRequest {
			t.Errorf("invalid session settings %s accepted: %d", body, w.Code)
		}
	}
	w := request(server, http.MethodPost, "/api/upload-sessions", strings.NewReader(`{"durationMs":1000,"warmupMs":0}`))
	var created uploadSnapshot
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || w.Code != http.StatusCreated || created.ID == "" || created.Started {
		t.Fatalf("session create: status=%d body=%s err=%v", w.Code, w.Body, err)
	}
	if w := request(server, http.MethodPost, "/api/upload-sessions", strings.NewReader(`{"durationMs":1000,"warmupMs":0}`)); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("session endpoint ignored capacity: %d", w.Code)
	}
	tooLarge := httptest.NewRequest(http.MethodPost, "/api/upload?session="+created.ID, strings.NewReader("x"))
	tooLarge.ContentLength = sessionMaxBodyBytes + 1
	w = httptest.NewRecorder()
	server.ServeHTTP(w, tooLarge)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized session upload accepted: %d", w.Code)
	}
	if w := request(server, http.MethodDelete, "/api/upload-sessions/"+created.ID, nil); w.Code != http.StatusNoContent {
		t.Fatalf("session delete: %d", w.Code)
	}
	if w := request(server, http.MethodGet, "/api/upload-sessions/"+created.ID, nil); w.Code != http.StatusNotFound {
		t.Fatalf("deleted session remained accessible: %d", w.Code)
	}
	if w := request(server, http.MethodPost, "/api/upload?session="+created.ID, strings.NewReader("x")); w.Code != http.StatusNotFound {
		t.Fatalf("deleted session accepted upload: %d", w.Code)
	}
}

type progressBody struct {
	first   bool
	arrived chan struct{}
	release chan struct{}
}

func (body *progressBody) Read(p []byte) (int, error) {
	if !body.first {
		body.first = true
		clear(p[:16384])
		return 16384, nil
	}
	close(body.arrived)
	<-body.release
	return 0, io.EOF
}

func TestUploadProgressCountsReceivedBytesBeforeAcknowledgement(t *testing.T) {
	server := testServer(t, 2)
	session := server.sessions.create(0, time.Second, time.Now())
	defer session.stop()
	body := &progressBody{arrived: make(chan struct{}), release: make(chan struct{})}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- request(server, http.MethodPost, "/api/upload?session="+session.id, body) }()
	select {
	case <-body.arrived:
	case <-time.After(time.Second):
		t.Fatal("upload body did not arrive")
	}
	w := request(server, http.MethodGet, "/api/upload-sessions/"+session.id, nil)
	var snapshot uploadSnapshot
	if err := json.Unmarshal(w.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if !snapshot.Started || snapshot.MeasuredBytes != 16384 || snapshot.ActiveRequests != 1 || snapshot.Finished {
		t.Fatalf("partial body was not measured before acknowledgement: %+v", snapshot)
	}
	select {
	case <-done:
		t.Fatal("upload was acknowledged before body completion")
	default:
	}
	close(body.release)
	select {
	case response := <-done:
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"bytes":16384`) {
			t.Fatalf("complete upload acknowledgement: %d %s", response.Code, response.Body)
		}
	case <-time.After(time.Second):
		t.Fatal("upload did not complete")
	}
}

func TestObservedConnectionsDistinguishTCPFromHTTPStreams(t *testing.T) {
	stats := newConnectionStats()
	requestFor := func(id string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/api/download?stream=1", nil)
		r.Proto = "HTTP/2.0"
		return r.WithContext(context.WithValue(r.Context(), connectionContextKey{}, id))
	}
	first := stats.enter(requestFor("one-tcp"))
	second := stats.enter(requestFor("one-tcp"))
	third := stats.enter(requestFor("two-tcp"))
	snapshot := stats.snapshot()
	if snapshot.ActiveRequests != 3 || snapshot.ActiveTCPConnections != 2 || snapshot.PeakTCPConnections != 2 || snapshot.ConnectionsObserved != 2 || len(snapshot.Protocols) != 1 || snapshot.Protocols[0] != "HTTP/2.0" {
		t.Fatalf("HTTP stream count was mistaken for TCP count: %+v", snapshot)
	}
	first()
	second()
	third()
	if snapshot := stats.snapshot(); snapshot.ActiveRequests != 0 || snapshot.ActiveTCPConnections != 0 || snapshot.PeakTCPConnections != 2 {
		t.Fatalf("connection observations did not settle: %+v", snapshot)
	}
}

func TestCORSTrustedMainOriginAndPreflight(t *testing.T) {
	server := testServer(t, 1)
	server.config.PublicOrigin = "http://localhost:8080"
	server.config.MeasurementOrigins = []string{"http://localhost:8081"}
	for _, entry := range []struct {
		origin string
		header string
		status int
	}{
		{"http://localhost:8080", "content-type", http.StatusNoContent},
		{"http://localhost:8080", "authorization", http.StatusForbidden},
		{"https://untrusted.example", "content-type", http.StatusForbidden},
		{"null", "content-type", http.StatusForbidden},
	} {
		r := httptest.NewRequest(http.MethodOptions, "http://localhost:8081/api/upload", nil)
		r.Header.Set("Origin", entry.origin)
		r.Header.Set("Access-Control-Request-Method", "POST")
		r.Header.Set("Access-Control-Request-Headers", entry.header)
		w := httptest.NewRecorder()
		server.serveMeasurementHTTP(w, r)
		if w.Code != entry.status {
			t.Errorf("preflight %s/%s status=%d want=%d", entry.origin, entry.header, w.Code, entry.status)
		}
		if entry.status == http.StatusNoContent && (w.Header().Get("Access-Control-Allow-Origin") != entry.origin || !strings.Contains(w.Header().Get("Access-Control-Expose-Headers"), "X-Test-Connection-ID")) {
			t.Errorf("trusted measurement CORS headers missing: %v", w.Header())
		}
	}
	if w := request(http.HandlerFunc(server.serveMeasurementHTTP), http.MethodGet, "/api/config", nil); w.Code != http.StatusNotFound {
		t.Fatalf("data listener exposed control configuration: %d", w.Code)
	}
	w := request(server, http.MethodGet, "/", nil)
	if !strings.Contains(w.Header().Get("Content-Security-Policy"), "connect-src 'self' http://localhost:8081") {
		t.Fatalf("CSP does not permit configured measurement origins: %v", w.Header())
	}
}

func TestRealStreamingCancellationAndTCPIdentity(t *testing.T) {
	handler := testServer(t, 2)
	server := httptest.NewUnstartedServer(handler)
	server.Config.ConnContext = attachConnectionContext
	server.Start()
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/download?stream=1&run=cancel-test", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	if response.ContentLength != -1 || response.Header.Get("X-Test-Connection-ID") == "" || response.Header.Get("X-Test-Protocol") != "HTTP/1.1" {
		t.Fatalf("continuous response metadata incorrect: %v length=%d", response.Header, response.ContentLength)
	}
	if _, err := io.ReadFull(response.Body, make([]byte, 1024)); err != nil {
		t.Fatal(err)
	}
	cancel()
	response.Body.Close()
	deadline := time.Now().Add(time.Second)
	for {
		stats := handler.runs.get("cancel-test", false, time.Now()).snapshot()
		if stats.ActiveRequests == 0 {
			if stats.PeakTCPConnections != 1 || stats.ConnectionsObserved != 1 || len(handler.requests) != 0 {
				t.Fatalf("cancelled stream stats incorrect: %+v slots=%d", stats, len(handler.requests))
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cancelled continuous download retained active request")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestRealUploadSessionDeletionInterruptsAnIncompleteBody(t *testing.T) {
	handler := testServer(t, 2)
	session := handler.sessions.create(0, time.Second, time.Now())
	server := httptest.NewUnstartedServer(handler)
	server.Config.ConnContext = attachConnectionContext
	server.Start()
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/api/upload?session="+session.id, reader)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/octet-stream")
	responseDone := make(chan error, 1)
	go func() {
		response, err := server.Client().Do(r)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				err = io.ErrUnexpectedEOF // An incomplete body must never get a success ACK.
			}
		}
		responseDone <- err
	}()
	if _, err := writer.Write(make([]byte, 16384)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for session.snapshot(time.Now()).MeasuredBytes != 16384 {
		if time.Now().After(deadline) {
			t.Fatal("server did not measure partial upload")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if snapshot := session.snapshot(time.Now()); snapshot.ActiveRequests != 1 || snapshot.PeakTCPConnections != 1 || snapshot.ConnectionsObserved != 1 {
		t.Fatalf("partial upload TCP observation: %+v", snapshot)
	}
	if !handler.sessions.remove(session.id, time.Now()) {
		t.Fatal("session could not be deleted")
	}
	select {
	case err := <-responseDone:
		if err == io.ErrUnexpectedEOF {
			t.Fatal("incomplete upload was acknowledged as complete")
		}
	case <-time.After(time.Second):
		t.Fatal("deleted session retained an incomplete HTTP body read")
	}
	if len(handler.requests) != 0 {
		t.Fatal("deleted upload retained a transfer slot")
	}
}
