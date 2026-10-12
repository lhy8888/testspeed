package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

const geoIPProvider = "https://free.freeipapi.com/api/json"

type networkLocation struct {
	Country     string `json:"country"`
	CountryCode string `json:"countryCode"`
	Region      string `json:"region"`
	City        string `json:"city"`
	Label       string `json:"label"`
	Source      string `json:"source"`
	Status      string `json:"status"`
	Approximate bool   `json:"approximate"`
}

type networkParty struct {
	IP            string          `json:"ip"`
	Scope         string          `json:"scope"`
	Name          string          `json:"name,omitempty"`
	Proxied       bool            `json:"proxied,omitempty"`
	ISP           string          `json:"isp,omitempty"`
	ASN           string          `json:"asn,omitempty"`
	NetworkSource string          `json:"networkSource,omitempty"`
	Location      networkLocation `json:"location"`
}

type networkInfo struct {
	Client networkParty `json:"client"`
	Server networkParty `json:"server"`
}

type geoResult struct {
	IP            string
	Location      networkLocation
	ISP           string
	ASN           string
	NetworkSource string
}
type geoCacheEntry struct {
	result   geoResult
	expires  time.Time
	accessed time.Time
}
type geoPending struct {
	done   chan struct{}
	result geoResult
}
type networkService struct {
	client        *http.Client
	enabled       bool
	provider      string
	offline       *offlineGeoDB
	mu            sync.Mutex
	cache         map[string]geoCacheEntry
	pending       map[string]*geoPending
	requests      chan struct{}
	tokens        float64
	lastRefill    time.Time
	cooldownUntil time.Time
}

func newNetworkService() *networkService {
	return &networkService{
		provider: "auto", enabled: true,
		client: &http.Client{Timeout: 1500 * time.Millisecond, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		cache:  make(map[string]geoCacheEntry), pending: make(map[string]*geoPending), requests: make(chan struct{}, 4),
		tokens: 4, lastRefill: time.Now(),
	}
}

func unavailableGeo() geoResult {
	return geoResult{Location: networkLocation{Source: "unavailable", Status: "unavailable"}}
}

func (service *networkService) lookup(ctx context.Context, ip string) geoResult {
	if !service.enabled || ctx.Err() != nil {
		return unavailableGeo()
	}
	// Only canonical public addresses can become lookup targets. The empty
	// address is reserved for an online observation of this server's egress IP.
	if ip != "" {
		address, err := netip.ParseAddr(ip)
		if err != nil || address.Zone() != "" || addressScope(address.Unmap()) != "public" {
			return unavailableGeo()
		}
		ip = address.Unmap().String()
	}
	if service.provider == "offline" {
		return service.lookupOffline(ip)
	}
	service.mu.Lock()
	now := time.Now()
	if entry, ok := service.cache[ip]; ok && now.Before(entry.expires) {
		entry.accessed = now
		service.cache[ip] = entry
		service.mu.Unlock()
		return entry.result
	}
	if pending := service.pending[ip]; pending != nil {
		service.mu.Unlock()
		select {
		case <-pending.done:
			return pending.result
		case <-ctx.Done():
			return unavailableGeo()
		}
	}
	select {
	case service.requests <- struct{}{}:
	default:
		service.mu.Unlock()
		return service.offlineFallback(ip, unavailableGeo())
	}
	// Forty new requests per minute plus a burst of four stays below the free
	// provider's shared sixty-per-minute limit. Cache hits consume no tokens.
	service.tokens = min(4, service.tokens+now.Sub(service.lastRefill).Seconds()/1.5)
	service.lastRefill = now
	if now.Before(service.cooldownUntil) || service.tokens < 1 {
		<-service.requests
		service.mu.Unlock()
		return service.offlineFallback(ip, unavailableGeo())
	}
	service.tokens--
	pending := &geoPending{done: make(chan struct{})}
	service.pending[ip] = pending
	service.mu.Unlock()
	result := service.offlineFallback(ip, service.fetch(ctx, ip))
	service.mu.Lock()
	ttl := time.Minute
	if result.Location.Status == "resolved" || result.ISP != "" || result.ASN != "" {
		ttl = time.Hour
	}
	if len(service.cache) >= 256 {
		oldest := ""
		oldestTime := time.Now()
		for key, entry := range service.cache {
			if !entry.accessed.After(oldestTime) {
				oldest, oldestTime = key, entry.accessed
			}
		}
		delete(service.cache, oldest)
	}
	service.cache[ip] = geoCacheEntry{result: result, expires: time.Now().Add(ttl), accessed: time.Now()}
	pending.result = result
	delete(service.pending, ip)
	close(pending.done)
	service.mu.Unlock()
	<-service.requests
	return result
}

func cleanLocationText(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 128 || strings.ContainsAny(value, "\r\n\x00") {
		return ""
	}
	return value
}

func cleanCountryCode(value string) string {
	code := strings.ToUpper(strings.TrimSpace(value))
	if len(code) == 2 && code[0] >= 'A' && code[0] <= 'Z' && code[1] >= 'A' && code[1] <= 'Z' {
		return code
	}
	return ""
}

func cleanASN(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(strings.ToUpper(value), "AS")
	if len(value) == 0 || len(value) > 10 {
		return ""
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return ""
		}
	}
	number, err := strconv.ParseUint(value, 10, 32)
	if err != nil || number == 0 {
		return ""
	}
	return "AS" + strconv.FormatUint(number, 10)
}

func (service *networkService) fetch(ctx context.Context, ip string) geoResult {
	// The endpoint is fixed HTTPS. No client-supplied Host, forwarded hostname,
	// provider URL or redirect can turn location lookup into an arbitrary fetch.
	endpoint := geoIPProvider
	if ip != "" {
		endpoint += "/" + ip
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return unavailableGeo()
	}
	response, err := service.client.Do(request)
	if err != nil {
		return unavailableGeo()
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests {
		cooldown := time.Minute
		if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil && seconds > 0 {
			cooldown = max(cooldown, time.Duration(min(seconds, 3600))*time.Second)
		} else if until, err := http.ParseTime(response.Header.Get("Retry-After")); err == nil {
			cooldown = max(cooldown, min(time.Hour, time.Until(until)))
		}
		service.mu.Lock()
		service.cooldownUntil = maxTime(service.cooldownUntil, time.Now().Add(cooldown))
		service.mu.Unlock()
		return unavailableGeo()
	}
	if response.StatusCode != http.StatusOK {
		return unavailableGeo()
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(body) > 65536 {
		return unavailableGeo()
	}
	type providerResult struct {
		IP           string `json:"ipAddress"`
		Country      string `json:"countryName"`
		CountryCode  string `json:"countryCode"`
		Region       string `json:"regionName"`
		City         string `json:"cityName"`
		ASN          string `json:"asn"`
		Organization string `json:"asnOrganization"`
	}
	var output providerResult
	body = []byte(strings.TrimSpace(string(body)))
	if len(body) > 0 && body[0] == '[' {
		var outputs []providerResult
		if json.Unmarshal(body, &outputs) != nil || len(outputs) != 1 {
			return unavailableGeo()
		}
		output = outputs[0]
	} else if json.Unmarshal(body, &output) != nil {
		return unavailableGeo()
	}
	if output.IP == "" {
		return unavailableGeo()
	}
	address, err := netip.ParseAddr(output.IP)
	if err != nil || address.Zone() != "" || addressScope(address.Unmap()) != "public" || ip != "" && address.Unmap().String() != ip {
		return unavailableGeo()
	}
	location := networkLocation{Country: cleanLocationText(output.Country), Region: cleanLocationText(output.Region), City: cleanLocationText(output.City), Source: "geoip", Status: "resolved", Approximate: true}
	location.CountryCode = cleanCountryCode(output.CountryCode)
	isp, asn := cleanLocationText(output.Organization), cleanASN(output.ASN)
	if location.Country == "" && location.Region == "" && location.City == "" && location.CountryCode == "" {
		location = unavailableGeo().Location
	}
	if location.Status != "resolved" && isp == "" && asn == "" {
		// A valid, matching IP is still an observation: auto mode can use it
		// for a local database fallback, including this server's egress address.
		return geoResult{IP: address.Unmap().String(), Location: unavailableGeo().Location}
	}
	result := geoResult{IP: address.Unmap().String(), Location: location, ISP: isp, ASN: asn}
	if isp != "" || asn != "" {
		result.NetworkSource = "geoip"
	}
	return result
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("fec0::/10"), netip.MustParsePrefix("3fff::/20"), netip.MustParsePrefix("100::/64"), netip.MustParsePrefix("2001:2::/48"), netip.MustParsePrefix("2001:10::/28"), netip.MustParsePrefix("2001:20::/28"),
}

func addressScope(address netip.Addr) string {
	if !address.IsValid() {
		return "unknown"
	}
	address = address.Unmap()
	if address.IsLoopback() {
		return "loopback"
	}
	if address.IsPrivate() || netip.MustParsePrefix("100.64.0.0/10").Contains(address) {
		return "private"
	}
	if address.IsLinkLocalUnicast() {
		return "link-local"
	}
	if !address.IsGlobalUnicast() {
		return "reserved"
	}
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(address) {
			return "reserved"
		}
	}
	return "public"
}

func parseNetworkAddress(value string) (netip.Addr, bool) {
	value = strings.TrimSpace(value)
	if strings.ContainsAny(value, "\r\n\t") {
		return netip.Addr{}, false
	}
	if address, err := netip.ParseAddr(value); err == nil {
		return address.WithZone("").Unmap(), true
	}
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		value = value[1 : len(value)-1]
		address, err := netip.ParseAddr(value)
		if err == nil {
			return address.WithZone("").Unmap(), true
		}
		return netip.Addr{}, false
	}
	host, port, err := net.SplitHostPort(value)
	if err != nil {
		return netip.Addr{}, false
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return netip.Addr{}, false
	}
	for _, digit := range port {
		if digit < '0' || digit > '9' {
			return netip.Addr{}, false
		}
	}
	address, err := netip.ParseAddr(host)
	return address.WithZone("").Unmap(), err == nil
}

func splitForwarded(value string, separator byte) ([]string, bool) {
	var parts []string
	quoted, escaped, start := false, false, 0
	for index := 0; index < len(value); index++ {
		if escaped {
			escaped = false
			continue
		}
		if value[index] == '\\' && quoted {
			escaped = true
			continue
		}
		if value[index] == '"' {
			quoted = !quoted
			continue
		}
		if value[index] == separator && !quoted {
			parts = append(parts, value[start:index])
			start = index + 1
		}
	}
	if quoted || escaped {
		return nil, false
	}
	return append(parts, value[start:]), true
}

func forwardedChain(value string) ([]netip.Addr, bool) {
	entries, ok := splitForwarded(value, ',')
	if !ok || len(entries) > 32 || len(value) > 8192 {
		return nil, false
	}
	chain := make([]netip.Addr, 0, len(entries))
	for _, entry := range entries {
		params, ok := splitForwarded(entry, ';')
		if !ok {
			return nil, false
		}
		found := false
		for _, param := range params {
			name, value, ok := strings.Cut(strings.TrimSpace(param), "=")
			if !ok {
				return nil, false
			}
			if !strings.EqualFold(name, "for") {
				continue
			}
			if found {
				return nil, false
			}
			found = true
			value = strings.TrimSpace(value)
			if strings.HasPrefix(value, "\"") {
				unquoted, err := strconv.Unquote(value)
				if err != nil {
					return nil, false
				}
				value = unquoted
			}
			if strings.Contains(value, "%") {
				return nil, false
			}
			address, ok := parseNetworkAddress(value)
			if !ok {
				return nil, false
			}
			chain = append(chain, address)
		}
		if !found {
			return nil, false
		}
	}
	return chain, len(chain) > 0
}

func xForwardedChain(value string) ([]netip.Addr, bool) {
	entries := strings.Split(value, ",")
	if len(entries) > 32 || len(value) > 8192 {
		return nil, false
	}
	chain := make([]netip.Addr, 0, len(entries))
	for _, value := range entries {
		if strings.Contains(value, "%") {
			return nil, false
		}
		address, ok := parseNetworkAddress(value)
		if !ok {
			return nil, false
		}
		chain = append(chain, address)
	}
	return chain, len(chain) > 0
}

func (config Config) trustedProxy(address netip.Addr) bool {
	for _, prefix := range config.TrustedProxies {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func (config Config) clientAddress(r *http.Request) (netip.Addr, bool) {
	peer, ok := parseNetworkAddress(r.RemoteAddr)
	if !ok || !config.trustedProxy(peer) {
		return peer, false
	}
	resolve := func(chain []netip.Addr) netip.Addr {
		address := peer
		for index := len(chain) - 1; index >= 0 && config.trustedProxy(address); index-- {
			address = chain[index]
		}
		return address
	}
	var selected netip.Addr
	present := false
	for _, header := range []string{"Forwarded", "X-Forwarded-For"} {
		values := r.Header.Values(header)
		if len(values) == 0 {
			continue
		}
		value := strings.Join(values, ",")
		var chain []netip.Addr
		var valid bool
		if header == "Forwarded" {
			chain, valid = forwardedChain(value)
		} else {
			chain, valid = xForwardedChain(value)
		}
		if !valid {
			return peer, false
		}
		candidate := resolve(chain)
		if present && selected != candidate {
			return peer, false
		}
		selected, present = candidate, true
	}
	if !present {
		return peer, false
	}
	return selected, true
}

func (server *speedServer) networkInfo(w http.ResponseWriter, r *http.Request) {
	address, proxied := server.config.clientAddress(r)
	clientIP := ""
	if address.IsValid() {
		clientIP = address.String()
	}
	info := networkInfo{Client: networkParty{IP: clientIP, Scope: addressScope(address), Proxied: proxied}, Server: networkParty{Name: server.config.NodeName, Scope: "unknown"}}
	var tasks sync.WaitGroup
	if info.Client.Scope != "public" {
		info.Client.Location = networkLocation{Source: "network", Status: "internal"}
		if server.config.ClientNetworkLabel != "" && info.Client.Scope != "unknown" {
			info.Client.Location = networkLocation{Label: server.config.ClientNetworkLabel, Source: "configured", Status: "resolved"}
		}
		if info.Client.Scope == "unknown" {
			info.Client.Location = unavailableGeo().Location
		}
	} else if !server.config.GeoIPEnabled {
		info.Client.Location = networkLocation{Source: "disabled", Status: "disabled"}
	} else {
		tasks.Add(1)
		go func() {
			defer tasks.Done()
			result := server.network.lookup(r.Context(), clientIP)
			info.Client.Location, info.Client.ISP, info.Client.ASN, info.Client.NetworkSource = result.Location, result.ISP, result.ASN, result.NetworkSource
		}()
	}
	if server.config.ServerLocation != "" {
		info.Server.Location = networkLocation{Label: server.config.ServerLocation, Source: "configured", Status: "resolved"}
	} else if !server.config.GeoIPEnabled {
		info.Server.Location = networkLocation{Source: "disabled", Status: "disabled"}
	} else {
		tasks.Add(1)
		go func() {
			defer tasks.Done()
			result := server.network.lookup(r.Context(), "")
			info.Server.IP = result.IP
			info.Server.Location = result.Location
			info.Server.ISP, info.Server.ASN, info.Server.NetworkSource = result.ISP, result.ASN, result.NetworkSource
			if result.IP != "" {
				address, _ := netip.ParseAddr(result.IP)
				info.Server.Scope = addressScope(address)
			}
		}()
	}
	tasks.Wait()
	writeJSON(w, http.StatusOK, info)
}
