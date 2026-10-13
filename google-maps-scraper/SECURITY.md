# Política de segurança

## Escopo

Esta edição é local e destinada a uma pessoa por instalação. Não há cadastro, sessão, token ou tela de login. A configuração padrão aceita conexões somente do próprio computador.

## Controles implementados

- bind local, validação de Host e validação de origem em operações que alteram dados;
- CSP, cabeçalhos defensivos e limitação de requisições;
- proteção SSRF com bloqueio de endereços privados e revalidação de redirecionamentos;
- arquivos de chave, banco, resultados e exportações com permissões restritas;
- remoção de credenciais e dados sensíveis dos registros operacionais;
- proteção contra fórmulas maliciosas em CSV;
- writer externo isolado e verificável por SHA-256;
- varredura de segredos no gate de versão.

## Operação segura

Mantenha a interface em `127.0.0.1`. O modo de rede deve ser habilitado apenas de forma consciente e exige uma lista explícita de hosts. Como não há autenticação no aplicativo, qualquer acesso por rede deve passar por firewall e proxy reverso com HTTPS e autenticação. Nunca publique a chave de criptografia, bancos, resultados ou arquivos de proxies.

## Relato de vulnerabilidade

Não abra uma issue pública contendo exploração ou dados reais. Envie um relatório privado ao mantenedor, incluindo versão, impacto, passos mínimos e correção sugerida. Troque imediatamente qualquer credencial externa exposta.
