# Deploying GodownBook (Python) with Docker

Puts the app online at **https://godown.ajmalaji.tech**.

Two containers:

- **`app`**: FastAPI + uvicorn. Creates its tables on first start; the SQLite database lives on the `db-data` volume.
- **`caddy`**: answers on ports 80 and 443, gets and renews the HTTPS certificate from Let's Encrypt, and forwards traffic to `app`.

Files: `Dockerfile`, `docker-compose.yml`, `docker-compose.traefik.yml`, `docker/Caddyfile`, `docker/entrypoint.sh`, `.env.production.example`, `.dockerignore`.

> **Server already running Traefik?** (e.g. Hostinger's Docker VPS image.) Don't start Caddy; use
> `docker compose -f docker-compose.traefik.yml up -d --build`. Traefik finds the container through its labels
> (router `godownpy`, entrypoint `websecure`, resolver `letsencrypt`). Every other step is the same.

## 1. DNS

At the DNS provider for `ajmalaji.tech` add:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `godown` | your server's IPv4 address | Auto / 300 |

Check: `nslookup godown.ajmalaji.tech` must print the server's IP before you start Caddy.
(Cloudflare: use **DNS only**, grey cloud, for the first start so the certificate can be issued.)

## 2. Server

Any Linux VPS with a public IP (1 vCPU / 1 GB is enough).

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER        # log out and back in
sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp
```

## 3. Configure and start

```bash
git clone <your repo> && cd stock-register-python
cp .env.production.example .env.production
openssl rand -hex 32                 # paste the result as AUTH_SECRET in .env.production
docker compose up -d --build
docker compose logs -f app           # "Starting GodownBook on port 8000"
```

Open https://godown.ajmalaji.tech, sign up, and you have a 90-day Pro trial.
The container refuses to start if `AUTH_SECRET` is missing or shorter than 32 characters.

**Keep `AUTH_SECRET` stable**: changing it signs everyone out and invalidates invoice share links.

## 4. Dodo Payments (optional)

Without Dodo keys the app works; the Upgrade button just shows a message. To enable Lifetime Pro, fill
`DODO_PAYMENTS_API_KEY`, `DODO_PRODUCT_ID` and `DODO_WEBHOOK_SECRET` in `.env.production`, then in the Dodo dashboard
point the webhook at `https://godown.ajmalaji.tech/api/webhooks/dodo` (event `payment.succeeded`).
Restart with `docker compose up -d`.

## 5. Updates and backups

```bash
git pull && docker compose up -d --build        # update (the database volume is kept)

# backup (consistent copy of the SQLite file, safe while running)
docker compose exec app python -c "import sqlite3; s=sqlite3.connect('/data/godownbook.db'); d=sqlite3.connect('/data/backup.db'); s.backup(d)"
docker compose cp app:/data/backup.db ./backup-$(date +%F).db
```

Restore: stop the app, copy the file back to `/data/godownbook.db` in the `db-data` volume, start the app.

## 6. Moving from the TypeScript app

The Python app opens the TypeScript app's Prisma SQLite database unchanged (tested both ways). Copy its `.db` file into
the `db-data` volume as `godownbook.db`, keep the **same `AUTH_SECRET`** and existing logins, sessions and share links
keep working.

## 7. Behind Cloudflare's proxy (orange cloud)

Regional (PPP) pricing reads a country header. Cloudflare sends `CF-IPCountry`, so set
`PPP_COUNTRY_HEADER=CF-IPCountry` in `.env.production`, and restrict ports 80/443 to Cloudflare's IP ranges so visitors
can't bypass it and forge the header. Without a proxy that sets it, every visitor pays the base price.

## Troubleshooting

- **Certificate not issued**: DNS doesn't point at the server yet, or ports 80/443 are blocked.
- **`docker compose logs app`** shows startup errors; `docker compose ps` shows health.
- **Everyone is signed out after a deploy**: `AUTH_SECRET` changed.

## Password-reset email (SMTP)

"Forgot password?" emails a link (valid 1 hour, single use) built from `APP_URL`. Set in `.env.production`:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASSWORD=<Google App Password>
SMTP_FROM=you@gmail.com
```

Gmail needs an **App Password** (Google Account -> Security -> 2-Step Verification -> App passwords), not your normal password.
Without `SMTP_HOST` the link is written to the app log instead of being emailed.
