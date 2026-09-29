import type { FastifyInstance } from "fastify";
import type { App } from "../app.js";
import { one } from "../db/client.js";
import { isUuid } from "../directory/businesses.js";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** A wa.me link that opens a chat with our number and their first message typed in. */
const waLink = (number: string, text: string) => `https://wa.me/${number}?text=${encodeURIComponent(text).replace(/'/g, "%27")}`;

interface LiveProduct {
  id: string;
  name: string;
  description: string;
  price_usd: string | null;
  price_text: string | null;
  unit: string | null;
  photo_id: string | null;
  price_updated_at: Date | null;
  in_stock: boolean;
  business: string;
  verification: string;
  area: string | null;
}

/**
 * What the public can see of a product: its page (/p/:id) and its photo (/media/products/:photoId).
 * WhatsApp's catalog needs both for every product in it, and a product's page is also a link a
 * store can share. A product taken down, or of a store that isn't live, isn't shown; out of stock,
 * its page stays and says so. Other photos (shopfronts, field checks) are never served here.
 */
export function registerPublicProducts(server: FastifyInstance, app: App): void {
  const { db, config } = app;

  server.get("/media/products/:photoId", async (req, reply) => {
    const id = (req.params as { photoId: string }).photoId.replace(/\.(jpe?g|png|webp)$/i, "");
    const photo = isUuid(id)
      ? await one<{ storage_key: string; content_type: string }>(
          db,
          `SELECT p.storage_key, p.content_type FROM business_photos p
             JOIN offerings o ON o.photo_id = p.id JOIN businesses b ON b.id = o.business_id
            WHERE p.id = $1 AND p.kind = 'product' AND o.archived_at IS NULL AND b.status = 'active'
            LIMIT 1`,
          [id],
        )
      : undefined;
    const data = photo ? await app.store.get(photo.storage_key) : undefined;
    if (!photo || !data) return reply.code(404).type("text/plain").send("Not found");
    return reply.type(photo.content_type).header("Cache-Control", "public, max-age=86400").send(data);
  });

  server.get("/p/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const p = isUuid(id)
      ? await one<LiveProduct>(
          db,
          `SELECT o.id, o.name, o.description, o.price_usd, o.price_text, o.unit, o.photo_id, o.price_updated_at, o.in_stock,
                  b.name AS business, b.verification, a.name AS area
             FROM offerings o JOIN businesses b ON b.id = o.business_id LEFT JOIN areas a ON a.id = b.area_id
            WHERE o.id = $1 AND o.archived_at IS NULL AND b.status = 'active'`,
          [id],
        )
      : undefined;
    const brand = esc(config.brandName);
    const wa = config.whatsapp.number;
    if (!p) {
      const ask = waLink(wa, "Hi");
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .send(
          page(brand, "Not available", `<h1>This product isn't available any more</h1>
            <p class="muted">The store may have sold out or taken it down. Tell us what you're looking for on WhatsApp, and we'll find who has it now.</p>
            <a class="btn btn-lg btn-brand" href="${esc(ask)}" rel="noopener">Ask on WhatsApp</a>`),
        );
    }
    const code = `P-${p.id.slice(0, 8)}`;
    const price = p.price_usd != null ? `$${Number(p.price_usd).toFixed(2)}` : p.price_text;
    const ask = waLink(wa, `Hi, I'm interested in ${p.name} (${code})`);
    const image = p.photo_id ? `${config.publicBaseUrl}/media/products/${p.photo_id}` : null;
    const where = [p.business, p.area].filter(Boolean).join(", ");
    const updated = p.price_updated_at
      ? `Price updated ${new Date(p.price_updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Harare" })}`
      : "";
    const meta = `
    <meta property="og:type" content="product" />
    <meta property="og:title" content="${esc(p.name)}${price ? ` · ${esc(price)}` : ""}" />
    <meta property="og:description" content="${esc(`Sold by ${where}. Ask about it on WhatsApp.`)}" />
    <meta property="og:url" content="${esc(`${config.publicBaseUrl}/p/${p.id}`)}" />
    ${image ? `<meta property="og:image" content="${esc(image)}" />` : ""}`;
    return reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "no-cache")
      .send(
        page(
          brand,
          p.name,
          `<article class="card product-page">
            ${image ? `<img class="product-photo" src="${esc(image)}" alt="${esc(p.name)}" />` : ""}
            <div class="product-info">
              <h1>${esc(p.name)}</h1>
              ${price ? `<p class="product-price">${esc(price)}${p.unit && p.unit !== "each" ? ` <span class="muted">${esc(p.unit)}</span>` : ""}</p>` : `<p class="muted">Ask the store for the price.</p>`}
              ${p.in_stock ? "" : `<p><span class="badge warn">Out of stock right now</span> Ask the store when it's back.</p>`}
              <p>Sold by <strong>${esc(p.business)}</strong>${p.area ? ` in ${esc(p.area)}` : ""}
                ${p.verification === "verified" ? `<span class="badge good">Verified by our team</span>` : `<span class="badge warn">Not verified yet</span>`}</p>
              ${p.description.trim() ? `<p class="muted">${esc(p.description.trim())}</p>` : ""}
              <a class="btn btn-lg btn-brand" href="${esc(ask)}" rel="noopener">Ask about it on WhatsApp</a>
              <p class="faint">${esc([updated, `Code ${code}`].filter(Boolean).join(" · "))}. The store sets its own prices.</p>
            </div>
          </article>`,
          meta,
        ),
      );
  });
}

function page(brand: string, title: string, body: string, meta = ""): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)} · ${brand}</title>
    <meta name="theme-color" content="#0c0a09" />${meta}
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <script src="/assets/theme.js"></script>
    <link rel="stylesheet" href="/assets/base.css" />
    <link rel="stylesheet" href="/assets/site.css" />
  </head>
  <body>
    <header class="nav">
      <div class="wrap nav-inner">
        <a class="brandmark" href="/"><img src="/assets/logo.svg" alt="" />${brand}</a>
      </div>
    </header>
    <main class="wrap product-wrap">${body}</main>
  </body>
</html>`;
}
