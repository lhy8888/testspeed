package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

const shareBodyLimit = 64 << 10

// Sharing is an explicit, optional persistence service. It stores only the
// allowlisted client report, never the request IP, user agent or location.
type shareService struct {
	db        *sql.DB
	config    Config
	retention time.Duration
	max       int
	now       func() time.Time
	mu        sync.Mutex
	limits    map[string]shareAdmission
	cancel    context.CancelFunc
	done      chan struct{}
}

type shareAdmission struct {
	tokens float64
	at     time.Time
}

type sharePhase struct {
	Mbps             *float64 `json:"mbps"`
	DurationMS       float64  `json:"durationMs"`
	MeasuredBytes    int64    `json:"measuredBytes"`
	TotalBytes       int64    `json:"totalBytes"`
	CompletionReason string   `json:"completionReason"`
	Complete         bool     `json:"complete"`
}

type shareLatency struct {
	MedianMS *float64 `json:"medianMs"`
	JitterMS *float64 `json:"jitterMs"`
	Samples  int      `json:"samples"`
	Failed   int      `json:"failed"`
	Attempts int      `json:"attempts"`
}

type shareReport struct {
	SchemaVersion int    `json:"schemaVersion"`
	CompletedAt   string `json:"completedAt"`
	Node          struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"node"`
	TestType          string      `json:"testType"`
	MeasurementPolicy string      `json:"measurementPolicy"`
	Transport         *string     `json:"transport"`
	Mode              string      `json:"mode"`
	Download          *sharePhase `json:"download"`
	Upload            *sharePhase `json:"upload"`
	Latency           struct {
		Idle     *shareLatency `json:"idle"`
		Download *shareLatency `json:"download"`
		Upload   *shareLatency `json:"upload"`
	} `json:"latency"`
	Connections struct {
		DownloadPeak *int `json:"downloadPeak"`
		UploadPeak   *int `json:"uploadPeak"`
	} `json:"connections"`
}

func newShareService(config Config) (*shareService, error) {
	if config.ShareDBPath == "" {
		return nil, nil
	}
	retention, max := config.ShareRetentionHours, config.ShareMaxResults
	if retention == 0 {
		retention = 168
	}
	if max == 0 {
		max = 10000
	}
	if retention < 1 || retention > 8760 || max < 128 || max > 100000 {
		return nil, fmt.Errorf("invalid result sharing retention or capacity")
	}
	path, err := filepath.Abs(config.ShareDBPath)
	if err != nil {
		return nil, fmt.Errorf("resolve result sharing database: %w", err)
	}
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return nil, fmt.Errorf("result sharing database must be a regular file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect result sharing database: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return nil, fmt.Errorf("create result sharing directory: %w", err)
	}
	// Restrict both new and existing files before SQLite opens them. WAL files
	// are avoided, and deletion capabilities are persisted only as hashes.
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open result sharing database: %w", err)
	}
	if err := file.Chmod(0600); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("restrict result sharing database permissions: %w", err)
	}
	if err := file.Close(); err != nil {
		return nil, fmt.Errorf("close result sharing database file: %w", err)
	}
	dsn := (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open SQLite result sharing: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	service := &shareService{db: db, config: config, retention: time.Duration(retention) * time.Hour, max: max, now: time.Now, limits: make(map[string]shareAdmission)}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, statement := range []string{
		"PRAGMA busy_timeout = 2000",
		"PRAGMA journal_mode = DELETE",
		"PRAGMA synchronous = FULL",
		"PRAGMA secure_delete = ON",
		`CREATE TABLE IF NOT EXISTS shared_results (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, report BLOB NOT NULL, delete_hash BLOB NOT NULL CHECK(length(delete_hash) = 32))`,
		"CREATE INDEX IF NOT EXISTS shared_results_expiry ON shared_results(expires_at)",
	} {
		if _, err = db.ExecContext(ctx, statement); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("initialize SQLite result sharing: %w", err)
		}
	}
	if err := service.cleanup(ctx, service.now()); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("clean SQLite result sharing: %w", err)
	}
	maintenance, stop := context.WithCancel(context.Background())
	service.cancel, service.done = stop, make(chan struct{})
	go func() {
		defer close(service.done)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-maintenance.Done():
				return
			case now := <-ticker.C:
				cleanupContext, cancel := context.WithTimeout(maintenance, 3*time.Second)
				_ = service.cleanup(cleanupContext, now)
				cancel()
			}
		}
	}()
	return service, nil
}

func (service *shareService) Close() error {
	if service == nil || service.db == nil {
		return nil
	}
	if service.cancel != nil {
		service.cancel()
		<-service.done
	}
	return service.db.Close()
}

func (service *shareService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	if service == nil || service.db == nil {
		writeError(w, http.StatusNotFound, "result sharing is disabled")
		return
	}
	if r.URL.Path == "/api/results" {
		if requireMethod(w, r, http.MethodPost) {
			service.create(w, r)
		}
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/results/")
	if !validShareID(id) || r.URL.Path != "/api/results/"+id {
		writeError(w, http.StatusNotFound, "shared result not found or expired")
		return
	}
	switch r.Method {
	case http.MethodGet:
		service.read(w, r, id)
	case http.MethodDelete:
		service.remove(w, r, id)
	default:
		w.Header().Set("Allow", "GET, DELETE")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func validShareID(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func randomShareID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

func (service *shareService) authorized(r *http.Request) bool {
	if service.config.ShareWriteToken == "" {
		return false
	}
	value := r.Header.Get("Authorization")
	if !strings.HasPrefix(value, "Bearer ") {
		return false
	}
	expected, actual := sha256.Sum256([]byte(service.config.ShareWriteToken)), sha256.Sum256([]byte(strings.TrimPrefix(value, "Bearer ")))
	return subtle.ConstantTimeCompare(expected[:], actual[:]) == 1
}

// Four immediately available writes, then one every 10 seconds. The bounded
// map contains only transient IP admission state, never persisted metadata.
func (service *shareService) admit(r *http.Request, now time.Time) bool {
	ip, _ := service.config.clientAddress(r)
	key := "unknown"
	if ip.IsValid() {
		key = ip.String()
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	entry, exists := service.limits[key]
	if !exists {
		if len(service.limits) >= 1024 {
			for old, value := range service.limits {
				if now.Sub(value.at) >= time.Minute {
					delete(service.limits, old)
				}
			}
			if len(service.limits) >= 1024 {
				return false
			}
		}
		entry = shareAdmission{tokens: 4, at: now}
	}
	entry.tokens = math.Min(4, entry.tokens+math.Max(0, now.Sub(entry.at).Seconds())/10)
	entry.at = now
	allowed := entry.tokens >= 1
	if allowed {
		entry.tokens--
	}
	service.limits[key] = entry
	return allowed
}

func (service *shareService) create(w http.ResponseWriter, r *http.Request) {
	if service.config.ShareWriteToken != "" && !service.authorized(r) {
		writeError(w, http.StatusUnauthorized, "a result sharing write token is required")
		return
	}
	if !service.admit(r, service.now()) {
		w.Header().Set("Retry-After", "10")
		writeError(w, http.StatusTooManyRequests, "result sharing write limit reached")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "result sharing requires application/json")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, shareBodyLimit))
	if err != nil {
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			writeError(w, http.StatusRequestEntityTooLarge, "shared result is too large")
		} else {
			writeError(w, http.StatusBadRequest, "cannot read shared result")
		}
		return
	}
	report, err := decodeShareReport(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid shared result")
		return
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "cannot encode shared result")
		return
	}
	id, err := randomShareID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "cannot create shared result")
		return
	}
	deleteToken, err := randomShareID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "cannot create shared result")
		return
	}
	deleteHash := sha256.Sum256([]byte(deleteToken))
	now := service.now().UTC()
	expires := now.Add(service.retention)
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	tx, err := service.db.BeginTx(ctx, nil)
	if err == nil {
		defer tx.Rollback()
		_, err = tx.ExecContext(ctx, "DELETE FROM shared_results WHERE expires_at <= ?", now.UnixMilli())
		if err == nil {
			_, err = tx.ExecContext(ctx, "INSERT INTO shared_results(id,created_at,expires_at,report,delete_hash) VALUES(?,?,?,?,?)", id, now.UnixMilli(), expires.UnixMilli(), encoded, deleteHash[:])
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, "DELETE FROM shared_results WHERE id IN (SELECT id FROM shared_results ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)", service.max)
		}
		if err == nil {
			err = tx.Commit()
		}
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "shared result storage is unavailable")
		return
	}
	writeJSON(w, http.StatusCreated, struct {
		ID          string `json:"id"`
		URL         string `json:"url"`
		DeleteToken string `json:"deleteToken"`
		ExpiresAt   string `json:"expiresAt"`
	}{id, "/share.html?id=" + id, deleteToken, expires.Format(time.RFC3339Nano)})
}

func (service *shareService) read(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	var created, expires int64
	var body []byte
	err := service.db.QueryRowContext(ctx, "SELECT created_at,expires_at,report FROM shared_results WHERE id=? AND expires_at>?", id, service.now().UnixMilli()).Scan(&created, &expires, &body)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "shared result not found or expired")
		return
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "shared result storage is unavailable")
		return
	}
	// Read through the same validation boundary so a damaged or manually edited
	// database cannot turn the public API into an arbitrary JSON/HTML store.
	report, err := decodeShareReport(body)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "shared result storage is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		ID         string      `json:"id"`
		CreatedAt  string      `json:"createdAt"`
		ExpiresAt  string      `json:"expiresAt"`
		Provenance string      `json:"provenance"`
		Result     shareReport `json:"result"`
	}{id, time.UnixMilli(created).UTC().Format(time.RFC3339Nano), time.UnixMilli(expires).UTC().Format(time.RFC3339Nano), "client-reported", report})
}

func (service *shareService) remove(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	var hash []byte
	err := service.db.QueryRowContext(ctx, "SELECT delete_hash FROM shared_results WHERE id=? AND expires_at>?", id, service.now().UnixMilli()).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "shared result not found or expired")
		return
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "shared result storage is unavailable")
		return
	}
	token := r.Header.Get("X-Delete-Token")
	actual := sha256.Sum256([]byte(token))
	if !service.authorized(r) && (!validShareID(token) || subtle.ConstantTimeCompare(hash, actual[:]) != 1) {
		writeError(w, http.StatusForbidden, "a result deletion token is required")
		return
	}
	if _, err := service.db.ExecContext(ctx, "DELETE FROM shared_results WHERE id=?", id); err != nil {
		writeError(w, http.StatusServiceUnavailable, "shared result storage is unavailable")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (service *shareService) cleanup(ctx context.Context, now time.Time) error {
	tx, err := service.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM shared_results WHERE expires_at<=?", now.UnixMilli()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM shared_results WHERE id IN (SELECT id FROM shared_results ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)", service.max); err != nil {
		return err
	}
	return tx.Commit()
}

func decodeShareReport(body []byte) (shareReport, error) {
	var report shareReport
	if !utf8.Valid(body) {
		return report, fmt.Errorf("shared result must be UTF-8 JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&report); err != nil {
		return report, err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return report, fmt.Errorf("unexpected trailing JSON")
	}
	completed, err := time.Parse(time.RFC3339Nano, report.CompletedAt)
	if err != nil || completed.Year() < 2000 || completed.Year() > 2100 || report.SchemaVersion != 1 ||
		!shareText(report.Node.ID, 128) || !shareText(report.Node.Name, 256) ||
		(report.TestType != "full" && report.TestType != "download" && report.TestType != "latency") ||
		(report.MeasurementPolicy != "fixed" && report.MeasurementPolicy != "adaptive") ||
		(report.Mode != "manual" && report.Mode != "auto") {
		return report, fmt.Errorf("invalid result metadata")
	}
	report.CompletedAt = completed.UTC().Format(time.RFC3339Nano)
	if report.TestType == "latency" {
		if report.Download != nil || report.Upload != nil || report.Transport != nil || report.Connections.DownloadPeak != nil || report.Connections.UploadPeak != nil || report.Latency.Download != nil || report.Latency.Upload != nil {
			return report, fmt.Errorf("latency result cannot contain transfer phases")
		}
	} else {
		if report.Transport == nil || (*report.Transport != "http" && *report.Transport != "websocket") || report.Download == nil || (report.TestType == "full" && report.Upload == nil) || (report.TestType == "download" && (report.Upload != nil || report.Connections.UploadPeak != nil || report.Latency.Upload != nil)) {
			return report, fmt.Errorf("invalid result phases")
		}
	}
	for _, phase := range []*sharePhase{report.Download, report.Upload} {
		if phase == nil {
			continue
		}
		if !shareFinite(phase.DurationMS, 60000) || phase.MeasuredBytes < 0 || phase.TotalBytes < phase.MeasuredBytes || phase.TotalBytes > 9007199254740991 ||
			(phase.CompletionReason != "duration" && phase.CompletionReason != "stable" && phase.CompletionReason != "budget") {
			return report, fmt.Errorf("invalid transfer metrics")
		}
		if phase.Complete {
			if phase.Mbps == nil || !shareFinite(*phase.Mbps, 10000000) || phase.DurationMS <= 0 || phase.MeasuredBytes <= 0 {
				return report, fmt.Errorf("invalid completed throughput")
			}
		} else if phase.Mbps != nil || phase.CompletionReason != "budget" || (phase.DurationMS > 0 && phase.MeasuredBytes > 0) {
			return report, fmt.Errorf("incomplete result requires an unmeasured budget stop")
		}
	}
	for _, latency := range []*shareLatency{report.Latency.Idle, report.Latency.Download, report.Latency.Upload} {
		if latency == nil {
			continue
		}
		if latency.Samples < 0 || latency.Failed < 0 || latency.Attempts < 0 || latency.Attempts > 100000 || latency.Attempts != latency.Samples+latency.Failed ||
			(latency.Samples == 0) != (latency.MedianMS == nil) || (latency.Samples < 2) != (latency.JitterMS == nil) ||
			(latency.MedianMS != nil && !shareFinite(*latency.MedianMS, 600000)) || (latency.JitterMS != nil && !shareFinite(*latency.JitterMS, 600000)) {
			return report, fmt.Errorf("invalid latency metrics")
		}
	}
	if report.Latency.Idle == nil || report.Latency.Idle.Attempts < 1 {
		return report, fmt.Errorf("result requires idle latency metrics")
	}
	for _, peak := range []*int{report.Connections.DownloadPeak, report.Connections.UploadPeak} {
		if peak != nil && (*peak < 0 || *peak > 30) {
			return report, fmt.Errorf("invalid connection metrics")
		}
	}
	return report, nil
}

func shareFinite(value, maximum float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= maximum
}

func shareText(value string, maximum int) bool {
	if value == "" || len(value) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}
