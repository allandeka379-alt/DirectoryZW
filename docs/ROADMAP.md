# Roadmap

Follows the plan and the feasibility study: a free WhatsApp directory for everything, with field teams, unverified businesses shown only to fill gaps, and payments left out until there's traction.

## Milestone 1: working conversation loop (done)

- [x] WhatsApp webhook: signature checks, parsing, delivery statuses, duplicate protection
- [x] Messages built within WhatsApp's limits; approved templates once the 24-hour window has closed
- [x] Local simulator with customer and business chats
- [x] Category taxonomy (about 80 categories, including high-scam, restricted and blocked), Zimbabwe place names
- [x] Search: verified first, unverified only to fill gaps, distance limit, high-scam verified-only
- [x] Customer flow: consent, request understanding, asking where, results, business card, Connect me with a reference code, lead notification, follow-up and rating, reports, ask around, handoff to a person
- [x] Business flow: self-registration, summary, pause, resume, remove, answering ask-around requests, claiming a field-registered listing
- [x] Claude interpreter (structured output, prompt caching, refusal fallbacks) with keyword fallback
- [x] Ops API: summary, supply gaps, handoffs, replies, reports, field registration, verification
- [x] Tests (40) and a production build

## Milestone 2: field and ops tools (done, except reading price lists from photos)

- [x] Field app: works offline and installs to the home screen. It captures a GPS pin with accuracy, up to 3 business photos, the premises and ID checklist (no ID copies stored) and the owner's consent. It checks for duplicates, queues registrations and uploads them when there's signal.
- [x] Agent accounts with one-time setup links; new link or deactivate from the ops console
- [x] Field quality control:
  - call-back sample per agent, with outcomes; a failed call-back hides the listing
  - per-agent stats: registrations, verified share, call-back pass rate, businesses that later got customers
- [x] Ops console: overview, handoff inbox (reply, hand back), supply gaps, reports, verification queue, call-backs, agents, business browser with photos
- [x] Weekly business summaries every Monday 08:00, only to businesses with activity
- [x] Business number: several listings per owner, update what you sell (re-categorised) and your location
- [x] Tests (53)
- [x] Price list from a photo, done in Milestone 3

## Milestone 3: answer more requests (done, except translated replies and semantic search)

- [x] "Found online": Claude's web search runs when nothing is listed, never for high-scam categories.
  - Results are labelled unchecked and connect by link only; the business isn't messaged.
  - Each result is checked: a Zimbabwe mobile number, and a source site the search returned.
  - Finds are reused for the same category nearby, and each customer has a daily limit on searches.
  - Finds are kept 30 days for the field team to invite, then deleted. A business that declines stays out of results (only a hash of its number is kept).
- [x] Voice notes: speech-to-text behind an HTTP contract, so Google Chirp 2 or Meta Omnilingual ASR can plug in.
  - The reply starts with "I heard: …".
  - If nothing is understood, which is likely for much Ndebele, the customer is asked to type.
  - The simulator fakes transcription.
  - Works on the business number too.
- [x] Photos, downloaded through WhatsApp's media API and read by Claude vision:
  - "Find me this" search from a photo and its caption.
  - Price lists read into listings. Owners confirm before saving; field agents' price-list photos are read in the background.
  - Customers see matching prices on business cards, and price-list items are searchable.
- [x] Customer recommendations ("recommend"), listed for the field team under Tips in the ops console
- [x] The taxonomy grows from unanswered requests:
  - The ops console lists searches that matched no category.
  - Adding a word to a category takes effect immediately and survives reseeding.
- [x] Offline interpreter ignores common Shona and Ndebele filler words ("ndoda", "ku", "ngifuna")
- [x] Tests (81)
- [ ] Shona and Ndebele replies. Deferred: the copy needs native-speaker translation and review, not machine translation. The interpreter already detects the language, so this is wiring once translations exist.
- [ ] Semantic search (pgvector). Deferred: it needs an embeddings provider (Anthropic doesn't offer one) and real request data to show it beats keywords plus the growing synonym list. Revisit with the 300-request test set in Milestone 4.

## Milestone 4: launch readiness (code done; the rest is accounts, approvals and people, see [LAUNCH.md](LAUNCH.md))

- [x] Nothing is lost:
  - Incoming messages are saved before Meta gets its 200, and anything a crash or restart left unhandled is handled again.
  - A message that keeps failing is dropped after three tries, and the team is alerted.
  - Replies that fail for temporary reasons (network, rate limits, Meta errors, a rejected token) are resent from the job queue.
- [x] Abuse controls:
  - Message limits per number, per minute and per day.
  - A daily cap on photos and voice notes (each costs a Claude or speech-to-text call).
  - A daily cap on reports, which count for more when the reporter contacted the business through us. Several such reports pause a listing and alert the team.
  - Numbers can be blocked from the console.
- [x] Ops console accounts:
  - One account per person, with admin and staff roles, scrypt passwords, lockout after wrong passwords, and sessions that end when a password changes.
  - An activity log of who did what.
  - People, Team, Activity, System and Account screens. The shared token remains for scripts.
- [x] Data protection in code:
  - "Delete my data" on both numbers, and export and delete from the console.
  - A daily retention clean-up (chats 180 days; request wording 365 days).
  - [DATA_PROTECTION.md](DATA_PROTECTION.md) records the data, the processors abroad and how requests are handled.
- [x] Hosting:
  - Photo storage on S3 or Cloudflare R2.
  - A Dockerfile, and `/health` and `/ready` checks.
  - Alerts to a chat webhook, and a System screen.
  - Production requires Postgres.
  - [DEPLOY.md](DEPLOY.md) covers backups and monitoring.
- [x] Message templates defined in code; `npm run templates` submits them and checks approval
- [x] Google Chirp 2 speech-to-text:
  - Shona, with Zulu standing in for Ndebele.
  - The last request's language is tried first.
  - Tested against a stand-in for Google, not yet against the real API.
- [x] Eval harness for request understanding:
  - 56 synthetic examples in English, Shona and Ndebele.
  - `npm run eval:export` turns real requests into a file to label.
  - `npm run eval -- --claude --model …` compares models.
  - The keyword baseline gets 79% of categories right (60% for Shona, 50% for Ndebele), which is why Claude is the primary interpreter.
- [x] Tests (110)
- [ ] Meta business verification, two numbers, display names, approved templates
- [ ] Hosting set up (Postgres with a tested restore, private bucket, HTTPS domain, alert webhook)
- [ ] POTRAZ data-controller licence and data protection officer; privacy notice and business terms published; confirm the lawful basis for keeping public details of businesses found online, and for sending voice notes abroad for transcription
- [ ] Chirp 2 checked against 50 real voice notes (Shona, Ndebele, English)
- [ ] About 300 real requests labelled; compare Claude models and pick the cheapest that scores as well
- [ ] Soft launch in Harare with 2,000+ verified businesses

## Next: understand requests locally, pay for Claude only when stuck

Design in [UNDERSTANDING.md](UNDERSTANDING.md). Target: 80% or more of requests understood without Claude, and Claude spend down about 80%.

- [ ] Phase 1: router with confidence bands; greetings, help and blocked words never reach Claude; small-model escalations with thinking off; spend metering and a daily budget; phrasebook from Claude's answers; "ask first" before web searches; category picker instead of Claude at registration and for tips
- [ ] Phase 2: local engine v2 (normalising, word roles, word forms, fuzzy spelling, Shona and Ndebele vocabulary reviewed by native speakers, action rules), "Did you mean…?" questions, vocabulary suggestions, weekly precision review
- [ ] Phase 3: thresholds and escalation model tuned on about 300 labelled real requests; optional small local classifier; caption-first photos; field price lists through the Batch API

## Later: monetization (only after traction)

- [ ] Featured placement, lead credits and sponsored slots, as priced in the feasibility study
- [ ] Credit top-ups through Paynow
- [ ] "Basic listing free forever" stays true

## Known limitations

- Area coordinates are approximate centroids; refine them from field GPS pins.
- Replies are in English only.
- Customers' photos aren't stored, so a person taking over a chat sees Claude's description of the photo, not the photo itself.
- Web search results depend on what Zimbabwean businesses publish online, mostly Facebook pages and directories, so coverage outside the big towns will be thin.
- The field name for WhatsApp's business-scoped user IDs is unconfirmed; the parser accepts `from` and `from_user_id`.
- Simulator messages live in memory and reset when the server restarts; the database persists.
- Run a single instance: messages from each person are kept in order in memory, and the login lockout and alert throttling are in memory too.
- Voice notes longer than a minute fail with Google's synchronous recognition (the person is asked to type instead).
- The keyword fallback confuses brands with categories ("honda fit gearbox" looks like buying a car); the eval shows these misses.
- GPS and offline mode need HTTPS (or localhost), so test the field app on a phone through an HTTPS tunnel or a deployed server.
