/** When the team answers chats that were handed to a person, in Harare time. */
export interface TeamHours {
  /** Days of the week, 0 = Sunday. */
  days: number[];
  /** Minutes after midnight. */
  open: number;
  close: number;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Mon-Sat 08:00-18:00" → Monday to Saturday, 8am to 6pm. */
export function parseTeamHours(text: string): TeamHours {
  const m = text.trim().toLowerCase().match(/^([a-z]{3})(?:\s*-\s*([a-z]{3}))?\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  const from = DAYS.indexOf(m?.[1] ?? "");
  const to = DAYS.indexOf(m?.[2] ?? m?.[1] ?? "");
  if (!m || from < 0 || to < 0) throw new Error(`TEAM_HOURS should look like "Mon-Sat 08:00-18:00", not "${text}"`);
  const days: number[] = [];
  for (let d = from; ; d = (d + 1) % 7) {
    days.push(d);
    if (d === to) break;
  }
  const open = Number(m[3]) * 60 + Number(m[4]);
  const close = Number(m[5]) * 60 + Number(m[6]);
  if (open >= close || close > 24 * 60) throw new Error(`TEAM_HOURS closes before it opens: "${text}"`);
  return { days, open, close };
}

function harareClock(now: Date): { day: number; minutes: number } {
  const local = new Date(now.getTime() + 2 * 3600_000);
  return { day: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** "8am", "8:30am", "12pm". */
function clockTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

export function teamIsIn(now: Date, hours: TeamHours): boolean {
  const { day, minutes } = harareClock(now);
  return hours.days.includes(day) && minutes >= hours.open && minutes < hours.close;
}

/** For a handoff message: a person replies soon, or when the team is next in. */
export function whenTeamReplies(now: Date, hours: TeamHours): string {
  if (teamIsIn(now, hours)) return "A person will reply here soon.";
  const { day, minutes } = harareClock(now);
  const at = clockTime(hours.open);
  if (hours.days.includes(day) && minutes < hours.open) return `Our team starts at ${at} today, and a person will reply then.`;
  for (let ahead = 1; ahead <= 7; ahead++) {
    const d = (day + ahead) % 7;
    if (hours.days.includes(d)) return `Our team is back at ${at} ${ahead === 1 ? "tomorrow" : `on ${DAY_NAMES[d]}`}, and a person will reply then.`;
  }
  return "A person will reply here as soon as they can.";
}

/** Midnight on the 1st of the month in Harare, for the given moment. */
export function harareStartOfMonth(now: Date): Date {
  const local = new Date(now.getTime() + 2 * 3600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - 2 * 3600_000);
}

/** Midnight in Harare (UTC+2, no daylight saving) for the given moment. */
export function harareStartOfDay(now: Date): Date {
  const local = new Date(now.getTime() + 2 * 3600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 2 * 3600_000);
}
