# Security policy

## Reporting a vulnerability

Email **lucas@lookadev.com** with the subject `lookacrawler security`. Please
include steps to reproduce and the version or commit. You will get a reply within
5 working days. Do not open a public issue for security reports.

## What runs where

- Extraction, crawling and the MCP server run on your machine. LookaCrawler sends
  no telemetry.
- Network requests go only to the pages you ask it to read. The optional Google
  Maps engine also calls the Photon/OpenStreetMap geocoder.
- Fetches to private, loopback and link-local addresses are blocked by default.

## Supported versions

Only the latest release on `main` receives fixes.
