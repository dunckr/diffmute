// Text for the bar: "Collapsed 3 lockfiles, 12 tests · Hidden 2 snapshots".
import type { Category } from './rules.ts';

export function summaryText(
  cats: readonly Pick<Category, 'id' | 'mode' | 'name'>[],
  counts: ReadonlyMap<string, number>,
  shown: ReadonlySet<string>,
  total: number
): string {
  const parts: Record<Category['mode'], string[]> = { collapse: [], hide: [] };
  const present = cats.filter((c) => counts.get(c.id));
  for (const c of present)
    if (!shown.has(c.id)) parts[c.mode].push(plural(counts.get(c.id)!, c.name));
  return (
    [
      parts.collapse.length > 0 ? `Collapsed ${parts.collapse.join(', ')}` : '',
      parts.hide.length > 0 ? `Hidden ${parts.hide.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' · ') ||
    (present.length > 0
      ? 'Showing all files'
      : `No noise in ${plural(total, 'files')}`)
  );
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word.replace(/s$/, '') : word}`;
}
