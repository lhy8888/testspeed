package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestStableUploadCompletionUsesActualElapsedAndFreezes(t *testing.T) {
	now := time.Now()
	session := newUploadSession("stable", now, time.Second, 10*time.Second)
	defer session.stop()
	if session.finishStable(now.Add(20 * time.Second)) {
		t.Fatal("unstarted session accepted stable completion")
	}
	session.record(100, now)
	session.record(1000, now.Add(2*time.Second))
	session.record(2000, now.Add(6*time.Second))
	if session.finishStable(now.Add(6*time.Second - time.Nanosecond)) {
		t.Fatal("stable completion accepted less than five measured seconds")
	}
	if !session.finishStable(now.Add(7 * time.Second)) {
		t.Fatal("valid stable completion was rejected")
	}
	frozen := session.snapshot(now.Add(7 * time.Second))
	if !frozen.Finished || frozen.CompletionReason != "stable" || frozen.TotalBytes != 3100 || frozen.MeasuredBytes != 3000 || frozen.MeasurementElapsedMS != 6000 || frozen.Mbps != .004 || session.ctx.Err() == nil {
		t.Fatalf("stable completion used configured time or client bytes: %+v", frozen)
	}
	if _, accepted := session.record(65536, now.Add(8*time.Second)); accepted {
		t.Fatal("stable completion accepted more measured bytes")
	}
	if !session.finishStable(now.Add(30 * time.Second)) {
		t.Fatal("already-finished stable completion was not idempotent")
	}
	after := session.snapshot(now.Add(30 * time.Second))
	if !reflect.DeepEqual(after, frozen) {
		t.Fatalf("stable result drifted after completion: before=%+v after=%+v", frozen, after)
	}
}

func TestUploadBudgetIncludesWarmupWithoutInventingMeasurement(t *testing.T) {
	now := time.Now()
	session := newUploadSession("budget-warmup", now, 1500*time.Millisecond, 10*time.Second, 512)
	defer session.stop()
	end, accepted := session.record(1024, now)
	if !accepted || !end.Equal(now) {
		t.Fatalf("first actual read did not close its budget window: accepted=%t end=%s", accepted, end)
	}
	frozen := session.snapshot(now.Add(20 * time.Second))
	if !frozen.Started || !frozen.Finished || frozen.CompletionReason != "budget" || frozen.MaxBytes != 512 || frozen.TotalBytes != 1024 || frozen.MeasuredBytes != 0 || frozen.MeasurementElapsedMS != 0 || frozen.Mbps != 0 || session.ctx.Err() == nil {
		t.Fatalf("warmup budget fabricated measurement bytes or duration: %+v", frozen)
	}
	if _, accepted := session.record(1024, now.Add(2*time.Second)); accepted {
		t.Fatal("budget-completed session accepted a later read")
	}
	if after := session.snapshot(now.Add(time.Hour)); !reflect.DeepEqual(after, frozen) {
		t.Fatalf("warmup budget result drifted: before=%+v after=%+v", frozen, after)
	}
}

func TestHTTPUploadBudgetReturnsMachineReadableCompletionAndKeepsTrueReads(t *testing.T) {
	server := testServer(t, 2)
	session := server.sessions.create(1500*time.Millisecond, 10*time.Second, time.Now(), 512)
	defer session.stop()
	response := request(server, http.MethodPost, "/api/upload?session="+session.id, strings.NewReader(strings.Repeat("x", 64<<10)))
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"code":"session_finished"`) {
		t.Fatalf("budget-completed HTTP body received a false success acknowledgement: %d %s", response.Code, response.Body)
	}
	frozen := session.snapshot(time.Now())
	if !frozen.Finished || frozen.CompletionReason != "budget" || frozen.TotalBytes != 64<<10 || frozen.MeasuredBytes != 0 || frozen.MeasurementElapsedMS != 0 || frozen.ActiveRequests != 0 {
		t.Fatalf("HTTP budget did not report actual body reads or settle its request: %+v", frozen)
	}
	response = request(server, http.MethodPost, "/api/upload?session="+session.id, strings.NewReader("late"))
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"code":"session_finished"`) || session.snapshot(time.Now()).TotalBytes != frozen.TotalBytes {
		t.Fatalf("completed budget accepted another HTTP upload: %d %s", response.Code, response.Body)
	}
}

func TestConcurrentUploadBudgetPreservesAcceptedReadsWithoutDeadlock(t *testing.T) {
	now := time.Now()
	const readers = 30
	const readBytes = 64 << 10
	const budget = 1 << 20
	session := newUploadSession("budget-concurrent", now, 0, 10*time.Second, budget)
	defer session.stop()
	session.record(1, now)
	var received atomic.Int64
	received.Store(1)
	var group sync.WaitGroup
	start := make(chan struct{})
	for range readers {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			for range 100 {
				_, accepted := session.record(readBytes, now.Add(time.Second))
				if !accepted {
					return
				}
				received.Add(readBytes)
			}
		}()
	}
	close(start)
	done := make(chan struct{})
	go func() { group.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("parallel budget completion deadlocked its own in-flight barrier")
	}
	frozen := session.snapshot(now.Add(20 * time.Second))
	if !frozen.Finished || frozen.CompletionReason != "budget" || frozen.TotalBytes != received.Load() || frozen.MeasuredBytes != received.Load() || frozen.TotalBytes < budget || frozen.TotalBytes > budget+readers*readBytes || frozen.MeasurementElapsedMS != 1000 {
		t.Fatalf("parallel actual reads were lost or exceeded bounded budget overshoot: frozen=%+v reads=%d", frozen, received.Load())
	}
	if after := session.snapshot(now.Add(time.Hour)); !reflect.DeepEqual(after, frozen) {
		t.Fatalf("parallel budget changed after finish: before=%+v after=%+v", frozen, after)
	}
}

func TestZeroUploadBudgetPreservesDurationAndCancellationRemainsDistinct(t *testing.T) {
	now := time.Now()
	session := newUploadSession("unlimited", now, 0, time.Second, 0)
	defer session.stop()
	session.record(4<<20, now)
	if before := session.snapshot(now.Add(500 * time.Millisecond)); before.Finished || before.MaxBytes != 0 {
		t.Fatalf("zero byte budget limited an existing fixed window: %+v", before)
	}
	frozen := session.snapshot(now.Add(2 * time.Second))
	if !frozen.Finished || frozen.CompletionReason != "duration" || frozen.MeasurementElapsedMS != 1000 || frozen.MeasuredBytes != 4<<20 {
		t.Fatalf("zero-budget duration behavior changed: %+v", frozen)
	}
	cancelled := newUploadSession("cancelled", now, 0, 10*time.Second)
	cancelled.record(4096, now)
	cancelled.stop()
	result := cancelled.snapshot(now.Add(time.Minute))
	if result.CompletionReason != "cancelled" || result.MeasurementElapsedMS >= 10000 || !result.Finished || result.MeasuredBytes != 4096 {
		t.Fatalf("cancellation was disguised as a completed fixed duration: %+v", result)
	}
	if after := cancelled.snapshot(now.Add(time.Hour)); !reflect.DeepEqual(after, result) {
		t.Fatalf("cancelled result elapsed time drifted: before=%+v after=%+v", result, after)
	}
}

func TestUploadBudgetAndStableFinishRoutesValidateAuthoritativeSettings(t *testing.T) {
	server := testServer(t, 2)
	for _, body := range []string{
		`null`,
		`{"maxBytes":-1}`,
		`{"maxBytes":1099511627777}`,
		`{"maxBytes":1.5}`,
		`{"maxBytes":"1000"}`,
		`{"maxBytes":true}`,
		`{"maxBytes":1000,"measuredBytes":1000}`,
	} {
		if w := request(server, http.MethodPost, "/api/upload-sessions", strings.NewReader(body)); w.Code != http.StatusBadRequest {
			t.Errorf("invalid byte budget accepted: body=%s status=%d", body, w.Code)
		}
	}
	w := request(server, http.MethodPost, "/api/upload-sessions", strings.NewReader(`{"durationMs":10000,"warmupMs":1000,"maxBytes":1099511627776}`))
	var created uploadSnapshot
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || w.Code != http.StatusCreated || created.MaxBytes != maxSessionBudgetBytes {
		t.Fatalf("maximum budget creation failed: status=%d body=%s err=%v", w.Code, w.Body, err)
	}
	session := server.sessions.get(created.ID, time.Now())
	defer session.stop()
	path := "/api/upload-sessions/" + created.ID + "/finish"
	for _, body := range []string{
		``, `null`, `{}`, `[]`, `{"reason":"budget"}`, `{"reason":"stable","elapsedMs":99999}`, `{"reason":"stable"} {}`,
	} {
		if w := request(server, http.MethodPost, path, strings.NewReader(body)); w.Code != http.StatusBadRequest {
			t.Errorf("invalid client finish settings accepted: body=%s status=%d", body, w.Code)
		}
	}
	if w := request(server, http.MethodGet, path, nil); w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("finish endpoint allowed method other than POST: %d %s", w.Code, w.Body)
	}
	if w := request(server, http.MethodPost, path, strings.NewReader(`{"reason":"stable"}`)); w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), `"code":"measurement_too_short"`) {
		t.Fatalf("unstarted upload accepted stable finish: %d %s", w.Code, w.Body)
	}
	// The test clock places actual server body reads in an older window. The
	// endpoint still ignores client-supplied elapsed time and counters entirely.
	started := time.Now().Add(-7 * time.Second)
	session.record(100, started)
	session.record(3000, started.Add(2*time.Second))
	w = request(server, http.MethodPost, path, strings.NewReader(`{"reason":"stable"}`))
	var frozen uploadSnapshot
	if err := json.Unmarshal(w.Body.Bytes(), &frozen); err != nil || w.Code != http.StatusOK || !frozen.Finished || frozen.CompletionReason != "stable" || frozen.MeasuredBytes != 3000 || frozen.TotalBytes != 3100 || frozen.MeasurementElapsedMS < 6000 || frozen.MeasurementElapsedMS > 6100 {
		t.Fatalf("authoritative stable response incorrect: status=%d body=%s err=%v", w.Code, w.Body, err)
	}
	w = request(server, http.MethodPost, path, strings.NewReader(`{"reason":"stable"}`))
	var repeated uploadSnapshot
	if err := json.Unmarshal(w.Body.Bytes(), &repeated); err != nil || w.Code != http.StatusOK || !reflect.DeepEqual(repeated, frozen) {
		t.Fatalf("finish retry changed a frozen result: status=%d body=%s err=%v", w.Code, w.Body, err)
	}
	if w := request(server, http.MethodPost, "/api/upload?session="+created.ID, strings.NewReader("late")); w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), `"code":"session_finished"`) {
		t.Fatalf("finished HTTP upload lost its machine-readable cutoff: %d %s", w.Code, w.Body)
	}
	if w := request(server, http.MethodPost, "/api/upload-sessions/missing/finish", strings.NewReader(`{"reason":"stable"}`)); w.Code != http.StatusNotFound {
		t.Fatalf("missing finish session was accepted: %d %s", w.Code, w.Body)
	}
}
