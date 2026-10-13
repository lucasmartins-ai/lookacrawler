#!/usr/bin/env sh
set -eu
export GOTOOLCHAIN=local
./scripts/check-secrets.sh
./scripts/check-scope.sh
./scripts/check-version.sh
[ -z "$(gofmt -l $(find . -name '*.go' -not -path './.git/*'))" ]
cp go.mod /tmp/gmaps-go.mod.$$; cp go.sum /tmp/gmaps-go.sum.$$
trap 'rm -f /tmp/gmaps-go.mod.$$ /tmp/gmaps-go.sum.$$' EXIT
go mod tidy
diff -u /tmp/gmaps-go.mod.$$ go.mod
diff -u /tmp/gmaps-go.sum.$$ go.sum
go test -count=1 ./...
go vet ./...
go build -trimpath -o /tmp/google-maps-scraper-gate .
./scripts/smoke.sh /tmp/google-maps-scraper-gate
rm -f /tmp/google-maps-scraper-gate
