// Which GitHub pages show diffs, and how they are keyed.

export interface Page {
  // PR number, only on pull request pages.
  number: null | string;
  path: string;
  // Storage key for per-page state: "owner/repo#12" for a PR,
  // "owner/repo@<sha>" for a commit, "owner/repo@<range>" for a compare.
  prKey: string;
  repo: string;
  // The whole PR diff (not one commit or a range), so fingerprints taken
  // here describe the PR and can be recorded for "changed since last visit".
  whole: boolean;
}

const PULL =
  /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(files|changes|commits\/[0-9a-f]+)(\/[^/]*)?\/?$/;
const COMMIT = /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})\/?$/;
const COMPARE = /^\/([^/]+)\/([^/]+)\/compare\/(.+?)\/?$/;

export function parsePage(pathname: string): null | Page {
  let m = pathname.match(PULL);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    const whole = (m[4] === 'files' || m[4] === 'changes') && !m[5]?.slice(1);
    return {
      number: m[3],
      path: pathname,
      prKey: `${repo}#${m[3]}`.toLowerCase(),
      repo,
      whole,
    };
  }
  m = pathname.match(COMMIT) ?? pathname.match(COMPARE);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    return {
      number: null,
      path: pathname,
      prKey: `${repo}@${decodeURIComponent(m[3])}`.toLowerCase(),
      repo,
      whole: false,
    };
  }
  return null;
}

// Path candidates from one header string. Renames render as "old → new".
export function renameCandidates(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (!t.includes('→')) return [t];
  return [t, t.split('→').pop()!.trim()].filter(Boolean);
}
