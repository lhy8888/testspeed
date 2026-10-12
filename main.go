package main

import (
	"context"
	"crypto/tls"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

//go:embed web
var embeddedWeb embed.FS

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--version" || os.Args[1] == "-version") {
		printVersion(os.Stdout)
		return
	}
	if err := run(); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	config, err := loadConfig()
	if err != nil {
		return err
	}
	web, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		return err
	}
	handler, err := newSpeedServer(config, web)
	if err != nil {
		return err
	}
	servers, listeners, err := bindServers(config, handler)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	defer func() {
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}()
	serverError := make(chan error, len(servers))
	for i, server := range servers {
		listener := listeners[i]
		go func() {
			slog.Info("speed node listening", "address", listener.Addr().String(), "node_id", config.NodeID,
				"measurement_only", server != servers[0], "max_concurrent_test_requests", config.MaxConcurrentRequests)
			var err error
			if config.TLSCertFile != "" {
				err = server.ServeTLS(listener, "", "")
			} else {
				err = server.Serve(listener)
			}
			serverError <- err
		}()
	}
	var serveError error
	select {
	case err := <-serverError:
		if !errors.Is(err, http.ErrServerClosed) {
			serveError = err
		}
	case <-ctx.Done():
	}
	slog.Info("shutting down speed node")
	// net/http Shutdown does not close hijacked WebSocket connections.
	handler.closeWebSockets()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdownServers(shutdownCtx, servers)
	return serveError
}

// Bind every port before accepting traffic so a failed data port cannot leave
// a partially running node. All listeners use the same certificates and node.
func bindServers(config Config, handler *speedServer) ([]*http.Server, []net.Listener, error) {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS13}
	if config.TLSCertFile != "" {
		certificate, err := tls.LoadX509KeyPair(config.TLSCertFile, config.TLSKeyFile)
		if err != nil {
			return nil, nil, fmt.Errorf("load HTTPS certificate: %w", err)
		}
		tlsConfig.Certificates = []tls.Certificate{certificate}
	}
	host, _, err := net.SplitHostPort(config.Addr)
	if err != nil {
		return nil, nil, err
	}
	addresses := []string{config.Addr}
	for _, port := range config.MeasurementPorts {
		addresses = append(addresses, net.JoinHostPort(host, port))
	}
	servers := make([]*http.Server, 0, len(addresses))
	listeners := make([]net.Listener, 0, len(addresses))
	for i, address := range addresses {
		listener, err := net.Listen("tcp", address)
		if err != nil {
			for _, bound := range listeners {
				_ = bound.Close()
			}
			return nil, nil, fmt.Errorf("listen on %s: %w", address, err)
		}
		protocols := &http.Protocols{}
		protocols.SetHTTP1(true)
		protocols.SetHTTP2(i == 0)
		var routeHandler http.Handler = handler
		listenerTLS := tlsConfig.Clone()
		if i != 0 {
			routeHandler = http.HandlerFunc(handler.serveMeasurementHTTP)
			// Separate origins and HTTP/1 prevent HTTP/2 connection coalescing
			// from merging the intended independent TCP measurement pools.
			listenerTLS.NextProtos = []string{"http/1.1"}
		}
		server := &http.Server{
			Addr: address, Handler: routeHandler,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       90 * time.Second,
			WriteTimeout:      90 * time.Second,
			IdleTimeout:       60 * time.Second,
			MaxHeaderBytes:    16 << 10,
			TLSConfig:         listenerTLS,
			Protocols:         protocols,
			ConnContext:       attachConnectionContext,
		}
		servers = append(servers, server)
		listeners = append(listeners, listener)
	}
	return servers, listeners, nil
}

func shutdownServers(ctx context.Context, servers []*http.Server) {
	var group sync.WaitGroup
	for _, server := range servers {
		group.Add(1)
		go func() {
			defer group.Done()
			if err := server.Shutdown(ctx); err != nil {
				// A measurement can outlast the grace period; terminate all of
				// its connections so process shutdown remains bounded.
				_ = server.Close()
			}
		}()
	}
	group.Wait()
}
