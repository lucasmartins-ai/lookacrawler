<p align="center">
  <img src="banner.png" alt="Maps Leads Banner" width="100%">
</p>

# 🗺️ Maps Leads — Prospecção Local Inteligente

![Go Version](https://img.shields.io/badge/Go-1.26.4+-00ADD8?style=for-the-badge&logo=go)
![License](https://img.shields.io/badge/Licença-MIT-blue?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Ativo-success?style=for-the-badge)

Aplicativo local em **Go** para encontrar empresas no Google Maps, organizar contatos públicos e baixar resultados em CSV. A interface foi projetada para uso simples: informe o tipo de empresa, digite a cidade ou região e inicie a busca.

---

## ✨ Principais Recursos

- 🎯 **Localização por Texto**: Busca por nome, cidade, bairro ou endereço, sem exigir coordenadas.
- 💡 **Sugestões Gratuitas**: Integração com Photon/OpenStreetMap e contingência com Open-Meteo/GeoNames.
- 🤖 **Contingência Automática**: Modo texto alternativo quando o serviço de sugestões estiver indisponível.
- ⚙️ **Flexibilidade de Busca**: Buscas rápidas, equilibradas ou mais completas, com raio configurável.
- 📊 **Acompanhamento Transparente**: Progresso em linguagem simples e clara.
- 🌗 **Interface Moderna**: Temas claro e escuro, ambos totalmente responsivos.
- 📋 **Resultados Detalhados**: Nome, categoria, nota, endereço, site e Instagram separados.
- 📥 **Exportação Simplificada**: Download de todos os resultados ou apenas dos filtros aplicados em CSV (otimizado para o Excel brasileiro).
- 💾 **Privacidade e Desempenho**: Armazenamento local em SQLite, sem cadastro, login ou token.
- 📧 **Enriquecimento de Dados**: Busca opcional de e-mails publicados nos sites encontrados.

---

## 🚀 Requisitos

- **Go 1.26.4** (para desenvolvimento)
- **Chromium** (instalado automaticamente pelo comando `install-browser`)
- Compatível com **Windows, macOS ou Linux 64-bit**

> **Nota:** O uso do PostgreSQL é opcional e destinado somente a execuções distribuídas avançadas. A interface local utiliza o SQLite embutido.

---

## ⚡ Início Rápido

Para começar a usar, compile e rode o projeto na sua máquina:

```bash
# 1. Compilar o projeto
go build -o google-maps-scraper .

# 2. Instalar o navegador necessário (Chromium)
./google-maps-scraper install-browser

# 3. Iniciar a interface
./google-maps-scraper desktop -data-folder ./data
```

O navegador abrirá automaticamente na interface do sistema. Por padrão, o servidor escuta somente em `127.0.0.1`, ficando acessível **apenas no próprio computador**.

---

## 💻 Uso via Linha de Comando (CLI)

Você também pode utilizar o Maps Leads diretamente no terminal:

```bash
# Executar uma extração a partir de um arquivo
./google-maps-scraper scrape -input queries.txt -results results.csv

# Gerar saída em JSON
./google-maps-scraper scrape -input queries.txt -results results.json -json

# Iniciar o servidor sem abrir o navegador (modo headless)
./google-maps-scraper serve -data-folder ./data

# Gerar um diagnóstico para suporte técnico
./google-maps-scraper doctor -data-folder ./data
```

> **Dica:** O arquivo `queries.txt` usa uma consulta por linha. Linhas vazias são ignoradas. Um identificador opcional pode ser informado como `consulta #!# id`.

---

## 🌍 Localização por Texto

A interface consulta o serviço público **Photon** somente quando o usuário digita um local, e usa o **Open-Meteo/GeoNames** como segunda fonte para cidades e CEPs. 

- As respostas são **priorizadas para o Brasil** e ficam em cache por 24 horas.
- Se ambos estiverem indisponíveis, o aplicativo pesquisa diretamente pelo nome do local informado, sem exigir coordenadas.
- Os serviços são **gratuitos para uso moderado**. Para uma operação de grande escala, configure instâncias ou planos próprios compatíveis.

---

## 🔒 Segurança e Privacidade

Sua segurança e privacidade são levadas a sério:

- 🛡️ Acesso local por padrão, com validação de host e origem;
- 🛡️ Cabeçalhos defensivos (CSP) e limite de requisições;
- 🛡️ Proteção contra SSRF no enriquecimento de sites;
- 🛡️ CSV protegido contra fórmulas maliciosas;
- 🛡️ Configuração das buscas criptografada no SQLite;
- 🛡️ **Telemetria desativada por padrão**.

> **Aviso:** Como a interface não exige autenticação, **não exponha a porta diretamente na internet**. Caso habilite acesso em rede, use um proxy reverso com HTTPS e autenticação.

Consulte os arquivos [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md) e [docs/OPERATIONS.md](docs/OPERATIONS.md) para mais informações.

---

## 🔌 Proxies e Integrações Opcionais

Prefira usar variáveis de ambiente ou arquivos protegidos para suas configurações:

```bash
export GMAPS_PROXIES_FILE=/caminho/proxies.txt
export LEADSDB_API_KEY='...'
export GMAPS_DATABASE_URL='postgres://...'
```

Veja mais detalhes em [docs/PROXIES.md](docs/PROXIES.md).

---

## 🐳 Docker

Para rodar via Docker, basta um comando:

```bash
docker compose up --build scraper
```

A porta é publicada somente em `127.0.0.1:8080`. O contêiner roda com configurações de segurança estritas (sem usuário root, sem capabilities Linux e com sistema de arquivos somente leitura).

---

## 🐘 PostgreSQL (Opcional)

Se desejar usar Postgres no lugar do SQLite local:

```bash
# Rodar migrações
migrate -path scripts/migrations -database "$GMAPS_DATABASE_URL" up

# Uso
./google-maps-scraper scrape -input queries.txt -dsn "$GMAPS_DATABASE_URL" -produce
./google-maps-scraper scrape -input queries.txt -dsn "$GMAPS_DATABASE_URL"
```

---

## 🛠️ Qualidade e Empacotamento

Use os comandos do Make para manter o código limpo e seguro:

```bash
make gate
make package
```
> O comando `make gate` executa varredura de segredos, formatação, testes, vet, build e smoke test.

---

## ⚖️ Uso Responsável

Respeite os termos dos serviços consultados, a privacidade, os limites de acesso e a legislação aplicável. **Não use o programa para acessar áreas privadas, assediar pessoas ou coletar dados além do necessário e permitido.**
