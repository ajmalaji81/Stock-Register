#!/bin/sh
# Container start: bring the SQLite schema up to date, then start the server.
# `db push` refuses changes that would lose data (no --accept-data-loss), so a risky
# schema change stops the container instead of silently dropping columns.
set -e

if [ -z "$AUTH_SECRET" ] || [ ${#AUTH_SECRET} -lt 32 ]; then
  echo "AUTH_SECRET must be set (32+ characters) in .env.production" >&2
  exit 1
fi

echo "Applying database schema to ${DATABASE_URL}"
node /opt/prisma-cli/node_modules/prisma/build/index.js db push --skip-generate --schema prisma/schema.prisma

echo "Starting GodownBook on ${HOSTNAME}:${PORT}"
exec node server.js
