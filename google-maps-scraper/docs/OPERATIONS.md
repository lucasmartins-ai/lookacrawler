# Operação

## Diretório de dados

Contém `jobs.db`, `encryption.key`, resultados, exportações e pacotes de diagnóstico. Faça cópias de segurança com o processo parado. Preserve as permissões e nunca versione esse diretório.

## Inicialização

1. Execute `install-browser` na primeira instalação.
2. Inicie com `desktop` para abrir a interface automaticamente.
3. Informe o tipo de empresa e escolha uma localização sugerida.
4. Inicie a busca e acompanhe o progresso na própria tela.

O comando `doctor` é destinado ao suporte técnico e não aparece na interface do usuário.

## Recuperação

As buscas usam lease e heartbeat. Ao iniciar, execuções vencidas voltam à fila enquanto ainda houver tentativas. Resultados parciais ficam disponíveis para download quando possível.

## Retenção

Configure `-retention-days` para a limpeza automática. O endpoint local `POST /api/v1/retention/run` permite uma limpeza manual por integração. Valide as cópias de segurança antes de reduzir o período.

## Diagnóstico de suporte

O comando `doctor` verifica diretório, permissões, porta e ambiente e gera `diagnostics.zip`. O pacote não inclui proxies, consultas ou resultados.

## PostgreSQL

Aplique migrações em ordem, teste rollback em uma cópia e monitore buscas em execução com lease expirado, tentativas e último erro.
