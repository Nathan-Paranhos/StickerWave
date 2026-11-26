FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src

COPY apps/whatsapp-gateway/package.json apps/whatsapp-gateway/package-lock.json apps/whatsapp-gateway/tsconfig.json ./apps/whatsapp-gateway/

RUN npm --prefix packages/contracts install --no-audit --no-fund \
  && npm --prefix packages/contracts run build

WORKDIR /app/apps/whatsapp-gateway
RUN npm ci --no-audit --no-fund

COPY apps/whatsapp-gateway/src ./src
RUN npm run build \
  && mkdir -p /data/session \
  && chown -R node:node /app /data

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    DATA_DIR=/data \
    SESSION_DIR=/data/session \
    DB_PATH=/data/gateway.db

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
