# Formatos — o manual que vai no prompt do agente

Quem lê está **no celular, muitas vezes em movimento, às vezes com baixa visão**, e o chat é o
mesmo onde chegam rotina, relatório e pergunta de decisão. O formato não é enfeite: ele decide
se a informação chega agora, chega depois ou não chega.

Duas perguntas resolvem quase tudo:

```
 o que ele precisa FAZER com isso?          isso precisa ACORDAR ele?
   │                                          │
   ├─ só saber ──────────► texto              ├─ pede ação dele hoje ──► normal
   ├─ comparar/conferir ─► imagem (cartao)    └─ rotina, progresso,
   ├─ ler com calma ────► citação ou PDF          recado de status ──► "silencioso": true
   ├─ ouvir andando ────► voz
   └─ decidir ──────────► botões ou enquete
```

---

## Três jeitos de responder

**Texto** — a resposta normal. Pode escrever markdown à vontade: o daemon traduz `**negrito**`,
`` `código` ``, `# título`, lista e link para a marcação do Telegram.

**Voz** — primeira linha começa com `[voz]`. O resto vira recado falado (`pt-BR-AntonioNeural`,
~120 caracteres por segundo). Sem markdown, sem bullet, sem URL, sem nome de arquivo — tudo isso
é lido em voz alta e soa péssimo.

**Lista de envios** — grave o JSON e responda só `[enviado]`:

```
/entrada/_envio/                   <- arquivos que você gerar (PNG, PDF, OGG)
/entrada/_saida/<timestamp>.json   <- a lista; o daemon varre, envia e apaga
```

---

## O catálogo

Um objeto ou uma lista de objetos. Cada um é um envio, na ordem.

```json
[
  { "tipo": "texto", "texto": "Deploy <b>v2.1</b> no ar — <i>0 erro</i> em 5 min." },
  { "tipo": "foto", "arquivo": "_envio/erros.png", "legenda": "erro por rota, última hora" },
  { "tipo": "botoes", "texto": "Libero para todos?", "opcoes": ["Libera", "Segura"] }
]
```

`texto` — `{ texto, html?: true, preview?: false }`. HTML do Telegram (lista completa abaixo).
`<blockquote expandable>` manda texto longo sem empurrar a conversa para fora da tela: chega
recolhido, ele abre se quiser.

`voz` — `{ texto }`. Mesmo efeito do `[voz]`, mas dá para misturar com outros envios.

`audio` — `{ arquivo, titulo?, autor?, legenda? }`. Faixa com título e duração, que ele pausa e
retoma. Recado curto é `voz`; roteiro de 8 minutos é `audio`.

`foto` — `{ arquivo, legenda?, legenda_acima?: false }`. É o formato de tabela, gráfico e
diagrama. Gere com `cartao.cjs`.

`documento` — `{ arquivo, legenda? }`. PDF, CSV, MD. Ele guarda e abre no tamanho que quiser.

`album` — `{ arquivos: [...], legenda? }`. Até 10, legenda só na primeira.

`video` — `{ arquivo, legenda? }`.

`botoes` — `{ texto, opcoes: [...] }`. Até 8. O clique volta para você como
"ele clicou no botao: X" e a pergunta se fecha no chat com `✓ X`. **Uma escolha.**

`enquete` — `{ texto, opcoes: [...], varias?: true }`. Até 10. É o único jeito de ele marcar
**três de oito** numa tela só; a resposta volta como "A | B | C". Não é anônima.

`progresso` — `{ chave, texto, fim?: true }`. A primeira chamada envia, as seguintes **editam a
mesma mensagem**. 40 itens viram uma linha que muda, em vez de 40 notificações. `fim` solta a
mensagem onde ela parou. Sempre silencioso, a não ser com `"silencioso": false`.

`reacao` — `{ emoji? }`. Marca a última mensagem dele com 👌 (ou 👍 👀 🔥). É o "ok, feito"
que não gasta uma linha do chat. Sem mensagem dele para marcar, não acontece nada.

`local` — `{ lat, lon, titulo, endereco }`. Endereço de reunião: ele toca e abre o mapa.

`contato` — `{ telefone, nome, sobrenome? }`. Um telefone vira contato salvo num toque.

### Opções que valem para qualquer envio

- `"silencioso": true` — chega na tela sem apitar. **Use em tudo que é rotina**: resumo de hora
  em hora, progresso, status. O que pede ação dele hoje vai normal.
- `"responder": true` — cita a mensagem dele. Quando ele manda três coisas e a resposta sai dez
  minutos depois, sem a citação ele tem de adivinhar qual era.
- `"fixar": true` — prega no topo do chat e solta a que estava fixada. Serve para a **única**
  mensagem do dia que ele volta a abrir: pipeline, pendências.
- `"legenda_acima": true` — legenda antes da imagem, quando o contexto vem primeiro.

### Marcação (testada contra a API, 28/10/2026)

`<b>` `<strong>` `<i>` `<em>` `<u>` `<ins>` `<s>` `<strike>` `<del>` `<code>` `<pre>`
`<pre><code class="language-js">` `<a href="…">` `<tg-spoiler>` `<span class="tg-spoiler">`
`<blockquote>` `<blockquote expandable>`.

Não existe tabela, nem título, nem lista nativa — por isso tabela vira imagem. Tag inválida
derruba a mensagem inteira com 400; o daemon reenvia **sem** marcação, então o conteúdo nunca
se perde, só a formatação. Limite de 4.000 caracteres por mensagem (o daemon parte sozinho).

---

## Imagem: `cartao.cjs`

Não escreva CSS novo a cada vez — o visual é fixo de propósito (fundo escuro, 22px, entrelinha
1.6), senão cada cartão sai de um tamanho e o olho tem de se reajustar.

```bash
cat > /entrada/_envio/ficha.json <<'EOF'
{ "titulo": "Fila desta semana", "sub": "o que vence primeiro no topo",
  "tipo": "tabela", "colunas": ["Cliente", "O que falta", "Quando"],
  "linhas": [["Acme", "resposta minha", "02/11"], ["Orion", "contrato", "10/11"]],
  "nota": "Acme vence primeiro." }
EOF
node /app/cartao.cjs /entrada/_envio/ficha.json /entrada/_envio/fila.png
```

Quatro tipos: `tabela` (até 3 colunas), `barras` (`itens` com `rotulo`, `valor`, `n`),
`passos` (`itens` com `rotulo`, `detalhe`) e `fichas` (um bloco por linha). Tabela com mais de
três colunas vira `fichas` sozinha: em 900px a quarta coluna quebraria cada célula em três
linhas — a tabela apertada que ele já reprovou duas vezes. Trocar `.png` por `.pdf` gera PDF.

### HTML próprio, quando o cartão não cobre

```bash
"$CHROME_EXE" --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=900,1400 --screenshot=/entrada/_envio/x.png file:///entrada/_envio/x.html

"$CHROME_EXE" --headless --no-sandbox --disable-gpu --no-pdf-header-footer \
  --print-to-pdf=/entrada/_envio/x.pdf file:///entrada/_envio/x.html
```

Para página inteira sem tarja, use o Playwright de `require(process.env.PLAYWRIGHT_MOD)` com
`fullPage` — é o que o `cartao.cjs` faz. No HTML: fundo escuro, fonte **20px ou mais**,
`line-height` 1.6, contraste alto, nunca peso fino, 900px de largura. Significado por forma e
rótulo, nunca por cor sozinha.

Caminho de arquivo pode ser `_envio/x.png` ou `/entrada/_envio/x.png` (a mesma pasta tem nome
diferente nos dois containers). Fora dela é recusado: o daemon tem o token do bot e não serve de
carona para ler o resto do disco.

---

## Receitas

**Rotina de hora em hora** — nada para decidir, não acorda ninguém:

```json
[{ "tipo": "texto", "silencioso": true,
   "texto": "<b>Fila</b> — 2 novos\n\n• Acme: contrato assinado\n• Orion segue sem resposta" }]
```

**Trabalho longo em andamento** — uma linha que se atualiza, e o resultado fixado no fim:

```json
[{ "tipo": "progresso", "chave": "varredura", "texto": "Varrendo… <b>12</b> de 40" }]
[{ "tipo": "progresso", "chave": "varredura", "texto": "Varredura encerrada: <b>6</b> pendências.", "fim": true },
 { "tipo": "foto", "arquivo": "_envio/pendencias.png", "fixar": true, "legenda": "as 6, por prazo" }]
```

**Resposta demorada** — cita o que ele perguntou e confirma na própria mensagem dele:

```json
[{ "tipo": "reacao", "emoji": "👌" },
 { "tipo": "texto", "responder": true, "texto": "Respondido e arquivado." }]
```

**Decisão de uma escolha** → `botoes`. **Escolher vários de uma lista** → `enquete` com
`"varias": true`. Pergunta de até 8 palavras, opção curta, no máximo 4 em botão.

**Material longo para ele estudar** — PDF, não parede de texto:

```json
[{ "tipo": "documento", "arquivo": "_envio/relatorio.pdf",
   "legenda": "relatório do mês — 1 página, fonte grande" },
 { "tipo": "voz", "texto": "Mandei o relatório em PDF. São três números, e o último é o que mudou." }]
```

---

## O que já deu errado

- **Markdown cru na tela.** `**Título**` e `### Resumo` apareciam com os símbolos. O daemon
  traduz toda resposta de texto; no `tipo: "texto"` do JSON já mande HTML.
- **Tabela em texto corrido.** Ele reprovou duas vezes: cada célula quebra em três linhas e
  vira ruído. Tabela é imagem.
- **Voz multilíngue falando português.** Soou artificial o bastante para ele desligar o áudio.
  A voz é `pt-BR-AntonioNeural` e não se troca sem ele pedir.
- **Resposta de 5.000 caracteres em bloco único.** Ou vira voz, ou `<blockquote expandable>`,
  ou PDF.
- **Notificação de rotina à meia-noite.** Toda mensagem que ele não precisa ler agora leva
  `"silencioso": true`.
