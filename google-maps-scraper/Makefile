APP := google-maps-scraper
VERSION := 2.2.0
GO ?= go

.PHONY: help fmt fmt-check tidy tidy-check test test-race vet build smoke gate clean package docker
help:
	@printf '%s\n' 'fmt fmt-check tidy-check test test-race vet build smoke gate package docker clean'
fmt:
	@gofmt -s -w $$(find . -name '*.go' -not -path './.git/*')
fmt-check:
	@test -z "$$(gofmt -l $$(find . -name '*.go' -not -path './.git/*'))"
tidy:
	@$(GO) mod tidy
tidy-check:
	@cp go.mod /tmp/gmaps-go.mod && cp go.sum /tmp/gmaps-go.sum; \
	$(GO) mod tidy; diff -u /tmp/gmaps-go.mod go.mod; diff -u /tmp/gmaps-go.sum go.sum
test:
	@$(GO) test -count=1 ./...
test-race:
	@$(GO) test -race -count=1 ./deduper ./grid ./internal/... ./web/... ./runner/webrunner
vet:
	@$(GO) vet ./...
build:
	@mkdir -p bin && $(GO) build -trimpath -o bin/$(APP) .
smoke: build
	@./scripts/smoke.sh ./bin/$(APP)
gate:
	@./scripts/gate.sh
package:
	@./scripts/package.sh $(VERSION)
docker:
	@docker build --pull -t $(APP):$(VERSION) .
clean:
	@rm -rf bin dist coverage.out
