// Reading price lists: CSV files and cells pasted from Excel or Google Sheets.

/** The product fields a column can fill, and the headings people use for them. */
export const FIELDS = [
  { key: "name", label: "Product name", aliases: ["name", "product", "product name", "item", "item name", "title", "product title"] },
  { key: "price", label: "Price (US$)", aliases: ["price", "price usd", "usd", "price us", "amount", "selling price", "retail price", "unit price", "cost"] },
  { key: "unit", label: "Unit", aliases: ["unit", "per", "uom", "unit of measure", "units", "pack", "size"] },
  { key: "sku", label: "Code (SKU)", aliases: ["sku", "code", "item code", "stock code", "product code", "barcode", "ref", "reference", "part number", "model"] },
  { key: "category", label: "Category", aliases: ["category", "department", "group", "type", "section", "range"] },
  { key: "description", label: "Description", aliases: ["description", "details", "notes", "info", "specs", "specification"] },
  { key: "inStock", label: "In stock (yes or no)", aliases: ["in stock", "in_stock", "instock", "stock", "available", "availability", "status"] },
  {
    key: "photoUrl",
    label: "Photo link",
    aliases: ["photo", "photo url", "photo link", "product photo", "image", "image url", "image link", "product image", "picture", "picture url", "img", "img url", "image src", "main image", "thumbnail", "photos", "images"],
  },
];

const normalize = (s) => s.toLowerCase().replace(/[_\-]+/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** Which separator a sheet uses: tabs (pasted cells), semicolons (some European Excel) or commas. */
function separatorOf(text) {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const count = (ch) => {
    let n = 0;
    let quoted = false;
    for (const c of first) {
      if (c === '"') quoted = !quoted;
      else if (c === ch && !quoted) n++;
    }
    return n;
  };
  const tabs = count("\t");
  const semis = count(";");
  const commas = count(",");
  if (tabs >= 1 && tabs >= commas) return "\t";
  if (semis > commas) return ";";
  return ",";
}

/** Rows of cells, following CSV quoting ("" inside quotes is a quote; quoted cells may hold new lines). */
export function parseSheet(text) {
  const src = text.replace(/^﻿/, "");
  const sep = separatorOf(src);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const clean = rows.filter((r) => r.some((c) => c.trim() !== ""));
  const width = Math.max(0, ...clean.map((r) => r.length));
  return clean.map((r) => [...r, ...Array(width - r.length).fill("")]);
}

/**
 * A best guess at which field each column fills, from its heading. "" leaves a column out.
 * An exact heading wins; otherwise the longest heading word found ("product description" is a
 * description, not a name).
 */
export function guessMapping(headers) {
  const taken = new Set();
  return headers.map((h) => {
    const n = normalize(h);
    let best = null;
    let bestLength = 0;
    for (const f of FIELDS) {
      if (taken.has(f.key)) continue;
      if (f.aliases.includes(n)) {
        best = f;
        bestLength = Infinity;
        break;
      }
      for (const a of f.aliases) {
        if (a.length > 3 && n.includes(a) && a.length > bestLength) {
          best = f;
          bestLength = a.length;
        }
      }
    }
    if (!best) return "";
    taken.add(best.key);
    return best.key;
  });
}

/** True when the first row looks like headings rather than a product. */
export function hasHeadings(rows) {
  if (!rows.length) return false;
  return guessMapping(rows[0]).filter(Boolean).length >= 1;
}

/** Rows for the import API: only the mapped columns, as text. */
export function toImportRows(rows, mapping) {
  return rows.map((r) => {
    const out = {};
    mapping.forEach((key, i) => {
      if (key) out[key] = (r[i] ?? "").trim();
    });
    return out;
  });
}
