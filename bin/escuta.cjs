// Daemon: UNICO dono do getUpdates do bot. Fica em long-poll para sempre, grava tudo
// que chega e entrega tudo que o agente deixa na fila de saida. Quem pergunta
// (pergunta.cjs) nao chama getUpdates -- dois long-polls no mesmo bot brigam e o
// Telegram devolve 409 Conflict.
//
//   node bin/escuta.cjs            -> roda para sempre (container "telegram")
//
// Configuracao (env):
//   TELEGRAM_TOKEN, TELEGRAM_CHAT  -> ou um JSON {token, chat} em $CANAL_DIR/telegram.json
//   CANAL_DIR    pasta de estado        (padrao ~/.cache/canal-telegram)
//   CANAL_NOME   assina a faixa de audio (padrao "canal")
//   CANAL_COMANDOS  caminho de um .cjs com comandos proprios (veja exemplos/comandos.cjs)
//   FALA, TRANSCRITOR  URLs dos servicos de voz (veja servicos/)
//
// Grava em $CANAL_DIR/respostas:
//   caixa.tsv                 <- toda mensagem recebida, sempre
//   <id>.json                 <- resposta de uma pergunta feita com botao ou enquete
//   _pendentes/<id>.json      <- pergunta aberta (escrita por pergunta.cjs)
//   _saida/<ts>.(txt|json)    <- fila de saida: o que o agente quer enviar
//   _anexos/                  <- o que ele manda (foto, PDF, audio) desce para ca
const fs = require('fs'), os = require('os');
const DIR = process.env.CANAL_DIR || os.homedir() + '/.cache/canal-telegram';
const RESP = DIR + '/respostas', PEND = RESP + '/_pendentes';
const NOME = process.env.CANAL_NOME || 'canal';
// Token por env ou por arquivo: o arquivo existe para o token nao aparecer em
// `docker inspect` nem no historico do shell.
const cred = process.env.TELEGRAM_TOKEN
  ? { token: process.env.TELEGRAM_TOKEN, chat: process.env.TELEGRAM_CHAT }
  : JSON.parse(fs.readFileSync(DIR + '/telegram.json', 'utf8'));
const { token, chat } = cred;
if (!token || !chat) throw new Error('faltou TELEGRAM_TOKEN/TELEGRAM_CHAT (ou $CANAL_DIR/telegram.json)');
const OFF = DIR + '/telegram-offset.json';
fs.mkdirSync(PEND, { recursive: true });

const api = (m, body) => fetch(`https://api.telegram.org/bot${token}/${m}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());
const lerOff = () => { try { return JSON.parse(fs.readFileSync(OFF, 'utf8')).offset || 0; } catch { return 0; } };
const log = (...a) => console.log(new Date().toISOString(), ...a);
const diz = (text) => api('sendMessage', { chat_id: chat, text });

// Ele reclamou do "anotado: ..." em 28/10/2026, e a reacao que tentei no lugar era
// pior: um tique nao diz O QUE foi feito. O recibo certo fica no objeto da acao --
// a PERGUNTA e reescrita com a resposta embaixo, que e o que o botao ja fazia.
// Nenhuma mensagem nova nasce. Sem pergunta aberta nao ha o que editar: ai vale o
// "digitando", que some sozinho em ~5s e nao entra no historico.
const digitando = (acao = 'typing') => api('sendChatAction', { chat_id: chat, action: acao }).catch(() => {});

// O sendChatAction morre em ~5s. Quando o agente leva minutos, um disparo so deixa
// ele sem sinal nenhum. Entao o "digitando" vira um estado com prazo: marcaTrabalho
// escreve ate quando vale, e um laco reemite a cada 4s enquanto nao vencer. O prazo
// existe para o indicador nao ficar mentindo para sempre se o agente morrer no meio.
const TRABALHO = RESP + '/.trabalhando';
const marcaTrabalho = (segundos) => segundos > 0
  ? fs.writeFileSync(TRABALHO, String(Date.now() + segundos * 1000))
  : (() => { try { fs.unlinkSync(TRABALHO); } catch {} })();

// Fila de saida: o agente roda no OUTRO container e nao tem o token do bot -- de
// proposito, o token mora so aqui. Ele deixa a resposta em _saida/ e este laco
// entrega. O Telegram corta em 4096 caracteres, entao a mensagem longa vai partida.
const FILA = RESP + '/_saida';
fs.mkdirSync(FILA, { recursive: true });

// Foto, PDF, audio: o arquivo desce para ca e o agente (outro container) le pelo
// mesmo caminho, porque ./telegram/estado/respostas e montado la como /entrada.
// Sem isto, qualquer mensagem que nao fosse texto puro era descartada em silencio.
const ANEXOS = RESP + '/_anexos';
fs.mkdirSync(ANEXOS, { recursive: true });

async function baixar(fileId, nomeSugerido) {
  const j = await api('getFile', { file_id: fileId });
  if (!j.ok) throw new Error('getFile: ' + JSON.stringify(j).slice(0, 120));
  const caminhoRemoto = j.result.file_path;
  const ext = (caminhoRemoto.match(/\.[a-z0-9]+$/i) || [''])[0];
  const nome = `${Date.now()}-${(nomeSugerido || 'arquivo').replace(/[^\w.-]/g, '_')}${nomeSugerido ? '' : ext}`;
  const bin = Buffer.from(await fetch(`https://api.telegram.org/file/bot${token}/${caminhoRemoto}`).then((r) => r.arrayBuffer()));
  fs.writeFileSync(`${ANEXOS}/${nome}`, bin);
  return { nome, bytes: bin.length };
}

// O transcritor so existe dentro da rede do Docker e pode estar reiniciando ou
// sem modelo. Devolver null aqui nao e falha: e o caminho de volta para "fica o
// arquivo anotado", que era o comportamento antes de existir transcricao.
const TRANSCRITOR = process.env.TRANSCRITOR || 'http://transcreve:8080';

async function transcrever(caminho) {
  marcaTrabalho(300);                    // em CPU velha 1 min de fala leva ~1 min
  try {
    const r = await fetch(`${TRANSCRITOR}/transcrever`, {
      method: 'POST',
      headers: { 'x-ext': (caminho.match(/\.[a-z0-9]+$/i) || ['.oga'])[0], 'content-type': 'application/octet-stream' },
      body: fs.readFileSync(caminho),
    });
    const j = await r.json();
    if (!r.ok || !j.texto) throw new Error(j.erro || `http ${r.status}`);
    return j.texto.trim() || null;
  } catch (e) {
    log('transcricao falhou', e.message);
    return null;
  } finally {
    marcaTrabalho(0);
  }
}

// Recado de voz: o agente deixa <ts>.voz.txt e este laco manda como audio. Nasceu
// em 28/10/2026, quando ele pediu "manda em audio pra eu ir ouvindo que agora nao
// consigo ler tudo" e o canal so sabia texto. A fala vem do servico `fala`, que
// so existe dentro da rede do Docker.
const FALA = process.env.FALA || 'http://fala:8080';
// Tamanho do recado, nao da espera: a pt-BR-AntonioNeural sintetiza ~120 chars/s
// (476 chars em 4s, medido 28/10), entao 3.000 caracteres saem em ~25s. A voz
// multilingue que veio antes fazia ~20 chars/s e era ela que mandava no corte.
const PEDACO_VOZ = 3000;

// Corta em fronteira de paragrafo, senao de frase: recado que comeca no meio de
// uma palavra e pior que recado comprido.
function partir(texto, max) {
  const pedacos = [];
  let resto = texto;
  while (resto.length > max) {
    const janela = resto.slice(0, max);
    const corte = Math.max(janela.lastIndexOf('\n\n'), janela.lastIndexOf('. '), janela.lastIndexOf('\n'));
    const ate = corte > max / 3 ? corte + 1 : max;
    pedacos.push(resto.slice(0, ate).trim());
    resto = resto.slice(ate);
  }
  if (resto.trim()) pedacos.push(resto.trim());
  return pedacos;
}

async function mandaVoz(texto) {
  const r = await fetch(`${FALA}/falar`, {
    method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: texto,
  });
  if (!r.ok) throw new Error(`fala http ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const ogg = Buffer.from(await r.arrayBuffer());
  const fd = new FormData();
  fd.append('chat_id', String(chat));
  fd.append('voice', new Blob([ogg], { type: 'audio/ogg' }), 'recado.ogg');
  const j = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, { method: 'POST', body: fd })
    .then((x) => x.json());
  if (!j.ok) throw new Error('sendVoice: ' + JSON.stringify(j).slice(0, 160));
  return ogg.length;
}

// --------------------------------------------- o que o agente pode mandar
// Ate 28/10/2026 a fila de saida so sabia texto corrido, e ele lia tabela em letra
// miuda e paragrafo de 5.000 caracteres. Agora o agente deixa <ts>.json com uma LISTA
// de envios e escolhe o formato de cada um: texto com marcacao, recado de voz, imagem,
// documento, album ou pergunta com botao. O protocolo esta em pipeline/CANAL-TELEGRAM.md.
const path = require('path');

// Caminho de arquivo so dentro de RESP, que e o /entrada do agente: o daemon tem o
// token do bot e nao serve de carona para ler o resto do disco. A mesma pasta tem nome
// diferente nos dois containers, entao o agente pode escrever "_envio/x.png" ou o
// caminho que ele ve, "/entrada/_envio/x.png" -- os dois chegam no mesmo arquivo.
function dentro(caminho) {
  const p = path.resolve(RESP, String(caminho || '').replace(/^\/entrada\//, ''));
  if (p !== RESP && !p.startsWith(RESP + '/')) throw new Error('arquivo fora de /entrada: ' + caminho);
  if (!fs.existsSync(p)) throw new Error('arquivo nao existe: ' + caminho);
  return p;
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain',
  '.csv': 'text/csv', '.html': 'text/html', '.json': 'application/json',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
};
const mime = (p) => MIME[(p.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()] || 'application/octet-stream';

// sendPhoto, sendDocument e irmaos querem o arquivo no corpo multipart, nao em JSON.
async function comArquivo(metodo, campo, caminho, extras = {}) {
  const p = dentro(caminho);
  const fd = new FormData();
  fd.append('chat_id', String(chat));
  for (const [k, v] of Object.entries(extras)) {
    if (v === undefined || v === null || v === '') continue;
    fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  fd.append(campo, new Blob([fs.readFileSync(p)], { type: mime(p) }), path.basename(p));
  const j = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, { method: 'POST', body: fd })
    .then((x) => x.json());
  if (!j.ok) throw new Error(`${metodo}: ` + JSON.stringify(j).slice(0, 200));
  return j;
}

// O Claude escreve em markdown por reflexo, e o Telegram nao renderiza nada disso: ele
// lia "**Titulo**" e "### Resumo" com os asteriscos na tela. A traducao acontece aqui, no
// caminho de TODA resposta de texto, em vez de depender de o agente lembrar.
function mdParaHtml(md) {
  const blocos = [];
  let t = String(md).replace(/```[a-z]*\n?([\s\S]*?)```/g, (_, c) => `\u0000${blocos.push(c.replace(/\n+$/, '')) - 1}\u0000`);
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  t = esc(t);
  t = t.replace(/^\s{0,3}#{1,6}\s*(.+?)\s*#*$/gm, '<b>$1</b>');     // titulo vira negrito
  t = t.replace(/^(\s*)[-*+]\s+/gm, '$1\u2022 ');                   // marcador vira bolinha
  t = t.replace(/^\s*([-*_]\s*){3,}$/gm, '\u2500\u2500\u2500\u2500\u2500');
  t = t.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, '$1<i>$2</i>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre>${esc(blocos[Number(i)])}</pre>`);
}

// Marcacao do Telegram e HTML: <b> <i> <u> <s> <code> <pre> <a> <tg-spoiler> e
// <blockquote expandable>, que e o jeito de mandar texto longo sem empurrar o resto
// da conversa para fora da tela. Tag errada derruba a mensagem INTEIRA com 400, e
// perder o conteudo por causa de um <b> aberto seria troca ruim: no 400 o mesmo
// texto vai cru.
async function mandaTexto(texto, { html = true, preview = false, markdown = false, op = {} } = {}) {
  let ultimo = null;
  for (const pedaco of partir(texto, 4000)) {
    const corpo = markdown ? mdParaHtml(pedaco) : pedaco;
    const base = { ...op, chat_id: chat, text: corpo, link_preview_options: { is_disabled: !preview } };
    const j = await api('sendMessage', html ? { ...base, parse_mode: 'HTML' } : base);
    if (j.ok) { ultimo = j.result; continue; }
    if (!html) throw new Error('sendMessage: ' + JSON.stringify(j).slice(0, 160));
    log('HTML recusado, mandando cru:', String(j.description || '').slice(0, 120));
    // Cai para o pedaco ORIGINAL: o convertido pode estar justamente com a tag quebrada.
    const k = await api('sendMessage', { ...base, text: pedaco });
    if (!k.ok) throw new Error('sendMessage: ' + JSON.stringify(k).slice(0, 160));
    ultimo = k.result;
  }
  return ultimo;
}

async function mandaAlbum(arquivos, legenda, op = {}) {
  const fd = new FormData();
  fd.append('chat_id', String(chat));
  for (const [k, v] of Object.entries(op)) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const media = arquivos.slice(0, 10).map((a, i) => {
    const p = dentro(a);
    fd.append(`f${i}`, new Blob([fs.readFileSync(p)], { type: mime(p) }), path.basename(p));
    const item = { type: mime(p).startsWith('image/') ? 'photo' : 'document', media: `attach://f${i}` };
    return i === 0 && legenda ? { ...item, caption: legenda, parse_mode: 'HTML' } : item;
  });
  fd.append('media', JSON.stringify(media));
  const j = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: 'POST', body: fd })
    .then((x) => x.json());
  if (!j.ok) throw new Error('sendMediaGroup: ' + JSON.stringify(j).slice(0, 200));
  return (j.result || [])[0] || null;
}

// Botao do agente usa a mesma pendencia do pergunta.cjs, com id "ag-": o clique volta
// por `anota` e o agente.cjs sabe que linha com esse prefixo e para ele. Sem o prefixo
// a escolha dele cairia na regra "isso e resposta de pergunta minha" e seria ignorada.
async function mandaBotoes(texto, opcoes, op = {}) {
  const id = 'ag-' + Date.now().toString(36);
  const escolhas = opcoes.map((o) => String(o)).filter(Boolean).slice(0, 8);
  const j = await api('sendMessage', {
    ...op, chat_id: chat, text: texto, link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: escolhas.map((o, i) => [{ text: o.slice(0, 64), callback_data: `${id}:${i}` }]) },
  });
  if (!j.ok) throw new Error('sendMessage(botoes): ' + JSON.stringify(j).slice(0, 160));
  fs.writeFileSync(`${PEND}/${id}.json`, JSON.stringify({
    id, pergunta: texto, opcoes: escolhas, msgId: j.result.message_id,
    quando: new Date().toISOString(), expira: Date.now() + 24 * 3600000,
  }, null, 1));
  return j.result;
}

async function fazVoz(texto) {
  marcaTrabalho(600);
  try {
    let bytes = 0;
    for (const pedaco of partir(texto, PEDACO_VOZ)) {
      await digitando('record_voice');
      bytes += await mandaVoz(pedaco);
    }
    return bytes;
  } finally { marcaTrabalho(0); }
}

// Opcoes que valem para qualquer envio.
//  - silencioso: chega na tela sem apitar. A rotina de inbox de hora em hora nao
//    precisa acordar ninguem; o que pede acao dele, sim.
//  - responder: cita a mensagem dele. Quando ele manda tres coisas e a resposta sai
//    dez minutos depois, sem a citacao ele tem de adivinhar qual era.
//  - fixar: prega no topo do chat. Serve para a UNICA mensagem do dia que ele volta
//    a abrir -- pipeline, pendencia -- e substitui a anterior.
const ULTIMA = RESP + '/.ultima-dele';
const ultimaDele = () => { try { return Number(fs.readFileSync(ULTIMA, 'utf8')) || 0; } catch { return 0; } };

function comuns(item) {
  const o = {};
  if (item.silencioso) o.disable_notification = true;
  const alvo = item.responder === true ? ultimaDele() : Number(item.responder) || 0;
  if (alvo) o.reply_parameters = { message_id: alvo, allow_sending_without_reply: true };
  return o;
}

// Mensagem que se atualiza no lugar: 40 itens viram UMA linha que muda, em vez de 40
// notificacoes. A chave amarra as edicoes; `fim` solta a mensagem onde ela parou.
const PROG = RESP + '/.progresso.json';
const lerProg = () => { try { return JSON.parse(fs.readFileSync(PROG, 'utf8')); } catch { return {}; } };

async function mandaProgresso(item) {
  const mapa = lerProg();
  const chave = String(item.chave || 'geral');
  // Igual ao tipo "texto": o JSON manda HTML pronto. Passar pelo mdParaHtml escapava a
  // tag e ele via "<b>40</b> itens" cru no chat.
  const texto = item.markdown ? mdParaHtml(String(item.texto || '')) : String(item.texto || '');
  if (mapa[chave]) {
    const j = await api('editMessageText', {
      chat_id: chat, message_id: mapa[chave], text: texto, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    if (!j.ok && !/not modified/i.test(String(j.description || ''))) {
      throw new Error('editMessageText: ' + JSON.stringify(j).slice(0, 160));
    }
  } else {
    const j = await api('sendMessage', {
      ...comuns(item), chat_id: chat, text: texto, parse_mode: 'HTML',
      disable_notification: item.silencioso !== false, link_preview_options: { is_disabled: true },
    });
    if (!j.ok) throw new Error('sendMessage(progresso): ' + JSON.stringify(j).slice(0, 160));
    mapa[chave] = j.result.message_id;
  }
  const id = mapa[chave];
  if (item.fim) delete mapa[chave];
  fs.writeFileSync(PROG, JSON.stringify(mapa));
  return { message_id: id };
}

// Enquete de multipla escolha e a unica coisa aqui que botao nao faz: ele marca tres
// itens de oito numa tela so, sem digitar. A resposta volta pelo update poll_answer.
async function mandaEnquete(item) {
  const opcoes = (item.opcoes || []).map((o) => String(o).slice(0, 100)).filter(Boolean).slice(0, 10);
  const j = await api('sendPoll', {
    ...comuns(item), chat_id: chat,
    question: String(item.texto || '').slice(0, 300),
    options: opcoes.map((text) => ({ text })),
    is_anonymous: false,
    allows_multiple_answers: !!item.varias,
  });
  if (!j.ok) throw new Error('sendPoll: ' + JSON.stringify(j).slice(0, 200));
  const id = 'ag-' + Date.now().toString(36);
  fs.writeFileSync(`${PEND}/${id}.json`, JSON.stringify({
    id, pergunta: item.texto, opcoes, msgId: j.result.message_id,
    pollId: j.result.poll && j.result.poll.id, quando: new Date().toISOString(),
    expira: Date.now() + 24 * 3600000,
  }, null, 1));
  return j.result;
}

// Reacao no lugar de "ok, feito": confirma que a mensagem dele foi lida e atendida sem
// gastar uma linha do chat. So emoji da lista do Telegram -- o resto volta 400.
async function reagir(item) {
  const alvo = Number(item.responder) || ultimaDele();
  // Sem mensagem dele para marcar (daemon recem-subido), a reacao simplesmente nao
  // acontece: ela e confirmacao, nao conteudo -- avisar "falhou" seria o ruido que
  // ela existe para evitar.
  if (!alvo) { log('reacao sem alvo, ignorada'); return null; }
  const j = await api('setMessageReaction', {
    chat_id: chat, message_id: alvo,
    reaction: [{ type: 'emoji', emoji: item.emoji || '\u{1F44C}' }],
  });
  if (!j.ok) throw new Error('setMessageReaction: ' + JSON.stringify(j).slice(0, 160));
  return {};
}

async function entrega(item) {
  const t = String(item.tipo || 'texto').toLowerCase();
  const op = comuns(item);
  const legenda = item.legenda ? { caption: item.legenda, parse_mode: 'HTML',
    show_caption_above_media: !!item.legenda_acima } : {};
  let res = null;

  if (t === 'texto') res = await mandaTexto(item.texto, { html: item.html !== false, preview: !!item.preview, op });
  else if (t === 'voz') { await fazVoz(item.texto); res = null; }
  else if (t === 'progresso') res = await mandaProgresso(item);
  else if (t === 'enquete') res = await mandaEnquete(item);
  else if (t === 'reacao') res = await reagir(item);
  else if (t === 'botoes') res = await mandaBotoes(item.texto, item.opcoes || [], op);
  else if (t === 'album') { await digitando('upload_photo'); res = await mandaAlbum(item.arquivos || [], item.legenda, op); }
  else if (t === 'foto') {
    await digitando('upload_photo');
    res = (await comArquivo('sendPhoto', 'photo', item.arquivo, { ...op, ...legenda })).result;
  } else if (t === 'documento') {
    await digitando('upload_document');
    res = (await comArquivo('sendDocument', 'document', item.arquivo, { ...op, ...legenda })).result;
  } else if (t === 'audio') {
    // sendAudio, nao sendVoice: faixa com titulo e duracao, que ele pausa e retoma.
    // Recado curto continua sendo voz; roteiro de 8 minutos e faixa.
    await digitando('upload_voice');
    res = (await comArquivo('sendAudio', 'audio', item.arquivo, {
      ...op, ...legenda, title: item.titulo, performer: item.autor || NOME,
    })).result;
  } else if (t === 'video') {
    await digitando('upload_video');
    res = (await comArquivo('sendVideo', 'video', item.arquivo, { ...op, ...legenda, supports_streaming: true })).result;
  } else if (t === 'local') {
    const j = await api('sendVenue', {
      ...op, chat_id: chat, latitude: Number(item.lat), longitude: Number(item.lon),
      title: String(item.titulo || ''), address: String(item.endereco || ''),
    });
    if (!j.ok) throw new Error('sendVenue: ' + JSON.stringify(j).slice(0, 160));
    res = j.result;
  } else if (t === 'contato') {
    const j = await api('sendContact', {
      ...op, chat_id: chat, phone_number: String(item.telefone || ''),
      first_name: String(item.nome || ''), last_name: item.sobrenome || '',
    });
    if (!j.ok) throw new Error('sendContact: ' + JSON.stringify(j).slice(0, 160));
    res = j.result;
  } else throw new Error('tipo desconhecido: ' + t);

  // Fixar substitui o que estava fixado: duas mensagens pregadas no topo viram duas
  // coisas para conferir, e ai nenhuma e A de hoje.
  if (item.fixar && res && res.message_id) {
    await api('unpinAllChatMessages', { chat_id: chat }).catch(() => {});
    await api('pinChatMessage', { chat_id: chat, message_id: res.message_id, disable_notification: true });
  }
  return res;
}

async function lacoSaida() {
  for (;;) {
    try {
      for (const f of fs.readdirSync(FILA).filter((x) => /\.(txt|json)$/.test(x)).sort()) {
        const bruto = fs.readFileSync(`${FILA}/${f}`, 'utf8').trim();
        fs.unlinkSync(`${FILA}/${f}`);
        if (!bruto) continue;

        if (f.endsWith('.json')) {
          let itens;
          try {
            const j = JSON.parse(bruto);
            itens = Array.isArray(j) ? j : [j];
          } catch (e) {
            // JSON quebrado nao pode calar a resposta: vai o texto que estava la.
            log('json invalido, mandando cru', e.message);
            await mandaTexto(bruto, { html: false });
            continue;
          }
          for (const item of itens) {
            try { await entrega(item); }
            catch (e) {
              log('envio falhou', JSON.stringify(item).slice(0, 120), '=>', e.message);
              await mandaTexto(`falhou o envio ${item.tipo || 'texto'}: ${e.message}`, { html: false });
              // Conteudo de texto ou voz nunca se perde por causa do formato.
              if (item.texto) await mandaTexto(item.texto, { html: false });
            }
          }
          log('entregue', f, itens.length, 'envios');
          continue;
        }

        if (f.endsWith('.voz.txt')) {
          try {
            const bytes = await fazVoz(bruto);
            log('entregue em voz', f, bruto.length, 'chars,', bytes, 'bytes');
            continue;
          } catch (e) {
            log('voz falhou, mandando texto', e.message);
            await diz('nao consegui gerar o audio (' + e.message.slice(0, 80) + '), vai escrito:');
          }
        }
        await mandaTexto(bruto, { markdown: true });
        log('entregue', f, bruto.length, 'chars');
      }
    } catch (e) { log('erro na fila de saida', e.message); }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function lacoDigitando() {
  for (;;) {
    try {
      const ate = Number(fs.readFileSync(TRABALHO, 'utf8'));
      if (Date.now() < ate) await digitando(); else marcaTrabalho(0);
    } catch {}
    await new Promise((r) => setTimeout(r, 4000));
  }
}
const fechaPergunta = (msgId, pergunta, resposta) => msgId && pergunta
  ? api('editMessageText', { chat_id: chat, message_id: msgId, text: `${pergunta}\n\u2500\u2500\u2500\n\u2713 ${resposta}` }).catch(() => {})
  : Promise.resolve();

// `linha` existe porque a caixa e o unico contexto que o agente retomado enxerga: a
// escolha sozinha ("Nubank | iFood") nao diz a que pergunta ela responde. O <id>.json
// continua guardando a resposta limpa.
function anota(resposta, id, pergunta, linha = null) {
  const quando = new Date().toISOString();
  fs.appendFileSync(RESP + '/caixa.tsv', [quando, id || '-', String(linha || resposta).replace(/\t|\n/g, ' ')].join('\t') + '\n');
  if (id) {
    fs.writeFileSync(`${RESP}/${id}.json`, JSON.stringify({ id, pergunta, resposta, quando }, null, 1));
    try { fs.unlinkSync(`${PEND}/${id}.json`); } catch {}
  }
  log('anotado', id || '(livre)', '=>', resposta);
}

// Callback de pergunta antiga: so o indice vem no data, as opcoes estao na pendencia.
function resolvePendente(id, i) {
  try {
    const p = JSON.parse(fs.readFileSync(`${PEND}/${id}.json`, 'utf8'));
    return { texto: p.pergunta, opcao: p.opcoes[Number(i)], msgId: p.msgId };
  } catch { return null; }
}

// ---------------------------------------------------------------- comandos
const N = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Comandos proprios entram por fora: CANAL_COMANDOS aponta um .cjs que recebe as
// ferramentas do daemon e devolve a lista e as acoes. O nucleo nao sabe o que e um
// curriculo nem uma cota de API -- isso e do projeto que usa o canal.
const extra = (() => {
  if (!process.env.CANAL_COMANDOS) return { comandos: [], acoes: {} };
  try {
    const feito = require(process.env.CANAL_COMANDOS)({
      api, diz, chat, token, log, digitando, marcaTrabalho, dentro, comArquivo, RESP,
    });
    return { comandos: feito.comandos || [], acoes: feito.acoes || {} };
  } catch (e) {
    log('CANAL_COMANDOS falhou, seguindo sem ele:', e.message);
    return { comandos: [], acoes: {} };
  }
})();

// Uma fonte so: o texto do /help e o menu nativo do Telegram saem daqui, senao
// um dos dois envelhece calado. O menu e o que faz o comando ser DESCOBERTO --
// com ele ele nao precisa lembrar que /help existe, basta digitar "/".
const COMANDOS = [
  ...extra.comandos,
  ['ajuda', 'esta lista', '/ajuda'],
];
const AJUDA = [
  ...COMANDOS.map(([, desc, ex]) => `${ex}\n   ${desc}`),
  '',
  'texto solto responde a ultima pergunta que eu te fiz.',
].join('\n');

// Devolve true quando era comando (e ja respondeu). Texto livre segue o fluxo normal.
async function comando(texto) {
  const m = texto.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
  if (!m) return false;
  const [, nome, args] = m;
  const tabela = {
    ...extra.acoes,
    ajuda: () => diz(AJUDA),
    // chamados pelo agente, nao por ele: ligam e desligam o "digitando" de fora
    _trabalhando: () => { marcaTrabalho(Number(args.trim()) || 180); },
    _parei: () => { marcaTrabalho(0); },
    start: () => diz(AJUDA),
    help: () => diz(AJUDA),
  };
  const fn = tabela[N(nome)];
  if (!fn) return false;
  await digitando();   // a propria resposta do comando e o recibo
  try { await fn(); } catch (e) { log('comando falhou', nome, e.message); await diz(`/${nome} falhou: ${e.message}`); }
  return true;
}
// -------------------------------------------------------------------------

// A enquete devolve as marcacoes dele por poll_answer, nao por mensagem: sem isso a
// escolha multipla seria so enfeite na tela.
async function tratarEnquete(pa) {
  const achado = fs.readdirSync(PEND).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(PEND + '/' + f, 'utf8')); } catch { return null; } })
    .find((x) => x && x.pollId === pa.poll_id);
  if (!achado) return;
  const escolhidas = (pa.option_ids || []).map((i) => achado.opcoes[i]).filter(Boolean);
  if (!escolhidas.length) return;                       // ele desmarcou tudo
  await api('stopPoll', { chat_id: chat, message_id: achado.msgId }).catch(() => {});
  const escolha = escolhidas.join(' | ');
  anota(escolha, achado.id, achado.pergunta,
    `na enquete "${String(achado.pergunta || '').slice(0, 120)}" ele marcou: ${escolha}`);
}

async function trata(u) {
  if (u.poll_answer) return tratarEnquete(u.poll_answer);
  const msg = u.message || (u.callback_query && u.callback_query.message);
  if (!msg || String(msg.chat.id) !== String(chat)) return;
  // Guarda a ultima mensagem DELE para "responder" e "reacao" terem onde se prender.
  if (u.message) { try { fs.writeFileSync(ULTIMA, String(u.message.message_id)); } catch {} }

  if (u.callback_query) {
    const [id, i] = String(u.callback_query.data).split(':');
    const p = resolvePendente(id, i);
    const r = p ? p.opcao : u.callback_query.data;
    await api('answerCallbackQuery', { callback_query_id: u.callback_query.id });
    if (p) await fechaPergunta(p.msgId, p.texto, r);
    anota(r, id, p && p.texto,
      p ? `na pergunta "${String(p.texto || '').slice(0, 120)}" ele escolheu: ${r}` : null);
    return;
  }
  if (!u.message) return;

  // Nao-texto vira linha na caixa com o caminho do arquivo: o Claude decide o que
  // fazer com ele, em vez de o daemon ter uma lista fechada de coisas que entende.
  let m = u.message;
  const anexo = m.document ? { id: m.document.file_id, nome: m.document.file_name, tipo: 'arquivo' }
    : m.photo ? { id: m.photo[m.photo.length - 1].file_id, nome: null, tipo: 'imagem' }
    : m.voice ? { id: m.voice.file_id, nome: null, tipo: 'audio' }
    : m.audio ? { id: m.audio.file_id, nome: m.audio.file_name, tipo: 'audio' }
    : m.video ? { id: m.video.file_id, nome: m.video.file_name, tipo: 'video' }
    : null;
  if (anexo) {
    try {
      const r = await baixar(anexo.id, anexo.nome);
      const legenda = (m.caption || '').trim();
      // Audio vira texto aqui e segue como se ele tivesse digitado: assim recado de
      // voz fecha pergunta pendente e chega ao Claude como qualquer frase. Claude nao
      // le som -- nem a API nem o Claude Code --, entao quem reconhece e o whisper.cpp
      // do container `transcreve`, na propria casa. Falhou, o arquivo fica anotado como
      // qualquer anexo e ninguem perde o recado.
      const fala = anexo.tipo === 'audio' ? await transcrever(`${ANEXOS}/${r.nome}`) : null;
      if (!fala) {
        anota(`[${anexo.tipo} em /entrada/_anexos/${r.nome}, ${Math.round(r.bytes / 1024)} KB]${legenda ? ' ' + legenda : ''}`, null, null);
        return;
      }
      log('audio transcrito', fala.length, 'chars');
      m = { ...m, text: legenda ? `${fala}\n${legenda}` : fala };
    } catch (e) {
      log('anexo falhou', e.message);
      await diz('nao consegui baixar esse arquivo: ' + e.message);
      return;
    }
  }

  if (!m.text) return;
  const texto = m.text.trim();
  if (await comando(texto)) return;

  // Texto livre fecha a pergunta pendente mais recente -- mas so enquanto ela esta
  // VIVA. Pendencia vencida (ou de um pergunta.cjs que morreu) e varrida daqui, senao
  // ela sequestra o teclado dele: tudo que ele digitasse viraria resposta de uma
  // pergunta que ninguem espera, e nunca chegaria ao Claude.
  const agora = Date.now();
  const abertas = fs.readdirSync(PEND).filter(f => f.endsWith('.json'))
    .map(f => {
      let p = null;
      try { p = JSON.parse(fs.readFileSync(PEND + '/' + f, 'utf8')); } catch {}
      return { f, p, t: fs.statSync(PEND + '/' + f).mtimeMs };
    })
    .filter(x => {
      const limite = x.p && (x.p.expira || (Date.parse(x.p.quando || 0) + 180 * 60000));
      if (limite && agora < limite) return true;
      try { fs.unlinkSync(PEND + '/' + x.f); log('pendencia vencida varrida', x.f); } catch {}
      return false;
    })
    .sort((a, b) => b.t - a.t);
  const alvo = abertas[0];
  if (alvo) {
    const p = alvo.p;
    await fechaPergunta(p.msgId, p.pergunta, texto);
    anota(texto, alvo.f.replace(/\.json$/, ''), p.pergunta);
  } else {
    // NAO ligar o "digitando" aqui: em 28/10/2026 ele perguntou do garimpo as 10:16,
    // viu 3 minutos de "digitando" e nunca veio resposta -- nenhuma sessao Claude
    // estava viva. O indicador so acende quando alguem REALMENTE pegou o trabalho,
    // via digitando.sh on. Prometer resposta que nao vem e pior que nao sinalizar.
    anota(texto, null, null);
  }
}

async function main() {
  await api('setMyCommands', { commands: COMANDOS.map(([command, description]) => ({ command, description })) })
    .then((j) => log('menu de comandos', j.ok ? 'registrado' : JSON.stringify(j).slice(0, 120)))
    .catch((e) => log('setMyCommands falhou', e.message));
  lacoDigitando();
  lacoSaida();
  log('escutando');
  for (;;) {
    try {
      const j = await api('getUpdates', { offset: lerOff() + 1, timeout: 50, allowed_updates: ['message', 'callback_query', 'poll_answer'] });
      if (!j.ok) { log('getUpdates nao-ok', JSON.stringify(j).slice(0, 200)); await new Promise(r => setTimeout(r, 5000)); continue; }
      const ups = j.result || [];
      if (ups.length) fs.writeFileSync(OFF, JSON.stringify({ offset: ups[ups.length - 1].update_id }), { mode: 0o600 });
      fs.writeFileSync(RESP + '/.daemon-vivo', new Date().toISOString());
      for (const u of ups) await trata(u);
    } catch (e) { log('erro', e.message); await new Promise(r => setTimeout(r, 5000)); }
  }
}
main();
