package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func shareFixture() []byte {
	return []byte(`{"schemaVersion":1,"completedAt":"2026-10-12T11:00:00Z","node":{"id":"local","name":"测试节点"},"testType":"full","measurementPolicy":"fixed","transport":"websocket","mode":"manual","download":{"mbps":1000,"durationMs":10000,"measuredBytes":1250000000,"totalBytes":1400000000,"completionReason":"duration","complete":true},"upload":{"mbps":20,"durationMs":10000,"measuredBytes":25000000,"totalBytes":30000000,"completionReason":"duration","complete":true},"latency":{"idle":{"medianMs":20,"jitterMs":1,"samples":2,"failed":0,"attempts":2},"download":{"medianMs":30,"jitterMs":2,"samples":2,"failed":1,"attempts":3},"upload":{"medianMs":40,"jitterMs":3,"samples":2,"failed":0,"attempts":2}},"connections":{"downloadPeak":8,"uploadPeak":8}}`)
}

func testShareService(t *testing.T, mutate func(*Config)) *shareService {
	t.Helper()
	config := Config{ShareDBPath: filepath.Join(t.TempDir(), "results.sqlite"), ShareRetentionHours: 1, ShareMaxResults: 128}
	if mutate != nil {
		mutate(&config)
	}
	service, err := newShareService(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Close() })
	return service
}

func shareRequest(service *shareService, method, path string, body []byte, ip string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	r.RemoteAddr = ip + ":8081"
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		r.Header.Set(name, value)
	}
	w := httptest.NewRecorder()
	service.ServeHTTP(w, r)
	return w
}

func createShare(t *testing.T, service *shareService, ip string, headers map[string]string) map[string]string {
	t.Helper()
	w := shareRequest(service, http.MethodPost, "/api/results", shareFixture(), ip, headers)
	if w.Code != http.StatusCreated {
		t.Fatalf("create share: %d %s", w.Code, w.Body.String())
	}
	var response map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !validShareID(response["id"]) || !validShareID(response["deleteToken"]) || response["id"] == response["deleteToken"] || response["url"] != "/share.html?id="+response["id"] {
		t.Fatalf("invalid share identifiers: %#v", response)
	}
	return response
}

func TestSharingDisabledDoesNotOpenFiles(t *testing.T) {
	service, err := newShareService(Config{ShareRetentionHours: -1, ShareMaxResults: -1})
	if service != nil || err != nil {
		t.Fatalf("disabled sharing must do no initialization: %v %v", service, err)
	}
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	w := shareRequest(service, http.MethodPost, "/api/results", shareFixture(), "192.0.2.1", nil)
	if w.Code != http.StatusNotFound || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("disabled response: %d %v", w.Code, w.Header())
	}
}

func TestSharingStartupRejectsUnusableStorageAndLimits(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "not-a-directory")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, config := range []Config{
		{ShareDBPath: directory},
		{ShareDBPath: filepath.Join(file, "results.sqlite")},
		{ShareDBPath: filepath.Join(directory, "bad.sqlite"), ShareRetentionHours: -1},
		{ShareDBPath: filepath.Join(directory, "bad.sqlite"), ShareMaxResults: 127},
	} {
		if service, err := newShareService(config); err == nil {
			_ = service.Close()
			t.Fatalf("accepted unusable config: %#v", config)
		}
	}
	if _, err := os.Stat(filepath.Join(directory, "bad.sqlite")); !os.IsNotExist(err) {
		t.Fatalf("invalid limits created a database: %v", err)
	}
}

func TestSharingSQLitePersistencePrivacyAndRevocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "results.sqlite")
	config := Config{ShareDBPath: path}
	service, err := newShareService(config)
	if err != nil {
		t.Fatal(err)
	}
	created := createShare(t, service, "198.51.100.7", map[string]string{"User-Agent": "private-user-agent", "X-Forwarded-For": "8.8.8.8"})
	var raw []byte
	var hash []byte
	if err := service.db.QueryRow("SELECT report,delete_hash FROM shared_results WHERE id=?", created["id"]).Scan(&raw, &hash); err != nil {
		t.Fatal(err)
	}
	wantHash := sha256.Sum256([]byte(created["deleteToken"]))
	if !bytes.Equal(hash, wantHash[:]) || bytes.Contains(raw, []byte("198.51.100")) || bytes.Contains(raw, []byte("private-user-agent")) || bytes.Contains(raw, []byte(created["deleteToken"])) {
		t.Fatal("database persisted private request metadata or plaintext deletion token")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm()&0077 != 0 {
		t.Fatalf("database file is not private: %v %v", info, err)
	}
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	service, err = newShareService(config)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	get := shareRequest(service, http.MethodGet, "/api/results/"+created["id"], nil, "203.0.113.1", nil)
	var response struct {
		Provenance string      `json:"provenance"`
		Result     shareReport `json:"result"`
	}
	if err := json.Unmarshal(get.Body.Bytes(), &response); err != nil || get.Code != http.StatusOK || response.Provenance != "client-reported" || response.Result.Download.Mbps == nil || *response.Result.Download.Mbps != 1000 || strings.Contains(get.Body.String(), "deleteToken") {
		t.Fatalf("restarted result: %d %s %v", get.Code, get.Body.String(), err)
	}
	for _, token := range []string{"", created["id"], strings.Repeat("a", 32)} {
		w := shareRequest(service, http.MethodDelete, "/api/results/"+created["id"], nil, "203.0.113.1", map[string]string{"X-Delete-Token": token})
		if w.Code != http.StatusForbidden {
			t.Fatalf("unauthorized delete returned %d", w.Code)
		}
	}
	w := shareRequest(service, http.MethodDelete, "/api/results/"+created["id"], nil, "203.0.113.1", map[string]string{"X-Delete-Token": created["deleteToken"]})
	if w.Code != http.StatusNoContent || shareRequest(service, http.MethodGet, "/api/results/"+created["id"], nil, "203.0.113.1", nil).Code != http.StatusNotFound {
		t.Fatal("revoked result remains public")
	}
}

func TestSharingWriteAuthenticationAndPublicRead(t *testing.T) {
	const token = "deployment-secret-write-token"
	service := testShareService(t, func(config *Config) { config.ShareWriteToken = token })
	for _, header := range []string{"", token, "Bearer wrong", "bearer " + token, "Bearer " + token + " "} {
		w := shareRequest(service, http.MethodPost, "/api/results", shareFixture(), "192.0.2.1", map[string]string{"Authorization": header})
		if w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), token) {
			t.Fatalf("invalid write token response: %d %s", w.Code, w.Body.String())
		}
	}
	created := createShare(t, service, "192.0.2.1", map[string]string{"Authorization": "Bearer " + token})
	if w := shareRequest(service, http.MethodGet, "/api/results/"+created["id"], nil, "192.0.2.2", nil); w.Code != http.StatusOK {
		t.Fatalf("write authentication blocked public read: %d", w.Code)
	}
	w := shareRequest(service, http.MethodDelete, "/api/results/"+created["id"], nil, "192.0.2.2", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusNoContent {
		t.Fatalf("admin token cannot revoke: %d", w.Code)
	}
}

func TestSharingStrictJSONAndBodyLimit(t *testing.T) {
	service := testShareService(t, nil)
	for index, body := range [][]byte{
		[]byte("null"),
		append(shareFixture(), []byte(" {}")...),
		bytes.Replace(shareFixture(), []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"clientIp":"8.8.8.8"`), 1),
		bytes.Replace(shareFixture(), []byte(`"name":"测试节点"`), []byte(`"name":"bad\nnode"`), 1),
		bytes.Replace(shareFixture(), []byte(`"mbps":1000`), []byte(`"mbps":1e999`), 1),
		bytes.Replace(shareFixture(), []byte(`"measuredBytes":1250000000`), []byte(`"measuredBytes":-1`), 1),
		bytes.Replace(shareFixture(), []byte(`"downloadPeak":8`), []byte(`"downloadPeak":31`), 1),
		bytes.Replace(shareFixture(), []byte(`"attempts":2`), []byte(`"attempts":99`), 1),
	} {
		w := shareRequest(service, http.MethodPost, "/api/results", body, fmt.Sprintf("192.0.2.%d", index+1), nil)
		if w.Code != http.StatusBadRequest {
			t.Errorf("invalid body %d returned %d: %s", index, w.Code, w.Body.String())
		}
	}
	w := shareRequest(service, http.MethodPost, "/api/results", bytes.Repeat([]byte(" "), shareBodyLimit+1), "192.0.2.99", nil)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body returned %d", w.Code)
	}
	w = shareRequest(service, http.MethodPost, "/api/results", shareFixture(), "192.0.2.100", map[string]string{"Content-Type": "text/plain"})
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("wrong media type returned %d", w.Code)
	}
}

func TestSharingSkippedAndBudgetPhasesRemainNull(t *testing.T) {
	var full shareReport
	if err := json.Unmarshal(shareFixture(), &full); err != nil {
		t.Fatal(err)
	}
	latency := full
	latency.TestType, latency.Transport, latency.Download, latency.Upload = "latency", nil, nil, nil
	latency.Latency.Download, latency.Latency.Upload = nil, nil
	latency.Connections.DownloadPeak, latency.Connections.UploadPeak = nil, nil
	download := full
	download.TestType, download.Upload, download.Latency.Upload, download.Connections.UploadPeak = "download", nil, nil, nil
	budget := download
	budget.Download = &sharePhase{TotalBytes: 5000, CompletionReason: "budget", Complete: false}
	budget.Latency.Download = &shareLatency{}
	for _, report := range []shareReport{latency, download, budget} {
		body, err := json.Marshal(report)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := decodeShareReport(body)
		if err != nil || decoded.TestType != report.TestType || (report.Upload == nil && decoded.Upload != nil) || (report.Download == nil && decoded.Download != nil) || (report.Download != nil && !report.Download.Complete && decoded.Download.Mbps != nil) {
			t.Fatalf("skipped phase became a false zero: %#v %v", decoded, err)
		}
	}
	budget.Download.Mbps = new(float64)
	bad, _ := json.Marshal(budget)
	if _, err := decodeShareReport(bad); err == nil {
		t.Fatal("unmeasured budget stop accepted a false zero throughput")
	}
}

func TestSharingAnonymousAdmissionUsesTrustedClientAddress(t *testing.T) {
	for _, trusted := range []bool{false, true} {
		t.Run(fmt.Sprintf("trusted=%v", trusted), func(t *testing.T) {
			service := testShareService(t, func(config *Config) {
				if trusted {
					config.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}
				}
			})
			now := time.Now()
			service.now = func() time.Time { return now }
			for index := 0; index < 5; index++ {
				w := shareRequest(service, http.MethodPost, "/api/results", shareFixture(), "192.0.2.1", map[string]string{"X-Forwarded-For": fmt.Sprintf("198.51.100.%d", index+1)})
				want := http.StatusCreated
				if !trusted && index == 4 {
					want = http.StatusTooManyRequests
				}
				if w.Code != want {
					t.Fatalf("write %d returned %d, want %d", index, w.Code, want)
				}
			}
			if !trusted {
				now = now.Add(10 * time.Second)
				createShare(t, service, "192.0.2.1", nil)
			}
		})
	}
}

func TestSharingExpiresAndTrimsConcurrentWriters(t *testing.T) {
	service := testShareService(t, nil)
	now := time.Now()
	service.now = func() time.Time { return now }
	var wait sync.WaitGroup
	errors := make(chan string, 160)
	for index := 0; index < 160; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			w := shareRequest(service, http.MethodPost, "/api/results", shareFixture(), fmt.Sprintf("198.51.100.%d", index+1), nil)
			if w.Code != http.StatusCreated {
				errors <- fmt.Sprintf("%d: %s", w.Code, w.Body.String())
			}
		}(index)
	}
	wait.Wait()
	close(errors)
	for failure := range errors {
		t.Error(failure)
	}
	var count int
	var id string
	if err := service.db.QueryRow("SELECT count(*) FROM shared_results").Scan(&count); err != nil || count != 128 {
		t.Fatalf("concurrent capacity bound: %d %v", count, err)
	}
	if err := service.db.QueryRow("SELECT id FROM shared_results LIMIT 1").Scan(&id); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Hour)
	if w := shareRequest(service, http.MethodGet, "/api/results/"+id, nil, "192.0.2.1", nil); w.Code != http.StatusNotFound {
		t.Fatalf("expired result remains visible: %d", w.Code)
	}
	if err := service.cleanup(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	if err := service.db.QueryRow("SELECT count(*) FROM shared_results").Scan(&count); err != nil || count != 0 {
		t.Fatalf("expired rows retained: %d %v", count, err)
	}
	var integrity string
	if err := service.db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("SQLite integrity: %s %v", integrity, err)
	}
}

func TestSharingRejectsBadIDsMethodsAndDamagedRecords(t *testing.T) {
	service := testShareService(t, nil)
	for _, id := range []string{"", "x", strings.Repeat("A", 32), strings.Repeat("a", 32) + "/x", "../results"} {
		if w := shareRequest(service, http.MethodGet, "/api/results/"+id, nil, "192.0.2.1", nil); w.Code != http.StatusNotFound {
			t.Fatalf("bad id %q returned %d", id, w.Code)
		}
	}
	if w := shareRequest(service, http.MethodGet, "/api/results", nil, "192.0.2.1", nil); w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "POST" {
		t.Fatalf("collection method handling: %d %v", w.Code, w.Header())
	}
	created := createShare(t, service, "192.0.2.1", nil)
	if w := shareRequest(service, http.MethodPut, "/api/results/"+created["id"], nil, "192.0.2.1", nil); w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, DELETE" {
		t.Fatalf("item method handling: %d %v", w.Code, w.Header())
	}
	if _, err := service.db.Exec("UPDATE shared_results SET report=? WHERE id=?", []byte(`{"unexpected":"<script>alert(1)</script>"}`), created["id"]); err != nil {
		t.Fatal(err)
	}
	if w := shareRequest(service, http.MethodGet, "/api/results/"+created["id"], nil, "192.0.2.1", nil); w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), "<script>") {
		t.Fatalf("damaged database escaped validation: %d %s", w.Code, w.Body.String())
	}
}
