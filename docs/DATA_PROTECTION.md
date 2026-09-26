# Data protection

A working record of what personal data the service holds, where it goes, and how requests are handled. It supports POTRAZ compliance under Zimbabwe's Cyber and Data Protection Act, but it isn't legal advice. Have a lawyer confirm it before launch.

## Before launch

- [ ] Register with POTRAZ as a data controller and get the licence. Our September 2026 research found the licensing regulations are SI 155 of 2024, with fees by tier.
- [ ] Appoint a data protection officer, and publish their contact details in the privacy notice.
- [ ] Publish the privacy notice and business terms, and set `PRIVACY_URL` and `BUSINESS_TERMS_URL`. Customers see the notice before their first search; businesses agree to the terms when they list.
- [ ] Record the cross-border transfers below and the safeguards for each (the providers' data processing terms).
- [ ] Agree who handles data requests, and how fast (the ops console makes each one a few clicks).

## What we hold

| Whose | What | Why | Kept |
| --- | --- | --- | --- |
| Customers | WhatsApp number, profile name, messages, requests, shared locations | Find businesses for them, follow up, improve the service | Messages 180 days (`MESSAGE_RETENTION_DAYS`). A request's wording, and the local engine's notes on it, 365 days (`REQUEST_RETENTION_DAYS`); after that only its category, area and outcome remain, for statistics. |
| Customers | "Did you mean…?" questions we asked them and what they picked | Understand them, and answer the same wording directly next time | 365 days (`REQUEST_RETENTION_DAYS`). The wording's key words and category are kept, unlinked from the person, in the phrasebook. |
| Customers | The team's labels on a sample of requests (what the customer wanted) | Measure and tune how well requests are understood | With the request: deleted with the customer's data. The eval export (`evals/real*.jsonl`) holds request wording, so keep it private and delete it after use. |
| Customers | Voice notes and photos they send | None: they're asked to type instead | Never downloaded or read. Only the fact that one arrived is logged with the message. |
| Customers | Ratings, follow-up answers ("sorted", "didn't reply", "didn't have it") and reports about businesses | Rank businesses, show track records, send businesses back for a re-check, stop scams | Until the customer deletes their data. Reports stay after that, with the link to the customer removed. Track records show counts only, never who answered. |
| Businesses | Name, WhatsApp number, location, description, who they sell to, field agents' photos, price list, ratings, the field team's re-check notes, and what they searched for as buyers (the supplier is told which business asked) | The listing | While listed. Deleting their data removes the listing, photos and re-checks. |
| Field agents | Name, phone, city, registrations | Quality control | While they work with us. |
| Ops team | Name, email, password hash, activity log | Accountability | Accounts while active. The activity log holds no message text. |

Idle chat state is deleted after 90 days (except chats waiting for a person). Finished background jobs go after 30 days, and expired ops sessions daily.

## Who processes it (cross-border transfers)

| Provider | Receives | Where |
| --- | --- | --- |
| Meta (WhatsApp Cloud API) | All messages, numbers and names | Meta's data centres (outside Zimbabwe) |
| Anthropic (Claude) | Only typed requests the local engine can't read (and hasn't seen before) | United States |
| Hosting and database provider | Everything in the database | Your chosen region |
| Storage provider (S3 or R2) | Field agents' photos of businesses | Your chosen region |
| Alert webhook (Slack, Discord…) | Alert text, without message content or phone numbers | The chat provider |

## Handling requests

- **Access:** in the ops console go to **People**, find the number, then **Export their data** (admins). It downloads a JSON file with their messages, requests, introductions, reports, tips and listings. Send it to them over a channel you've confirmed is theirs.
- **Deletion:** customers type `delete my data` on either WhatsApp number and confirm. It happens straight away, and a business owner's listings go too. Admins can do the same from **People** (a customer's data) or a business's page (**Delete completely**).
- **Correction:** businesses update their own listing from the business number (menu). The team can edit anything from the ops console.
- **Objection and marketing:** we send no marketing. `stop` ends conversations. Businesses get weekly summaries only when they had activity.
- Every export and deletion is recorded in **Activity**, with who did it and when.

## Security measures

- Every ops console user has their own account, with an admin or staff role. Passwords are hashed with scrypt, and sign-in locks after 5 wrong attempts.
- Session tokens, field-agent tokens and opted-out numbers are stored only as hashes.
- Webhook calls must carry Meta's signature. The ops API needs a signed-in person or the ops token.
- The photo bucket stays private; photos are served only through the signed-in ops API.
- Limits per number stop floods: messages per minute and day, reports per day.
