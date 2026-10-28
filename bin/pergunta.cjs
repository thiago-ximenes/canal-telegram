// Pergunta no Telegram com botoes e espera a resposta. Feito para rodar em BACKGROUND:
// quando ele responde, o processo sai e o Claude e chamado de volta com o resultado.
//
//   node pergunta.cjs <id> "<pergunta>" "Opcao A|Opcao B|Opcao C" [minutos]
//   node pergunta.cjs --le                       -> o que chegou desde a ultima leitura (nao bloqueia)
//
// Quem escuta o Telegram e o daemon bin/escuta.cjs, dono unico do getUpdates.
// Aqui so se envia a pergunta, grava a pendencia e espera o arquivo de resposta aparecer.
// Toda pergunta aceita texto livre tambem: basta ele digitar em vez de clicar.
const fs = require('fs'), os = require('os');
const DIR = process.env.CANAL_DIR || os.homedir() + '/.cache/canal-telegram';
const RESP = DIR + '/respostas', PEND = RESP + '/_pendentes';
const { token, chat } = process.env.TELEGRAM_TOKEN
  ? { token: process.env.TELEGRAM_TOKEN, chat: process.env.TELEGRAM_CHAT }
  : JSON.parse(fs.readFileSync(DIR + '/telegram.json', 'utf8'));
fs.mkdirSync(PEND, { recursive: true });

const api = (m, body) => fetch(`https://api.telegram.org/bot${token}/${m}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());
const espera = (ms) => new Promise(r => setTimeout(r, ms));

// --le: le a caixa que o daemon escreve, da ultima linha vista em diante.
function le() {
  const MARCA = RESP + '/.caixa-lida';
  let linhas = [];
  try { linhas = fs.readFileSync(RESP + '/caixa.tsv', 'utf8').split('\n').filter(Boolean); } catch {}
  let lidas = 0; try { lidas = Number(fs.readFileSync(MARCA, 'utf8').trim()) || 0; } catch {}
  const novas = linhas.slice(lidas);
  fs.writeFileSync(MARCA, String(linhas.length));
  console.log(novas.map(l => { const c = l.split('\t'); return `[${c[0]}] ${c[1]}: ${c[2]}`; }).join('\n') || '(nada novo)');
  if (!fs.existsSync(RESP + '/.daemon-vivo')) console.log('(aviso: o daemon telegram-escuta nao deu sinal de vida)');
}

async function main() {
  if (process.argv[2] === '--le') return le();

  const [id, texto, opcoesCru, min] = process.argv.slice(2);
  const opcoes = (opcoesCru || '').split('|').map(s => s.trim()).filter(Boolean);
  const minutos = Number(min || 180);
  const arq = `${RESP}/${id}.json`;
  try { fs.unlinkSync(arq); } catch {}

  const env = await api('sendMessage', {
    chat_id: chat, text: texto, disable_web_page_preview: true,
    reply_markup: opcoes.length ? { inline_keyboard: opcoes.map((o, i) => [{ text: o, callback_data: `${id}:${i}` }]) } : undefined,
  });
  const msgId = env.result && env.result.message_id;
  // `expira` existe para a pendencia nao sequestrar o teclado dele para sempre: o
  // daemon so trata texto livre como RESPOSTA enquanto a pergunta esta viva. Sem isso,
  // um pergunta.cjs morto no meio deixava o pendente orfao e tudo que ele digitasse
  // virava resposta de uma pergunta que ninguem mais esperava -- e nao chegava ao Claude.
  fs.writeFileSync(`${PEND}/${id}.json`, JSON.stringify({ id, pergunta: texto, opcoes, msgId, quando: new Date().toISOString(), expira: Date.now() + minutos * 60000 }, null, 1));

  const limite = Date.now() + minutos * 60000;
  while (Date.now() < limite) {
    await espera(1000);
    if (fs.existsSync(arq)) {
      console.log('RESPOSTA ' + id + ': ' + JSON.parse(fs.readFileSync(arq, 'utf8')).resposta);
      return;
    }
  }
  try { fs.unlinkSync(`${PEND}/${id}.json`); } catch {}
  console.log('SEM RESPOSTA ' + id + ' em ' + minutos + ' min');
}
main();
