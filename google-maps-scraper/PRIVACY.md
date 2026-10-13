# Privacidade

O aplicativo armazena campanhas e resultados localmente. A telemetria é desativada por padrão e não envia palavras-chave, contatos, resultados, proxies ou credenciais.

## Dados armazenados

- buscas e situações no SQLite;
- configuração das buscas criptografada com chave local;
- resultados e arquivos CSV no diretório de dados;
- eventos operacionais sem o conteúdo bruto dos contatos.

## Consulta de localização

Ao digitar uma cidade, bairro ou endereço, o texto é enviado ao serviço público Photon para obter coordenadas baseadas no OpenStreetMap. Quando não há resposta, a mesma consulta pode ser enviada ao Open-Meteo, que usa dados do GeoNames. As respostas ficam em cache local por 24 horas. Não informe dados pessoais ou confidenciais nesse campo.

## Retenção e exclusão

A exclusão de uma busca remove seus registros, resultados finais ou parciais e exportações associadas. Cópias de segurança externas continuam sob responsabilidade do operador.

## Enriquecimento

A busca opcional de e-mails consulta somente sites públicos relacionados aos resultados, com limites de resposta e proteções de rede. Use a função apenas com base legal e finalidade legítima.
