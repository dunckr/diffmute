// Copies the newest signed build into every Firefox profile.
//   node scripts/install-profiles.mjs [path/to/diffmute.xpi]
// Firefox keeps an installed extension at <profile>/extensions/<id>.xpi, so
// replacing that file updates it the next time the profile starts. A profile
// that never had diffmute asks you to enable it on its next start.
// Quit Firefox first: a running profile only picks up the file on restart.
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';

const manifest = JSON.parse(await readFile('static/manifest.json', 'utf8'));
const id = manifest.browser_specific_settings.gecko.id;

const firefoxDirectory =
  platform() === 'darwin'
    ? path.join(homedir(), 'Library/Application Support/Firefox')
    : path.join(homedir(), '.mozilla/firefox');

async function newestXpi() {
  const dir = 'web-ext-artifacts';
  const all = await readdir(dir);
  const names = all.filter((n) => n.endsWith('.xpi'));
  if (names.length === 0) {
    throw new Error(`No signed .xpi in ${dir}/. Run "npm run sign" first.`);
  }
  const withTimes = await Promise.all(
    names.map(async (n) => {
      const file = path.join(dir, n);
      const info = await stat(file);
      return { file, time: info.mtimeMs };
    })
  );
  return withTimes.sort((a, b) => b.time - a.time)[0].file;
}

// Each [ProfileN] section in profiles.ini has a Name, a Path and whether
// that path is relative to the Firefox folder.
function profiles(ini) {
  const out = [];
  let current = null;
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      current = /^\[Profile\d+\]$/.test(line) ? {} : null;
      if (current) out.push(current);
    } else if (current && line.includes('=')) {
      const at = line.indexOf('=');
      current[line.slice(0, at)] = line.slice(at + 1);
    }
  }
  return out
    .filter((p) => p.Path)
    .map((p) => ({
      dir:
        p.IsRelative === '1' || !path.isAbsolute(p.Path)
          ? path.join(firefoxDirectory, p.Path)
          : p.Path,
      name: p.Name ?? p.Path,
    }));
}

const xpi = process.argv[2] ?? (await newestXpi());
const ini = await readFile(path.join(firefoxDirectory, 'profiles.ini'), 'utf8');
const found = profiles(ini);
if (found.length === 0) throw new Error('No profiles in profiles.ini.');

console.log(`Installing ${xpi}`);
for (const p of found) {
  const target = path.join(p.dir, 'extensions', `${id}.xpi`);
  await mkdir(path.join(p.dir, 'extensions'), { recursive: true });
  await copyFile(xpi, target);
  console.log(`  ${p.name}: ${target}`);
}
console.log('Restart Firefox to load it in each profile.');
