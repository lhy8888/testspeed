package main

import (
	"fmt"
	"net/netip"
	"strconv"
	"strings"
	"sync"

	"github.com/oschwald/maxminddb-golang/v2"
)

// A single reader is shared for the life of the node. Locking also makes Close
// safe while a bounded network-info request is finishing during shutdown.
type offlineGeoDB struct {
	mu     sync.RWMutex
	reader *maxminddb.Reader
}

func newConfiguredNetworkService(config Config) (*networkService, error) {
	service := newNetworkService()
	service.provider = config.GeoIPProvider
	if service.provider == "" {
		service.provider = "auto"
	}
	if service.provider != "auto" && service.provider != "online" && service.provider != "offline" {
		return nil, fmt.Errorf("GEOIP_PROVIDER must be auto, online or offline")
	}
	if !config.GeoIPEnabled {
		service.enabled = false
		return service, nil
	}
	if config.GeoIPDBPath == "" {
		if service.provider == "offline" {
			return nil, fmt.Errorf("GEOIP_DB_PATH is required when GEOIP_PROVIDER is offline")
		}
		return service, nil
	}
	reader, err := maxminddb.Open(config.GeoIPDBPath)
	if err != nil {
		return nil, fmt.Errorf("open GEOIP_DB_PATH: %w", err)
	}
	// The format alone cannot identify the schema: an anonymous-IP or arbitrary
	// MMDB must not be advertised as a country/ASN database.
	databaseType := strings.ToLower(reader.Metadata.DatabaseType)
	supported := strings.HasPrefix(databaseType, "ipinfo ") || databaseType == "country_asn"
	for _, name := range []string{"geoip2-city", "geolite2-city", "geoip2-country", "geolite2-country", "geolite2-asn", "geoip2-isp", "geoip2-enterprise"} {
		supported = supported || databaseType == name
	}
	if !supported {
		_ = reader.Close()
		return nil, fmt.Errorf("GEOIP_DB_PATH has unsupported database type %q; use an IPinfo country/ASN or MaxMind City/Country/ASN/ISP database", reader.Metadata.DatabaseType)
	}
	service.offline = &offlineGeoDB{reader: reader}
	return service, nil
}

func (service *networkService) Close() error {
	service.client.CloseIdleConnections()
	if service.offline == nil {
		return nil
	}
	service.offline.mu.Lock()
	defer service.offline.mu.Unlock()
	if service.offline.reader == nil {
		return nil
	}
	err := service.offline.reader.Close()
	service.offline.reader = nil
	return err
}

func recordText(value any) string {
	text, _ := value.(string)
	return cleanLocationText(text)
}

func recordMap(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func recordEnglish(value any) string {
	return recordText(recordMap(recordMap(value)["names"])["en"])
}

func recordASN(value any) string {
	switch value := value.(type) {
	case string:
		return cleanASN(value)
	case uint64:
		return cleanASN(strconv.FormatUint(value, 10))
	case uint32:
		return cleanASN(strconv.FormatUint(uint64(value), 10))
	case uint:
		return cleanASN(strconv.FormatUint(uint64(value), 10))
	default:
		return ""
	}
}

func (service *networkService) lookupOffline(ip string) geoResult {
	if service.offline == nil || ip == "" {
		return unavailableGeo()
	}
	address, err := netip.ParseAddr(ip)
	if err != nil || address.Zone() != "" || addressScope(address.Unmap()) != "public" {
		return unavailableGeo()
	}
	service.offline.mu.RLock()
	defer service.offline.mu.RUnlock()
	if service.offline.reader == nil {
		return unavailableGeo()
	}
	lookup := service.offline.reader.Lookup(address.Unmap())
	if !lookup.Found() {
		return unavailableGeo()
	}
	var record map[string]any
	if lookup.Decode(&record) != nil {
		return unavailableGeo()
	}
	return offlineRecord(address.Unmap().String(), record)
}

// Support both MaxMind's nested City/Country/ASN/ISP records and IPinfo's flat
// country_asn/Lite records. An ASN-only database supplies network ownership,
// never an invented country, region or city.
func offlineRecord(ip string, record map[string]any) geoResult {
	location := networkLocation{Source: "mmdb", Status: "resolved", Approximate: true}
	if country := recordMap(record["country"]); country != nil {
		location.Country = recordEnglish(country)
		location.CountryCode = cleanCountryCode(recordText(country["iso_code"]))
		location.City = recordEnglish(record["city"])
		if subdivisions, ok := record["subdivisions"].([]any); ok && len(subdivisions) > 0 {
			location.Region = recordEnglish(subdivisions[0])
		}
	} else {
		location.CountryCode = cleanCountryCode(recordText(record["country_code"]))
		location.Country = recordText(record["country_name"])
		country := recordText(record["country"])
		if location.CountryCode == "" && cleanCountryCode(country) != "" {
			location.CountryCode = cleanCountryCode(country)
		} else if location.Country == "" {
			location.Country = country
		}
		location.Region = recordText(record["region"])
		location.City = recordText(record["city"])
	}
	isp := ""
	for _, key := range []string{"isp", "autonomous_system_organization", "as_name"} {
		if isp = recordText(record[key]); isp != "" {
			break
		}
	}
	asn := recordASN(record["autonomous_system_number"])
	if asn == "" {
		asn = recordASN(record["asn"])
	}
	if location.Country == "" && location.CountryCode == "" && location.Region == "" && location.City == "" {
		location = unavailableGeo().Location
	}
	if location.Status != "resolved" && isp == "" && asn == "" {
		return unavailableGeo()
	}
	result := geoResult{IP: ip, Location: location, ISP: isp, ASN: asn}
	if isp != "" || asn != "" {
		result.NetworkSource = "mmdb"
	}
	return result
}

func (service *networkService) offlineFallback(ip string, result geoResult) geoResult {
	if service.provider != "auto" || service.offline == nil {
		return result
	}
	if ip == "" {
		// A database cannot reveal our public address. Enrich the server only if
		// the online provider has actually observed its egress IP.
		ip = result.IP
	}
	if result.Location.Status == "resolved" && result.ISP != "" && result.ASN != "" {
		return result
	}
	offline := service.lookupOffline(ip)
	if result.IP == "" {
		result.IP = offline.IP
	}
	if result.Location.Status != "resolved" && offline.Location.Status == "resolved" {
		result.Location = offline.Location
	}
	enriched := false
	if result.ISP == "" && offline.ISP != "" {
		result.ISP, enriched = offline.ISP, true
	}
	if result.ASN == "" && offline.ASN != "" {
		result.ASN, enriched = offline.ASN, true
	}
	if enriched {
		if result.NetworkSource != "" && result.NetworkSource != "mmdb" {
			result.NetworkSource = "mixed"
		} else {
			result.NetworkSource = "mmdb"
		}
	}
	return result
}
