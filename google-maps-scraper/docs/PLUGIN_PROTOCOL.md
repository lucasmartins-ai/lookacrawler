# Protocolo de writer externo

O aplicativo inicia um executável absoluto e envia um objeto JSON por linha no stdin. O writer deve processar streaming, respeitar encerramento do stdin e retornar código diferente de zero em falha.

O stdout é descartado; stderr é limitado. O processo recebe ambiente mínimo e diretório temporário. Configure `GMAPS_WRITER_SHA256` para bloquear troca do executável entre configuração e execução.
