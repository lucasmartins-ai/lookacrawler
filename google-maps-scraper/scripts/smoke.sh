#!/usr/bin/env sh
set -eu
bin=${1:-./bin/google-maps-scraper}
"$bin" version | grep -F '2.2.0'
"$bin" help >/dev/null
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
"$bin" doctor -data-folder "$work" -addr 127.0.0.1:0 >/dev/null
[ -f "$work/diagnostics.zip" ]
