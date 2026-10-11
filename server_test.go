package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func testServer(t *testing.T, limit int) *speedServer {
	t.Helper()
	server, err := newSpeedServer(Config{
		NodeID: "test-node", NodeName: "测试节点", MaxConcurrentRequests: limit,
		DownloadDurationMS: 10000, UploadDurationMS: 10000, WarmupMS: 1500,
	}, fstest.MapFS{
		"index.html": {Data: []byte("<!doctype html><title>测速</title>")},
		"app.js":     {Data: []byte("console.log('local asset')")},
	})
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func request(server http.Handler, method, path string, body io.Reader) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	server.ServeHTTP(w, httptest.NewRequest(method, path, body))
	return w
}

func TestConfigPingAndHealth(t *testing.T) {
	server := testServer(t, 2)
	w := request(server, http.MethodGet, "/api/config", nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("config status/cache: %d %v", w.Code, w.Header())
	}
	var config clientConfig
	if err := json.Unmarshal(w.Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	if config.ProtocolVersion != 2 || len(config.Nodes) != 1 || config.Nodes[0].ID != "test-node" || config.Nodes[0].BaseURL != "" || config.Test.DownloadChunkBytes != defaultDownloadBytes || config.Test.MaxStreams != 4 || !config.Features.LoadedLatency {
		t.Fatalf("unexpected public protocol: %+v", config)
	}
	w = request(server, http.MethodGet, "/api/ping?nonce=uncached", nil)
	var ping struct {
		NodeID     string `json:"nodeId"`
		ServerTime string `json:"serverTime"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &ping); err != nil {
		t.Fatal(err)
	}
	if _, err := time.Parse(time.RFC3339Nano, ping.ServerTime); err != nil || ping.NodeID != "test-node" || !strings.Contains(w.Header().Get("Cache-Control"), "no-transform") {
		t.Fatalf("invalid ping response: %s %v", w.Body, w.Header())
	}
	if w := request(server, http.MethodGet, "/healthz", nil); w.Code != http.StatusOK {
		t.Fatalf("health status: %d", w.Code)
	}
}

func TestDownloadTransfersExactUncompressedBytes(t *testing.T) {
	server := testServer(t, 2)
	const size = (1 << 20) + 37
	w := request(server, http.MethodGet, "/api/download?bytes="+strconv.Itoa(size)+"&nonce=123", nil)
	if w.Code != http.StatusOK || w.Body.Len() != size || w.Header().Get("Content-Length") != strconv.Itoa(size) || w.Header().Get("Content-Encoding") != "identity" || w.Header().Get("X-Accel-Buffering") != "no" {
		t.Fatalf("incorrect measurement body: status=%d bytes=%d headers=%v", w.Code, w.Body.Len(), w.Header())
	}
	var compressed bytes.Buffer
	zipped := gzip.NewWriter(&compressed)
	if _, err := zipped.Write(w.Body.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	if compressed.Len() < size*99/100 {
		t.Fatalf("measurement payload is compressible: %d compressed / %d raw", compressed.Len(), size)
	}
	if len(server.requests) != 0 {
		t.Fatal("completed transfer retained a concurrency slot")
	}
}

func TestDownloadRejectsInvalidSizes(t *testing.T) {
	server := testServer(t, 1)
	for _, query := range []string{"bytes=0", "bytes=-1", "bytes=67108865", "bytes=nope", "bytes=", "bytes=10&bytes=20", "bytes=99999999999999999999999"} {
		if w := request(server, http.MethodGet, "/api/download?"+query, nil); w.Code != http.StatusBadRequest {
			t.Errorf("%s status=%d, want 400", query, w.Code)
		}
	}
}

func TestUploadAcknowledgesOnlyConsumedBytes(t *testing.T) {
	server := testServer(t, 1)
	w := request(server, http.MethodPost, "/api/upload", strings.NewReader("measured upload body"))
	var result struct {
		Bytes      int64   `json:"bytes"`
		DurationMS float64 `json:"durationMs"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || result.Bytes != int64(len("measured upload body")) || result.DurationMS < 0 || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("unexpected upload acknowledgement: %d %+v", w.Code, result)
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func TestUploadEnforcesDeclaredAndStreamingBodyLimits(t *testing.T) {
	server := testServer(t, 1)
	declared := httptest.NewRequest(http.MethodPost, "/api/upload", strings.NewReader("x"))
	declared.ContentLength = maxTransferBytes + 1
	w := httptest.NewRecorder()
	server.ServeHTTP(w, declared)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized Content-Length accepted: %d", w.Code)
	}
	w = request(server, http.MethodPost, "/api/upload", io.LimitReader(zeroReader{}, maxTransferBytes+1))
	if w.Code != http.StatusRequestEntityTooLarge || len(server.requests) != 0 {
		t.Fatalf("streaming upload limit not enforced/released: %d slots=%d", w.Code, len(server.requests))
	}
}

func TestMethodsAndStaticPathsAreRestricted(t *testing.T) {
	server := testServer(t, 1)
	for _, entry := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodPost, "/api/ping", http.StatusMethodNotAllowed},
		{http.MethodHead, "/api/download", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/upload", http.StatusMethodNotAllowed},
		{http.MethodOptions, "/api/upload", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/missing", http.StatusNotFound},
		{http.MethodGet, "/api/ping/extra", http.StatusNotFound},
		{http.MethodPost, "/", http.StatusMethodNotAllowed},
		{http.MethodGet, "/../main.go", http.StatusNotFound},
		{http.MethodGet, "/web/../../main.go", http.StatusNotFound},
		{http.MethodGet, "/.git/config", http.StatusNotFound},
		{http.MethodGet, "/missing.js", http.StatusNotFound},
		{http.MethodGet, "/", http.StatusOK},
		{http.MethodGet, "/app.js", http.StatusOK},
		{http.MethodHead, "/app.js", http.StatusOK},
	} {
		if w := request(server, entry.method, entry.path, nil); w.Code != entry.status {
			t.Errorf("%s %s status=%d, want %d", entry.method, entry.path, w.Code, entry.status)
		}
	}
	w := request(server, http.MethodGet, "/", nil)
	if !strings.Contains(w.Header().Get("Content-Security-Policy"), "script-src 'self'") || w.Header().Get("X-Frame-Options") != "DENY" {
		t.Fatalf("static security headers missing: %v", w.Header())
	}
	w = request(server, http.MethodGet, "/app.js", nil)
	if !strings.Contains(w.Header().Get("Content-Type"), "javascript") {
		t.Fatalf("script served with incorrect MIME type: %v", w.Header())
	}
}

type blockedBody struct {
	started chan struct{}
	release chan struct{}
}

func (body *blockedBody) Read([]byte) (int, error) {
	close(body.started)
	<-body.release
	return 0, io.EOF
}

func TestConcurrencyCapKeepsPingAvailableAndReleasesSlots(t *testing.T) {
	server := testServer(t, 1)
	body := &blockedBody{started: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		request(server, http.MethodPost, "/api/upload", body)
	}()
	select {
	case <-body.started:
	case <-time.After(time.Second):
		t.Fatal("upload did not begin")
	}
	w := request(server, http.MethodGet, "/api/download?bytes=1", nil)
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") != "1" {
		t.Errorf("concurrency cap not applied: %d %v", w.Code, w.Header())
	}
	if w := request(server, http.MethodGet, "/api/ping", nil); w.Code != http.StatusOK {
		t.Errorf("ping unavailable while transfer slot is busy: %d", w.Code)
	}
	close(body.release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("upload did not release")
	}
	if w := request(server, http.MethodGet, "/api/download?bytes=1", nil); w.Code != http.StatusOK || len(server.requests) != 0 {
		t.Fatalf("transfer slot was not released: %d slots=%d", w.Code, len(server.requests))
	}
}

type cancelWriter struct {
	*httptest.ResponseRecorder
	cancel context.CancelFunc
	writes int
}

func (w *cancelWriter) Write(p []byte) (int, error) {
	w.writes++
	w.cancel()
	return w.ResponseRecorder.Write(p)
}

func TestCancelledDownloadStopsStreamingAndReleasesSlot(t *testing.T) {
	server := testServer(t, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := httptest.NewRequest(http.MethodGet, "/api/download?bytes=67108864", nil).WithContext(ctx)
	w := &cancelWriter{ResponseRecorder: httptest.NewRecorder(), cancel: cancel}
	server.ServeHTTP(w, r)
	if w.writes != 1 || w.Body.Len() != len(server.payload) || len(server.requests) != 0 {
		t.Fatalf("cancelled transfer continued or retained slot: writes=%d bytes=%d slots=%d", w.writes, w.Body.Len(), len(server.requests))
	}
}

func TestRealHTTPServerSupportsMeasuredTransfers(t *testing.T) {
	server := httptest.NewServer(testServer(t, 2))
	defer server.Close()
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(server.URL + "/api/download?bytes=65537")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	count, err := io.Copy(io.Discard, response.Body)
	if err != nil || count != 65537 || response.ContentLength != 65537 {
		t.Fatalf("real streamed download: bytes=%d contentLength=%d err=%v", count, response.ContentLength, err)
	}
	response, err = client.Post(server.URL+"/api/upload", "application/octet-stream", strings.NewReader("upload"))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result map[string]any
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil || result["bytes"] != float64(6) {
		t.Fatalf("real upload acknowledgement: %v err=%v", result, err)
	}
}
