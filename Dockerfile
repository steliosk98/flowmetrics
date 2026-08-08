FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build:docker

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 flowmetrics && useradd --system --uid 10001 --gid flowmetrics --home-dir /app flowmetrics
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build --chown=flowmetrics:flowmetrics /src/apps/web/dist ./apps/web/dist
COPY --from=build --chown=flowmetrics:flowmetrics /src/public ./apps/web/dist
COPY --from=build --chown=flowmetrics:flowmetrics /src/server-dist ./server-dist
COPY --from=build --chown=flowmetrics:flowmetrics /src/migrations ./migrations
# Troubleshooting tool: `docker compose exec flowmetrics node scripts/ecoflow-probe.mjs`
# checks credentials from inside the container, where the .env already applies.
COPY --from=build --chown=flowmetrics:flowmetrics /src/scripts/ecoflow-probe.mjs ./scripts/
RUN mkdir -p /app/data && chown flowmetrics:flowmetrics /app/data
USER flowmetrics
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server-dist/index.js"]
