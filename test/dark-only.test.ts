import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// FindZim has one look: dark. No page offers a light/dark switch, and nothing can turn a page light.
const ROOT = path.resolve(import.meta.dirname, "..");

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return filesUnder(full);
    return /\.(html|css|js|ts)$/.test(e.name) ? [full] : [];
  });
}

describe("dark mode only", () => {
  const files = [...filesUnder(path.join(ROOT, "public")), ...filesUnder(path.join(ROOT, "src"))];

  it("has no theme switch and no light theme anywhere", () => {
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const where = path.relative(ROOT, file);
      expect(text, where).not.toContain("data-theme-toggle");
      expect(text, where).not.toContain('data-theme="light"');
      expect(text, where).not.toMatch(/prefers-color-scheme/);
      expect(text, where).not.toMatch(/color-scheme:\s*light/);
      expect(text, where).not.toContain("themeSwitch");
    }
  });

  it("theme.js clears an old saved choice and keeps the page dark", () => {
    const js = fs.readFileSync(path.join(ROOT, "public/web/theme.js"), "utf8");
    expect(js).toContain('localStorage.removeItem(KEY)');
    expect(js).toContain('"dz.theme"');
    expect(js).toContain("#0c0a09");
    expect(js).not.toMatch(/setAttribute\("data-theme"/);
  });
});
