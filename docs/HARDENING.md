# Hardening: very cheap to run, hard to break

The goal is a directory that costs almost nothing per customer and keeps working when something around it fails. This plan follows Milestone 11, which made the service read typed messages only (no speech-to-text, no Claude reading photos).

## Summary

- **Most of what we do is already free.** A WhatsApp conversation a customer starts is free: every reply inside the 24-hour window their message opens costs nothing (Meta's pricing page, checked 25 September 2026).
- **Only three kinds of message cost money today**, about $0.004 each, because they go out when nobody has written to us:
  - the lead notice to a business (whose window is usually closed)
  - the follow-up to the customer, 72 hours after connecting (always outside the window)
  - the weekly summary to each active business
- **Claude is the other cost**, and only for typed wording the local engine can't read. With little traffic, each call pays to write the prompt cache (1.25 times the price) and nobody reads it back.
- **The plan:**
  - stay inside conversations people started, so WhatsApp costs nothing
  - ask the customer (free) before asking Claude (paid)
  - make every paid event visible on the System screen, with caps
  - then harden the engine against bad input, outages and abuse
- **Target:** under $0.50 of variable cost per 1,000 customer requests, plus about $25 a month for hosting. That compares with roughly $4 per 1,000 requests, plus about $17 a month for weekly summaries, as built today.

## 1. Where the money goes today

Prices: WhatsApp utility templates in the Rest of Africa market cost about $0.004 each (from our September research; confirm on Meta's rate card). Claude Sonnet 5 costs $2 per million input tokens and $10 per million output tokens; Haiku 4.5 costs $1 and $5.

| Cost | When it happens | Each | Per 1,000 requests (assumptions below) |
| --- | --- | --- | --- |
| Replies to customers and businesses | Inside a window they opened | Free | $0 |
| Lead notice to the business | Every "Connect me", when the business hasn't written to us in 24 hours | ~$0.004 | ~$1.40 |
| Follow-up to the customer | 72 hours after every "Connect me" | ~$0.004 | ~$1.60 |
| Weekly summary | Every Monday, per business shown in a search that week | ~$0.004 | Not per request: ~$17 a month for 1,000 such businesses |
| Claude, reading a request | Wording the local engine can't read, and hasn't seen before | ~$0.0085 with a cold cache, ~$0.0016 warm | ~$0.85 |
| Hosting | Always | Fixed | $20–40 a month |
| People | Handoffs, verification | Staff time | Outside this plan, except that fewer handoffs means less of it |

Assumptions:
- 40% of requests end in "Connect me".
- 90% of businesses haven't written to us in the last 24 hours.
- 10% of requests reach Claude: the target ceiling in [UNDERSTANDING.md](UNDERSTANDING.md).
- Claude's request prompt is about 3,000 tokens.

A cold cache is the normal case until requests are less than 5 minutes apart. A cold call on Sonnet 5 (about $0.0085) costs more than sending the same prompt uncached (about $0.007).

## 2. The rules

1. **Every message we send is a reply inside a conversation someone started.** Anything else costs money and needs a stated reason, a setting to turn it off, and a line on the System screen.
2. **A question to the customer is free; a Claude call isn't.** When the local engine has one to three likely categories, it asks "Did you mean…?" before paying Claude.
3. **Every paid event is recorded, capped and shown.** No bill should surprise us.
4. **Degrade, don't stall.** If Claude, the database or WhatsApp misbehaves, the customer still gets an answer: a question, a person, or "try again shortly".

## 3. The work

### A. Know the cost of everything (Phase 1)

- [x] Templates sent are counted from the message log and priced with `WHATSAPP_TEMPLATE_PRICE_USD` (default $0.004), next to the Claude costs already in `ai_usage`.
- [x] **Running costs** on the System screen, for today and this month, with a projection for the month and the cost per 1,000 requests. It also says which paid templates are switched on.
- [x] A daily cap on templates (`TEMPLATE_DAILY_CAP`, default 100). Past it, templates stop for the day and the team is alerted once.
- [ ] **Done when:** the System screen's monthly total is within 10% of the Anthropic and Meta invoices.

### B. Zero-cost messaging (Phase 1)

- [x] **Follow-ups inside the customer's window.** Tapping "Connect me" is a message from the customer, so the window runs 24 hours from then. Send the follow-up about 20 hours after connecting (`FOLLOW_UP_DELAY_HOURS=20`), which is free.
  - More customers will answer "Not yet" this early. Track records only count final answers, so they stay honest.
  - If the window has closed by the time it's due, the follow-up is skipped, unless `PAID_FOLLOW_UPS=true`.
- [x] **Lead notices only when they're free.** Send one when the business has written to us in the last 24 hours; otherwise skip it (`LEAD_NOTICES=free_only`).
  - The customer's own first message already says "I found you on Directory ZW (ref K7Q2M)", so the business still knows where the customer came from.
  - The business menu gets **My customers**: recent reference codes, free to check any time.
- [x] **Weekly summaries on request.** The week shows at the top of the business menu, and "summary" answers any time. The Monday push is a setting, off by default (`WEEKLY_SUMMARIES=off|window_only|always`).
- [x] **Handoff replies inside the window.** The team can't send a free-form reply once a customer's 24 hours are over; today such a send fails.
  - The inbox shows how long each window has left, and won't send a reply that can't be delivered (the API answers 409).
  - Chats about to expire go to the top.
- [ ] **Done when:** a normal day sends no paid templates unless the team turned one on, and the Meta invoice is about $0.

### C. Fewer, cheaper Claude calls (Phases 1 and 2)

- [ ] **Ask before paying (Phase 2).** When the local engine has one to three candidate categories, even with low confidence, ask "Did you mean…?" instead of calling Claude. Only wording with no candidates goes to Claude. Measure how often customers pick an option.
- [x] **Cache only when it pays (Phase 1).** Mark the prompt for caching only when the last Claude call was under 4 minutes ago, so a read can follow. Otherwise send it uncached, at 1× instead of 1.25×. Check the result in `ai_usage` (cache read and write tokens are already recorded).
- [ ] **Choose the model by the eval (Phase 2).** Run `npm run eval -- --claude --model claude-sonnet-5,claude-haiku-4-5` on the labelled real requests.
  - Haiku 4.5 can't cache our prompt (its minimum is 4,096 tokens) but costs about $0.0034 a call, uncached.
  - Switch if Haiku is about as accurate.
- [ ] **A smaller prompt (Phase 2).** Send each category as `slug: name` without its six example words, which halves the prompt, or send only the local engine's candidates. Keep whichever the eval says is no worse.
- [x] **Tighter budgets at launch (Phase 1).** `CLAUDE_DAILY_BUDGET_USD=1` (about 125 cold calls a day) and `CLAUDE_CALLS_PER_NUMBER_PER_DAY=3`. Over either limit, customers get a question or a person, as today.
- [x] **Timeouts and a circuit breaker (Phase 1).**
  - The Anthropic client ran with the SDK's defaults (a 10-minute timeout and two retries), so a stuck call could hold up a customer's reply for minutes. Now it's a 6-second timeout and one retry (`CLAUDE_TIMEOUT_SECONDS`).
  - After three failures in a row, skip Claude for five minutes and alert once.
- [ ] **Done when:**
  - fewer than 3 Claude calls per 100 requests after the first month
  - Claude costs under $0.30 per 1,000 requests
  - no customer waits more than about 13 seconds on Claude (a 6-second timeout, one retry)

### D. Harden the engine (Phase 2)

- [ ] **An accuracy gate.** The free, local-only eval runs with the tests. It fails if confident answers fall below 98% right, or if coverage drops by more than 2 points.
- [ ] **Hostile input.** Fuzz the local engine with 10,000-character messages, emoji floods, zero-width characters, mixed scripts, text that looks like SQL or HTML, and stretched letters.
  - It must never throw, and must answer within 50 ms.
  - Look for regular expressions that can backtrack badly.
- [ ] **A guard against a poisoned phrasebook.** Today one customer's tap on "Did you mean…?" answers everyone who writes the same words after them.
  - A customer-sourced entry should answer directly only once two different customers agree, or the team confirms it.
  - Until then, the question is asked again with that option first.
- [ ] **Retrain only on change.** The classifier retrains every hour whether or not anything changed. Skip it when no words, phrasebook entries or labels are new.
- [ ] **A load test.** On the smallest server, run 20 messages a second for 10 minutes:
  - locally answered replies take under 1 second (p95)
  - memory stays flat
  - nothing is lost
- [ ] **Failure drills**, each with a test:
  - Claude down (question or person)
  - database slow (the webhook still answers Meta in time)
  - WhatsApp rejecting sends (retried, then an alert)
  - the server restarting mid-conversation (picked up again)
- [ ] **Unknown words, weekly.** The team clears the top unknown words on the Vocabulary screen, so fewer requests need a question or Claude.

### E. Cheap, boring infrastructure (Phase 2)

- [ ] One small server (1 vCPU, 1–2 GB) running the Docker image behind Caddy for HTTPS.
- [ ] Postgres: either a managed free or small tier, or Postgres on the same server with nightly backups to the bucket. Test a restore either way.
- [ ] Cloudflare R2 for field photos: 10 GB free, no charge for downloads.
- [ ] Keep logs small: no message text in logs, and at most 14 days kept.
- [ ] **Done when:** hosting costs $25 a month or less, and a restore from backup has been tested.

### F. People's time (ongoing)

A handoff costs minutes of someone's day, which is more than any message or Claude call. Keep handoffs under 2% of requests, add canned replies to the inbox, and keep using "tell the assistant what they wanted", so each handoff teaches the engine.

## 4. Order of work

| Phase | When | What |
| --- | --- | --- |
| 1 | Before launch, about a week | A (metering), B (zero-cost messaging), and from C: cache only when it pays, tighter budgets, timeouts and the circuit breaker |
| 2 | First month of real traffic | The rest of C (ask before paying, model choice, smaller prompt), D (engine hardening), E (infrastructure) |
| 3 | Every week after | Check the Running costs and Targets on the System screen; clear unknown words; review handoffs |

## 5. Decisions for the owner

Decided on 26 September 2026: all four as recommended, and built (see section 3).

| Decision | Recommended | Alternative |
| --- | --- | --- |
| Lead notices to businesses | Only when free: the customer's message carries the reference anyway | Always, about $0.004 per connection |
| When to follow up | About 20 hours after connecting, free | 72 hours, about $0.004 each, more customers know how it went |
| Weekly summaries | On request and at the top of the business menu, free | Every Monday, about $0.017 a month per active business |
| Claude | Keep it, capped at $1 a day | No key at all: the local engine, questions and people only. $0 for AI, but more questions and handoffs |

## 6. What it adds up to

Per 1,000 customer requests, on the assumptions in section 1:

| | As built today | After this plan |
| --- | --- | --- |
| Claude | ~$0.85 | ~$0.10 (3 calls per 100 requests, uncached on the cheaper model) |
| Lead notices | ~$1.40 | $0 |
| Follow-ups | ~$1.60 | $0 |
| Speech-to-text and photos | $0 (removed in Milestone 11) | $0 |
| **Variable total** | **~$3.85** | **~$0.10** |
| Weekly summaries | ~$17 a month | $0 |
| Hosting | $20–40 a month | $25 a month or less |

At 10,000 requests a month that's about $75–95 a month today, against about $26 after this plan: almost all of it the server.
