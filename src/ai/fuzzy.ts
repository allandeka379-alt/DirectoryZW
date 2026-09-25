/**
 * Edit distance between two words, counting two swapped letters as one edit, so "electritian"
 * is one edit from "electrician" and "plumbre" one from "plumber". Gives up early and returns
 * max + 1 once the words are clearly further apart than `max`.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    rows.push(row);
  }
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = d;
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
  }
  return rows[a.length]![b.length]!;
}

/**
 * How many wrong letters a word may have and still count as a misspelling: none under 6 letters
 * (too many real words are one letter apart: "shows", "shoes"), one from 6, two from 10.
 */
export function allowedEdits(length: number): number {
  return length >= 10 ? 2 : length >= 6 ? 1 : 0;
}
