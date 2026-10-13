#!/usr/bin/env sh
set -eu
if grep -RIE --exclude-dir=.git --exclude-dir=reports --exclude-dir=docs/audit --exclude='check-scope.sh' --exclude='SCOPE.md' --exclude='*.sum' '(self-hosted SaaS|admin UI|two-factor|2FA|riverqueue|organization API key|cloud provisioning)' .; then
  echo 'Legacy platform residue found' >&2; exit 1
fi
