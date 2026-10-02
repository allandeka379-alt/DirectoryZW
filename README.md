# FindZim

One WhatsApp number where people in Zimbabwe type what they want to buy or hire. For now it reads typed messages only: voice notes and photos get a polite "please type" reply. The service replies with local businesses that can help, verified ones first, and connects the customer to them directly. When nobody lists exactly what they want, it offers suppliers in related categories; when there's nothing at all, a person from the team takes over. It is free for customers and businesses at launch. Businesses register on the same number by typing "I want to register a business", or field teams register them.

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

Open http://localhost:3000/simulator. It shows two people chatting with our one number, side by side: a customer and a business owner. No Meta account or API key is needed: messages stay on your computer, the database is embedded Postgres (PGlite) stored in `.data/`, and requests are understood by the local engine (Claude only helps with wording it can't read, when `ANTHROPIC_API_KEY` is set). Sample businesses are fictional and marked "(sample)".

Things to try:

1. **Customer:** type `I need a plumber in Mabelreign`, tap **I agree**, open **See options**, pick one, tap **Connect me**.
2. **Business owner:** pick the business you chose, and type `my business`: its lead notification carries the same reference code.
3. **Run follow-ups now** (top right) sends the follow-up that normally goes out 20 hours later.
4. **Business owner, a new number:** type `I want to register a business` and list it. Type `my business` any time for the business menu; anything else you type is a search, as for any customer.
5. **Customer:** `I need a wedding venue in Avondale`. No venue is listed, so it offers the events businesses nearby. Then try `I need a lawyer in Avondale`: nothing fits, so the chat goes straight to a person (see **Live chats** in the admin portal).
6. **Customer, in Shona:** `ndoda plumber ku Mabelreign`. The reply is in English.
7. **Customer:** type `recommend` and describe a business you know. It appears under **Customer tips** in the admin portal.
8. **Business owner, buying stock:** pick Siyaso Hardware, type `my business`, choose **Find a supplier** and type `cement wholesale`. You get the wholesalers near Mbare, and the message to the supplier says Siyaso is asking.

With `ANTHROPIC_API_KEY` set you can also:

9. **Customer:** write something the local engine doesn't know, such as `ndoda keke remuchato ku Avondale`. Claude works it out once, and the next person who writes it is answered from the phrasebook, without Claude. The **Health and costs** screen shows how requests were understood and what Claude cost today.

The website is at http://localhost:3000: register a business at `/register`, then send the code it gives you from the simulator's business-owner side. The reply links to the business dashboard at `/app`, where the owner adds products one by one or uploads a price list, changes prices and sees their customers. Type `dashboard` as the owner any time for a new sign-in link.

The admin portal, where the team manages everything, is at http://localhost:3000/admin. Locally it's open until the first account exists; after that everyone signs in (see [Admin portal accounts](#admin-portal-accounts)). To try the field app, go to **Field agents** in the admin portal, add an agent and open the setup link it gives you. On a phone on the same network, use `PUBLIC_BASE_URL` with this computer's address, because GPS and offline mode need a secure page, so over a network the app needs HTTPS. Only localhost works without it.

## How it works

| Folder | What it does |
| --- | --- |
| `src/whatsapp` | Webhook signature checks and parsing, message builders that enforce WhatsApp's limits (product cards included), two transports (Meta's Cloud API and the local simulator), and the sync that keeps our Meta catalog in step with the dashboard |
| `src/conversation` | The engine (messages from one person handled in order, duplicates ignored), the router that sends each message on our number to the customer or the business side, the customer and business flows, alerts when a store lists what someone asked for, and the messenger, which switches to approved templates once the 24-hour window has closed |
| `src/ai` | Understanding requests: the local engine (the lexicon with word roles, Shona prefixes and verb roots, action rules, spelling guesses) and its confidence bands, the phrasebook, and Claude for wording the engine can't read (within a daily budget) |
| `src/directory` | Category taxonomy (with related categories), place names, search and ranking, businesses, the live product search and matcher (`products.ts`), stores that list an item merged with stores in the trade (`suppliers.ts`), customer recommendations, introductions with reference codes |
| `src/field` | Field agents (setup links), in-person registration with duplicate checks, call-back audits |
| `src/jobs` | A job queue stored in Postgres: follow-ups, weekly summaries, report reminders, resending failed replies, the daily clean-ups |
| `src/http` | Fastify server: WhatsApp webhook, health checks, simulator, the website and dashboard API, the admin API (with sign-in), field API, static pages |
| `src/ops` | The team's accounts, sessions and the activity log |
| `src/web` | The business dashboard's back end: owners' sign-in links and sessions, products and prices (bulk upload, price changes, price history, photos), analytics, and registration from the website |
| `src/privacy.ts` | Export and deletion on request, and the retention clean-up |
| `src/eval` | Measuring how well requests are understood, against labelled examples in `evals/` |
| `src/db` | Embedded PGlite or Postgres, SQL migrations, seed data (categories, areas, the starting lexicon, sample businesses) |
| `public/field` | The field app: works offline, captures GPS and photos, and queues registrations until there's signal |
| `public/site` | The website: the landing page and the registration form |
| `public/app` | The business dashboard |
| `public/admin` | The admin portal |
| `public/web` | What they share: the design system (`base.css`), the dark and light themes, and UI building blocks |
| `public/ops` | The first ops console, kept at `/ops/classic` |

Rules the code enforces:

- **One number for everyone.** Customers and businesses message the same WhatsApp number, and the router in `src/conversation/router.ts` picks the side:
  - A tap goes back to the side that sent the button.
  - "I want to register a business" (or "register my shop", "list my business") starts a registration, and "my business" opens the business menu.
  - While the business side is in the middle of something and was the last to reply, within the hour, it keeps the conversation.
  - Everything else is a search.
  - A message to either side opens WhatsApp's free reply window for both.
- **The AI interprets; the database decides.** Claude only turns text into structured fields. Businesses, prices and results always come from the database.
- **Products, live.** Every reply reads the products stores list on the dashboard at that moment. A product added, a price changed or "out of stock" shows in the very next reply ([docs/ROADMAP.md](docs/ROADMAP.md), Milestone 15):
  - "I found *samsung 55 inch tv* at three stores near Avondale, from *$520*". Stores that list it come first, verified before unverified, then stores in the trade that haven't listed it.
  - The matcher reads sizes, plurals, other names, Shona words and typos. It won't pass off another size or an accessory ("TV stand") as the item.
  - With a Meta catalog (`WHATSAPP_CATALOG_ID`), products with a photo and a price also go out as WhatsApp's own product cards after the results. A card, a cart or a product's code brings that store's card. We don't take orders: stores sell directly.
  - When nobody listed what someone asked for and a store near them lists it within a day, they get one alert, free, inside their window. *alerts off* or *stop* ends them.
- **Photos in bulk.** A "Photo link" column in the product upload brings in photos from the store's website. The server fetches them in the background, only from the public internet, and makes them the size of a photo added by hand. **Add photos** takes many photo files at once and matches them to products by file name (code or name).
- **Verified first, and said so.** Results tell customers which businesses our team has verified: "We have three stores near Avondale that our team has verified, and they have *iphone 18 pro max*" for categories that sell goods, "We have two businesses near Mabelreign that offer *plumbing services*, and our team has verified them" for services. The welcome message explains what verified means: visited in person, with the owner checked. Unverified businesses appear only when fewer than `MIN_VERIFIED_RESULTS` verified ones match. They're counted apart, listed under "Not checked yet" and shown with a deposit warning. High-scam categories (rentals, cars, visas) show verified businesses only. Blocked and restricted categories are never searchable.
- **Replies in English.** The assistant reads English, Shona and Ndebele and always answers in English. A Shona or Ndebele request is named by its English category.
- **The customer contacts the business.** "Connect me" opens a WhatsApp chat with the message typed, including a reference code. Customer numbers are never passed to businesses.
- **Opt-in first.** Customers agree to the privacy notice before their first search; businesses agree to the listing terms when they register.
- **No ID copies.** Field agents tick that they checked the owner's ID or registration; the app never accepts a photo of one. Verified means an agent saw the premises and checked ID.
- **Our suppliers, then people.** A request is answered from suppliers in its category. When none are nearby, the customer gets suppliers in related categories: a gadget nobody lists goes to the electronics shops. Related categories are a deliberate list in `src/db/seed-data/categories.ts`, and trades and professional services aren't cross-referred. When nothing fits, a person takes over straight away. Both kinds show up in supply gaps for the field team.
- **Local first.** Greetings, help, "agent", blocked items and clear requests, in English or Shona, are understood without Claude. When one to three categories fit, or the request rests on Shona words nobody has checked yet, the customer taps "Did you mean…?" instead. Claude is asked only about wording the engine can't read at all, and only within the daily budget. Taps, Claude's answers and the team's corrections are remembered, so the same wording is never asked about twice. What nobody understands after one "please say it differently" goes to a person.
- **Typed messages only, for now.** Voice notes and photos aren't downloaded or read: customers and owners are asked to type instead. It keeps running costs down (no speech-to-text, no Claude for images). Items on price lists read before this change still show on business cards.
- **Businesses find suppliers too.** Each business sells to the public, to other businesses (wholesale), or both. In the business menu, **Find a supplier** searches, for the owner's own business, the businesses that sell wholesale near it, never its own listings. When no wholesaler has it, the owner gets the retail stores in that line of business instead. Suppliers are told which business is asking. Wholesale is for registered businesses only: the public never sees wholesale-only businesses.
- **Free conversations.** Replies inside the 24-hour window a person's own message opens cost nothing. The follow-up goes out 20 hours after "Connect me", inside that window. A business hears about a new customer only while its own window is open; otherwise the customer's first message, which carries the reference, tells it. Owners see their week at the top of the business menu and their customers under **My customers**, instead of a paid Monday summary. Paid templates are off unless switched on, and capped per day. The **Health and costs** screen shows the running costs. See [docs/HARDENING.md](docs/HARDENING.md).
- **We keep our promise.** The follow-up asks customers how it went, and "didn't reply" or "didn't have it" answers count against the business. Business cards show when our team checked them and, once five customers have answered, how many got what they needed. Verified businesses that keep letting customers down, have open reports or were verified over a year ago go on the Re-checks screen for the field team. Reports left open for a day raise an alert.
- **Nothing is lost.** Every incoming message is saved before WhatsApp is told it arrived. Anything a crash leaves unhandled is picked up again. Replies that fail for a temporary reason are resent.
- **Limits per number.** Floods of messages or reports from one number are cut off politely. A listing is paused automatically only after several customers who contacted it report it.
- **People can leave.** "delete my data" deletes everything about that person, as a customer and as a business (and an owner's listings), once they confirm. Old chats are cleaned up on a schedule.

## Claude

Claude is the backup, not the first reader. The design and its reasoning are in [docs/UNDERSTANDING.md](docs/UNDERSTANDING.md).

- **When it's used:** only for typed wording the local engine isn't confident about, and hasn't seen before. Voice notes and photos aren't read, so nothing else reaches Claude.
- **How:**
  - the model is set by `CLAUDE_MODEL`, default `claude-sonnet-5`
  - thinking is off and effort low
  - the instructions and category list are cached
  - the local engine's notes (possible categories, unknown words, place) go with the message
  - server-side refusal fallbacks are on (`fallbacks: "default"`)
  - any failure returns to the local reading, so the chat never stalls
- **Budget:**
  - `CLAUDE_DAILY_BUDGET_USD` (default $1) stops Claude calls for the rest of the day in Harare, and the team is alerted at 80% and 100%.
  - `CLAUDE_CALLS_PER_NUMBER_PER_DAY` (default 3) caps what one number can cause.
  - Every call's cost is recorded, and the **Health and costs** screen shows today's spend and how requests were understood.
  - A call gives up after `CLAUDE_TIMEOUT_SECONDS` (default 6) with one retry. After three failures in a row, Claude is skipped for five minutes.
  - The prompt is marked for caching only when the previous call was under four minutes ago, because a cache write costs 1.25 times the price and only pays off if another call reads it.
- **Business sign-up never uses Claude:** the local engine reads the description, and when it can't, the owner picks the category from a list.

Measure before changing models: `npm run eval -- --claude --model …` compares models on labelled requests. Plain `npm run eval` shows how many requests the local engine answers on its own, and whether any of those confident answers were wrong.

## The local engine and the word list

The local engine reads a request word by word ([docs/UNDERSTANDING.md](docs/UNDERSTANDING.md) has the design):

- **Places**, including Shona and Ndebele prefixes ("kuMabelreign", "eNkulumane") and misspellings ("Mabelrein").
- **Each category's own words**, plus the **lexicon**: every word has a role (service, product, general word, brand, occasion, action, detail or filler). The lexicon is in the database, seeded from `src/db/seed-data/lexicon.ts`, and editable in the admin portal.
- **Shona word shapes:**
  - joining prefixes ("keke remuchato", a wedding cake; "matende nemacheya", tents and chairs)
  - the plural "ma-" on borrowed words ("matyres")
  - verb roots with their prefixes and endings ("anogadzira", who repairs; "yekuroja", for hire)
- **Ndebele word shapes:**
  - noun prefixes, including on borrowed words ("ifriji", "ifridge")
  - "of" and "and" forms that swallow a vowel ("ikhekhe lomtshado", a wedding cake)
  - verb roots ("olungisa", who repairs; "ukuqasha", to hire)
- **English word forms** ("installer", "drilling"), texting spellings ("pls", "2moro", "55inch") and one-letter misspellings of longer words ("plumbar").
- **Action rules** in `src/ai/rules.ts` (repair + fridge = appliance repairs, hire + chairs = event hire). Brands and occasions only narrow ("tyres for my Toyota" is car parts).

**The Shona and Ndebele word lists are first drafts by the developers.** Until a native speaker approves a word (admin portal → **Word list**, or the spreadsheet download), requests that depend on it get a "Did you mean…?" question rather than a straight answer. `LEXICON_TRUST_DRAFTS=true` uses the drafts as if approved. The reviewer's guide is [docs/WORD_LIST.md](docs/WORD_LIST.md).

The team keeps teaching it:
- **Handoffs → Teach the assistant**: what the customer actually wanted
- **Check answers**: the weekly check. Requests customers said were wrong come first (they tapped "Not what I asked for", or told the assistant it doesn't understand), then a random sample of answers it gave on its own. A wrong one is fixed for that wording at once.
- **Vocabulary → Suggested words**: words customers used, with what they turned out to mean

A customer who says the assistant doesn't understand ("useless", "hauna kunzwisisa", "awuzwisisi") goes straight to a person. Handoff messages say when a person will reply, from `TEAM_HOURS`.

`npm run explain -- "ndoda keke remuchato ku Budiriro"` shows how a message is read, word by word.

**Tuning on real traffic (Phase 3).** The team labels real requests in the admin portal (**Label requests**); about 300 are enough. Then:
- `npm run eval:export -- --out evals/real.jsonl --labelled` exports them as the eval's answer key.
- `npm run eval -- --file evals/real.jsonl --tune` suggests the thresholds: `LOCAL_UNKNOWN_WORDS`, unknown words a straight answer may have per language, and `LOCAL_CLASSIFIER_MIN`, the word-shape classifier's bar.
- `npm run eval -- --file evals/real.jsonl --claude --model claude-sonnet-5,claude-haiku-4-5` compares models on the requests Claude would actually see, with cost per 100 requests.

The **Health and costs** screen tracks the targets: understood without Claude, Claude calls per 100 requests, handoffs, the weekly check, and labelling progress.

The **word-shape classifier** is a second opinion for words the rules don't know. It finds the known word most like a misspelling ("fotographer" → "photographer"), and only ever offers it as a "Did you mean…?" option.

## Going live

Step by step in [docs/LAUNCH.md](docs/LAUNCH.md); hosting, backups and monitoring in [docs/DEPLOY.md](docs/DEPLOY.md); personal data in [docs/DATA_PROTECTION.md](docs/DATA_PROTECTION.md). In short:

1. Create a Meta Business portfolio and complete business verification. Unverified accounts can start only about 250 conversations a day.
2. Add one number to the WhatsApp Cloud API. Note its phone number ID, and create a permanent access token for a system user.
3. Point the webhook at `https://<your-domain>/webhook/whatsapp` with your verify token, subscribe to `messages`, and set the app secret.
4. Submit these utility templates with `npm run templates -- --create` (set `WHATSAPP_BUSINESS_ACCOUNT_ID`), then run `npm run templates` until they're approved. Button payloads are filled in by the app. The definitions live in `src/whatsapp/templates.ts`.

   | Name | Body | Buttons (quick reply) |
   | --- | --- | --- |
   | `lead_notification` | New customer (ref {{1}}) is looking for: {{2}}. They'll message you on WhatsApp shortly. | none |
   | `follow_up` | Did you get what you needed from {{1}}? | Yes, sorted · Not yet · They didn't reply |
   | `weekly_summary` | Your week: {{1}} was shown in {{2}} searches and {{3}} customers connected with you. | none |

5. Set the following, then deploy with the `Dockerfile` or anywhere that runs Node:
   - `WHATSAPP_TRANSPORT=cloud`, plus the WhatsApp variables in `.env.example`. Before Meta has approved the number, use `WHATSAPP_TRANSPORT=off` (**pre-launch mode**):
     - The website, the dashboard, the admin portal and the field app run, and nothing goes out on WhatsApp.
     - Website sign-ups wait on **Website sign-ups** for the team to call the owner and **List it**.
     - Owners get a one-time dashboard link from the business's page in the admin portal (**Dashboard link for the owner**, admins only), which works for a day.
     - Switch to `cloud` once the Meta settings are in.
   - `DATABASE_URL` pointing at Postgres (required in production)
   - `OPS_TOKEN`
   - `PUBLIC_BASE_URL`: your HTTPS address, used in agents' setup links and owners' dashboard sign-in links
   - `CONTACT_EMAIL`: where people write about their data and listings. The app serves the privacy notice at `/privacy` and the business terms at `/terms` (a lawyer should review both); `PRIVACY_URL` and `BUSINESS_TERMS_URL` point elsewhere instead
   - `STORAGE=s3` with the `S3_*` settings (or `UPLOADS_DIR` on a disk that survives redeploys)
   - `ANTHROPIC_API_KEY` for Claude (wording the local engine can't read), with `CLAUDE_DAILY_BUDGET_USD`
   - `ALERT_WEBHOOK_URL` for alerts
   - `SEED_SAMPLE_DATA=false`
   - `NODE_ENV=production`

   Run `npm run build`, then `npm start`. Health checks: `/health` (the process is up) and `/ready` (it can reach the database). On Railway, `railway.json` sets the health check and restarts.

   GitHub Actions type-checks and runs the tests on every push (`.github/workflows/ci.yml`). Turn on **Wait for CI** in the Railway service's settings, so a commit that fails them is never deployed.
6. Create the first admin with `node dist/ops/user-cli.js add --email … --name … --role admin`.
7. For WhatsApp's product cards (optional), connect a catalog to the number in Meta's Commerce Manager and set `WHATSAPP_CATALOG_ID`. The access token needs `catalog_management`. Products go in within a minute of a change; **Health and costs** shows what's in and what Meta refused. Without a catalog, replies still show products and prices as text.

## Admin portal accounts

Everyone on the team signs in at `/admin` with their own email and password, so the **Activity log** shows who did what. Businesses never use this sign-in: they get one-time links on WhatsApp.

- **Staff** handle chats, reports, verification, call-backs, listings, tips and vocabulary, and can block a number.
- **Admins** can also manage field agents, the team, and people's data: export and delete.

Create accounts under **Team accounts**, or with `npm run ops:user -- add --email … --name … --role admin|staff`, which prints a one-time password. Five wrong passwords lock an email for 15 minutes. `OPS_TOKEN` works as an admin for scripts and the first sign-in. In development, with no `OPS_TOKEN` and no accounts yet, the portal is open.

## Admin API

The admin portal at `/admin` is built on these JSON endpoints. They live under `/ops/api` and need `Authorization: Bearer <session token or OPS_TOKEN>`. Endpoints marked (admin) refuse staff.

| Endpoint | Purpose |
| --- | --- |
| `POST /login`, `POST /logout`, `GET /me`, `POST /me/password` | Sign in (`{ "email", "password" }` gives a session token), sign out, who am I, change my password |
| `GET /users`, `POST /users`, `POST /users/:id` (admin) | The team; add someone (a password is generated when none is given); change role, switch off or on, new password |
| `GET /activity` (admin) | Who did what, newest first |
| `GET /contacts?phone=` | Find people on either number |
| `POST /contacts/:id/block` | Block or unblock a number (`{ "blocked": true, "reason": "…" }`) |
| `GET /contacts/:id/export`, `POST /contacts/:id/erase` (admin) | A person's data as JSON; delete it |
| `POST /businesses/:id/erase` (admin) | Delete a listing completely, with its photos and products (they leave the WhatsApp catalog at the next sync) |
| `GET /system` | Queues, failed sends, what's switched on, Claude spend today and this week, how requests were understood and matched, recent alerts |
| `GET /catalog`, `POST /catalog/sync` (admin) | Products on WhatsApp: what's in our catalog, what's waiting, what Meta refused, and alerts sent; send every product again |
| `GET /summary` | Businesses, requests, introductions, open handoffs, reports, active agents, businesses to verify, website sign-ups waiting for their code, products listed, owners using the dashboard, and the launch measures for the last 30 days: final follow-up answers and "Yes, sorted", customers who came back, owners who wrote in, connections with verified businesses |
| `GET /trends?days=30` | Requests, connections, new businesses and website sign-ups per day, in Harare time |
| `GET /requests?status=no_results` | Recent requests, filterable by status |
| `GET /supply-gaps?days=7` | Requests no supplier in their category could answer (given related suppliers, or handed to a person), grouped by category and area: where field teams go next |
| `GET /handoffs` | Chats waiting for a person, with recent messages |
| `POST /contacts/:id/reply` | Reply to a customer as the team (`{ "text": "…" }`) |
| `POST /contacts/:id/release` | Hand the chat back to the assistant |
| `GET /reports`, `POST /reports/:id/status` | Open reports about businesses; mark `reviewed` or `actioned` |
| `GET /businesses?q=&verification=&status=&source=`, `GET /businesses/:id` | Browse and inspect listings, with photos, checks and call-backs, the owner and their dashboard sessions, and how complete the catalogue is |
| `GET /businesses/:id/products?q=`, `POST /businesses/:id/products/archive` | A business's catalogue; take products down (`{ "ids": [..], "reason": "…" }`, recorded in the activity log) |
| `DELETE /businesses/:id/photos/:photoId` | Delete a shopfront, inside or product photo |
| `POST /businesses/:id/owner/sign-out` | Sign the owner out of the dashboard everywhere, and spoil their unused sign-in links |
| `GET /web-registrations?status=pending` | Registrations from the website: `pending` (waiting for the WhatsApp code), `completed`, `expired` or `all` |
| `GET /photos/:id` | Any photo: field, shopfront, inside or product |
| `POST /businesses` | Manual registration (`name`, `phone`, `categories`, `area` or `lat`/`lng`, `consent: true`, `verified`) |
| `POST /businesses/:id/verify`, `POST /businesses/:id/status` | Mark verified (recorded under your name); set `active`, `paused` or (admin) `removed` |
| `GET /verification-queue` | Self-registered businesses waiting for a field visit |
| `GET /agents`, `POST /agents` (admin) | Agents with quality stats; add one and get its setup link |
| `POST /agents/:id/token`, `POST /agents/:id/active` (admin) | New setup link (the old one stops working); deactivate or reactivate |
| `GET /audits/queue?percent=10`, `POST /businesses/:id/audit` | Call-back sample per agent; record `confirmed`, `details_wrong`, `wrong_number`, `not_a_business` or `refused` (the last three count as failures; a wrong number or "not a business" also hides the listing) |
| `GET /recommendations?status=new`, `POST /recommendations/:id/status` | Customers' tips about businesses to list; mark `contacted`, `listed` or `rejected` |
| `GET /unmatched?days=30` | Searches that matched no category, grouped by what people typed (wording the engine or phrasebook now answers drops off) |
| `GET /vocabulary/suggestions` | Words customers used that the engine didn't know, with the category they turned out to mean and how consistently |
| `GET /lexicon?language=sn&status=draft&q=`, `GET /lexicon/export.csv` | The word list, drafts first, with example forms of verb roots and how many customers agreed; as a spreadsheet for offline review |
| `POST /lexicon` | Add a word or change what one means (`term`, `language`, `role`, `categories`, `action`, `root`, `gloss`); approved straight away |
| `POST /lexicon/review` | Approve, reject or reopen words (`{ "ids": [..], "status": "approved" }`) |
| `POST /requests/:id/teach` | What a customer actually wanted (`{ "category": "…" }`): corrects the request and remembers the wording |
| `GET /review/sample?days=7`, `POST /requests/:id/review` | Answers customers said were wrong, then answers the engine gave on its own, for the weekly check; record `right`, `should_ask` or `wrong` with the right `category` |
| `GET /labels/next?limit=20`, `POST /requests/:id/label`, `GET /labels/summary` | Real requests to label (`{ "intent": "search", "category": "…" }`), and how often each step of the ladder was right |
| `GET /categories`, `POST /categories/:slug/synonyms` | Categories with their words; add or remove words (`{ "add": ["kombi"] }`), effective immediately and kept across restarts |

The website and the business dashboard talk to `/app/api`:

| Endpoint | Purpose |
| --- | --- |
| `GET /public/options`, `POST /public/register` | Categories and areas for the form; start a registration, which gives the code to send from WhatsApp |
| `POST /auth/request`, `POST /auth/exchange`, `POST /auth/logout` | Ask for a sign-in link on WhatsApp (always the same answer, so it doesn't say which numbers are registered); trade a link's token for a session cookie; sign out |
| `GET /me`, `GET /options` | The owner's businesses; categories and areas |
| `GET`, `PUT /businesses/:id`, `POST /businesses/:id/status`, `POST`, `DELETE /businesses/:id/photos` | The business profile (a verified business's number is changed by the team only), live or paused, shopfront and inside photos |
| `GET /businesses/:id/analytics?days=30`, `GET /businesses/:id/customers` | Searches, customers, outcomes, rating and local demand; customers by reference code |
| `GET`, `POST /businesses/:id/products`, `GET`, `PUT /businesses/:id/products/:pid` | List, search and add products; one product with its price history; change it |
| `POST /businesses/:id/products/archive`, `/stock`, `/confirm-prices`, `/adjust-prices`, `/import` | Take down, in or out of stock, prices still right, change many prices (with `dryRun` to preview), upload a list (with `dryRun` to check) |
| `PUT`, `DELETE /businesses/:id/products/:pid/photo` | A product's photo |
| `GET /businesses/:id/products/index` | Every product's name and code, to match many photo files to products at once |
| `GET /businesses/:id/photo-links`, `POST /businesses/:id/photo-links/retry`, `/clear` | Photos from the links in an upload: how many are on their way, and which links didn't work; try those again, or forget them |
| `GET /photos/:id` | A photo, for the business's owner only |

Every call except the public ones needs the owner's session cookie, and changes must come from our own pages.

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
| `npm run db:demo [-- --days 120 \| --clear]` | Fill the local database with months of sample activity to try the dashboards, or remove it ([docs/DASHBOARDS.md](docs/DASHBOARDS.md)); refuses to run against production |
| `npm run ops:user -- add\|reset\|list` | Admin portal accounts from the command line |
| `npm run templates [-- --create]` | Check (or submit) the WhatsApp message templates |
| `npm run eval [-- --claude --model …]` | Score request understanding on `evals/requests.jsonl`, and show what the ladder does with each: answered locally, "Did you mean…?", or passed on (free; `--trust-drafts` as if the Shona words were approved; `--claude` calls the API) |
| `npm run explain -- "text"` | Show how the local engine reads a message, word by word |
| `npm run eval:export -- --out evals/real.jsonl [--labelled]` | Export real requests for the eval: the team's labelled ones, or a sample to label by hand (kept out of git) |
| `npm run eval -- --tune` | Suggest `LOCAL_UNKNOWN_WORDS` and `LOCAL_CLASSIFIER_MIN` from the labelled examples |

Tests run two at a time because each starts its own embedded Postgres; set `VITEST_MAX_WORKERS` higher on a machine with more than 8 GB of memory.

See [docs/ROADMAP.md](docs/ROADMAP.md) for what comes next.
