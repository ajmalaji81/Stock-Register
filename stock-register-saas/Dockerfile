# GodownBook production image: Next.js standalone server + Prisma (SQLite on a volume).
# Build:  docker compose build      Run: docker compose up -d      (see DEPLOY.md)

FROM node:24-bookworm-slim AS base
# Prisma's query engine needs OpenSSL.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- dependencies (Prisma install scripts are pre-approved in package.json "allowScripts")
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---- build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ---- Prisma CLI on its own (with all its dependencies), used at container start for `db push`
FROM base AS prisma-cli
WORKDIR /cli
RUN echo '{"name":"prisma-cli","private":true,"allowScripts":{"prisma@6.19.3":true,"@prisma/engines@6.19.3":true}}' > package.json  && npm install --no-audit --no-fund prisma@6.19.3

# ---- runtime
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/data/godownbook.db
RUN groupadd --system app && useradd --system --gid app --home /app app \
 && mkdir -p /data && chown app:app /data

COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/prisma/schema.prisma ./prisma/schema.prisma
# Generated Prisma client + query engine for this platform (in case tracing missed them).
COPY --from=build --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
# Prisma CLI, used by the entrypoint to create / update the database schema on start.
COPY --from=prisma-cli --chown=app:app /cli/node_modules /opt/prisma-cli/node_modules
COPY --chown=app:app docker/entrypoint.sh ./entrypoint.sh

USER app
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["sh", "./entrypoint.sh"]
