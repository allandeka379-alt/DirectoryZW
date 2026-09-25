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

## Milestone 4: launch readiness

- [ ] Meta business verification, two numbers, approved templates (five, listed in the README)
- [ ] Hosting over HTTPS, managed Postgres, backups, monitoring and alerts
- [ ] Photo storage on S3 or Cloudflare R2 instead of local disk
- [ ] Reprocess inbound messages left unhandled after a crash (messages are logged before processing, replies are not yet retried)
- [ ] Rate limits and abuse controls (request floods, photo floods that each cost a Claude call, fake reports); per-person accounts for the ops console instead of one shared token
- [ ] POTRAZ compliance: data-controller licence, retention periods, export and delete on request, cross-border transfer records. This includes the lawful basis for keeping public business details found online, and for sending audio to a speech-to-text provider abroad.
- [ ] A real speech-to-text adapter (Chirp 2 for Shona first), measured on real voice notes
- [ ] Test set of ~300 real requests (English, Shona, mixed) to measure Claude's understanding and try cheaper models
- [ ] Soft launch in Harare with 2,000+ verified businesses

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
- GPS and offline mode need HTTPS (or localhost), so test the field app on a phone through an HTTPS tunnel or a deployed server.
