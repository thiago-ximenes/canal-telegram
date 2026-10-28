// Transforma dado em imagem legivel para o Telegram -- o jeito de nunca mais mandar
// tabela em texto corrido. O visual e fixo de proposito: fundo escuro, fonte 22px,
// linha alta, contraste alto. Ele le no celular, com baixa visao; cada cartao
// improvisado com CSS novo sai de um tamanho e o olho tem de se reajustar.
//
//   node cartao.cjs ficha.json /entrada/_envio/funil.png
//   node cartao.cjs ficha.json /entrada/_envio/funil.pdf     (PDF, para guardar)
//   cat ficha.json | node cartao.cjs - /entrada/_envio/x.png
//
// ficha.json:
//   { "titulo": "Funil por canal", "sub": "medido em 22/10", "nota": "...",
//     "tipo": "barras",  "itens":   [ { "rotulo": "Indicacao", "valor": "100%", "n": 100 } ] }
//   { "tipo": "tabela",  "colunas": ["Empresa", "Etapa", "Quando"],
//                        "linhas":  [ ["Pedido 41", "pago", "10/11"] ] }
//   { "tipo": "passos",  "itens":   [ { "rotulo": "Responder", "detalhe": "ate sexta" } ] }
//   { "tipo": "fichas",  "colunas": [...], "linhas": [...] }   <- tabela larga demais
const fs = require('fs');

const ficha = JSON.parse(process.argv[2] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(process.argv[2], 'utf8'));
const destino = process.argv[3];
if (!destino) { console.error('uso: node cartao.cjs ficha.json saida.png'); process.exit(2); }

const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Mais de tres colunas nao cabem em 900px sem a celula quebrar em tres linhas -- foi
// exatamente a tabela apertada que ele reprovou duas vezes. Vira ficha, uma por linha.
const tipo = ficha.tipo === 'tabela' && (ficha.colunas || []).length > 3 ? 'fichas' : (ficha.tipo || 'tabela');

function barras(itens) {
  const maior = Math.max(...itens.map((i) => Number(i.n) || 0), 1);
  return `<table>${itens.map((i) => `<tr>
    <td class="rot">${esc(i.rotulo)}</td>
    <td class="num">${esc(i.valor)}</td>
    <td><span class="barra" style="width:${Math.round((Number(i.n) || 0) / maior * 420)}px"></span></td>
  </tr>`).join('')}</table>`;
}

function tabela(colunas, linhas) {
  return `<table>
    <tr>${colunas.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
    ${linhas.map((l) => `<tr>${l.map((c, i) => `<td class="${i === 0 ? 'rot' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}
  </table>`;
}

function fichas(colunas, linhas) {
  return linhas.map((l) => `<div class="ficha">
    <div class="ficha-t">${esc(l[0])}</div>
    ${l.slice(1).map((c, i) => `<div class="par"><span class="chave">${esc(colunas[i + 1])}</span>${esc(c)}</div>`).join('')}
  </div>`).join('');
}

function passos(itens) {
  return itens.map((p, i) => `<div class="passo">
    <div class="bolha">${i + 1}</div>
    <div><div class="passo-t">${esc(p.rotulo)}</div>${p.detalhe ? `<div class="passo-d">${esc(p.detalhe)}</div>` : ''}</div>
  </div>`).join('');
}

const corpo = tipo === 'barras' ? barras(ficha.itens || [])
  : tipo === 'passos' ? passos(ficha.itens || [])
  : tipo === 'fichas' ? fichas(ficha.colunas || [], ficha.linhas || [])
  : tabela(ficha.colunas || [], ficha.linhas || []);

const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><style>
  body{background:#12151a;color:#f2f4f7;margin:0;padding:34px 38px;width:900px;
       box-sizing:border-box;font:400 22px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif}
  h1{font-size:30px;font-weight:700;margin:0 0 6px;letter-spacing:-.2px}
  .sub{color:#aab4c2;font-size:19px;margin:0 0 26px}
  table{border-collapse:collapse;width:100%}
  th{text-align:left;font-size:18px;color:#aab4c2;font-weight:600;padding:0 14px 10px 0;
     border-bottom:2px solid #2c333d}
  td{padding:14px 14px 14px 0;border-bottom:1px solid #222831;vertical-align:top}
  td.rot{font-weight:700}
  td.num{text-align:right;font-weight:700;width:110px;font-variant-numeric:tabular-nums;
         padding-right:0}
  .barra{display:inline-block;height:20px;margin-left:18px;background:#5aa9ff;border-radius:3px;
         vertical-align:middle}
  .ficha{border-left:4px solid #5aa9ff;padding:4px 0 4px 18px;margin:0 0 22px}
  .ficha-t{font-weight:700;font-size:24px;margin-bottom:6px}
  .par{color:#dfe5ec}
  .chave{color:#aab4c2;font-size:19px;display:inline-block;min-width:150px}
  .passo{display:flex;gap:18px;align-items:flex-start;margin:0 0 22px}
  .bolha{flex:0 0 40px;height:40px;border-radius:50%;background:#5aa9ff;color:#0b0e13;
         font-weight:700;display:flex;align-items:center;justify-content:center}
  .passo-t{font-weight:700}
  .passo-d{color:#aab4c2;font-size:20px}
  .nota{margin-top:26px;color:#aab4c2;font-size:19px}
</style>
${ficha.titulo ? `<h1>${esc(ficha.titulo)}</h1>` : ''}
${ficha.sub ? `<p class="sub">${esc(ficha.sub)}</p>` : ''}
${corpo}
${ficha.nota ? `<p class="nota">${esc(ficha.nota)}</p>` : ''}
</html>`;

const fonte = destino.replace(/\.(png|pdf)$/i, '') + '.html';
fs.writeFileSync(fonte, html);

// fullPage: a altura sai do conteudo. Com --window-size do Chrome cru, cartao de 7 linhas
// e de 3 linhas saem do mesmo tamanho e sobra tarja preta embaixo.
(async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MOD || 'playwright');
  const navegador = await chromium.launch();                       // headless, sempre
  // Viewport baixa de proposito: fullPage nunca encolhe abaixo dela, e cartao de 3 linhas
  // com janela de 600px sai com um terco de tarja preta embaixo.
  const pagina = await navegador.newPage({ viewport: { width: 900, height: 200 }, deviceScaleFactor: 2 });
  await pagina.goto('file://' + require('path').resolve(fonte));
  if (/\.pdf$/i.test(destino)) {
    const alturaPx = await pagina.evaluate(() => document.documentElement.scrollHeight);
    await pagina.pdf({ path: destino, printBackground: true, width: '900px', height: `${alturaPx + 2}px` });
  } else {
    await pagina.screenshot({ path: destino, fullPage: true });
  }
  await navegador.close();
  console.log(destino, fs.statSync(destino).size, 'bytes');
})().catch((e) => { console.error('cartao falhou:', e.message); process.exit(1); });
