// Comandos proprios do seu projeto, carregados pelo daemon quando CANAL_COMANDOS
// aponta para este arquivo. O nucleo nao sabe o que e um relatorio nem uma cota de
// API -- isso e seu.
//
//   CANAL_COMANDOS=/app/comandos.cjs node bin/escuta.cjs
//
// Recebe as ferramentas do daemon e devolve { comandos, acoes }:
//   comandos: [[nome, descricao, exemplo]]   -> vira /help e o menu nativo do Telegram
//   acoes:    { nome: (args) => ... }        -> o que roda quando ele digita
const fs = require('fs');

module.exports = ({ diz, digitando, comArquivo, log }) => ({
  comandos: [
    ['status', 'como esta o servico agora', '/status'],
    ['relatorio', 'manda o PDF do dia', '/relatorio'],
  ],
  acoes: {
    status: () => diz(`no ar desde ${fs.statSync('/proc/1').mtime.toISOString()}`),

    // Arquivo sai pelo mesmo caminho que o daemon usa: comArquivo respeita a pasta
    // permitida, entao um comando nao vira leitura livre do disco.
    relatorio: async () => {
      await digitando('upload_document');
      try {
        await comArquivo('sendDocument', 'document', '_envio/relatorio.pdf', {
          caption: 'relatório de hoje',
        });
      } catch (e) {
        log('relatorio falhou', e.message);
        await diz('não achei o relatório de hoje');
      }
    },
  },
});
