export interface ReplyButton {
  id: string;
  title: string;
}
export interface ListRow {
  id: string;
  title: string;
  description?: string;
}
export interface ListSection {
  title?: string;
  rows: ListRow[];
}
/** Products from our catalog, under one heading (a store's name). */
export interface ProductSection {
  title: string;
  /** Catalog retailer IDs; the name, price and photo are for the simulator and logs (WhatsApp shows the catalog's own). */
  products: { id: string; name?: string; price?: string | null; image?: string | null }[];
}

export type OutboundMessage =
  | { kind: "text"; text: string }
  | { kind: "buttons"; body: string; buttons: ReplyButton[]; header?: string; footer?: string }
  | { kind: "list"; body: string; button: string; sections: ListSection[]; header?: string; footer?: string }
  | { kind: "cta_url"; body: string; displayText: string; url: string; footer?: string }
  | { kind: "location_request"; body: string }
  | { kind: "contact_card"; name: string; phone: string }
  /** WhatsApp's own product cards, from our catalog: photos, prices, "View items". */
  | { kind: "product_list"; catalogId: string; header: string; body: string; footer?: string; sections: ProductSection[] }
  | {
      kind: "template";
      name: string;
      language: string;
      bodyParams: string[];
      quickReplies?: ReplyButton[];
      /** What to show when templates don't apply (simulator, logs). */
      fallback: OutboundMessage;
    };

/** WhatsApp Cloud API limits for interactive messages. */
export const LIMITS = {
  text: 4096,
  body: 1024,
  listBody: 4096,
  header: 60,
  footer: 60,
  buttonTitle: 20,
  buttons: 3,
  listButton: 20,
  rows: 10,
  rowTitle: 24,
  rowDescription: 72,
  sectionTitle: 24,
  ctaText: 20,
  id: 256,
  productSections: 10,
  products: 30,
} as const;

export function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Enforce WhatsApp's limits so a message is never rejected for length or count. */
export function normalize(msg: OutboundMessage): OutboundMessage {
  switch (msg.kind) {
    case "text":
      return { ...msg, text: truncate(msg.text, LIMITS.text) };
    case "buttons":
      return {
        ...msg,
        body: truncate(msg.body, LIMITS.body),
        header: msg.header ? truncate(msg.header, LIMITS.header) : undefined,
        footer: msg.footer ? truncate(msg.footer, LIMITS.footer) : undefined,
        buttons: msg.buttons.slice(0, LIMITS.buttons).map((b) => ({ id: b.id.slice(0, LIMITS.id), title: truncate(b.title, LIMITS.buttonTitle) })),
      };
    case "list": {
      let remaining: number = LIMITS.rows;
      const sections = msg.sections
        .map((s) => {
          const rows = s.rows.slice(0, Math.max(0, remaining)).map((r) => ({
            id: r.id.slice(0, LIMITS.id),
            title: truncate(r.title, LIMITS.rowTitle),
            description: r.description ? truncate(r.description, LIMITS.rowDescription) : undefined,
          }));
          remaining -= rows.length;
          return { title: s.title ? truncate(s.title, LIMITS.sectionTitle) : undefined, rows };
        })
        .filter((s) => s.rows.length > 0);
      return {
        ...msg,
        body: truncate(msg.body, LIMITS.listBody),
        button: truncate(msg.button, LIMITS.listButton),
        header: msg.header ? truncate(msg.header, LIMITS.header) : undefined,
        footer: msg.footer ? truncate(msg.footer, LIMITS.footer) : undefined,
        sections,
      };
    }
    case "cta_url":
      return {
        ...msg,
        body: truncate(msg.body, LIMITS.body),
        displayText: truncate(msg.displayText, LIMITS.ctaText),
        footer: msg.footer ? truncate(msg.footer, LIMITS.footer) : undefined,
      };
    case "location_request":
      return { ...msg, body: truncate(msg.body, LIMITS.body) };
    case "template":
      return {
        ...msg,
        // Template parameters may not contain new lines, tabs or runs of spaces.
        bodyParams: msg.bodyParams.map((p) => p.replace(/[\r\n\t]+/g, " · ").replace(/ {4,}/g, " ").trim() || "-"),
        fallback: normalize(msg.fallback),
      };
    case "contact_card":
      return msg;
    case "product_list": {
      let remaining: number = LIMITS.products;
      const sections = msg.sections
        .slice(0, LIMITS.productSections)
        .map((s) => {
          const products = s.products.slice(0, Math.max(0, remaining));
          remaining -= products.length;
          return { title: truncate(s.title, LIMITS.sectionTitle), products };
        })
        .filter((s) => s.products.length > 0);
      return {
        ...msg,
        header: truncate(msg.header, LIMITS.header),
        body: truncate(msg.body, LIMITS.body),
        footer: msg.footer ? truncate(msg.footer, LIMITS.footer) : undefined,
        sections,
      };
    }
  }
}

/** Build the Graph API request body for POST /{phone-number-id}/messages. */
export function toCloudPayload(to: string, input: OutboundMessage): Record<string, unknown> {
  const msg = normalize(input);
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  switch (msg.kind) {
    case "text":
      return { ...base, type: "text", text: { body: msg.text, preview_url: false } };
    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          ...(msg.header ? { header: { type: "text", text: msg.header } } : {}),
          body: { text: msg.body },
          ...(msg.footer ? { footer: { text: msg.footer } } : {}),
          action: { buttons: msg.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
        },
      };
    case "list":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          ...(msg.header ? { header: { type: "text", text: msg.header } } : {}),
          body: { text: msg.body },
          ...(msg.footer ? { footer: { text: msg.footer } } : {}),
          action: {
            button: msg.button,
            sections: msg.sections.map((s) => ({
              ...(s.title ? { title: s.title } : {}),
              rows: s.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })),
            })),
          },
        },
      };
    case "cta_url":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "cta_url",
          body: { text: msg.body },
          ...(msg.footer ? { footer: { text: msg.footer } } : {}),
          action: { name: "cta_url", parameters: { display_text: msg.displayText, url: msg.url } },
        },
      };
    case "location_request":
      return {
        ...base,
        type: "interactive",
        interactive: { type: "location_request_message", body: { text: msg.body }, action: { name: "send_location" } },
      };
    case "contact_card":
      return {
        ...base,
        type: "contacts",
        contacts: [{ name: { formatted_name: msg.name, first_name: msg.name }, phones: [{ phone: `+${msg.phone}`, type: "WORK", wa_id: msg.phone }] }],
      };
    case "product_list":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "product_list",
          header: { type: "text", text: msg.header },
          body: { text: msg.body },
          ...(msg.footer ? { footer: { text: msg.footer } } : {}),
          action: {
            catalog_id: msg.catalogId,
            sections: msg.sections.map((s) => ({ title: s.title, product_items: s.products.map((p) => ({ product_retailer_id: p.id })) })),
          },
        },
      };
    case "template": {
      const components: unknown[] = [];
      if (msg.bodyParams.length) components.push({ type: "body", parameters: msg.bodyParams.map((text) => ({ type: "text", text })) });
      (msg.quickReplies ?? []).forEach((b, index) =>
        components.push({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload: b.id }] }),
      );
      return { ...base, type: "template", template: { name: msg.name, language: { code: msg.language }, components } };
    }
  }
}

/** Plain-text rendering, for logs and the ops inbox. */
export function describe(msg: OutboundMessage): string {
  switch (msg.kind) {
    case "text":
      return msg.text;
    case "buttons":
      return `${msg.body}\n[${msg.buttons.map((b) => b.title).join("] [")}]`;
    case "list":
      return `${msg.body}\n${msg.sections.flatMap((s) => s.rows.map((r) => `- ${r.title}${r.description ? ` (${r.description})` : ""}`)).join("\n")}`;
    case "cta_url":
      return `${msg.body}\n${msg.displayText}: ${msg.url}`;
    case "location_request":
      return `${msg.body}\n[Send location]`;
    case "contact_card":
      return `Contact: ${msg.name} +${msg.phone}`;
    case "product_list":
      return `${msg.header}\n${msg.body}\n${msg.sections
        .map((s) => `${s.title}: ${s.products.map((p) => [p.name ?? p.id, p.price].filter(Boolean).join(" ")).join(", ")}`)
        .join("\n")}`;
    case "template":
      return describe(msg.fallback);
  }
}
