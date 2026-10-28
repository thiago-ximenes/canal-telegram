# canal-telegram

Um agente que escreve bem não serve de nada num canal que só sabe texto corrido.
Este é o canal: um daemon de ~700 linhas que recebe tudo que chega no Telegram e
entrega o que o agente deixa numa fila de arquivos — **escolhendo o formato**.

```
 agente (outro processo, sem o token)        daemon (dono do getUpdates)
   │                                            │
   ├─ _saida/1730.json ──────────────────────►  entrega na ordem:
   │    [{tipo:"progresso"},{tipo:"foto"},      texto HTML, voz, imagem, PDF,
   │     {tipo:"botoes"}]                       álbum, botão, enquete, reação
   │                                            │
   └─ caixa.tsv  ◄───────────────────────────  tudo que chega: texto, foto,
        "na enquete 'X' ele marcou: A | B"      PDF, e recado de voz já
                                                transcrito em texto
```

O agente nunca vê o token do bot. Ele escreve um arquivo; o daemon envia.
São processos (e containers) separados de propósito.

## Por que não mandar tudo como texto

O dono do chat lê no celular, muitas vezes em movimento, às vezes com baixa visão.
Tabela em texto corrido quebra cada célula em três linhas. Parágrafo de 5.000
caracteres ninguém lê. Notificação de rotina à meia-noite ensina a desligar o bot.

Então o formato faz parte da resposta:

```
 o que ele precisa FAZER com isso?        isso precisa ACORDAR ele?
   ├─ só saber ─────────► texto            ├─ pede ação hoje ──► normal
   ├─ comparar ─────────► imagem           └─ rotina/status ───► silencioso
   ├─ ler com calma ───► PDF ou citação
   ├─ ouvir andando ───► voz
   └─ decidir ─────────► botões ou enquete
```

`docs/FORMATOS.md` é o manual que vai no prompt do agente: os 13 tipos, as opções
que valem para qualquer envio e as receitas prontas.

## O que tem aqui

| | |
|---|---|
| `bin/escuta.cjs` | o daemon: recebe, entrega, fecha pergunta, baixa anexo |
| `bin/pergunta.cjs` | faz uma pergunta com botões e espera a resposta chegar |
| `bin/cartao.cjs` | dado com coluna vira imagem legível (Chromium headless) |
| `servicos/fala` | texto → recado de voz (edge-tts + ffmpeg, OGG/Opus) |
| `servicos/transcreve` | recado de voz → texto (whisper.cpp, na sua máquina) |
| `exemplos/` | compose, comandos próprios, `.env` |
| `Dockerfile` | o canal como imagem própria, para subir em compose |

Node 20+. Sem dependência de runtime: o daemon usa só `fetch` e `fs`. O cartão
precisa de Playwright (Chromium); os dois serviços de voz são containers.

## Rodar

```bash
export TELEGRAM_TOKEN=123:ABC          # ou $CANAL_DIR/telegram.json com {token, chat}
export TELEGRAM_CHAT=987654321         # descubra mandando /start e lendo getUpdates
node bin/escuta.cjs
```

Agora qualquer processo que enxergue `$CANAL_DIR/respostas/_saida/` fala no chat:

```bash
cat > "$CANAL_DIR/respostas/_saida/$(date +%s).json" <<'EOF'
[{"tipo":"texto","silencioso":true,"texto":"Deploy <b>v2.1</b> no ar — 0 erro em 5 min."},
 {"tipo":"botoes","texto":"Libero para todos?","opcoes":["Libera","Segura"]}]
EOF
```

A escolha dele volta em `caixa.tsv` **com a pergunta junto** — uma sessão retomada
só enxerga essa linha, e "Libera" sozinho não diz a que pergunta responde.

### Quem pode mandar

`TELEGRAM_CHAT` diz para onde o canal **envia**; quem pode **falar** é outra pergunta.
Em conversa privada os dois números são iguais e o padrão resolve: só o seu chat entra
na caixa, update de qualquer outro é descartado com uma linha `recusado 999@999` no log
(uma por remetente, não uma por mensagem).

Num grupo não resolve: lá `chat.id` é o grupo e quem fala é qualquer membro. Então
liste os **ids humanos**:

```bash
export CANAL_DONOS=987654321,123456789    # ou "donos" no telegram.json
```

Um update passa se o remetente **ou** o chat estiver na lista — ou seja, pôr o id de um
grupo em `CANAL_DONOS` libera todo mundo que está nele. Para um agente que roda comando
na sua máquina, liste pessoas, nunca o grupo.

### Em Docker

O canal é um serviço como qualquer outro — `exemplos/compose.yml` sobe ele junto dos
dois de voz:

```bash
docker compose build canal && docker compose up -d canal
```

A imagem carrega o `bin/`, então o que está no ar é o que foi buildado, não o que
alguém editou no disco agora. Só o `comandos/` fica fora dela, montado: é o código do
*seu* projeto, e ele muda num ritmo diferente do canal. Trocar de versão não perde
nada — offset, pendências e `caixa.tsv` vivem em `CANAL_DIR`, no host.

## Voz nos dois sentidos

`servicos/transcreve` roda whisper.cpp na sua própria máquina: o recado de voz vira
texto antes de chegar ao agente (nenhum modelo de linguagem ouve áudio, e mandar a
voz de alguém para serviço de terceiro é uma decisão, não um detalhe). `servicos/fala`
faz o caminho de volta com edge-tts. Voz padrão `pt-BR-AntonioNeural` — uma voz
multilíngue falando português soa artificial o bastante para ele desligar o áudio.

## Comandos próprios

O núcleo não sabe o que é um currículo nem uma cota de API. `CANAL_COMANDOS` aponta
um arquivo que recebe as ferramentas do daemon e devolve seus comandos —
`exemplos/comandos.cjs` tem um pronto.

## Licença

MIT.
