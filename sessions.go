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

const (
	sessionTTL            = 90 * time.Second
	maxSessionBudgetBytes = int64(1 << 40)
	minimumStableWindow   = 5 * time.Second
)

type uploadSession struct {
	id         string
	created    time.Time
	warmup     time.Duration
	duration   time.Duration
	maxBytes   int64
	total      atomic.Int64
	measured   atomic.Int64
	finished   atomic.Bool
	inFlight   atomic.Int64
	startOnce  sync.Once
	finishOnce sync.Once
	window     atomic.Pointer[uploadWindow]
	completion atomic.Pointer[uploadCompletion]
	ctx        context.Context
	cancel     context.CancelFunc
	timerMu    sync.Mutex
	timer      *time.Timer
	stats      *connectionStats
}

type uploadCompletion struct {
	end    time.Time
	reason string
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
	MaxBytes             int64   `json:"maxBytes"`
	CompletionReason     string  `json:"completionReason,omitempty"`
	Mbps                 float64 `json:"mbps"`
	connectionSnapshot
}

func newUploadSession(id string, now time.Time, warmup, duration time.Duration, budgets ...int64) *uploadSession {
	ctx, cancel := context.WithCancel(context.Background())
	var maxBytes int64
	if len(budgets) > 0 {
		maxBytes = budgets[0]
	}
	return &uploadSession{
		id: id, created: now, warmup: warmup, duration: duration, maxBytes: maxBytes,
		ctx: ctx, cancel: cancel, stats: newConnectionStats(),
	}
}

func (session *uploadSession) stop() {
	session.stopAt(time.Now(), "cancelled")
}

func (session *uploadSession) stopAt(now time.Time, reason string) {
	session.finishOnce.Do(func() {
		if window := session.window.Load(); window != nil && !now.Before(window.end) {
			now, reason = window.end, "duration"
		}
		session.completion.Store(&uploadCompletion{end: now, reason: reason})
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

// finishStable only accepts a sufficiently long server-side measurement. The
// browser also checks RTT and throughput convergence, but never supplies the
// elapsed time or byte counters used for the authoritative result.
func (session *uploadSession) finishStable(now time.Time) bool {
	if session.finished.Load() {
		session.stop()
		return true
	}
	window := session.window.Load()
	if window == nil || now.Sub(window.measurementStart) < minimumStableWindow {
		return false
	}
	session.stopAt(now, "stable")
	return true
}

// record counts bytes returned by a server body read. Queued browser bytes and
// acknowledgement timing never enter the result. Arrival is sampled per read,
// so a boundary has at most one read buffer of uncertainty per active request.
func (session *uploadSession) record(count int64, now time.Time) (end time.Time, accepting bool) {
	if session.finished.Load() {
		return time.Time{}, false
	}
	if count <= 0 {
		return time.Time{}, true
	}
	session.startOnce.Do(func() {
		session.window.Store(&uploadWindow{start: now, measurementStart: now.Add(session.warmup), end: now.Add(session.warmup + session.duration)})
		session.timerMu.Lock()
		if !session.finished.Load() {
			session.timer = time.AfterFunc(session.warmup+session.duration, func() { session.stopAt(now.Add(session.warmup+session.duration), "duration") })
		}
		session.timerMu.Unlock()
	})
	window := session.window.Load()
	end = window.end
	if !now.Before(end) {
		session.stopAt(end, "duration")
		return end, false
	}
	if session.maxBytes > 0 && session.total.Load() >= session.maxBytes {
		// Another reader may have reached the budget and then yielded before
		// entering the finish barrier. Prevent this stream from accepting a
		// second read while that first completion is still pending.
		session.stopAt(now, "budget")
		return session.completion.Load().end, false
	}
	session.inFlight.Add(1)
	if session.finished.Load() {
		session.inFlight.Add(-1)
		return end, false
	}
	total := session.total.Add(count)
	if !now.Before(window.measurementStart) {
		session.measured.Add(count)
	}
	// Complete only after releasing our own counter update. Calling stopAt
	// inside the in-flight barrier would wait for itself forever. Reads already
	// inside that barrier remain true received bytes; budget overshoot is bounded
	// by one 64 KiB read buffer per active transfer, never browser queue bytes.
	session.inFlight.Add(-1)
	if session.maxBytes > 0 && total >= session.maxBytes {
		session.stopAt(now, "budget")
		if completed := session.completion.Load(); completed != nil {
			end = completed.end
		}
	}
	return end, true
}

func (session *uploadSession) snapshot(now time.Time) uploadSnapshot {
	window := session.window.Load()
	if window != nil && !now.Before(window.end) {
		session.stopAt(window.end, "duration")
	}
	finished := session.finished.Load()
	if finished {
		// Synchronize with the finish barrier before reading frozen counters.
		session.stop()
	}
	elapsed := time.Duration(0)
	reason := ""
	if finished {
		completed := session.completion.Load()
		now, reason = completed.end, completed.reason
	}
	if window != nil {
		elapsed = max(time.Duration(0), min(session.duration, now.Sub(window.measurementStart)))
	}
	measured, total := session.measured.Load(), session.total.Load()
	mbps := float64(0)
	if elapsed > 0 {
		mbps = float64(measured) * 8 / elapsed.Seconds() / 1e6
	}
	result := uploadSnapshot{
		ID: session.id, Started: window != nil, Finished: finished,
		MeasuredBytes: measured, TotalBytes: total,
		MeasurementElapsedMS: float64(elapsed.Nanoseconds()) / 1e6,
		DurationMS:           session.duration.Milliseconds(), WarmupMS: session.warmup.Milliseconds(), Mbps: mbps,
		MaxBytes: session.maxBytes, CompletionReason: reason,
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

func (sessions *uploadSessions) create(warmup, duration time.Duration, now time.Time, budgets ...int64) *uploadSession {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	sessions.prune(now)
	if len(sessions.entries) >= sessions.limit {
		return nil
	}
	var id [16]byte
	_, _ = rand.Read(id[:])
	session := newUploadSession(hex.EncodeToString(id[:]), now, warmup, duration, budgets...)
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
		type sessionOptions struct {
			WarmupMS   *int   `json:"warmupMs"`
			DurationMS *int   `json:"durationMs"`
			MaxBytes   *int64 `json:"maxBytes"`
		}
		options := &sessionOptions{}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&options); options == nil || err != nil && !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "invalid upload session settings")
			return
		}
		var extra any
		if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "request must contain one JSON object")
			return
		}
		warmup, duration := server.config.WarmupMS, server.config.UploadDurationMS
		var maxBytes int64
		if options.WarmupMS != nil {
			warmup = *options.WarmupMS
		}
		if options.DurationMS != nil {
			duration = *options.DurationMS
		}
		if options.MaxBytes != nil {
			maxBytes = *options.MaxBytes
		}
		if duration < 1000 || duration > 60000 || warmup < 0 || warmup > 10000 {
			writeError(w, http.StatusBadRequest, "invalid duration or warmup for upload session")
			return
		}
		if maxBytes < 0 || maxBytes > maxSessionBudgetBytes {
			writeError(w, http.StatusBadRequest, "upload byte budget must be between 0 and 1 TiB")
			return
		}
		session := server.sessions.create(time.Duration(warmup)*time.Millisecond, time.Duration(duration)*time.Millisecond, time.Now(), maxBytes)
		if session == nil {
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusServiceUnavailable, "upload session limit reached")
			return
		}
		writeJSON(w, http.StatusCreated, session.snapshot(time.Now()))
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/upload-sessions/")
	finish := strings.HasSuffix(id, "/finish")
	if finish {
		id = strings.TrimSuffix(id, "/finish")
	}
	if !validRunID(id) {
		writeError(w, http.StatusNotFound, "upload session not found")
		return
	}
	if finish {
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		var options struct {
			Reason string `json:"reason"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&options); err != nil || options.Reason != "stable" {
			writeError(w, http.StatusBadRequest, "finish reason must be stable")
			return
		}
		var extra any
		if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "request must contain one JSON object")
			return
		}
		session := server.sessions.get(id, time.Now())
		if session == nil {
			writeError(w, http.StatusNotFound, "upload session not found or expired")
			return
		}
		if !session.finishStable(time.Now()) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "stable completion requires at least 5000 ms of server measurement", "code": "measurement_too_short"})
			return
		}
		writeJSON(w, http.StatusOK, session.snapshot(time.Now()))
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
