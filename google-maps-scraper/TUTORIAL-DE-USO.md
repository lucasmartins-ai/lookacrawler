# Tutorial de uso — Maps Leads 2.2.0

🎉 **Muito obrigado pela sua compra!** Você acaba de adquirir a ferramenta definitiva para prospecção local.

Este tutorial mostra o passo a passo para você abrir e usar o Maps Leads para encontrar empresas, visualizar contatos públicos e baixar milhares de resultados em CSV.

> **Importante:** o Maps Leads é seu e funciona localmente no seu computador. Não é necessário criar conta, fazer assinaturas mensais ou depender de nuvem.

## 1. Antes de começar

Você precisará de:

- Windows, macOS ou Linux de 64 bits;
- conexão com a internet durante as buscas;
- espaço livre no computador para salvar os bancos de dados;
- apenas 1 minuto para realizar a configuração inicial!

Os dados das buscas ficam armazenados na pasta escolhida na primeira execução. Não apague essa pasta se quiser manter o histórico e os resultados.

## 2. Primeiro acesso no Windows

Para deixar tudo extremamente simples para você, nós criamos botões fáceis de usar! Não é necessário mexer com códigos ou telas pretas difíceis.

Nós precisamos apenas baixar um "navegador invisível" (Chromium) que o robô vai usar para fazer as buscas no Google Maps por baixo dos panos sem atrapalhar o seu mouse.

1. Abra a pasta onde você salvou o projeto.
2. Dê dois cliques no arquivo **`1 - Instalar Navegador.bat`**.
3. Aguarde o download terminar e a tela fechar. **Atenção: Isso é necessário apenas na primeiríssima vez que for usar o programa no seu computador!**
4. Agora, dê dois cliques no arquivo **`2 - Iniciar Maps Leads.bat`**.

Pronto! O seu navegador padrão será aberto automaticamente na interface do Maps Leads.

## 3. Instalação no macOS ou Linux

Dentro da pasta do projeto, execute:

```bash
go build -buildvcs=false -o maps-leads .
./maps-leads install-browser
./maps-leads desktop -data-folder ./dados
```

Se o sistema bloquear a execução, dê permissão ao arquivo:

```bash
chmod +x maps-leads
```

## 4. Como abrir a ferramenta no dia a dia

Nas próximas vezes que você for trabalhar, o processo é ainda mais simples (não precisa instalar mais nada).

Sempre que quiser usar o programa, basta dar dois cliques no botão mágico:

**`2 - Iniciar Maps Leads.bat`**

Deixe a janelinha preta que abrir minimizada. Se o navegador não abrir sozinho, basta ir no seu Chrome e acessar manualmente o link:

<http://127.0.0.1:8080/>

## 5. Criando a primeira busca

Na tela inicial, clique em **Criar nova busca** ou **Nova busca**.

### Passo 1 — informe o que deseja encontrar

No campo **Tipo de empresa ou serviço**, digite o segmento desejado.

Exemplo com um termo:

```text
Clínicas odontológicas
```

Exemplo com vários termos:

```text
Clínicas odontológicas
Laboratórios de prótese
Ortodontistas
```

Use uma linha para cada termo. É possível pesquisar até 100 termos na mesma busca, mas começar com poucos termos facilita a análise dos resultados.

### Passo 2 — escolha o local

1. Digite uma cidade, bairro, região, endereço ou CEP.
2. Aguarde as sugestões aparecerem.
3. Clique na opção correta, conferindo cidade, estado e país.

Exemplos:

```text
Uberlândia, Minas Gerais
Centro, Franca, SP
38400-000
```

Você não precisa descobrir latitude ou longitude.

Se os serviços de localização estiverem temporariamente indisponíveis, o programa permitirá continuar usando o texto digitado. Para obter maior precisão, sempre inclua a cidade e o estado.

### Passo 3 — escolha o alcance

| Configuração | Quando usar                                         |
| ------------ | --------------------------------------------------- |
| Até 5 km     | Busca concentrada em um bairro ou região pequena    |
| Até 10 km    | Opção equilibrada para a maioria das cidades        |
| Até 25 km    | Cidades maiores ou regiões metropolitanas           |
| Até 50 km    | Área ampla; pode aumentar bastante o tempo da busca |

### Passo 4 — escolha o nível de busca

| Nível         | Característica                                 |
| ------------- | ---------------------------------------------- |
| Rápida        | Termina mais cedo e coleta menos resultados    |
| Equilibrada   | Recomendada para a maioria das buscas          |
| Mais completa | Procura mais resultados, mas pode demorar mais |

### Passo 5 — opções adicionais

Abra **Opções adicionais** apenas quando precisar.

- **Buscar e-mails públicos:** procura e-mails publicados nos sites das empresas. Nem todas as empresas possuem um e-mail público.
- **Coletar avaliações adicionais:** amplia a coleta de avaliações e pode aumentar consideravelmente o tempo da busca.
- **Nome da busca:** permite dar um nome fácil de reconhecer. Se ficar vazio, o programa cria um nome automaticamente.

Depois de revisar o resumo, clique em **Iniciar busca**.

## 6. Acompanhando o progresso

Após iniciar, a tela exibirá uma barra de progresso com a etapa atual.

O percentual inicial pode ser estimado enquanto o programa prepara a região. Durante a coleta, ele passa a considerar as etapas e empresas processadas.

Você pode continuar usando o computador normalmente, mas deve manter o programa aberto. Fechar apenas a aba do navegador não encerra o processo; fechar a janela do terminal interrompe a ferramenta.

| Situação           | Significado                                              |
| ------------------ | -------------------------------------------------------- |
| Aguardando         | A busca está na fila local                               |
| Busca em andamento | Empresas e contatos estão sendo coletados                |
| Busca concluída    | A coleta terminou normalmente                            |
| Com erro           | Ocorreu uma falha e a busca pode ser executada novamente |
| Tempo encerrado    | A busca atingiu o limite configurado                     |
| Cancelada          | O usuário solicitou o cancelamento                       |
| Interrompida       | O programa ou computador foi encerrado durante a busca   |

## 7. Entendendo os resultados

Cada empresa é exibida em um cartão organizado. Dependendo das informações públicas disponíveis, você poderá ver:

- nome da empresa;
- categoria principal;
- avaliação e quantidade de avaliações;
- endereço;
- telefone;
- site;
- Instagram;
- e-mail;
- horário de funcionamento;
- descrição e faixa de preço;
- responsável, quando informado;
- link para o Google Maps.

O **Instagram é tratado separadamente do site**. Um perfil do Instagram não será contado como se fosse o site oficial da empresa.

Use os ícones do cartão para ligar, abrir o site, acessar o Instagram ou visualizar a empresa no mapa.

Clique em **Ver mais informações** para abrir dados adicionais sem deixar a tela principal sobrecarregada.

## 8. Filtrando os resultados

Na área de resultados, abra **Filtrar resultados**.

Você pode filtrar por:

- nome, endereço ou contato;
- categoria;
- nota mínima;
- empresas com telefone;
- empresas com site;
- empresas com Instagram;
- empresas com e-mail.

Depois de escolher os filtros, clique em **Aplicar filtros**.

Para remover tudo, clique em **Limpar**.

## 9. Baixando o CSV

### Baixar todos os resultados

Clique em **Baixar tudo em CSV** ou **Baixar tudo**. O download começa diretamente, sem necessidade de configurar uma exportação.

### Baixar somente os resultados filtrados

1. Abra **Filtrar resultados**.
2. Escolha os filtros desejados.
3. Clique em **Aplicar filtros** para conferir o resultado.
4. Clique em **Baixar filtrados**.

O CSV é gerado:

- em português;
- com codificação UTF-8;
- separado por ponto e vírgula;
- organizado para o Excel no padrão brasileiro;
- com horários convertidos para texto legível;
- com site e Instagram em colunas separadas;
- sem objetos JSON vazios no campo de responsável.

As principais colunas incluem nome, categorias, endereço, bairro, cidade, estado, CEP, telefone, site, Instagram, e-mails, avaliação, horários e link do Google Maps.

## 10. Alterando o tema

No canto superior direito, clique no botão com o ícone de sol ou lua.

- **Tema claro:** indicado para ambientes bem iluminados.
- **Tema escuro:** reduz o brilho da interface em ambientes escuros.

A preferência fica salva no navegador utilizado.

## 11. Gerenciando buscas

Na tela **Minhas buscas**, clique em uma busca para abri-la.

As ações disponíveis podem incluir:

- **Cancelar busca:** interrompe uma busca em andamento;
- **Executar novamente:** reinicia uma busca que já terminou ou apresentou erro;
- **Duplicar busca:** cria uma cópia com a mesma configuração;
- **Excluir busca:** remove a busca, os resultados e as exportações associadas.

> A exclusão é definitiva. Baixe o CSV antes de excluir uma busca importante.

## 12. Onde os dados ficam armazenados

Ao usar o comando:

```text
-data-folder .\dados
```

o programa cria a pasta `dados` no mesmo local do executável. Ela guarda:

- histórico das buscas;
- banco de dados local;
- resultados completos ou parciais;
- arquivos de exportação.

Para fazer backup, feche o programa e copie a pasta `dados` inteira para outro local.

Para restaurar, coloque a pasta novamente ao lado do executável e inicie usando o mesmo comando.

## 13. Encerrando corretamente

1. Aguarde as buscas importantes terminarem.
2. Volte à janelinha preta do `2 - Iniciar Maps Leads.bat` que ficou minimizada.
3. Simplesmente feche ela clicando no **X** no canto superior direito.

Lembre-se: Fechar apenas a aba do navegador não desliga o motor do programa! Sempre feche a janelinha preta quando terminar.

## 14. Solução de problemas

### O navegador da ferramenta não foi encontrado (Erro do Playwright)

Você provavelmente esqueceu de rodar o passo de instalação inicial. Volte na pasta e dê dois cliques no arquivo:
**`1 - Instalar Navegador.bat`**

### A interface não abriu automaticamente

Acesse:

<http://127.0.0.1:8080/>

Se ainda não abrir, verifique se o programa continua em execução no terminal.

### A porta 8080 já está sendo usada

Inicie em outra porta:

```powershell
.\MapsLeads.exe desktop -addr 127.0.0.1:8081 -data-folder .\dados
```

Depois, acesse <http://127.0.0.1:8081/>.

### A busca por local não mostrou sugestões

- confirme que há conexão com a internet;
- informe cidade e estado, como `Franca, SP`;
- aguarde alguns segundos e tente novamente;
- se aparecer a opção de continuar com o texto digitado, você pode usá-la.

### A busca encontrou poucas empresas

- use termos mais simples, como `Dentistas` em vez de uma descrição muito longa;
- confira se o local selecionado está correto;
- aumente a distância;
- escolha o nível **Mais completa**;
- pesquise termos relacionados em linhas separadas.

### Alguns contatos estão vazios

O programa apresenta somente informações públicas encontradas. Uma empresa pode não publicar telefone, site, Instagram ou e-mail.

### A busca está demorando

O tempo depende da quantidade de termos, distância, nível escolhido, conexão e opções adicionais. Evite iniciar muitos termos com alcance de 50 km e nível completo na primeira tentativa.

### O programa foi fechado durante uma busca

Abra novamente usando a mesma pasta `dados`. A busca poderá aparecer como interrompida. Abra-a e use **Executar novamente**.

## 15. Boas práticas

- Comece com um termo e alcance de 10 km.
- Confira alguns resultados antes de fazer uma busca muito ampla.
- Use o filtro de Instagram separadamente do filtro de site.
- Faça backup periódico da pasta `dados`.
- Não desligue o computador durante uma coleta importante.
- Respeite os termos dos serviços consultados e a legislação de privacidade.
- Use contatos públicos de maneira responsável e evite mensagens em massa não solicitadas.

## 16. Resumo rápido

1. Dê dois cliques em **`2 - Iniciar Maps Leads.bat`**.
2. Clique em **Nova busca**.
3. Informe o tipo de empresa.
4. Digite e selecione o local.
5. Escolha distância e nível.
6. Clique em **Iniciar busca**.
7. Aguarde a conclusão.
8. Analise ou filtre os cartões.
9. Clique em **Baixar tudo em CSV** ou **Baixar filtrados**.
10. Feche a janelinha preta do programa para encerrar.

---

**Maps Leads 2.2.0** — ferramenta local de prospecção e organização de contatos públicos.
