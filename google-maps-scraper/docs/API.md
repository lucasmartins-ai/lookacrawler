# API local

O contrato canônico está em `web/static/openapi.yaml` e também é servido em `/api/openapi.yaml`.

A API acompanha a interface local e não exige token. O servidor continua limitado ao endereço configurado, valida o Host e rejeita operações de escrita originadas por outro site. A criação de buscas suporta idempotência por meio do cabeçalho `Idempotency-Key`.

Não publique a API diretamente na internet. Para acesso em rede, use HTTPS e autenticação em um proxy reverso.
