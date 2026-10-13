package safehttp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var ErrUnsafeURL = errors.New("unsafe URL")

type Resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}
type netResolver struct{ *net.Resolver }

func (r netResolver) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return r.Resolver.LookupNetIP(ctx, network, host)
}

type Config struct {
	Timeout          time.Duration
	MaxResponseBytes int64
	AllowedPorts     map[string]bool
	Resolver         Resolver
	UserAgent        string
}

func New(cfg Config) *http.Client {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 12 * time.Second
	}
	if cfg.MaxResponseBytes <= 0 {
		cfg.MaxResponseBytes = 2 << 20
	}
	if cfg.Resolver == nil {
		cfg.Resolver = netResolver{net.DefaultResolver}
	}
	if cfg.AllowedPorts == nil {
		cfg.AllowedPorts = map[string]bool{"80": true, "443": true}
	}
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment, MaxIdleConns: 50, MaxIdleConnsPerHost: 4, IdleConnTimeout: 30 * time.Second, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 8 * time.Second, ExpectContinueTimeout: time.Second, ForceAttemptHTTP2: true}
	transport.DialContext = DialContext(cfg)
	client := &http.Client{Timeout: cfg.Timeout, Transport: transport}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return ValidateURL(req.Context(), req.URL, cfg.Resolver, cfg.AllowedPorts)
	}
	return client
}

// DialContext returns a dial function that resolves once, rejects every private or
// reserved answer, and connects to the validated IP to prevent DNS rebinding.
func DialContext(cfg Config) func(context.Context, string, string) (net.Conn, error) {
	if cfg.Resolver == nil {
		cfg.Resolver = netResolver{net.DefaultResolver}
	}
	if cfg.AllowedPorts == nil {
		cfg.AllowedPorts = map[string]bool{"80": true, "443": true}
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if !cfg.AllowedPorts[port] {
			return nil, fmt.Errorf("%w: port %s", ErrUnsafeURL, port)
		}
		ips, err := cfg.Resolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("%w: host has no addresses", ErrUnsafeURL)
		}
		for _, ip := range ips {
			if !publicIP(ip) {
				return nil, fmt.Errorf("%w: private or reserved address", ErrUnsafeURL)
			}
		}
		var dialErrs []error
		for _, ip := range ips {
			conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if dialErr == nil {
				return conn, nil
			}
			dialErrs = append(dialErrs, dialErr)
		}
		return nil, errors.Join(dialErrs...)
	}
}

func ValidateURL(ctx context.Context, u *url.URL, resolver Resolver, allowedPorts map[string]bool) error {
	if u == nil {
		return fmt.Errorf("%w: nil URL", ErrUnsafeURL)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("%w: unsupported scheme", ErrUnsafeURL)
	}
	if u.User != nil {
		return fmt.Errorf("%w: userinfo is forbidden", ErrUnsafeURL)
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("%w: missing host", ErrUnsafeURL)
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	if _, err := strconv.Atoi(port); err != nil || !allowedPorts[port] {
		return fmt.Errorf("%w: port %s", ErrUnsafeURL, port)
	}
	if ip, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		if !publicIP(ip) {
			return fmt.Errorf("%w: private or reserved address", ErrUnsafeURL)
		}
		return nil
	}
	if resolver == nil {
		resolver = netResolver{net.DefaultResolver}
	}
	ips, err := resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return fmt.Errorf("resolve host: %w", err)
	}
	if len(ips) == 0 {
		return fmt.Errorf("%w: host has no addresses", ErrUnsafeURL)
	}
	for _, ip := range ips {
		if !publicIP(ip) {
			return fmt.Errorf("%w: host resolves to private or reserved address", ErrUnsafeURL)
		}
	}
	return nil
}

func publicIP(ip netip.Addr) bool {
	return ip.IsValid() && !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !ip.IsMulticast() && !ip.IsUnspecified() && !ip.IsInterfaceLocalMulticast()
}

func Get(ctx context.Context, raw string, cfg Config) ([]byte, int, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, 0, err
	}
	if cfg.Resolver == nil {
		cfg.Resolver = netResolver{net.DefaultResolver}
	}
	if cfg.AllowedPorts == nil {
		cfg.AllowedPorts = map[string]bool{"80": true, "443": true}
	}
	if err := ValidateURL(ctx, u, cfg.Resolver, cfg.AllowedPorts); err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, 0, err
	}
	if cfg.UserAgent != "" {
		req.Header.Set("User-Agent", cfg.UserAgent)
	}
	client := New(cfg)
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	limit := cfg.MaxResponseBytes
	if limit <= 0 {
		limit = 2 << 20
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if int64(len(body)) > limit {
		return nil, resp.StatusCode, fmt.Errorf("response exceeds %d bytes", limit)
	}
	return body, resp.StatusCode, nil
}

// NewClient returns a hardened client suitable for public HTTP/HTTPS enrichment.
func NewClient() *http.Client {
	return New(Config{Timeout: 12 * time.Second, MaxResponseBytes: 2 << 20, UserAgent: "GoogleMapsScraperLocal"})
}
