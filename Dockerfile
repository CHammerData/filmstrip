# syntax=docker/dockerfile:1

# Single-container Filmstrip: one Node process serves the React SPA and the /api backend.
# Three stages keep the runtime image free of build-only toolchains.

# --- Stage 1: build the React SPA (web/ is its own npm package) ---
FROM node:20-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build   # -> /web/dist

# --- Stage 2: install backend deps, generate the Prisma client, compile TS ---
FROM node:20-slim AS build
# openssl must be present when `prisma generate` runs so it detects the OpenSSL version and
# emits the matching query engine (openssl 3.x here). Without it Prisma falls back to the
# 1.1.x engine, which then fails to load against the openssl-3 runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build   # tsc -> /app/dist

# --- Stage 3: runtime ---
FROM node:20-slim AS runtime
# openssl is required by Prisma's query engine at runtime. curl is a fallback HTTP client for the
# Letterboxd scraper (src/scraper/http.ts): Cloudflare's bot-mitigation blocks Node's own HTTP
# stack (fetch and the core https module both 403) on some multi-page scrape URLs where curl,
# confirmed directly against the identical request, reliably succeeds -- a TLS/HTTP client
# fingerprint false-positive, not a real permission denial. ca-certificates is required for curl
# specifically -- node:20-slim doesn't ship it, and unlike curl, Node's own fetch/https work fine
# without it because Node bundles its own trusted root CAs internally. Confirmed by testing inside
# an actual built image: curl fails TLS setup entirely ("error setting certificate file") without
# this package, even though openssl alone is already present.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Version/commit are injected by the release workflow (--build-arg) and surfaced by /api/health and
# the startup log. They default empty so a plain `docker build` still works (version then falls back
# to package.json).
ARG FILMSTRIP_VERSION=""
ARG FILMSTRIP_COMMIT=""
ENV FILMSTRIP_VERSION=${FILMSTRIP_VERSION}
ENV FILMSTRIP_COMMIT=${FILMSTRIP_COMMIT}

LABEL org.opencontainers.image.title="Filmstrip" \
      org.opencontainers.image.description="Sync Letterboxd watchlists and lists into Radarr — multi-list, multi-user." \
      org.opencontainers.image.source="https://github.com/CHammerData/filmstrip" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=${FILMSTRIP_VERSION} \
      org.opencontainers.image.revision=${FILMSTRIP_COMMIT}

ENV NODE_ENV=production
# SQLite DB lives on a mounted volume so it survives container recreation.
ENV DATABASE_URL="file:/config/filmstrip.db"
ENV PORT=3000
# Run mode: gui (default) serves the SPA + /api; headless runs the scheduler + /api/health only.
ENV FILMSTRIP_MODE=gui

# node_modules from the build stage already has the generated Prisma client + the prisma CLI
# (used for `migrate deploy` at startup); dist is the compiled backend.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY prisma ./prisma
# createApp() resolves the SPA at ../../web/dist relative to dist/server, i.e. /app/web/dist.
COPY --from=web /web/dist ./web/dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply any pending migrations against the mounted DB, then boot the scheduler + API.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node dist/index.js"]
