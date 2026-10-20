// Pure helpers for structural detection. The content script reads the DOM
// and hands plain strings to these, so they can be tested without a browser.

export interface Counts {
  changes: number;
  additions: number;
  deletions: number;
}

const COUNTS = /([\d,]+)\s+changes?:\s*([\d,]+)\s+additions?\s*&\s*([\d,]+)\s+deletions?/i;

const num = (s: string) => Number(s.replace(/,/g, ""));

// Parses GitHub's "12 changes: 7 additions & 5 deletions" header text.
export function parseCounts(text: string): Counts | null {
  const m = text.match(COUNTS);
  return m ? { changes: num(m[1]), additions: num(m[2]), deletions: num(m[3]) } : null;
}

// True when removed and added lines carry the same text once all whitespace
// is dropped, so reindenting and rewrapping count but moving code between
// lines in a different order does not. Needs at least one changed line.
export function whitespaceOnly(removed: string[], added: string[]): boolean {
  if (!removed.length && !added.length) return false;
  const squash = (lines: string[]) => lines.join("").replace(/\s+/g, "");
  return squash(removed) === squash(added);
}
