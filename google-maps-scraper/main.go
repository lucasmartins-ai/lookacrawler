package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"

	"github.com/coelhobugado/google-maps-scraper/internal/diagnostics"
	"github.com/coelhobugado/google-maps-scraper/internal/update"
	"github.com/coelhobugado/google-maps-scraper/internal/version"
	"github.com/coelhobugado/google-maps-scraper/runner"
	"github.com/coelhobugado/google-maps-scraper/runner/databaserunner"
	"github.com/coelhobugado/google-maps-scraper/runner/filerunner"
	"github.com/coelhobugado/google-maps-scraper/runner/installplaywright"
	"github.com/coelhobugado/google-maps-scraper/runner/webrunner"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		printHelp()
		return nil
	}
	command := args[0]
	if command == "help" || command == "-h" || command == "--help" {
		printHelp()
		return nil
	}
	if command == "version" {
		fmt.Printf("%s %s (Go %s)\n", version.Name, version.Version, runtime.Version())
		return nil
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	switch command {
	case "verify-update":
		return verifyUpdate(args[1:])
	}
	cfg, err := runner.ParseConfigArgs(args[1:])
	if err != nil {
		return err
	}
	switch command {
	case "serve", "desktop":
		cfg.WebRunner = true
		cfg.Desktop = command == "desktop"
		cfg.RunMode = runner.RunModeWeb
	case "scrape":
		if cfg.Dsn == "" {
			cfg.RunMode = runner.RunModeFile
		} else if cfg.ProduceOnly {
			cfg.RunMode = runner.RunModeDatabaseProduce
		} else {
			cfg.RunMode = runner.RunModeDatabase
		}
		if cfg.InputFile == "" {
			return errors.New("-input is required; use -input stdin for standard input")
		}
	case "install-browser":
		cfg.RunMode = runner.RunModeInstallPlaywright
	case "doctor":
		report := diagnostics.Run(ctx, cfg.DataFolder, cfg.Addr, nil)
		for _, c := range report.Checks {
			fmt.Printf("%-22s %-8s %s\n", c.Name, c.Status, c.Detail)
		}
		path := cfg.DataFolder + string(os.PathSeparator) + "diagnostics.zip"
		if err := diagnostics.WritePackage(path, report); err != nil {
			return err
		}
		fmt.Println("diagnostic package:", path)
		return nil
	default:
		return fmt.Errorf("unknown command %q", command)
	}
	runner.Banner()
	instance, err := runnerFactory(cfg)
	if err != nil {
		return err
	}
	defer func() { _ = instance.Close(context.Background()); _ = runner.Telemetry().Close() }()
	if cfg.Desktop {
		if p, ok := instance.(interface{ BrowserURL() string }); ok {
			go openBrowser(p.BrowserURL())
		}
	}
	if err := instance.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}

func runnerFactory(cfg *runner.Config) (runner.Runner, error) {
	switch cfg.RunMode {
	case runner.RunModeFile:
		return filerunner.New(cfg)
	case runner.RunModeDatabase, runner.RunModeDatabaseProduce:
		return databaserunner.New(cfg)
	case runner.RunModeInstallPlaywright:
		return installplaywright.New(cfg)
	case runner.RunModeWeb:
		return webrunner.New(cfg)
	default:
		return nil, fmt.Errorf("%w: %d", runner.ErrInvalidRunMode, cfg.RunMode)
	}
}
func openBrowser(raw string) {
	if raw == "" {
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", raw)
	case "darwin":
		cmd = exec.Command("open", raw)
	default:
		cmd = exec.Command("xdg-open", raw)
	}
	_ = cmd.Start()
}
func verifyUpdate(args []string) error {
	if len(args) != 4 {
		return errors.New("usage: verify-update <manifest.json> <manifest.sig> <public-key-base64> <artifact-root>")
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(args[2]))
	if err != nil {
		return err
	}
	if len(key) != ed25519.PublicKeySize {
		return errors.New("invalid Ed25519 public key")
	}
	manifest, err := update.Verify(args[0], args[1], ed25519.PublicKey(key), args[3])
	if err != nil {
		return err
	}
	fmt.Printf("verified update %s with %d artifact(s)\n", manifest.Version, len(manifest.Artifacts))
	return nil
}
func printHelp() {
	fmt.Printf(`%s %s

Uso:
  google-maps-scraper <command> [options]

Comandos:
  desktop         Inicia a interface local e abre o navegador
  serve           Inicia o servidor HTTP local
  scrape          Executa uma extração pela linha de comando
  install-browser Instala o navegador necessário para as buscas
  doctor          Verifica o ambiente e gera diagnostics.zip para suporte
  verify-update   Verifica um pacote de atualização assinado
  version         Exibe a versão instalada

Segurança padrão:
  - A interface escuta apenas no computador local, salvo configuração explícita de rede.
  - Credenciais opcionais devem vir de variáveis de ambiente ou arquivos protegidos.
  - A telemetria permanece desativada por padrão.
`, version.Name, version.Version)
}
