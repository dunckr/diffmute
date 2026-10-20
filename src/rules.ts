// Rule categories, config shape and path classification. Shared by the
// content script, the options page and the tests.
import { matchesAny } from "./glob.ts";

export type Mode = "collapse" | "hide";

// Properties of a change that no path glob can express.
export type Detect = "deleted" | "renamed" | "whitespace" | "unchanged";

// What the content script knows about a file beyond its path. A missing or
// null entry means "unknown" and never matches.
export type FileFacts = Partial<Record<Detect, boolean | null>>;

export interface Category {
  id: string;
  name: string;
  mode: Mode;
  enabled: boolean;
  patterns: string[];
  // Set on structural categories, which match on facts instead of patterns.
  detect?: Detect;
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

export interface Features {
  // Collapse files whose patch is unchanged since you last read them.
  revisit: boolean;
  // Keyboard shortcuts for moving through the diff.
  keys: boolean;
  // Reading order outline in the bar.
  order: boolean;
}

export const TIER_IDS = ["contracts", "ui", "tests", "config"] as const;
export type TierId = (typeof TIER_IDS)[number];

export interface Config {
  categories: Category[];
  repos: Record<string, RepoOverride>;
  features: Features;
  tiers: Record<TierId, string[]>;
}

export interface Rules {
  categories: Category[];
  ignore: string[];
}

export const MODES: readonly Mode[] = ["collapse", "hide"];

const STRUCTURAL: readonly Category[] = [
  { id: "deleted", name: "deleted", mode: "collapse", enabled: true, patterns: [], detect: "deleted" },
  { id: "renamed", name: "renamed", mode: "collapse", enabled: true, patterns: [], detect: "renamed" },
  { id: "whitespace", name: "whitespace", mode: "collapse", enabled: true, patterns: [], detect: "whitespace" },
];

const STRUCTURAL_IDS = new Set(STRUCTURAL.map((c) => c.id));

export const STRUCTURAL_HELP: Record<string, string> = {
  deleted: "Files the pull request deletes.",
  renamed: "Files that were moved or renamed without changes.",
  whitespace: "Files whose only changes are whitespace or line breaks.",
};

// Added at runtime on a revisit, after every configured category.
export const UNCHANGED: Category = {
  id: "unchanged",
  name: "unchanged",
  mode: "collapse",
  enabled: true,
  patterns: [],
  detect: "unchanged",
};

export const DEFAULT_CATEGORIES: readonly Category[] = [
  ...STRUCTURAL,
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

const TEST_PATTERNS = DEFAULT_CATEGORIES.filter((c) => c.id === "tests" || c.id === "snapshots").flatMap(
  (c) => c.patterns,
);

// Reading order tiers. Files matching none of them are "core" and are read
// after contracts. Matching checks tests, config, contracts, ui in that order.
export const DEFAULT_TIERS: Readonly<Record<TierId, readonly string[]>> = {
  contracts: [
    "**/*.d.ts",
    "**/types/**",
    "**/types.*",
    "**/schema*",
    "**/*.proto",
    "**/*.graphql",
    "**/openapi*",
    "**/migrations/**",
    "**/models/**",
    "**/interfaces/**",
  ],
  ui: [
    "**/*.tsx",
    "**/*.jsx",
    "**/*.vue",
    "**/*.svelte",
    "**/components/**",
    "**/*.css",
    "**/*.scss",
    "**/templates/**",
    "**/views/**",
  ],
  tests: TEST_PATTERNS,
  config: [
    "package.json",
    "**/*.config.*",
    "/.github/**",
    "Dockerfile*",
    "**/*.md",
    "**/*.yml",
    "**/*.yaml",
    "**/*.toml",
    ".*rc",
    ".*ignore",
    ".editorconfig",
    ".gitattributes",
  ],
};

const DEFAULT_FEATURES: Features = { revisit: true, keys: true, order: true };

function isMode(value: unknown): value is Mode {
  return MODES.includes(value as Mode);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((p) => p.trim()).filter(Boolean) : [];
}

export function defaultConfig(): Config {
  return {
    categories: structuredClone(DEFAULT_CATEGORIES) as Category[],
    repos: {},
    features: { ...DEFAULT_FEATURES },
    tiers: structuredClone(DEFAULT_TIERS) as Record<TierId, string[]>,
  };
}

// Accepts anything read back from storage and returns a well-formed config.
export function normalizeConfig(raw: unknown): Config {
  const input = (raw ?? {}) as { categories?: unknown; repos?: unknown; features?: unknown; tiers?: unknown };
  const categories: Category[] = Array.isArray(input.categories)
    ? input.categories
        .filter((c): c is Partial<Category> => !!c && !!c.id && c.id !== UNCHANGED.id)
        .map((c) => {
          const id = String(c.id);
          const structural = STRUCTURAL.find((s) => s.id === id);
          const cat: Category = {
            id,
            name: String(c.name || id),
            mode: isMode(c.mode) ? c.mode : "collapse",
            enabled: c.enabled !== false,
            patterns: structural ? [] : strings(c.patterns),
          };
          if (structural) cat.detect = structural.detect;
          return cat;
        })
    : defaultConfig().categories;
  // Structural categories cannot be removed, only turned off. Configs saved
  // before they existed get them at the front, where they take precedence.
  const missing = STRUCTURAL.filter((s) => !categories.some((c) => c.id === s.id));
  categories.unshift(...(structuredClone(missing) as Category[]));
  const repos: Record<string, RepoOverride> = {};
  const rawRepos = (input.repos ?? {}) as Record<string, Partial<RepoOverride> | undefined>;
  for (const [key, r] of Object.entries(rawRepos)) {
    repos[key.toLowerCase()] = {
      off: !!r?.off,
      ignore: (r?.ignore ?? []).map(String).filter((p) => p.trim()),
      categories: r?.categories ?? {},
    };
  }
  const f = (input.features ?? {}) as Partial<Features>;
  const features: Features = {
    revisit: f.revisit ?? DEFAULT_FEATURES.revisit,
    keys: f.keys ?? DEFAULT_FEATURES.keys,
    order: f.order ?? DEFAULT_FEATURES.order,
  };
  const rawTiers = (input.tiers ?? {}) as Partial<Record<TierId, unknown>>;
  const tiers = {} as Record<TierId, string[]>;
  for (const id of TIER_IDS) {
    tiers[id] = Array.isArray(rawTiers[id]) ? strings(rawTiers[id]) : [...DEFAULT_TIERS[id]];
  }
  return { categories, repos, features, tiers };
}

export function isStructural(id: string): boolean {
  return STRUCTURAL_IDS.has(id);
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
    .filter((c) => c.enabled && (c.detect || c.patterns.length));
  return { categories, ignore: override?.ignore ?? [] };
}

// First matching category wins; ignored paths never match. Structural
// categories only match when the fact they detect is known to be true.
export function classify(path: string, rules: Rules, facts: FileFacts = {}): Category | null {
  if (matchesAny(path, rules.ignore)) return null;
  return rules.categories.find((c) => (c.detect ? facts[c.detect] === true : matchesAny(path, c.patterns))) ?? null;
}
