# syntax=docker/dockerfile:1

# Base glibc (node:24-bookworm-slim), NO node:24-alpine (EN-036.4, Management
# #568): spike real (no supuesto de memoria) con onnxruntime-node@1.30.0
# dentro de node:24-alpine fallo con evidencia exacta --
#   "Error loading shared library ld-linux-x86-64.so.2: No such file or
#   directory (needed by .../onnxruntime-node/bin/napi-v6/linux/x64/
#   libonnxruntime.so.1)"
# -- el binario nativo de ONNX Runtime esta compilado contra glibc; Alpine
# usa musl y no tiene `ld-linux-x86-64.so.2` en absoluto. El mismo spike
# contra node:24-bookworm-slim SI funciono (carga ~119 ms, inferencia
# [1,72]/[3,72] en 0-2 ms, score identico al host). Las CUATRO etapas usan
# la MISMA base glibc a proposito (#568 §106): copiar `node_modules` con un
# binario nativo compilado para una libc distinta de la del runtime final
# rompe el binding en silencio. Ver docs/en-036-neural-runtime.md para la
# evidencia completa y el tamano de imagen antes/despues.

# ---------------------------------------------------------------------------
# Etapa 1 — dependencias de compilacion
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Etapa 2 — compilacion con el Nest CLI
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN npm run build

# ---------------------------------------------------------------------------
# Etapa 3 — dependencias de produccion unicamente
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Etapa 4 — imagen final
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3006

WORKDIR /app

# La imagen base ya define el usuario sin privilegios `node` (uid 1000).
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

EXPOSE 3006

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3006)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
