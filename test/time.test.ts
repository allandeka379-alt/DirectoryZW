import { describe, expect, it } from "vitest";
import { parseTeamHours, teamIsIn, whenTeamReplies } from "../src/time.js";

/** A moment given in Harare time (UTC+2). 2026-09-29 is a Tuesday. */
const harare = (iso: string) => new Date(`${iso}+02:00`);
const hours = parseTeamHours("Mon-Sat 08:00-18:00");

describe("team hours", () => {
  it("reads the setting", () => {
    expect(hours).toEqual({ days: [1, 2, 3, 4, 5, 6], open: 480, close: 1080 });
    expect(parseTeamHours("sat-mon 9:30-13:00")).toEqual({ days: [6, 0, 1], open: 570, close: 780 });
    expect(() => parseTeamHours("weekdays")).toThrow(/TEAM_HOURS/);
    expect(() => parseTeamHours("Mon-Fri 18:00-08:00")).toThrow(/closes before it opens/);
  });

  it("says when a person will reply", () => {
    expect(teamIsIn(harare("2026-09-29T10:00:00"), hours)).toBe(true);
    expect(whenTeamReplies(harare("2026-09-29T10:00:00"), hours)).toBe("A person will reply here soon.");
    expect(whenTeamReplies(harare("2026-09-29T06:30:00"), hours)).toBe("Our team starts at 8am today, and a person will reply then.");
    expect(whenTeamReplies(harare("2026-09-29T19:00:00"), hours)).toBe("Our team is back at 8am tomorrow, and a person will reply then.");
    // Saturday evening: Sunday is off.
    expect(whenTeamReplies(harare("2026-10-03T19:00:00"), hours)).toBe("Our team is back at 8am on Monday, and a person will reply then.");
    expect(whenTeamReplies(harare("2026-09-29T19:00:00"), parseTeamHours("Mon-Sat 08:30-17:00"))).toContain("8:30am tomorrow");
  });
});
