package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func configuredGeoTestService(t *testing.T, provider, fixture string) *networkService {
	t.Helper()
	service, err := newConfiguredNetworkService(Config{GeoIPEnabled: true, GeoIPProvider: provider, GeoIPDBPath: filepath.Join("testdata", "geoip", fixture)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := service.Close(); err != nil {
			t.Errorf("close offline reader: %v", err)
		}
	})
	return service
}

func TestOfflineGeoReadsActualMMDBSchemasWithoutNetwork(t *testing.T) {
	for _, test := range []struct {
		name, fixture, ip, country, region, city, isp, asn string
	}{
		{"nested city", "GeoIP2-City-Test.mmdb", "81.2.69.142", "GB", "England", "London", "", ""},
		{"nested ISP only", "GeoIP2-ISP-Test.mmdb", "1.128.0.1", "", "", "", "Telstra Internet", "AS1221"},
		{"flat location and ASN", "ipinfo_lite_sample.mmdb", "1.1.1.1", "AU", "", "", "Cloudflare, Inc.", "AS13335"},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := configuredGeoTestService(t, "offline", test.fixture)
			service.client.Transport = networkRoundTripper(func(*http.Request) (*http.Response, error) {
				t.Error("offline mode made an online provider request")
				return nil, errors.New("network forbidden")
			})
			result := service.lookup(context.Background(), test.ip)
			if result.IP != test.ip || result.Location.CountryCode != test.country || result.Location.Region != test.region || result.Location.City != test.city || result.ISP != test.isp || result.ASN != test.asn {
				t.Fatalf("fixture result: %+v", result)
			}
			if test.country != "" && (result.Location.Source != "mmdb" || !result.Location.Approximate || result.Location.Status != "resolved") {
				t.Fatalf("offline location provenance lost: %+v", result)
			}
			if test.country == "" && (result.Location.Status != "unavailable" || result.Location.Country != "") {
				t.Fatalf("ASN/ISP-only database invented a location: %+v", result)
			}
			if test.asn != "" && result.NetworkSource != "mmdb" {
				t.Fatalf("offline ownership provenance lost: %+v", result)
			}
			for _, ip := range []string{"", "10.0.0.1", "127.0.0.1", "2001:db8::1", "2001:4860:4860::8888", "not-an-address"} {
				if result := service.lookup(context.Background(), ip); result.IP != "" || result.Location.Status != "unavailable" || result.ISP != "" || result.ASN != "" {
					t.Fatalf("unknown, internal or missing MMDB record yielded data for %q: %+v", ip, result)
				}
			}
		})
	}
}

func TestOfflineGeoInitializationFailsForExplicitInvalidDatabase(t *testing.T) {
	temporary := filepath.Join(t.TempDir(), "invalid.mmdb")
	if err := os.WriteFile(temporary, []byte("this is not an MMDB"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, config := range []Config{
		{GeoIPEnabled: true, GeoIPProvider: "offline"},
		{GeoIPEnabled: true, GeoIPProvider: "unexpected"},
		{GeoIPEnabled: true, GeoIPDBPath: temporary},
		{GeoIPEnabled: true, GeoIPDBPath: temporary + "-absent"},
	} {
		if service, err := newConfiguredNetworkService(config); err == nil {
			_ = service.Close()
			t.Errorf("invalid explicit offline configuration accepted: %+v", config)
		}
	}
	// Preserve a structurally valid MMDB but replace its equally long database
	// type. A valid search tree alone must not pass schema validation.
	data, err := os.ReadFile(filepath.Join("testdata", "geoip", "GeoIP2-City-Test.mmdb"))
	if err != nil {
		t.Fatal(err)
	}
	otherType := filepath.Join(t.TempDir(), "unsupported.mmdb")
	if err := os.WriteFile(otherType, bytes.ReplaceAll(data, []byte("GeoIP2-City"), []byte("OtherDB-XYZ")), 0600); err != nil {
		t.Fatal(err)
	}
	if service, err := newConfiguredNetworkService(Config{GeoIPEnabled: true, GeoIPDBPath: otherType}); err == nil {
		_ = service.Close()
		t.Fatal("unrelated MMDB schema was accepted")
	}
	// Disabling geolocation preserves an IP-only deployment even if a previously
	// configured optional database has been removed.
	service, err := newConfiguredNetworkService(Config{GeoIPEnabled: false, GeoIPProvider: "offline", GeoIPDBPath: temporary + "-absent"})
	if err != nil || service.offline != nil {
		t.Fatalf("disabled geolocation tried opening database: %+v %v", service, err)
	}
	service.client.Transport = networkRoundTripper(func(*http.Request) (*http.Response, error) {
		t.Error("disabled geolocation queried provider")
		return nil, errors.New("disabled")
	})
	if result := service.lookup(context.Background(), "1.1.1.1"); result.Location.Status != "unavailable" {
		t.Fatal("disabled geolocation still resolved location")
	}
	_ = service.Close()
}

func TestGeoAutoFallbackIsCachedCoalescedAndHonorsProviderSelection(t *testing.T) {
	service := configuredGeoTestService(t, "auto", "ipinfo_lite_sample.mmdb")
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	service.client.Transport = networkRoundTripper(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		close(started)
		<-release
		return nil, errors.New("provider unavailable")
	})
	var tasks sync.WaitGroup
	results := make(chan geoResult, 12)
	for range 12 {
		tasks.Add(1)
		go func() {
			defer tasks.Done()
			results <- service.lookup(context.Background(), "1.1.1.1")
		}()
	}
	<-started
	close(release)
	tasks.Wait()
	close(results)
	for result := range results {
		if result.Location.CountryCode != "AU" || result.ISP != "Cloudflare, Inc." || result.ASN != "AS13335" || result.NetworkSource != "mmdb" {
			t.Fatalf("auto fallback failed: %+v", result)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("same-IP auto fallback was not coalesced/cached: %d", calls.Load())
	}
	if ttl := time.Until(service.cache["1.1.1.1"].expires); ttl < 59*time.Minute || ttl > time.Hour {
		t.Fatalf("successful offline fallback did not receive success cache TTL: %v", ttl)
	}
	online := configuredGeoTestService(t, "online", "ipinfo_lite_sample.mmdb")
	online.client.Transport = networkRoundTripper(func(*http.Request) (*http.Response, error) { return nil, errors.New("no online") })
	if result := online.lookup(context.Background(), "1.1.1.1"); result.Location.Status != "unavailable" || result.ISP != "" || result.ASN != "" {
		t.Fatalf("online-only mode used offline database: %+v", result)
	}
}

func TestGeoAutoFallbackSurvivesOnlineRateLimitAndEnrichesMissingOwnership(t *testing.T) {
	for _, name := range []string{"quota exhausted", "provider cooldown", "online ownership absent"} {
		t.Run(name, func(t *testing.T) {
			service := configuredGeoTestService(t, "auto", "ipinfo_lite_sample.mmdb")
			calls := 0
			service.client.Transport = networkRoundTripper(func(*http.Request) (*http.Response, error) {
				calls++
				return networkResponse(`{"ipAddress":"1.1.1.1","countryName":"Online country","countryCode":"US"}`), nil
			})
			if name == "quota exhausted" {
				service.tokens = 0
			} else if name == "provider cooldown" {
				service.cooldownUntil = time.Now().Add(time.Minute)
			}
			result := service.lookup(context.Background(), "1.1.1.1")
			if result.ASN != "AS13335" || result.ISP != "Cloudflare, Inc." || result.NetworkSource != "mmdb" {
				t.Fatalf("offline ownership missing: %+v", result)
			}
			if name == "online ownership absent" {
				if calls != 1 || result.Location.CountryCode != "US" || result.Location.Source != "geoip" {
					t.Fatalf("offline enrichment overwrote online location: %+v calls=%d", result, calls)
				}
			} else if calls != 0 || result.Location.CountryCode != "AU" || result.Location.Source != "mmdb" {
				t.Fatalf("quota/cooldown did not fall back without fetching: %+v calls=%d", result, calls)
			}
		})
	}
}

func TestGeoAutoFallbackKeepsTLSVerificationAndTimeoutBound(t *testing.T) {
	local := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ipAddress":"1.1.1.1","countryName":"United States","countryCode":"US","asn":"13335"}`))
	}))
	defer local.Close()
	endpoint, _ := url.Parse(local.URL)
	for _, trusted := range []bool{false, true} {
		service := configuredGeoTestService(t, "auto", "ipinfo_lite_sample.mmdb")
		transport := &http.Transport{}
		defer transport.CloseIdleConnections()
		if trusted {
			roots := x509.NewCertPool()
			roots.AddCert(local.Certificate())
			transport.TLSClientConfig = &tls.Config{RootCAs: roots}
		}
		service.client.Transport = networkRoundTripper(func(request *http.Request) (*http.Response, error) {
			copy := request.Clone(request.Context())
			location := *request.URL
			location.Host = endpoint.Host
			copy.URL = &location
			return transport.RoundTrip(copy)
		})
		result := service.lookup(context.Background(), "1.1.1.1")
		if trusted {
			if result.Location.CountryCode != "US" || result.Location.Source != "geoip" || result.ASN != "AS13335" || result.NetworkSource != "mixed" {
				t.Fatalf("trusted online result/offline enrichment incorrect: %+v", result)
			}
		} else if result.Location.CountryCode != "AU" || result.Location.Source != "mmdb" || result.NetworkSource != "mmdb" {
			t.Fatalf("untrusted TLS did not fall back to local data: %+v", result)
		}
	}
	service := configuredGeoTestService(t, "auto", "ipinfo_lite_sample.mmdb")
	service.client.Timeout = 20 * time.Millisecond
	service.client.Transport = networkRoundTripper(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	started := time.Now()
	if result := service.lookup(context.Background(), "1.1.1.1"); result.Location.CountryCode != "AU" || time.Since(started) > 500*time.Millisecond {
		t.Fatalf("timed-out provider did not yield bounded offline fallback: %+v", result)
	}
}

func TestOfflineNetworkInfoNeverInventsServerAddressAndSupportsInternalLabel(t *testing.T) {
	handler := testServer(t, 2)
	handler.config.GeoIPEnabled = true
	handler.config.ClientNetworkLabel = "上海 · 企业办公网"
	_ = handler.network.Close()
	handler.network = configuredGeoTestService(t, "offline", "ipinfo_lite_sample.mmdb")
	handler.network.client.Transport = networkRoundTripper(func(*http.Request) (*http.Response, error) {
		t.Error("offline network-info queried a third party")
		return nil, errors.New("forbidden")
	})
	for _, ip := range []string{"1.1.1.1", "192.168.3.4"} {
		r := httptest.NewRequest(http.MethodGet, "/api/network-info", nil)
		r.RemoteAddr = ip + ":12345"
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var info networkInfo
		if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil {
			t.Fatal(err)
		}
		if info.Server.IP != "" || info.Server.Location.Status != "unavailable" || info.Server.Scope != "unknown" {
			t.Fatalf("offline database invented server address/location: %+v", info.Server)
		}
		if ip == "1.1.1.1" {
			if info.Client.ISP != "Cloudflare, Inc." || info.Client.ASN != "AS13335" || info.Client.NetworkSource != "mmdb" || info.Client.Location.Source != "mmdb" {
				t.Fatalf("network-info omitted real ownership fields: %+v", info.Client)
			}
		} else if info.Client.Location.Label != handler.config.ClientNetworkLabel || info.Client.Location.Source != "configured" || info.Client.Location.Approximate || info.Client.ISP != "" || info.Client.ASN != "" {
			t.Fatalf("explicit internal network label lost/misattributed: %+v", info.Client)
		}
	}
	handler.config.ServerLocation = "圣何塞 · 机房 A"
	w := request(handler, http.MethodGet, "/api/network-info", nil)
	if !strings.Contains(w.Body.String(), "圣何塞 · 机房 A") {
		t.Fatal("offline mode ignored explicit physical server location")
	}
}

func TestOfflineGeoCloseCanRaceWithLookupAndIsIdempotent(t *testing.T) {
	service := configuredGeoTestService(t, "offline", "ipinfo_lite_sample.mmdb")
	var tasks sync.WaitGroup
	for range 20 {
		tasks.Add(1)
		go func() {
			defer tasks.Done()
			for range 20 {
				result := service.lookup(context.Background(), "1.1.1.1")
				if result.Location.Status != "unavailable" && result.ASN != "AS13335" {
					t.Errorf("reader produced invalid result during close: %+v", result)
				}
			}
		}()
	}
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	tasks.Wait()
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}
	if result := service.lookup(context.Background(), "1.1.1.1"); result.Location.Status != "unavailable" {
		t.Fatal("closed reader continued producing data")
	}
}

func TestOnlineProviderReadsOnlyDocumentedASNFields(t *testing.T) {
	for _, test := range []struct{ asn, organization, wantASN, wantISP string }{
		{"15169", "Google LLC", "AS15169", "Google LLC"},
		{"AS013335", "Cloudflare, Inc.", "AS13335", "Cloudflare, Inc."},
		{"4294967295", "Example", "AS4294967295", "Example"},
		{"4294967296", "Example", "", "Example"},
		{"0", "Example", "", "Example"},
		{"not-asn", "bad\norganization", "", ""},
	} {
		service := newNetworkService()
		payload, _ := json.Marshal(map[string]string{"ipAddress": "8.8.8.8", "countryName": "United States", "countryCode": "US", "asn": test.asn, "asnOrganization": test.organization, "isp": "undocumented and ignored"})
		service.client.Transport = networkRoundTripper(func(*http.Request) (*http.Response, error) { return networkResponse(string(payload)), nil })
		result := service.lookup(context.Background(), "8.8.8.8")
		if result.ASN != test.wantASN || result.ISP != test.wantISP || result.Location.CountryCode != "US" {
			t.Fatalf("documented ASN fields were incorrectly parsed: %+v", result)
		}
	}
}
