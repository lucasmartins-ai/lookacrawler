# Metas operacionais locais

Estas metas são referências de engenharia para uma instalação local suportada, não uma promessa de serviço em nuvem.

- API local: 99,9% das respostas administrativas abaixo de 500 ms, excluindo leitura de CSV grande.
- Criação/cancelamento de campanha: confirmação persistida abaixo de 1 s.
- Recuperação de worker: jobs com lease expirado devem ser recuperados em até 2 minutos.
- Integridade: nenhuma campanha pode ser marcada como concluída antes da publicação atômica do resultado.
- Segurança: nenhuma credencial, palavra-chave, contato ou resultado deve aparecer em telemetria ou pacote de diagnóstico.
- Exportação: SHA-256 e contagem de linhas devem acompanhar cada artefato.
- Memória: grades, deduplicação e respostas HTTP devem respeitar os limites configurados.

Os gates em `scripts/gate.sh` verificam formatação, testes, análise estática, escopo e segredos antes da embalagem.
