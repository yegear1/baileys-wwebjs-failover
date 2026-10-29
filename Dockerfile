# syntax=docker/dockerfile:1.4

# ==============================================================================
# Stage 1: Build & Prune Dependencies
# ==============================================================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy package manifests and workspace configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./

# Install all dependencies (including devDependencies required for compilation)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY src/ ./src/

# Compile TypeScript
RUN pnpm build

# Prune devDependencies to keep production closure lean
RUN pnpm prune --prod

# ==============================================================================
# Stage 2: Minimal Production Runtime with Chromium
# ==============================================================================
FROM node:20-bookworm-slim AS runner

# Production environment invariants
ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    AUTH_DIR_BAILEYS=/data/auth/baileys \
    AUTH_DIR_WWEBJS=/data/auth/wwebjs

# Install Chromium, CJK/Emoji fonts, and dumb-init for zombie process management
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create segregated auth data directories with strict permissions
RUN mkdir -p /data/auth/baileys /data/auth/wwebjs /app && \
    chown -R node:node /data/auth /app && \
    chmod -R 0700 /data/auth

# Copy production node_modules, compiled dist, and package metadata
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

# Run as non-root user
USER node

# Healthcheck probing HTTP observability endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

EXPOSE 3000

# INVARIANT: dumb-init acts as PID 1 to handle signal forwarding and reap zombie Chromium renderer processes
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
