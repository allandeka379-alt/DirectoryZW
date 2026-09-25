import "dotenv/config";
import { loadConfig } from "../config.js";
import { TEMPLATES, templatePayload } from "./templates.js";

const USAGE = `WhatsApp message templates.

  npm run templates             show whether each template is approved
  npm run templates -- --create submit the ones Meta doesn't have yet

Needs WHATSAPP_ACCESS_TOKEN (with whatsapp_business_management) and WHATSAPP_BUSINESS_ACCOUNT_ID.
Templates are reviewed by Meta, usually within minutes, sometimes up to a day.`;

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const config = loadConfig();
const { accessToken, businessAccountId, graphVersion, templates } = config.whatsapp;
if (!accessToken || !businessAccountId) {
  console.error("Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID first.\n");
  console.log(USAGE);
  process.exit(1);
}

const url = `https://graph.facebook.com/${graphVersion}/${businessAccountId}/message_templates`;
const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

interface MetaTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
  rejected_reason?: string;
}

async function existing(): Promise<MetaTemplate[]> {
  const res = await fetch(`${url}?fields=name,language,status,category,rejected_reason&limit=200`, { headers });
  const body = (await res.json()) as { data?: MetaTemplate[]; error?: { message: string } };
  if (!res.ok) throw new Error(`Meta said: ${body.error?.message ?? res.status}`);
  return body.data ?? [];
}

const create = args.includes("--create");
const current = await existing();
let problems = 0;
for (const def of TEMPLATES) {
  const name = templates[def.key];
  const found = current.find((t) => t.name === name && t.language === templates.language);
  if (found) {
    const note = found.status === "REJECTED" ? ` (${found.rejected_reason ?? "no reason given"})` : "";
    if (found.status !== "APPROVED") problems++;
    console.log(`${found.status.padEnd(9)} ${name}${note}`);
    continue;
  }
  if (!create) {
    problems++;
    console.log(`MISSING   ${name}  (run with --create to submit it)`);
    continue;
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(templatePayload(def, name, templates.language)) });
  const body = (await res.json()) as { status?: string; error?: { message: string; error_user_msg?: string } };
  if (!res.ok) {
    problems++;
    console.log(`FAILED    ${name}: ${body.error?.error_user_msg ?? body.error?.message ?? res.status}`);
  } else {
    problems++;
    console.log(`SUBMITTED ${name}: ${body.status ?? "PENDING"}`);
  }
}
if (problems) console.log("\nRun this again later to check on templates that aren't approved yet.");
process.exitCode = problems ? 1 : 0;
