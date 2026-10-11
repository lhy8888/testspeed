package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"sort"
	"sync"
	"time"
)

type connectionContextKey struct{}

// The identifier belongs to an accepted server-side TCP connection. Behind a
// reverse proxy this identifies its upstream connection, not the browser's TCP.
func attachConnectionContext(ctx context.Context, _ net.Conn) context.Context {
	var id [16]byte
	_, _ = rand.Read(id[:])
	return context.WithValue(ctx, connectionContextKey{}, hex.EncodeToString(id[:]))
}

func connectionID(r *http.Request) string {
	id, _ := r.Context().Value(connectionContextKey{}).(string)
	return id
}

type connectionSnapshot struct {
	ActiveRequests       int      `json:"activeRequests"`
	ActiveTCPConnections int      `json:"activeTcpConnections"`
	PeakTCPConnections   int      `json:"peakTcpConnections"`
	ConnectionsObserved  int      `json:"connectionsObserved"`
	Protocols            []string `json:"protocols"`
	Scope                string   `json:"scope"`
}

type connectionStats struct {
	mu       sync.Mutex
	active   int
	peak     int
	refs     map[string]int
	observed map[string]struct{}
	protocol map[string]struct{}
}

func newConnectionStats() *connectionStats {
	return &connectionStats{
		refs: make(map[string]int), observed: make(map[string]struct{}),
		protocol: make(map[string]struct{}),
	}
}

func (stats *connectionStats) enter(r *http.Request) func() {
	id := connectionID(r)
	stats.mu.Lock()
	stats.active++
	stats.protocol[r.Proto] = struct{}{}
	if id != "" {
		stats.refs[id]++
		stats.observed[id] = struct{}{}
		stats.peak = max(stats.peak, len(stats.refs))
	}
	stats.mu.Unlock()
	return func() {
		stats.mu.Lock()
		defer stats.mu.Unlock()
		stats.active--
		if id != "" {
			stats.refs[id]--
			if stats.refs[id] == 0 {
				delete(stats.refs, id)
			}
		}
	}
}

func (stats *connectionStats) snapshot() connectionSnapshot {
	stats.mu.Lock()
	defer stats.mu.Unlock()
	protocols := make([]string, 0, len(stats.protocol))
	for protocol := range stats.protocol {
		protocols = append(protocols, protocol)
	}
	sort.Strings(protocols)
	return connectionSnapshot{
		ActiveRequests: stats.active, ActiveTCPConnections: len(stats.refs),
		PeakTCPConnections: stats.peak, ConnectionsObserved: len(stats.observed),
		Protocols: protocols, Scope: "server",
	}
}

type downloadRun struct {
	created time.Time
	stats   *connectionStats
}

type downloadRuns struct {
	mu      sync.Mutex
	entries map[string]*downloadRun
}

func (runs *downloadRuns) get(id string, create bool, now time.Time) *connectionStats {
	runs.mu.Lock()
	defer runs.mu.Unlock()
	for id, run := range runs.entries {
		if now.Sub(run.created) >= sessionTTL {
			delete(runs.entries, id)
		}
	}
	if entry := runs.entries[id]; entry != nil {
		return entry.stats
	}
	if !create || len(runs.entries) >= 512 {
		return nil
	}
	stats := newConnectionStats()
	runs.entries[id] = &downloadRun{created: now, stats: stats}
	return stats
}

func validRunID(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for _, character := range id {
		if character != '-' && character != '_' && !(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z') && !(character >= '0' && character <= '9') {
			return false
		}
	}
	return true
}
