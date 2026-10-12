package main

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestOptionalFeatureConfiguration(t *testing.T) {
	clearConfigEnv(t)
	config, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://example.com/api/config", nil)
	client, err := config.clientConfig(request)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(client)
	if !client.Features.TestSelection || !client.Features.AdaptiveDuration || !client.Features.ByteBudget || !client.Features.Stability || client.Features.Sharing || client.Features.ShareRequiresToken {
		t.Fatalf("unexpected default capabilities: %s", encoded)
	}
	t.Setenv("SHARE_DB_PATH", filepath.Join(t.TempDir(), "results.sqlite"))
	t.Setenv("SHARE_WRITE_TOKEN", "private-fixture-token")
	t.Setenv("SHARE_RETENTION_HOURS", "24")
	t.Setenv("SHARE_MAX_RESULTS", "128")
	config, err = loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	client, err = config.clientConfig(request)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ = json.Marshal(client)
	if !client.Features.Sharing || !client.Features.ShareRequiresToken || strings.Contains(string(encoded), config.ShareWriteToken) || strings.Contains(string(encoded), config.ShareDBPath) {
		t.Fatalf("invalid public capability config: %s", encoded)
	}
}

func TestOptionalFeatureConfigRejectsInvalidSettings(t *testing.T) {
	for _, entry := range []struct{ name, value string }{
		{"GEOIP_PROVIDER", "unknown"}, {"GEOIP_PROVIDER", "offline"},
		{"GEOIP_DB_PATH", "bad\npath"}, {"CLIENT_NETWORK_LABEL", "label\nheader"},
		{"SHARE_DB_PATH", "bad\npath"}, {"SHARE_WRITE_TOKEN", "bad\nheader"},
		{"SHARE_RETENTION_HOURS", "0"}, {"SHARE_RETENTION_HOURS", "8761"},
		{"SHARE_MAX_RESULTS", "127"}, {"SHARE_MAX_RESULTS", "100001"},
	} {
		t.Run(entry.name+"="+entry.value, func(t *testing.T) {
			clearConfigEnv(t)
			t.Setenv(entry.name, entry.value)
			if _, err := loadConfig(); err == nil {
				t.Fatal("invalid optional configuration accepted")
			}
		})
	}
}

func TestOptionalServiceIntegrationAndShutdown(t *testing.T) {
	clearConfigEnv(t)
	config, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	config.GeoIPEnabled = false
	web, _ := fs.Sub(embeddedWeb, "web")
	server, err := newSpeedServer(config, web)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	server.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "http://example.com/api/results", strings.NewReader("{}")))
	if w.Code != http.StatusNotFound {
		t.Fatalf("disabled sharing: %d", w.Code)
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	config.ShareDBPath = filepath.Join(t.TempDir(), "results.sqlite")
	server, err = newSpeedServer(config, web)
	if err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "http://example.com/api/results", strings.NewReader("{}"))
	r.Header.Set("Origin", "https://untrusted.example")
	server.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("sharing bypassed origin gate: %d", w.Code)
	}
	w = httptest.NewRecorder()
	server.serveMeasurementHTTP(w, httptest.NewRequest(http.MethodGet, "http://example.com/api/results/abcd", nil))
	if w.Code != http.StatusNotFound {
		t.Fatal("result API exposed on measurement listener")
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if err := server.sharing.db.Ping(); err == nil {
		t.Fatal("SQLite connection survived node shutdown")
	}
	config.GeoIPEnabled = true
	config.GeoIPProvider = "offline"
	config.GeoIPDBPath = "missing-explicit.mmdb"
	if _, err := newSpeedServer(config, web); err == nil {
		t.Fatal("invalid explicit MMDB did not fail startup")
	}
}
