# WhatsApp Directory (working name: Directory ZW)

One WhatsApp number where people in Zimbabwe ask for anything they want to buy or hire, by typing, sending a voice note or sending a photo. The service replies with local businesses that can help, verified ones first, and connects the customer to them directly. When nobody lists exactly what they want, it offers suppliers in related categories; when there's nothing at all, a person from the team takes over. It is free for customers and businesses at launch. Businesses self-register on a second WhatsApp number or are registered by field teams, and they can send a photo of their price list so customers see what they sell.

## Run it locally

Requires Node.js 22 or newer.

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run dev
```

Open http://localhost:3000/simulator. It shows a customer chat and a business chat side by side. No Meta account or API key is needed: messages stay on your computer, the database is embedded Postgres (PGlite) stored in `.data/`, and requests are understood by the local engine (Claude only helps with wording it can't read, when `ANTHROPIC_API_KEY` is set). Sample businesses are fictional and marked "(sample)".

Things to try:

1. **Customer:** type `I need a plumber in Mabelreign`, tap **I agree**, open **See options**, pick one, tap **Connect me**.
2. **Business pane:** switch to the business you picked to see its lead notification with the same reference code.
3. **Run follow-ups now** (top right) sends the follow-up that normally goes out 72 hours later.
4. **Business pane, new number:** type `register` and list a business.
5. **Customer:** `I need a wedding venue in Avondale`. No venue is listed, so it offers the events businesses nearby. Then try `I need a lawyer in Avondale`: nothing fits, so the chat goes straight to a person (see **Handoffs** in the ops console).
6. **Customer, voice note:** tap 🎙️ and type what the voice note says, for example `ndoda plumber ku Mabelreign`. The simulator stands in for speech-to-text.
7. **Customer:** type `recommend` and describe a business you know. It appears under **Tips** in the ops console.

With `ANTHROPIC_API_KEY` set you can also:

8. **Customer, photo:** tap 📷 to send a photo of something you want. Type a caption first if you like, such as `like this in Glen View`.
9. **Business pane:** switch to Siyaso Hardware, type `menu`, choose **Add price list photo** and send a photo of a price list. Then search as a customer for `cement in Mbare` and open Siyaso to see the matching prices.
10. **Customer:** write something the local engine doesn't know, such as `ndoda keke remuchato ku Avondale`. Claude works it out once, and the next person who writes it is answered from the phrasebook, without Claude. The **System** screen shows how requests were understood and what Claude cost today.

The ops console is at http://localhost:3000/ops. Locally it's open until the first account exists; after that everyone signs in (see [Ops console accounts](#ops-console-accounts)). To try the field app, go to **Agents** in the ops console, add an agent and open the setup link it gives you. On a phone on the same network, use `PUBLIC_BASE_URL` with this computer's address, because GPS and offline mode need a secure page, so over a network the app needs HTTPS. Only localhost works without it.

## How it works

| Folder | What it does |
| --- | --- |
| `src/whatsapp` | Webhook signature checks and parsing, message builders that enforce WhatsApp's limits, two transports (Meta's Cloud API and the local simulator), and downloads of the photos and voice notes people send |
| `src/conversation` | The engine (messages from one person handled in order, duplicates ignored), the customer and business flows, and the messenger, which switches to approved templates once the 24-hour window has closed |
| `src/ai` | Understanding requests: the local engine with its confidence bands, the phrasebook, Claude for wording the engine can't read (within a daily budget), photo reading, speech-to-text |
| `src/directory` | Category taxonomy (with related categories), place names, search and ranking, businesses, price-list items, customer recommendations, introductions with reference codes |
| `src/field` | Field agents (setup links), in-person registration with duplicate checks, call-back audits |
| `src/jobs` | A job queue stored in Postgres: follow-ups, weekly summaries, resending failed replies, the daily clean-ups, reading field price-list photos |
| `src/http` | Fastify server: WhatsApp webhook, health checks, simulator, ops API (with sign-in), field API, static pages |
| `src/ops` | Ops console accounts, sessions and the activity log |
| `src/privacy.ts` | Export and deletion on request, and the retention clean-up |
| `src/eval` | Measuring how well requests are understood, against labelled examples in `evals/` |
| `src/db` | Embedded PGlite or Postgres, SQL migrations, seed data (categories, areas, sample businesses) |
| `public/field` | The field app: works offline, captures GPS and photos, and queues registrations until there's signal |
| `public/ops` | The ops console |

Rules the code enforces:

- **The AI interprets; the database decides.** Claude only turns text into structured fields. Businesses, prices and results always come from the database.
- **Verified first.** Unverified businesses appear only when fewer than `MIN_VERIFIED_RESULTS` verified ones match, and always with a deposit warning. High-scam categories (rentals, cars, visas) show verified businesses only. Blocked and restricted categories are never searchable.
- **The customer contacts the business.** "Connect me" opens a WhatsApp chat with the message typed, including a reference code. Customer numbers are never passed to businesses.
- **Opt-in first.** Customers agree to the privacy notice before their first search; businesses agree to the listing terms when they register.
- **No ID copies.** Field agents tick that they checked the owner's ID or registration; the app never accepts a photo of one. Verified means an agent saw the premises and checked ID.
- **Our suppliers, then people.** A request is answered from suppliers in its category. When none are nearby, the customer gets suppliers in related categories: a gadget nobody lists goes to the electronics shops. Related categories are a deliberate list in `src/db/seed-data/categories.ts`, and trades and professional services aren't cross-referred. When nothing fits, a person takes over straight away. Both kinds show up in supply gaps for the field team.
- **Local first.** Greetings, help, "agent", blocked items and clear requests are understood without Claude. Claude is asked only about wording the local engine can't read, and only within the daily budget. Its answers are remembered, so the same wording never costs twice. What nobody understands after one "please say it differently" goes to a person.
- **Photos and voice notes only after consent.** A customer's photo or voice note is processed only once they've agreed to the privacy notice, and isn't stored. Only the transcript or a short description is saved with the message. Price-list photos that owners send are kept with their listing.
- **Nothing is lost.** Every incoming message is saved before WhatsApp is told it arrived. Anything a crash leaves unhandled is picked up again. Replies that fail for a temporary reason are resent.
- **Limits per number.** Floods of messages, photos, voice notes or reports from one number are cut off politely. A listing is paused automatically only after several customers who contacted it report it.
- **People can leave.** "delete my data" on either number deletes everything about that person (and an owner's listings) once they confirm. Old chats are cleaned up on a schedule.

## Claude

Claude is the backup, not the first reader. The design and its reasoning are in [docs/UNDERSTANDING.md](docs/UNDERSTANDING.md).

- **When it's used:**
  - wording the local engine isn't confident about, and hasn't seen before
  - customers' photos
  - price-list photos
- **How:**
  - the model is set by `CLAUDE_MODEL`, default `claude-sonnet-5`
  - thinking is off and effort low
  - the instructions and category list are cached
  - the local engine's notes (possible categories, unknown words, place) go with the message
  - server-side refusal fallbacks are on (`fallbacks: "default"`)
  - any failure returns to the local reading, so the chat never stalls
- **Budget:**
  - `CLAUDE_DAILY_BUDGET_USD` (default $5) stops Claude calls for the rest of the day in Harare, and the team is alerted at 80% and 100%.
  - `CLAUDE_CALLS_PER_NUMBER_PER_DAY` (default 5) caps what one number can cause.
  - Every call's cost is recorded, and the **System** screen shows today's spend and how requests were understood.
- **Business sign-up never uses Claude:** the local engine reads the description, and when it can't, the owner picks the category from a list.
- **Photos:** a customer's "find me this" photo becomes a request. An owner's price-list photo becomes items and prices, and the owner confirms before anything is saved. Price-list photos field agents take are read in the background, and wait for the next day when the budget is spent.

Measure before changing models: `npm run eval -- --claude --model …` compares models on labelled requests. Plain `npm run eval` shows how many requests the local engine answers on its own, and whether any of those confident answers were wrong.

## Voice notes

Voice notes need a speech-to-text service. Whisper handles Shona poorly. Two options are built in:

- **Google Chirp 2** (set `GOOGLE_STT_PROJECT` and a service-account key).
  - Chirp 2 transcribes Shona (`sn-ZW`) from the `europe-west4` and `asia-southeast1` regions.
  - Ndebele isn't supported, so Zulu (`zu-ZA`), a close relative, stands in for it.
  - Languages are tried in order until one hears something, starting with the language of the person's last request.
  - Voice notes up to a minute are supported.
- **Any other engine** (for example Meta's Omnilingual ASR) behind a small HTTP contract:
  - `POST $SPEECH_TO_TEXT_URL` with the audio as the body, its `Content-Type` (usually `audio/ogg`), `X-Language-Hints: sn,nd,en` (the last request's language first) and `Authorization: Bearer $SPEECH_TO_TEXT_TOKEN`.
  - The service answers `{ "text": "…", "language": "sn" }`, with an empty `text` when nothing intelligible was said.

The reply starts with "🎙️ I heard: …" so a wrong transcript is easy to spot. That line goes at the top of the answer rather than in a separate message, because WhatsApp starts charging for replies inside the 24-hour window on 1 October 2026. When the service can't make anything out, the customer is asked to type instead. With neither option set, the simulator fakes transcription and the live number asks people to type.

## Going live

Step by step in [docs/LAUNCH.md](docs/LAUNCH.md); hosting, backups and monitoring in [docs/DEPLOY.md](docs/DEPLOY.md); personal data in [docs/DATA_PROTECTION.md](docs/DATA_PROTECTION.md). In short:

1. Create a Meta Business portfolio and complete business verification. Unverified accounts can start only about 250 conversations a day.
2. Add two numbers to the WhatsApp Cloud API, one for customers and one for businesses. Note both phone number IDs, and create a permanent access token for a system user.
3. Point the webhook at `https://<your-domain>/webhook/whatsapp` with your verify token, subscribe to `messages`, and set the app secret.
4. Submit these utility templates with `npm run templates -- --create` (set `WHATSAPP_BUSINESS_ACCOUNT_ID`), then run `npm run templates` until they're approved. Button payloads are filled in by the app. The definitions live in `src/whatsapp/templates.ts`.

   | Name | Body | Buttons (quick reply) |
   | --- | --- | --- |
   | `lead_notification` | New customer (ref {{1}}) is looking for: {{2}}. They'll message you on WhatsApp shortly. | none |
   | `follow_up` | Did you get what you needed from {{1}}? | Yes, sorted · Not yet · They didn't reply |
   | `weekly_summary` | Your week: {{1}} was shown in {{2}} searches and {{3}} customers connected with you. | none |

5. Set the following, then deploy with the `Dockerfile` or anywhere that runs Node:
   - `WHATSAPP_TRANSPORT=cloud`, plus the WhatsApp variables in `.env.example`
   - `DATABASE_URL` pointing at Postgres (required in production)
   - `OPS_TOKEN`
   - `PUBLIC_BASE_URL`: your HTTPS address, used in agents' setup links
   - `STORAGE=s3` with the `S3_*` settings (or `UPLOADS_DIR` on a disk that survives redeploys)
   - `ANTHROPIC_API_KEY` for Claude (wording the local engine can't read, and photos) with `CLAUDE_DAILY_BUDGET_USD`, and `GOOGLE_STT_PROJECT` or `SPEECH_TO_TEXT_URL` for voice notes
   - `ALERT_WEBHOOK_URL` for alerts
   - `SEED_SAMPLE_DATA=false`
   - `NODE_ENV=production`

   Run `npm run build`, then `npm start`. Health checks: `/health` (the process is up) and `/ready` (it can reach the database).
6. Create the first admin with `node dist/ops/user-cli.js add --email … --name … --role admin`.

## Ops console accounts

Everyone on the team signs in with their own account, so the **Activity** screen shows who did what.

- **Staff** handle chats, reports, verification, call-backs, listings, tips and vocabulary, and can block a number.
- **Admins** can also manage field agents, the team, and people's data: export and delete.

Create accounts under **Team**, or with `npm run ops:user -- add --email … --name … --role admin|staff`, which prints a one-time password. Five wrong passwords lock an email for 15 minutes. `OPS_TOKEN` works as an admin for scripts and the first sign-in. In development, with no `OPS_TOKEN` and no accounts yet, the console is open.

## Ops API

The ops console at `/ops` is built on these JSON endpoints. They live under `/ops/api` and need `Authorization: Bearer <session token or OPS_TOKEN>`. Endpoints marked (admin) refuse staff.

| Endpoint | Purpose |
| --- | --- |
| `POST /login`, `POST /logout`, `GET /me`, `POST /me/password` | Sign in (`{ "email", "password" }` gives a session token), sign out, who am I, change my password |
| `GET /users`, `POST /users`, `POST /users/:id` (admin) | The team; add someone (a password is generated when none is given); change role, switch off or on, new password |
| `GET /activity` (admin) | Who did what, newest first |
| `GET /contacts?phone=` | Find people on either number |
| `POST /contacts/:id/block` | Block or unblock a number (`{ "blocked": true, "reason": "…" }`) |
| `GET /contacts/:id/export`, `POST /contacts/:id/erase` (admin) | A person's data as JSON; delete it |
| `POST /businesses/:id/erase` (admin) | Delete a listing completely, with photos and price list |
| `GET /system` | Queues, failed sends, what's switched on, Claude spend today and this week, how requests were understood and matched, recent alerts |
| `GET /summary` | Businesses, requests, introductions, open handoffs, reports, active agents |
| `GET /requests?status=no_results` | Recent requests, filterable by status |
| `GET /supply-gaps?days=7` | Requests no supplier in their category could answer (given related suppliers, or handed to a person), grouped by category and area: where field teams go next |
| `GET /handoffs` | Chats waiting for a person, with recent messages |
| `POST /contacts/:id/reply` | Reply to a customer as the team (`{ "text": "…" }`) |
| `POST /contacts/:id/release` | Hand the chat back to the assistant |
| `GET /reports`, `POST /reports/:id/status` | Open reports about businesses; mark `reviewed` or `actioned` |
| `GET /businesses?q=&verification=`, `GET /businesses/:id` | Browse and inspect listings, with photos, checks and call-backs |
| `GET /photos/:id` | A field photo |
| `POST /businesses` | Manual registration (`name`, `phone`, `categories`, `area` or `lat`/`lng`, `consent: true`, `verified`) |
| `POST /businesses/:id/verify`, `POST /businesses/:id/status` | Mark verified (recorded under your name); set `active`, `paused` or (admin) `removed` |
| `GET /verification-queue` | Self-registered businesses waiting for a field visit |
| `GET /agents`, `POST /agents` (admin) | Agents with quality stats; add one and get its setup link |
| `POST /agents/:id/token`, `POST /agents/:id/active` (admin) | New setup link (the old one stops working); deactivate or reactivate |
| `GET /audits/queue?percent=10`, `POST /businesses/:id/audit` | Call-back sample per agent; record `confirmed`, `details_wrong`, `wrong_number`, `not_a_business` or `refused` (the last three count as failures; a wrong number or "not a business" also hides the listing) |
| `GET /recommendations?status=new`, `POST /recommendations/:id/status` | Customers' tips about businesses to list; mark `contacted`, `listed` or `rejected` |
| `GET /unmatched?days=30` | Searches that matched no category, grouped by what people typed |
| `GET /categories`, `POST /categories/:slug/synonyms` | Categories with their words; add or remove words (`{ "add": ["kombi"] }`), effective immediately and kept across restarts |

The field app talks to `/field/api` with the agent's token:
- `GET /bootstrap`: categories and areas, cached for offline use
- `GET /duplicates`
- `POST /businesses`: idempotent via `clientRef`; returns 409 with matches when the business may already be listed
- `GET /mine`

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with auto-reload |
| `npm test` | Run the test suite (in-memory database, no network) |
| `npm run typecheck` | Type-check everything |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run db:migrate` / `npm run db:seed` | Apply migrations / load reference data (and sample businesses when enabled) |
| `npm run ops:user -- add\|reset\|list` | Ops console accounts from the command line |
| `npm run templates [-- --create]` | Check (or submit) the WhatsApp message templates |
| `npm run eval [-- --claude --model …]` | Score request understanding on `evals/requests.jsonl`, and show what the local engine answers on its own (free; `--claude` calls the API) |
| `npm run eval:export -- --out evals/real.jsonl` | Export real requests to label for the eval (kept out of git) |

Tests run two at a time because each starts its own embedded Postgres; set `VITEST_MAX_WORKERS` higher on a machine with more than 8 GB of memory.

See [docs/ROADMAP.md](docs/ROADMAP.md) for what comes next.
