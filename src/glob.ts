// Minimal glob matcher, gitignore flavoured:
// - a pattern without "/" matches the basename at any depth ("yarn.lock")
// - a leading "/" anchors to the repo root ("/dist/**")
// - "**/" matches zero or more directories, "*" and "?" never cross "/"
// - "{a,b}" alternation and "[abc]" / "[!abc]" classes are supported

const cache = new Map<string, RegExp>();

function escape(c: string): string {
  return /[\\^$.+()|{}[\]*?]/.test(c) ? "\\" + c : c;
}

export function globToRegExp(glob: string): RegExp {
  let g = glob.trim();
  if (g.startsWith("/")) g = g.slice(1);
  else if (!g.includes("/")) g = "**/" + g;
  if (g.endsWith("/")) g += "**";

  let re = "";
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const atStart = i === 0 || g[i - 1] === "/";
        const next = g[i + 2];
        if (atStart && next === "/") {
          re += "(?:.*/)?";
          i += 2;
          continue;
        }
        if (atStart && next === undefined) {
          re += ".*";
          i += 1;
          continue;
        }
        i += 1;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = g.indexOf("]", i + 2);
      if (end === -1) {
        re += "\\[";
        continue;
      }
      let body = g.slice(i + 1, end).replace(/\\/g, "\\\\");
      if (body[0] === "!") body = "^" + body.slice(1);
      re += "[" + body + "]";
      i = end;
    } else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) {
      re += "|";
    } else {
      re += escape(c);
    }
  }
  return new RegExp("^" + re + "$");
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

export function matches(path: string, glob: string): boolean {
  return compile(glob).test(path.replace(/^\/+/, ""));
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => g.trim() && matches(path, g));
}
