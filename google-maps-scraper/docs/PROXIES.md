# Proxies

Google Maps scraping can trigger rate limits or blocking, especially with larger jobs or higher concurrency. Proxies can help, but they are not a guarantee. Proxy quality, geography, concurrency, query volume, and Google behavior all affect reliability.

## Configure Proxies

Use `-proxies` with a comma-separated list:

```bash
./google-maps-scraper \
  -input queries.txt \
  -results results.csv \
  -proxies "socks5://user:pass@host:port,http://host2:port2" \
  -depth 1
```

Supported protocols: `socks5`, `socks5h`, `http`, `https`.

## Docker Example

```bash
mkdir -p gmaps-output

docker run \
  -v gmaps-playwright-cache:/opt \
  -v "$PWD/example-queries.txt:/queries.txt:ro" \
  -v "$PWD/gmaps-output:/out" \
  gosom/google-maps-scraper \
  -input /queries.txt \
  -results /out/results.csv \
  -depth 1 \
  -proxies "http://user:pass@host:port,socks5://host:port" \
  -exit-on-inactivity 3m
```

## Practical Notes

- Test with a small input file before running a large job.
- Increase concurrency gradually.
- If results become less reliable, reduce `-c` before assuming the proxy provider is the only issue.
- Keep proxy URLs private. Do not commit credentials.
