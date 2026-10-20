// Bundles src/ and copies static/ into an unpacked extension.
//   node scripts/build.mjs           Firefox build in dist/
//   node scripts/build.mjs --chrome  Chrome build in dist-chrome/
//   node scripts/build.mjs --run     Firefox build, watch, and launch Firefox via web-ext
//   node scripts/build.mjs --stamp   Firefox build with a unique version for signing
// The version comes from package.json; static/manifest.json has none.
import * as esbuild from 'esbuild';
import { watch } from 'node:fs';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';

const run = process.argv.includes('--run');
const stamp = process.argv.includes('--stamp');
const chrome = process.argv.includes('--chrome');
const outdir = chrome ? 'dist-chrome' : 'dist';

const options = {
  // Chrome exposes the same promise-based API as `chrome`.
  banner: chrome
    ? { js: 'globalThis.browser ??= globalThis.chrome;' }
    : undefined,
  bundle: true,
  entryPoints: ['src/content.ts', 'src/background.ts', 'src/options.ts'],
  format: 'iife',
  logLevel: 'info',
  outdir,
  target: chrome ? 'chrome120' : 'firefox121',
};

async function copyStatic() {
  await cp('static', outdir, { recursive: true });
  await writeManifest();
}

async function writeManifest() {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const path = `${outdir}/manifest.json`;
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  // AMO rejects a version it has already signed, so signed builds get a
  // fourth component: minutes since the epoch, which always increases.
  manifest.version = stamp
    ? `${version}.${Math.floor(Date.now() / 60_000)}`
    : version;
  if (chrome) {
    delete manifest.browser_specific_settings;
    manifest.background = { service_worker: 'background.js' };
  }
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
  if (stamp) console.log(`  version ${manifest.version}`);
}

await rm(outdir, { force: true, recursive: true });

if (run) {
  const context = await esbuild.context(options);
  await context.rebuild();
  await copyStatic();
  await context.watch();
  watch('static', { recursive: true }, () => copyStatic().catch(console.error));

  const { default: webExtension } = await import('web-ext');
  await webExtension.cmd.run(
    {
      firefoxProfile: '.firefox-profile',
      keepProfileChanges: true,
      profileCreateIfMissing: true,
      sourceDir: outdir,
      startUrl: ['https://github.com/vitejs/vite/pull/23826/files'],
    },
    { shouldExitProgram: true }
  );
} else {
  await esbuild.build(options);
  await copyStatic();
}
