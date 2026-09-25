import fs from "node:fs";

/** The app's version from package.json (one folder up from both src/ and dist/). */
export const VERSION: string = (() => {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
})();

export const STARTED_AT = new Date();
