// POST /transcrever  — corpo = os bytes do audio, cabecalho x-ext diz a extensao.
// Devolve {"texto": "..."} ou {"erro": "..."}.
//
// So existe dentro da rede do Docker (sem `ports` no compose), entao quem alcanca
// e o daemon do Telegram e o agente. O audio passa por /tmp e e apagado no fim --
// a copia que fica e a do _anexos, que foi quem baixou.
const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');

const MODELO = process.env.MODELO || '/modelos/ggml-small.bin';
const IDIOMA = process.env.IDIOMA || 'pt';
const THREADS = process.env.THREADS || '4';
// Vocabulario da casa: sem isto o reconhecedor escreve "tech led" e "atis". O whisper
// usa esta frase como contexto anterior, entao os nomes proprios do seu dia a dia
// passam a existir para o modelo. Ponha os seus em VOCABULARIO.
const VOCABULARIO = process.env.VOCABULARIO ||
  'Node, TypeScript, Postgres, Docker, Kubernetes, deploy, pull request, backlog.';
const LIMITE = 25 * 1024 * 1024;   // recado de Telegram nao chega perto disso

function transcrever(bruto, ext) {
  const base = `/tmp/a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entrada = `${base}${ext}`, wav = `${base}.wav`;
  fs.writeFileSync(entrada, bruto);
  try {
    // 16 kHz mono PCM: o unico formato que o whisper.cpp le.
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', entrada,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { timeout: 120000 });
    // -nt tira o carimbo de tempo e -np os logs, entao o stdout ja e a fala.
    return execFileSync('whisper-cli', ['-m', MODELO, '-f', wav, '-l', IDIOMA,
      '-t', THREADS, '-nt', '-np', '--prompt', VOCABULARIO],
      { encoding: 'utf8', timeout: 900000 }).trim();
  } finally {
    for (const f of [entrada, wav]) { try { fs.unlinkSync(f); } catch {} }
  }
}

http.createServer((req, res) => {
  const responde = (codigo, obj) => {
    res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/saude') return responde(200, { ok: fs.existsSync(MODELO) });
  if (req.method !== 'POST' || !req.url.startsWith('/transcrever')) return responde(404, { erro: 'rota' });

  const partes = [];
  let total = 0;
  req.on('data', (c) => {
    total += c.length;
    if (total > LIMITE) { req.destroy(); return; }
    partes.push(c);
  });
  req.on('error', () => responde(413, { erro: `audio acima de ${LIMITE} bytes` }));
  req.on('end', () => {
    const ext = (String(req.headers['x-ext'] || '.oga').match(/^\.[a-z0-9]{1,5}$/i) || ['.oga'])[0];
    const comecou = Date.now();
    try {
      const texto = transcrever(Buffer.concat(partes), ext);
      console.log(new Date().toISOString(), `transcrito em ${Math.round((Date.now() - comecou) / 1000)}s, ${texto.length} chars`);
      responde(200, { texto, segundos: Math.round((Date.now() - comecou) / 1000) });
    } catch (e) {
      const motivo = String(e.stderr || e.message).slice(0, 300);
      console.log(new Date().toISOString(), 'falhou:', motivo);
      responde(500, { erro: motivo });
    }
  });
}).listen(8080, () => console.log(new Date().toISOString(), 'transcritor de plantao na 8080'));
