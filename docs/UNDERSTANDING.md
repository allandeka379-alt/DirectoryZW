# Understanding requests: local first, Claude when stuck, people last

**Goal:** our own engine understands normal requests, for free and instantly. It calls Claude only for messages it genuinely can't read, and hands to a person when Claude can't either. Every hard case it sees once should be easy the next time.

**Status:** Phases 1 and 2 are built (Milestones 5 to 7). Phase 3's tools are built (Milestone 8); running them needs real traffic: about 300 labelled requests. Since this was written, three decisions changed it:

- **No web search.** "Found online" is gone. We're building up our own suppliers.
- **Nothing found means suppliers first, then people.** When no supplier in the category is nearby, the customer gets suppliers in related categories (a gadget nobody lists goes to our electronics shops). When nothing fits, a person takes over in the same reply.
- **Draft word lists.** The developers wrote the starting Shona and Ndebele lists, not native speakers. So a draft word can only ever lead to a "Did you mean…?" question, never a straight answer, until a native speaker approves it ([WORD_LIST.md](WORD_LIST.md)).

## Summary

- Before Milestone 5, every free-text message went to Claude Opus 5, including "hi", "thanks" and business descriptions at registration. Photos, price lists and "found online" searches called Claude too.
- A request costs about half a US cent on Opus. The expensive events were web searches (about 15 cents each, now removed) and price lists (about 5 cents).
- The design is a ladder of five steps. Each message stops at the first step that understands it:
  1. **Structured input** (buttons, lists, commands).
  2. **Local engine** (vocabulary, rules and a confidence score).
  3. **Phrasebook** (everything resolved before).
  4. **Ask the customer** (two or three close options, as buttons).
  5. **Claude**, then **a person**.
- Every answer from steps 4 and 5 is saved, so the local engine keeps getting better. Claude calls should fall week by week.
- Expected effect at 10,000 conversations a month: Claude spend falls from about **$100 to about $10**. Web search, which would have added about $180, is gone.
- After that, WhatsApp's own per-message charges (from October 2026) are the bigger bill. So the design avoids adding conversation turns just to save a Claude call.

## 1. Where Claude is used today, and what it costs

Prices are per million tokens as of 25 September 2026 (claude.com/pricing):

| Model | Input | Cached input | Output |
| --- | --- | --- | --- |
| Opus 5 | $5 | $0.50 | $25 |
| Sonnet 5 | $2 | $0.20 | $10 |
| Haiku 4.5 | $1 | $0.10 | $5 |

The Batch API halves every price, and web search adds $10 per 1,000 searches.

| Event | Today | Cost each on Opus 5 | On Sonnet 5 |
| --- | --- | --- | --- |
| Customer text message (anything that isn't a button, command or answer to our question) | Always Claude | ~$0.005 (2,900-token cached prompt, ~100-token answer, plus thinking tokens: thinking isn't switched off) | ~$0.002 |
| Business description at registration or edit; customer tips | Always Claude | ~$0.005 | ~$0.002 |
| Customer photo (removed in Milestone 11) | Always Claude | ~$0.012 (~1,600 image tokens) | ~$0.005 |
| Price-list photo (removed in Milestone 11) | Always Claude | ~$0.05 (long output) | ~$0.02; ~$0.01 with the Batch API |
| "Found online" web search (removed) | When nothing was listed | ~$0.15 (3 searches plus 10–30k tokens of results) | ~$0.08 |
| For comparison: one WhatsApp message | | Free inside the 24-hour window a customer's message opens; about $0.004 for a template outside it (Meta's pricing page, checked 25 Sep 2026) | |

Haiku 4.5 is cheapest per token, but it only caches prompts of 4,096 tokens or more. Our request prompt is about 2,900 tokens, so on Haiku every call pays full price (about $0.0035). Sonnet 5 caches it and costs about $0.0017. Model choice should come from the eval (`npm run eval -- --claude --model …`), not from list prices.

## 2. What the current engine can already do

The keyword interpreter scored 79% on categories across the 56 test requests. As an experiment, a simple confidence gate answered locally only when exactly one category matched and at most one word was unknown:

- It answered **55% locally**, 29 of 31 correctly.
- It sent 25 to "escalate", but **15 of those were right**. The unknown words were harmless: brands and specs ("samsung", "5kva"), word forms ("installer", "drilling", "electrician") and occasions ("birthday party").
- It let **2 wrong answers through**:
  - "paint my house": "paint" is also a hardware product.
  - "anogadzira fridge": the Shona "repair" verb is unknown, so it chose appliances rather than appliance repair.

So the confidence signal works, but the vocabulary is too thin in both directions. The engine needs to know which words don't matter (brands, units, occasions) and which words change the meaning (repair, hire, move, and the Shona and Ndebele verbs for them). The test set is small and made up; real traffic will be messier. That's why the phrasebook and the review loop matter more than any rule.

## 3. The ladder

```
message
 0 Structured: button, list row, location, command, answer to our own question → handled (no understanding needed)
 1 Local engine: normalise → vocabulary → rules → places, budget, time → confidence
      HIGH  → answer
 2 Phrasebook: resolved before? → answer
      MEDIUM with 2–3 clear options
 3 Ask the customer: "Did you mean…?" buttons → answer, and remember
      LOW, or the customer's reply didn't settle it
 4 Claude (small model, budgeted), given the local engine's notes → answer, and remember
      still unclear, over budget, or a sensitive case
 5 A person (handoff) → answer, and remember
```

Some rules hold at every step:

- **Blocked words stay local and strict.** Illegal goods and restricted services are decided by the lexicon and never sent to Claude or to a guess.
- **High-scam categories** (rentals, cars, visas) need a HIGH local answer or a Claude or person answer. They never come from a clarifying guess.
- **Greetings, thanks, "help", "agent", "menu", "stop" and "delete my data" never reach Claude.** Today "hi" and "thanks" do.

## 4. Step 1: the local engine (v2)

Everything the engine knows lives in data (the lexicon), editable from the ops console, not in code.

**Normalising**
- Lower case, strip punctuation and emoji, and collapse stretched letters ("pleeease").
- Common texting spellings: pls, plz, 2moro, nyt.
- Split numbers from units ("55inch", "5kva", "20l").
- Strip locative and noun prefixes before place and word lookup: "kuMabelreign", "eNkulumane", "kwa", "i-plumber", "ama-", "ma tyres".
- Fuzzy matching against the lexicon only: one wrong letter for words of 5+ letters, two for 8+ ("plumbar", "Mabelrein", "electritian").
- English word forms: installer → install, drilling → drill, electrician → electric, accountant → accounting.

**The lexicon: every word has a role**

| Role | Examples | Effect |
| --- | --- | --- |
| service | plumber, mechanic, electrician, catering, tutor | Decides the category |
| product | cement, tyres, fridge, couch, cake | Decides the category |
| action | repair, fix, *gadzira*, *lungisa*, hire, rent, *roja*, move, deliver, buy, *tenga*, *thenga* | Changes it: "repair" + phone → phone repairs |
| brand | samsung, toyota, honda fit, hisense | Weak: never decides a category on its own if a service or product word is present |
| spec or unit | inch, kva, litres, bedroom, tonne | Neutral |
| occasion | wedding, funeral, birthday, party, church | Neutral when another term is present ("catering for a funeral" means catering) |
| ambiguous | paint, gas, cake? | Can't decide alone: needs an action or object ("paint my house" means painters), otherwise ask |
| filler | ndoda, ndinoda, ngifuna, ku, please, how much | Ignored (partly done) |

Shona and Ndebele nouns and verbs belong in the lexicon too:

- Nouns: *keke/ikhekhe* (cake), *muchato/umtshado* (wedding), *matende* (tents), *macheya* (chairs), *mota/imoto* (car), *firiji/ifriji* (fridge), *umakhenikha* (mechanic).
- Verbs: *gadzira/lungisa* (repair), *tenga/thenga* (buy), *roja/qasha* (hire), *chera/gebha* (dig or drill), *takura/thutha* (carry or move).

The first lists should come from native speakers. In practice the developers drafted the Shona and Ndebele lists, so draft words lead only to questions until a native speaker approves them. The phrasebook then adds what real customers write.

**Rules (few, explicit, each with a test)**
- An action changes the category family:
  - repair + phone, laptop or TV → phone and electronics repairs
  - repair + fridge or stove → appliance repairs
  - repair + car → mechanics
  - parts words (tyres, spares, battery) + car brand → car parts
  - hire + event items → event hire; hire + car → car hire; hire + room or cottage → rentals
  - move or transport + goods → trucks and moving
- A longer, more specific term beats a shorter one it contains ("water delivery" beats "delivery").
- Places, budget, time and quantity are pulled out as today. Landmarks count as places ("Sam Levy's" means Borrowdale), with fuzzy spelling.

**Confidence bands (explainable)**
- **HIGH:**
  - one category after the rules
  - at most one unknown content word, and it doesn't look like a Shona or Ndebele verb or noun (prefixes such as *ano-*, *ku-*, *u-*, *i-*)
  - area known, or not needed
- **MEDIUM:** 2–3 candidate categories remain, or one category with two or more unknown words.
- **LOW:** no category, mostly unknown words, a long message (over about 25 words) or several needs at once ("venue, catering and a DJ").

Each decision logs its reasons ("category=plumbing via 'plumber'; unknown: none; area=Mabelreign"). The handoff card and the review screen show them.

The target is **98% or better precision for HIGH answers**, checked weekly on a random sample (§9). The thresholds are tuned on labelled real requests, not on the made-up test set.

## 5. Step 2: the phrasebook (why it gets cheaper every week)

- Each resolved request is saved as **signature → interpretation**. The signature is the request's content words, normalised and sorted, without places or numbers. For example, "ndoda keke remuchato ku Budiriro" is saved as `keke muchato` → Cakes.
- Sources, most trusted first: a person in the ops console, the customer's own tap, then Claude.
- The next customer who writes the same thing gets an answer with no Claude call.
- **Vocabulary suggestions:** unknown words are counted against the categories they were resolved to. For example: "keke → Cakes, seen 14 times, all agreed. Add it?" One click in the Vocabulary screen makes it part of the lexicon. Nothing enters the lexicon without a person's approval.
- There are no names or phone numbers in signatures. An entry used only once is dropped after 180 days.

## 6. Step 3: ask the customer

- **When:** MEDIUM confidence with 2–3 clear candidates, for example "tyres for my Honda Fit" (car parts or cars for sale).
- **How:** "Did you mean…?" with up to three buttons named after the categories, plus "Something else". A tap runs the search and teaches the phrasebook.
- **Cost:** one extra WhatsApp reply, about the same as a small Claude call. It's worth it because the answer is certain and it trains the engine. When the options aren't clear-cut, go to Claude instead.
- Ask at most once per request. If the customer writes something new instead of tapping, run the ladder again on the new text.

## 7. Step 4: Claude, only when stuck

**Text requests**
- **When:** LOW confidence, a MEDIUM case the customer didn't settle, and the message looks like a real request (two or more content words, not gibberish).
- **Model:** Sonnet 5 or Haiku 4.5, whichever the eval shows is accurate enough on real requests. Start with Sonnet 5, which caches our prompt.
- **Settings:** thinking switched off (`thinking: {type: "disabled"}`; it's on by default on Opus 5), low effort, `max_tokens` about 300, the same structured output as today.
- **Context:** the local engine's notes go into the message (candidate categories, unknown words, the detected place), so Claude has less to work out.
- **Budget guard:**
  - a daily spend limit (for example `CLAUDE_DAILY_BUDGET_USD=5`), with an alert at 80%
  - a per-number daily cap (for example 5 escalations)
  - over either limit, ask the customer or go to a person instead
- **Metering:** every call's `usage` (input, cached and output tokens) is saved with its feature, so the System screen shows Claude spend per day and per feature.

**Other uses** (photos and price lists were removed in Milestone 11: messages are typed only, for now)
- **Customer photos:** try the caption first. If the local engine understands it with HIGH confidence, skip the photo. Otherwise send a downscaled photo (long side 800px, about 850 tokens instead of about 1,600) to the small model.
- **Price lists:**
  - Photos agents take in the field go through the Batch API (half price; results within 24 hours, usually much sooner).
  - Owners' own photos stay interactive on the small model, capped at 60 items.
- **Business registration and customer tips:** no Claude.
  - Use the local engine. If it's unsure, show a category picker: a list of groups, then the categories in the chosen group. Owners confirm their categories anyway.
  - Tips the engine can't place wait for the team to categorise.
- **No web search.** When our suppliers don't have it, related suppliers or a person do the finding (see step 5).

## 8. Step 5: people

- **Triggers:**
  - no supplier in the category or in related categories (built: the reply itself says a person will help)
  - nobody could make sense of it after one "please say it differently" (built)
  - over budget, and the engine didn't understand
  - the customer shows frustration ("you don't understand", "useless", "hauna kunzwisisa", "awuzwisisi") (built: a person takes over at once, and their last request goes to the weekly check)
  - the customer repeats themselves
  - several needs in one message
  - urgent or sensitive situations (a medical or legal emergency)
  - the customer asks for a person
- **Out of hours:** outside the team's hours (`TEAM_HOURS`, Monday–Saturday 8am–6pm by default), say when a person will reply, and queue the chat (built).
- **The handoff card shows the ladder's notes:** what the engine understood, the candidates and the unknown words. The person picks the category and area when replying, which fills the phrasebook.
- **Aim:** under 2% of requests reach a person.

## 9. Measuring it

Show these on the System screen and review them every week:

- Share of requests answered at each step
- Claude calls per 100 requests, and Claude spend per day by feature
- Clarifying questions: how often asked, and how often tapped
- Handoffs: share of requests, and time to first answer
- **Local precision:**
  - Each week the team reviews 50 random HIGH answers in the ops console: right, wrong, or should have asked.
  - A wrong answer becomes a lexicon or rule fix plus a test.
- Top unknown words, and pending vocabulary suggestions

Targets after the first month of real traffic:

- 80% or more answered without Claude (steps 0–3)
- 10 or fewer Claude calls per 100 requests
- handoffs under 2%
- HIGH precision of 98% or better
- end-to-end accuracy no worse than Claude-only

## 10. Estimated effect (to be replaced by metered numbers)

The scenario:

- 10,000 customer conversations a month
- 15,000 messages that need understanding
- 5% of conversations send a photo
- 20% of requests have no listed results
- 300 price lists

| | Today | With this design |
| --- | --- | --- |
| Text understanding | 15,000 Opus calls, about $75 | About 15% escalated, 2,250 Sonnet calls: about $4 |
| Photos | 500, about $6 | Caption-first, downscaled, 300 small-model calls: about $1.50 (none since Milestone 11) |
| Price lists | 300, about $15 | Batch and small model: about $3 (none since Milestone 11) |
| Registration and tips | About 1,000 calls, about $5 | None |
| **Claude total** | **about $100** | **about $10** |

WhatsApp replies are free: every message sent inside the 24-hour window a customer's own message opens costs nothing (Meta's pricing page, checked 25 September 2026; an earlier note here said replies would be charged from October 2026, which was wrong). Only templates sent outside a window cost money, about $0.004 each. See [HARDENING.md](HARDENING.md) for keeping those near zero. A side benefit: requests handled locally never leave our servers, which means fewer cross-border transfers to record for POTRAZ.

## 11. Rollout

Each phase ships on its own and must keep the eval at least as accurate as Claude-only.

**Phase 1: stop paying for easy messages (built)**
- A router with confidence bands:
  - greetings, thanks, help, agent and blocked words are always local
  - HIGH local answers skip Claude, using today's keyword engine and a strict gate
  - on the 56 test requests, 46% are answered locally, all correctly
- Claude escalations on the small model, with thinking off and the local notes in the message; metering, the budget guard and the System screen figures.
- A phrasebook filled from Claude's answers.
- A category picker instead of Claude at registration and for tips.
- Web search removed. Related suppliers, then a person, when nothing matches.

**Phase 2: a local engine that reads like a Zimbabwean (built)**
- Built:
  - the normaliser (texting spellings, numbers stuck to units, stretched letters), word roles, English word forms, fuzzy matching (same first letter, 6+ letters) and place prefixes
  - the lexicon in the database, editable in the ops console
  - Shona word shapes: joining prefixes, "ma-" on borrowed words, verb roots with their prefixes and endings, common spelling variations. A word joined by "of" ("nyama yemombe") only describes the main word.
  - a draft Shona list of about 460 words and roots
  - Ndebele word shapes: noun prefixes ("ifriji", "ifridge"), "of"/"and" forms that swallow a vowel ("ikhekhe lomtshado", "inyama yenkomo"), e- and -ini for places, verb roots ("olungisa", "ukuqasha"), and a draft list of about 300 words and roots
  - the action rules
  - "Did you mean…?" (step 3), learning from taps, handoffs and the weekly check
  - vocabulary suggestions, the Word list review screen, and the Check answers screen
  - handoff messages that say when the team is next in, a person at once when the customer is frustrated, and "Not what I asked for" under results (both feed the weekly check)
- On the 159 test requests (56 Shona, 48 Ndebele), every category is right:
  - With the Shona and Ndebele words still drafts: 98% of English requests are answered locally. 79% of Shona and Ndebele ones get a question, always offering the right option. None is confidently wrong.
  - With them approved: 97% are answered locally, all correctly.
  - The developers wrote these examples alongside the word lists, so real traffic will score lower. That's what Phase 3 measures.

**Phase 3: tune on real traffic (tools built in Milestone 8; run them after the first 2–4 weeks)**
- **Labelling** (built): the ops console's **Label requests** screen shows random real requests with what the assistant did. The team says what each customer wanted.
  - A correction also teaches the phrasebook.
  - `npm run eval:export -- --labelled` turns the labels into the eval's answer key.
  - The screen shows how often each step of the ladder was right.
- **Thresholds** (built):
  - How many unknown words a straight answer may have, per language, is a setting (`LOCAL_UNKNOWN_WORDS`, now en:1, sn:0, nd:0).
  - `npm run eval -- --tune --file evals/real.jsonl` shows each value's coverage and precision, and suggests the one that answers most at 98% precision.
  - The classifier's bar is a setting too (`LOCAL_CLASSIFIER_MIN`).
- **The escalation model** (built): `npm run eval -- --claude --model claude-sonnet-5,claude-haiku-4-5` compares models on the requests Claude actually sees, those the local engine doesn't answer, with accuracy and cost per 100 customer requests.
- **The classifier** (built): a second opinion for words the rules don't know.
  - It isn't naive Bayes after all. It finds the known word most like each unknown one, by shared letter patterns (rare ones count more), among words of about the same length ("fotographer" → "photographer"; "controller" isn't taken for "control").
  - It learns from single words only: category words, the lexicon, the phrasebook and the labels.
  - It only offers "Did you mean…?" options, never answers. Its guesses go through the action rules ("fridj repair" → appliance repairs).
  - It's retrained hourly and whenever words change.
  - On 12 misspelled test requests it turned 4 of 10 unanswerable ones into questions with the right option, and made no wrong guesses.
- **Caption-first photos** (built, then removed in Milestone 11): a caption the local engine understands on its own is used without sending the photo to Claude.
- **The Batch API for field price lists** (built, then removed in Milestone 11): field agents' price-list photos are sent every 20 minutes in one batch, at half price. Results usually come within the hour, and failures are retried up to three times. Owners' own photos are still read straight away. We skipped downscaling photos, which needs an image library; Claude sizes them down anyway.
- **Targets** (built): the System screen shows the targets from §9 against the last 7 days: understood without Claude, Claude calls per 100 requests, handoffs, the weekly check, and labelling progress.
- **To do once there's traffic:**
  - label about 300 requests
  - run the tuning and the model comparison
  - set `LOCAL_UNKNOWN_WORDS`, `LOCAL_CLASSIFIER_MIN` and `CLAUDE_MODEL` from the results

## Risks and how the design handles them

- **Confident but wrong local answers** are worse than a Claude call. The design handles them with:
  - strict HIGH criteria
  - ambiguous-word handling
  - the weekly precision review
  - nothing high-scam decided by a guess
  - a customer's "not what I asked" button that feeds the review
- **Vocabulary drift** (a synonym wrongly added) is contained because every lexicon change needs a person's approval and is recorded in Activity. Eval runs before each release.
- **Shona and Ndebele quality** depends on native speakers reviewing the starting lexicon and the suggestions. We don't generate it.
- **Cost overruns** are capped by the daily budget and per-number limits, and the service degrades gracefully to clarifying questions and people, never to silence.
