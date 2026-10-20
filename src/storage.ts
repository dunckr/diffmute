// Config lives in storage.sync (categories and repos as separate keys to stay
// under the per-item quota). Per-PR "show this category" toggles live in
// storage.local since they are only useful on this machine.
import { normalizeConfig, type Config } from "./rules.ts";

const PR_STATE_KEY = "prState";
const PR_STATE_LIMIT = 300;

type PrState = Record<string, { shown: string[]; at: number }>;

export async function loadConfig(): Promise<Config> {
  const raw = await browser.storage.sync.get(["categories", "repos"]);
  return normalizeConfig(raw.categories ? raw : null);
}

export async function saveConfig(config: Config): Promise<void> {
  const c = normalizeConfig(config);
  await browser.storage.sync.set({ categories: c.categories, repos: c.repos });
}

export async function resetConfig(): Promise<void> {
  await browser.storage.sync.remove(["categories", "repos"]);
}

export function onConfigChange(fn: () => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && (changes.categories || changes.repos)) fn();
  });
}

async function loadPrState(): Promise<PrState> {
  const stored = await browser.storage.local.get(PR_STATE_KEY);
  return (stored[PR_STATE_KEY] as PrState | undefined) ?? {};
}

// Returns the category ids the user revealed on this PR.
export async function loadShown(prKey: string): Promise<string[]> {
  return (await loadPrState())[prKey]?.shown ?? [];
}

export async function saveShown(prKey: string, shown: string[]): Promise<void> {
  const all = await loadPrState();
  if (shown.length) all[prKey] = { shown, at: Date.now() };
  else delete all[prKey];
  const keys = Object.keys(all);
  if (keys.length > PR_STATE_LIMIT) {
    keys
      .sort((a, b) => all[a].at - all[b].at)
      .slice(0, keys.length - PR_STATE_LIMIT)
      .forEach((k) => delete all[k]);
  }
  await browser.storage.local.set({ [PR_STATE_KEY]: all });
}
