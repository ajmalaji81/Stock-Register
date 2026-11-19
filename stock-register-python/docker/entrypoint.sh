#!/bin/sh
# Container start: refuse to run without a real secret, then start the server.
# Tables are created on first start (SQLAlchemy create_all); existing data is never altered.
set -e

if [ -z "$AUTH_SECRET" ] || [ ${#AUTH_SECRET} -lt 32 ]; then
  echo "AUTH_SECRET must be set (32+ characters) in .env.production" >&2
  exit 1
fi

echo "Starting GodownBook on port ${PORT:-8000} (database: ${DATABASE_URL})"
# --proxy-headers: trust X-Forwarded-* from the reverse proxy in front (Caddy / Traefik only; the port is not published).
exec python -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" \
  --proxy-headers --forwarded-allow-ips="*" --no-server-header
