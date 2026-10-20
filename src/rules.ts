// Rule categories, config shape and path classification. Shared by the
// content script, the options page and the tests.
import { matchesAny } from './glob.ts';

export interface Category {
  // Set on structural categories, which match on facts instead of patterns.
  detect?: Detect;
  enabled: boolean;
  id: string;
  mode: Mode;
  name: string;
  patterns: string[];
}

export interface CategoryOverride {
  enabled?: boolean;
  mode?: Mode;
}

// Properties of a change that no path glob can express.
export type Detect = 'deleted' | 'renamed' | 'unchanged' | 'whitespace';

export interface Features {
  // Keyboard shortcuts for moving through the diff.
  keys: boolean;
  // Reading order outline in the bar.
  order: boolean;
  // Collapse files whose patch is unchanged since you last read them.
  revisit: boolean;
}

// What the content script knows about a file beyond its path. A missing or
// null entry means "unknown" and never matches.
export type FileFacts = Partial<Record<Detect, boolean | null>>;

export type Mode = 'collapse' | 'hide';

export interface RepoOverride {
  categories: Record<string, CategoryOverride>;
  ignore: string[];
  off: boolean;
}

export const TIER_IDS = ['contracts', 'ui', 'tests', 'config'] as const;
export interface Config {
  categories: Category[];
  features: Features;
  // Never-mute globs for every repo.
  ignore: string[];
  repos: Record<string, RepoOverride>;
  tiers: Record<TierId, string[]>;
}

export interface Rules {
  categories: Category[];
  ignore: string[];
}

export type TierId = (typeof TIER_IDS)[number];

const MODES: ReadonlySet<string> = new Set<Mode>(['collapse', 'hide']);

const STRUCTURAL: readonly Category[] = [
  {
    detect: 'deleted',
    enabled: true,
    id: 'deleted',
    mode: 'collapse',
    name: 'deleted',
    patterns: [],
  },
  {
    detect: 'renamed',
    enabled: true,
    id: 'renamed',
    mode: 'collapse',
    name: 'renamed',
    patterns: [],
  },
  {
    detect: 'whitespace',
    enabled: true,
    id: 'whitespace',
    mode: 'collapse',
    name: 'whitespace',
    patterns: [],
  },
];

const STRUCTURAL_IDS = new Set(STRUCTURAL.map((c) => c.id));

export const STRUCTURAL_HELP: Record<string, string> = {
  deleted: 'Files the pull request deletes.',
  renamed: 'Files that were moved or renamed without changes.',
  whitespace: 'Files whose only changes are whitespace or line breaks.',
};

// Added at runtime on a revisit, after every configured category.
export const UNCHANGED: Category = {
  detect: 'unchanged',
  enabled: true,
  id: 'unchanged',
  mode: 'collapse',
  name: 'unchanged',
  patterns: [],
};

const DEFAULT_CATEGORIES: readonly Category[] = [
  ...STRUCTURAL,
  {
    enabled: true,
    id: 'lockfiles',
    mode: 'collapse',
    name: 'lockfiles',
    patterns: [
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'bun.lock',
      'bun.lockb',
      'Cargo.lock',
      'Gemfile.lock',
      'poetry.lock',
      'uv.lock',
      'Pipfile.lock',
      'go.sum',
      'composer.lock',
      'flake.lock',
      'Podfile.lock',
      'Package.resolved',
      'deno.lock',
      'pubspec.lock',
      'mix.lock',
      'gradle.lockfile',
      'Cartfile.resolved',
      'packages.lock.json',
    ],
  },
  {
    enabled: true,
    id: 'snapshots',
    mode: 'collapse',
    name: 'snapshots',
    patterns: [
      '**/__snapshots__/**',
      '**/*.snap',
      '**/fixtures/**',
      '**/__fixtures__/**',
      '**/testdata/**',
      '**/*.golden',
      '**/*.ambr',
    ],
  },
  {
    enabled: true,
    id: 'tests',
    mode: 'collapse',
    name: 'tests',
    patterns: [
      '**/*.test.*',
      '**/*.spec.*',
      '**/__tests__/**',
      '**/test/**',
      '**/tests/**',
      '**/*_test.go',
      '**/test_*.py',
      '**/*_test.py',
      '**/*Test.java',
      '**/*Tests.swift',
      '**/*_spec.rb',
      '**/spec/**',
      '**/*.cy.*',
      '**/*.e2e.*',
      '**/e2e/**',
    ],
  },
  {
    enabled: true,
    id: 'generated',
    mode: 'collapse',
    name: 'generated',
    patterns: [
      '**/*.generated.*',
      '**/__generated__/**',
      '**/*.pb.go',
      '**/*_pb2.py',
      '**/*_pb2_grpc.py',
      '**/*.g.dart',
      '**/*.freezed.dart',
      '**/dist/**',
      '**/*.min.js',
      '**/*.min.css',
      '**/*.map',
      '**/vendor/**',
    ],
  },
  {
    enabled: false,
    id: 'docs',
    mode: 'collapse',
    name: 'docs',
    patterns: ['**/*.md', '**/*.mdx', '**/docs/**', 'CHANGELOG*', 'LICENSE*'],
  },
  {
    enabled: false,
    id: 'i18n',
    mode: 'collapse',
    name: 'translations',
    patterns: [
      '**/locales/**',
      '**/i18n/**',
      '**/*.po',
      '**/*.pot',
      '**/*.xliff',
    ],
  },
];

const TEST_PATTERNS = DEFAULT_CATEGORIES.filter(
  (c) => c.id === 'tests' || c.id === 'snapshots'
).flatMap((c) => c.patterns);

// Reading order tiers. Files matching none of them are "core" and are read
// after contracts. Matching checks tests, config, contracts, ui in that order.
const DEFAULT_TIERS: Readonly<Record<TierId, readonly string[]>> = {
  config: [
    'package.json',
    '**/*.config.*',
    '/.github/**',
    'Dockerfile*',
    '**/*.md',
    '**/*.yml',
    '**/*.yaml',
    '**/*.toml',
    '.*rc',
    '.*ignore',
    '.editorconfig',
    '.gitattributes',
  ],
  contracts: [
    '**/*.d.ts',
    '**/types/**',
    '**/types.*',
    '**/schema*',
    '**/*.proto',
    '**/*.graphql',
    '**/openapi*',
    '**/migrations/**',
    '**/models/**',
    '**/interfaces/**',
  ],
  tests: TEST_PATTERNS,
  ui: [
    '**/*.tsx',
    '**/*.jsx',
    '**/*.vue',
    '**/*.svelte',
    '**/components/**',
    '**/*.css',
    '**/*.scss',
    '**/templates/**',
    '**/views/**',
  ],
};

const DEFAULT_FEATURES: Features = { keys: true, order: true, revisit: true };

// First matching category wins; ignored paths never match. Structural
// categories only match when the fact they detect is known to be true.
export function classify(
  path: string,
  rules: Rules,
  facts: FileFacts = {}
): Category | null {
  if (matchesAny(path, rules.ignore)) return null;
  return (
    rules.categories.find((c) =>
      c.detect ? facts[c.detect] === true : matchesAny(path, c.patterns)
    ) ?? null
  );
}

export function defaultConfig(): Config {
  return {
    categories: structuredClone(DEFAULT_CATEGORIES) as Category[],
    features: { ...DEFAULT_FEATURES },
    ignore: [],
    repos: {},
    tiers: structuredClone(DEFAULT_TIERS) as Record<TierId, string[]>,
  };
}

export function isStructural(id: string): boolean {
  return STRUCTURAL_IDS.has(id);
}

// Accepts anything read back from storage and returns a well-formed config.
export function normalizeConfig(raw: unknown): Config {
  const input = (raw ?? {}) as {
    categories?: unknown;
    features?: unknown;
    ignore?: unknown;
    repos?: unknown;
    tiers?: unknown;
  };
  const categories: Category[] = Array.isArray(input.categories)
    ? input.categories
        .filter(
          (c): c is Partial<Category> => !!c && !!c.id && c.id !== UNCHANGED.id
        )
        .map((c) => {
          const id = String(c.id);
          const structural = STRUCTURAL.find((s) => s.id === id);
          const cat: Category = {
            enabled: c.enabled !== false,
            id,
            mode: isMode(c.mode) ? c.mode : 'collapse',
            name: String(c.name || id),
            patterns: structural ? [] : strings(c.patterns),
          };
          if (structural) cat.detect = structural.detect;
          return cat;
        })
    : defaultConfig().categories;
  // Structural categories cannot be removed, only turned off. Configs saved
  // before they existed get them at the front, where they take precedence.
  const missing = STRUCTURAL.filter(
    (s) => !categories.some((c) => c.id === s.id)
  );
  categories.unshift(...(structuredClone(missing) as Category[]));
  const repos: Record<string, RepoOverride> = {};
  const rawRepos = (input.repos ?? {}) as Record<
    string,
    Partial<RepoOverride> | undefined
  >;
  for (const [key, r] of Object.entries(rawRepos)) {
    repos[key.toLowerCase()] = {
      categories: r?.categories ?? {},
      ignore: (r?.ignore ?? []).map(String).filter((p) => p.trim()),
      off: !!r?.off,
    };
  }
  const f = (input.features ?? {}) as Partial<Features>;
  const features: Features = {
    keys: f.keys ?? DEFAULT_FEATURES.keys,
    order: f.order ?? DEFAULT_FEATURES.order,
    revisit: f.revisit ?? DEFAULT_FEATURES.revisit,
  };
  const rawTiers = (input.tiers ?? {}) as Partial<Record<TierId, unknown>>;
  const tiers = {} as Record<TierId, string[]>;
  for (const id of TIER_IDS) {
    tiers[id] = Array.isArray(rawTiers[id])
      ? strings(rawTiers[id])
      : [...DEFAULT_TIERS[id]];
  }
  return { categories, features, ignore: strings(input.ignore), repos, tiers };
}

// Effective categories for a repo, with overrides applied.
export function resolveRules(config: Config, repo: string): Rules {
  const override = config.repos[repo.toLowerCase()];
  if (override?.off) return { categories: [], ignore: [] };
  const ignore = [...config.ignore, ...(override?.ignore ?? [])];
  const categories = config.categories
    .map((c) => {
      const o = override?.categories[c.id] ?? {};
      return {
        ...c,
        enabled: o.enabled ?? c.enabled,
        mode: isMode(o.mode) ? o.mode : c.mode,
      };
    })
    .filter((c) => c.enabled && (c.detect || c.patterns.length > 0));
  return { categories, ignore };
}

function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && MODES.has(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map(String)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
}
