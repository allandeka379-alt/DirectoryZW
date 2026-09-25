# WhatsApp Directory (working name: Directory ZW)

One WhatsApp number where people in Zimbabwe ask for anything they want to buy or hire. The service replies with local businesses that can help, verified ones first, and connects the customer to them directly. It is free for customers and businesses at launch; businesses self-register on a second WhatsApp number or are registered by field teams.

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

Open http://localhost:3000/simulator. It shows a customer chat and a business chat side by side. No Meta account or API key is needed: messages stay on your computer, the database is embedded Postgres (PGlite) stored in `.data/`, and without `ANTHROPIC_API_KEY` a simple keyword interpreter reads requests. Sample businesses are fictional and marked "(sample)".

Things to try:

1. **Customer:** type `I need a plumber in Mabelreign`, tap **I agree**, open **See options**, pick one, tap **Connect me**.
2. **Business pane:** switch to the business you picked to see its lead notification with the same reference code.
3. **Run follow-ups now** (top right) sends the follow-up that normally goes out 72 hours later.
4. **Business pane, new number:** type `register` and list a business.
5. **Customer:** `I need a wedding venue in Avondale` → **Ask around**, then switch the business pane to Msasa Event Hire and tap **Yes, I can help**.

The ops console is at http://localhost:3000/ops. To try the field app, go to **Agents** in the ops console, add an agent and open the setup link it gives you. On a phone on the same network, use `PUBLIC_BASE_URL` with this computer's address, because GPS and offline mode need a secure page, so over a network the app needs HTTPS. Only localhost works without it.

## How it works

| Folder | What it does |
| --- | --- |
| `src/whatsapp` | Webhook signature checks and parsing, message builders that enforce WhatsApp's limits, and two transports: Meta's Cloud API and the local simulator |
| `src/conversation` | The engine (messages from one person handled in order, duplicates ignored), the customer and business flows, and the messenger, which switches to approved templates once the 24-hour window has closed |
| `src/ai` | Request interpreters: Claude with structured output, plus a keyword fallback used offline, in tests and when Claude fails |
| `src/directory` | Category taxonomy, place names, search and ranking, businesses, introductions with reference codes |
| `src/field` | Field agents (setup links), in-person registration with duplicate checks, call-back audits |
| `src/jobs` | A job queue stored in Postgres (follow-ups, weekly summaries) |
| `src/http` | Fastify server: WhatsApp webhook, simulator, ops API, field API, static pages |
| `src/db` | Embedded PGlite or Postgres, SQL migrations, seed data (categories, areas, sample businesses) |
| `public/field` | The field app: works offline, captures GPS and photos, and queues registrations until there's signal |
| `public/ops` | The ops console |

Rules the code enforces:

- **The AI interprets; the database decides.** Claude only turns text into structured fields. Businesses, prices and results always come from the database.
- **Verified first.** Unverified businesses appear only when fewer than `MIN_VERIFIED_RESULTS` verified ones match, and always with a deposit warning. High-scam categories (rentals, cars, visas) show verified businesses only. Blocked and restricted categories are never searchable.
- **The customer contacts the business.** "Connect me" opens a WhatsApp chat with the message typed, including a reference code. Customer numbers are never passed to businesses.
- **Opt-in first.** Customers agree to the privacy notice before their first search; businesses agree to the listing terms when they register.
- **No ID copies.** Field agents tick that they checked the owner's ID or registration; the app never accepts a photo of one. Verified means an agent saw the premises and checked ID.

## Claude

With `ANTHROPIC_API_KEY` set, requests go to `claude-opus-5` at low effort. The system prompt, meaning the instructions and category list, is cached. Server-side refusal fallbacks are enabled (`fallbacks: "default"`), and any failure drops back to the keyword interpreter so the chat never stalls. Change the model with `CLAUDE_MODEL`. The feasibility study assumes routine steps eventually move to a cheaper model. Only do that after testing it against a set of real requests.

## Going live on WhatsApp

1. Create a Meta Business portfolio and complete business verification. Unverified accounts can start only about 250 conversations a day.
2. Add two numbers to the WhatsApp Cloud API, one for customers and one for businesses. Note both phone number IDs, and create a permanent access token for a system user.
3. Point the webhook at `https://<your-domain>/webhook/whatsapp` with your verify token, subscribe to `messages`, and set the app secret.
4. Create and get approval for these utility templates. Button payloads are filled in by the app.

   | Name | Body | Buttons (quick reply) |
   | --- | --- | --- |
   | `lead_notification` | New customer (ref {{1}}) is looking for: {{2}}. They'll message you on WhatsApp shortly. | none |
   | `follow_up` | Did you get what you needed from {{1}}? | Yes, sorted · Not yet · They didn't reply |
   | `ask_around` | A customer is looking for: {{1}} near {{2}}. Can you help? | Yes, I can help · No |
   | `ask_around_reply` | Good news! {{1}} says they can help with: {{2}}. | Connect me |
   | `weekly_summary` | Your week: {{1}} was shown in {{2}} searches and {{3}} customers connected with you. | none |

5. Set the following, then deploy anywhere that runs Node:
   - `WHATSAPP_TRANSPORT=cloud`, plus the WhatsApp variables in `.env.example`
   - `DATABASE_URL` pointing at Postgres
   - `OPS_TOKEN`
   - `PUBLIC_BASE_URL`: your HTTPS address, used in agents' setup links
   - `UPLOADS_DIR` on persistent storage
   - `SEED_SAMPLE_DATA=false`
   - `NODE_ENV=production`

   Run `npm run build`, then `npm start`.

## Ops API

The ops console at `/ops` is built on these JSON endpoints. They live under `/ops/api` and need `Authorization: Bearer $OPS_TOKEN`; in development they are open when no token is set.

| Endpoint | Purpose |
| --- | --- |
| `GET /summary` | Businesses, requests, introductions, open handoffs, reports, active agents |
| `GET /requests?status=no_results` | Recent requests, filterable by status |
| `GET /supply-gaps?days=7` | Unanswered requests grouped by category and area: where field teams go next |
| `GET /handoffs` | Chats waiting for a person, with recent messages |
| `POST /contacts/:id/reply` | Reply to a customer as the team (`{ "text": "…" }`) |
| `POST /contacts/:id/release` | Hand the chat back to the assistant |
| `GET /reports`, `POST /reports/:id/status` | Open reports about businesses; mark `reviewed` or `actioned` |
| `GET /businesses?q=&verification=`, `GET /businesses/:id` | Browse and inspect listings, with photos, checks and call-backs |
| `GET /photos/:id` | A field photo |
| `POST /businesses` | Manual registration (`name`, `phone`, `categories`, `area` or `lat`/`lng`, `consent: true`, `verified`, `agent`) |
| `POST /businesses/:id/verify`, `POST /businesses/:id/status` | Mark verified; set `active`, `paused` or `removed` |
| `GET /verification-queue` | Self-registered businesses waiting for a field visit |
| `GET /agents`, `POST /agents` | Agents with quality stats; add one and get its setup link |
| `POST /agents/:id/token`, `POST /agents/:id/active` | New setup link (the old one stops working); deactivate or reactivate |
| `GET /audits/queue?percent=10`, `POST /businesses/:id/audit` | Call-back sample per agent; record `confirmed`, `details_wrong`, `wrong_number`, `not_a_business` or `refused` (the last three count as failures; a wrong number or "not a business" also hides the listing) |

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

See [docs/ROADMAP.md](docs/ROADMAP.md) for what comes next.
