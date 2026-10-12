package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	webSocketMessageBytes          = 1 << 20
	maxWebSocketUploadMessageBytes = 4 << 20
	webSocketCloseGrace            = time.Second
	maxWebSocketCloseDrainBytes    = 16 << 20
)

type socketRegistry struct {
	mu          sync.Mutex
	closed      bool
	connections map[*websocket.Conn]struct{}
	active      sync.WaitGroup
}

func (registry *socketRegistry) add(conn *websocket.Conn) bool {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if registry.closed {
		return false
	}
	registry.connections[conn] = struct{}{}
	registry.active.Add(1)
	return true
}

func (registry *socketRegistry) remove(conn *websocket.Conn) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	delete(registry.connections, conn)
	registry.active.Done()
}

func closeSocket(conn *websocket.Conn, code int, reason string) {
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(200*time.Millisecond))
	_ = conn.Close()
}

func (server *speedServer) closeWebSockets() {
	server.webSockets.mu.Lock()
	server.webSockets.closed = true
	connections := make([]*websocket.Conn, 0, len(server.webSockets.connections))
	for conn := range server.webSockets.connections {
		connections = append(connections, conn)
	}
	server.webSockets.mu.Unlock()
	var group sync.WaitGroup
	for _, conn := range connections {
		group.Add(1)
		go func() { defer group.Done(); closeSocket(conn, websocket.CloseGoingAway, "server_shutdown") }()
	}
	group.Wait()
	server.webSockets.active.Wait()
}

func (server *speedServer) prepareWebSocketData() error {
	server.webSockets.connections = make(map[*websocket.Conn]struct{})
	server.preparedDownload = make(map[int]*websocket.PreparedMessage)
	for size := 1024; size <= webSocketMessageBytes; size *= 2 {
		message, err := websocket.NewPreparedMessage(websocket.BinaryMessage, server.payload[:size])
		if err != nil {
			return fmt.Errorf("prepare WebSocket measurement data: %w", err)
		}
		server.preparedDownload[size] = message
	}
	return nil
}

func (server *speedServer) websocket(w http.ResponseWriter, r *http.Request) {
	direction := r.URL.Query().Get("direction")
	var stats *connectionStats
	var session *uploadSession
	switch direction {
	case "download":
		id := r.URL.Query().Get("run")
		if !validRunID(id) {
			writeError(w, http.StatusBadRequest, "invalid measurement run id")
			return
		}
		stats = server.runs.get(id, true, time.Now())
		if stats == nil {
			writeError(w, http.StatusServiceUnavailable, "measurement run limit reached")
			return
		}
	case "upload":
		id := r.URL.Query().Get("session")
		if !validRunID(id) {
			writeError(w, http.StatusBadRequest, "invalid upload session id")
			return
		}
		session = server.sessions.get(id, time.Now())
		if session == nil {
			writeError(w, http.StatusNotFound, "upload session not found or expired")
			return
		}
		if session.snapshot(time.Now()).Finished {
			writeSessionFinished(w, "upload measurement window is complete")
			return
		}
		stats = session.stats
	case "probe":
	default:
		writeError(w, http.StatusBadRequest, "direction must be probe, download or upload")
		return
	}
	if !server.acquire(w, r) {
		return
	}
	defer func() { <-server.requests }()
	upgrader := websocket.Upgrader{
		HandshakeTimeout: 5 * time.Second, ReadBufferSize: 4096, WriteBufferSize: 4096,
		EnableCompression: false,
		CheckOrigin: func(request *http.Request) bool {
			origin := request.Header.Get("Origin")
			mainOrigin, _, err := server.config.origins(request)
			return err == nil && (origin == "" || origin == mainOrigin)
		},
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	if !server.webSockets.add(conn) {
		closeSocket(conn, websocket.CloseGoingAway, "server_shutdown")
		return
	}
	defer server.webSockets.remove(conn)
	defer conn.Close()
	if stats != nil {
		defer stats.enter(r)()
	}
	conn.EnableWriteCompression(false)
	deadline := time.Now().Add(transferTimeout)
	_ = conn.SetReadDeadline(deadline)
	_ = conn.SetWriteDeadline(deadline)
	conn.SetReadLimit(maxWebSocketUploadMessageBytes)
	if err := conn.WriteJSON(struct {
		Type         string `json:"type"`
		ConnectionID string `json:"connectionId"`
		Protocol     string `json:"protocol"`
	}{"ready", connectionID(r), r.Proto}); err != nil {
		return
	}
	if direction == "probe" {
		if err := conn.WriteMessage(websocket.BinaryMessage, server.payload[:4096]); err == nil {
			closeSocket(conn, websocket.CloseNormalClosure, "probe_complete")
		}
		return
	}
	if direction == "upload" {
		server.webSocketUpload(conn, session)
		return
	}
	// Browsers send close/control frames on cancellation. A dedicated reader
	// processes them and interrupts a pending prepared write promptly.
	readDone := make(chan struct{})
	var messageBytes atomic.Int32
	messageBytes.Store(4096)
	conn.SetReadLimit(4096)
	go func() {
		defer close(readDone)
		defer conn.Close()
		for {
			messageType, reader, err := conn.NextReader()
			if err != nil {
				return
			}
			if messageType != websocket.TextMessage {
				closeSocket(conn, websocket.CloseUnsupportedData, "resize_text_required")
				return
			}
			var resize struct {
				Type  string `json:"type"`
				Bytes int    `json:"bytes"`
			}
			decoder := json.NewDecoder(reader)
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&resize); err != nil {
				closeSocket(conn, websocket.CloseInvalidFramePayloadData, "invalid_resize")
				return
			}
			var extra any
			if err := decoder.Decode(&extra); err != io.EOF || resize.Type != "resize" || resize.Bytes < 1024 || resize.Bytes > webSocketMessageBytes || resize.Bytes&(resize.Bytes-1) != 0 {
				closeSocket(conn, websocket.ClosePolicyViolation, "invalid_resize")
				return
			}
			messageBytes.Store(int32(resize.Bytes))
		}
	}()
	for time.Now().Before(deadline) {
		if err := conn.WritePreparedMessage(server.preparedDownload[int(messageBytes.Load())]); err != nil {
			break
		}
	}
	_ = conn.Close()
	<-readDone
}

func (server *speedServer) webSocketUpload(conn *websocket.Conn, session *uploadSession) {
	var normalClose sync.Once
	closeSent := false
	closeFinished := func() {
		normalClose.Do(func() {
			// Keep the read side open until the sole upload reader can discard
			// queued bytes. Closing TCP here with unread bytes can reset the
			// connection before the peer receives this normal close frame.
			closeSent = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "session_finished"), time.Now().Add(200*time.Millisecond)) == nil
			_ = conn.UnderlyingConn().SetReadDeadline(time.Now())
		})
	}
	stopClose := context.AfterFunc(session.ctx, closeFinished)
	buffer := server.readBuffers.Get().(*[]byte)
	defer server.readBuffers.Put(buffer)
	defer func() {
		// A socket read deadline can fire before the session timer's callback.
		// Finish the authoritative window and send its close frame before the
		// outer connection cleanup can turn a normal cutoff into an EOF.
		if session.snapshot(time.Now()).Finished {
			closeFinished()
			if closeSent {
				// DELETE skips the grace wait; global shutdown independently
				// closes the registered socket and interrupts any active drain.
				drain := server.sessions.get(session.id, time.Now()) == session
				finishUploadWebSocketTransport(conn, *buffer, drain)
			}
		}
		stopClose()
	}()
	deadlineSet := false
	for session.ctx.Err() == nil {
		messageType, reader, err := conn.NextReader()
		if err != nil {
			return
		}
		if messageType != websocket.BinaryMessage {
			closeSocket(conn, websocket.CloseUnsupportedData, "binary_messages_required")
			return
		}
		for session.ctx.Err() == nil {
			count, err := reader.Read(*buffer)
			if count > 0 {
				end, accepting := session.record(int64(count), time.Now())
				if !accepting {
					return
				}
				if !deadlineSet {
					_ = conn.SetReadDeadline(end)
					deadlineSet = true
				}
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				return
			}
		}
	}
}

func finishUploadWebSocketTransport(conn *websocket.Conn, buffer []byte, drain bool) {
	transport := conn.UnderlyingConn()
	deadline := time.Now().Add(webSocketCloseGrace)
	_ = transport.SetWriteDeadline(deadline)
	_ = transport.SetReadDeadline(deadline)
	// TCP FIN follows the written close frame. TLS sends close_notify while
	// preserving its read side. Both let the peer observe orderly completion.
	if halfClose, ok := transport.(interface{ CloseWrite() error }); ok {
		_ = halfClose.CloseWrite()
	}
	// A timed-out tls.Conn also retains its read error. Its TLS writes are
	// finished now, so discard remaining ciphertext from the underlying TCP
	// connection rather than trying to resume either protocol reader.
	if wrapped, ok := transport.(interface{ NetConn() net.Conn }); ok {
		transport = wrapped.NetConn()
		_ = transport.SetReadDeadline(deadline)
		_ = transport.SetWriteDeadline(deadline)
		if halfClose, ok := transport.(interface{ CloseWrite() error }); ok {
			_ = halfClose.CloseWrite()
		}
	}
	if !drain {
		return
	}
	// Gorilla's reader retains timeout errors, so do not reuse NextReader here.
	// Raw transport reads have one owner, fixed memory, byte/time limits, and
	// never enter session.record: the measurement has already been frozen.
	remaining := int64(maxWebSocketCloseDrainBytes)
	for remaining > 0 && time.Now().Before(deadline) {
		count, err := transport.Read(buffer[:min(int64(len(buffer)), remaining)])
		remaining -= int64(count)
		if err != nil {
			return
		}
	}
}
