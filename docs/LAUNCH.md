# Launch checklist

In order. The code is ready for each step; most of the work here is accounts, approvals and people.

## 1. Meta and WhatsApp (start first: approvals take days to weeks)

- [ ] Create a Meta Business portfolio and complete **business verification** (company documents, website, domain). Until then you can message only about 250 new people a day.
- [ ] Add **two phone numbers** to the WhatsApp Cloud API: one for customers, one for businesses and field teams. Use numbers that have never had a WhatsApp account, or delete the account first.
- [ ] Set each number's **display name** (Meta reviews it) and business profile: description, address, website and the privacy notice link.
- [ ] Create a **system user** with a permanent access token that has `whatsapp_business_messaging` and `whatsapp_business_management`.
- [ ] Submit the **message templates**: `npm run templates -- --create`, then run `npm run templates` until all three show APPROVED.
- [ ] Register the **webhook** at `https://<domain>/webhook/whatsapp` with your verify token, subscribe to `messages`, and set the app secret.

## 2. Hosting (see [DEPLOY.md](DEPLOY.md))

- [ ] Postgres with backups; test a restore.
- [ ] A private bucket for photos (`STORAGE=s3`).
- [ ] Deploy, with health checks on `/ready`.
- [ ] Set `ALERT_WEBHOOK_URL` and send a test (for example, briefly use a wrong `ANTHROPIC_API_KEY` on a staging copy).
- [ ] Create the first admin (`node dist/ops/user-cli.js add …`), then the team's accounts.

## 3. Data protection (see [DATA_PROTECTION.md](DATA_PROTECTION.md))

- [ ] POTRAZ licence and data protection officer.
- [ ] Privacy notice and business terms published; `PRIVACY_URL` and `BUSINESS_TERMS_URL` set.

## 4. Quality checks

- [ ] **Shona word list** reviewed by a native speaker, ideally two: ops console → **Word list**, or the spreadsheet download. See [WORD_LIST.md](WORD_LIST.md). Until then, Shona requests get a "Did you mean…?" question more often than they need to.
- [ ] **Ndebele word list** reviewed by a native speaker the same way.
- [ ] `TEAM_HOURS` set to when the team really answers handed-over chats.
- [ ] **Understanding requests** (Phase 3, after the first 2–4 weeks of real traffic):
  - Label about 300 real requests in the ops console (**Label requests**), spread over the team, 20 at a time.
  - `npm run eval:export -- --out evals/real.jsonl --labelled`, then `npm run eval -- --file evals/real.jsonl --tune`. Set `LOCAL_UNKNOWN_WORDS` and `LOCAL_CLASSIFIER_MIN` to what it suggests.
  - `npm run eval -- --file evals/real.jsonl --claude --model claude-sonnet-5,claude-haiku-4-5`. Switch `CLAUDE_MODEL` only if the cheaper model scores about as well.
  - Watch the **Targets** on the System screen.
- [ ] **Templates** approved. **Weekly summary** checked on a Monday on staging.

## 5. Soft launch in Harare

- [ ] Field teams register and verify at least 2,000 businesses, led by the supply-gaps screen.
- [ ] Call back a share of each agent's registrations (Call-backs screen) every week.
- [ ] Work through the **Re-checks** screen every week: visit or phone each business, then record what you found. Customers are told verified businesses are genuine and reliable, and this list is how that stays true.
- [ ] Answer every report within a day. The team is alerted about any report left open longer, and customers are told "we look into every report".
- [ ] Open the customer number to a first group (friends, family, one suburb) before any advertising.
- [ ] Watch weekly:
  - the share of requests with results
  - the share connected with a business
  - the share rated "sorted"
  - repeat customers
  - top supply gaps
  - reports
  - time to answer handoffs
  - **Check answers**: 50 of the assistant's own answers, marked right or wrong (aim for 98% right)
  - how often "Did you mean…?" is answered, and the Suggested words on the Vocabulary screen
