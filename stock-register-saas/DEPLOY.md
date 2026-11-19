# Deploying GodownBook with Docker

This puts GodownBook online at **https://godownbook.ajmalaji.tech**.

Two containers run it:

- **`app`**: the Next.js server. It creates or updates the SQLite database on every start, and the database lives on the `db-data` volume.
- **`caddy`**: answers on ports 80 and 443, gets and renews the HTTPS certificate from Let's Encrypt automatically, and forwards traffic to `app`.

Files: `Dockerfile`, `docker-compose.yml`, `docker/Caddyfile`, `docker/entrypoint.sh`, `.env.production.example`, `.dockerignore`.

---

> **Server already running Traefik?** (e.g. Hostinger's Docker VPS image, where Traefik owns ports 80/443 for n8n and other apps.)
> Don't start Caddy. Use `docker-compose.traefik.yml` instead: it has no Caddy and adds Traefik labels (router `godownbook`, entrypoint `websecure`, cert resolver `letsencrypt`, a middleware that strips the country header). Deploy from `/docker/godownbook`:
>
> ```bash
> docker compose -f docker-compose.traefik.yml up -d --build
> ```
>
> Every other step below (DNS, `.env.production`, backups) is the same; replace `docker compose` with `docker compose -f docker-compose.traefik.yml`. Traefik requests the certificate the first time someone visits the site after DNS points at the server.

---

## 1. What you need

- **A Linux server with a public IP address.** Any VPS works, for example DigitalOcean, Hetzner, AWS Lightsail or Oracle Cloud's free tier. 1 vCPU and 1 GB RAM is enough, and Ubuntu 22.04 or 24.04 is recommended.
  - A home PC behind a router won't work unless you forward ports 80 and 443 to it and your IP address is public.
- **DNS access for `ajmalaji.tech`**, wherever you bought the domain or manage its DNS.

## 2. Point the domain at the server

At your DNS provider, add this record:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `godownbook` | your server's IPv4 address | Auto / 300 |

Then check it from any computer. It must print the server's IP address before you start Caddy, otherwise Let's Encrypt can't issue the certificate:

```bash
nslookup godownbook.ajmalaji.tech
```

> Using Cloudflare? Set the record to **DNS only** (grey cloud) for the first start so Caddy can get its certificate. To use the Cloudflare proxy (orange cloud) afterwards, see section 7.

## 3. Install Docker on the server

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER      # then log out and back in
docker --version && docker compose version
```

If the server runs a firewall, open ports 80 and 443:

```bash
sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp
```

## 4. Copy the app to the server

Copy the `stock-register-saas/` folder, for example by pushing it to a private Git repository and cloning it on the server, or with `scp`:

```bash
# from your PC, in the "Stock Register" folder
scp -r stock-register-saas user@SERVER_IP:~/godownbook
```

Do **not** copy `node_modules`, `.next`, `.env` or `prisma/dev.db`. The image builds its own and starts with a fresh database. `.dockerignore` already excludes them from the image.

## 5. Configure

```bash
cd ~/godownbook
cp .env.production.example .env.production
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 2>/dev/null || openssl rand -hex 32
nano .env.production
```

Settings in `.env.production`:

- **`AUTH_SECRET`** (required): paste the generated value. Changing it later logs everyone out and breaks existing invoice share links.
- **`NEXT_PUBLIC_APP_URL`**: `https://godownbook.ajmalaji.tech`.
- **Dodo Payments**: fill these in when you're ready to take payments. Until then checkout shows an error, and everything else works.
  - `DODO_PAYMENTS_API_KEY`, `DODO_WEBHOOK_SECRET`, `DODO_PRODUCT_ID`
  - `DODO_PAYMENTS_ENVIRONMENT`: keep `test_mode` until you go live.

## 6. Start

```bash
docker compose up -d --build
docker compose logs -f          # wait for "Starting GodownBook" and Caddy's "certificate obtained successfully"
```

Open **https://godownbook.ajmalaji.tech**, create your account, and fill in **Settings** (business name, state and GSTIN).

**Dodo webhook:** in the Dodo dashboard, add the webhook URL `https://godownbook.ajmalaji.tech/api/webhooks/dodo` and subscribe it to `payment.succeeded`. Put its signing secret in `DODO_WEBHOOK_SECRET`, then run `docker compose up -d` again.

---

## Day-to-day

| Task | Command |
|---|---|
| See status | `docker compose ps` (app should show `healthy`) |
| Logs | `docker compose logs -f app` / `docker compose logs -f caddy` |
| Restart | `docker compose restart app` |
| Update to new code | copy the new files, then `docker compose up -d --build` |
| Stop | `docker compose down` (keeps the data volumes) |

**About updates:** the database schema is applied automatically when the container starts. If a schema change would delete data, the app container stops with a Prisma warning instead of deleting anything. Back up first, then decide.

### Backups (do this)

All data is one SQLite file on the `db-data` volume. Copy it out regularly:

```bash
mkdir -p ~/backups
docker compose exec app node -e "require('fs').copyFileSync('/data/godownbook.db','/data/backup.db')"
docker compose cp app:/data/backup.db ~/backups/godownbook-$(date +%F).db
```

To restore:

```bash
docker compose stop app
docker compose cp ~/backups/godownbook-YYYY-MM-DD.db app:/data/godownbook.db
docker compose start app
```

Keep copies off the server too, for example on your PC or cloud storage.

---

## 7. Country pricing (PPP) and Cloudflare

Lifetime Pro's country discount trusts a country header. Caddy **removes** any `X-Vercel-IPCountry` header a visitor sends, so with the default settings nobody can fake a cheaper country. As a result, **everyone pays the base price**.

To turn on real country pricing, put Cloudflare in front of the server:

1. Proxy the DNS record (orange cloud). Set SSL/TLS mode to **Full (strict)**.
2. In `.env.production`, set `PPP_COUNTRY_HEADER="cf-ipcountry"`.
3. Make sure only Cloudflare can reach the server. Otherwise someone could connect directly and send a fake `CF-IPCountry`. Firewall ports 80 and 443 so they accept only [Cloudflare's IP ranges](https://www.cloudflare.com/ips/), or add `request_header -CF-IPCountry` to the Caddyfile for traffic that doesn't come from Cloudflare.
4. Run `docker compose up -d`.

For the price to actually change at checkout, the Dodo product must be **Pay What You Want** (see the README).

---

## 8. Password reset emails (Gmail)

The **Forgot password?** link on the login page emails a one-time reset link. The link expires after 30 minutes. Gmail sends it through SMTP.

1. Turn on **2-Step Verification** for the Gmail account: https://myaccount.google.com/security
2. Create an **App Password** at https://myaccount.google.com/apppasswords and name it "GodownBook". Your normal Gmail password won't work.
3. Add these to `.env.production`:
   ```env
   SMTP_USER="yourname@gmail.com"
   SMTP_PASS="abcd efgh ijkl mnop"      # the 16-character App Password
   MAIL_FROM="GodownBook <yourname@gmail.com>"
   ```
4. Restart: `docker compose -f docker-compose.traefik.yml up -d` (or `docker compose up -d`).
5. Test it: use **Forgot password?** with your own email. If nothing arrives, check `docker compose logs app` for "Password reset email failed" and check your spam folder.

`NEXT_PUBLIC_APP_URL` must be your public https address, because the reset link is built from it. Gmail allows about 500 emails a day from a personal account.

## Troubleshooting

- **Caddy can't get a certificate.** DNS doesn't point at this server yet, ports 80/443 are closed, or Cloudflare's proxy is on. Check `docker compose logs caddy`.
- **The app container keeps restarting.** Run `docker compose logs app`. The usual cause is a missing or too-short `AUTH_SECRET`.
- **Login works but you're logged out immediately.** The site must be opened over **https**: session cookies are marked Secure in production.
- **Moving to Postgres later.** Change `provider` in `prisma/schema.prisma` to `postgresql`, set `DATABASE_URL` in `docker-compose.yml`, and rebuild. Existing SQLite data has to be migrated separately.
