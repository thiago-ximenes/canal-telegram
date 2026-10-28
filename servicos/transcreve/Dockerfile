# Transcritor de audio: ffmpeg converte, whisper.cpp reconhece. Roda no zezinho,
# entao a voz dele nunca sai da maquina -- e o custo por recado e zero.
#
# O modelo NAO entra na imagem: ele vem montado em /modelos, porque sao ~466 MB
# que nao deveriam ser rebaixados a cada rebuild.
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      git build-essential cmake ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp .
# Estatico de proposito: assim o binario atravessa para a imagem final sozinho,
# sem arrastar as .so do ggml.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build build -j --target whisper-cli

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY servidor.cjs /app/servidor.cjs
USER node
CMD ["node", "/app/servidor.cjs"]
