#!/usr/bin/env sh
set -eu
printf 'version='; go run . version
printf 'go='; go version
printf 'modules_sha256='; sha256sum go.mod go.sum | sha256sum | cut -d' ' -f1
printf 'source_commit='; git rev-parse HEAD 2>/dev/null || printf 'not-a-git-checkout\n'
printf 'packages=%s\n' "$(go list ./... | wc -l | tr -d ' ')"
printf 'go_files=%s\n' "$(find . -name '*.go' -not -path './.git/*' | wc -l | tr -d ' ')"
