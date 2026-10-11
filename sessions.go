package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const sessionTTL = 90 * time.Second

type uploadSession struct {
	id         string
	created    time.Time
	warmup     time.Duration
	duration   time.Duration
	total      atomic.Int64
	measured   atomic.Int64
	finished   atomic.Bool
	inFlight   atomic.Int64
	startOnce  sync.Once
	finishOnce sync.Once
	window     atomic.Pointer[uploadWindow]
	ctx        context.Context
	cancel     context.CancelFunc
	timerMu    sync.Mutex
	timer      *time.Timer
	stats      *connectionStats
}

type uploadWindow struct {
	start            time.Time
	measurementStart time.Time
	end              time.Time
}

type uploadSnapshot struct {
	ID                   string  `json:"id"`
	Started              bool    `json:"started"`
	Finished             bool    `json:"finished"`
	MeasuredBytes        int64   `json:"measuredBytes"`
	TotalBytes           int64   `json:"totalBytes"`
	MeasurementElapsedMS float64 `json:"measurementElapsedMs"`
	DurationMS           int64   `json:"durationMs"`
	WarmupMS             int64   `json:"warmupMs"`
	Mbps                 float64 `json:"mbps"`
	connectionSnapshot
}

func newUploadSession(id string, now time.Time, warmup, duration time.Duration) *uploadSession {
	ctx, cancel := context.WithCancel(context.Background())
	return &uploadSession{
		id: id, created: now, warmup: warmup, duration: duration,
		ctx: ctx, cancel: cancel, stats: newConnectionStats(),
	}
}

func (session *uploadSession) stop() {
	session.finishOnce.Do(func() {
		session.finished.Store(true)
		// No new counter operation can pass the finished check. Wait only for
		// already-entered, allocation-free updates before freezing the result.
		for session.inFlight.Load() != 0 {
			runtime.Gosched()
		}
		session.cancel()
		session.timerMu.Lock()
		if session.timer != nil {
			session.timer.Stop()
		}
		session.timerMu.Unlock()
	})
}

// record counts bytes returned by a server body read. Queued browser bytes and
// acknowledgement timing never enter the result. Arrival is sampled per read,
// so a boundary has at most one read buffer of uncertainty per active request.
func (session *uploadSession) record(count int64, now time.Time) (end time.Time, accepting bool) {
	if session.finished.Load() {
		return time.Time{}, false
	}
	session.startOnce.Do(func() {
		session.window.Store(&uploadWindow{start: now, measurementStart: now.Add(session.warmup), end: now.Add(session.warmup + session.duration)})
		session.timerMu.Lock()
		if !session.finished.Load() {
			session.timer = time.AfterFunc(session.warmup+session.duration, session.stop)
		}
		session.timerMu.Unlock()
	})
	window := session.window.Load()
	end = window.end
	if !now.Before(end) {
		session.stop()
		return end, false
	}
	session.inFlight.Add(1)
	defer session.inFlight.Add(-1)
	if session.finished.Load() {
		return end, false
	}
	session.total.Add(count)
	if !now.Before(window.measurementStart) {
		session.measured.Add(count)
	}
	return end, true
}

func (session *uploadSession) snapshot(now time.Time) uploadSnapshot {
	elapsed := time.Duration(0)
	window := session.window.Load()
	if window != nil {
		elapsed = max(time.Duration(0), min(session.duration, now.Sub(window.measurementStart)))
		if elapsed == session.duration {
			session.stop()
		}
	}
	if session.finished.Load() {
		// Synchronize with the finish barrier before reading frozen counters.
		session.stop()
	}
	measured, total := session.measured.Load(), session.total.Load()
	mbps := float64(0)
	if elapsed > 0 {
		mbps = float64(measured) * 8 / elapsed.Seconds() / 1e6
	}
	result := uploadSnapshot{
		ID: session.id, Started: window != nil, Finished: session.finished.Load(),
		MeasuredBytes: measured, TotalBytes: total,
		MeasurementElapsedMS: float64(elapsed.Nanoseconds()) / 1e6,
		DurationMS:           session.duration.Milliseconds(), WarmupMS: session.warmup.Milliseconds(), Mbps: mbps,
	}
	result.connectionSnapshot = session.stats.snapshot()
	return result
}

type uploadSessions struct {
	mu      sync.Mutex
	entries map[string]*uploadSession
	limit   int
}

func (sessions *uploadSessions) prune(now time.Time) {
	for id, session := range sessions.entries {
		if now.Sub(session.created) >= sessionTTL {
			session.stop()
			delete(sessions.entries, id)
		}
	}
}

func (sessions *uploadSessions) create(warmup, duration time.Duration, now time.Time) *uploadSession {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	sessions.prune(now)
	if len(sessions.entries) >= sessions.limit {
		return nil
	}
	var id [16]byte
	_, _ = rand.Read(id[:])
	session := newUploadSession(hex.EncodeToString(id[:]), now, warmup, duration)
	sessions.entries[session.id] = session
	return session
}

func (sessions *uploadSessions) get(id string, now time.Time) *uploadSession {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	sessions.prune(now)
	return sessions.entries[id]
}

func (sessions *uploadSessions) remove(id string, now time.Time) bool {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	sessions.prune(now)
	session := sessions.entries[id]
	if session == nil {
		return false
	}
	delete(sessions.entries, id)
	session.stop()
	return true
}

func (server *speedServer) sessionRoute(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/upload-sessions" {
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		var options struct {
			WarmupMS   *int `json:"warmupMs"`
			DurationMS *int `json:"durationMs"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&options); err != nil && !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "invalid upload session settings")
			return
		}
		var extra any
		if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "request must contain one JSON object")
			return
		}
		warmup, duration := server.config.WarmupMS, server.config.UploadDurationMS
		if options.WarmupMS != nil {
			warmup = *options.WarmupMS
		}
		if options.DurationMS != nil {
			duration = *options.DurationMS
		}
		if duration < 1000 || duration > 60000 || warmup < 0 || warmup > 10000 {
			writeError(w, http.StatusBadRequest, "invalid duration or warmup for upload session")
			return
		}
		session := server.sessions.create(time.Duration(warmup)*time.Millisecond, time.Duration(duration)*time.Millisecond, time.Now())
		if session == nil {
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusServiceUnavailable, "upload session limit reached")
			return
		}
		writeJSON(w, http.StatusCreated, session.snapshot(time.Now()))
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/upload-sessions/")
	if !validRunID(id) {
		writeError(w, http.StatusNotFound, "upload session not found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		session := server.sessions.get(id, time.Now())
		if session == nil {
			writeError(w, http.StatusNotFound, "upload session not found or expired")
			return
		}
		writeJSON(w, http.StatusOK, session.snapshot(time.Now()))
	case http.MethodDelete:
		if !server.sessions.remove(id, time.Now()) {
			writeError(w, http.StatusNotFound, "upload session not found or expired")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "GET, DELETE")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
