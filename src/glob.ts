// Minimal glob matcher, gitignore flavoured:
// - a pattern without "/" matches the basename at any depth ("yarn.lock")
// - a leading "/" anchors to the repo root ("/dist/**")
// - "**/" matches zero or more directories, "*" and "?" never cross "/"
// - "{a,b}" alternation and "[abc]" / "[!abc]" classes are supported
// In a list, a line starting with "!" excludes paths an earlier line matched,
// so the last matching line wins, as in .gitignore. Lines starting with "#"
// are comments.

const cache = new Map<string, RegExp>();

export function matches(path: string, glob: string): boolean {
  return compile(glob).test(path.replace(/^\/+/, ''));
}

export function matchesAny(path: string, globs: string[]): boolean {
  let hit = false;
  for (const raw of globs) {
    const g = raw.trim();
    if (!g || g.startsWith('#')) continue;
    if (g.startsWith('!')) {
      if (hit && matches(path, g.slice(1))) hit = false;
    } else if (!hit && matches(path, g)) {
      hit = true;
    }
  }
  return hit;
}

function compile(glob: string): RegExp {
  let re = cache.get(glob);
  if (!re) {
    try {
      re = globToRegExp(glob);
    } catch {
      re = /(?!)/;
    }
    cache.set(glob, re);
  }
  return re;
}

function escape(c: string): string {
  return /[\\^$.+()|{}[\]*?]/.test(c) ? '\\' + c : c;
}

function globToRegExp(glob: string): RegExp {
  let g = glob.trim();
  if (g.startsWith('/')) g = g.slice(1);
  else if (!g.includes('/')) g = '**/' + g;
  if (g.endsWith('/')) g += '**';

  let re = '';
  let braces = 0;
  for (let index = 0; index < g.length; index++) {
    const c = g[index];
    switch (c) {
      case '*': {
        if (g[index + 1] === '*') {
          const atStart = index === 0 || g[index - 1] === '/';
          const next = g[index + 2];
          if (atStart && next === '/') {
            re += '(?:.*/)?';
            index += 2;
            continue;
          }
          if (atStart && next === undefined) {
            re += '.*';
            index += 1;
            continue;
          }
          index += 1;
        }
        re += '[^/]*';

        break;
      }
      case '?': {
        re += '[^/]';

        break;
      }
      case '[': {
        const end = g.indexOf(']', index + 2);
        if (end === -1) {
          re += String.raw`\[`;
          continue;
        }
        let body = g.slice(index + 1, end).replaceAll('\\', '\\\\');
        if (body[0] === '!') body = '^' + body.slice(1);
        re += '[' + body + ']';
        index = end;

        break;
      }
      case '{': {
        braces++;
        re += '(?:';

        break;
      }
      default: {
        if (c === '}' && braces > 0) {
          braces--;
          re += ')';
        } else if (c === ',' && braces > 0) {
          re += '|';
        } else {
          re += escape(c);
        }
      }
    }
  }
  return new RegExp('^' + re + '$');
}
