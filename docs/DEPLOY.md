# Deploying

The app is one Node.js process with a web server, a background job loop and the WhatsApp webhook. Run **exactly one instance**. Messages from each person are kept in order in memory, so two instances could answer the same person twice. One instance handles a soft launch comfortably; scaling out needs a shared lock first.

## What you need

| Piece | Why | Examples |
| --- | --- | --- |
| A host that runs Node 22+ or Docker, with HTTPS | The app, the webhook Meta calls, the website, the business dashboard, the admin portal and the field app (GPS and offline mode need HTTPS) | Render, Railway, Fly.io, a VPS behind Caddy |
| Managed PostgreSQL 15+ with daily backups and point-in-time recovery | Everything except photos | Neon, Supabase, AWS RDS, DigitalOcean |
| S3-compatible bucket, private | Field agents' photos of businesses, and the photos owners add on the dashboard | Cloudflare R2, AWS S3, Backblaze B2 |
| Meta WhatsApp Business account with one number | Customers and businesses both message it | See [LAUNCH.md](LAUNCH.md) |
| Anthropic API key (optional) | Wording the local engine can't read (within `CLAUDE_DAILY_BUDGET_USD`) | console.anthropic.com |
| Chat webhook (optional) | Alerts | Slack, Discord or Google Chat incoming webhook |

Where the data lives matters for POTRAZ: every provider above stores or processes data outside Zimbabwe. Record each one (see [DATA_PROTECTION.md](DATA_PROTECTION.md)). Hosting in South Africa (for example AWS Cape Town, Azure South Africa North or Google Cloud Johannesburg) keeps latency low for customers in Zimbabwe.

## Settings

Copy `.env.example` and set at least:

```
NODE_ENV=production
DATABASE_URL=postgres://…
OPS_TOKEN=<long random string, for scripts and the first sign-in>
PUBLIC_BASE_URL=https://your-domain
WHATSAPP_TRANSPORT=cloud
WHATSAPP_ACCESS_TOKEN=…            # permanent system-user token
WHATSAPP_APP_SECRET=…
WHATSAPP_VERIFY_TOKEN=…
WHATSAPP_PHONE_NUMBER_ID=…         # our one number
WHATSAPP_NUMBER=263…
WHATSAPP_BUSINESS_ACCOUNT_ID=…     # for npm run templates
WHATSAPP_CATALOG_ID=…              # optional: our Meta catalog, for product cards
ANTHROPIC_API_KEY=…
STORAGE=s3
S3_BUCKET=… S3_ENDPOINT=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…
ALERT_WEBHOOK_URL=…
SEED_SAMPLE_DATA=false
```

The app refuses to start in production without `OPS_TOKEN`, `DATABASE_URL` and the WhatsApp settings.

## Run it

With Docker:

```bash
docker build -t findzim .
```

```bash
docker run --env-file .env -p 3000:3000 findzim
```

Without Docker: `npm ci`, `npm run build`, then `npm start`. The database schema is created and upgraded automatically at start-up.

Point your host's health check at `/ready` (it checks the database) and uptime monitoring at `/health`.

## First sign-in

Create the first admin account from the server:

```bash
node dist/ops/user-cli.js add --email you@example.com --name "Your Name" --role admin
```

It prints a password once. Sign in at `https://your-domain/admin`, then add the rest of the team under **Team accounts**. You can also sign in with the ops token under "Use the ops token instead". Everything done that way is recorded as "ops token", so keep it for scripts.

## Backups and restores

- Turn on your Postgres provider's daily backups and point-in-time recovery, and do a test restore before launch.
- Photos in the bucket aren't in the database backup. Copy the bucket somewhere else once a week (for example `rclone sync`), or enable versioning if your provider has it.
- An extra nightly dump you control:

  ```bash
  pg_dump --format=custom "$DATABASE_URL" > backup-$(date +%F).dump
  ```

  Upload the dump to a second bucket, keep 30 days, and encrypt it: it contains customer messages.

## Monitoring

- **Alerts** go to `ALERT_WEBHOOK_URL` (at most once every 30 minutes per kind) and to the logs. They cover:
  - WhatsApp or Claude rejecting their keys, or Claude billing problems
  - Claude spend reaching 80% and 100% of the daily budget
  - replies that still fail after retries
  - background jobs and incoming messages that keep failing
  - businesses paused by customer reports
- The **Health and costs** screen in the admin portal shows:
  - messages waiting to be handled
  - replies being retried or failed
  - due and failed jobs
  - when the last message arrived
  - which features are on
  - recent alerts
- **Logs** are JSON lines on stdout. Keep at least 14 days.

## How it copes with failures

- Every incoming message is saved before Meta gets its 200 reply. If saving fails, Meta retries delivery.
- A message left unhandled by a crash or restart is picked up again within a few minutes (up to 24 hours later). After three failed attempts it's dropped and the team is alerted.
- A reply WhatsApp rejects with a temporary error is retried up to three times over about 15 minutes.
- Background jobs (follow-ups, weekly summaries, clean-ups) live in the database and survive restarts.
