# Data protection

A working record of what personal data the service holds, where it goes, and how requests are handled. It supports POTRAZ compliance under Zimbabwe's Cyber and Data Protection Act, but it isn't legal advice. Have a lawyer confirm it before launch.

## Before launch

- [ ] Register with POTRAZ as a data controller and get the licence. Our September 2026 research found the licensing regulations are SI 155 of 2024, with fees by tier.
- [ ] Appoint a data protection officer, and publish their contact details in the privacy notice.
- [ ] Have a lawyer review the privacy notice and business terms. The app serves plain-English versions at `/privacy` and `/terms` (src/web/legal.ts), true to what it does, with the retention periods from the settings. Set `CONTACT_EMAIL` (and add the data protection officer's details), or point `PRIVACY_URL` and `BUSINESS_TERMS_URL` at your own pages. Customers get the notice's link before their first search; businesses agree to the terms when they list.
- [ ] Record the cross-border transfers below and the safeguards for each (the providers' data processing terms).
- [ ] Agree who handles data requests, and how fast (the admin portal makes each one a few clicks).

## What we hold

| Whose | What | Why | Kept |
| --- | --- | --- | --- |
| Customers | WhatsApp number, profile name, messages, requests, shared locations | Find businesses for them, follow up, improve the service | Messages 180 days (`MESSAGE_RETENTION_DAYS`). A request's wording, search words, shared location and the local engine's notes on it, 365 days (`REQUEST_RETENTION_DAYS`); after that only its category, area and outcome remain, for statistics. Someone who hasn't written for 365 days loses their number and name (the rest stays, anonymous), unless they manage a listing, are blocked, or wait for a person. A shared location is used for their searches for 12 hours. |
| Customers | "Did you mean…?" questions we asked them and what they picked | Understand them, and answer the same wording directly next time | 365 days (`REQUEST_RETENTION_DAYS`). The wording's key words and category are kept, unlinked from the person, in the phrasebook. |
| Customers | The team's labels on a sample of requests (what the customer wanted) | Measure and tune how well requests are understood | With the request: deleted with the customer's data. The eval export (`evals/real*.jsonl`) holds request wording, so keep it private and delete it after use. |
| Customers | Voice notes and photos they send | None: they're asked to type instead | Never downloaded or read. Only the fact that one arrived is logged with the message. |
| Customers | Ratings, follow-up answers ("sorted", "didn't reply", "didn't have it") and reports about businesses | Rank businesses, show track records, send businesses back for a re-check, stop scams | Until the customer deletes their data. Reports stay after that, with the link to the customer removed. Track records show counts only, never who answered. |
| Customers | Alerts we sent them (which request, store and product), and when they switched alerts off | Tell them once when a store lists what nobody had; never twice, never after they said no | 365 days (`REQUEST_RETENTION_DAYS`), and deleted with the customer's data. |
| Anyone | Registration codes sent on WhatsApp that didn't match, by a hash of the WhatsApp ID (no number) | Stop anyone guessing codes: five wrong a day per number | 7 days. |
| Businesses | Name, WhatsApp number, location, description, who they sell to, field agents' photos, price list, ratings, the field team's re-check notes, and what they searched for as buyers (the supplier is told which business asked) | The listing | While listed. Deleting their data removes the listing, photos and re-checks. |
| Businesses | Products, prices and each price change, product photos, opening hours, email and website, entered on the dashboard | The listing, and prices in our replies | While listed. A product taken down is kept out of sight with its history, and its photo is deleted. Deleting the business's data removes all of it. |
| Businesses | The links their product photos came from (a "Photo link" column in an upload), and why a link didn't work | Fetching the photos from the business's own website, without fetching them twice | With the product. The server fetches each link only from the public internet, and keeps the photo, not the page. |
| Businesses | What's public of their products: each live product's name, price, description, photo and the store's name and area, on its own page (`/p/…`), and, for products with a photo and a price, in our Meta catalog for WhatsApp's product cards | Customers find and share products; WhatsApp shows them as cards | While the product is live. Out of stock, taken down or a paused business leaves the catalog within a minute; taken down, the page and photo go at once. The listing terms must say products are published this way. |
| Businesses | What they typed on the website's registration form | Creating the listing when the owner sends the code from WhatsApp | Cleared once the listing exists. Unfinished registrations are deleted 7 days after their code runs out. |
| Business owners | Dashboard sign-in links and sessions, stored only as hashes | Signing in without a password | A link works once, for 15 minutes, and is deleted a day after it runs out. A session lasts 30 days and is then deleted. The team can end an owner's sessions from the admin portal. |
| Field agents | Name, phone, city, registrations | Quality control | While they work with us. |
| Our team | Name, email, password hash, activity log | Accountability | Accounts while active. The activity log holds no message text. |

Idle chat state is deleted after 90 days (except chats waiting for a person). Finished background jobs go after 30 days. Expired team sessions and owners' dashboard sessions go daily, and so do owners' sign-in links a day after they run out.

## Who processes it (cross-border transfers)

| Provider | Receives | Where |
| --- | --- | --- |
| Meta (WhatsApp Cloud API) | All messages, numbers and names | Meta's data centres (outside Zimbabwe) |
| Meta (Commerce catalog) | Products with a photo and a price: name, price, description, the store's name and area, and links to the product's page and photo. No customer data. | Meta's data centres (outside Zimbabwe) |
| Anthropic (Claude) | Only typed requests the local engine can't read (and hasn't seen before) | United States |
| Hosting and database provider | Everything in the database | Your chosen region |
| Storage provider (S3 or R2) | Field agents' photos of businesses, and the photos owners add on the dashboard | Your chosen region |
| Alert webhook (Slack, Discord…) | Alert text, without message content or phone numbers | The chat provider |

## Handling requests

- **Access:** in the admin portal go to **People**, find the number, then **Export their data** (admins). It downloads a JSON file with their messages, requests (with shared locations), the businesses we showed them, introductions, reports, tips, listings, "Did you mean…?" answers, alerts, their chat's saved state, when Claude read their messages, and whether they're blocked, stopped messages or switched alerts off. Send it to them over a channel you've confirmed is theirs.
- **Deletion:** customers type `delete my data` on either WhatsApp number and confirm. It happens straight away, and a business owner's listings go too. Admins can do the same from **People** (a customer's data) or a business's page (**Delete completely**).
- **Correction:** businesses update their own listing from their business menu (they type *my business* on our WhatsApp number) or on the dashboard. The team can change anything from the admin portal.
- **Objection and marketing:** we send no marketing. `stop` ends conversations, alerts and the follow-up for businesses they contacted before it. Businesses get weekly summaries only when they had activity.
- **Feedback stays private:** owners see who contacted them (reference codes) and what they asked for, never how each customer answered our follow-up or rated them. Track records and the dashboard's Overview show totals only.
- **Alerts:** one, when nobody had listed what the customer asked for and a store near them lists it within a day. Only inside the free 24-hour window their own message opened, at most two a day, and never after `stop`, `alerts off` or the "No more alerts" button. `alerts on` brings them back.
- Every export and deletion is recorded in the **Activity log**, with who did it and when.

## Security measures

- Everyone on the team has their own admin portal account, with an admin or staff role. Passwords are hashed with scrypt, and sign-in locks after 5 wrong attempts.
- Business owners sign in to the dashboard with one-time links sent on WhatsApp, so there are no owner passwords to leak. Their session cookie can't be read by scripts, and the dashboard accepts changes only from our own pages.
- Session tokens, field-agent tokens and opted-out numbers are stored only as hashes.
- Webhook calls must carry Meta's signature. The ops API needs a signed-in person or the ops token.
- Sign-in links carry their token after "#", which browsers never send to a server, and request logs drop query strings.
- Every response tells browsers not to let other sites frame our pages or guess content types, and to send other sites our origin at most.
- A number can send five wrong registration codes a day; the team is alerted when a listing is claimed with its code.
- The photo bucket stays private. A live product's photo is served publicly, because its page and WhatsApp's catalog need it; every other photo (field agents', shopfront, inside) is served only to the business's owner on the dashboard and to the signed-in team.
- Limits per number stop floods: messages per minute and day, reports per day.
