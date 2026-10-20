// Fingerprints and "changed since you last read it" tagging.
import type { Counts } from './detect.ts';

export type Tag = 'changed' | 'new' | 'unchanged';

// "<additions>/<deletions>:<sha of changed lines>". The line hash is empty
// when the diff was not rendered (large files, binaries, pure renames).
export function fingerprint(counts: Counts | null, linesHash: string): string {
  const c = counts ? `${counts.additions}/${counts.deletions}` : '?';
  return `${c}:${linesHash}`;
}

export function sameFingerprint(a: string, b: string): boolean {
  if (a === b) return true;
  const [ca, ha] = splitFingerprint(a);
  const [callback, hb] = splitFingerprint(b);
  // With a line hash on only one side, the counts are all we can compare.
  if (ha && hb) return false;
  return ca === callback && ca !== '?';
}

// Compares what the reader saw before (baseline) with one file now. Returns
// null on a first visit (empty baseline), so that visit looks like it did
// without this feature.
export function tagFile(
  baseline: Record<string, string>,
  hash: string,
  fp: string
): null | Tag {
  if (Object.keys(baseline).length === 0) return null;
  const before = baseline[hash];
  return before === undefined
    ? 'new'
    : sameFingerprint(before, fp)
      ? 'unchanged'
      : 'changed';
}

function splitFingerprint(f: string): [string, string] {
  const index = f.indexOf(':');
  return index === -1 ? [f, ''] : [f.slice(0, index), f.slice(index + 1)];
}
