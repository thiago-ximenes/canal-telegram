// POST /falar  — corpo = o texto em utf8. Devolve os bytes de um OGG/Opus, que e
// o unico formato que o Telegram aceita como recado de voz (sendVoice).
//
// Sem `ports` no compose: so o daemon do Telegram alcanca. O mp3 do edge-tts e o
// ogg convertido passam por /tmp e morrem no fim da requisicao.
const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');

const VOZ = process.env.VOZ || 'pt-BR-AntonioNeural';
const LIMITE = 20000;              // ~20 min de fala; acima disso o pedido esta errado

function falar(texto) {
  const base = `/tmp/v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const txt = `${base}.txt`, mp3 = `${base}.mp3`, ogg = `${base}.ogg`;
  fs.writeFileSync(txt, texto);
  try {
    execFileSync('edge-tts', ['--voice', VOZ, '--file', txt, '--write-media', mp3],
      { timeout: 300000 });
    // -application voip e 32k: voz limpa num arquivo que cabe no Telegram sem corte.
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', mp3,
      '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1',
      '-application', 'voip', ogg], { timeout: 120000 });
    return fs.readFileSync(ogg);
  } finally {
    for (const f of [txt, mp3, ogg]) { try { fs.unlinkSync(f); } catch {} }
  }
}

http.createServer((req, res) => {
  const erro = (codigo, obj) => {
    res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/saude') return erro(200, { ok: true, voz: VOZ });
  if (req.method !== 'POST' || !req.url.startsWith('/falar')) return erro(404, { erro: 'rota' });

  const partes = [];
  let total = 0;
  req.on('data', (c) => {
    total += c.length;
    if (total > LIMITE * 4) { req.destroy(); return; }
    partes.push(c);
  });
  req.on('end', () => {
    const texto = Buffer.concat(partes).toString('utf8').trim();
    if (!texto) return erro(400, { erro: 'texto vazio' });
    const comecou = Date.now();
    try {
      const ogg = falar(texto.slice(0, LIMITE));
      console.log(new Date().toISOString(),
        `falou ${texto.length} chars em ${Math.round((Date.now() - comecou) / 1000)}s, ${ogg.length} bytes`);
      res.writeHead(200, { 'content-type': 'audio/ogg', 'content-length': ogg.length });
      res.end(ogg);
    } catch (e) {
      const motivo = String(e.stderr || e.message).slice(0, 300);
      console.log(new Date().toISOString(), 'falhou:', motivo);
      erro(500, { erro: motivo });
    }
  });
}).listen(8080, () => console.log(new Date().toISOString(), 'voz de plantao na 8080', VOZ));
