import { classify, resolveRules, type Category, type Config, type Rules } from "./rules.ts";
import { loadConfig, loadShown, onConfigChange, saveShown } from "./storage.ts";

type Applied = "collapse" | "hide" | "none";

interface Page {
  repo: string;
  prKey: string;
  path: string;
}

// GitHub gives every file container id="diff-<sha256(path)>" in both the
// classic and the React diff views, so the hash is our stable file key.
const FILE_ID = /^diff-([0-9a-f]{64})$/;
const PAGE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes|commits\/[0-9a-f]+)/;

let config: Config | null = null;
let page: Page | null = null;
let shown = new Set<string>(); // category ids revealed on this PR
const seen = new Map<string, string | null>(); // hash -> category id, survives virtualised unmounts
const pathCache = new Map<string, string>(); // hash -> path
let bar: HTMLElement | null = null;
let barSignature = "";
let scanTimer: ReturnType<typeof setTimeout> | undefined;
let scanning = false;
let rescan = false;

function parsePage(): Page | null {
  const m = location.pathname.match(PAGE);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  return { repo, prKey: `${repo}#${m[3]}`.toLowerCase(), path: location.pathname };
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

function toggleButton(el: Element): HTMLButtonElement | null {
  const buttons = el.querySelectorAll<HTMLButtonElement>("button[aria-expanded]");
  return (
    [...buttons].find((b) =>
      /toggle diff|collapse file|expand file|^(collapse|expand)\b/i.test(b.getAttribute("aria-label") ?? "")
    ) ?? null
  );
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

function applyTree(hiddenHashes: string[]): void {
  const want = new Set<Element>();
  for (const hash of hiddenHashes) for (const n of treeNodes(hash)) want.add(n);
  for (const n of document.querySelectorAll(".diffmute-tree-hidden")) {
    if (!want.has(n)) n.classList.remove("diffmute-tree-hidden");
  }
  for (const n of want) n.classList.add("diffmute-tree-hidden");
}

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
  await saveShown(page.prKey, [...shown]);
  barSignature = "";
  queueScan(0);
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word.replace(/s$/, "") : word}`;
}

function button(label: string, action: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "diffmute-link";
  b.dataset.action = action;
  b.textContent = label;
  return b;
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

  const signature = JSON.stringify([summary, cats.map((c) => [c.id, counts.get(c.id), shown.has(c.id)])]);
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
  for (const c of cats) {
    const muted = !shown.has(c.id);
    const b = button(`${c.name} ${counts.get(c.id)}`, "toggle");
    b.dataset.category = c.id;
    b.className = "diffmute-chip";
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
}

function teardown(): void {
  bar?.remove();
  barSignature = "";
  page = null;
  seen.clear();
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
    if (!page || page.prKey !== p.prKey) {
      shown = new Set(await loadShown(p.prKey));
    }
    if (!page || page.path !== p.path) {
      seen.clear();
      barSignature = "";
    }
    page = p;
    config ??= await loadConfig();

    const rules = resolveRules(config, p.repo);
    const byId = new Map(rules.categories.map((c) => [c.id, c]));
    const fileEls = [...document.querySelectorAll<HTMLElement>('[id^="diff-"]')].filter((e) => FILE_ID.test(e.id));
    if (!fileEls.length) return;

    for (const el of fileEls) {
      const hash = el.id.slice(5);
      const path = await resolvePath(el, hash);
      if (!path) continue;
      const cat = classify(path, rules);
      seen.set(hash, cat?.id ?? null);
      applyFile(el, cat);
    }

    const hidden = [...seen]
      .filter(([, id]) => id && byId.get(id)?.mode === "hide" && !shown.has(id))
      .map(([hash]) => hash);
    applyTree(hidden);

    if (config.repos[p.repo.toLowerCase()]?.off) {
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
  if (bar && mutations.every((m) => bar!.contains(m.target))) return;
  queueScan();
}).observe(document.documentElement, { childList: true, subtree: true });

for (const evt of ["turbo:load", "popstate", "pageshow"]) {
  window.addEventListener(evt, () => queueScan(0));
  document.addEventListener(evt, () => queueScan(0));
}

onConfigChange(() => {
  config = null;
  seen.clear();
  barSignature = "";
  queueScan(0);
});

queueScan(0);
