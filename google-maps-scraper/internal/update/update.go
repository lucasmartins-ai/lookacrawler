package update

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Artifact struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}
type Manifest struct {
	Version   string     `json:"version"`
	Artifacts []Artifact `json:"artifacts"`
}

func Verify(manifestPath, signaturePath string, publicKey ed25519.PublicKey, root string) (Manifest, error) {
	var m Manifest
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return m, err
	}
	sig, err := os.ReadFile(signaturePath)
	if err != nil {
		return m, err
	}
	if !ed25519.Verify(publicKey, raw, sig) {
		return m, errors.New("invalid update manifest signature")
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return m, err
	}
	if m.Version == "" {
		return m, errors.New("manifest version is empty")
	}
	cleanRoot, err := filepath.Abs(root)
	if err != nil {
		return m, err
	}
	for _, a := range m.Artifacts {
		clean := filepath.Clean(a.Path)
		if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return m, fmt.Errorf("unsafe artifact path: %s", a.Path)
		}
		full := filepath.Join(cleanRoot, clean)
		abs, err := filepath.Abs(full)
		if err != nil || !strings.HasPrefix(abs, cleanRoot+string(filepath.Separator)) {
			return m, fmt.Errorf("artifact escapes root: %s", a.Path)
		}
		data, err := os.ReadFile(abs)
		if err != nil {
			return m, fmt.Errorf("read artifact %s: %w", a.Path, err)
		}
		sum := sha256.Sum256(data)
		if !strings.EqualFold(hex.EncodeToString(sum[:]), a.SHA256) {
			return m, fmt.Errorf("checksum mismatch for %s", a.Path)
		}
	}
	return m, nil
}
