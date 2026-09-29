// Matching many photo files to products by their file names: the product's code (CEM-50.jpg) or its
// name (Defy fridge 300L.jpg). A copy number the computer or camera added ("CEM-50 (2).jpg",
// "CEM-50_1.jpg") doesn't stop a match.

/** Letters and digits only, in lower case: "Défy Fridge-300L" and "defy_fridge_300l" are the same. */
export function squash(text) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** The ways a file's name may name its product: as it is, then without a copy number. */
function keysOf(fileName) {
  const base = fileName.replace(/\.[a-z0-9]{2,5}$/i, "");
  const keys = [squash(base)];
  const copy = base.replace(/\s*\(\d{1,2}\)$|_\d{1,2}$/, "");
  if (copy !== base) keys.push(squash(copy));
  return keys.filter(Boolean);
}

/**
 * For each file, the product it's a photo of: by code first, then by name. `by` says which, and is
 * null when nothing matched, for the owner to choose.
 */
export function matchPhotos(fileNames, products) {
  const byCode = new Map();
  const byName = new Map();
  for (const p of products) {
    if (p.sku) byCode.set(squash(p.sku), p);
    const key = squash(p.name);
    if (key && !byName.has(key)) byName.set(key, p);
  }
  return fileNames.map((file) => {
    for (const key of keysOf(file)) {
      if (byCode.has(key)) return { file, product: byCode.get(key), by: "code" };
      if (byName.has(key)) return { file, product: byName.get(key), by: "name" };
    }
    return { file, product: null, by: null };
  });
}
