// throughput measures the local node's HTTP payload capacity. Loopback results
// do not establish NIC capacity or what a JavaScript browser can achieve.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type result struct {
	Streams     int     `json:"streams"`
	Bytes       uint64  `json:"measuredBytes"`
	Seconds     float64 `json:"seconds"`
	Gbps        float64 `json:"gbps"`
	Connections int     `json:"observedConnections"`
	Errors      int64   `json:"errors"`
	Transport   string  `json:"transport"`
	Scope       string  `json:"scope"`
}

func measure(base *url.URL, streams int, duration time.Duration) result {
	warmup := 500 * time.Millisecond
	start := time.Now().Add(warmup)
	end := start.Add(duration)
	ctx, cancel := context.WithDeadline(context.Background(), end)
	defer cancel()
	transport := &http.Transport{
		DisableCompression: true, ForceAttemptHTTP2: false,
		MaxConnsPerHost: streams, MaxIdleConns: streams,
		MaxIdleConnsPerHost: streams, ResponseHeaderTimeout: 5 * time.Second,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	var bytes atomic.Uint64
	var failures atomic.Int64
	var group sync.WaitGroup
	var mutex sync.Mutex
	connections := map[string]struct{}{}
	protocol := ""
	for stream := 0; stream < streams; stream++ {
		group.Add(1)
		go func() {
			defer group.Done()
			endpoint := *base
			endpoint.Path = strings.TrimSuffix(base.Path, "/") + "/api/download"
			query := endpoint.Query()
			query.Set("stream", "1")
			query.Set("run", fmt.Sprintf("benchmark-%d", start.UnixNano()))
			endpoint.RawQuery = query.Encode()
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
			if err != nil {
				failures.Add(1)
				return
			}
			response, err := client.Do(request)
			if err != nil {
				if ctx.Err() == nil {
					failures.Add(1)
				}
				return
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK || response.ContentLength >= 0 {
				failures.Add(1)
				return
			}
			mutex.Lock()
			if id := response.Header.Get("X-Test-Connection-ID"); id != "" {
				connections[id] = struct{}{}
			}
			protocol = response.Proto
			mutex.Unlock()
			buffer := make([]byte, 256<<10)
			for {
				n, readErr := response.Body.Read(buffer)
				observed := time.Now()
				if n > 0 && !observed.Before(start) && !observed.After(end) {
					bytes.Add(uint64(n))
				}
				if readErr != nil {
					if ctx.Err() == nil && (readErr == io.EOF || observed.Before(end)) {
						failures.Add(1)
					}
					return
				}
			}
		}()
	}
	group.Wait()
	measured := bytes.Load()
	return result{
		Streams: streams, Bytes: measured, Seconds: duration.Seconds(),
		Gbps:        float64(measured) * 8 / duration.Seconds() / 1e9,
		Connections: len(connections), Errors: failures.Load(), Transport: protocol,
		Scope: "HTTP payload throughput on the selected path; loopback is not NIC/browser capacity",
	}
}

func main() {
	address := flag.String("url", "http://127.0.0.1:8080", "URL of a node you are authorized to test")
	counts := flag.String("streams", "1,4,12,24", "comma-separated concurrent HTTP/1.1 streams")
	duration := flag.Duration("duration", 3*time.Second, "measured duration, excluding 500ms warmup")
	flag.Parse()
	base, err := url.Parse(*address)
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || *duration < time.Second || *duration > 30*time.Second {
		fmt.Fprintln(os.Stderr, "use a valid HTTP/HTTPS URL and duration between 1s and 30s")
		os.Exit(2)
	}
	failed := false
	for _, count := range strings.Split(*counts, ",") {
		streams, err := strconv.Atoi(strings.TrimSpace(count))
		if err != nil || streams < 1 || streams > 128 {
			fmt.Fprintln(os.Stderr, "streams must be integers between 1 and 128")
			os.Exit(2)
		}
		outcome := measure(base, streams, *duration)
		if err := json.NewEncoder(os.Stdout).Encode(outcome); err != nil {
			panic(err)
		}
		if outcome.Errors > 0 || outcome.Bytes == 0 {
			failed = true
		}
	}
	if failed {
		os.Exit(1)
	}
}
