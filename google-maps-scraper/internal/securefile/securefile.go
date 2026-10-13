package securefile

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

func EnsureDir(path string) error {
	if path == "" {
		return errors.New("empty directory path")
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create secure directory: %w", err)
	}
	if err := os.Chmod(path, 0o700); err != nil && !errors.Is(err, fs.ErrPermission) {
		return fmt.Errorf("chmod secure directory: %w", err)
	}
	return nil
}

func Write(path string, data []byte) error {
	if err := EnsureDir(filepath.Dir(path)); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".secure-*")
	if err != nil {
		return fmt.Errorf("create temporary secure file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod temporary secure file: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write temporary secure file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync temporary secure file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temporary secure file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("publish secure file: %w", err)
	}
	return os.Chmod(path, 0o600)
}

func Read(path string, maxBytes int64) ([]byte, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if runtime.GOOS != "windows" && st.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("insecure permissions on %s: expected 0600", path)
	}
	if maxBytes > 0 && st.Size() > maxBytes {
		return nil, fmt.Errorf("secure file too large: %d bytes", st.Size())
	}
	return os.ReadFile(path)
}
