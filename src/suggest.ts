// Patterns offered by the per-file "mute" menu, narrowest first.

export interface Suggestion {
  label: string;
  pattern: string;
}

const GENERIC_DIRS = new Set([
  'app',
  'cmd',
  'internal',
  'lib',
  'packages',
  'pkg',
  'source',
  'src',
]);

export function suggestPatterns(path: string): Suggestion[] {
  const parts = path.split('/');
  const name = parts.pop()!;
  const out: Suggestion[] = [{ label: `files named ${name}`, pattern: name }];

  const dot = name.indexOf('.', 1);
  if (dot > 0) {
    // "app.test.ts" -> "**/*.test.ts", "data.json" -> "**/*.json"
    const extension = name.slice(dot);
    out.push({ label: `all *${extension} files`, pattern: `**/*${extension}` });
    const last = name.slice(name.lastIndexOf('.'));
    if (last !== extension)
      out.push({ label: `all *${last} files`, pattern: `**/*${last}` });
  }

  // Nearest folder that says something about the file (skip src/, lib/...).
  for (let index = parts.length - 1; index >= 0; index--) {
    if (GENERIC_DIRS.has(parts[index])) continue;
    out.push({
      label: `anything in a ${parts[index]}/ folder`,
      pattern: `**/${parts[index]}/**`,
    });
    break;
  }
  if (parts.length > 0)
    out.push({
      label: `everything in /${parts.join('/')}/`,
      pattern: `/${parts.join('/')}/**`,
    });
  return out;
}
