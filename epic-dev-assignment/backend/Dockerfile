# Express API gateway — multi-stage, non-root, migrate-then-serve.
# Build:  docker build -t focusflow-backend epic-dev-assignment/backend
# Wired by docker-compose.prod.yml (this is not meant to run standalone —
# it needs DATABASE_URL and the other env from Appendix A).

# ── deps stage: install production dependencies only ─────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --omit=dev: no test/build tooling in the runtime image.
RUN npm ci --omit=dev

# ── runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# node:alpine ships an unprivileged `node` user (uid 1000) — use it.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

# The entrypoint applies pending migrations, then starts the server. Migrations
# are idempotent (schema_migrations tracking table), so restarts are safe.
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3003

# Liveness: /api/health has no dependencies (readiness is /api/ready).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3003)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
