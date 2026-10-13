# Estratégia de testes

- unitários: validação, CSV, perímetro HTTP local, SSRF, update, parsers, grid e dedupe;
- integração: migração/lifecycle SQLite, API HTTP, worker e PostgreSQL com doubles;
- race: pacotes concorrentes e camada web;
- smoke: versão, help e diagnóstico;
- release: secret scan, scope scan, tidy, test, vet, build e checksums.

Fixtures externas ausentes não quebram a distribuição: testes históricos pulam explicitamente e existem fixtures autossuficientes para drift de schema.
