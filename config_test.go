package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func clearConfigEnv(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"ADDR", "NODE_ID", "NODE_NAME", "MAX_CONCURRENT_TEST_REQUESTS",
		"TLS_CERT_FILE", "TLS_KEY_FILE", "TEST_DOWNLOAD_DURATION_MS",
		"TEST_UPLOAD_DURATION_MS", "TEST_WARMUP_MS",
		"MEASUREMENT_PORTS", "PUBLIC_ORIGIN", "MEASUREMENT_ORIGINS",
		"MAX_TEST_STREAMS", "UPLOAD_SESSION_LIMIT", "TEST_TRANSPORT",
	} {
		t.Setenv(name, "")
	}
	// The absent variable enables defaults; an explicitly empty value disables
	// extra listeners. Setenv above ensures the original state is restored.
	if err := os.Unsetenv("MEASUREMENT_PORTS"); err != nil {
		t.Fatal(err)
	}
}

func TestLoadConfigDefaultsAndOverrides(t *testing.T) {
	clearConfigEnv(t)
	config, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.Addr != ":8080" || config.NodeID != "local" || config.MaxConcurrentRequests != 128 || config.DownloadDurationMS != 10000 || config.WarmupMS != 1500 || config.MaxTestStreams != 30 || config.UploadSessionLimit != 256 || len(config.MeasurementPorts) != 0 || config.TestTransport != "websocket" {
		t.Fatalf("unexpected default config: %+v", config)
	}
	t.Setenv("ADDR", "127.0.0.1:9090")
	t.Setenv("NODE_ID", "office")
	t.Setenv("NODE_NAME", "企业内网节点")
	t.Setenv("MAX_CONCURRENT_TEST_REQUESTS", "12")
	t.Setenv("TLS_CERT_FILE", "/tmp/cert.pem")
	t.Setenv("TLS_KEY_FILE", "/tmp/key.pem")
	t.Setenv("TEST_DOWNLOAD_DURATION_MS", "3000")
	t.Setenv("TEST_UPLOAD_DURATION_MS", "3000")
	t.Setenv("TEST_WARMUP_MS", "1000")
	t.Setenv("MEASUREMENT_PORTS", "9091, 9092")
	t.Setenv("MAX_TEST_STREAMS", "30")
	t.Setenv("UPLOAD_SESSION_LIMIT", "128")
	config, err = loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.Addr != "127.0.0.1:9090" || config.NodeID != "office" || config.NodeName != "企业内网节点" || config.MaxConcurrentRequests != 12 || config.TLSKeyFile != "/tmp/key.pem" || config.DownloadDurationMS != 3000 || config.WarmupMS != 1000 || config.MaxTestStreams != 30 || config.UploadSessionLimit != 128 || !reflect.DeepEqual(config.MeasurementPorts, []string{"9091", "9092"}) {
		t.Fatalf("overrides were not applied: %+v", config)
	}
}

func TestLoadConfigRejectsInvalidDeploymentSettings(t *testing.T) {
	for _, entry := range []struct {
		name  string
		value string
	}{
		{"MAX_CONCURRENT_TEST_REQUESTS", "0"},
		{"MAX_CONCURRENT_TEST_REQUESTS", "4097"},
		{"MAX_CONCURRENT_TEST_REQUESTS", "unlimited"},
		{"TLS_CERT_FILE", "/tmp/cert.pem"},
		{"TLS_KEY_FILE", "/tmp/key.pem"},
		{"TEST_DOWNLOAD_DURATION_MS", "999"},
		{"TEST_UPLOAD_DURATION_MS", "60001"},
		{"TEST_WARMUP_MS", "10001"},
		{"TEST_WARMUP_MS", "-1"},
		{"NODE_ID", "node\nother"},
		{"ADDR", "127.0.0.1"},
		{"ADDR", ":0"},
		{"MEASUREMENT_PORTS", "8080"},
		{"MEASUREMENT_PORTS", "8081,08081"},
		{"MEASUREMENT_PORTS", "0"},
		{"MEASUREMENT_PORTS", "65536"},
		{"MEASUREMENT_PORTS", "8081,"},
		{"MEASUREMENT_PORTS", "+8081"},
		{"MAX_TEST_STREAMS", "0"},
		{"MAX_TEST_STREAMS", "31"},
		{"TEST_TRANSPORT", "unknown"},
		{"UPLOAD_SESSION_LIMIT", "0"},
		{"PUBLIC_ORIGIN", "https://example.com/path"},
		{"MEASUREMENT_ORIGINS", "https://measure.example.com"},
	} {
		t.Run(entry.name+"="+entry.value, func(t *testing.T) {
			clearConfigEnv(t)
			t.Setenv(entry.name, entry.value)
			if _, err := loadConfig(); err == nil {
				t.Fatal("invalid configuration was accepted")
			}
		})
	}
}

func TestClientConfigPerformanceAndSinglePortFallback(t *testing.T) {
	clearConfigEnv(t)
	config, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "http://example.com:8080/api/config", nil)
	client, err := config.clientConfig(r)
	if err != nil {
		t.Fatal(err)
	}
	if client.ProtocolVersion != 2 || client.Nodes[0].BaseURL != "" || client.Test.MinStreams != 8 || client.Test.MaxStreams != 30 || client.Performance.MaxStreams != 30 || client.Performance.DefaultMode != "manual" || client.Performance.DefaultStreams != 8 || client.Performance.Transport != "websocket" || client.Performance.DownloadBlockBytes != 25<<20 || client.Performance.UploadBlockBytes != 25<<20 || client.Performance.MaxUploadBodyBytes != 1<<30 {
		t.Fatalf("unexpected performance protocol: %+v", client)
	}
	if !reflect.DeepEqual(client.Performance.MeasurementOrigins, []string{"http://example.com:8080"}) {
		t.Fatalf("unexpected measurement origins: %v", client.Performance.MeasurementOrigins)
	}
	t.Setenv("MEASUREMENT_PORTS", "")
	t.Setenv("TEST_TRANSPORT", "http")
	config, err = loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	client, err = config.clientConfig(r)
	if err != nil {
		t.Fatal(err)
	}
	if len(config.MeasurementPorts) != 0 || client.Test.MaxStreams != 4 || client.Performance.MaxStreams != 4 || !reflect.DeepEqual(client.Performance.MeasurementOrigins, []string{"http://example.com:8080"}) {
		t.Fatalf("unexpected single origin fallback: %+v", client)
	}
	t.Setenv("MEASUREMENT_PORTS", "8081,8082,8083,8084")
	config, err = loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	client, err = config.clientConfig(r)
	if err != nil || client.Performance.MaxStreams != 24 {
		t.Fatalf("HTTP origin capacity: %+v %v", client, err)
	}
	t.Setenv("MAX_TEST_STREAMS", "1")
	config, err = loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	client, err = config.clientConfig(r)
	if err != nil || client.Test.MinStreams != 1 || client.Test.MaxStreams != 1 {
		t.Fatalf("configured stream bound: %+v %v", client.Test, err)
	}
}

func TestWarmupIsIndependentFromMeasurementDuration(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("TEST_WARMUP_MS", "10000")
	t.Setenv("TEST_DOWNLOAD_DURATION_MS", "1000")
	t.Setenv("TEST_UPLOAD_DURATION_MS", "1000")
	config, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if config.WarmupMS != 10000 || config.DownloadDurationMS != 1000 || config.UploadDurationMS != 1000 {
		t.Fatalf("independent warmup and measurement durations were not preserved: %+v", config)
	}
}

func TestOriginsDeriveWebsiteAndIndependentMeasurementPorts(t *testing.T) {
	config := Config{Addr: ":8080", MeasurementPorts: []string{"8081", "8082"}}
	for _, entry := range []struct {
		host, main string
		tls        bool
		origins    []string
	}{
		{"example.com:8080", "http://example.com:8080", false, []string{"http://example.com:8081", "http://example.com:8082"}},
		{"example.com:8081", "http://example.com:8080", false, []string{"http://example.com:8081", "http://example.com:8082"}},
		{"example.com", "https://example.com", true, []string{"https://example.com:8081", "https://example.com:8082"}},
		{"[2001:db8::1]:8082", "https://[2001:db8::1]:8080", true, []string{"https://[2001:db8::1]:8081", "https://[2001:db8::1]:8082"}},
		{"[::1]", "http://[::1]", false, []string{"http://[::1]:8081", "http://[::1]:8082"}},
		{"[::ffff:127.0.0.1]:8081", "http://[::ffff:7f00:1]:8080", false, []string{"http://[::ffff:7f00:1]:8081", "http://[::ffff:7f00:1]:8082"}},
	} {
		t.Run(entry.host, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "http://example.com/api/config", nil)
			r.Host = entry.host
			r.Header.Set("X-Forwarded-Host", "untrusted.example")
			r.Header.Set("X-Forwarded-Proto", "ftp")
			if entry.tls {
				r.TLS = &tls.ConnectionState{}
			}
			main, origins, err := config.origins(r)
			if err != nil || main != entry.main || !reflect.DeepEqual(origins, entry.origins) {
				t.Fatalf("got main=%q origins=%v error=%v", main, origins, err)
			}
		})
	}
}

func TestExplicitOriginsAndPublicWebsiteOverride(t *testing.T) {
	clearConfigEnv(t)
	t.Setenv("PUBLIC_ORIGIN", "HTTPS://SPEED.EXAMPLE.COM:443")
	t.Setenv("MEASUREMENT_ORIGINS", "https://data1.example.com, https://[2001:db8::1]:8443")
	t.Setenv("MEASUREMENT_PORTS", "")
	config, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "http://internal:8081/api/download", nil)
	main, origins, err := config.origins(r)
	if err != nil || main != "https://speed.example.com" || !reflect.DeepEqual(origins, []string{"https://data1.example.com", "https://[2001:db8::1]:8443"}) {
		t.Fatalf("explicit origins were not applied: main=%q origins=%v err=%v", main, origins, err)
	}
	client, err := config.clientConfig(r)
	if err != nil || client.Performance.MaxStreams != 30 {
		t.Fatalf("external measurement origins incorrectly disabled parallelism: %+v %v", client, err)
	}
	for _, value := range []string{"https://data.example.com,", "https://DATA.example.com,https://data.example.com:443", "https://data.example.com/path"} {
		t.Setenv("MEASUREMENT_ORIGINS", value)
		if _, err := loadConfig(); err == nil {
			t.Fatalf("invalid configured origins were accepted: %q", value)
		}
	}
}

func TestOriginRejectsURLsAndInvalidHosts(t *testing.T) {
	for _, value := range []string{
		"", "//example.com", "ftp://example.com", "https://user@example.com",
		"https://example.com/", "https://example.com/%2f", "https://example.com?", "https://example.com?q=x",
		"https://example.com#", "https://example.com#fragment", "https://example.com:0", "https://example.com:65536",
		"https://example.com:abc", "https://example.com:", "https://example..com", "https://-example.com",
		"https://exa mple.com", "https://[fe80::1%25eth0]", "https://example.com\n",
		"http://[example.com]", "http://[127.0.0.1]", "http://127.1", "http://0x7f000001", "http://127.0.0.01",
	} {
		t.Run(value, func(t *testing.T) {
			if origin, err := normalizeOrigin(value); err == nil {
				t.Fatalf("invalid origin %q normalized to %q", value, origin)
			}
		})
	}
	config := Config{}
	for _, host := range []string{"evil.example/path", "user@evil.example", "example.com\r\nOrigin: evil", "example.com:65536"} {
		r := httptest.NewRequest(http.MethodGet, "http://example.com", nil)
		r.Host = host
		if _, _, err := config.origins(r); err == nil {
			t.Fatalf("invalid request Host was accepted: %q", host)
		}
	}
}

func TestBindServersReleasesPortsOnPartialFailure(t *testing.T) {
	mainProbe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	mainAddress := mainProbe.Addr().String()
	if err := mainProbe.Close(); err != nil {
		t.Fatal(err)
	}
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	_, dataPort, _ := net.SplitHostPort(occupied.Addr().String())
	if _, _, err := bindServers(Config{Addr: mainAddress, MeasurementPorts: []string{dataPort}}, nil); err == nil {
		t.Fatal("occupied measurement listener was accepted")
	}
	mainProbe, err = net.Listen("tcp", mainAddress)
	if err != nil {
		t.Fatalf("failed setup left the main listener bound: %v", err)
	}
	defer mainProbe.Close()
}

func TestTLSMeasurementListenersUseIndependentHTTP1Connections(t *testing.T) {
	// Reuse httptest's trusted local certificate, preserving certificate
	// verification while exercising HTTP/2 negotiation on the control listener.
	certificateSource := httptest.NewUnstartedServer(http.NotFoundHandler())
	certificateSource.EnableHTTP2 = true
	certificateSource.StartTLS()
	defer certificateSource.Close()
	certificate := certificateSource.TLS.Certificates[0]
	privateKey, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	config := Config{Addr: "127.0.0.1:0", MeasurementPorts: []string{"0"}}
	config.TLSCertFile = filepath.Join(t.TempDir(), "certificate.pem")
	config.TLSKeyFile = filepath.Join(t.TempDir(), "private-key.pem")
	if err := os.WriteFile(config.TLSCertFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.TLSKeyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateKey}), 0600); err != nil {
		t.Fatal(err)
	}
	servers, listeners, err := bindServers(config, testServer(t, 2))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		shutdownServers(ctx, servers)
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}()
	for i, server := range servers {
		listener := listeners[i]
		go func() { _ = server.ServeTLS(listener, "", "") }()
	}
	transport := &http.Transport{
		TLSClientConfig:   certificateSource.Client().Transport.(*http.Transport).TLSClientConfig.Clone(),
		ForceAttemptHTTP2: true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	for i, listener := range listeners {
		response, err := client.Get("https://" + listener.Addr().String() + "/healthz")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		wantProtocol := 2
		if i > 0 {
			wantProtocol = 1
		}
		if response.StatusCode != http.StatusOK || response.ProtoMajor != wantProtocol || response.TLS.Version != tls.VersionTLS13 {
			t.Fatalf("listener %d response: status=%d protocol=%s TLS=%x", i, response.StatusCode, response.Proto, response.TLS.Version)
		}
	}
	dataOrigin := "https://" + listeners[1].Addr().String()
	response, err := client.Get(dataOrigin + "/api/download?bytes=1024")
	if err != nil {
		t.Fatal(err)
	}
	count, err := io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if err != nil || count != 1024 || response.Header.Get("X-Test-Connection-ID") == "" || response.Header.Get("X-Test-Protocol") != "HTTP/1.1" {
		t.Fatalf("data listener did not expose its TCP measurement: %d bytes headers=%v err=%v", count, response.Header, err)
	}
	response, err = client.Get(dataOrigin + "/api/config")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("control route was exposed on measurement listener: %d", response.StatusCode)
	}
}
