#!/usr/bin/env sh
set -eu
bad='BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|AKIA[0-9A-Z]{16}|xox[baprs]-|gh[pousr]_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}'
if grep -RIE --exclude-dir=.git --exclude='*.sum' --exclude='check-secrets.sh' "$bad" .; then
  echo 'Potential secret found' >&2; exit 1
fi
find . -type f \( -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' -o -name 'test_ssh_key*' \) -not -path './.git/*' | grep . && exit 1 || true
