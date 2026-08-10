FROM oven/bun:1.3 as base
WORKDIR /app

# Install System dependencies for Playwright Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libsqlite3-dev \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.json ./
RUN bun install

COPY . .

# Install Playwright Chromium browser binaries
RUN bunx playwright install chromium

EXPOSE 3000

ENV PORT=3000

CMD ["bun", "run", "cli.ts", "serve", "--transport", "sse", "--port", "3000"]
