# syntax=docker/dockerfile:1.7
ARG GO_VERSION=1.26.4
FROM golang:${GO_VERSION}-trixie AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags='-s -w' -o /out/google-maps-scraper .

FROM builder AS browser-installer
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
RUN mkdir -p /opt/browsers && /out/google-maps-scraper install-browser

FROM debian:trixie-slim AS runtime
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers \
    PLAYWRIGHT_DRIVER_PATH=/opt/ms-playwright-go \
    GMAPS_DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxkbcommon0 libatspi2.0-0 libx11-6 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system gmaps && useradd --system --gid gmaps --create-home gmaps \
    && mkdir -p /data /opt/browsers /opt/ms-playwright-go \
    && chown -R gmaps:gmaps /data /opt/browsers /opt/ms-playwright-go
COPY --from=builder --chown=root:root /out/google-maps-scraper /usr/local/bin/google-maps-scraper
COPY --from=browser-installer --chown=gmaps:gmaps /opt/browsers /opt/browsers
COPY --from=browser-installer --chown=gmaps:gmaps /root/.cache/ms-playwright-go /opt/ms-playwright-go
USER gmaps
WORKDIR /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null && curl --fail --silent http://127.0.0.1:8080/readyz >/dev/null || exit 1
ENTRYPOINT ["google-maps-scraper"]
CMD ["serve","-data-folder","/data","-addr","0.0.0.0:8080","-allow-network","-allowed-hosts","localhost,127.0.0.1"]
