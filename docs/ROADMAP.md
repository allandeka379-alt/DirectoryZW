# Roadmap

Follows the plan and the feasibility study: a free WhatsApp directory for everything, with field teams, unverified businesses shown only to fill gaps, and payments left out until there's traction.

## Milestone 1: working conversation loop (done)

- [x] WhatsApp webhook: signature checks, parsing, delivery statuses, duplicate protection
- [x] Messages built within WhatsApp's limits; approved templates once the 24-hour window has closed
- [x] Local simulator with customer and business chats
- [x] Category taxonomy (about 80 categories, including high-scam, restricted and blocked), Zimbabwe place names
- [x] Search: verified first, unverified only to fill gaps, distance limit, high-scam verified-only
- [x] Customer flow: consent, request understanding, asking where, results, business card, Connect me with a reference code, lead notification, follow-up and rating, reports, ask around (removed in Milestone 5), handoff to a person
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

## Milestone 3: answer more requests (done, except semantic search; replies stay in English)

- [x] "Found online": Claude's web search runs when nothing is listed, never for high-scam categories. (Removed in Milestone 5.)
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
- [x] Replies in English. Decided in Milestone 9: the assistant reads Shona and Ndebele and always answers in English, so no translations are needed.
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

## Milestone 5: understand requests locally, pay for Claude only when stuck

Design in [UNDERSTANDING.md](UNDERSTANDING.md). Target: 80% or more of requests understood without Claude.

- [x] Phase 1: understand locally first, and keep Claude to a budget
  - Every request goes through the understanding ladder: the local engine, then the phrasebook, then Claude, then a person.
  - The local engine settles greetings, help, "agent", off-topic questions, blocked items and clear requests. Unknown words in Shona or Ndebele, or in a high-scam category, send a request on rather than risking a wrong answer.
  - On the 56 test requests, 46% are answered locally, all correctly.
  - Claude is the backup. It gets the local notes, runs with thinking off, and uses `claude-sonnet-5` by default. Every call is costed, with a daily budget, a per-number cap, and alerts at 80% and 100%.
  - The phrasebook remembers Claude's answers, so the same wording never costs twice.
  - Business sign-up and customer tips never use Claude: owners pick a category from a list when their description doesn't match.
  - The System screen shows Claude spend and how requests were understood and matched.
- [x] Suppliers first, then people:
  - When nobody in the category is nearby, the customer gets suppliers in related categories, a curated list (a gadget nobody lists goes to the electronics shops).
  - When nothing fits, a person takes over in the same reply.
  - Requests nobody understands are asked once more, then handed over.
  - Related-only and handed-over requests count as supply gaps.
- [x] Removed "found online" web search, and ask-around (related suppliers do its job), with their tables and two message templates
- [x] Tests (114)
- [x] Phase 2: done for English and Shona in Milestone 6
- [x] Phase 3 tools: done in Milestone 8 (the tuning itself needs about 300 labelled real requests)

## Milestone 6: the local engine reads Shona (Phase 2, Shona first)

- [x] **A lexicon.** Every word has a role: service, product, general word, brand, occasion, action, detail or filler.
  - It's stored in the database and editable in the ops console; each category's own words work as before.
  - Brands, occasions and general words only narrow: "tyres for a Toyota Corolla" is car parts, not a car for sale.
- [x] **Shona word shapes:**
  - joining prefixes: "keke remuchato" (wedding cake), "matende nemacheya" (tents and chairs). A word joined by "of" only describes the main word: "nyama yemombe" is meat, not cattle.
  - the plural "ma-" on borrowed words ("matyres", "maplumber")
  - verb roots with their prefixes and endings: "anogadzira", "yekuroja", "kutengeswa", "mupendi"
  - place prefixes: "kuMabelreign", "eNkulumane"
  - common spelling variations: bh/b, zv/z, l/r
- [x] **A first Shona word list** of about 460 words and verb roots, written by the developers as drafts.
  - A draft word only leads to a "Did you mean…?" question until a native speaker approves it (Word list screen, or the spreadsheet).
  - `LEXICON_TRUST_DRAFTS=true` uses the drafts as if approved.
- [x] **Action rules** (`src/ai/rules.ts`): repair or make, hire, buy, move, dig, build, paint, sew, clean, wash, cook, send, applied to the kind of thing named. "Anogadzira fridge" is appliance repairs; "chairs for hire" is event hire.
- [x] **Everyday spellings and typos:**
  - English word forms ("installer", "drilling")
  - texting spellings ("pls", "2moro", "55inch")
  - misspellings ("plumbar", "Mabelrein")
  - several places in one message ("Hillside, Bulawayo")
- [x] **"Did you mean…?"** when one to three categories fit, or the words aren't approved yet: the customer taps instead of a Claude call.
  - Typed answers count ("to hire", "yes").
  - The answer is remembered for that wording, so the next customer isn't asked.
  - "Something else" goes to Claude, told what's ruled out; then "say it differently", then a person.
- [x] **The team teaches the engine:**
  - "Teach the assistant" on a handoff
  - the weekly **Check answers** screen: a random sample of its own answers, and a wrong one is fixed for that wording at once
  - adding and correcting words in the **Word list**
  - A person's answer beats even a confident local reading.
- [x] **Suggested words:** words customers used, with what they turned out to mean.
- [x] **System screen:** questions asked and answered, answers checked, and the word list's review status.
- [x] **Business sign-up and tips** read Shona descriptions too ("Tinogadzira mafiriji", we repair fridges).
- [x] **Eval:** 117 requests (56 Shona).
  - With the drafts unreviewed: 57% answered locally, 39% get a question with the right option, 3% passed on, none confidently wrong.
  - With the Shona words approved: 93% answered locally, all right.
- [x] `npm run explain` shows how a message is read, word by word.
- [x] Tests (139)
- [ ] A native speaker reviews the Shona word list ([WORD_LIST.md](WORD_LIST.md))
- [x] Ndebele word list and word shapes (Milestone 7)
- [x] Out-of-hours handoff messages, spotting frustration, a "not what I asked" button on results (Milestone 7)

## Milestone 7: Ndebele, and the rest of Phase 2

- [x] **Ndebele word shapes** (`src/ai/ndebele.ts`):
  - noun prefixes, including on borrowed words ("ifriji", "ifridge", "amatyres")
  - "of" and "and" forms that swallow the next word's first vowel: "ikhekhe lomtshado" (wedding cake), "inyama yenkomo" (beef: meat of cattle, so it's a butchery, not livestock)
  - e- and -ini for places ("eNkulumane", "emtshadweni")
  - verb roots with their prefixes and endings: "olungisa" (who repairs), "ukuqasha" (to hire), "owakha" (who builds), "umthengisi" (a seller)
- [x] **A draft Ndebele word list** of about 300 words and roots, for native speakers to review like the Shona list.
- [x] **Shona or Ndebele?** Each message is weighed by which language has more of its own words.
- [x] **Handoff messages say when a person will reply:** "soon" during the team's hours (`TEAM_HOURS`, default Monday–Saturday 8am–6pm), otherwise "our team is back at 8am tomorrow" or "on Monday".
- [x] **Frustration:** "you don't understand", "useless", "hauna kunzwisisa", "awuzwisisi"… hand the chat to a person at once, and the last request goes to the weekly check.
- [x] **"Not what I asked for"** under results:
  - The customer can say it again or talk to a person; if it's still not understood, a person takes over.
  - The request comes first in **Check answers**.
- [x] **Eval:** 159 requests (56 Shona, 48 Ndebele), every category right.
  - Drafts unreviewed: 98% of English answered locally; 79% of Shona and Ndebele get a question with the right option.
  - Words approved: 97% answered locally.
- [x] Migration 007; tests (147)
- [ ] Native speakers review the Shona and Ndebele word lists ([WORD_LIST.md](WORD_LIST.md))
- [ ] Set `TEAM_HOURS` to the team's real hours

## Milestone 8: tuning on real traffic (Phase 3 tools)

- [x] **Label requests** screen: the team labels a random sample of real requests (what the customer wanted). It shows how often each step of the ladder was right, and a correction teaches the phrasebook.
  - `npm run eval:export -- --labelled` makes the eval's answer key from the labels.
- [x] **Thresholds as settings:** `LOCAL_UNKNOWN_WORDS` (unknown words a straight answer may have, per language) and `LOCAL_CLASSIFIER_MIN`.
  - `npm run eval -- --tune` shows each value's coverage and precision, and suggests the best at 98% precision.
- [x] **Choosing Claude's model:** `npm run eval -- --claude --model a,b` compares models on the requests the local engine passes on, with accuracy and cost per 100 customer requests.
- [x] **The word-shape classifier:** for words the rules don't know, the known word most like each one ("fotographer" → "photographer").
  - It only offers "Did you mean…?" options; its guesses go through the action rules.
  - It learns from category words, the lexicon, the phrasebook and the labels, and is retrained hourly.
- [x] **Caption-first photos:** a caption the engine understands on its own is used without sending the photo to Claude.
- [x] **Field price lists through the Batch API** (half price): photos are sent every 20 minutes and results saved when the batch ends, with up to three tries. The System screen shows the queue. `PRICE_LIST_BATCH=false` switches it off.
- [x] **Targets on the System screen:** understood without Claude, Claude calls per 100 requests, handoffs, the weekly check, labelling progress.
- [x] **Eval:** 171 requests, including 12 misspellings. None is confidently wrong; the classifier turns 4 of the 10 it could help with into the right question.
- [x] Migration 008; tests (159)
- [ ] Label about 300 real requests, run the tuning and the model comparison, and set `LOCAL_UNKNOWN_WORDS`, `LOCAL_CLASSIFIER_MIN` and `CLAUDE_MODEL` from the results

## Milestone 9: English replies, and results that say who we verified

- [x] **Every reply is in English**, whatever language the customer writes in.
  - Claude's clarifying questions and "needed by" are in English.
  - Replies repeat the customer's words only when they wrote in English. A Shona or Ndebele request is named by its English category ("ndoda keke remuchato" → *cakes and baking*).
- [x] **Results say which businesses our team verified**, so customers can trust them:
  - Goods: "We have three stores near Avondale that our team has verified, and they have *iphone 18 pro max*. Tap one to connect with them."
  - Services say what the businesses offer: "We have two businesses near Mabelreign that offer *plumbing services*, and our team has verified them."
  - Businesses that listed themselves still fill gaps. They're counted apart ("Two more listed themselves and haven't been checked by our team yet"), in their own "Not checked yet" section, with the deposit warning.
  - "Where should I look for…", the related-categories message and the handoff when nobody is listed use the same words.
  - `src/db/seed-data/categories.ts` lists which categories sell goods (`goodsCategories`) and how replies name each category (`categoryPhrases`). A request for goods is named in the customer's words, or by the category's phrase when their words only name a kind of shop ("butcher" → *meat*) or aren't in English.
- [x] **The welcome message says why verified businesses can be trusted:** "✅ Every business we verify is visited in person by our team, and we check who runs it, so you know it's genuine and reliable. Customers rate the businesses they contact, and we look into every report."
- [x] Migrations 009 and 010; tests (165)

## Later: monetization (only after traction)

- [ ] Featured placement, lead credits and sponsored slots, as priced in the feasibility study
- [ ] Credit top-ups through Paynow
- [ ] "Basic listing free forever" stays true

## Known limitations

- Area coordinates are approximate centroids; refine them from field GPS pins.
- Results say a verified store "has" what the customer asked for because our team checked what it sells (its categories), not its stock of that model. The customer's message to the store names the item, so the store answers about stock.
- Customers' photos aren't stored, so a person taking over a chat sees Claude's description of the photo, not the photo itself.
- The related-categories list is a first draft: review it with the field team, especially across groups (solar to electricians, catering to restaurants).
- The field name for WhatsApp's business-scoped user IDs is unconfirmed; the parser accepts `from` and `from_user_id`.
- Simulator messages live in memory and reset when the server restarts; the database persists.
- Run a single instance: messages from each person are kept in order in memory, and the login lockout and alert throttling are in memory too.
- Voice notes longer than a minute fail with Google's synchronous recognition (the person is asked to type instead).
- The Shona word list and the eval examples were both written by the developers, so the eval shows what's possible, not real-world accuracy. Labelled real requests (Phase 3) will show the real numbers.
- GPS and offline mode need HTTPS (or localhost), so test the field app on a phone through an HTTPS tunnel or a deployed server.
