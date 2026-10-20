// Bundles src/ into dist/ and copies static/ alongside.
//   node scripts/build.mjs          one-off build
//   node scripts/build.mjs --run    build, watch, and launch Firefox via web-ext
//   node scripts/build.mjs --stamp  build with a unique version for signing
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import * as esbuild from "esbuild";

const run = process.argv.includes("--run");
const stamp = process.argv.includes("--stamp");
const outdir = "dist";

const options = {
  entryPoints: ["src/content.ts", "src/background.ts", "src/options.ts"],
  outdir,
  bundle: true,
  format: "iife",
  target: "firefox121",
  logLevel: "info",
};

// AMO rejects a version it has already signed, so signed builds get a fourth
// component: minutes since the epoch, which always increases.
async function stampVersion() {
  const path = `${outdir}/manifest.json`;
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.version = `${manifest.version}.${Math.floor(Date.now() / 60000)}`;
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`  version ${manifest.version}`);
}

const copyStatic = () => cp("static", outdir, { recursive: true });

await rm(outdir, { recursive: true, force: true });

if (!run) {
  await esbuild.build(options);
  await copyStatic();
  if (stamp) await stampVersion();
} else {
  const ctx = await esbuild.context(options);
  await ctx.rebuild();
  await copyStatic();
  await ctx.watch();
  watch("static", { recursive: true }, () => copyStatic().catch(console.error));

  const { default: webExt } = await import("web-ext");
  await webExt.cmd.run(
    {
      sourceDir: outdir,
      firefoxProfile: ".firefox-profile",
      profileCreateIfMissing: true,
      keepProfileChanges: true,
      startUrl: ["https://github.com/vitejs/vite/pull/23826/files"],
    },
    { shouldExitProgram: true },
  );
}
