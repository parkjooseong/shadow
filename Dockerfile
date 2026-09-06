# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 SHADOW_PORT=8787 SHADOW_DB_PATH=/app/data/shadow.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node server ./server
# Node's built-in TypeScript stripping runs these shared backend modules directly.
COPY --chown=node:node src/domain ./src/domain
COPY --chown=node:node src/services/interchange.ts ./src/services/interchange.ts
COPY --chown=node:node scripts/backup.mjs ./scripts/backup.mjs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || process.env.SHADOW_PORT || '8787') + '/api/health', {signal: AbortSignal.timeout(3000)}); if (!r.ok || (await r.json()).status !== 'ok') process.exit(1);"]
CMD ["node", "server/index.mjs"]
