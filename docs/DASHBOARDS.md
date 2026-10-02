# Dashboards

What the business dashboard (`/app`) and the admin portal (`/admin`) show, how every number is counted, and how to try them on sample activity before there's real traffic.

Both are executive dashboards in the Power BI mould:

- a row of headline tiles, each with the change on the period before and a sparkline;
- trend charts against the period before;
- a funnel, ranked bars, heatmaps and a map;
- filters that scope the whole page;
- a Chart/Table switch and a CSV download on every card;
- **Save as PDF** for a report to keep or send.

## For businesses (`/app`)

Owners see counts and shares about their own listing and their market. They never see who a customer is, or how any one customer answered our follow-up: only the totals. Nor do they see anything about other stores, including how their prices compare (the user's decision, 2 October 2026).

**Overview:** how the listing is doing.

- Tiles:
  - Shown in searches
  - Customers sent to you
  - Chosen when shown
  - Said "Yes, sorted"
  - Share of demand
  - Average position
- **Over time:** customers sent, or searches you came up in, each day, with the period before in grey.
- **From demand to customers:** requests in your categories in your city, how many showed you, how many chose you, answered our follow-up, and said "Yes, sorted".
- **Products that bring customers:** how often each product was in our replies, and how often the customer then chose you.
- **What customers told us:** follow-up answers (sorted, not yet, couldn't help, no reply), and the rating.
- **How far away customers were:** distance bands from the shop's pin to where customers asked from.
- **Your catalogue:** products with a price, with a recently confirmed price, with a photo, in stock.

**Insights:** the market in the owner's categories and city.

- Tiles:
  - Requests in your categories
  - You came up in
  - Searches you missed
  - Nobody could supply
- **Your market over time,** and **your categories**.
- **What people ask for:** each item marked where nobody near the customer had it.
- **Searches you missed:** requests in your categories where you didn't come up. "Add it" opens a new product with that name, but only when you don't already list it. When you do, or the search was a general one ("hardware shop"), the reason is shown instead: stores nearer the customer came up first.
- **When people ask:** day of the week by hour, Harare time.
- **Where people asked from,** and **what customers asked when they found you**.

**Customers:** the customers sent each day, and the list with reference codes. **Download CSV** gives the list for the owner's own records.

The founding partners' monthly intent report is the Overview and Insights saved as PDF for the last 30 days.

## For the team (`/admin`)

Four report pages, with tabs that keep the filters:

- **Overview:**
  - Eight tiles:
    - Requests
    - Customers
    - Found a supplier
    - Connections
    - Connection rate
    - Said "Yes, sorted"
    - Live businesses
    - Products listed
  - **Over time:** switch between requests, customers, connections and found a supplier.
  - **From asking to sorted,** the funnel.
  - **Demand by category.**
  - **Where people asked from:** towns, or a city's suburbs with rings every 5 km from the centre.
  - **When people ask.**
  - **Launch measures** against their targets.
  - Anything waiting for the team shows as chips at the top.
- **Demand:**
  - Tiles:
    - Requests
    - Found a supplier
    - Searches that found nobody
    - From businesses
    - Handed to a person
    - Understood without Claude
  - Requests by category group each day.
  - **Every category:** demand next to supply, sortable, with in-cell bars.
  - What people search for, and what nobody had (with the areas that asked most).
  - Areas against categories.
  - How requests were understood.
- **Supply:**
  - Tiles:
    - Live businesses
    - Verified
    - New businesses
    - Website sign-ups
    - Owners on the dashboard
    - Products listed
  - Businesses over time.
  - How businesses joined.
  - **Where to sign up next:** categories with the most searches that found nobody.
  - Catalogue health and activity.
  - **Top businesses,** a sortable leaderboard.
  - **Needs attention:** open reports, shown often but never chosen, rarely replies.
- **Customer experience:**
  - Tiles:
    - Customers
    - New customers
    - Came back
    - Said "Yes, sorted"
    - Average rating
    - Reports
    - Product alerts sent
    - Stopped our messages
  - New and returning customers.
  - Ratings.
  - How follow-ups went.
  - **Who comes back:** weekly cohorts, the share who asked again in each week after their first.

**Filters:** period, city, and category group or category, in the address so a view can be bookmarked or sent.

- Picking a bar, a map bubble or a table row narrows the page to it.
- A town on the map opens its suburbs. A business in the leaderboard opens its details.
- The category list leaves out the category filter, and the map leaves out the area filter, so the chosen one stands out among the rest.
- Launch measures always cover the last 30 days of the whole service.
- Website sign-ups cover all cities (registrations don't carry a city until they're finished).

## Periods

- **7, 30 or 90 days, by day, or 12 months by week.** Days are Harare days (UTC+2) and end today. A year is the last 52 Monday-to-Sunday weeks, this one included.
- **Every period is compared with the same length just before it.** Totals always equal the sum of the bars.
- **Today (or this week) is still in progress.** Its segment is drawn lighter and dashed, and its tooltip says "so far", so a half-finished day doesn't read as a fall.
- **Shares on tiles use a rolling sparkline:** the share over the last 7 days (4 weeks for a year), worked out from the counts. Day-by-day shares jump about on small numbers.
- **Counts compare in percent; shares compare in points.** A share that went from 70% to 73% is "3 pts". Colour shows whether a change is good, always with an arrow too.

## Definitions

| Measure | How it's counted |
| --- | --- |
| Request | Anything someone asked us, including what we couldn't help with (not understood, a blocked category, asking for a person). |
| Search | A request we understood as a search for something. |
| Found a supplier | Of the searches, the share where we sent at least one business. |
| Searches that found nobody | Searches answered with no business at all. |
| Connection | A customer choosing a business and getting its WhatsApp link, with a reference code. |
| Connection rate | Of all requests, the share that led to at least one connection. |
| Said "Yes, sorted" | Of the final follow-up answers (sorted, couldn't help, no reply), the share that said sorted. "Not yet" doesn't count, as in track records. |
| Customers | People who asked us something in the period, each counted once. |
| New customers | People whose first request ever was in the period. |
| Came back | Of the period's customers, the share who asked on more than one day. |
| Handed to a person | Requests the team took over: no supplier, not understood twice, or the customer asked for a person. |
| Understood without Claude | Of the requests we read, the share our own engine, the phrasebook or the customer's own pick understood. |
| Live businesses | Active listings now. The change counts listings added since the period began. |
| Verified | Live businesses our team checked in person, by when they were verified. |
| Products listed | Products on live listings now. |
| Shown in searches (owner) | Replies the business was in. |
| Chosen when shown (owner) | Of those, the share where the customer then chose it. |
| Share of demand (owner) | Of the requests for its categories in its city, the share where it came up. |
| Average position (owner) | Its place in our list of up to three, on average; 1 is the top. |

The queries are in `src/ops/insights.ts` (the team) and `src/web/analytics.ts` (owners). The periods and filters are in `src/web/periods.ts`.

## Colour

Dark only, like the rest of the service. The rules come from a validated method:

- **One series:** the brand teal (`#3ecfa6`), with the period before in grey.
- **Several series:** the categorical order aqua, orange, blue, yellow, magenta, green, violet, red. It's checked against the card (`#161413`) for colour-blind readers: the worst neighbouring pair is ΔE 9.4, against a target of 8; for normal vision it's 19.3, against a floor of 15.
  - A ninth series is never a new colour: it folds into "Other" (grey).
  - Colour follows the thing, not its rank. A category group keeps its colour when a filter changes which groups show.
  - The parts of a bar sit in the colours' fixed order, so only the checked neighbours touch.
- **Magnitude** (heatmaps): one teal ramp, darker for fewer.
- **Funnel stages:** a teal ramp whose every step clears 2:1 on the card.
- **Good and bad** (on target, couldn't help, no reply): status colours, used only where the data means good or bad, and always with words or an icon.

Every chart has a table view and a CSV download. In CSV, text a spreadsheet would read as a formula gets a leading apostrophe.

## Trying it on sample activity

```
npm run db:demo
```

- **What it adds:** about seven months of fictional activity to the local database. That's 100 sample businesses with owners, products and price changes, and about 25,000 requests across Harare (and some of Bulawayo and other towns). It also adds connections and follow-up answers, website sign-ups and dashboard visits.
- **Showcase link:** it prints a one-time link to the dashboard of the busiest sample shop.
- **Options:** `-- --days 120` sets the number of days; `-- --clear` removes it all.
- **Marking:** everything it adds is marked (numbers starting `2637999`), so clearing it leaves the rest alone.
- **Production is safe:** it refuses to run with `DATABASE_URL` set or with `NODE_ENV=production`.
- **Stop the server first:** the local database takes one process at a time.

The `findzim-demo` entry in `.claude/launch.json` runs the site on port 3001 against its own sample database (`.claude/demo.env`, `.data/pglite-demo`).

## Speed

- **Indexes:** migration 017 adds the indexes the reports lean on: requests and connections by date, requests by category and date, and connections by request.
- **On the local embedded database,** with the sample data:
  - a 30-day page answers in about half a second;
  - the 12-month overview takes about two seconds.
- **On the production Postgres** they should be far quicker.
