# O canal vira imagem propria em vez de "node:24-alpine + volume com o codigo": assim a
# versao que esta no ar e a que foi buildada, e nao a que alguem editou no disco do host
# cinco minutos atras. Rebuild e explicito (docker compose build canal).
#
# As duas flags do CMD nao sao enfeite. A bridge do Docker pode nao rotear IPv6 enquanto o
# DNS devolve AAAA: o Happy Eyeballs do Node tenta IPv6, espera 250ms e aborta o fetch para
# a api.telegram.org. --dns-result-order sozinha nao basta (medido em 27/10/2026).
FROM node:24-alpine

# Nenhuma dependencia: o daemon usa so o que vem no Node (fetch, fs, http).
COPY --chmod=755 bin/ /app/

# Roda como root de proposito. CANAL_DIR e um volume do host (estado, anexos, respostas) e
# o dono desses arquivos varia por maquina; trocar para USER node quebra a escrita em
# diretorio que ja existe com outro dono. O container nao expoe porta e nao instala nada.
CMD ["node", "--dns-result-order=ipv4first", "--no-network-family-autoselection", "/app/escuta.cjs"]
