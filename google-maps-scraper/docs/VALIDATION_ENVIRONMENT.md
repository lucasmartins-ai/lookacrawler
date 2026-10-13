# Ambiente de validação

- Go: 1.26.4
- Arquitetura principal: linux/amd64
- Browser: Chromium gerenciado por playwright-go v0.5700.1
- Banco local: SQLite modernc
- Banco distribuído opcional: PostgreSQL 15+

Comandos mínimos: `make gate`. O Docker deve ser validado em host com daemon disponível. Integrações externas exigem credenciais de teste próprias e nunca são habilitadas na suíte padrão.
