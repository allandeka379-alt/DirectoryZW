# Launch checklist

In order. The code is ready for each step; most of the work here is accounts, approvals and people.

## 1. Meta and WhatsApp (start first: approvals take days to weeks)

- [ ] Create a Meta Business portfolio and complete **business verification** (company documents, website, domain). Until then you can message only about 250 new people a day.
- [ ] Add **one phone number** to the WhatsApp Cloud API. Customers search on it, and businesses register on it by typing "I want to register a business". Use a number that has never had a WhatsApp account, or delete the account first.
- [ ] Set the number's **display name** (Meta reviews it) and business profile: description, address, website and the privacy notice link.
- [ ] Create a **system user** with a permanent access token that has `whatsapp_business_messaging` and `whatsapp_business_management`.
- [ ] Submit the **message templates**: `npm run templates -- --create`, then run `npm run templates` until all three show APPROVED.
- [ ] Register the **webhook** at `https://<domain>/webhook/whatsapp` with your verify token, subscribe to `messages`, and set the app secret.
- [ ] **Product cards** (optional; replies show products and prices as text without them):
  - In Commerce Manager, create a catalog (e-commerce, products) owned by the business portfolio, and connect it to the WhatsApp number.
  - Give the system user's token `catalog_management`, and set `WHATSAPP_CATALOG_ID`.
  - Switch WhatsApp's cart off, since stores sell directly: in WhatsApp Manager's catalog settings, or with the Cloud API's commerce settings for the number (`is_cart_enabled=false`, `is_catalog_visible=true`). If a cart comes in anyway, we reply that stores sell directly and show the store.
  - Check that `PUBLIC_BASE_URL` is the live HTTPS address: Meta fetches each product's page (`/p/…`) and photo from it.
  - In the admin portal, **Health and costs** → **Products on WhatsApp** → **Send everything again**. Within a few minutes it shows how many products are in and anything Meta refused.
  - Try it on a test number first: search for a product with a photo and a price, open a card, tap "Ask about this" (the store's card should come back), and send a cart (we reply that stores sell directly).

## 2. Hosting (see [DEPLOY.md](DEPLOY.md))

Until Meta approves the number, run with `WHATSAPP_TRANSPORT=off` (pre-launch mode). The website, the dashboard, the admin portal and the field app work, for the sign-up drive:
- Website sign-ups wait on **Website sign-ups**. Call each owner, check the details, then **List it**.
- Owners get their dashboard through a one-time link from their business's page (**Dashboard link for the owner**). It works for a day.
- On launch day, set the Meta settings and `WHATSAPP_TRANSPORT=cloud`. Owners claim their listings by typing *my business* on WhatsApp.

- [ ] Postgres with backups; test a restore.
- [ ] A private bucket for photos (`STORAGE=s3`).
- [ ] Deploy, with health checks on `/ready`.
- [ ] Set `ALERT_WEBHOOK_URL` and send a test (for example, briefly use a wrong `ANTHROPIC_API_KEY` on a staging copy).
- [ ] Create the first admin (`node dist/ops/user-cli.js add …`), then the team's accounts.

## 3. Data protection (see [DATA_PROTECTION.md](DATA_PROTECTION.md))

- [ ] POTRAZ licence and data protection officer.
- [ ] Privacy notice and business terms published; `PRIVACY_URL` and `BUSINESS_TERMS_URL` set.

## 4. Quality checks

- [ ] **Shona word list** reviewed by a native speaker, ideally two: admin portal → **Word list**, or the spreadsheet download. See [WORD_LIST.md](WORD_LIST.md). Until then, Shona requests get a "Did you mean…?" question more often than they need to.
- [ ] **Ndebele word list** reviewed by a native speaker the same way.
- [ ] `TEAM_HOURS` set to when the team really answers handed-over chats.
- [ ] **Understanding requests** (Phase 3, after the first 2–4 weeks of real traffic):
  - Label about 300 real requests in the admin portal (**Label requests**), spread over the team, 20 at a time.
  - `npm run eval:export -- --out evals/real.jsonl --labelled`, then `npm run eval -- --file evals/real.jsonl --tune`. Set `LOCAL_UNKNOWN_WORDS` and `LOCAL_CLASSIFIER_MIN` to what it suggests.
  - `npm run eval -- --file evals/real.jsonl --claude --model claude-sonnet-5,claude-haiku-4-5`. Switch `CLAUDE_MODEL` only if the cheaper model scores about as well.
  - Watch the **Targets** on the System screen.
- [ ] **Templates** approved. **Weekly summary** checked on a Monday on staging.

## 5. Soft launch in Harare

- [ ] Field teams register and verify at least 2,000 businesses, led by the supply-gaps screen.
- [ ] Mark wholesalers as they're registered ("Who they sell to" in the field app), and recruit wholesalers where the supply gaps show businesses searching.
- [ ] Call back a share of each agent's registrations (Call-backs screen) every week.
- [ ] Work through the **Re-checks** screen every week: visit or phone each business, then record what you found. Customers are told verified businesses are genuine and reliable, and this list is how that stays true.
- [ ] Answer every report within a day. The team is alerted about any report left open longer, and customers are told "we look into every report".
- [ ] Open the number to a first group of customers (friends, family, one suburb) before any advertising.
- [ ] Watch weekly (the Overview's **Launch measures** and the System screen's **Targets** and **Running costs** show most of these):
  - the share of requests with results
  - the share connected with a business
  - follow-up answers that say "Yes, sorted" (aim: 60% or more of final answers)
  - customers who come back on another day (aim: 25% or more)
  - owners who wrote to us (aim: half or more), and connections per verified business
  - top supply gaps
  - reports
  - time to answer handoffs
  - **Check answers**: 50 of the assistant's own answers, marked right or wrong (aim for 98% right)
  - how often "Did you mean…?" is answered, and the Suggested words on the Vocabulary screen
