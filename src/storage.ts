// Config lives in storage.sync. storage.sync caps each item at 8 KB, so each
// category is its own key ("category:<id>") with "categoryOrder" listing them,
// and the other sections get a key each. Per-PR state (revealed categories,
// files read, files viewed) lives in storage.local since it is only useful on
// this machine.
import { type Config, normalizeConfig } from './rules.ts';

const SECTION_KEYS = ['repos', 'ignore', 'features', 'tiers'] as const;
const ORDER_KEY = 'categoryOrder';
const CATEGORY_PREFIX = 'category:';
// Before 0.2 all categories were stored under one key.
const LEGACY_CATEGORIES = 'categories';
const PR_STATE_KEY = 'prState';
const PR_STATE_LIMIT = 300;
const PINS_KEY = 'pins';
const PINS_TTL = 60 * 60 * 1000;
const OUTLINE_KEY = 'outlineOpen';

export interface PrState {
  at: number;
  // File hash -> fingerprint of the patch when the user last read it.
  read: Record<string, string>;
  // Category ids the user revealed on this PR.
  shown: string[];
  // File hashes marked viewed locally (when GitHub's checkbox is absent).
  viewed: string[];
}

type AllPrState = Record<string, Partial<PrState>>;

type Pins = Record<string, { at: number; pins: string[] }>;

// Rebuilds the config object from the flat key layout.
export function fromStored(raw: Record<string, unknown>): Config {
  const order = raw[ORDER_KEY];
  const categories = Array.isArray(order)
    ? order.map((id) => raw[CATEGORY_PREFIX + String(id)]).filter(Boolean)
    : raw[LEGACY_CATEGORIES];
  const rest: Record<string, unknown> = {};
  for (const k of SECTION_KEYS) rest[k] = raw[k];
  return normalizeConfig({ ...rest, categories });
}

export async function loadConfig(): Promise<Config> {
  return fromStored(await browser.storage.sync.get(null));
}

export async function loadOutlineOpen(): Promise<boolean> {
  return (await getLocal(OUTLINE_KEY)) === true;
}

export async function loadPins(prKey: string): Promise<null | string[]> {
  const stored = (await getLocal(PINS_KEY)) as Pins | undefined;
  const hit = stored?.[prKey];
  return hit && Date.now() - hit.at < PINS_TTL ? hit.pins : null;
}

export async function loadPrState(prKey: string): Promise<PrState> {
  const all = await loadAll();
  const s = all[prKey] ?? {};
  return {
    at: s.at ?? 0,
    read: s.read ?? {},
    shown: s.shown ?? [],
    viewed: s.viewed ?? [],
  };
}

export function onConfigChange(fn: () => void): void {
  browser.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') fn();
  });
}

export async function resetConfig(): Promise<void> {
  await browser.storage.sync.clear();
}

export async function saveConfig(config: Config): Promise<void> {
  const next = toStored(config);
  const existing = Object.keys(await browser.storage.sync.get(null));
  const stale = existing.filter(
    (k) =>
      (k.startsWith(CATEGORY_PREFIX) || k === LEGACY_CATEGORIES) && !(k in next)
  );
  await browser.storage.sync.set(next);
  if (stale.length > 0) await browser.storage.sync.remove(stale);
}

export async function saveOutlineOpen(open: boolean): Promise<void> {
  await browser.storage.local.set({ [OUTLINE_KEY]: open });
}

export async function savePins(prKey: string, pins: string[]): Promise<void> {
  const stored = ((await getLocal(PINS_KEY)) as Pins | undefined) ?? {};
  const now = Date.now();
  for (const [k, v] of Object.entries(stored))
    if (now - v.at > PINS_TTL) delete stored[k];
  stored[prKey] = { at: now, pins };
  await browser.storage.local.set({ [PINS_KEY]: stored });
}

// Merges a partial update into one PR's state, dropping the oldest PRs past
// the limit. Reads and writes the whole map, so callers should batch.
export async function savePrState(
  prKey: string,
  update: Partial<Omit<PrState, 'at'>>
): Promise<void> {
  const all = await loadAll();
  const next = { ...all[prKey], ...update, at: Date.now() };
  const empty =
    !next.shown?.length &&
    Object.keys(next.read ?? {}).length === 0 &&
    !next.viewed?.length;
  if (empty) delete all[prKey];
  else all[prKey] = next;
  const keys = Object.keys(all);
  if (keys.length > PR_STATE_LIMIT) {
    for (const k of keys
      .sort((a, b) => (all[a].at ?? 0) - (all[b].at ?? 0))
      .slice(0, keys.length - PR_STATE_LIMIT))
      delete all[k];
  }
  await browser.storage.local.set({ [PR_STATE_KEY]: all });
}

export function toStored(config: Config): Record<string, unknown> {
  const c = normalizeConfig(config);
  const out: Record<string, unknown> = {
    [ORDER_KEY]: c.categories.map((x) => x.id),
  };
  for (const cat of c.categories) out[CATEGORY_PREFIX + cat.id] = cat;
  for (const k of SECTION_KEYS) out[k] = c[k];
  return out;
}

async function getLocal(key: string): Promise<unknown> {
  const stored = await browser.storage.local.get(key);
  return stored[key];
}

async function loadAll(): Promise<AllPrState> {
  const stored = await browser.storage.local.get(PR_STATE_KEY);
  return (stored[PR_STATE_KEY] as AllPrState | undefined) ?? {};
}
