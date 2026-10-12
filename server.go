package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	transferTimeout     = 90 * time.Second
	downloadBlockBytes  = 25 << 20
	sessionMaxBodyBytes = 1 << 30
)

type speedServer struct {
	config           Config
	web              fs.FS
	payload          []byte
	requests         chan struct{}
	sessions         *uploadSessions
	runs             downloadRuns
	readBuffers      sync.Pool
	webSockets       socketRegistry
	preparedDownload map[int]*websocket.PreparedMessage
}

func newSpeedServer(config Config, web fs.FS) (*speedServer, error) {
	if config.MaxConcurrentRequests < 1 {
		return nil, fmt.Errorf("transfer request limit must be positive")
	}
	// A shared, immutable 25 MiB block avoids making random generation the
	// bottleneck at high link speeds. Measurement responses use identity encoding
	// and no-transform: a proxy must not recompress this repeated random block.
	payload := make([]byte, downloadBlockBytes)
	if _, err := rand.Read(payload); err != nil {
		return nil, fmt.Errorf("generate measurement data: %w", err)
	}
	limit := config.UploadSessionLimit
	if limit == 0 {
		limit = 256
	}
	server := &speedServer{
		config: config, web: web, payload: payload,
		requests:    make(chan struct{}, config.MaxConcurrentRequests),
		sessions:    &uploadSessions{entries: make(map[string]*uploadSession), limit: limit},
		runs:        downloadRuns{entries: make(map[string]*downloadRun)},
		readBuffers: sync.Pool{New: func() any { buffer := make([]byte, 64<<10); return &buffer }},
	}
	if err := server.prepareWebSocketData(); err != nil {
		return nil, err
	}
	return server, nil
}

func (server *speedServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/healthz" {
		noStore(w)
		if !server.allowOrigin(w, r) {
			return
		}
	}
	if r.URL.Path == "/api/upload-sessions" || strings.HasPrefix(r.URL.Path, "/api/upload-sessions/") {
		server.sessionRoute(w, r)
		return
	}
	switch r.URL.Path {
	case "/api/ws":
		if requireMethod(w, r, http.MethodGet) {
			server.websocket(w, r)
		}
	case "/api/config":
		if requireMethod(w, r, http.MethodGet) {
			config, err := server.config.clientConfig(r)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid request origin")
				return
			}
			writeJSON(w, http.StatusOK, config)
		}
	case "/api/connection-stats":
		if requireMethod(w, r, http.MethodGet) {
			id := r.URL.Query().Get("run")
			if !validRunID(id) {
				writeError(w, http.StatusBadRequest, "invalid measurement run id")
				return
			}
			stats := server.runs.get(id, false, time.Now())
			if stats == nil {
				writeError(w, http.StatusNotFound, "measurement run not found or expired")
				return
			}
			writeJSON(w, http.StatusOK, stats.snapshot())
		}
	case "/api/ping":
		if requireMethod(w, r, http.MethodGet) {
			writeJSON(w, http.StatusOK, struct {
				NodeID     string `json:"nodeId"`
				ServerTime string `json:"serverTime"`
			}{server.config.NodeID, time.Now().UTC().Format(time.RFC3339Nano)})
		}
	case "/api/download":
		if requireMethod(w, r, http.MethodGet) {
			server.download(w, r)
		}
	case "/api/upload":
		if requireMethod(w, r, http.MethodPost) {
			server.upload(w, r)
		}
	case "/healthz":
		if requireMethod(w, r, http.MethodGet) {
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "nodeId": server.config.NodeID, "version": version})
		}
	default:
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeError(w, http.StatusNotFound, "API route not found")
			return
		}
		server.static(w, r)
	}
}

func (server *speedServer) serveMeasurementHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/download" && r.URL.Path != "/api/upload" && r.URL.Path != "/api/ws" && r.URL.Path != "/healthz" {
		noStore(w)
		writeError(w, http.StatusNotFound, "route is available only on the control listener")
		return
	}
	server.ServeHTTP(w, r)
}

func (server *speedServer) allowOrigin(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin != "" {
		mainOrigin, _, err := server.config.origins(r)
		if err != nil || origin != mainOrigin {
			writeError(w, http.StatusForbidden, "request origin is not allowed")
			return false
		}
		w.Header().Set("Access-Control-Allow-Origin", mainOrigin)
		w.Header().Add("Vary", "Origin")
		w.Header().Set("Access-Control-Expose-Headers", "X-Test-Connection-ID, X-Test-Protocol, Content-Length, Content-Encoding")
	}
	if r.Method != http.MethodOptions || (r.URL.Path != "/api/download" && r.URL.Path != "/api/upload") {
		return true
	}
	if origin == "" {
		writeError(w, http.StatusMethodNotAllowed, "preflight requires a trusted origin")
		return false
	}
	method := r.Header.Get("Access-Control-Request-Method")
	if method != http.MethodGet && method != http.MethodPost {
		writeError(w, http.StatusForbidden, "preflight method is not allowed")
		return false
	}
	for _, header := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
		if header = strings.TrimSpace(header); header != "" && !strings.EqualFold(header, "Content-Type") {
			writeError(w, http.StatusForbidden, "preflight header is not allowed")
			return false
		}
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.WriteHeader(http.StatusNoContent)
	return false
}

func measurementHeaders(w http.ResponseWriter, r *http.Request) {
	if id := connectionID(r); id != "" {
		w.Header().Set("X-Test-Connection-ID", id)
	}
	w.Header().Set("X-Test-Protocol", r.Proto)
}

func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, no-transform")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
}

func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	return false
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeSessionFinished(w http.ResponseWriter, message string) {
	writeJSON(w, http.StatusConflict, map[string]string{"error": message, "code": "session_finished"})
}

func (server *speedServer) acquire(w http.ResponseWriter, r *http.Request) bool {
	if r.Context().Err() != nil {
		return false
	}
	select {
	case server.requests <- struct{}{}:
		return true
	default:
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusServiceUnavailable, "measurement node is busy; retry shortly")
		return false
	}
}

func (server *speedServer) download(w http.ResponseWriter, r *http.Request) {
	count := int64(defaultDownloadBytes)
	stream := r.URL.Query().Get("stream") == "1"
	if stream && r.URL.Query().Has("bytes") {
		writeError(w, http.StatusBadRequest, "stream and bytes cannot be combined")
		return
	}
	if value := r.URL.Query().Get("stream"); value != "" && value != "1" {
		writeError(w, http.StatusBadRequest, "stream must be 1 when provided")
		return
	}
	if value, present := r.URL.Query()["bytes"]; present {
		if len(value) != 1 {
			writeError(w, http.StatusBadRequest, "bytes must be provided once")
			return
		}
		var err error
		count, err = strconv.ParseInt(value[0], 10, 64)
		if err != nil || count < 1 || count > maxTransferBytes {
			writeError(w, http.StatusBadRequest, "bytes must be an integer between 1 and 67108864")
			return
		}
	}
	if !server.acquire(w, r) {
		return
	}
	defer func() { <-server.requests }()
	id := r.URL.Query().Get("run")
	if id != "" {
		if !validRunID(id) {
			writeError(w, http.StatusBadRequest, "invalid measurement run id")
			return
		}
		stats := server.runs.get(id, true, time.Now())
		if stats == nil {
			writeError(w, http.StatusServiceUnavailable, "measurement run limit reached")
			return
		}
		defer stats.enter(r)()
	}
	controller := http.NewResponseController(w)
	deadline := time.Now().Add(transferTimeout)
	_ = controller.SetWriteDeadline(deadline)
	measurementHeaders(w, r)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Encoding", "identity")
	if !stream {
		w.Header().Set("Content-Length", strconv.FormatInt(count, 10))
	}
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if stream {
		if err := controller.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
			return
		}
	}
	for stream || count > 0 {
		if r.Context().Err() != nil || time.Now().After(deadline) {
			return
		}
		length := min(count, int64(len(server.payload)))
		if stream {
			length = int64(len(server.payload))
		}
		n, err := w.Write(server.payload[:int(length)])
		if err != nil || int64(n) != length {
			return
		}
		if !stream {
			count -= int64(n)
		}
	}
}

func (server *speedServer) upload(w http.ResponseWriter, r *http.Request) {
	maxBody := int64(maxTransferBytes)
	var session *uploadSession
	if id := r.URL.Query().Get("session"); id != "" {
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
		maxBody = sessionMaxBodyBytes
	}
	if r.ContentLength > maxBody {
		writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds request byte limit")
		return
	}
	if !server.acquire(w, r) {
		return
	}
	defer func() { <-server.requests }()
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(transferTimeout))
	_ = controller.SetWriteDeadline(time.Now().Add(transferTimeout))
	measurementHeaders(w, r)
	if session != nil {
		defer session.stats.enter(r)()
		stopDeadline := context.AfterFunc(session.ctx, func() { _ = controller.SetReadDeadline(time.Now()) })
		defer stopDeadline()
	}
	start := time.Now()
	body := http.MaxBytesReader(w, r.Body, maxBody)
	defer body.Close()
	var count int64
	var err error
	if session == nil {
		count, err = io.Copy(io.Discard, body)
	} else {
		buffer := server.readBuffers.Get().(*[]byte)
		defer server.readBuffers.Put(buffer)
		deadlineSet := false
		for {
			if session.ctx.Err() != nil {
				err = context.Canceled
				break
			}
			var n int
			n, err = body.Read(*buffer)
			if n > 0 {
				count += int64(n)
				end, accepting := session.record(int64(n), time.Now())
				if !accepting {
					err = context.Canceled
					break
				}
				if !deadlineSet {
					_ = controller.SetReadDeadline(end)
					// A DELETE may race this first deadline assignment. Preserve
					// the cancellation deadline rather than reopening the window.
					if session.ctx.Err() != nil {
						_ = controller.SetReadDeadline(time.Now())
					}
					deadlineSet = true
				}
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					err = nil
				}
				break
			}
		}
	}
	if err != nil {
		var limitError *http.MaxBytesError
		if errors.As(err, &limitError) {
			writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds request byte limit")
		} else if session != nil && session.snapshot(time.Now()).Finished {
			writeSessionFinished(w, "upload measurement window is complete; body was not fully consumed")
		} else if r.Context().Err() == nil {
			writeError(w, http.StatusBadRequest, "upload body could not be read completely")
		}
		return
	}
	if r.Context().Err() != nil {
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Bytes      int64   `json:"bytes"`
		DurationMS float64 `json:"durationMs"`
	}{count, float64(time.Since(start).Nanoseconds()) / 1e6})
}

func (server *speedServer) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	if !fs.ValidPath(name) || path.Clean(name) != name || strings.HasPrefix(name, ".") {
		http.NotFound(w, r)
		return
	}
	content, err := fs.ReadFile(server.web, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Frame-Options", "DENY")
	_, origins, err := server.config.origins(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid request origin")
		return
	}
	connectOrigins := append([]string{}, origins...)
	for _, origin := range origins {
		connectOrigins = append(connectOrigins, strings.Replace(strings.Replace(origin, "https://", "wss://", 1), "http://", "ws://", 1))
	}
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' "+strings.Join(connectOrigins, " ")+"; img-src 'self' data:; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(content))
}
