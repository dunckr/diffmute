// Reading styles for markdown files in the source diff. Rich diff can't take
// line comments, so the diff stays as it is: each code cell gets a
// data-md attribute naming the kind of line, CSS styles it from there, and
// bold text is marked with the CSS Highlight API so GitHub's DOM is never
// rewritten.

export type LineKind =
  | 'blank'
  | 'code'
  | 'fence'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'list'
  | 'prose'
  | 'quote'
  | 'rule'
  | 'table';

const MD_PATH = /\.(md|mdx|markdown)$/i;
const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s/;
// Classic diff view cells first, then the React view's. The React view's
// class names are hashed, so it is matched on its data attributes.
const CODE_CELL =
  'td.blob-code:not(.blob-code-hunk), td[data-diff-cell="text"]';
const HUNK_CELL = 'td.blob-code-hunk, td[data-diff-cell="hunk"]';
const INNER = '.blob-code-inner, [data-diff-text-inner]';
const STRONG = 'diffmute-md-strong';
const LINK = 'diffmute-md-link';
const UNTAGGED = ':is(.pl-s, .pl-v, .pl-corl):not([data-md-mark])';
// data-md is only ever set on code cells, so it is enough to find them.
const PROSE_CELL = 'td[data-md]:not([data-md="code"], [data-md="fence"])';

interface Marked {
  link: Range[];
  strong: Range[];
}

export function isMarkdownPath(path: string): boolean {
  return MD_PATH.test(path);
}

// Kinds for consecutive lines of one side of a hunk. A fence opened before
// the hunk starts can't be seen, so those lines read as prose.
export function lineKinds(lines: string[]): LineKind[] {
  let fence: null | string = null;
  return lines.map((line) => {
    const f = FENCE.exec(line);
    if (fence) {
      if (f?.[1] !== fence) return 'code';
      fence = null;
      return 'fence';
    }
    if (f) {
      fence = f[1];
      return 'fence';
    }
    if (!line.trim()) return 'blank';
    const h = HEADING.exec(line);
    if (h) return `h${Math.min(h[1].length, 4)}` as LineKind;
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return 'rule';
    if (/^\s*>/.test(line)) return 'quote';
    if (/^\s*\|/.test(line)) return 'table';
    if (/^\s*([-*+]|\d+[.)])\s/.test(line)) return 'list';
    if (/^( {4}|\t)/.test(line)) return 'code';
    return 'prose';
  });
}

const marked = new Map<HTMLElement, Marked>();

export function applyMarkdown(element: HTMLElement, path: string): void {
  if (!isMarkdownPath(path)) return;
  // The scan runs on every page change, so skip files already done. Rows
  // can be added or re-created as the diff loads and scrolls, and GitHub
  // can swap in the syntax spans after a row renders, so a cell or span
  // without a tag means the file needs marking again.
  const rowsDone =
    !!element.dataset.diffmuteMd &&
    !element.querySelector(`:is(${CODE_CELL}):not([data-md])`);
  if (rowsDone) {
    if (element.querySelector(`${PROSE_CELL} ${UNTAGGED}`)) {
      marked.set(element, markSyntax(element));
      paintHighlights();
    }
    return;
  }
  element.dataset.diffmuteMd = isNewFile(element) ? 'new' : 'changed';

  // Split view puts old and new lines side by side, so each column is
  // its own run of lines. A hunk header starts new runs.
  let columns: HTMLElement[][] = [];
  const runs: HTMLElement[][] = [];
  for (const row of element.querySelectorAll('tr')) {
    if (row.querySelector(HUNK_CELL)) {
      runs.push(...columns);
      columns = [];
      continue;
    }
    const code = [...row.querySelectorAll<HTMLElement>(CODE_CELL)];
    for (const [index, cell] of code.entries())
      (columns[index] ??= []).push(cell);
  }
  runs.push(...columns);

  for (const run of runs) {
    const kinds = lineKinds(run.map((cell) => lineText(cell)));
    for (const [index, cell] of run.entries()) cell.dataset.md = kinds[index];
  }
  marked.set(element, markSyntax(element));
  paintHighlights();
}

export function clearMarkdown(): void {
  marked.clear();
  if (typeof Highlight !== 'undefined') {
    CSS.highlights?.delete(STRONG);
    CSS.highlights?.delete(LINK);
  }
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-diffmute-md]'
  )) {
    delete element.dataset.diffmuteMd;
  }
}

// Whether a file is new in this PR or had lines before it, or null while
// its diff rows haven't loaded yet.
export function fileKind(element: HTMLElement): 'changed' | 'new' | null {
  if (!element.querySelector(CODE_CELL)) return null;
  return isNewFile(element) ? 'new' : 'changed';
}

// What to do with one of GitHub's syntax token spans in a prose line:
// fade it as markdown syntax, color it as a list bullet, hide it as a link
// URL, or leave it.
export function markerRole(
  cls: string,
  text: string
): 'bullet' | 'syntax' | 'url' | null {
  if (cls === 'pl-v') return /^([-*+]|\d+[.)])$/.test(text) ? 'bullet' : null;
  if (cls === 'pl-corl') return 'url';
  if (cls !== 'pl-s') return null;
  return /^(\*\*|__|\*|_|~~|`+|\[|\]|\(|\))$/.test(text) ? 'syntax' : null;
}

function between(open: Element, close: Element): Range {
  const range = new Range();
  range.setStartAfter(open);
  range.setEndBefore(close);
  return range;
}

function isNewFile(element: HTMLElement): boolean {
  return (
    !!element.querySelector(
      'td.blob-code-addition, [data-diff-type="addition"]'
    ) &&
    // An old-side line number means the file had lines before this PR.
    !element.querySelector(
      'td.blob-code-deletion, td.blob-code-context, td[data-diff-cell="line-number"][data-diff-side="left"]'
    )
  );
}

function lineText(cell: HTMLElement): string {
  return (cell.querySelector(INNER) ?? cell).textContent ?? '';
}

// Tags the syntax spans CSS should hide or restyle, and collects the text
// between ** pairs and inside [link] brackets. GitHub wraps the markers in
// their own spans but not the text between them, so that text is marked
// with the Highlight API instead.
function markSyntax(element: HTMLElement): Marked {
  const out: Marked = { link: [], strong: [] };
  for (const cell of element.querySelectorAll<HTMLElement>(PROSE_CELL)) {
    const spans = [
      ...cell.querySelectorAll<HTMLElement>('.pl-s, .pl-v, .pl-corl'),
    ];
    for (const span of spans) {
      const role = markerRole(span.className, span.textContent ?? '');
      span.dataset.mdMark = role ?? 'plain';
    }
    // The parentheses around a link URL go with it.
    for (const url of cell.querySelectorAll<HTMLElement>('.pl-corl')) {
      for (const side of [url.previousElementSibling, url.nextElementSibling])
        if (
          side instanceof HTMLElement &&
          /^[()]$/.test(side.textContent ?? '')
        )
          side.dataset.mdMark = 'url';
    }
    const bold = spans.filter((s) => /^(\*\*|__)$/.test(s.textContent ?? ''));
    for (let index = 0; index + 1 < bold.length; index += 2)
      out.strong.push(between(bold[index], bold[index + 1]));
    let open: HTMLElement | null = null;
    for (const span of spans) {
      if (span.textContent === '[') open = span;
      else if (span.textContent === ']' && open) {
        out.link.push(between(open, span));
        open = null;
      }
    }
  }
  return out;
}

function paintHighlights(): void {
  if (typeof Highlight === 'undefined' || !CSS.highlights) return;
  for (const element of marked.keys())
    if (!element.isConnected) marked.delete(element);
  const all = [...marked.values()];
  CSS.highlights.set(STRONG, new Highlight(...all.flatMap((m) => m.strong)));
  CSS.highlights.set(LINK, new Highlight(...all.flatMap((m) => m.link)));
}
