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

# ---------------------------------------------------------------------------
# Etapa 5 — worker de entrenamiento continuo (EN-037.4, Management #573)
# ---------------------------------------------------------------------------
# Imagen SEPARADA de `runtime` (#573 §6.1): el runtime HTTP de Combat nunca
# necesita PyTorch; mezclarlos infla la imagen que SI esta en el camino de
# peticion y amplia su superficie de seguridad sin necesidad. El worker de
# evaluacion automatica (`npm run evaluate:automatic`,
# `AutomaticModelEvaluationCoordinator`) NO necesita esta imagen: ejecuta el
# harness de #569 enteramente en Node/ONNX Runtime Node (`runAiEvaluation`
# corre en el MISMO proceso, nunca un subproceso Python) -- reutiliza
# directamente la imagen `runtime` de arriba (ver `compose/nodes/app.yml` de
# Nexus-Battle-Infrastructure, servicio `combat-evaluator`).
#
# `uv` se copia desde la imagen oficial de Astral (patron documentado por
# Astral para Docker, https://docs.astral.sh/uv/guides/integration/docker/)
# en vez de instalarse con pip/apt: fija la version EXACTA (0.9.17, la MISMA
# que usa `.github/workflows/ci.yml` para `ai/`) sin depender de que el
# repositorio apt de Debian Bookworm la tenga disponible. `uv` despues
# instala su PROPIO Python 3.13 (`python-build-standalone`, con builds
# linux/arm64 reales) en vez de confiar en el `python3` de sistema de
# `node:24-bookworm-slim` (Bookworm trae Python 3.11 por defecto, incompatible
# con `requires-python = ">=3.13"` de `ai/pyproject.toml`).
FROM node:24-bookworm-slim AS trainer

ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="nexus-battle-combat-trainer" \
      org.opencontainers.image.revision=${SOURCE_COMMIT}

COPY --from=ghcr.io/astral-sh/uv:0.9.17 /uv /uvx /usr/local/bin/

ENV NODE_ENV=production \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_LINK_MODE=copy

WORKDIR /app

# Mismo `dist`/`node_modules` que `runtime` (#573 §6.2): el worker ES el
# mismo codigo Node de Combat (`ContinuousTrainingPipeline.ts`,
# `continuous-training-worker.ts`), solo con Python anadido al lado -- nunca
# una reimplementacion.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# `ai/` explicitamente SOLO aqui (ver `.dockerignore`): `runtime` arriba
# nunca lo copia.
COPY --chown=node:node ai/pyproject.toml ai/uv.lock ai/README.md ./ai/
COPY --chown=node:node ai/src ./ai/src

# `UV_PYTHON_INSTALL_DIR` (`/opt/uv-python`) se crea y se cede a `node`
# ANTES de cambiar de usuario (#573 §6.4): `/opt` es de root por defecto y
# `node` no podria crear el subdirectorio por si mismo. `uv python install`
# ANTES de `uv sync --frozen`: fija el interprete real antes de resolver el
# entorno. `--no-dev`: sin pytest/ruff en la imagen de despliegue. El
# propietario del entorno Python queda en `node:node` (igual que el resto
# de la imagen: nunca root).
RUN mkdir -p /opt/uv-python && chown node:node /opt/uv-python
USER node
RUN cd /app/ai \
 && uv python install 3.13 \
 && uv sync --frozen --no-dev \
 && uv cache clean

WORKDIR /app

# Sin HEALTHCHECK HTTP (#573 §12.1): este worker no expone puerto ni API
# propia. La salud operacional se verifica por el estado del proceso y los
# eventos estructurados que ya emite (`continuous_training_worker_started`,
# `continuous_training_candidate_registered`, etc.), nunca por un endpoint
# nuevo inventado para esta Task.

CMD ["node", "dist/infrastructure/training/continuous-training-worker.js"]
