/**
 * The privacy notice and the business terms, as pages of the public website (/privacy, /terms).
 * Plain English, and true to what the code does: the retention periods come from the settings.
 * PRIVACY_URL and BUSINESS_TERMS_URL can point elsewhere instead. A lawyer should review both
 * before launch (docs/DATA_PROTECTION.md).
 */

export interface LegalValues {
  brand: string;
  /** Where people write to us about their data (CONTACT_EMAIL). */
  contactEmail?: string;
  /** Our WhatsApp number, when WhatsApp is live. */
  whatsappNumber?: string;
  messageDays: number;
  requestDays: number;
  year: number;
}

/** When the wording last changed. Change it with the text. */
export const LEGAL_UPDATED = "30 September 2026";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** How to reach us, from what's set up: email first, then WhatsApp, then the registration page. */
function contactLine(v: LegalValues): string {
  if (v.contactEmail) return `write to us at <a href="mailto:${esc(v.contactEmail)}">${esc(v.contactEmail)}</a>`;
  if (v.whatsappNumber) return `message us on WhatsApp at +${esc(v.whatsappNumber.replace(/\D/g, ""))}`;
  return `leave your number on our <a href="/register">registration page</a> and our team will call you`;
}

function page(v: LegalValues, title: string, body: string): string {
  const brand = esc(v.brand);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}: ${brand}</title>
    <meta name="theme-color" content="#0c0a09" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <script src="/assets/theme.js"></script>
    <link rel="stylesheet" href="/assets/base.css" />
    <link rel="stylesheet" href="/assets/site.css" />
  </head>
  <body>
    <header class="nav">
      <div class="wrap nav-inner">
        <a class="brandmark" href="/"><img src="/assets/logo.svg" alt="" />${brand}</a>
        <div class="nav-cta">
          <a class="btn btn-ghost btn-sm" href="/app/">Sign in</a>
          <a class="btn btn-sm btn-brand" href="/register">Register</a>
        </div>
      </div>
    </header>
    <main class="wrap">
      <article class="legal">
        <h1>${esc(title)}</h1>
        <p class="muted">Last updated ${LEGAL_UPDATED}</p>
${body}
      </article>
    </main>
    <footer class="footer">
      <div class="wrap footer-inner">
        <a class="brandmark" href="/"><img src="/assets/logo.svg" alt="" />${brand}</a>
        <nav aria-label="Footer">
          <a href="/register">Register</a>
          <a href="/app/">Sign in</a>
          <a href="/terms">Business terms</a>
          <a href="/privacy">Privacy</a>
        </nav>
        <p class="faint">Operated by FINDZIM WORLD (PRIVATE) LIMITED.</p>
        <p class="faint">&copy; ${v.year} ${brand}. Made in Zimbabwe.</p>
      </div>
    </footer>
  </body>
</html>
`;
}

export function privacyPage(v: LegalValues): string {
  const brand = esc(v.brand);
  return page(
    v,
    "Privacy notice",
    `
        <p>${brand} helps people in Zimbabwe find businesses on WhatsApp, and helps businesses show what they sell. This notice says what we keep about you, why, who sees it and for how long, and how to have it deleted. To ask us anything about it, ${contactLine(v)}.</p>

        <h2>If you ask us for something on WhatsApp</h2>
        <p>We keep:</p>
        <ul>
          <li>your WhatsApp number and the name on your WhatsApp profile;</li>
          <li>your messages to us, what you asked for, and any location you share;</li>
          <li>the businesses we showed you and the ones you chose to contact;</li>
          <li>your answers to our follow-up, your ratings, and any report you make about a business.</li>
        </ul>
        <p>We use them to find businesses for you, to connect you with the one you choose, to ask once how it went, to keep dishonest businesses off ${brand}, and to get better at understanding requests. Voice notes and photos you send us are not downloaded or read.</p>

        <h2>If you list a business</h2>
        <p>We keep what you give us for the listing: the business's name, WhatsApp number, location, address, opening hours, description, products, prices and photos, and what our team noted when checking it. Most of it is public: customers see it on WhatsApp and on this website, and products with a photo and a price are also shown in WhatsApp's product catalog. We also keep a record of the customers we sent you and how it went, and your dashboard sign-ins.</p>

        <h2>Who else sees it</h2>
        <ul>
          <li><strong>The business you choose to contact</strong> sees what you asked for, with a reference code, and your number when you message them. Businesses you don't contact see nothing about you.</li>
          <li><strong>Meta</strong> carries every WhatsApp message, and holds the product catalog.</li>
          <li><strong>Anthropic</strong> reads some typed requests that our own system can't understand, without your number or name.</li>
          <li><strong>Our hosting and storage providers</strong> keep the database and photos for us.</li>
        </ul>
        <p>Some of these providers keep data outside Zimbabwe, under their own data protection terms. We never sell personal data, and we send no marketing.</p>

        <h2>How long we keep it</h2>
        <ul>
          <li>Messages: ${v.messageDays} days.</li>
          <li>The wording of your requests: ${v.requestDays} days. After that we keep only the kind of thing asked for, the area and whether it was found, for statistics.</li>
          <li>Ratings and reports: until you delete your data. Reports stay after that, without your name or number.</li>
          <li>A listing and its products: while the business is listed.</li>
          <li>Dashboard sign-in links: 15 minutes, or a day when our team sends one. Sessions: 30 days.</li>
        </ul>

        <h2>Messages we send you</h2>
        <p>We answer your messages. After you contact a business we may ask once how it went. If nobody had what you asked for and a business near you lists it soon after, we may tell you once. Type <strong>alerts off</strong> to stop those, or <strong>stop</strong> to stop everything until you write to us again.</p>

        <h2>Your choices</h2>
        <ul>
          <li><strong>Delete everything:</strong> type <strong>delete my data</strong> on WhatsApp and confirm. It happens straight away.</li>
          <li><strong>A copy of your data, or a correction:</strong> ${contactLine(v)}. Businesses can correct their listing themselves on the dashboard.</li>
          <li><strong>A complaint:</strong> tell us first, and we'll put it right if we can. You can also complain to POTRAZ, Zimbabwe's data protection authority.</li>
        </ul>

        <h2>Changes</h2>
        <p>If we change this notice we update this page and its date. If a change matters to you, we tell you before it takes effect.</p>`,
  );
}

export function termsPage(v: LegalValues): string {
  const brand = esc(v.brand);
  return page(
    v,
    "Business terms",
    `
        <p>These terms apply when you list a business on ${brand}. By listing it, you accept them for the business. To ask us anything about them, ${contactLine(v)}.</p>

        <h2>What ${brand} does</h2>
        <p>Customers tell ${brand} what they need on WhatsApp, and we show them businesses that have it. When a customer chooses your business, they message you directly on WhatsApp with a reference code from us. The sale, the price, delivery and payment are between you and the customer: we don't take payments or part in the deal.</p>

        <h2>Who can list</h2>
        <p>A business that trades lawfully in Zimbabwe, listed by its owner or by someone the owner has allowed to. You must be 18 or older.</p>

        <h2>What customers see</h2>
        <p>Your business's name, area, address, opening hours, WhatsApp number, description, products, prices and photos, whether our team has verified it, its customers' ratings, and how many customers we sent got what they needed. Products with a photo and a price also appear on their own page on this website and in WhatsApp's product catalog.</p>

        <h2>What you agree to</h2>
        <ul>
          <li>Everything in your listing is true, and yours to publish, and you keep it up to date: prices, stock, hours and location.</li>
          <li>You answer customers we send you, and treat them fairly: the price you listed is the price you charge, or you correct it first.</li>
          <li>You don't list anything illegal, counterfeit or dangerous, and you never ask a customer for a deposit you don't intend to honour.</li>
          <li>You use a customer's number only to deal with what they asked for.</li>
          <li>You let us show your listing, products and photos on WhatsApp, on this website and in WhatsApp's product catalog, and make photos smaller to do so. You still own them.</li>
        </ul>

        <h2>Checks, reports and pausing</h2>
        <p>Our team may visit or call to verify your business. Verified means we checked it in person at that time; it isn't a guarantee. We look into every customer report. We may pause or remove a listing that breaks these terms, fails a check, or gets reports from several customers who contacted it. A listing we pause is switched back on by our team; tell us if you think we got it wrong.</p>

        <h2>Messages we send you</h2>
        <p>About your listing: customers we sent you, a weekly summary when there was activity, and sign-in links for the dashboard when you ask for one. We never share your data except as our <a href="/privacy">privacy notice</a> says.</p>

        <h2>Leaving</h2>
        <p>You can pause or remove your listing at any time on the dashboard, or type <strong>pause</strong> or <strong>remove</strong> on WhatsApp. Type <strong>delete my data</strong> to delete the listing and everything we hold about it.</p>

        <h2>Changes, and our responsibility</h2>
        <p>We may change ${brand} and these terms. We tell you before a change to these terms takes effect, and you can remove your listing if you don't accept it. We work to keep ${brand} running and accurate, but we can't promise it always will be, and we aren't responsible for what customers and businesses do between themselves, as far as the law allows. These terms are governed by the laws of Zimbabwe.</p>`,
  );
}
