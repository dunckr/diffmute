// Fingerprints and "changed since you last read it" tagging.
import type { Counts } from "./detect.ts";

export type Tag = "new" | "changed" | "unchanged";

// "<additions>/<deletions>:<sha of changed lines>". The line hash is empty
// when the diff was not rendered (large files, binaries, pure renames).
export function fingerprint(counts: Counts | null, linesHash: string): string {
  const c = counts ? `${counts.additions}/${counts.deletions}` : "?";
  return `${c}:${linesHash}`;
}

export function sameFingerprint(a: string, b: string): boolean {
  if (a === b) return true;
  const [ca, ha] = splitFingerprint(a);
  const [cb, hb] = splitFingerprint(b);
  // With a line hash on only one side, the counts are all we can compare.
  if (ha && hb) return false;
  return ca === cb && ca !== "?";
}

function splitFingerprint(f: string): [string, string] {
  const i = f.indexOf(":");
  return i === -1 ? [f, ""] : [f.slice(0, i), f.slice(i + 1)];
}

// Compares what the reader saw before (baseline) with one file now. Returns
// null on a first visit (empty baseline), so that visit looks like it did
// without this feature.
export function tagFile(baseline: Record<string, string>, hash: string, fp: string): Tag | null {
  if (!Object.keys(baseline).length) return null;
  const before = baseline[hash];
  return before === undefined ? "new" : sameFingerprint(before, fp) ? "unchanged" : "changed";
}

export function tagFiles(baseline: Record<string, string>, current: Map<string, string>): Map<string, Tag> {
  const tags = new Map<string, Tag>();
  for (const [hash, fp] of current) {
    const tag = tagFile(baseline, hash, fp);
    if (tag) tags.set(hash, tag);
  }
  return tags;
}
