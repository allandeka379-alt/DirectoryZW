# FindZim review, 30 September 2026

A review of the whole project: where it stands, what was wrong, what was fixed, and how it rates now.

## Where the project is

FindZim is built and running in pre-launch mode. Customers will ask for anything on WhatsApp and get businesses near them, with prices; businesses list themselves on the website or on WhatsApp and manage their listings on the dashboard. Around that sit the admin portal, the field agents' app, a local engine that reads English, Shona and Ndebele (Claude only for what it can't read), the product engine and the WhatsApp catalog sync.

- **Live:** the app on Railway (project positive-love) behind `https://findzim.vercel.app`, with WhatsApp switched off until Meta approves the number. Sign-ups wait for the team to call and list them.
- **Size:** about 17,700 lines of TypeScript in 96 files, 23 web files, 16 database migrations, and 308 tests that run on an in-memory copy of the whole app.
- **Not yet done:** Meta approval, legal review, POTRAZ registration, and the launch tasks in [LAUNCH.md](LAUNCH.md).

## How it was reviewed

1. Every part of the code was mapped: the conversation, understanding, directory and search, products and catalog, the web and dashboard, the admin portal and field app, data protection, jobs and deployment.
2. Reviewers looked for problems in ten areas (correctness, conversation design, reliability, security, data protection, performance, tests, documentation, launch readiness and product gaps): 230 findings.
3. The 70 most serious were checked against the code, each by an independent reviewer trying to prove it wrong: 48 held up, 22 didn't.
4. The 48, and the serious findings that were plain from the code, were fixed, with tests.

## Ratings

Out of 10. "Before" is the project as it was on 29 September (commit 8cb8b34); "after" includes the fixes in this review.

| Area | Before | After | Why |
| --- | --- | --- | --- |
| Features | 8 | 8.5 | Unusually complete for pre-launch: both sides of WhatsApp, website, dashboard, admin portal, field app, product engine, catalog, bulk photos. Cards now show address and hours. |
| Conversation design | 6.5 | 8 | Before: an unknown suburb dropped the request, a search typed hours later could be filed as a report, a chat handed to a person swallowed "stop", typed "I agree" did nothing. All fixed. |
| Correctness | 6.5 | 8 | Before: tapping "Yes, sorted" twice raised a score twice, "Connect me" twice made two introductions and two follow-ups, wholesale-only stores reached the public through product codes, an owner could undo a pause from customer reports. All fixed. |
| Reliability | 5.5 | 7.5 | Before: a dropped database connection could crash the process, start-up didn't wait for the database, a job could be run twice after a restart, recurring jobs multiplied after a failure, nothing ran the tests before deploy. Now handled; one instance only is still the limit. |
| Security | 7 | 8 | Sound design (hashed tokens, scrypt, signed webhooks, one-time links). Before: sign-in tokens in URLs and logs, a mangled cookie gave a server error, no framing protection, and six-digit codes could be guessed without limit. Fixed. |
| Data protection and legal | 4.5 | 7 | Before: no privacy notice or terms published, locations and search words kept for ever, people's numbers kept for ever, owners could see how each customer rated them. Now: notice and terms served (to be checked by a lawyer), retention complete, feedback private. |
| Performance | 6.5 | 7.5 | Before: several lookups by person and by photo scanned whole tables, and the business search took an arbitrary 300 candidates. Indexes added and candidates ordered. Fine for thousands of businesses; one instance only. |
| Tests | 7 | 8 | 275 tests became 308. The Meta adapters and message ordering had none; now they do, against responses shaped like Meta's. Nothing has run against Meta itself yet. |
| Documentation | 8 | 8.5 | Thorough and current. Now covers the volume backups, Railway settings, CI and the review. |
| Launch readiness | 5 | 7 | The code side is close: webhook can be registered before launch, team-listed businesses can be claimed, pre-launch wording fixed. What's left is accounts, approvals and people (below). |
| **Overall** | **6.5** | **7.8** | A well-built product whose rough edges were in conversation dead ends, operations and data protection. Those are largely closed; the rest needs people, not code. |

## What was fixed

- **Conversations:** typed agreement; unknown places keep the request; "anywhere"; questions lapse an hour after the customer's last message; locations last 12 hours; "stop" and follow-up answers work while a person has the chat; "no" to a phone number; typed answers to the follow-up; reactions ignored and stickers answered on both sides; ways out of business registration.
- **Follow-ups and scores:** no follow-up after "stop"; one introduction, lead notice and follow-up per "Connect me"; scores move once; follow-ups claimed before sending.
- **Results:** address and hours on cards; services called businesses; retail fallback explained with products; wholesale-only stores kept to businesses; product questions reuse only the matching request.
- **Pauses:** who paused a listing is recorded (migration 016), and only our team lifts its own pauses. Pauses, re-checks, call-backs, a new location and removed photos reach the WhatsApp catalog.
- **Launch:** `/privacy` and `/terms`; webhook verification before launch; claims with a registration code, five wrong codes a day per number, and an alert to the team; the website's pre-launch wording.
- **Reliability:** database retries and error handling; stuck jobs judged by when they started, checked every few minutes; recurring jobs booked once; Meta's rate limits retried; storage check at start-up; `railway.json`; CI.
- **Data protection:** complete exports; retention of search words, locations, alerts and idle people's numbers; per-customer feedback private.
- **Security:** tokens after "#", logs without query strings, safe cookie reading, security headers.
- **Uploads:** empty cells keep values; products found by name when they had no code; no duplicate products when a photo fails.

## What's left, in order

1. **A lawyer reviews `/privacy` and `/terms`.** They're plain-English drafts true to what the code does. Set `CONTACT_EMAIL`, add the data protection officer, and register with POTRAZ.
2. **Railway settings:** turn on **Wait for CI** and volume backups. After this deploy, check the logs: if they say photo storage can't be written, set `RAILWAY_RUN_UID=0`. Move photos to R2 before launch.
3. **Decide the WhatsApp wording on listing being free.** The website says nothing about it; WhatsApp still says "list it free" in places, including the step where owners accept the terms.
4. **Try Meta end to end on a test number** before switching `WHATSAPP_TRANSPORT=cloud`: messages, templates, product cards and the catalog.
5. **Later:** related-category searches in one query; a shared lock before running more than one instance.

## The 22 findings that didn't hold up

For the record, these were checked and found to be wrong or already handled: a registration limit per IP, the field agents' wording, the "Verified" promise, editing products on WhatsApp, shutdown during a job tick, delivery failures reported later by Meta, and 16 smaller ones. The terms and privacy notice were judged a launch task rather than a code defect, but the app now serves both anyway.
