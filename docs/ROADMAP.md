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
- [ ] Price list from a photo (Claude vision). Needs WhatsApp media download, so it moves to Milestone 3.

## Milestone 3: answer more requests

- [ ] "Found online" results from web search when nothing is listed, labelled unverified, stored only long enough for the field team to invite the business
- [ ] Voice notes: speech-to-text for Shona (Google Chirp 2 or Meta Omnilingual ASR), with a fallback for Ndebele
- [ ] Photos: "find me this" search and price lists read into listings (WhatsApp media download + Claude vision)
- [ ] Shona and Ndebele replies
- [ ] Semantic search (pgvector) alongside keywords; taxonomy grows from unanswered requests
- [ ] Customer recommendations ("know someone good?") feeding the field team's list

## Milestone 4: launch readiness

- [ ] Meta business verification, two numbers, approved templates (five, listed in the README)
- [ ] Hosting over HTTPS, managed Postgres, backups, monitoring and alerts
- [ ] Photo storage on S3 or Cloudflare R2 instead of local disk
- [ ] Reprocess inbound messages left unhandled after a crash (messages are logged before processing, replies are not yet retried)
- [ ] Rate limits and abuse controls (request floods, fake reports); per-person accounts for the ops console instead of one shared token
- [ ] POTRAZ compliance: data-controller licence, retention periods, export and delete on request, cross-border transfer records
- [ ] Test set of ~300 real requests (English, Shona, mixed) to measure Claude's understanding and try cheaper models
- [ ] Soft launch in Harare with 2,000+ verified businesses

## Later: monetization (only after traction)

- [ ] Featured placement, lead credits and sponsored slots, as priced in the feasibility study
- [ ] Credit top-ups through Paynow
- [ ] "Basic listing free forever" stays true

## Known limitations

- Area coordinates are approximate centroids; refine them from field GPS pins.
- Replies are in English only.
- The field name for WhatsApp's business-scoped user IDs is unconfirmed; the parser accepts `from` and `from_user_id`.
- Simulator messages live in memory and reset when the server restarts; the database persists.
- GPS and offline mode need HTTPS (or localhost), so test the field app on a phone through an HTTPS tunnel or a deployed server.
