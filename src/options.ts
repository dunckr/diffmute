import { TIER_NAMES } from './order.ts';
import {
  classify,
  type Config,
  defaultConfig,
  isStructural,
  normalizeConfig,
  resolveRules,
  STRUCTURAL_HELP,
  TIER_IDS,
} from './rules.ts';
import { loadConfig, resetConfig, saveConfig } from './storage.ts';

function $<T extends Element = HTMLElement>(sel: string): T {
  const element = document.querySelector<T>(sel);
  if (!element) throw new Error(`missing ${sel}`);
  return element;
}

function field<T extends Element = HTMLInputElement>(
  root: Element,
  sel: string
): T {
  return root.querySelector<T>(sel)!;
}

function template(id: string): HTMLElement {
  return $<HTMLTemplateElement>(id).content.firstElementChild!.cloneNode(
    true
  ) as HTMLElement;
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

let state: Config = defaultConfig();

function collect(): Config {
  const categories = [
    ...document.querySelectorAll<HTMLElement>('.category'),
  ].map((node) => ({
    enabled: field(node, '.enabled').checked,
    id: node.dataset.id!,
    mode: field<HTMLSelectElement>(node, '.mode').value,
    name: field(node, '.name').value.trim() || node.dataset.id!,
    patterns: lines(
      node.querySelector<HTMLTextAreaElement>('.patterns')?.value ?? ''
    ),
  }));
  const repos: Record<string, unknown> = {};
  for (const node of document.querySelectorAll<HTMLElement>('.repo')) {
    const cats: Record<string, { enabled: boolean; mode?: string }> = {};
    for (const select of node.querySelectorAll<HTMLSelectElement>(
      'select[data-category]'
    )) {
      const id = select.dataset.category!;
      if (select.value === 'off') cats[id] = { enabled: false };
      else if (select.value) cats[id] = { enabled: true, mode: select.value };
    }
    repos[node.dataset.repo!] = {
      categories: cats,
      ignore: lines(field<HTMLTextAreaElement>(node, '.ignore').value),
      off: field(node, '.off').checked,
    };
  }
  const tiers: Record<string, string[]> = {};
  for (const node of document.querySelectorAll<HTMLElement>('.tier')) {
    tiers[node.dataset.tier!] = lines(
      field<HTMLTextAreaElement>(node, 'textarea').value
    );
  }
  const features = {
    keys: $<HTMLInputElement>('#feature-keys').checked,
    order: $<HTMLInputElement>('#feature-order').checked,
    revisit: $<HTMLInputElement>('#feature-revisit').checked,
  };
  const ignore = lines($<HTMLTextAreaElement>('#global-ignore').value);
  return normalizeConfig({ categories, features, ignore, repos, tiers });
}

function render(): void {
  renderFeatures();
  renderCategories();
  renderRepos();
  runTest();
}

function renderCategories(): void {
  const root = $('#categories');
  root.replaceChildren();
  for (const c of state.categories) {
    const structural = isStructural(c.id);
    const node = template(structural ? '#structural-tpl' : '#category-tpl');
    node.dataset.id = c.id;
    field(node, '.name').value = c.name;
    field(node, '.enabled').checked = c.enabled;
    field<HTMLSelectElement>(node, '.mode').value = c.mode;
    if (structural) {
      field(node, '.help').textContent = STRUCTURAL_HELP[c.id] ?? '';
    } else {
      field<HTMLTextAreaElement>(node, '.patterns').value =
        c.patterns.join('\n');
      field(node, '.remove').addEventListener('click', () => {
        state = collect();
        state.categories = state.categories.filter((x) => x.id !== c.id);
        render();
      });
    }
    root.append(node);
  }
}

function renderFeatures(): void {
  $<HTMLTextAreaElement>('#global-ignore').value = state.ignore.join('\n');
  $<HTMLInputElement>('#feature-revisit').checked = state.features.revisit;
  $<HTMLInputElement>('#feature-order').checked = state.features.order;
  $<HTMLInputElement>('#feature-keys').checked = state.features.keys;
  const root = $('#tiers');
  root.replaceChildren();
  for (const id of TIER_IDS) {
    const node = template('#tier-tpl');
    node.dataset.tier = id;
    field(node, '.tier-name').textContent = TIER_NAMES[id];
    field<HTMLTextAreaElement>(node, 'textarea').value =
      state.tiers[id].join('\n');
    root.append(node);
  }
}

function renderRepos(): void {
  const root = $('#repos');
  root.replaceChildren();
  for (const [name, r] of Object.entries(state.repos).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const node = template('#repo-tpl');
    node.dataset.repo = name;
    field(node, '.repo-name').textContent = name;
    field(node, '.off').checked = r.off;
    field<HTMLTextAreaElement>(node, '.ignore').value = r.ignore.join('\n');
    const overrides = field(node, '.overrides');
    for (const c of state.categories) {
      const o = r.categories[c.id] ?? {};
      const label = document.createElement('label');
      label.textContent = c.name;
      const select = document.createElement('select');
      select.dataset.category = c.id;
      for (const [value, text] of [
        ['', 'default'],
        ['collapse', 'collapse'],
        ['hide', 'hide'],
        ['off', 'off'],
      ]) {
        select.append(new Option(text, value));
      }
      select.value = o.enabled === false ? 'off' : (o.mode ?? '');
      label.append(select);
      overrides.append(label);
    }
    field(node, '.remove').addEventListener('click', () => {
      state = collect();
      delete state.repos[name];
      render();
    });
    root.append(node);
  }
}

function runTest(): void {
  const path = $<HTMLInputElement>('#test-path').value.trim();
  const out = $('#test-result');
  if (!path) {
    out.textContent = 'Type a path to see which category matches.';
    return;
  }
  const repo = $<HTMLInputElement>('#test-repo').value.trim();
  const rules = resolveRules(collect(), repo);
  const cat = classify(path, rules);
  out.textContent = cat
    ? `Matches "${cat.name}" (${cat.mode}).`
    : rules.ignore.length > 0 && repo
      ? `Not muted in ${repo}.`
      : 'No category matches, file is shown.';
}

function status(text: string): void {
  $('#status').textContent = text;
  if (text) setTimeout(() => status(''), 2500);
}

$('#add-category').addEventListener('click', () => {
  state = collect();
  const id = `custom-${Date.now().toString(36)}`;
  state.categories.push({
    enabled: true,
    id,
    mode: 'collapse',
    name: 'new category',
    patterns: [],
  });
  render();
  $<HTMLInputElement>(`.category[data-id="${id}"] .name`).select();
});

$('#add-repo').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>('#repo-name');
  const name = input.value.trim().toLowerCase();
  state = collect();
  state.repos[name] ??= { categories: {}, ignore: [], off: false };
  input.value = '';
  render();
});

// Renaming a category relabels the per-repo selects.
$('#categories').addEventListener('change', (event) => {
  if ((event.target as Element).matches('.name')) {
    state = collect();
    renderRepos();
  }
});

document.addEventListener('input', (event) => {
  if (
    (event.target as Element).closest(
      '#test-path, #test-repo, #categories, #repos, #global-ignore'
    )
  )
    runTest();
});

$('#save').addEventListener('click', async () => {
  state = collect();
  await saveConfig(state);
  status('Saved');
});

$('#reset').addEventListener('click', async () => {
  if (!confirm('Reset all categories and repo overrides to defaults?')) return;
  await resetConfig();
  state = defaultConfig();
  render();
  status('Reset to defaults');
});

$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(collect(), null, 2)], {
    type: 'application/json',
  });
  const a = Object.assign(document.createElement('a'), {
    download: 'diffmute.json',
    href: URL.createObjectURL(blob),
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

$<HTMLInputElement>('#import').addEventListener('change', async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    state = normalizeConfig(JSON.parse(await file.text()));
  } catch {
    status('That file is not valid JSON');
    return;
  }
  render();
  status('Imported, review and save');
});

// options.html?repo=owner/repo, from the bar's "rules" button: show that
// repo's overrides, adding an empty one if needed (saved only on Save).
function focusRepo(): void {
  const repo = new URLSearchParams(location.search)
    .get('repo')
    ?.trim()
    .toLowerCase();
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return;
  state.repos[repo] ??= { categories: {}, ignore: [], off: false };
  render();
  $<HTMLInputElement>('#test-repo').value = repo;
  const node = document.querySelector<HTMLElement>(
    `.repo[data-repo="${CSS.escape(repo)}"]`
  );
  node?.scrollIntoView({ block: 'center' });
  node?.classList.add('focus');
}

void loadConfig().then((config) => {
  state = config;
  render();
  focusRepo();
});
