package runner

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coelhobugado/google-maps-scraper/internal/version"
	"github.com/coelhobugado/google-maps-scraper/tlmt"
	"github.com/coelhobugado/google-maps-scraper/tlmt/gonoop"
	"github.com/gosom/scrapemate/scrapemateapp"
)

const (
	RunModeFile = iota + 1
	RunModeDatabase
	RunModeDatabaseProduce
	RunModeInstallPlaywright
	RunModeWeb
)

var ErrInvalidRunMode = errors.New("invalid run mode")

type Runner interface {
	Run(context.Context) error
	Close(context.Context) error
}

type Config struct {
	Concurrency              int
	CacheDir                 string
	MaxDepth                 int
	InputFile                string
	ResultsFile              string
	JSON                     bool
	LangCode                 string
	Debug                    bool
	Dsn                      string
	ProduceOnly              bool
	ExitOnInactivityDuration time.Duration
	Email                    bool
	CustomWriter             string
	GeoCoordinates           string
	Zoom                     int
	RunMode                  int
	WebRunner                bool
	Desktop                  bool
	DataFolder               string
	Proxies                  []string
	FastMode                 bool
	Radius                   float64
	Addr                     string
	AllowNetwork             bool
	AllowedHosts             []string
	DisablePageReuse         bool
	ExtraReviews             bool
	LeadsDBAPIKey            string
	LeadsDBPreviewMode       bool
	BrowserPoolSize          int
	MaxPagesPerBrowser       int
	GridBBox                 string
	GridCellKm               float64
	MaxGridCells             int
	MaxSeedJobs              int
	RetentionDays            int
	MaxRequestBytes          int64
	Version                  bool
}

func DefaultConfig() *Config {
	return &Config{Concurrency: max(runtime.NumCPU()/2, 1), CacheDir: "cache", MaxDepth: 10, ResultsFile: "stdout", LangCode: "en", Zoom: 15, DataFolder: "webdata", Radius: 10000, Addr: "127.0.0.1:8080", GridCellKm: 1, MaxGridCells: 100, MaxSeedJobs: 1000, MaxPagesPerBrowser: 1, RetentionDays: 30, MaxRequestBytes: 1 << 20, ExitOnInactivityDuration: 5 * time.Second}
}

func ParseConfig() (*Config, error) { return ParseConfigArgs(os.Args[1:]) }

func ParseConfigArgs(args []string) (*Config, error) {
	cfg := DefaultConfig()
	fs := flag.NewFlagSet("google-maps-scraper", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var proxies, allowedHosts string
	fs.IntVar(&cfg.Concurrency, "c", cfg.Concurrency, "concurrent workers")
	fs.StringVar(&cfg.CacheDir, "cache", cfg.CacheDir, "cache directory")
	fs.IntVar(&cfg.MaxDepth, "depth", cfg.MaxDepth, "maximum search scroll depth")
	fs.StringVar(&cfg.ResultsFile, "results", cfg.ResultsFile, "result file or stdout")
	fs.StringVar(&cfg.InputFile, "input", cfg.InputFile, "query file or stdin")
	fs.StringVar(&cfg.LangCode, "lang", cfg.LangCode, "Google language code")
	fs.BoolVar(&cfg.Debug, "debug", false, "open a visible browser")
	fs.StringVar(&cfg.Dsn, "dsn", os.Getenv("GMAPS_DATABASE_URL"), "PostgreSQL DSN; prefer GMAPS_DATABASE_URL")
	fs.BoolVar(&cfg.ProduceOnly, "produce", false, "enqueue database jobs only")
	fs.DurationVar(&cfg.ExitOnInactivityDuration, "exit-on-inactivity", cfg.ExitOnInactivityDuration, "stop after inactivity")
	fs.BoolVar(&cfg.JSON, "json", false, "write JSON instead of CSV")
	fs.BoolVar(&cfg.Email, "email", false, "enrich public website emails")
	fs.StringVar(&cfg.CustomWriter, "writer", "", "absolute executable writer path")
	fs.StringVar(&cfg.GeoCoordinates, "geo", "", "latitude,longitude")
	fs.IntVar(&cfg.Zoom, "zoom", cfg.Zoom, "map zoom 1-21")
	fs.StringVar(&cfg.DataFolder, "data-folder", cfg.DataFolder, "local application data directory")
	fs.StringVar(&proxies, "proxies", "", "comma-separated proxy URLs; prefer GMAPS_PROXIES_FILE")
	fs.BoolVar(&cfg.FastMode, "fast-mode", false, "use map search endpoint")
	fs.Float64Var(&cfg.Radius, "radius", cfg.Radius, "search radius in metres")
	fs.StringVar(&cfg.Addr, "addr", cfg.Addr, "web listen address")
	fs.BoolVar(&cfg.AllowNetwork, "allow-network", false, "allow binding beyond loopback")
	fs.StringVar(&allowedHosts, "allowed-hosts", "", "comma-separated Host values for network mode")
	fs.BoolVar(&cfg.DisablePageReuse, "disable-page-reuse", false, "disable browser page reuse")
	fs.BoolVar(&cfg.ExtraReviews, "extra-reviews", false, "collect additional reviews")
	fs.BoolVar(&cfg.LeadsDBPreviewMode, "leadsdb-preview", false, "validate LeadsDB mapping without upload")
	fs.StringVar(&cfg.GridBBox, "grid-bbox", "", "minLat,minLon,maxLat,maxLon")
	fs.Float64Var(&cfg.GridCellKm, "grid-cell", cfg.GridCellKm, "grid cell size in kilometres")
	fs.IntVar(&cfg.MaxGridCells, "max-grid-cells", cfg.MaxGridCells, "maximum grid cells")
	fs.IntVar(&cfg.MaxSeedJobs, "max-seed-jobs", cfg.MaxSeedJobs, "maximum seed jobs")
	fs.IntVar(&cfg.BrowserPoolSize, "browser-pool-size", 0, "browser context pool size")
	fs.IntVar(&cfg.MaxPagesPerBrowser, "pages-per-browser", cfg.MaxPagesPerBrowser, "pages per browser context")
	fs.IntVar(&cfg.RetentionDays, "retention-days", cfg.RetentionDays, "local campaign retention in days; 0 disables")
	fs.BoolVar(&cfg.Version, "version", false, "print version")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if path := os.Getenv("GMAPS_PROXIES_FILE"); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read GMAPS_PROXIES_FILE: %w", err)
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line != "" && !strings.HasPrefix(line, "#") {
				cfg.Proxies = append(cfg.Proxies, line)
			}
		}
	} else if proxies != "" {
		for _, p := range strings.Split(proxies, ",") {
			if p = strings.TrimSpace(p); p != "" {
				u, err := url.Parse(p)
				if err != nil {
					return nil, fmt.Errorf("invalid proxy URL: %w", err)
				}
				if u.User != nil {
					return nil, errors.New("proxy credentials are not accepted on the command line; use GMAPS_PROXIES_FILE")
				}
				cfg.Proxies = append(cfg.Proxies, p)
			}
		}
	}
	cfg.LeadsDBAPIKey = os.Getenv("LEADSDB_API_KEY")
	for _, h := range strings.Split(allowedHosts, ",") {
		if h = strings.TrimSpace(h); h != "" {
			cfg.AllowedHosts = append(cfg.AllowedHosts, h)
		}
	}
	if cfg.Version {
		return cfg, nil
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (c *Config) Validate() error {
	if c.Concurrency < 1 || c.Concurrency > 128 {
		return fmt.Errorf("concurrency must be between 1 and 128")
	}
	if c.MaxDepth < 1 || c.MaxDepth > 100 {
		return fmt.Errorf("depth must be between 1 and 100")
	}
	if c.Zoom < 1 || c.Zoom > 21 {
		return fmt.Errorf("zoom must be between 1 and 21")
	}
	if c.Radius < 0 || c.Radius > 500000 {
		return fmt.Errorf("radius must be between 0 and 500000")
	}
	if c.MaxGridCells < 1 || c.MaxGridCells > 100000 {
		return fmt.Errorf("max-grid-cells must be between 1 and 100000")
	}
	if c.MaxSeedJobs < 1 || c.MaxSeedJobs > 1000000 {
		return fmt.Errorf("max-seed-jobs must be between 1 and 1000000")
	}
	if c.MaxPagesPerBrowser < 1 || c.MaxPagesPerBrowser > 32 {
		return fmt.Errorf("pages-per-browser must be between 1 and 32")
	}
	if c.ProduceOnly && c.Dsn == "" {
		return errors.New("database DSN is required with -produce")
	}
	if c.FastMode && c.GeoCoordinates == "" {
		return errors.New("-geo is required with -fast-mode")
	}
	return nil
}

var telemetryOnce sync.Once
var telemetry tlmt.Telemetry

func Telemetry() tlmt.Telemetry {
	telemetryOnce.Do(func() { telemetry = gonoop.New() })
	return telemetry
}

func AppendBrowserCapacityOptions(opts []func(*scrapemateapp.Config) error, cfg *Config) []func(*scrapemateapp.Config) error {
	if cfg.MaxPagesPerBrowser > 1 {
		opts = append(opts, scrapemateapp.WithMaxPagesPerBrowser(cfg.MaxPagesPerBrowser))
	}
	if cfg.BrowserPoolSize > 0 {
		opts = append(opts, scrapemateapp.WithBrowserPoolSize(cfg.BrowserPoolSize))
	}
	return opts
}
func Banner() {
	fmt.Fprintf(os.Stderr, "%s %s · local-first · telemetry disabled by default\n", version.Name, version.Version)
}
