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
- [x] Voice notes: speech-to-text behind an HTTP contract, so Google Chirp 2 or Meta Omnilingual ASR can plug in. Removed in Milestone 11: typed messages only, for now.
  - The reply starts with "I heard: …".
  - If nothing is understood, which is likely for much Ndebele, the customer is asked to type.
  - The simulator fakes transcription.
  - Works on the business number too.
- [x] Photos, downloaded through WhatsApp's media API and read by Claude vision. Removed in Milestone 11: typed messages only, for now. Price-list items read before then still show on business cards.
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
  - A daily cap on photos and voice notes (each costs a Claude or speech-to-text call). Removed in Milestone 11.
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
- [x] Google Chirp 2 speech-to-text (removed in Milestone 11):
  - Shona, with Zulu standing in for Ndebele.
  - The last request's language is tried first.
  - Tested against a stand-in for Google, not yet against the real API.
- [x] Eval harness for request understanding:
  - 56 synthetic examples in English, Shona and Ndebele.
  - `npm run eval:export` turns real requests into a file to label.
  - `npm run eval -- --claude --model …` compares models.
  - The keyword baseline gets 79% of categories right (60% for Shona, 50% for Ndebele), which is why Claude is the primary interpreter.
- [x] Tests (110)
- [ ] Meta business verification, one number (see Milestone 13), display name, approved templates
- [ ] Hosting set up (Postgres with a tested restore, private bucket, HTTPS domain, alert webhook)
- [ ] POTRAZ data-controller licence and data protection officer; privacy notice and business terms published; confirm the lawful basis for keeping public details of businesses found online, and for sending voice notes abroad for transcription
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
- [x] **Caption-first photos:** a caption the engine understands on its own is used without sending the photo to Claude. Removed in Milestone 11.
- [x] **Field price lists through the Batch API** (half price; removed in Milestone 11): photos are sent every 20 minutes and results saved when the batch ends, with up to three tries. The System screen shows the queue. `PRICE_LIST_BATCH=false` switches it off.
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

## Milestone 10: keeping our promise

The welcome message says verified businesses are genuine and reliable and that we look into every report, and results say verified stores have what the customer asked for. This milestone checks that it stays true.

- [x] **The follow-up asks how it went**: "Yes, sorted", "Not yet" or "It didn't work out". "It didn't work out" asks what happened: "They didn't reply", "Didn't have it" (for stores; "Couldn't help" for services), or "Something else", which the customer tells us as a report.
  - A business that didn't reply or couldn't help ranks lower, and "Other options" leaves it out for that request.
  - When nobody else is left, the customer is offered a person from the team.
- [x] **Track record on the business card**, once five customers have answered: "👍 8 of the last 9 customers we sent them got what they needed" (last 90 days).
- [x] **When our team checked it**, on the card: "✅ Verified by our team in September 2026".
- [x] **Re-checks screen** for the field team. Verified businesses are listed with the reasons:
  - open reports
  - fewer than half of 3+ customers got what they needed
  - 2+ customers said they didn't reply this month
  - an average rating under 3
  - verified over a year ago
  - The team visits or phones them, then records "still good" (renews the tick), "remove ✅" or "pause". Recording it closes the business's open reports.
- [x] **Reports can't sit unread**: the team is alerted once about any report left open for a day. The overview shows how many are waiting.
- [x] Migration 011; tests (172)
- [ ] Re-submit the `follow_up` template if it was already submitted: its third button is now "It didn't work out"
- [ ] Make re-checks part of the field team's week, like call-backs

## Milestone 11: typed messages only, and cheap to run

- [x] **Typed messages only, for now.** Voice notes and photos get a polite "please type" reply on both numbers.
  - Removed: speech-to-text (Google Chirp 2 and the HTTP adapter), Claude reading photos and price lists, the Batch API for field price lists, WhatsApp media downloads, and the daily cap on photos and voice notes.
  - Kept: field agents' photos of businesses (evidence for the team, never read by AI), and price-list items read before this change, which still show on business cards.
  - Claude is now used for one thing only: typed wording the local engine can't read.
- [x] **Hardening, phase 1, so the system is very cheap to run** (the owner's four decisions, 26 September 2026; details in [HARDENING.md](HARDENING.md)):
  - WhatsApp messages stay inside conversations people started, which makes them free:
    - the follow-up goes out 20 hours after "Connect me"
    - lead notices go only while the business's own window is open
    - owners see their week at the top of the menu, and their customers under **My customers**, instead of a Monday summary
  - Paid templates are off unless switched on, and capped per day.
  - Claude: $1 a day and 3 calls per number, a 6-second timeout with one retry, a five-minute break after three failures, and caching only when calls come close together.
  - The handoff inbox shows each chat's reply window and won't send a reply WhatsApp would refuse.
  - **Running costs** on the System screen.
- [ ] Hardening, phase 2: see [HARDENING.md](HARDENING.md).

## Milestone 12: businesses finding suppliers

- [x] **Who a business sells to:** the public, other businesses (wholesale), or both. Owners set it under **Who I sell to**, field agents in the field app, and the team on the business page. Wholesale is for registered businesses only: wholesale-only businesses never show in the public's searches.
- [x] **Find a supplier**, on the business number:
  - An owner types what their business needs ("cement wholesale", "cooking oil in bulk").
  - They get suppliers near their own business that sell to businesses, never their own listings: "We have two suppliers near Mbare that our team has verified, and they have *cement*".
  - The rest works as it does for the public: "Did you mean…?", related suppliers, a person when nothing fits, "Connect me", the follow-up, ratings and reports.
  - The owner's message to the supplier, and the supplier's lead notice, name the business that's asking.
  - When no wholesaler has it, the business gets the retail stores in that line of business instead: "No wholesaler we list has *fridges* yet, so here are retail stores that do." It still counts as a wholesale gap.
- [x] **Supply gaps** show how many requests came from businesses, so field teams can recruit wholesalers.
- [x] Three sample wholesalers for trying it in the simulator.
- [x] Migration 012; tests (172)
- [ ] Field teams mark wholesalers as they register them, and recruit wholesalers where the supply gaps show businesses searching

## Launch measures

The executive review of 26 September 2026 found four soft-launch measures that no screen showed.

- [x] **Launch measures** on the Overview, for the last 30 days, each with its target:
  - follow-up answers that say "Yes, sorted", counting final answers only, as track records do (aim: 60% or more)
  - customers who came back on another day (aim: 25% or more)
  - owners who wrote to us (aim: half or more)
  - connections per verified business, and how many verified businesses got at least one
- [x] Tests (174)

## Milestone 13: one WhatsApp number

The owner's decision, 27 September 2026: one number for everyone. Businesses register on it by typing "I want to register a business".

- [x] **The router** (`src/conversation/router.ts`) picks the side for each message on the number:
  - A tap goes back to the side that sent the button: by WhatsApp's reply context, else by the button's ID.
  - "I want to register a business", "register my shop", "list my business" or "sign up" starts a registration. "Register a company" stays a search, because people look for agents who register companies.
  - "my business" opens the business menu, and claims a listing a field agent registered for that number.
  - While the business side is in the middle of a registration, an edit or a supplier search, and was the last to reply within the hour, it keeps typed messages, its own commands, and "menu", "cancel" or "back".
  - An owner's "delete my data" goes to the business side, which deletes both sides and their listings.
  - Everything else is a customer's search.
- [x] **One reply window.** A message to either side opens WhatsApp's free 24-hour window for both, so a lead notice to an owner who searched recently is free.
- [x] **Wording.** The welcome and help messages tell businesses to type *register my business*. Texts owners keep, like "You're listed!", say *my business*.
- [x] **Settings.** `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_NUMBER` replace the four two-number settings. The webhook takes messages to our number only.
- [x] **Simulator.** Two people side by side, a customer and a business owner, both chatting with the one number.
- [x] **Ops console.** Handoff replies go out on our number. Chats and contacts are marked "customer" or "business", and the launch measure counts owners who wrote to us on either side.
- [x] Tests (183)
- [ ] Native speakers: Shona and Ndebele ways of saying "register my business", for the router once reviewed

## Milestone 14: the website, the business dashboard and the admin portal

Requested on 29 September 2026: a website where businesses register, a web app where they manage products and prices and see their numbers, and an admin portal where the team manages everything. Minimal and modern, dark by default.

- [x] **The website** (`public/site`):
  - A landing page whose hero is a night map of Harare, with customers asking across the city. It says nothing about prices or plans.
  - A three-step registration form. It gives a code, and the owner sends it from WhatsApp: that creates the listing and links it to their phone (`src/web/registration.ts`). A code works for 48 hours, and the form's details are cleared once the listing exists.
- [x] **Signing in to the dashboard without a password** (`src/web/owner-auth.ts`):
  - The owner types *dashboard* on WhatsApp, or asks from the sign-in page while their free reply window is open.
  - They get a one-time link that works for 15 minutes. The page trades it for a 30-day session cookie with a POST, so link previews can't use it up.
- [x] **The business dashboard** (`public/app`):
  - **Overview:** the searches the business came up in, the customers sent to it, its connection rate, a day-by-day chart, what customers asked for, and how complete the catalogue is.
  - **Products:** add or edit one at a time, with a photo shrunk in the browser. Change a price right in the table, mark products in or out of stock, confirm prices are still right, and take products down. Search, filter and sort.
  - **Upload a list** from a CSV file or cells pasted from Excel or Google Sheets:
    - Columns are matched by their headings, and nothing changes until the list has been checked.
    - Up to 25,000 products, sent in batches.
    - Products already listed are updated (by code, else by name); columns left out keep their values.
  - **Change prices** by a percentage or an amount, or set a new price:
    - For chosen products, one category, or everything.
    - Rounded to the cent, 5c, 10c, 50c or dollar, and previewed first.
    - Every price change is kept in the product's history.
  - **Customers** by reference code, **Insights** (what people in the business's categories and city ask for, what nobody could supply, and at what time of day), and the **business profile** with shopfront photos.
- [x] Product names feed WhatsApp search. Results show a product's price with when it was last updated; products out of stock or taken down drop out.
- [x] **The admin portal** (`public/admin`, at `/admin`):
  - The team signs in with their own email and password; businesses never use this sign-in.
  - One sidebar for everything: live chats, reports and people; all businesses, verification, website sign-ups, call-backs, re-checks and customer tips; requests and supply gaps; vocabulary, the word list, and checking and labelling answers; field agents, team accounts and the activity log; health and costs.
  - A business's page shows its owner, their dashboard use, the catalogue and the photos. The team can take a product down (with a reason, kept in the activity log), delete a photo, or sign the owner out of the dashboard everywhere.
  - `/ops` now leads here; the first console stays at `/ops/classic`.
- [x] **Dark by default**, with a light mode anyone can switch to (`public/web/theme.js`). The dashboard and the admin portal share one set of building blocks (`public/web/ui.js`).
- [x] Tests (222)
- [ ] Publish the business terms and privacy notice, and set `BUSINESS_TERMS_URL` and `PRIVACY_URL`: the website and the registration form link to them
- [ ] A photo for the hero, if real shops would sell it better than the map (keep it small: data is expensive)

## Milestone 15: the product engine

Requested on 29 September 2026: make the engine work well, getting products from the dashboard to WhatsApp in real time, with WhatsApp's own product cards.

- [x] **Products are searched on their own, live** (`src/directory/products.ts`):
  - Each product has its own search index: its name counts most, then the owner's category and code, then the description. A store's whole catalogue is searched, however big.
  - Nothing waits for a refresh. A product added, a price changed or "out of stock" on the dashboard is in the very next reply.
  - For goods, any store that lists the item is found, whatever its categories. For a service, only that trade's own listings count: "fridge repair" never shows fridges for sale.
  - Stores that list the item come first, verified before unverified, then stores in the trade that haven't listed it. Wholesale-only stores are for businesses buying stock.
- [x] **Matching that reads product names the way people write them:**
  - Sizes and units are read one way ('55"', "55in" and "55 inch"; "300L" and "300 litres"). It also allows for plurals, other names for an item (fridge, refrigerator, firiji), Shona and Ndebele words through their English meaning, and typos.
  - Two-word items count as one ("washing machine" isn't a sewing machine), in the database's first cut too.
  - The item asked for must be in the product's name or the owner's category for it. The description will do when the name is only a model, like "Capri CF300".
  - A different size isn't a match, and nor is an accessory ("TV stand", "Bracket for 55 inch TV"). A word before the item only describes it ("Stand fan"), and what comes with it is still the item ("TV with free bracket").
- [x] **Replies say what stores list.** "I found *samsung 55 inch tv* at three stores near Avondale, from *$520*", each store's row with its price, and a store's card with up to three matching products and when each price was updated. "Other options" and a store's card read the prices again, so they're never out of date.
- [x] **Alerts** (`src/conversation/alerts.ts`). When nobody listed what someone asked for, and a store near them lists it within a day, they get one message, inside their free window only:
  - Goods only, within 60 km and within their budget. At most one per request, and two a day per person.
  - Never after *stop* or *alerts off* (or the "No more alerts" button); *alerts on* brings them back.
  - Sent a moment after the owner saves, from the job queue.
- [x] **WhatsApp's own product cards** (`src/whatsapp/catalog.ts`):
  - Products with a photo and a price go into our Meta catalog. A change on the dashboard goes within a minute, and only what changed is sent. Out of stock, taken down or a paused store comes out, and so do an erased business's products.
  - If Meta refuses a batch, its products go again at the next sync. A daily check sends anything missed.
  - After the results list, the stores' products follow as cards, with photos and prices ("View items").
  - Writing to us from a card ("Ask about this"), sending a cart, or typing a product's code (P-xxxxxxxx) brings that store's card, ready to connect. We don't take orders: the store sells directly.
  - Each product has a public page (`/p/:id`) and photo (`/media/products/:photoId`), which Meta's catalog needs. The page has an "Ask about it on WhatsApp" link.
- [x] **Admin portal:** "Products on WhatsApp" on Health and costs shows what's in the catalog, what's waiting, what Meta refused and the alerts sent. It has a "Send everything again" button.
- [x] **Simulator:** product cards, with "Ask about this".
- [x] **Settings:** `WHATSAPP_CATALOG_ID`, `PRODUCT_CARDS`, `PRODUCT_ALERTS` and `PRODUCT_ALERT_HOURS`.
- [x] Tests (257)
- [ ] Connect the catalog in Meta's Commerce Manager and set `WHATSAPP_CATALOG_ID` (see [LAUNCH.md](LAUNCH.md)). The catalog calls, cards and carts can only be tried against Meta once the number is approved.
- [ ] Native speakers: more Shona and Ndebele names for items, for the list of other names in `src/directory/products.ts`

## The name, and pre-launch mode

On 29 September 2026 the project was named **FindZim** (`BRAND_NAME`; the GitHub repository and the Railway service keep their old name for now). Production runs on Railway before Meta approves the number, so:

- [x] **Pre-launch mode** (`WHATSAPP_TRANSPORT=off`):
  - The website, the dashboard, the admin portal and the field app run. Nothing goes out on WhatsApp. Meta can verify the webhook, and signed calls are acknowledged and dropped (since the September review).
  - The website says we open on WhatsApp soon and hides the WhatsApp buttons.
  - A website sign-up waits 60 days for the team, who call the owner and **List it** from the admin portal.
  - Admins hand owners a one-time dashboard link from the business's page. It works for a day, and the business's own number becomes its owner.
- [x] Tests (261)
- [x] Live before Meta: the app on Railway (positive-love) behind `https://findzim.vercel.app` (see [DEPLOY.md](DEPLOY.md))
- [x] Our own address, `https://findzim.com` (1 October 2026): DNS at Namecheap points it at Vercel; `www` and the vercel.app address redirect to it, and `PUBLIC_BASE_URL` uses it
- [ ] Switch to `WHATSAPP_TRANSPORT=cloud` once Meta's settings are in

## Photos in bulk

Requested on 29 September 2026, so that big catalogues like Halsteds' come with their photos.

- [x] **Photo links in the product upload.** The upload has a "Photo link" column, and so does the template:
  - The check counts the photos to fetch and names any link that isn't a web address. Those products are imported without a photo.
  - After the import, the server fetches the photos in the background (`src/web/photo-links.ts`). It takes a few at a time, and at most three per business in a round, so one store's big list doesn't hold up another's.
  - Only from the public internet: never this machine or a private network, whether the link gives an address or a name, and redirects are checked too. At most 15 MB and 20 seconds a step.
  - Each photo is made 1280 pixels at most, as a JPEG (with `sharp`), like one added by hand. See-through photos go on white.
  - A link that may work later is tried again after 5, then 10 minutes.
  - The Products page shows how many photos are on their way, and which links didn't work and why, with **Try them again** and **Clear the list**.
  - Uploading the same list again doesn't fetch what's already there, and a link never replaces a photo the owner added by hand.
- [x] **Many photo files at once:** **Add photos** on the Products page.
  - Photos are matched to products by their file names: the product's code or its name, allowing for a copy number ("CEM-50 (2).jpg").
  - The owner chooses the product for any that didn't match.
  - Each photo is made smaller in the browser before it's sent, three at a time.
- [x] Tests (275)

## The September 2026 review

On 30 September 2026 the whole project was reviewed: 230 findings, of which the 70 most serious were checked against the code (48 held up). The report and ratings are in [REVIEW.md](REVIEW.md). Fixed:

- [x] **Conversations that got stuck or went wrong:**
  - Typing "I agree" (or "yes", "ndinobvuma", "ngiyavuma") after the notice counts as agreeing.
  - A place we don't know keeps the request and says so; "anywhere" searches without a place; a new request typed instead of a place is a new request.
  - Questions we asked (where, which one, what went wrong, a recommendation's details) lapse an hour after the customer's last message, so a search typed hours later is never filed as a report. A shared location is used for 12 hours.
  - While a person handles the chat, "stop", "alerts off" and taps on our follow-ups still work.
  - "No" to a recommended business's number means not knowing it.
  - "Yes", "not yet" or "no" typed under the follow-up count as its buttons.
  - Reactions get no reply; stickers, videos and documents get "please type" instead of the help text, on both sides.
  - "back", "exit", "menu" and "help" work halfway through registering a business.
- [x] **Follow-ups and scores:** "stop" also stops the follow-up for businesses contacted before it; "Connect me" tapped twice gives the same link, one lead notice and one follow-up; tapping "Yes, sorted" again never moves a business's score twice; the follow-up is claimed before it's sent, so it's never sent twice.
- [x] **Results:** cards show the street address and opening hours; service businesses aren't called stores; a business's supplier search that falls back to retail says so with products too; wholesale-only stores never reach the public through product codes; asking about one product reuses only a request that showed that product.
- [x] **Pauses:** a listing paused after customer reports, a failed call-back or a re-check can't be switched back on by its owner, on WhatsApp or the dashboard (migration 016, `paused_by`). Pauses, re-checks, call-backs, a new location and a photo removed by the team now reach the WhatsApp catalog too.
- [x] **Launch:** the privacy notice (`/privacy`) and business terms (`/terms`) are served by the app, linked from WhatsApp and the website (`CONTACT_EMAIL`). The webhook can be verified before launch. A listing our team made from a website sign-up is claimed by whoever sends its code first (the team is alerted), and a number can send five wrong codes a day. The website no longer tells pre-launch visitors to use WhatsApp.
- [x] **Reliability:** start-up waits for the database; a dropped database connection, an unhandled rejection or an uncaught exception no longer kills the process silently; jobs left running by a crash go back in the queue by when they started, every few minutes; recurring jobs can't multiply after a failure; Meta's rate limits are retried; photo storage is checked at start-up; `railway.json` sets the health check and restarts; CI runs the tests (`.github/workflows/ci.yml`).
- [x] **Data protection:** exports include everything held; after `REQUEST_RETENTION_DAYS` requests lose their search words and location, alerts go, and people who haven't written lose their number and name; owners no longer see how each customer answered our follow-up or rated them.
- [x] **Security:** sign-in tokens travel after "#" and logs drop query strings; a mangled cookie is no session instead of a server error; responses forbid framing and content sniffing.
- [x] **Speed:** indexes for lookups by person and by photo (migration 016); the business search keeps the right 300 candidates when there are more.
- [x] **Uploads:** an empty cell keeps what's listed ("ask" takes a price off); a product listed without a code is found by its name; the add-product form never adds a product twice when its photo fails.
- [x] **Tests for what had none:** the Cloud API transport and the catalog's batch calls against responses shaped like Meta's, and one person's messages handled in order.
- [x] Tests (308)

Still to do:

- [ ] A lawyer reviews `/privacy` and `/terms`; set `CONTACT_EMAIL`; register with POTRAZ.
- [ ] Decide the WhatsApp wording about listing being free (the website says nothing about it; WhatsApp still says "list it free" in places, including the terms step).
- [ ] Railway: turn on **Wait for CI** and volume backups; if the logs say photo storage can't be written, set `RAILWAY_RUN_UID=0`; move photos to R2 before launch.
- [ ] Related-category searches in one query instead of one per category.

## The website, redesigned (1 October 2026)

The user found the website flat, with no pictures. It now shows the product working instead of describing it:

- [x] **Hero:** a phone where a customer asks for a fridge in Avondale and gets three stores with product pictures, prices, distance and a Verified mark, then a reference code; beside it, the first message the shop receives. Behind it, a redrawn night map of Harare that never reaches the text.
- [x] **One colour language:** amber for a customer asking (pins, request chips, reference codes), green for a business answering.
- [x] **New sections:** example requests in customers' own words with the categories we cover, and "Verified means we went there" with a seal.
- [x] **Every claim has a picture:** mini screens for the three steps, the dashboard in a browser frame, micro-visuals on each feature, the founding partners' catalogue and monthly report as paper sheets.
- [x] **Register page:** a preview of how customers will see the listing, and what happens next.
- [x] Hand-written SVG, CSS and a 3 KB optional script (`public/site/assets`, served at `/assets/site/...`): the page works without JavaScript, follows dark and light, and stays still under reduced motion. About 27 KB compressed for the page and stylesheet.
- [x] Files are revalidated with ETags, so a returning visitor downloads only what changed.
- [x] **Photos of the formal sector** (same day, after the user's feedback): a hero of a customer asking on her phone in a store, with the chat showing the stores that answer; tiles for pharmacies, furniture showrooms, tiles and building supplies, and solar installers; a shop owner in the trust section; the Harare business district behind the closing call to action; a shop owner at his counter on the register page. No street vending, markets or roadside repairs. Licences and credits in [PHOTO_CREDITS.md](PHOTO_CREDITS.md).
- [x] **A lighter hero:** one headline, one line, one button. The pre-launch note moved to the closing section.
- [x] **Dark mode only**, everywhere: the website, the business dashboard, the admin portal and the field app. The light theme and every switch are gone.

## Executive dashboards (2 October 2026)

The user asked for executive-level dashboards "like the one made by PowerBI", for the team and for the businesses that register. Details and definitions: [DASHBOARDS.md](DASHBOARDS.md).

- [x] **A shared chart kit** (`public/app/viz.js`, `viz.css`), plain SVG with no dependencies:
  - stat tiles with change and sparkline, and trend lines against the period before;
  - columns, ranked bars, part-to-whole bars, a funnel, heatmaps, a bubble map and meters;
  - a Chart/Table switch and CSV on every card, and Save as PDF.
  - Colours are validated for colour-blind readers on the dark card.
- [x] **Periods:** 7, 30 or 90 days by day, or 12 months by week, in Harare days. Each is compared with the period before; the day in progress is drawn lighter.
- [x] **The business dashboard:**
  - **Overview:** six tiles, the trend, the funnel from demand to customers, products that bring customers, follow-up answers, distance to customers, and catalogue health. How a shop's prices compare with other stores' was built, then taken out at the user's request: owners see nothing about other stores.
  - **Insights:** market size and share, what people ask for, searches the shop missed (with "Add it" only when it doesn't list the thing), when people ask, and where.
  - **Customers:** a daily chart and a CSV download.
- [x] **The admin portal:**
  - **Overview:** the executive summary.
  - **Demand, Supply and Customer experience** reports.
  - Filters for city and category in the address, cross-filtering by clicking, a map of towns and suburbs, a demand-against-supply table, "where to sign up next", a leaderboard, a needs-attention list and weekly cohorts. This covers the traffic-by-category screen the solar plan needed.
- [x] **Sample activity for trying it:** `npm run db:demo` (local database only), and the `findzim-demo` preview on port 3001.
- [x] Migration 017 (indexes); 11 new tests.

## Later: monetization (only after traction)

- [ ] Featured placement, lead credits and sponsored slots, as priced in the feasibility study
- [ ] Credit top-ups through Paynow
- [ ] "Basic listing free forever" stays true

## Known limitations

- Area coordinates are approximate centroids; refine them from field GPS pins.
- Results say a verified store "has" what the customer asked for because our team checked what it sells (its categories), not its stock of that model. The customer's message to the store names the item, so the store answers about stock.
- The related-categories list is a first draft: review it with the field team, especially across groups (solar to electricians, catering to restaurants).
- The product matcher's word lists (other names for an item, accessories, two-word items) are a first draft. Extend them from the requests the team labels.
- Product cards, carts and the catalog's batch calls follow Meta's documentation but haven't run against Meta yet, because the number isn't approved. Try them on a test number first.
- The field name for WhatsApp's business-scoped user IDs is unconfirmed; the parser accepts `from` and `from_user_id`.
- Simulator messages live in memory and reset when the server restarts; the database persists.
- Run a single instance: messages from each person are kept in order in memory, and the login lockout and alert throttling are in memory too.
- The Shona word list and the eval examples were both written by the developers, so the eval shows what's possible, not real-world accuracy. Labelled real requests (Phase 3) will show the real numbers.
- GPS and offline mode need HTTPS (or localhost), so test the field app on a phone through an HTTPS tunnel or a deployed server.
