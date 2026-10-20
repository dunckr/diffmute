import type { TierId } from './rules.ts';

// Reading order: group files into tiers so types are read before the code
// that uses them, and tests and config come last.
import { matches, matchesAny } from './glob.ts';

export type OrderTier = 'core' | 'start' | TierId;

// Display order. "core" is everything no tier claims.
export const TIER_ORDER: readonly OrderTier[] = [
  'start',
  'contracts',
  'core',
  'ui',
  'tests',
  'config',
];

export const TIER_NAMES: Record<OrderTier, string> = {
  config: 'Config and docs',
  contracts: 'Types and schema',
  core: 'Logic',
  start: 'Start here',
  tests: 'Tests',
  ui: 'UI',
};

// A test file is often also a .tsx file, so tests and config are matched
// before contracts and ui.
const MATCH_ORDER: readonly TierId[] = ['tests', 'config', 'contracts', 'ui'];

export interface OrderedFile {
  path: string;
  tier: OrderTier;
}

export function matchesPin(path: string, pin: string): boolean {
  const p = pin.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (!p) return false;
  if (path === p || path.startsWith(p + '/')) return true;
  if (/[*?[{]/.test(p)) return matches(path, p);
  return !p.includes('/') && path.split('/').pop() === p;
}

// Pinned files come first in pin order, then tiers in TIER_ORDER. Within a
// tier the input order (GitHub's) is kept.
export function orderFiles(
  paths: string[],
  tiers: Record<TierId, string[]>,
  pins: string[] = []
): OrderedFile[] {
  return paths
    .map((path, index) => {
      const pin = pins.length > 0 ? pinIndex(path, pins) : -1;
      return {
        i: index,
        path,
        pin,
        tier: pin >= 0 ? ('start' as const) : tierOf(path, tiers),
      };
    })
    .sort(
      (a, b) =>
        tierRank(a.tier) - tierRank(b.tier) || a.pin - b.pin || a.i - b.i
    )
    .map(({ path, tier }) => ({ path, tier }));
}

function pinIndex(path: string, pins: string[]): number {
  return pins.findIndex((pin) => matchesPin(path, pin));
}

function tierOf(path: string, tiers: Record<TierId, string[]>): OrderTier {
  return MATCH_ORDER.find((id) => matchesAny(path, tiers[id])) ?? 'core';
}

const HEADING = /^\W*review[\s-]*order\b/i;

export function isReviewOrderHeading(text: string): boolean {
  return HEADING.test(text.trim());
}

// Pulls a path out of one list item of the author's "Review order" section.
// A code span wins; otherwise the first token that looks like a path.
export function pinFromItem(code: null | string, text: string): null | string {
  const c = code?.trim();
  if (c) return c;
  const token = text
    .trim()
    .split(/\s+/)
    .map((t) => t.replaceAll(/^[("'`]+|[)"'`,.;:]+$/g, ''))
    .find((t) => /[/.*]/.test(t) && !/^https?:/.test(t));
  return token || null;
}

function tierRank(tier: OrderTier): number {
  return TIER_ORDER.indexOf(tier);
}
