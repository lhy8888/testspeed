package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type networkRoundTripper func(*http.Request) (*http.Response, error)

func (transport networkRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}
func networkResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func TestNetworkConfiguration(t *testing.T) {
	clearConfigEnv(t)
	config, err := loadConfig()
	if err != nil || !config.GeoIPEnabled || config.ServerLocation != "" || len(config.TrustedProxies) != 0 {
		t.Fatalf("network defaults: %+v %v", config, err)
	}
	t.Setenv("GEOIP_ENABLED", "false")
	t.Setenv("SERVER_LOCATION", "  上海 · 企业机房  ")
	t.Setenv("TRUSTED_PROXIES", "10.1.2.3/8,fd00::/8")
	config, err = loadConfig()
	if err != nil || config.GeoIPEnabled || config.ServerLocation != "上海 · 企业机房" || len(config.TrustedProxies) != 2 || config.TrustedProxies[0].String() != "10.0.0.0/8" {
		t.Fatalf("network configuration: %+v %v", config, err)
	}
	for _, entry := range []struct{ name, value string }{{"GEOIP_ENABLED", "sometimes"}, {"SERVER_LOCATION", "somewhere\nelse"}, {"TRUSTED_PROXIES", "10.0.0.1"}, {"TRUSTED_PROXIES", "::ffff:10.0.0.0/104"}, {"TRUSTED_PROXIES", "10.0.0.0/8,"}} {
		t.Run(entry.name+entry.value, func(t *testing.T) {
			clearConfigEnv(t)
			t.Setenv(entry.name, entry.value)
			if _, err := loadConfig(); err == nil {
				t.Fatal("invalid network configuration accepted")
			}
		})
	}
}

func TestClientAddressTrustsOnlyRightmostVerifiedProxyChain(t *testing.T) {
	config := Config{TrustedProxies: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("fd00::/8")}}
	for _, entry := range []struct {
		peer, xff, forwarded, want string
		proxied                    bool
	}{
		{"8.8.8.8:1234", "1.1.1.1", "", "8.8.8.8", false},
		{"10.0.0.3:1234", "8.8.8.8, 1.1.1.1, 10.0.0.2", "", "1.1.1.1", true},
		{"10.0.0.3:1234", "", "for=8.8.8.8, for=1.1.1.1, for=10.0.0.2;proto=https", "1.1.1.1", true},
		{"10.0.0.3:1234", "1.1.1.1,10.0.0.2", "for=1.1.1.1,for=10.0.0.2", "1.1.1.1", true},
		{"10.0.0.3:1234", "8.8.8.8", "for=1.1.1.1", "10.0.0.3", false},
		{"10.0.0.3:1234", "8.8.8.8, broken, 10.0.0.2", "", "10.0.0.3", false},
		{"10.0.0.3:1234", "8.8.8.8", "for=unknown", "10.0.0.3", false},
		{"10.0.0.3:1234", "", "for=_hidden", "10.0.0.3", false},
		{"10.0.0.3:1234", "", "for=8.8.8.8;for=1.1.1.1", "10.0.0.3", false},
		{"[fd00::3]:1234", "", "for=\"[2606:4700:4700::1111]:1234\", for=\"[fd00::2]\"", "2606:4700:4700::1111", true},
		{"[::ffff:10.0.0.3]:1234", "::ffff:8.8.8.8", "", "8.8.8.8", true},
		{"10.0.0.3:1234", "fe80::1%eth0", "", "10.0.0.3", false},
	} {
		r := httptest.NewRequest(http.MethodGet, "/api/network-info", nil)
		r.RemoteAddr = entry.peer
		if entry.xff != "" {
			r.Header.Set("X-Forwarded-For", entry.xff)
		}
		if entry.forwarded != "" {
			r.Header.Set("Forwarded", entry.forwarded)
		}
		address, proxied := config.clientAddress(r)
		if address.String() != entry.want || proxied != entry.proxied {
			t.Errorf("peer=%s XFF=%q Forwarded=%q => %s/%t want%s/%t", entry.peer, entry.xff, entry.forwarded, address, proxied, entry.want, entry.proxied)
		}
	}
}

func TestNonPublicAddressesNeverBecomeGeoLookupTargets(t *testing.T) {
	for _, entry := range []struct{ ip, scope string }{
		{"127.0.0.1", "loopback"}, {"::1", "loopback"}, {"::ffff:127.0.0.1", "loopback"},
		{"10.0.0.1", "private"}, {"192.168.1.1", "private"}, {"172.16.1.1", "private"}, {"fd00::1", "private"}, {"100.64.1.1", "private"},
		{"169.254.1.1", "link-local"}, {"fe80::1", "link-local"}, {"192.0.2.1", "reserved"}, {"198.51.100.1", "reserved"}, {"203.0.113.1", "reserved"}, {"2001:db8::1", "reserved"}, {"198.18.0.1", "reserved"}, {"224.0.0.1", "reserved"},
		{"8.8.8.8", "public"}, {"2606:4700:4700::1111", "public"},
		{"fec0::1", "reserved"}, {"3fff::1", "reserved"}, {"100::1", "reserved"}, {"2001:2::1", "reserved"}, {"2001:20::1", "reserved"}, {"192.88.99.1", "reserved"},
	} {
		if scope := addressScope(netip.MustParseAddr(entry.ip)); scope != entry.scope {
			t.Errorf("%s scope=%s want=%s", entry.ip, scope, entry.scope)
		}
	}
	handler := testServer(t, 2)
	handler.config.GeoIPEnabled = true
	handler.network.enabled = true // This test explicitly changes the fixture's disabled deployment configuration.
	handler.config.ServerLocation = "北京 · 内网机房"
	var calls atomic.Int32
	handler.network.client.Transport = networkRoundTripper(func(*http.Request) (*http.Response, error) { calls.Add(1); return networkResponse(`{}`), nil })
	r := httptest.NewRequest(http.MethodGet, "/api/network-info", nil)
	r.RemoteAddr = "192.168.2.3:1234"
	r.Header.Set("X-Forwarded-For", "8.8.8.8")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	var info networkInfo
	if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 || info.Client.IP != "192.168.2.3" || info.Client.Location.Status != "internal" || info.Server.Location.Label != "北京 · 内网机房" || info.Server.Location.Source != "configured" || info.Server.Location.Approximate {
		t.Fatalf("internal/manual network info: %+v providerCalls=%d", info, calls.Load())
	}
}

func TestNetworkLookupUsesFixedHTTPSProviderCachesAndMarksEgressApproximate(t *testing.T) {
	handler := testServer(t, 2)
	handler.config.GeoIPEnabled = true
	handler.network.enabled = true
	var calls atomic.Int32
	handler.network.client.Transport = networkRoundTripper(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.URL.Scheme != "https" || r.URL.Host != "free.freeipapi.com" {
			t.Errorf("lookup did not use fixed HTTPS provider: %s", r.URL)
		}
		ip := "8.8.8.8"
		if r.URL.Path == "/api/json" {
			ip = "1.1.1.1"
		}
		return networkResponse(`{"ipAddress":"` + ip + `","countryName":"United States","countryCode":"US","regionName":"California","cityName":"Los Angeles"}`), nil
	})
	for range 2 {
		r := httptest.NewRequest(http.MethodGet, "http://fake-host.example/api/network-info", nil)
		r.RemoteAddr = "8.8.8.8:1234"
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var info networkInfo
		if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil {
			t.Fatal(err)
		}
		if info.Client.IP != "8.8.8.8" || info.Client.Location.CountryCode != "US" || info.Server.IP != "1.1.1.1" || !info.Server.Location.Approximate || info.Server.Location.Source != "geoip" || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
			t.Fatalf("network geo result/provenance: %+v", info)
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("same client and server lookup was not cached: calls=%d", calls.Load())
	}
}

func TestNetworkProviderFailuresAreBoundedCachedAndDoNotAffectTests(t *testing.T) {
	handler := testServer(t, 2)
	handler.config.GeoIPEnabled = true
	handler.network.enabled = true
	handler.config.ServerLocation = "configured"
	var calls atomic.Int32
	handler.network.client.Transport = networkRoundTripper(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: 429, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("limited"))}, nil
	})
	for range 2 {
		r := httptest.NewRequest(http.MethodGet, "/api/network-info", nil)
		r.RemoteAddr = "8.8.8.8:1234"
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"status":"unavailable"`) {
			t.Fatalf("provider failure blocked network response: %d %s", w.Code, w.Body)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("provider failure was not cached")
	}
	if w := request(handler, http.MethodGet, "/api/ping", nil); w.Code != http.StatusOK {
		t.Fatal("geo failure blocked measurement ping")
	}
	if w := request(handler, http.MethodGet, "/api/download?bytes=1", nil); w.Code != http.StatusOK || w.Body.Len() != 1 {
		t.Fatal("geo failure blocked transfer")
	}
	handler.config.GeoIPEnabled = false
	r := httptest.NewRequest(http.MethodGet, "/api/network-info", nil)
	r.RemoteAddr = "8.8.8.8:1234"
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if !strings.Contains(w.Body.String(), `"status":"disabled"`) || calls.Load() != 1 {
		t.Fatal("disabled geo still queried provider")
	}
}

func TestNetworkLookupCoalescesAndCapsConcurrentRequests(t *testing.T) {
	service := newNetworkService()
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	var calls atomic.Int32
	service.client.Transport = networkRoundTripper(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return nil, r.Context().Err()
		}
		return networkResponse(`{"success":false}`), nil
	})
	var tasks sync.WaitGroup
	for _, ip := range []string{"8.8.8.8", "1.1.1.1", "9.9.9.9", "4.2.2.2"} {
		tasks.Add(1)
		go func() { defer tasks.Done(); service.lookup(context.Background(), ip) }()
	}
	for range 4 {
		<-started
	}
	if result := service.lookup(context.Background(), "8.8.4.4"); result.Location.Status != "unavailable" || calls.Load() != 4 {
		t.Fatal("full provider concurrency did not fail open immediately")
	}
	tasks.Add(1)
	go func() { defer tasks.Done(); service.lookup(context.Background(), "8.8.8.8") }()
	close(release)
	tasks.Wait()
	if calls.Load() != 4 {
		t.Fatalf("same-IP lookup was not coalesced: %d", calls.Load())
	}
	bounded := newNetworkService()
	bounded.client.Transport = networkRoundTripper(func(*http.Request) (*http.Response, error) { return networkResponse(`{}`), nil })
	for index := range 256 {
		key := netip.AddrFrom4([4]byte{8, 8, 1, byte(index)}).String()
		bounded.cache[key] = geoCacheEntry{expires: time.Now().Add(time.Hour), accessed: time.Now().Add(time.Duration(index-256) * time.Second)}
	}
	bounded.lookup(context.Background(), "9.9.9.9")
	if len(bounded.cache) != 256 {
		t.Fatalf("geo cache grew past bound: %d", len(bounded.cache))
	}
	if _, ok := bounded.cache["8.8.1.0"]; ok {
		t.Fatal("oldest cache entry was not evicted")
	}
	if service.client.Timeout != 1500*time.Millisecond {
		t.Fatal("provider request timeout missing")
	}
}

func TestNetworkProviderRateLimitAndGlobalCooldown(t *testing.T) {
	service := newNetworkService()
	var calls atomic.Int32
	service.client.Transport = networkRoundTripper(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		return networkResponse(`{"ipAddress":"` + strings.TrimPrefix(r.URL.Path, "/api/json/") + `","countryName":"Example","countryCode":"US"}`), nil
	})
	for _, ip := range []string{"8.8.8.8", "1.1.1.1", "9.9.9.9", "4.2.2.2"} {
		if service.lookup(context.Background(), ip).Location.Status != "resolved" {
			t.Fatal("initial token burst failed")
		}
	}
	if service.lookup(context.Background(), "8.8.4.4").Location.Status != "unavailable" || calls.Load() != 4 {
		t.Fatal("provider burst exceeded four")
	}
	if service.lookup(context.Background(), "8.8.8.8").Location.Status != "resolved" || calls.Load() != 4 {
		t.Fatal("cache hit spent provider quota")
	}
	service.lastRefill = time.Now().Add(-1500 * time.Millisecond)
	if service.lookup(context.Background(), "8.8.4.4").Location.Status != "resolved" || calls.Load() != 5 {
		t.Fatal("provider token was not replenished at forty per minute")
	}
	cooldown := newNetworkService()
	cooldown.client.Transport = networkRoundTripper(func(*http.Request) (*http.Response, error) {
		response := networkResponse("limited")
		response.StatusCode = 429
		response.Header.Set("Retry-After", "120")
		return response, nil
	})
	cooldown.lookup(context.Background(), "8.8.8.8")
	if remaining := time.Until(cooldown.cooldownUntil); remaining < 119*time.Second || remaining > 121*time.Second {
		t.Fatalf("429 Retry-After cooldown ignored: %s", remaining)
	}
	cooldown.client.Transport = networkRoundTripper(func(*http.Request) (*http.Response, error) {
		t.Error("global cooldown made a second network call")
		return networkResponse(`{}`), nil
	})
	if cooldown.lookup(context.Background(), "1.1.1.1").Location.Status != "unavailable" {
		t.Fatal("cooldown did not fail open")
	}
}

func TestNetworkProviderRejectsMalformedMismatchedAndLargeResponses(t *testing.T) {
	for _, entry := range []struct {
		body     string
		resolved bool
	}{
		{`{"ipAddress":"8.8.8.8","countryName":"Example","countryCode":"US"}`, true},
		{`[{"ipAddress":"8.8.8.8","countryName":"Example","countryCode":"US"}]`, true},
		{`[{"ipAddress":"8.8.8.8","countryName":"Example"},{"ipAddress":"1.1.1.1","countryName":"Example"}]`, false},
		{`{"ipAddress":"1.1.1.1","countryName":"Example"}`, false},
		{`{"ipAddress":"192.168.1.1","countryName":"Example"}`, false},
		{`{"ipAddress":"8.8.8.8","countryName":"bad\nline"}`, false},
		{`not json`, false}, {strings.Repeat(" ", 65537), false},
	} {
		service := newNetworkService()
		service.client.Transport = networkRoundTripper(func(*http.Request) (*http.Response, error) { return networkResponse(entry.body), nil })
		result := service.lookup(context.Background(), "8.8.8.8")
		if (result.Location.Status == "resolved") != entry.resolved {
			t.Errorf("malformed/mismatched response accepted: %q => %+v", entry.body[:min(len(entry.body), 100)], result)
		}
	}
}

func TestNetworkProviderPreservesTLSVerificationAndTimesOut(t *testing.T) {
	local := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ipAddress":"8.8.8.8","countryName":"Example","countryCode":"US"}`))
	}))
	defer local.Close()
	endpoint, _ := url.Parse(local.URL)
	for _, trusted := range []bool{false, true} {
		transport := &http.Transport{}
		defer transport.CloseIdleConnections()
		if trusted {
			roots := x509.NewCertPool()
			roots.AddCert(local.Certificate())
			transport.TLSClientConfig = &tls.Config{RootCAs: roots}
		}
		service := newNetworkService()
		service.client.Transport = networkRoundTripper(func(request *http.Request) (*http.Response, error) {
			copy := request.Clone(request.Context())
			location := *request.URL
			location.Host = endpoint.Host
			copy.URL = &location
			return transport.RoundTrip(copy)
		})
		result := service.lookup(context.Background(), "8.8.8.8")
		if (result.Location.Status == "resolved") != trusted {
			t.Fatalf("TLS certificate verification bypassed/missing: trusted=%t result=%+v", trusted, result)
		}
	}
	service := newNetworkService()
	service.client.Timeout = 20 * time.Millisecond
	service.client.Transport = networkRoundTripper(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	started := time.Now()
	if service.lookup(context.Background(), "8.8.8.8").Location.Status != "unavailable" || time.Since(started) > 500*time.Millisecond {
		t.Fatal("provider timeout did not fail open")
	}
}
