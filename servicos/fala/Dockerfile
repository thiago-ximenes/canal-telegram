# O caminho de volta do transcreve: texto entra, recado de voz sai. Existe porque
# ele pediu "manda em audio pra eu ir ouvindo" (28/10/2026) e o canal so sabia
# texto -- com baixa visao, ouvir e mais barato que ler 5.500 caracteres.
#
# A voz e a pt-BR-AntonioNeural da Microsoft, pelo mesmo edge-tts dos videos. A
# primeira versao usou a en-US-BrianMultilingualNeural (a voz dos videos, que ele
# escolheu em 18/09/2026): em portugues ela soou tao mal que ele achou que era TTS
# local e pediu "o da Microsoft, que e de graca e tem boa qualidade" (28/10/2026).
# Voz inglesa multilingue serve para video em ingles, nao para recado em portugues.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv ca-certificates \
 && python3 -m venv /opt/tts \
 && /opt/tts/bin/pip install --no-cache-dir edge-tts==7.3.1 \
 && rm -rf /var/lib/apt/lists/*
ENV PATH=/opt/tts/bin:$PATH
COPY servidor.cjs /app/servidor.cjs
USER node
CMD ["node", "/app/servidor.cjs"]
