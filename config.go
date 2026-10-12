package main

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
)

const (
	defaultDownloadBytes = 8 << 20
	maxTransferBytes     = 64 << 20
)

// Config is the local node's deployment configuration. Measurement routes stay
// independent of the node list so additional nodes can implement this protocol.
type Config struct {
	Addr                  string
	NodeID                string
	NodeName              string
	MaxConcurrentRequests int
	TLSCertFile           string
	TLSKeyFile            string
	DownloadDurationMS    int
	UploadDurationMS      int
	WarmupMS              int
	MeasurementPorts      []string
	PublicOrigin          string
	MeasurementOrigins    []string
	MaxTestStreams        int
	UploadSessionLimit    int
	TestTransport         string
}

func loadConfig() (Config, error) {
	config := Config{
		Addr:                  envDefault("ADDR", ":8080"),
		NodeID:                envDefault("NODE_ID", "local"),
		NodeName:              envDefault("NODE_NAME", "默认测速节点"),
		MaxConcurrentRequests: 128,
		TLSCertFile:           strings.TrimSpace(os.Getenv("TLS_CERT_FILE")),
		TLSKeyFile:            strings.TrimSpace(os.Getenv("TLS_KEY_FILE")),
		DownloadDurationMS:    10000,
		UploadDurationMS:      10000,
		WarmupMS:              1500,
		MaxTestStreams:        30,
		UploadSessionLimit:    256,
		TestTransport:         envDefault("TEST_TRANSPORT", "websocket"),
	}
	if config.TestTransport != "websocket" && config.TestTransport != "http" {
		return Config{}, fmt.Errorf("TEST_TRANSPORT must be websocket or http")
	}
	_, mainPort, err := net.SplitHostPort(config.Addr)
	if err != nil {
		return Config{}, fmt.Errorf("ADDR must contain a host and numeric port: %w", err)
	}
	mainPort, err = normalizedPort(mainPort)
	if err != nil {
		return Config{}, fmt.Errorf("ADDR: %w", err)
	}
	if value, present := os.LookupEnv("MEASUREMENT_PORTS"); present {
		config.MeasurementPorts = nil
		if strings.TrimSpace(value) != "" {
			seen := map[string]bool{}
			for _, entry := range strings.Split(value, ",") {
				port, err := normalizedPort(strings.TrimSpace(entry))
				if err != nil {
					return Config{}, fmt.Errorf("MEASUREMENT_PORTS: %w", err)
				}
				if seen[port] {
					return Config{}, fmt.Errorf("MEASUREMENT_PORTS contains duplicate port %s", port)
				}
				seen[port] = true
				config.MeasurementPorts = append(config.MeasurementPorts, port)
			}
		}
	}
	for _, port := range config.MeasurementPorts {
		if port == mainPort {
			return Config{}, fmt.Errorf("MEASUREMENT_PORTS must not include the main ADDR port %s", mainPort)
		}
	}
	if value := strings.TrimSpace(os.Getenv("PUBLIC_ORIGIN")); value != "" {
		config.PublicOrigin, err = normalizeOrigin(value)
		if err != nil {
			return Config{}, fmt.Errorf("PUBLIC_ORIGIN: %w", err)
		}
	}
	if value := strings.TrimSpace(os.Getenv("MEASUREMENT_ORIGINS")); value != "" {
		if config.PublicOrigin == "" {
			return Config{}, fmt.Errorf("PUBLIC_ORIGIN is required with MEASUREMENT_ORIGINS to identify the main website")
		}
		seen := map[string]bool{}
		for _, entry := range strings.Split(value, ",") {
			origin, err := normalizeOrigin(strings.TrimSpace(entry))
			if err != nil {
				return Config{}, fmt.Errorf("MEASUREMENT_ORIGINS: %w", err)
			}
			if seen[origin] {
				return Config{}, fmt.Errorf("MEASUREMENT_ORIGINS contains duplicate origin %s", origin)
			}
			seen[origin] = true
			config.MeasurementOrigins = append(config.MeasurementOrigins, origin)
		}
	}
	if (config.TLSCertFile == "") != (config.TLSKeyFile == "") {
		return Config{}, fmt.Errorf("TLS_CERT_FILE and TLS_KEY_FILE must both be configured for HTTPS")
	}
	for _, setting := range []struct {
		name   string
		target *int
		min    int
		max    int
	}{
		{"MAX_CONCURRENT_TEST_REQUESTS", &config.MaxConcurrentRequests, 1, 4096},
		{"MAX_TEST_STREAMS", &config.MaxTestStreams, 1, 30},
		{"UPLOAD_SESSION_LIMIT", &config.UploadSessionLimit, 1, 4096},
		{"TEST_DOWNLOAD_DURATION_MS", &config.DownloadDurationMS, 1000, 60000},
		{"TEST_UPLOAD_DURATION_MS", &config.UploadDurationMS, 1000, 60000},
		{"TEST_WARMUP_MS", &config.WarmupMS, 0, 10000},
	} {
		if value := os.Getenv(setting.name); value != "" {
			parsed, err := strconv.Atoi(value)
			if err != nil || parsed < setting.min || parsed > setting.max {
				return Config{}, fmt.Errorf("%s must be an integer between %d and %d", setting.name, setting.min, setting.max)
			}
			*setting.target = parsed
		}
	}
	if strings.ContainsAny(config.NodeID, "\r\n") || len(config.NodeID) > 128 {
		return Config{}, fmt.Errorf("NODE_ID must be at most 128 bytes without line breaks")
	}
	if strings.ContainsAny(config.NodeName, "\r\n") || len(config.NodeName) > 256 {
		return Config{}, fmt.Errorf("NODE_NAME must be at most 256 bytes without line breaks")
	}
	return config, nil
}

func envDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func normalizedPort(value string) (string, error) {
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return "", fmt.Errorf("port must be an integer between 1 and 65535")
		}
	}
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return "", fmt.Errorf("port must be an integer between 1 and 65535")
	}
	return strconv.Itoa(port), nil
}

// normalizeOrigin accepts only a browser origin, never a URL with a path or
// credentials. Canonical default ports make comparisons match browser Origin.
func normalizeOrigin(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil {
		return "", fmt.Errorf("invalid HTTP origin")
	}
	scheme := strings.ToLower(u.Scheme)
	if (scheme != "http" && scheme != "https") || u.Host == "" || u.User != nil ||
		u.Opaque != "" || u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery ||
		u.Fragment != "" || u.RawFragment != "" || strings.ContainsAny(value, "\r\n\t #") {
		return "", fmt.Errorf("must be an http(s) origin without credentials, path, query or fragment")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || strings.Contains(host, "%") {
		return "", fmt.Errorf("invalid origin hostname")
	}
	if strings.HasPrefix(u.Host, "[") && !strings.Contains(host, ":") {
		return "", fmt.Errorf("bracketed origin hosts must be IPv6 addresses")
	}
	ip := net.ParseIP(host)
	if ip != nil {
		if strings.Contains(host, ":") {
			// Browser URLs keep IPv4-mapped addresses as bracketed IPv6 and
			// serialize their final groups in hex; net.IP.String uses IPv4.
			host = browserIPv6(ip)
		} else {
			host = ip.String()
		}
	} else {
		if len(host) > 253 {
			return "", fmt.Errorf("invalid origin hostname")
		}
		labels := strings.Split(strings.TrimSuffix(host, "."), ".")
		// Browser URL parsers treat a numeric final label as an IPv4
		// candidate, including abbreviated, hexadecimal and octal forms.
		// Require ordinary dotted decimal IPv4 rather than publishing an
		// origin that the browser will serialize to a different hostname.
		if numericIPLabel(labels[len(labels)-1]) {
			return "", fmt.Errorf("IPv4 origins must use standard dotted decimal addresses")
		}
		for _, label := range labels {
			if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return "", fmt.Errorf("invalid origin hostname")
			}
			for _, ch := range label {
				if (ch < 'a' || ch > 'z') && (ch < '0' || ch > '9') && ch != '-' {
					return "", fmt.Errorf("invalid origin hostname")
				}
			}
		}
	}
	port := u.Port()
	if port == "" && strings.HasSuffix(u.Host, ":") {
		return "", fmt.Errorf("invalid origin port")
	}
	if port != "" {
		port, err = normalizedPort(port)
		if err != nil {
			return "", err
		}
	}
	if scheme == "http" && port == "80" || scheme == "https" && port == "443" {
		port = ""
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return scheme + "://" + host, nil
}

func numericIPLabel(label string) bool {
	if label == "" {
		return false
	}
	hexadecimal := strings.HasPrefix(label, "0x")
	if hexadecimal {
		label = label[2:]
	}
	for _, ch := range label {
		if ch >= '0' && ch <= '9' || hexadecimal && ch >= 'a' && ch <= 'f' {
			continue
		}
		return false
	}
	return true
}

func browserIPv6(ip net.IP) string {
	address := ip.To16()
	groups := make([]string, 8)
	zeroStart, zeroLength := -1, 0
	for i := 0; i < len(groups); i++ {
		value := uint16(address[2*i])<<8 | uint16(address[2*i+1])
		groups[i] = strconv.FormatUint(uint64(value), 16)
	}
	for i := 0; i < len(groups); {
		if groups[i] != "0" {
			i++
			continue
		}
		end := i
		for end < len(groups) && groups[end] == "0" {
			end++
		}
		if end-i > zeroLength && end-i >= 2 {
			zeroStart, zeroLength = i, end-i
		}
		i = end
	}
	if zeroStart < 0 {
		return strings.Join(groups, ":")
	}
	return strings.Join(groups[:zeroStart], ":") + "::" + strings.Join(groups[zeroStart+zeroLength:], ":")
}

// origins does not trust proxy forwarding headers. Deployments with a proxy
// can set PUBLIC_ORIGIN and MEASUREMENT_ORIGINS to their external origins.
func (config Config) origins(r *http.Request) (string, []string, error) {
	mainOrigin := config.PublicOrigin
	if mainOrigin == "" {
		if r == nil {
			return "", nil, fmt.Errorf("request is required to determine website origin")
		}
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		var err error
		mainOrigin, err = normalizeOrigin(scheme + "://" + r.Host)
		if err != nil {
			return "", nil, fmt.Errorf("invalid request Host: %w", err)
		}
		requestOrigin, _ := url.Parse(mainOrigin)
		requestPort := requestOrigin.Port()
		if requestPort == "" {
			if scheme == "https" {
				requestPort = "443"
			} else {
				requestPort = "80"
			}
		}
		for _, port := range config.MeasurementPorts {
			if requestPort == port {
				_, mainPort, err := net.SplitHostPort(config.Addr)
				if err != nil {
					return "", nil, fmt.Errorf("invalid main listen address: %w", err)
				}
				mainOrigin, err = normalizeOrigin(scheme + "://" + net.JoinHostPort(requestOrigin.Hostname(), mainPort))
				if err != nil {
					return "", nil, err
				}
				break
			}
		}
	}
	mainOrigin, err := normalizeOrigin(mainOrigin)
	if err != nil {
		return "", nil, err
	}
	if len(config.MeasurementOrigins) > 0 {
		origins := make([]string, 0, len(config.MeasurementOrigins))
		for _, value := range config.MeasurementOrigins {
			origin, err := normalizeOrigin(value)
			if err != nil {
				return "", nil, err
			}
			origins = append(origins, origin)
		}
		return mainOrigin, origins, nil
	}
	originURL, _ := url.Parse(mainOrigin)
	origins := make([]string, 0, max(1, len(config.MeasurementPorts)))
	for _, port := range config.MeasurementPorts {
		origin, err := normalizeOrigin(originURL.Scheme + "://" + net.JoinHostPort(originURL.Hostname(), port))
		if err != nil {
			return "", nil, err
		}
		origins = append(origins, origin)
	}
	if len(origins) == 0 {
		origins = append(origins, mainOrigin)
	}
	return mainOrigin, origins, nil
}

type nodeInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	BaseURL string `json:"baseUrl"`
}

type testSettings struct {
	DownloadDurationMS  int `json:"downloadDurationMs"`
	UploadDurationMS    int `json:"uploadDurationMs"`
	WarmupMS            int `json:"warmupMs"`
	MinStreams          int `json:"minStreams"`
	MaxStreams          int `json:"maxStreams"`
	PingSamples         int `json:"pingSamples"`
	DownloadChunkBytes  int `json:"downloadChunkBytes"`
	UploadChunkBytes    int `json:"uploadChunkBytes"`
	MaxUploadChunkBytes int `json:"maxUploadChunkBytes"`
}

type features struct {
	Download      bool `json:"download"`
	Upload        bool `json:"upload"`
	Latency       bool `json:"latency"`
	LoadedLatency bool `json:"loadedLatency"`
}

type performanceSettings struct {
	Transport          string   `json:"transport"`
	DefaultStreams     int      `json:"defaultStreams"`
	MeasurementOrigins []string `json:"measurementOrigins"`
	MaxStreams         int      `json:"maxStreams"`
	DefaultMode        string   `json:"defaultMode"`
	DownloadBlockBytes int      `json:"downloadBlockBytes"`
	UploadBlockBytes   int      `json:"uploadBlockBytes"`
	MaxUploadBodyBytes int64    `json:"maxUploadBodyBytes"`
}

type clientConfig struct {
	ProtocolVersion int                 `json:"protocolVersion"`
	Nodes           []nodeInfo          `json:"nodes"`
	Test            testSettings        `json:"test"`
	Performance     performanceSettings `json:"performance"`
	Features        features            `json:"features"`
}

func (config Config) clientConfig(r *http.Request) (clientConfig, error) {
	mainOrigin, origins, err := config.origins(r)
	if err != nil {
		return clientConfig{}, err
	}
	maxStreams := config.MaxTestStreams
	if maxStreams == 0 {
		maxStreams = 30
	}
	maxStreams = min(maxStreams, 30)
	transport := config.TestTransport
	if transport == "" {
		transport = "websocket"
	}
	if transport == "http" {
		// Reserve control connections on the website origin; dedicated origins
		// can use all six slots in the browser's HTTP/1.1 connection pool.
		capacity := 0
		for _, origin := range origins {
			if origin == mainOrigin {
				capacity += 4
			} else {
				capacity += 6
			}
		}
		maxStreams = min(maxStreams, capacity)
	}
	defaultStreams := min(8, maxStreams)
	return clientConfig{
		ProtocolVersion: 2,
		Nodes: []nodeInfo{{
			ID: config.NodeID, Name: config.NodeName, BaseURL: "",
		}},
		Test: testSettings{
			DownloadDurationMS: config.DownloadDurationMS, UploadDurationMS: config.UploadDurationMS,
			WarmupMS: config.WarmupMS, MinStreams: defaultStreams, MaxStreams: maxStreams, PingSamples: 8,
			DownloadChunkBytes: defaultDownloadBytes, UploadChunkBytes: 1 << 20,
			MaxUploadChunkBytes: 8 << 20,
		},
		Performance: performanceSettings{
			MeasurementOrigins: origins, MaxStreams: maxStreams, DefaultMode: "manual", Transport: transport, DefaultStreams: defaultStreams,
			DownloadBlockBytes: 25 << 20, UploadBlockBytes: 25 << 20, MaxUploadBodyBytes: 1 << 30,
		},
		Features: features{Download: true, Upload: true, Latency: true, LoadedLatency: true},
	}, nil
}
