import { parseCounts, whitespaceOnly, type Counts } from "./detect.ts";
import { nextFile } from "./nav.ts";
import {
  TIER_NAMES,
  TIER_ORDER,
  isReviewOrderHeading,
  orderFiles,
  pinFromItem,
  type OrderTier,
  type OrderedFile,
} from "./order.ts";
import { fingerprint, tagFile, type Tag } from "./revisit.ts";
import { UNCHANGED, classify, resolveRules, type Category, type Config, type FileFacts, type Rules } from "./rules.ts";
import {
  loadConfig,
  loadOutlineOpen,
  loadPins,
  loadPrState,
  onConfigChange,
  saveOutlineOpen,
  savePins,
  savePrState,
} from "./storage.ts";

type Applied = "collapse" | "hide" | "none";

interface Page {
  repo: string;
  number: string;
  prKey: string;
  path: string;
  // Full PR diff (not one commit or a commit range), so fingerprints taken
  // here describe the whole PR and can be recorded.
  whole: boolean;
}

interface FileEntry {
  hash: string;
  path: string;
}

// GitHub gives every file container id="diff-<sha256(path)>" in both the
// classic and the React diff views, so the hash is our stable file key.
const FILE_ID = /^diff-([0-9a-f]{64})$/;
const PAGE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(files|changes|commits\/[0-9a-f]+)(\/[^/]*)?\/?$/;
const CHANGED_ROWS = "td.blob-code-addition, td.blob-code-deletion";
const READ_AFTER_MS = 1000;
const SAVE_AFTER_MS = 2000;
const STICKY_OFFSET = 140;

let config: Config | null = null;
let page: Page | null = null;
let shown = new Set<string>(); // category ids revealed on this PR
const seen = new Map<string, string | null>(); // hash -> category id, survives virtualised unmounts
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
let lastJump: string | null = null;
let bar: HTMLElement | null = null;
let barSignature = "";
let scanTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let highlightTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let scanning = false;
let rescan = false;

function parsePage(): Page | null {
  const m = location.pathname.match(PAGE);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  const whole = (m[4] === "files" || m[4] === "changes") && !m[5]?.slice(1);
  return { repo, number: m[3], prKey: `${repo}#${m[3]}`.toLowerCase(), path: location.pathname, whole };
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pathHash(path: string): Promise<string> {
  let h = hashCache.get(path);
  if (!h) {
    h = await sha256(path);
    hashCache.set(path, h);
  }
  return h;
}

function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/[‎‏‪-‮]/g, "").trim();
}

function dataPath(el: Element): string {
  return (
    clean(el.getAttribute("data-tagsearch-path")) ||
    clean(el.closest("[data-file-path]")?.getAttribute("data-file-path")) ||
    clean(el.querySelector("[data-path]")?.getAttribute("data-path"))
  );
}

function headerOf(el: Element): Element {
  return el.querySelector(".file-header, [class*='file-header'], [class*='FileHeader']") ?? el.firstElementChild ?? el;
}

function pathCandidates(el: Element): string[] {
  const raw: (string | null | undefined)[] = [
    el.getAttribute("data-tagsearch-path"),
    el.closest("[data-file-path]")?.getAttribute("data-file-path"),
    el.querySelector("[data-path]")?.getAttribute("data-path"),
  ];
  for (const a of el.querySelectorAll(`a[href$="#${el.id}"]`)) {
    raw.push(a.getAttribute("title"), a.textContent);
  }
  raw.push(el.querySelector("h3")?.textContent);
  const out: string[] = [];
  for (const r of raw) {
    const c = clean(r);
    if (!c) continue;
    out.push(c);
    // renames render as "old → new"
    if (c.includes("→")) out.push(clean(c.split("→").pop()));
  }
  return [...new Set(out)];
}

async function resolvePath(el: Element, hash: string): Promise<string | null> {
  const cached = pathCache.get(hash);
  if (cached) return cached;
  for (const c of pathCandidates(el)) {
    if ((await sha256(c)) === hash) {
      pathCache.set(hash, c);
      return c;
    }
  }
  // Nothing hashed to the id; trust a data attribute if one exists.
  const fallback = dataPath(el);
  if (fallback) pathCache.set(hash, fallback);
  return fallback || null;
}

// ---- structural facts and fingerprints ----

function countsOf(el: Element): Counts | null {
  const header = headerOf(el);
  for (const node of header.querySelectorAll(".sr-only, [aria-label]")) {
    const c = parseCounts(node.textContent || node.getAttribute("aria-label") || "");
    if (c) return c;
  }
  return parseCounts(header.textContent ?? "");
}

function changedLines(el: Element): { removed: string[]; added: string[] } {
  const removed: string[] = [];
  const added: string[] = [];
  for (const td of el.querySelectorAll(CHANGED_ROWS)) {
    (td.classList.contains("blob-code-addition") ? added : removed).push(td.textContent ?? "");
  }
  return { removed, added };
}

// Text of the file body, only read when the diff has no rendered lines,
// so it is short ("File renamed without changes.", "Load diff").
function bodyText(el: Element): string {
  return (el.querySelector(".js-file-content") ?? el).textContent ?? "";
}

function detectFacts(el: HTMLElement, counts: Counts | null): FileFacts {
  const { removed, added } = changedLines(el);
  const rendered = removed.length + added.length > 0;
  const text = rendered ? "" : bodyText(el);
  const deleted = el.getAttribute("data-file-deleted") === "true" || /This file was deleted\./.test(text);
  const renamed =
    !deleted &&
    (/File renamed without changes/i.test(text) ||
      (counts?.changes === 0 && pathCandidates(el).some((c) => c.includes("→"))));
  let whitespace: boolean | null = null;
  if (deleted || renamed) whitespace = false;
  else if (/Whitespace-only changes/i.test(text)) whitespace = true;
  else if (rendered && (!counts || counts.changes === removed.length + added.length)) {
    whitespace = whitespaceOnly(removed, added);
  }
  return { deleted, renamed, whitespace };
}

async function fileState(el: HTMLElement, hash: string): Promise<{ facts: FileFacts; fp: string }> {
  const settled = factsCache.get(hash);
  const known = fingerprints.get(hash);
  if (settled && known && !known.endsWith(":")) return { facts: settled, fp: known };

  const counts = countsOf(el);
  const facts = settled ?? detectFacts(el, counts);
  if (facts.whitespace !== null) factsCache.set(hash, facts);

  const { removed, added } = changedLines(el);
  const linesHash =
    removed.length + added.length ? await sha256(`-${removed.join("\n")}\n+${added.join("\n")}`) : "";
  const fp = fingerprint(counts, linesHash);
  fingerprints.set(hash, fp);
  return { facts, fp };
}

// ---- collapse and hide ----

function toggleButton(el: Element): HTMLButtonElement | null {
  const buttons = el.querySelectorAll<HTMLButtonElement>("button[aria-expanded]");
  return (
    [...buttons].find((b) =>
      /toggle diff|collapse file|expand file|^(collapse|expand)\b/i.test(b.getAttribute("aria-label") ?? ""),
    ) ?? null
  );
}

function isExpanded(el: HTMLElement): boolean {
  if (el.classList.contains("diffmute-hidden") || el.classList.contains("diffmute-collapsed")) return false;
  const btn = toggleButton(el);
  return btn ? btn.getAttribute("aria-expanded") === "true" : true;
}

// Returns true if the file's collapsed state was changed.
function setCollapsed(el: HTMLElement, want: boolean): boolean {
  const btn = toggleButton(el);
  if (!btn) {
    const had = el.classList.contains("diffmute-collapsed");
    el.classList.toggle("diffmute-collapsed", want);
    return had !== want;
  }
  const expanded = btn.getAttribute("aria-expanded") === "true";
  if (expanded !== want) return false;
  btn.click();
  return true;
}

function undo(el: HTMLElement): void {
  const state = el.dataset.diffmute;
  if (state === "collapse" && el.dataset.diffmuteClicked) setCollapsed(el, false);
  if (state === "hide") el.classList.remove("diffmute-hidden");
  delete el.dataset.diffmuteClicked;
  delete el.dataset.diffmute;
}

function applyFile(el: HTMLElement, cat: Category | null): void {
  const want: Applied = cat && !shown.has(cat.id) ? cat.mode : "none";
  const have = (el.dataset.diffmute as Applied | undefined) ?? "none";
  if (want === have) return;
  undo(el);
  if (want === "collapse") {
    if (setCollapsed(el, true)) el.dataset.diffmuteClicked = "1";
  } else if (want === "hide") {
    el.classList.add("diffmute-hidden");
  }
  if (want !== "none") el.dataset.diffmute = want;
}

// ---- file tree ----

const TREE_ITEM = '[role="treeitem"]';
const TREE_GROUP = '[role="group"]';

function treeNodes(hash: string): Set<Element> {
  const nodes = new Set<Element>();
  const byId = document.getElementById(`file-tree-item-diff-${hash}`);
  if (byId) nodes.add(byId);
  for (const a of document.querySelectorAll(`[role="treeitem"] a[href*="diff-${hash}"]`)) {
    const item = a.closest('[role="treeitem"]');
    if (item) nodes.add(item);
  }
  const path = pathCache.get(hash);
  const byPath = path ? document.getElementById(path) : null;
  if (byPath?.getAttribute("role") === "treeitem") nodes.add(byPath);
  return nodes;
}

function markTree(cls: string, hashes: Iterable<string>): void {
  const want = new Set<Element>();
  for (const hash of hashes) for (const n of treeNodes(hash)) want.add(n);
  for (const n of document.querySelectorAll(`.${cls}`)) {
    if (!want.has(n)) n.classList.remove(cls);
  }
  for (const n of want) n.classList.add(cls);
}

function treeLeafPath(node: Element): string | null {
  const text = clean(
    node.querySelector(":scope > [data-filterable-item-text], :scope > * > [data-filterable-item-text]")
      ?.textContent,
  );
  if (text) return text;
  const hash = treeLeafHash(node);
  return hash ? (pathCache.get(hash) ?? null) : null;
}

function treeLeafHash(node: Element): string | null {
  return (
    node.id.match(/diff-([0-9a-f]{64})$/)?.[1] ??
    node.querySelector('a[href*="#diff-"]')?.getAttribute("href")?.match(/#diff-([0-9a-f]{64})/)?.[1] ??
    null
  );
}

function treeLeaves(): Element[] {
  return [...document.querySelectorAll(TREE_ITEM)].filter((n) => !n.querySelector(TREE_GROUP));
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
  for (const el of fileEls) {
    const hash = el.id.slice(5);
    const path = pathCache.get(hash);
    if (path && !have.has(hash)) {
      have.add(hash);
      out.push({ hash, path });
    }
  }
  return out;
}

function categoryOf(hash: string, path: string, rules: Rules): string | null {
  return seen.has(hash) ? seen.get(hash)! : (classify(path, rules)?.id ?? null);
}

function isMuted(hash: string, path: string, rules: Rules): boolean {
  const id = categoryOf(hash, path, rules);
  return !!id && !shown.has(id);
}

function folderToggle(dir: Element): { el: HTMLElement; expanded: boolean } | null {
  const btn = dir.querySelector<HTMLElement>(":scope > button[aria-expanded], :scope > div > button[aria-expanded]");
  if (btn) return { el: btn, expanded: btn.getAttribute("aria-expanded") === "true" };
  const content = dir.firstElementChild as HTMLElement | null;
  if (dir.hasAttribute("aria-expanded") && content && !content.matches(TREE_GROUP)) {
    return { el: content, expanded: dir.getAttribute("aria-expanded") === "true" };
  }
  return null;
}

// Collapses sidebar folders whose files are all muted (e.g. __tests__/),
// and reopens them once any of their files is shown again. Folders the
// user reopens by hand are left alone.
function applyFolders(rules: Rules): void {
  const muted = new Map<Element, boolean>();
  for (const node of treeLeaves()) {
    const path = treeLeafPath(node);
    const hash = treeLeafHash(node) ?? (path ? hashCache.get(path) : undefined);
    muted.set(node, !!path && isMuted(hash ?? "", path, rules));
  }
  const allMuted = (dir: Element) => {
    const leaves = [...dir.querySelectorAll(TREE_ITEM)].filter((n) => muted.has(n));
    return leaves.length > 0 && leaves.every((n) => muted.get(n));
  };

  for (const dir of document.querySelectorAll<HTMLElement>(TREE_ITEM)) {
    if (!dir.querySelector(TREE_GROUP)) continue;
    const parent = dir.parentElement?.closest(TREE_ITEM);
    const want = allMuted(dir) && !(parent && allMuted(parent));
    const toggle = folderToggle(dir);
    if (!toggle) continue;
    if (want && !dir.dataset.diffmuteFolder) {
      dir.dataset.diffmuteFolder = "1";
      if (toggle.expanded) toggle.el.click();
      else dir.dataset.diffmuteFolder = "already";
    } else if (!want && dir.dataset.diffmuteFolder) {
      if (dir.dataset.diffmuteFolder === "1" && !toggle.expanded && !(parent && allMuted(parent))) toggle.el.click();
      delete dir.dataset.diffmuteFolder;
    }
  }
}

// ---- revisit: read tracking, badges ----

function revisitActive(): boolean {
  return !!config?.features.revisit && !!page?.whole && Object.keys(baseline).length > 0;
}

function queueSave(): void {
  if (!page) return;
  const key = page.prKey;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(key), SAVE_AFTER_MS);
}

async function flushSave(key = page?.prKey): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!key) return;
  await savePrState(key, { read: { ...read }, viewed: [...viewedLocal] });
}

function markRead(hash: string): void {
  const fp = fingerprints.get(hash);
  if (!page?.whole || !fp || read[hash] === fp) return;
  read[hash] = fp;
  queueSave();
}

const readTimers = new Map<Element, ReturnType<typeof setTimeout>>();
const observed = new WeakSet<Element>();
const readObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const el = e.target as HTMLElement;
    clearTimeout(readTimers.get(el));
    readTimers.delete(el);
    if (!e.isIntersecting) continue;
    readTimers.set(
      el,
      setTimeout(() => {
        readTimers.delete(el);
        if (el.isConnected && isExpanded(el)) markRead(el.id.slice(5));
      }, READ_AFTER_MS),
    );
  }
});

function applyBadge(el: HTMLElement, tag: Tag | undefined): void {
  const want = tag === "new" || tag === "changed" ? tag : null;
  const header = headerOf(el);
  const existing = header.querySelector<HTMLElement>(".diffmute-badge");
  if ((existing?.dataset.tag ?? null) === want) return;
  existing?.remove();
  if (!want) return;
  const badge = document.createElement("span");
  badge.className = "diffmute-badge";
  badge.dataset.tag = want;
  badge.textContent = want;
  const link = header.querySelector(`a[href$="#${el.id}"]`);
  if (link) link.after(badge);
  else header.append(badge);
}

// ---- viewed ----

function viewedControl(el: HTMLElement): HTMLElement | null {
  const header = headerOf(el);
  return (
    header.querySelector<HTMLElement>('input.js-reviewed-checkbox, input[name="viewed"]') ??
    [...header.querySelectorAll<HTMLElement>("button, label")].find((b) =>
      /^(not )?viewed$/i.test(clean(b.getAttribute("aria-label") || b.textContent)),
    ) ??
    null
  );
}

function isViewed(el: HTMLElement | null, hash: string): boolean {
  if (viewedLocal.has(hash)) return true;
  if (!el) return false;
  const c = viewedControl(el);
  if (!c) return false;
  if (c instanceof HTMLInputElement) return c.checked;
  if (c.getAttribute("aria-pressed") === "true" || c.getAttribute("aria-checked") === "true") return true;
  return !!c.querySelector<HTMLInputElement>("input:checked");
}

function markViewed(el: HTMLElement, hash: string): void {
  markRead(hash);
  if (isViewed(el, hash)) return;
  const control = viewedControl(el);
  if (control) {
    control.click();
    return;
  }
  viewedLocal.add(hash);
  setCollapsed(el, true);
  queueSave();
}

// ---- reading order ----

async function fetchPins(p: Page): Promise<string[]> {
  const cached = await loadPins(p.prKey);
  if (cached) return cached;
  let found: string[] = [];
  try {
    const res = await fetch(`/${p.repo}/pull/${p.number}`, { credentials: "include" });
    if (res.ok) {
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const body = doc.querySelector(".comment-body");
      found = body ? pinsFromBody(body) : [];
    }
  } catch {
    return [];
  }
  await savePins(p.prKey, found);
  return found;
}

// Finds a "Review order" heading (or bold line) in the PR description and
// reads the list after it.
function pinsFromBody(body: Element): string[] {
  for (const h of body.querySelectorAll("h1, h2, h3, h4, h5, h6, p, strong, b")) {
    if (!isReviewOrderHeading(h.textContent ?? "")) continue;
    let block: Element | null = h.closest("p, h1, h2, h3, h4, h5, h6") ?? h;
    while ((block = block.nextElementSibling)) {
      if (/^H[1-6]$/.test(block.tagName)) break;
      if (block.matches("ul, ol")) {
        return [...block.querySelectorAll(":scope > li")]
          .map((li) => pinFromItem(li.querySelector("code")?.textContent ?? null, li.textContent ?? ""))
          .filter((x): x is string => !!x);
      }
    }
  }
  return [];
}

// ---- bar ----

function placeBar(fileEls: HTMLElement[]): HTMLElement {
  bar ??= createBar();
  if (bar.isConnected) return bar;
  const first = fileEls[0];
  const last = fileEls[fileEls.length - 1];
  let anchor: Element = first.closest("copilot-diff-entry") ?? first;
  while (anchor.parentElement && !anchor.contains(last)) {
    anchor = anchor.parentElement;
  }
  anchor.parentElement?.insertBefore(bar, anchor);
  return bar;
}

function createBar(): HTMLElement {
  const el = document.createElement("div");
  el.className = "diffmute-bar";
  el.setAttribute("role", "toolbar");
  el.setAttribute("aria-label", "diffmute filters");
  el.addEventListener("click", onBarClick);
  el.addEventListener(
    "toggle",
    (e) => {
      const d = e.target as HTMLDetailsElement;
      if (!d.matches(".diffmute-outline") || d.open === outlineOpen) return;
      outlineOpen = d.open;
      void saveOutlineOpen(outlineOpen);
    },
    true,
  );
  return el;
}

async function onBarClick(e: MouseEvent): Promise<void> {
  const btn = (e.target as Element).closest<HTMLButtonElement>("button");
  if (!btn || !page) return;
  const action = btn.dataset.action;
  if (action === "options") {
    void browser.runtime.sendMessage({ type: "open-options" });
    return;
  }
  if (action === "goto") {
    jumpTo(btn.dataset.hash!, true);
    return;
  }
  if (action === "next-new") {
    const hash = navOrder.find((h) => isFresh(h) && !isViewed(fileEl(h), h));
    if (hash) jumpTo(hash, true);
    return;
  }
  if (action === "toggle") {
    const id = btn.dataset.category!;
    if (shown.has(id)) shown.delete(id);
    else shown.add(id);
  } else if (action === "show-all") {
    for (const id of seen.values()) if (id) shown.add(id);
  } else if (action === "filter-all") {
    shown.clear();
  } else {
    return;
  }
  await savePrState(page.prKey, { shown: [...shown] });
  barSignature = "";
  queueScan(0);
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word.replace(/s$/, "") : word}`;
}

function button(label: string, action: string, cls = "diffmute-link"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.dataset.action = action;
  b.textContent = label;
  return b;
}

function isFresh(hash: string): boolean {
  const t = tags.get(hash);
  return t === "new" || t === "changed";
}

interface OutlineRow {
  hash: string;
  path: string;
  tier: OrderTier;
  muted: boolean;
}

function outlineRows(rules: Rules): OutlineRow[] {
  const byPath = new Map(files.map((f) => [f.path, f.hash]));
  const all = ordered.map(({ path, tier }) => {
    const hash = byPath.get(path)!;
    return { hash, path, tier, muted: isMuted(hash, path, rules) };
  });
  // Muted files go to the end of their tier.
  return TIER_ORDER.flatMap((t) => {
    const rows = all.filter((r) => r.tier === t);
    return [...rows.filter((r) => !r.muted), ...rows.filter((r) => r.muted)];
  });
}

function renderOutline(rows: OutlineRow[]): HTMLElement {
  const details = document.createElement("details");
  details.className = "diffmute-outline";
  details.open = outlineOpen;
  const summary = document.createElement("summary");
  const first = rows.find((r) => !r.muted);
  summary.textContent = first ? `Reading order · start with ${first.path.split("/").pop()}` : "Reading order";
  details.append(summary);
  for (const tier of TIER_ORDER) {
    const inTier = rows.filter((r) => r.tier === tier);
    if (!inTier.length) continue;
    const h = document.createElement("div");
    h.className = "diffmute-tier";
    h.textContent = TIER_NAMES[tier];
    const list = document.createElement("ol");
    for (const r of inTier) {
      const li = document.createElement("li");
      const b = button("", "goto", "diffmute-file");
      b.dataset.hash = r.hash;
      if (r.muted) b.classList.add("diffmute-file-muted");
      const slash = r.path.lastIndexOf("/");
      const dir = document.createElement("span");
      dir.className = "diffmute-dir";
      dir.textContent = slash >= 0 ? r.path.slice(0, slash + 1) : "";
      const name = document.createElement("span");
      name.textContent = r.path.slice(slash + 1);
      b.append(dir, name);
      const tag = tags.get(r.hash);
      if (tag === "new" || tag === "changed") {
        const badge = document.createElement("span");
        badge.className = "diffmute-badge";
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

function renderBar(el: HTMLElement, rules: Rules, total: number): void {
  const counts = new Map<string, number>();
  for (const id of seen.values()) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  const cats = rules.categories.filter((c) => counts.has(c.id));

  const parts: Record<Category["mode"], string[]> = { collapse: [], hide: [] };
  for (const c of cats) if (!shown.has(c.id)) parts[c.mode].push(plural(counts.get(c.id)!, c.name));
  const summary =
    [
      parts.collapse.length ? `Collapsed ${parts.collapse.join(", ")}` : "",
      parts.hide.length ? `Hidden ${parts.hide.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ") || (cats.length ? "Showing all files" : `No noise in ${plural(total, "files")}`);

  const fresh = revisitActive() ? navOrder.filter(isFresh).length : 0;
  const rows = config!.features.order && files.length > 1 ? outlineRows(rules) : [];

  const signature = JSON.stringify([
    summary,
    cats.map((c) => [c.id, counts.get(c.id), shown.has(c.id)]),
    fresh,
    rows.map((r) => [r.hash, r.tier, r.muted, tags.get(r.hash)]),
  ]);
  if (signature === barSignature) return;
  barSignature = signature;

  el.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = "diffmute";
  const text = document.createElement("span");
  text.className = "diffmute-summary";
  text.textContent = summary;

  const chips = document.createElement("span");
  chips.className = "diffmute-chips";
  if (fresh) {
    const b = button(`${fresh} new since last visit`, "next-new", "diffmute-chip diffmute-fresh");
    b.title = "Jump to the first file that is new or changed since you last read it";
    chips.append(b);
  }
  for (const c of cats) {
    const muted = !shown.has(c.id);
    const b = button(`${c.name} ${counts.get(c.id)}`, "toggle", "diffmute-chip");
    b.dataset.category = c.id;
    b.setAttribute("aria-pressed", String(muted));
    b.title = muted ? `Show ${c.name}` : `${c.mode === "hide" ? "Hide" : "Collapse"} ${c.name}`;
    chips.append(b);
  }
  if (cats.length) {
    const anyMuted = cats.some((c) => !shown.has(c.id));
    chips.append(anyMuted ? button("show all", "show-all") : button("mute all", "filter-all"));
  }
  const gear = button("rules", "options");
  gear.title = "Edit diffmute rules";
  el.append(title, text, chips, gear);
  if (rows.length) el.append(renderOutline(rows));
}

// ---- keyboard ----

function fileEl(hash: string): HTMLElement | null {
  return document.getElementById(`diff-${hash}`);
}

// The file the keyboard last jumped to stays current until the user scrolls
// by hand, since collapsing files above it shifts the page under it.
function currentHash(): string | null {
  if (lastJump) {
    const r = fileEl(lastJump)?.getBoundingClientRect();
    if (r && r.bottom > 0 && r.top < window.innerHeight) return lastJump;
  }
  let current: string | null = null;
  for (const el of document.querySelectorAll<HTMLElement>('[id^="diff-"]')) {
    if (!FILE_ID.test(el.id) || el.classList.contains("diffmute-hidden")) continue;
    if (el.getBoundingClientRect().top > STICKY_OFFSET + 8) break;
    current = el.id.slice(5);
  }
  return current;
}

function highlight(el: HTMLElement): void {
  for (const n of document.querySelectorAll(".diffmute-current")) n.classList.remove("diffmute-current");
  el.classList.add("diffmute-current");
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => el.classList.remove("diffmute-current"), 1500);
}

function jumpTo(hash: string, expand: boolean): void {
  const el = fileEl(hash);
  lastJump = hash;
  if (!el) {
    // Not rendered yet (lazy or virtualised); GitHub scrolls to the anchor.
    location.hash = `diff-${hash}`;
    return;
  }
  if (expand && !isExpanded(el)) {
    el.classList.remove("diffmute-collapsed");
    setCollapsed(el, false);
  }
  const top = el.getBoundingClientRect().top + window.scrollY - STICKY_OFFSET;
  window.scrollTo({ top, behavior: "instant" as ScrollBehavior });
  highlight(el);
}

function needsAttention(hash: string): boolean {
  const el = fileEl(hash);
  if (el?.classList.contains("diffmute-hidden")) return false;
  if (el?.dataset.diffmute) return false;
  if (!el && config && page) {
    const path = pathCache.get(hash);
    if (path && isMuted(hash, path, resolveRules(config, page.repo))) return false;
  }
  return !isViewed(el, hash);
}

function step(dir: 1 | -1, from = currentHash()): void {
  const order = navOrder;
  const idx = from ? order.indexOf(from) : -1;
  const next = nextFile(idx, order.length, (i) => !needsAttention(order[i]), dir);
  if (next === -1) {
    toast(dir === 1 ? "All files reviewed" : "This is the first file to review");
    return;
  }
  jumpTo(order[next], true);
}

let toastEl: HTMLElement | null = null;
function toast(text: string): void {
  toastEl ??= Object.assign(document.createElement("div"), { className: "diffmute-toast" });
  toastEl.textContent = text;
  document.body.append(toastEl);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl?.remove(), 2000);
}

const KEYS: [string, string][] = [
  ["]", "Next file to review"],
  ["[", "Previous file to review"],
  ["v", "Mark viewed and go to next"],
  ["x", "Collapse or expand current file"],
  ["h", "Show or hide this help"],
];

let helpEl: HTMLElement | null = null;
function toggleHelp(force?: boolean): void {
  const open = force ?? !helpEl?.isConnected;
  if (!open) {
    helpEl?.remove();
    return;
  }
  helpEl = document.createElement("div");
  helpEl.className = "diffmute-help";
  helpEl.setAttribute("role", "dialog");
  helpEl.setAttribute("aria-label", "diffmute shortcuts");
  const title = document.createElement("strong");
  title.textContent = "diffmute shortcuts";
  const list = document.createElement("dl");
  for (const [k, label] of KEYS) {
    const dt = document.createElement("dt");
    const kbd = document.createElement("kbd");
    kbd.textContent = k;
    dt.append(kbd);
    const dd = document.createElement("dd");
    dd.textContent = label;
    list.append(dt, dd);
  }
  helpEl.append(title, list);
  helpEl.addEventListener("click", () => toggleHelp(false));
  document.body.append(helpEl);
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

function onKey(e: KeyboardEvent): void {
  if (!page || !config?.features.keys || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
  if (!document.querySelector('[id^="diff-"]')) return;
  const handled = (() => {
    switch (e.key) {
      case "]":
        step(1);
        return true;
      case "[":
        step(-1);
        return true;
      case "v": {
        const hash = currentHash();
        const el = hash ? fileEl(hash) : null;
        if (hash && el) markViewed(el, hash);
        step(1, hash);
        return true;
      }
      case "x": {
        const hash = currentHash();
        const el = hash ? fileEl(hash) : null;
        if (el) {
          setCollapsed(el, isExpanded(el));
          highlight(el);
        }
        return true;
      }
      case "h":
        toggleHelp();
        return true;
      case "Escape":
        if (helpEl?.isConnected) {
          toggleHelp(false);
          return true;
        }
        return false;
      default:
        return false;
    }
  })();
  if (handled) {
    // Keep GitHub's own handlers from acting on the same key.
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

// ---- scan ----

function teardown(): void {
  void flushSave();
  bar?.remove();
  barSignature = "";
  page = null;
  seen.clear();
  tags.clear();
  files = [];
  ordered = [];
  navOrder = [];
  for (const b of document.querySelectorAll(".diffmute-badge")) b.remove();
  markTree("diffmute-tree-fresh", []);
}

async function enterPr(p: Page): Promise<void> {
  if (saveTimer) await flushSave();
  const state = await loadPrState(p.prKey);
  shown = new Set(state.shown);
  baseline = { ...state.read };
  read = { ...state.read };
  viewedLocal = new Set(state.viewed);
  tags.clear();
  factsCache.clear();
  fingerprints.clear();
  pins = [];
  if (config?.features.order) {
    void fetchPins(p).then((found) => {
      if (page?.prKey !== p.prKey || !found.length) return;
      pins = found;
      barSignature = "";
      queueScan(0);
    });
  }
}

async function scan(): Promise<void> {
  if (scanning) {
    rescan = true;
    return;
  }
  scanning = true;
  try {
    const p = parsePage();
    if (!p) return teardown();
    config ??= await loadConfig();
    if (!page || page.prKey !== p.prKey) await enterPr(p);
    if (!page || page.path !== p.path) {
      // A commit page shows different content for the same paths.
      seen.clear();
      tags.clear();
      factsCache.clear();
      fingerprints.clear();
      barSignature = "";
    }
    page = p;

    const rules = resolveRules(config, p.repo);
    const repoOff = !!config.repos[p.repo.toLowerCase()]?.off;
    const revisit = revisitActive() && !repoOff;
    if (revisit) rules.categories.push(UNCHANGED);
    const byId = new Map(rules.categories.map((c) => [c.id, c]));
    const fileEls = [...document.querySelectorAll<HTMLElement>('[id^="diff-"]')].filter((e) => FILE_ID.test(e.id));
    for (const el of fileEls) {
      const hash = el.id.slice(5);
      const path = await resolvePath(el, hash);
      if (!path) continue;
      const { facts, fp } = await fileState(el, hash);
      const tag = p.whole ? tagFile(baseline, hash, fp) : null;
      if (tag) tags.set(hash, tag);
      else tags.delete(hash);
      const cat = classify(path, rules, revisit ? { ...facts, unchanged: tag === "unchanged" } : facts);
      seen.set(hash, cat?.id ?? null);
      applyFile(el, cat);
      applyBadge(el, revisit ? (tag ?? undefined) : undefined);
      if (!observed.has(el)) {
        observed.add(el);
        readObserver.observe(el);
      }
    }

    const hidden = [...seen]
      .filter(([, id]) => id && byId.get(id)?.mode === "hide" && !shown.has(id))
      .map(([hash]) => hash);
    markTree("diffmute-tree-hidden", hidden);
    markTree("diffmute-tree-fresh", revisit ? [...tags].filter(([, t]) => t !== "unchanged").map(([h]) => h) : []);
    applyFolders(rules);
    if (!fileEls.length) return;

    files = await collectFiles(fileEls);
    const hashOf = new Map(files.map((f) => [f.path, f.hash]));
    ordered = config.features.order
      ? orderFiles(
          files.map((f) => f.path),
          config.tiers,
          pins,
        )
      : [];
    navOrder = ordered.length ? ordered.map(({ path }) => hashOf.get(path)!) : files.map((f) => f.hash);

    if (repoOff) {
      bar?.remove();
      return;
    }
    renderBar(placeBar(fileEls), rules, seen.size);
  } catch (err) {
    console.error("diffmute:", err);
  } finally {
    scanning = false;
    if (rescan) {
      rescan = false;
      queueScan();
    }
  }
}

function queueScan(delay = 150): void {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, delay);
}

new MutationObserver((mutations) => {
  const ours = (n: Node) =>
    (bar?.contains(n) ?? false) ||
    (n instanceof Element && n.matches(".diffmute-badge, .diffmute-toast, .diffmute-help"));
  if (mutations.every((m) => ours(m.target) || [...m.addedNodes, ...m.removedNodes].every(ours))) return;
  queueScan();
}).observe(document.documentElement, { childList: true, subtree: true });

for (const evt of ["turbo:load", "popstate", "pageshow"]) {
  window.addEventListener(evt, () => queueScan(0));
  document.addEventListener(evt, () => queueScan(0));
}

window.addEventListener("keydown", onKey, true);
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);
const forgetJump = () => {
  lastJump = null;
};
window.addEventListener("wheel", forgetJump, { passive: true });
window.addEventListener("touchmove", forgetJump, { passive: true });
window.addEventListener("keydown", (e) => {
  if (SCROLL_KEYS.has(e.key) && !isEditable(e.target)) forgetJump();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && saveTimer) void flushSave();
});
window.addEventListener("pagehide", () => {
  if (saveTimer) void flushSave();
});

// Viewed checkboxes count as reading the file.
document.addEventListener(
  "change",
  (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.matches?.('input.js-reviewed-checkbox, input[name="viewed"]') || !input.checked) return;
    const el = input.closest<HTMLElement>('[id^="diff-"]');
    if (el && FILE_ID.test(el.id)) markRead(el.id.slice(5));
  },
  true,
);

onConfigChange(() => {
  config = null;
  seen.clear();
  barSignature = "";
  queueScan(0);
});

void loadOutlineOpen().then((open) => {
  outlineOpen = open;
});

queueScan(0);
