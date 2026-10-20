// Rule categories, config shape and path classification. Shared by the
// content script, the options page and the tests.
import { matchesAny } from "./glob.ts";

export type Mode = "collapse" | "hide";

export interface Category {
  id: string;
  name: string;
  mode: Mode;
  enabled: boolean;
  patterns: string[];
}

export interface CategoryOverride {
  enabled?: boolean;
  mode?: Mode;
}

export interface RepoOverride {
  off: boolean;
  ignore: string[];
  categories: Record<string, CategoryOverride>;
}

export interface Config {
  categories: Category[];
  repos: Record<string, RepoOverride>;
}

export interface Rules {
  categories: Category[];
  ignore: string[];
}

export const MODES: readonly Mode[] = ["collapse", "hide"];

export const DEFAULT_CATEGORIES: readonly Category[] = [
  {
    id: "lockfiles",
    name: "lockfiles",
    mode: "collapse",
    enabled: true,
    patterns: [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lock",
      "bun.lockb",
      "Cargo.lock",
      "Gemfile.lock",
      "poetry.lock",
      "uv.lock",
      "Pipfile.lock",
      "go.sum",
      "composer.lock",
      "flake.lock",
      "Podfile.lock",
      "Package.resolved",
    ],
  },
  {
    id: "snapshots",
    name: "snapshots",
    mode: "collapse",
    enabled: true,
    patterns: ["**/__snapshots__/**", "**/*.snap", "**/fixtures/**"],
  },
  {
    id: "tests",
    name: "tests",
    mode: "collapse",
    enabled: true,
    patterns: [
      "**/*.test.*",
      "**/*.spec.*",
      "**/__tests__/**",
      "**/test/**",
      "**/tests/**",
      "**/*_test.go",
      "**/test_*.py",
      "**/*Test.java",
    ],
  },
  {
    id: "generated",
    name: "generated",
    mode: "collapse",
    enabled: true,
    patterns: ["**/*.generated.*", "**/*.pb.go", "**/dist/**", "**/*.min.js", "**/vendor/**"],
  },
];

function isMode(value: unknown): value is Mode {
  return MODES.includes(value as Mode);
}

export function defaultConfig(): Config {
  return { categories: structuredClone(DEFAULT_CATEGORIES) as Category[], repos: {} };
}

// Accepts anything read back from storage and returns a well-formed config.
export function normalizeConfig(raw: unknown): Config {
  const input = (raw ?? {}) as { categories?: unknown; repos?: unknown };
  const categories = Array.isArray(input.categories)
    ? input.categories
        .filter((c): c is Partial<Category> => !!c && !!c.id)
        .map((c) => ({
          id: String(c.id),
          name: String(c.name || c.id),
          mode: isMode(c.mode) ? c.mode : "collapse",
          enabled: c.enabled !== false,
          patterns: (c.patterns ?? []).map(String).filter((p) => p.trim()),
        }))
    : defaultConfig().categories;
  const repos: Record<string, RepoOverride> = {};
  const rawRepos = (input.repos ?? {}) as Record<string, Partial<RepoOverride> | undefined>;
  for (const [key, r] of Object.entries(rawRepos)) {
    repos[key.toLowerCase()] = {
      off: !!r?.off,
      ignore: (r?.ignore ?? []).map(String).filter((p) => p.trim()),
      categories: r?.categories ?? {},
    };
  }
  return { categories, repos };
}

// Effective categories for a repo, with overrides applied.
export function resolveRules(config: Config, repo: string): Rules {
  const override = config.repos[repo.toLowerCase()];
  if (override?.off) return { categories: [], ignore: [] };
  const categories = config.categories
    .map((c) => {
      const o = override?.categories[c.id] ?? {};
      return { ...c, enabled: o.enabled ?? c.enabled, mode: isMode(o.mode) ? o.mode : c.mode };
    })
    .filter((c) => c.enabled && c.patterns.length);
  return { categories, ignore: override?.ignore ?? [] };
}

// First matching category wins; ignored paths never match.
export function classify(path: string, rules: Rules): Category | null {
  if (matchesAny(path, rules.ignore)) return null;
  return rules.categories.find((c) => matchesAny(path, c.patterns)) ?? null;
}
