package update

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestVerifySignedManifestAndRejectTraversal(t *testing.T) {
	root := t.TempDir()
	artifact := []byte("binary")
	if err := os.WriteFile(filepath.Join(root, "app"), artifact, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(artifact)
	m := Manifest{Version: "2.1.0", Artifacts: []Artifact{{Path: "app", SHA256: hex.EncodeToString(sum[:])}}}
	data, _ := json.Marshal(m)
	manifest := filepath.Join(root, "manifest.json")
	sigPath := filepath.Join(root, "manifest.sig")
	if err := os.WriteFile(manifest, data, 0o600); err != nil {
		t.Fatal(err)
	}
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	sig := ed25519.Sign(priv, data)
	if err := os.WriteFile(sigPath, sig, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(manifest, sigPath, pub, root); err != nil {
		t.Fatal(err)
	}
	m.Artifacts[0].Path = "../escape"
	data, _ = json.Marshal(m)
	_ = os.WriteFile(manifest, data, 0o600)
	_ = os.WriteFile(sigPath, ed25519.Sign(priv, data), 0o600)
	if _, err := Verify(manifest, sigPath, pub, root); err == nil {
		t.Fatal("path traversal accepted")
	}
}
