import { type Counts, parseCounts, whitespaceOnly } from './detect.ts';
import { nextFile } from './nav.ts';
import {
  isReviewOrderHeading,
  type OrderedFile,
  orderFiles,
  type OrderTier,
  pinFromItem,
  TIER_NAMES,
  TIER_ORDER,
} from './order.ts';
import { type Page, parsePage, renameCandidates } from './page.ts';
import { fingerprint, type Tag, tagFile } from './revisit.ts';
import {
  classify,
  type Config,
  type FileFacts,
  resolveRules,
  type Rules,
  UNCHANGED,
} from './rules.ts';
import {
  loadConfig,
  loadOutlineOpen,
  loadPins,
  loadPrState,
  onConfigChange,
  saveConfig,
  saveOutlineOpen,
  savePins,
  savePrState,
} from './storage.ts';
import { suggestPatterns } from './suggest.ts';
import { summaryText } from './summary.ts';

type Applied = 'collapse' | 'hide' | 'none';

interface FileEntry {
  hash: string;
  path: string;
}

// GitHub gives every file container id="diff-<sha256(path)>" in both the
// classic and the React diff views, so the hash is our stable file key.
const FILE_ID = /^diff-([0-9a-f]{64})$/;
const CHANGED_ROWS = 'td.blob-code-addition, td.blob-code-deletion';
const READ_AFTER_MS = 1000;
const SAVE_AFTER_MS = 2000;
const STICKY_OFFSET = 140;

let config: Config | null = null;
let page: null | Page = null;
let shown = new Set<string>(); // category ids revealed on this PR
const seen = new Map<string, null | string>(); // hash -> category id, survives virtualised unmounts
const predicted = new Map<string, null | string>(); // hash -> category id by path, for diffs not rendered yet
const userExpanded = new Set<string>(); // muted files the user opened by hand
let classCache = new Map<string, null | string>(); // path -> category id, reset each scan
const pathCache = new Map<string, string>(); // hash -> path
const hashCache = new Map<string, string>(); // path -> hash
const factsCache = new Map<string, FileFacts>(); // hash -> settled facts
const fingerprints = new Map<string, string>(); // hash -> current fingerprint
let baseline: Record<string, string> = {}; // read fingerprints as of page load
let read: Record<string, string> = {}; // read fingerprints, updated live
let viewedLocal = new Set<string>();
const tags = new Map<string, Tag>();
let pins: string[] = [];
let files: FileEntry[] = []; // every file in the PR, GitHub order
let ordered: OrderedFile[] = []; // files in reading order, with tiers
let navOrder: string[] = []; // hashes the keyboard walks through
let outlineOpen = false;
let lastJump: null | string = null;
let bar: HTMLElement | null = null;
let barSignature = '';
let scanTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let highlightTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let scanning = false;
let rescan = false;

function applyFile(
  element: HTMLElement,
  hash: string,
  cat: null | { id: string; mode: Applied }
): void {
  const want: Applied =
    cat && !shown.has(cat.id) && !userExpanded.has(hash) ? cat.mode : 'none';
  const have = (element.dataset.diffmute as Applied | undefined) ?? 'none';
  if (want === have) return;
  undo(element);
  if (want === 'collapse') {
    if (setCollapsed(element, true)) element.dataset.diffmuteClicked = '1';
  } else if (want === 'hide') {
    element.classList.add('diffmute-hidden');
  }
  if (want !== 'none') element.dataset.diffmute = want;
}

// Text of the file body, only read when the diff has no rendered lines,
// so it is short ("File renamed without changes.", "Load diff").
function bodyText(element: Element): string {
  return (
    (element.querySelector('.js-file-content') ?? element).textContent ?? ''
  );
}

function changedLines(element: Element): {
  added: string[];
  removed: string[];
} {
  const removed: string[] = [];
  const added: string[] = [];
  for (const td of element.querySelectorAll(CHANGED_ROWS)) {
    (td.classList.contains('blob-code-addition') ? added : removed).push(
      td.textContent ?? ''
    );
  }
  return { added, removed };
}

function clean(s: null | string | undefined): string {
  return (s ?? '').replaceAll(/[‎‏‪-‮]/g, '').trim();
}

function countsOf(element: Element): Counts | null {
  const header = headerOf(element);
  for (const node of header.querySelectorAll('.sr-only, [aria-label]')) {
    const c = parseCounts(
      node.textContent || node.getAttribute('aria-label') || ''
    );
    if (c) return c;
  }
  return parseCounts(header.textContent ?? '');
}

function dataPath(element: HTMLElement): string {
  return (
    clean(element.dataset.tagsearchPath) ||
    clean(
      element.closest('[data-file-path]')?.getAttribute('data-file-path')
    ) ||
    clean(element.querySelector('[data-path]')?.getAttribute('data-path'))
  );
}

function detectFacts(element: HTMLElement, counts: Counts | null): FileFacts {
  const { added, removed } = changedLines(element);
  const rendered = removed.length + added.length > 0;
  const text = rendered ? '' : bodyText(element);
  const deleted =
    element.dataset.fileDeleted === 'true' ||
    /This file was deleted\./.test(text);
  const renamed =
    !deleted &&
    (/File renamed without changes/i.test(text) ||
      (counts?.changes === 0 &&
        pathCandidates(element).some((c) => c.includes('→'))));
  let whitespace: boolean | null = null;
  if (deleted || renamed) whitespace = false;
  else if (/Whitespace-only changes/i.test(text)) whitespace = true;
  else if (
    rendered &&
    (!counts || counts.changes === removed.length + added.length)
  ) {
    whitespace = whitespaceOnly(removed, added);
  }
  return { deleted, renamed, whitespace };
}

// ---- structural facts and fingerprints ----

async function fileState(
  element: HTMLElement,
  hash: string
): Promise<{ facts: FileFacts; fp: string }> {
  const settled = factsCache.get(hash);
  const known = fingerprints.get(hash);
  if (settled && known && !known.endsWith(':'))
    return { facts: settled, fp: known };

  const counts = countsOf(element);
  const facts = settled ?? detectFacts(element, counts);
  if (facts.whitespace !== null) factsCache.set(hash, facts);

  const { added, removed } = changedLines(element);
  const linesHash =
    removed.length + added.length
      ? await sha256(`-${removed.join('\n')}\n+${added.join('\n')}`)
      : '';
  const fp = fingerprint(counts, linesHash);
  fingerprints.set(hash, fp);
  return { facts, fp };
}

function headerOf(element: Element): Element {
  return (
    element.querySelector(
      ".file-header, [class*='file-header'], [class*='FileHeader']"
    ) ??
    element.firstElementChild ??
    element
  );
}

function isExpanded(element: HTMLElement): boolean {
  if (
    element.classList.contains('diffmute-hidden') ||
    element.classList.contains('diffmute-collapsed')
  )
    return false;
  const button = toggleButton(element);
  return button ? button.getAttribute('aria-expanded') === 'true' : true;
}

function pathCandidates(element: HTMLElement): string[] {
  const raw: (null | string | undefined)[] = [
    element.dataset.tagsearchPath,
    element.closest('[data-file-path]')?.getAttribute('data-file-path'),
    element.querySelector('[data-path]')?.getAttribute('data-path'),
  ];
  for (const a of element.querySelectorAll(`a[href$="#${element.id}"]`)) {
    raw.push(a.getAttribute('title'), a.textContent);
  }
  raw.push(element.querySelector('h3')?.textContent);
  return [...new Set(raw.flatMap((r) => renameCandidates(clean(r))))];
}

async function pathHash(path: string): Promise<string> {
  let h = hashCache.get(path);
  if (!h) {
    h = await sha256(path);
    hashCache.set(path, h);
  }
  return h;
}

// ---- collapse and hide ----

async function resolvePath(
  element: HTMLElement,
  hash: string
): Promise<null | string> {
  const cached = pathCache.get(hash);
  if (cached) return cached;
  for (const c of pathCandidates(element)) {
    if ((await sha256(c)) === hash) {
      pathCache.set(hash, c);
      return c;
    }
  }
  // Nothing hashed to the id; trust a data attribute if one exists.
  const fallback = dataPath(element);
  if (fallback) pathCache.set(hash, fallback);
  return fallback || null;
}

// Returns true if the file's collapsed state was changed.
function setCollapsed(element: HTMLElement, want: boolean): boolean {
  const button = toggleButton(element);
  if (!button) {
    const had = element.classList.contains('diffmute-collapsed');
    element.classList.toggle('diffmute-collapsed', want);
    return had !== want;
  }
  const expanded = button.getAttribute('aria-expanded') === 'true';
  if (expanded !== want) return false;
  button.click();
  return true;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(s)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toggleButton(element: Element): HTMLButtonElement | null {
  const buttons = element.querySelectorAll<HTMLButtonElement>(
    'button[aria-expanded]'
  );
  return (
    [...buttons].find((b) =>
      /toggle diff|collapse file|expand file|^(collapse|expand)\b/i.test(
        b.getAttribute('aria-label') ?? ''
      )
    ) ?? null
  );
}

function undo(element: HTMLElement): void {
  const state = element.dataset.diffmute;
  if (state === 'collapse' && element.dataset.diffmuteClicked)
    setCollapsed(element, false);
  if (state === 'hide') element.classList.remove('diffmute-hidden');
  delete element.dataset.diffmuteClicked;
  delete element.dataset.diffmute;
}

// ---- file tree ----

const TREE_ITEM = '[role="treeitem"]';
const TREE_GROUP = '[role="group"]';

// Last open state applied to each sidebar folder.
const folderWant = new WeakMap<Element, boolean>();
// Files seen inside each folder, by folder id. The React tree drops a
// closed folder's children, so this is how we know what it holds.
const folderFiles = new Map<string, Set<string>>();

// Sidebar folders are closed when every file in them is muted and open
// otherwise. A folder is only set when that answer changes (or it first
// appears), so folders the user toggles by hand stay put until the next
// show/hide changes them.
function applyFolders(rules: Rules): void {
  // One pass over the files, adding each to every folder above it.
  const contents = new Map<Element, Set<string>>();
  for (const node of treeLeaves()) {
    const path = treeLeafPath(node);
    if (!path) continue;
    const hash = treeLeafHash(node);
    if (hash) hashCache.set(path, hash);
    for (
      let dir = node.parentElement?.closest(TREE_ITEM);
      dir;
      dir = dir.parentElement?.closest(TREE_ITEM)
    ) {
      const set = contents.get(dir) ?? new Set();
      set.add(path);
      contents.set(dir, set);
      if (!dir.id) continue;
      const known = folderFiles.get(dir.id) ?? new Set();
      known.add(path);
      folderFiles.set(dir.id, known);
    }
  }

  for (const dir of document.querySelectorAll<HTMLElement>(TREE_ITEM)) {
    if (!isFolder(dir)) continue;
    const paths = (dir.id && folderFiles.get(dir.id)) || contents.get(dir);
    if (!paths?.size) continue;
    const open = [...paths].some(
      (path) => !isMuted(hashCache.get(path) ?? '', path, rules)
    );
    if (folderWant.get(dir) === open) continue;
    const toggle = folderToggle(dir);
    if (!toggle) continue;
    folderWant.set(dir, open);
    if (toggle.expanded !== open) toggle.el.click();
  }
}

function categoryOf(hash: string, path: string, rules: Rules): null | string {
  if (seen.has(hash)) return seen.get(hash)!;
  if (!classCache.has(path))
    classCache.set(path, classify(path, rules)?.id ?? null);
  return classCache.get(path)!;
}

// Every file in the PR, from the file tree when it is rendered (it lists all
// files up front) plus any rendered diffs it does not cover.
async function collectFiles(fileEls: HTMLElement[]): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const have = new Set<string>();
  for (const node of treeLeaves()) {
    const path = treeLeafPath(node);
    if (!path) continue;
    const hash = treeLeafHash(node) ?? (await pathHash(path));
    if (have.has(hash)) continue;
    have.add(hash);
    pathCache.set(hash, pathCache.get(hash) ?? path);
    out.push({ hash, path: pathCache.get(hash)! });
  }
  for (const element of fileEls) {
    const hash = element.id.slice(5);
    const path = pathCache.get(hash);
    if (path && !have.has(hash)) {
      have.add(hash);
      out.push({ hash, path });
    }
  }
  return out;
}

async function flushSave(key = page?.prKey): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!key) return;
  await savePrState(key, { read: { ...read }, viewed: [...viewedLocal] });
}

function folderToggle(
  dir: Element
): null | { el: HTMLElement; expanded: boolean } {
  const button = dir.querySelector<HTMLElement>(
    ':scope > button[aria-expanded], :scope > div > button[aria-expanded]'
  );
  if (button)
    return {
      el: button,
      expanded: button.getAttribute('aria-expanded') === 'true',
    };
  const content = dir.firstElementChild as HTMLElement | null;
  if (
    dir.hasAttribute('aria-expanded') &&
    content &&
    !content.matches(TREE_GROUP)
  ) {
    return {
      el: content,
      expanded: dir.getAttribute('aria-expanded') === 'true',
    };
  }
  return null;
}

function isFolder(node: HTMLElement): boolean {
  return (
    !!node.querySelector(TREE_GROUP) ||
    node.hasAttribute('aria-expanded') ||
    node.dataset.treeEntryType === 'directory'
  );
}

function isMuted(hash: string, path: string, rules: Rules): boolean {
  const id = categoryOf(hash, path, rules);
  return !!id && !shown.has(id);
}

function markRead(hash: string): void {
  const fp = fingerprints.get(hash);
  if (!page?.whole || !fp || read[hash] === fp) return;
  read[hash] = fp;
  queueSave();
}

function markTree(cls: string, hashes: Iterable<string>): void {
  const want = new Set<Element>();
  for (const hash of hashes) for (const n of treeNodes(hash)) want.add(n);
  for (const n of document.querySelectorAll(`.${cls}`)) {
    if (!want.has(n)) n.classList.remove(cls);
  }
  for (const n of want) n.classList.add(cls);
}

function queueSave(): void {
  if (!page) return;
  const key = page.prKey;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(key), SAVE_AFTER_MS);
}

function revisitActive(): boolean {
  return (
    !!config?.features.revisit &&
    !!page?.whole &&
    Object.keys(baseline).length > 0
  );
}

// ---- revisit: read tracking, badges ----

function treeLeafHash(node: Element): null | string {
  return (
    node.id.match(/diff-([0-9a-f]{64})$/)?.[1] ??
    node
      .querySelector('a[href*="#diff-"]')
      ?.getAttribute('href')
      ?.match(/#diff-([0-9a-f]{64})/)?.[1] ??
    null
  );
}

function treeLeafPath(node: Element): null | string {
  const text = clean(
    node.querySelector(
      ':scope > [data-filterable-item-text], :scope > * > [data-filterable-item-text]'
    )?.textContent
  );
  if (text) return text;
  const hash = treeLeafHash(node);
  return hash ? (pathCache.get(hash) ?? null) : null;
}

function treeLeaves(): Element[] {
  return [...document.querySelectorAll<HTMLElement>(TREE_ITEM)].filter(
    (n) => !isFolder(n)
  );
}

function treeNodes(hash: string): Set<Element> {
  const nodes = new Set<Element>();
  const byId = document.querySelector(`#file-tree-item-diff-${hash}`);
  if (byId) nodes.add(byId);
  for (const a of document.querySelectorAll(
    `[role="treeitem"] a[href*="diff-${hash}"]`
  )) {
    const item = a.closest('[role="treeitem"]');
    if (item) nodes.add(item);
  }
  const path = pathCache.get(hash);
  const byPath = path ? document.querySelector(`#${CSS.escape(path)}`) : null;
  if (byPath?.getAttribute('role') === 'treeitem') nodes.add(byPath);
  return nodes;
}

const readTimers = new Map<Element, ReturnType<typeof setTimeout>>();
const observed = new WeakSet<Element>();
const readObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const element = entry.target as HTMLElement;
    clearTimeout(readTimers.get(element));
    readTimers.delete(element);
    if (!entry.isIntersecting) continue;
    readTimers.set(
      element,
      setTimeout(() => {
        readTimers.delete(element);
        if (element.isConnected && isExpanded(element))
          markRead(element.id.slice(5));
      }, READ_AFTER_MS)
    );
  }
});

interface OutlineRow {
  hash: string;
  muted: boolean;
  path: string;
  tier: OrderTier;
}

// ---- viewed ----

// Rendered files as classified, plus files not rendered yet, by path.
function allCategories(): Map<string, null | string> {
  const all = new Map(predicted);
  for (const [hash, id] of seen) all.set(hash, id);
  return all;
}

function applyBadge(element: HTMLElement, tag: Tag | undefined): void {
  const want = tag === 'new' || tag === 'changed' ? tag : null;
  const header = headerOf(element);
  const existing = header.querySelector<HTMLElement>('.diffmute-badge');
  if ((existing?.dataset.tag ?? null) === want) return;
  existing?.remove();
  if (!want) return;
  const badge = document.createElement('span');
  badge.className = 'diffmute-badge';
  badge.dataset.tag = want;
  badge.textContent = want;
  const link = header.querySelector(`a[href$="#${element.id}"]`);
  if (link) link.after(badge);
  else header.append(badge);
}

function createBar(): HTMLElement {
  const element = document.createElement('div');
  element.className = 'diffmute-bar';
  element.setAttribute('role', 'toolbar');
  element.setAttribute('aria-label', 'diffmute filters');
  element.addEventListener('click', onBarClick);
  element.addEventListener(
    'toggle',
    (event) => {
      const d = event.target as HTMLDetailsElement;
      if (!d.matches('.diffmute-outline') || d.open === outlineOpen) return;
      outlineOpen = d.open;
      void saveOutlineOpen(outlineOpen);
    },
    true
  );
  return element;
}

// ---- reading order ----

async function fetchPins(p: Page): Promise<string[]> {
  if (!p.number) return [];
  const cached = await loadPins(p.prKey);
  if (cached) return cached;
  let found: string[] = [];
  try {
    const res = await fetch(`/${p.repo}/pull/${p.number}`, {
      credentials: 'include',
    });
    if (res.ok) {
      const parsed = new DOMParser().parseFromString(
        await res.text(),
        'text/html'
      );
      const body = parsed.querySelector('.comment-body');
      found = body ? pinsFromBody(body) : [];
    }
  } catch {
    return [];
  }
  await savePins(p.prKey, found);
  return found;
}

function isFresh(hash: string): boolean {
  const t = tags.get(hash);
  return t === 'new' || t === 'changed';
}

// ---- bar ----

function isViewed(element: HTMLElement | null, hash: string): boolean {
  if (viewedLocal.has(hash)) return true;
  if (!element) return false;
  const c = viewedControl(element);
  if (!c) return false;
  if (c instanceof HTMLInputElement) return c.checked;
  if (
    c.getAttribute('aria-pressed') === 'true' ||
    c.getAttribute('aria-checked') === 'true'
  )
    return true;
  return !!c.querySelector<HTMLInputElement>('input:checked');
}

function makeButton(
  label: string,
  action: string,
  cls = 'diffmute-link'
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.dataset.action = action;
  b.textContent = label;
  return b;
}

function markViewed(element: HTMLElement, hash: string): void {
  markRead(hash);
  if (isViewed(element, hash)) return;
  const control = viewedControl(element);
  if (control) {
    control.click();
    return;
  }
  viewedLocal.add(hash);
  setCollapsed(element, true);
  queueSave();
}

async function onBarClick(event: MouseEvent): Promise<void> {
  const button = (event.target as Element).closest<HTMLButtonElement>('button');
  if (!button || !page) return;
  const action = button.dataset.action;
  if (action === 'options') {
    void browser.runtime.sendMessage({ repo: page.repo, type: 'open-options' });
    return;
  }
  if (action === 'goto') {
    jumpTo(button.dataset.hash!, true);
    return;
  }
  if (action === 'next-new') {
    const hash = navOrder.find(
      (h) => isFresh(h) && !isViewed(fileElement(h), h)
    );
    if (hash) jumpTo(hash, true);
    return;
  }
  switch (action) {
    case 'filter-all': {
      shown.clear();
      userExpanded.clear();

      break;
    }
    case 'show-all': {
      for (const id of allCategories().values()) if (id) shown.add(id);

      break;
    }
    case 'toggle': {
      const id = button.dataset.category!;
      if (shown.has(id)) {
        shown.delete(id);
        // Muting a category again also re-mutes files opened by hand.
        for (const [hash, cat] of seen)
          if (cat === id) userExpanded.delete(hash);
      } else {
        shown.add(id);
      }

      break;
    }
    default: {
      return;
    }
  }
  await savePrState(page.prKey, { shown: [...shown] });
  barSignature = '';
  queueScan(0);
}

function outlineRows(rules: Rules): OutlineRow[] {
  const byPath = new Map(files.map((f) => [f.path, f.hash]));
  const all = ordered.map(({ path, tier }) => {
    const hash = byPath.get(path)!;
    return { hash, muted: isMuted(hash, path, rules), path, tier };
  });
  // Muted files go to the end of their tier.
  return TIER_ORDER.flatMap((t) => {
    const rows = all.filter((r) => r.tier === t);
    return [...rows.filter((r) => !r.muted), ...rows.filter((r) => r.muted)];
  });
}

// Finds a "Review order" heading (or bold line) in the PR description and
// reads the list after it.
function pinsFromBody(body: Element): string[] {
  for (const h of body.querySelectorAll(
    'h1, h2, h3, h4, h5, h6, p, strong, b'
  )) {
    if (!isReviewOrderHeading(h.textContent ?? '')) continue;
    let block: Element | null = h.closest('p, h1, h2, h3, h4, h5, h6') ?? h;
    while ((block = block.nextElementSibling)) {
      if (/^H[1-6]$/.test(block.tagName)) break;
      if (block.matches('ul, ol')) {
        return [...block.querySelectorAll(':scope > li')]
          .map((li) =>
            pinFromItem(
              li.querySelector('code')?.textContent ?? null,
              li.textContent ?? ''
            )
          )
          .filter((x): x is string => !!x);
      }
    }
  }
  return [];
}

function placeBar(fileEls: HTMLElement[]): HTMLElement {
  bar ??= createBar();
  if (bar.isConnected) return bar;
  const first = fileEls[0];
  const last = fileEls.at(-1) ?? first;
  let anchor: Element = first.closest('copilot-diff-entry') ?? first;
  while (anchor.parentElement && !anchor.contains(last)) {
    anchor = anchor.parentElement;
  }
  anchor.parentElement?.insertBefore(bar, anchor);
  return bar;
}

function renderBar(element: HTMLElement, rules: Rules, total: number): void {
  const counts = new Map<string, number>();
  for (const id of allCategories().values())
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  const cats = rules.categories.filter((c) => counts.has(c.id));
  const summary = summaryText(cats, counts, shown, total);

  const fresh = revisitActive()
    ? navOrder.filter((hash) => isFresh(hash)).length
    : 0;
  const rows =
    config!.features.order && files.length > 1 ? outlineRows(rules) : [];

  const signature = JSON.stringify([
    summary,
    cats.map((c) => [c.id, counts.get(c.id), shown.has(c.id)]),
    fresh,
    rows.map((r) => [r.hash, r.tier, r.muted, tags.get(r.hash)]),
  ]);
  if (signature === barSignature) return;
  barSignature = signature;

  element.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = 'diffmute';
  const text = document.createElement('span');
  text.className = 'diffmute-summary';
  text.textContent = summary;

  const chips = document.createElement('span');
  chips.className = 'diffmute-chips';
  if (fresh) {
    const b = makeButton(
      `${fresh} new since last visit`,
      'next-new',
      'diffmute-chip diffmute-fresh'
    );
    b.title =
      'Jump to the first file that is new or changed since you last read it';
    chips.append(b);
  }
  for (const c of cats) {
    const muted = !shown.has(c.id);
    const b = makeButton(
      `${c.name} ${counts.get(c.id)}`,
      'toggle',
      'diffmute-chip'
    );
    b.dataset.category = c.id;
    b.setAttribute('aria-pressed', String(muted));
    b.title = muted
      ? `Show ${c.name}`
      : `${c.mode === 'hide' ? 'Hide' : 'Collapse'} ${c.name}`;
    chips.append(b);
  }
  if (cats.length > 0) {
    const anyMuted = cats.some((c) => !shown.has(c.id));
    chips.append(
      anyMuted
        ? makeButton('show all', 'show-all')
        : makeButton('mute all', 'filter-all')
    );
  }
  const gear = makeButton('rules', 'options');
  gear.title = 'Edit diffmute rules';
  element.append(title, text, chips, gear);
  if (rows.length > 0) element.append(renderOutline(rows));
}

function renderOutline(rows: OutlineRow[]): HTMLElement {
  const details = document.createElement('details');
  details.className = 'diffmute-outline';
  details.open = outlineOpen;
  const summary = document.createElement('summary');
  const first = rows.find((r) => !r.muted);
  summary.textContent = first
    ? `Reading order · start with ${first.path.split('/').pop()}`
    : 'Reading order';
  details.append(summary);
  for (const tier of TIER_ORDER) {
    const inTier = rows.filter((r) => r.tier === tier);
    if (inTier.length === 0) continue;
    const h = document.createElement('div');
    h.className = 'diffmute-tier';
    h.textContent = TIER_NAMES[tier];
    const list = document.createElement('ol');
    for (const r of inTier) {
      const li = document.createElement('li');
      const b = makeButton('', 'goto', 'diffmute-file');
      b.dataset.hash = r.hash;
      if (r.muted) b.classList.add('diffmute-file-muted');
      const slash = r.path.lastIndexOf('/');
      const dir = document.createElement('span');
      dir.className = 'diffmute-dir';
      dir.textContent = slash === -1 ? '' : r.path.slice(0, slash + 1);
      const name = document.createElement('span');
      name.textContent = r.path.slice(slash + 1);
      b.append(dir, name);
      const tag = tags.get(r.hash);
      if (tag === 'new' || tag === 'changed') {
        const badge = document.createElement('span');
        badge.className = 'diffmute-badge';
        badge.dataset.tag = tag;
        badge.textContent = tag;
        b.append(badge);
      }
      li.append(b);
      list.append(li);
    }
    details.append(h, list);
  }
  return details;
}

function viewedControl(element: HTMLElement): HTMLElement | null {
  const header = headerOf(element);
  return (
    header.querySelector<HTMLElement>(
      'input.js-reviewed-checkbox, input[name="viewed"]'
    ) ??
    [...header.querySelectorAll<HTMLElement>('button, label')].find((b) =>
      /^(not )?viewed$/i.test(
        clean(b.getAttribute('aria-label') || b.textContent)
      )
    ) ??
    null
  );
}

// ---- per-file mute menu ----

let menuElement: HTMLElement | null = null;

function applyMuteButton(element: HTMLElement, hash: string): void {
  const header = headerOf(element);
  if (header.querySelector('.diffmute-mute')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'diffmute-mute';
  button.textContent = 'mute…';
  button.title = 'Add a diffmute rule for files like this';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (menuElement?.dataset.hash === hash) closeMenu();
    else openMenu(button, hash);
  });
  const link = header.querySelector(`a[href$="#${element.id}"]`);
  (link?.parentElement ?? header).append(button);
}

function closeMenu(): void {
  menuElement?.remove();
  menuElement = null;
}

function openMenu(anchor: HTMLElement, hash: string): void {
  closeMenu();
  const path = pathCache.get(hash);
  if (!path || !config || !page) return;
  const repo = page.repo.toLowerCase();
  const globCats = config.categories.filter((c) => !c.detect);
  const current = seen.get(hash);

  const menu = document.createElement('div');
  menu.className = 'diffmute-menu';
  menu.dataset.hash = hash;
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Mute files like this');

  const title = document.createElement('strong');
  title.textContent = path;
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Category');
  for (const c of globCats) select.append(new Option(c.name, c.id));
  select.value = globCats.some((c) => c.id === current)
    ? current!
    : (globCats[0]?.id ?? '');
  const pick = document.createElement('label');
  pick.append('Add to ', select);

  const list = document.createElement('div');
  list.className = 'diffmute-menu-list';
  for (const s of suggestPatterns(path)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.pattern = s.pattern;
    const code = document.createElement('code');
    code.textContent = s.pattern;
    b.append(code, ` ${s.label}`);
    list.append(b);
  }
  const never = document.createElement('button');
  never.type = 'button';
  never.dataset.never = '1';
  never.textContent = `Never mute this file in ${page.repo}`;

  menu.append(title, pick, list, never);
  menu.addEventListener('click', async (event) => {
    const b = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!b) return;
    const fresh = await loadConfig();
    if (b.dataset.never) {
      const r = (fresh.repos[repo] ??= {
        categories: {},
        ignore: [],
        off: false,
      });
      if (!r.ignore.includes(`/${path}`)) r.ignore.push(`/${path}`);
      toast(`${path} will not be muted in ${page!.repo}`);
    } else {
      const cat = fresh.categories.find((c) => c.id === select.value);
      if (!cat) return;
      if (!cat.patterns.includes(b.dataset.pattern!))
        cat.patterns.push(b.dataset.pattern!);
      cat.enabled = true;
      shown.delete(cat.id);
      toast(`Added ${b.dataset.pattern} to ${cat.name}`);
    }
    userExpanded.delete(hash);
    closeMenu();
    await saveConfig(fresh);
  });

  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menuElement = menu;
}

document.addEventListener('click', (event) => {
  if (
    menuElement &&
    !menuElement.contains(event.target as Node) &&
    !(event.target as Element).closest?.('.diffmute-mute')
  )
    closeMenu();
});
window.addEventListener('scroll', () => closeMenu(), { passive: true });

// ---- keyboard ----

// The file the keyboard last jumped to stays current until the user scrolls
// by hand, since collapsing files above it shifts the page under it.
function currentHash(): null | string {
  if (lastJump) {
    const r = fileElement(lastJump)?.getBoundingClientRect();
    if (r && r.bottom > 0 && r.top < window.innerHeight) return lastJump;
  }
  let current: null | string = null;
  for (const element of document.querySelectorAll<HTMLElement>(
    '[id^="diff-"]'
  )) {
    if (
      !FILE_ID.test(element.id) ||
      element.classList.contains('diffmute-hidden')
    )
      continue;
    if (element.getBoundingClientRect().top > STICKY_OFFSET + 8) break;
    current = element.id.slice(5);
  }
  return current;
}

function fileElement(hash: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#diff-${hash}`);
}

function highlight(element: HTMLElement): void {
  for (const n of document.querySelectorAll('.diffmute-current'))
    n.classList.remove('diffmute-current');
  element.classList.add('diffmute-current');
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(
    () => element.classList.remove('diffmute-current'),
    1500
  );
}

function jumpTo(hash: string, expand: boolean): void {
  const element = fileElement(hash);
  lastJump = hash;
  if (!element) {
    // Not rendered yet (lazy or virtualised); GitHub scrolls to the anchor.
    location.hash = `diff-${hash}`;
    return;
  }
  if (expand && !isExpanded(element)) {
    if (element.dataset.diffmute) {
      userExpanded.add(hash);
      undo(element);
    }
    element.classList.remove('diffmute-collapsed');
    setCollapsed(element, false);
  }
  const top =
    element.getBoundingClientRect().top + window.scrollY - STICKY_OFFSET;
  window.scrollTo({ behavior: 'instant' as ScrollBehavior, top });
  highlight(element);
}

function needsAttention(hash: string): boolean {
  const element = fileElement(hash);
  if (element?.classList.contains('diffmute-hidden')) return false;
  if (element?.dataset.diffmute) return false;
  if (userExpanded.has(hash)) return !isViewed(element, hash);
  if (!element && config && page) {
    const path = pathCache.get(hash);
    if (path && isMuted(hash, path, resolveRules(config, page.repo)))
      return false;
  }
  return !isViewed(element, hash);
}

function step(dir: -1 | 1, from = currentHash()): void {
  const order = navOrder;
  const index = from ? order.indexOf(from) : -1;
  const next = nextFile(
    index,
    order.length,
    (index) => !needsAttention(order[index]),
    dir
  );
  if (next === -1) {
    toast(
      dir === 1 ? 'All files reviewed' : 'This is the first file to review'
    );
    return;
  }
  jumpTo(order[next], true);
}

let toastElement: HTMLElement | null = null;
function toast(text: string): void {
  toastElement ??= Object.assign(document.createElement('div'), {
    className: 'diffmute-toast',
  });
  toastElement.textContent = text;
  document.body.append(toastElement);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement?.remove(), 2000);
}

const KEYS: [string, string][] = [
  [']', 'Next file to review'],
  ['[', 'Previous file to review'],
  ['v', 'Mark viewed and go to next'],
  ['x', 'Collapse or expand current file'],
  ['h', 'Show or hide this help'],
];

let helpElement: HTMLElement | null = null;
async function enterPr(p: Page): Promise<void> {
  if (saveTimer) await flushSave();
  const state = await loadPrState(p.prKey);
  shown = new Set(state.shown);
  baseline = { ...state.read };
  read = { ...state.read };
  viewedLocal = new Set(state.viewed);
  userExpanded.clear();
  folderFiles.clear();
  tags.clear();
  factsCache.clear();
  fingerprints.clear();
  pins = [];
  if (config?.features.order) {
    void fetchPins(p).then((found) => {
      if (page?.prKey !== p.prKey || found.length === 0) return;
      pins = found;
      barSignature = '';
      queueScan(0);
    });
  }
}

function isEditable(t: EventTarget | null): boolean {
  const element = t as HTMLElement | null;
  return !!element?.closest?.(
    "input, textarea, select, [contenteditable=''], [contenteditable='true']"
  );
}

// Nodes diffmute itself adds; changes to them never need a rescan.
function isOwnNode(node: Node): boolean {
  return (
    (bar?.contains(node) ?? false) ||
    (menuElement?.contains(node) ?? false) ||
    (node instanceof Element &&
      node.matches(
        '.diffmute-badge, .diffmute-toast, .diffmute-help, .diffmute-mute, .diffmute-menu'
      ))
  );
}

// ---- scan ----

function onKey(event: KeyboardEvent): void {
  if (
    !page ||
    !config?.features.keys ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    isEditable(event.target)
  )
    return;
  if (!document.querySelector('[id^="diff-"]')) return;
  const handled = (() => {
    switch (event.key) {
      case '[': {
        step(-1);
        return true;
      }
      case ']': {
        step(1);
        return true;
      }
      case 'Escape': {
        if (menuElement) {
          closeMenu();
          return true;
        }
        if (helpElement?.isConnected) {
          toggleHelp(false);
          return true;
        }
        return false;
      }
      case 'h': {
        toggleHelp();
        return true;
      }
      case 'v': {
        const hash = currentHash();
        const element = hash ? fileElement(hash) : null;
        if (hash && element) markViewed(element, hash);
        step(1, hash);
        return true;
      }
      case 'x': {
        const hash = currentHash();
        const element = hash ? fileElement(hash) : null;
        if (element) {
          setCollapsed(element, isExpanded(element));
          highlight(element);
        }
        return true;
      }
      default: {
        return false;
      }
    }
  })();
  if (handled) {
    // Keep GitHub's own handlers from acting on the same key.
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

function queueScan(delay = 150): void {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, delay);
}

async function scan(): Promise<void> {
  if (scanning) {
    rescan = true;
    return;
  }
  scanning = true;
  try {
    const p = parsePage(location.pathname);
    if (!p) return teardown();
    config ??= await loadConfig();
    if (!page || page.prKey !== p.prKey) await enterPr(p);
    if (!page || page.path !== p.path) {
      // A commit page shows different content for the same paths.
      seen.clear();
      predicted.clear();
      tags.clear();
      factsCache.clear();
      fingerprints.clear();
      barSignature = '';
    }
    page = p;

    const rules = resolveRules(config, p.repo);
    classCache = new Map();
    const repoOff = !!config.repos[p.repo.toLowerCase()]?.off;
    const revisit = revisitActive() && !repoOff;
    if (revisit) rules.categories.push(UNCHANGED);
    const byId = new Map(rules.categories.map((c) => [c.id, c]));
    const fileEls = [
      ...document.querySelectorAll<HTMLElement>('[id^="diff-"]'),
    ].filter((element) => FILE_ID.test(element.id));
    for (const element of fileEls) {
      const hash = element.id.slice(5);
      const path = await resolvePath(element, hash);
      if (!path) continue;
      const { facts, fp } = await fileState(element, hash);
      const tag = p.whole ? tagFile(baseline, hash, fp) : null;
      if (tag) tags.set(hash, tag);
      else tags.delete(hash);
      const cat = classify(
        path,
        rules,
        revisit ? { ...facts, unchanged: tag === 'unchanged' } : facts
      );
      seen.set(hash, cat?.id ?? null);
      applyFile(element, hash, cat);
      applyBadge(element, revisit ? (tag ?? undefined) : undefined);
      applyMuteButton(element, hash);
      if (!observed.has(element)) {
        observed.add(element);
        readObserver.observe(element);
      }
    }

    const hidden = [...seen]
      .filter(([, id]) => id && byId.get(id)?.mode === 'hide' && !shown.has(id))
      .map(([hash]) => hash);
    markTree('diffmute-tree-hidden', hidden);
    markTree(
      'diffmute-tree-fresh',
      revisit
        ? [...tags].filter(([, t]) => t !== 'unchanged').map(([h]) => h)
        : []
    );
    applyFolders(rules);
    if (fileEls.length === 0) return;

    files = await collectFiles(fileEls);
    predicted.clear();
    for (const f of files)
      if (!seen.has(f.hash))
        predicted.set(f.hash, categoryOf(f.hash, f.path, rules));
    const hashOf = new Map(files.map((f) => [f.path, f.hash]));
    ordered = config.features.order
      ? orderFiles(
          files.map((f) => f.path),
          config.tiers,
          pins
        )
      : [];
    navOrder =
      ordered.length > 0
        ? ordered.map(({ path }) => hashOf.get(path)!)
        : files.map((f) => f.hash);

    if (repoOff) {
      bar?.remove();
      return;
    }
    renderBar(placeBar(fileEls), rules, files.length || seen.size);
  } catch (error) {
    console.error('diffmute:', error);
  } finally {
    scanning = false;
    if (rescan) {
      rescan = false;
      queueScan();
    }
  }
}

function teardown(): void {
  void flushSave();
  bar?.remove();
  barSignature = '';
  page = null;
  seen.clear();
  predicted.clear();
  userExpanded.clear();
  closeMenu();
  tags.clear();
  files = [];
  ordered = [];
  navOrder = [];
  for (const b of document.querySelectorAll('.diffmute-badge')) b.remove();
  markTree('diffmute-tree-fresh', []);
}

function toggleHelp(force?: boolean): void {
  const open = force ?? !helpElement?.isConnected;
  if (!open) {
    helpElement?.remove();
    return;
  }
  helpElement = document.createElement('div');
  helpElement.className = 'diffmute-help';
  helpElement.setAttribute('role', 'dialog');
  helpElement.setAttribute('aria-label', 'diffmute shortcuts');
  const title = document.createElement('strong');
  title.textContent = 'diffmute shortcuts';
  const list = document.createElement('dl');
  for (const [k, label] of KEYS) {
    const dt = document.createElement('dt');
    const kbd = document.createElement('kbd');
    kbd.textContent = k;
    dt.append(kbd);
    const dd = document.createElement('dd');
    dd.textContent = label;
    list.append(dt, dd);
  }
  helpElement.append(title, list);
  helpElement.addEventListener('click', () => toggleHelp(false));
  document.body.append(helpElement);
}

new MutationObserver((mutations) => {
  const ownOnly = mutations.every(
    (m) =>
      isOwnNode(m.target) ||
      [...m.addedNodes, ...m.removedNodes].every((node) => isOwnNode(node))
  );
  if (!ownOnly) queueScan();
}).observe(document.documentElement, { childList: true, subtree: true });

for (const event_ of ['turbo:load', 'popstate', 'pageshow']) {
  globalThis.addEventListener(event_, () => queueScan(0));
  document.addEventListener(event_, () => queueScan(0));
}

globalThis.addEventListener('keydown', onKey, true);
const SCROLL_KEYS = new Set([
  ' ',
  'ArrowDown',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
]);
const forgetJump = () => {
  lastJump = null;
};
window.addEventListener('wheel', forgetJump, { passive: true });
globalThis.addEventListener('touchmove', forgetJump, { passive: true });
globalThis.addEventListener('keydown', (event) => {
  if (SCROLL_KEYS.has(event.key) && !isEditable(event.target)) forgetJump();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) void flushSave();
});
window.addEventListener('pagehide', () => {
  if (saveTimer) void flushSave();
});

// Viewed checkboxes count as reading the file.
document.addEventListener(
  'change',
  (event) => {
    const input = event.target as HTMLInputElement;
    if (
      !input.matches?.('input.js-reviewed-checkbox, input[name="viewed"]') ||
      !input.checked
    )
      return;
    const element = input.closest<HTMLElement>('[id^="diff-"]');
    if (element && FILE_ID.test(element.id)) markRead(element.id.slice(5));
  },
  true
);

// A muted file the user expands with GitHub's own toggle stays open, even
// after the virtualised diff unmounts and remounts it.
document.addEventListener(
  'click',
  (event) => {
    if (!event.isTrusted) return;
    const button = (event.target as Element).closest?.<HTMLButtonElement>(
      'button[aria-expanded]'
    );
    const element = button?.closest<HTMLElement>('[id^="diff-"]');
    if (
      !button ||
      !element ||
      !FILE_ID.test(element.id) ||
      toggleButton(element) !== button
    )
      return;
    const hash = element.id.slice(5);
    const opening = button.getAttribute('aria-expanded') !== 'true';
    if (opening && element.dataset.diffmute) {
      userExpanded.add(hash);
      delete element.dataset.diffmute;
      delete element.dataset.diffmuteClicked;
    } else if (!opening && userExpanded.delete(hash)) {
      barSignature = '';
      queueScan();
    }
  },
  true
);

onConfigChange(() => {
  config = null;
  seen.clear();
  barSignature = '';
  queueScan(0);
});

void loadOutlineOpen().then((open) => {
  outlineOpen = open;
});

queueScan(0);
