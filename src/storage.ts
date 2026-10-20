// Config lives in storage.sync, one key per section to stay under the
// per-item quota. Per-PR state (revealed categories, files read, files
// viewed) lives in storage.local since it is only useful on this machine.
import { normalizeConfig, type Config } from "./rules.ts";

const CONFIG_KEYS = ["categories", "repos", "features", "tiers"] as const;
const PR_STATE_KEY = "prState";
const PR_STATE_LIMIT = 300;
const PINS_KEY = "pins";
const PINS_TTL = 60 * 60 * 1000;
const OUTLINE_KEY = "outlineOpen";

export interface PrState {
  // Category ids the user revealed on this PR.
  shown: string[];
  // File hash -> fingerprint of the patch when the user last read it.
  read: Record<string, string>;
  // File hashes marked viewed locally (when GitHub's checkbox is absent).
  viewed: string[];
  at: number;
}

type AllPrState = Record<string, Partial<PrState>>;

export async function loadConfig(): Promise<Config> {
  const raw = await browser.storage.sync.get([...CONFIG_KEYS]);
  return normalizeConfig(raw);
}

export async function saveConfig(config: Config): Promise<void> {
  const c = normalizeConfig(config);
  await browser.storage.sync.set({ categories: c.categories, repos: c.repos, features: c.features, tiers: c.tiers });
}

export async function resetConfig(): Promise<void> {
  await browser.storage.sync.remove([...CONFIG_KEYS]);
}

export function onConfigChange(fn: () => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && CONFIG_KEYS.some((k) => changes[k])) fn();
  });
}

async function loadAll(): Promise<AllPrState> {
  const stored = await browser.storage.local.get(PR_STATE_KEY);
  return (stored[PR_STATE_KEY] as AllPrState | undefined) ?? {};
}

export async function loadPrState(prKey: string): Promise<PrState> {
  const s = (await loadAll())[prKey] ?? {};
  return { shown: s.shown ?? [], read: s.read ?? {}, viewed: s.viewed ?? [], at: s.at ?? 0 };
}

// Merges a partial update into one PR's state, dropping the oldest PRs past
// the limit. Reads and writes the whole map, so callers should batch.
export async function savePrState(prKey: string, update: Partial<Omit<PrState, "at">>): Promise<void> {
  const all = await loadAll();
  const next = { ...all[prKey], ...update, at: Date.now() };
  const empty = !next.shown?.length && !Object.keys(next.read ?? {}).length && !next.viewed?.length;
  if (empty) delete all[prKey];
  else all[prKey] = next;
  const keys = Object.keys(all);
  if (keys.length > PR_STATE_LIMIT) {
    keys
      .sort((a, b) => (all[a].at ?? 0) - (all[b].at ?? 0))
      .slice(0, keys.length - PR_STATE_LIMIT)
      .forEach((k) => delete all[k]);
  }
  await browser.storage.local.set({ [PR_STATE_KEY]: all });
}

type Pins = Record<string, { pins: string[]; at: number }>;

export async function loadPins(prKey: string): Promise<string[] | null> {
  const stored = (await browser.storage.local.get(PINS_KEY))[PINS_KEY] as Pins | undefined;
  const hit = stored?.[prKey];
  return hit && Date.now() - hit.at < PINS_TTL ? hit.pins : null;
}

export async function savePins(prKey: string, pins: string[]): Promise<void> {
  const stored = ((await browser.storage.local.get(PINS_KEY))[PINS_KEY] as Pins | undefined) ?? {};
  const now = Date.now();
  for (const [k, v] of Object.entries(stored)) if (now - v.at > PINS_TTL) delete stored[k];
  stored[prKey] = { pins, at: now };
  await browser.storage.local.set({ [PINS_KEY]: stored });
}

export async function loadOutlineOpen(): Promise<boolean> {
  return (await browser.storage.local.get(OUTLINE_KEY))[OUTLINE_KEY] === true;
}

export async function saveOutlineOpen(open: boolean): Promise<void> {
  await browser.storage.local.set({ [OUTLINE_KEY]: open });
}
