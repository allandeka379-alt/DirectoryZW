import "dotenv/config";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { one, openDb } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { createUser, generatePassword, listUsers, normalizeEmail, ROLES, updateUser, type Role } from "./accounts.js";

const USAGE = `Ops console accounts.

  npm run ops:user -- add --email ruth@example.com --name "Ruth Moyo" [--role admin|staff]
  npm run ops:user -- reset --email ruth@example.com     (new password, signs them out)
  npm run ops:user -- list

In production (after npm run build): node dist/ops/user-cli.js add ...
New passwords are printed once. Pass them on privately.`;

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string" } },
});

const command = positionals[0];
if (!command || !["add", "reset", "list"].includes(command)) {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}

const config = loadConfig();
const db = await openDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
try {
  await migrate(db);
  if (command === "list") {
    for (const u of await listUsers(db)) console.log(`${u.active ? " " : "x"} ${u.role.padEnd(5)} ${u.email}  (${u.name})`);
  } else if (command === "add") {
    const role = (values.role ?? "staff") as Role;
    if (!values.email || !values.name || !ROLES.includes(role)) throw new Error("Give --email, --name and optionally --role admin|staff");
    const password = generatePassword();
    const user = await createUser(db, { name: values.name, email: values.email, role, password });
    console.log(`Created ${user.role} ${user.email}. Password: ${password}`);
  } else {
    if (!values.email) throw new Error("Give --email");
    const user = await one<{ id: string }>(db, "SELECT id FROM ops_users WHERE email = $1", [normalizeEmail(values.email)]);
    if (!user) throw new Error(`No account for ${values.email}`);
    const password = generatePassword();
    await updateUser(db, user.id, { password, active: true });
    console.log(`New password for ${values.email}: ${password}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.close();
}
