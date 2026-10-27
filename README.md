# diffmute

A Firefox extension that collapses noisy files in GitHub pull request diffs.

![diffmute on a React pull request: the three test files at the top of the diff load collapsed and their sidebar folder is closed. One test is opened and closed with its chevron, the "tests" chip shows all of them and hides them again, and the reading order lists the files](docs/demo.gif)

Lockfiles, tests, snapshots, generated code, deleted files, renames without changes and whitespace-only changes are collapsed as the diff loads. A bar at the top of the diff lists what was collapsed ("Collapsed 8 tests"), with a chip for each category. Click a chip to show that category again. The choice is saved for each PR.

## Features

- **Muted categories.** Files are sorted into categories by path (lockfiles, snapshots, tests, generated) or by what changed (deleted, renamed without changes, whitespace only). Each category can collapse its files, hide them, or be turned off.
- **File tree folders.** Folders in the sidebar whose files are all muted, like `__tests__/`, are closed. They open again when you show their files.
- **Mute from the diff.** Hover a file header and click "mute…" to add that file, its extension or its folder to a category, or to add it to the repo's never-mute list.
- **Reading order.** The "Reading order" outline in the bar groups files into types and schema, logic, UI, tests, and config and docs. Click a file to jump to it. A PR author can pin files to the top by adding a "Review order" heading to the description, followed by a list of paths, folders or globs.
- **Changes since last visit.** A file counts as read once it has been open on screen for a second, or marked viewed. When you come back to a PR, files that haven't changed since you read them are collapsed as "unchanged". New and changed files get a badge, and a "new since last visit" chip jumps to the first one.
- **Keyboard.** `]` and `[` go to the next or previous file that still needs review. `v` marks the current file viewed and moves on. `x` collapses or expands the current file. `h` shows the shortcuts.

You can turn off reading order, changes since last visit and keyboard shortcuts in the options page.

## Install

Release Firefox only installs signed extensions. Signing is free and unlisted, so the extension isn't published on addons.mozilla.org:

1. Create API credentials at https://addons.mozilla.org/developers/addon/api/key/
2. Copy `.env.example` to `.env` and fill them in.
3. Run `npm install`, then `npm run install:firefox`. It signs the build and opens the `.xpi` in Firefox, which asks you to install it.

Each signed build gets a new fourth version number, so Firefox installs every run as an update.

To try it without signing, run `npm run build`, open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on" and pick `dist/manifest.json`. It stays loaded until Firefox restarts.

### Chrome

Run `npm run build:chrome`, open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `dist-chrome/`.

## Rules

Click "rules" in the bar to open the options page at the current repo's settings. You can export and import the whole config as JSON.

Each category is a list of patterns:

- A pattern without `/` matches the file name in any folder (`yarn.lock`).
- `**/` matches any number of folders. `*` and `?` match within one folder.
- A leading `/` anchors the pattern to the repo root (`/test/**`).
- `{a,b}`, `[abc]` and `[!abc]` work.
- A line starting with `!` excludes paths that an earlier line matched, so the last matching line wins (`**/test/**`, then `!**/test/helpers/**`). Lines starting with `#` are comments.
- A file goes into the first category that matches it, so put narrower categories first.

The `docs` and `translations` categories are off by default. If you saved a config with an older version, click "Reset to defaults" to get new default patterns.

A global never-mute list applies to every repo. Each repo (`owner/repo`) can also have its own settings: turn the extension off, change a category's mode or turn it off, or list paths that should never be muted.

## How it works

- It runs on PR files and commits pages, single commits and compare views. The content script is loaded on all of `github.com` because GitHub switches between PR tabs without a full page load.
- GitHub gives each file in the diff the id `diff-<sha256(path)>`, so files are tracked by that hash. Class names aren't used.
- To collapse a file, it clicks GitHub's own toggle, so GitHub knows the file is collapsed and its chevron shows it closed. If GitHub hasn't loaded its script yet, the file is hidden with a class and its chevron turned, and the toggle is clicked again on the next change to the page. Hiding sets `display: none` on the file and its file tree entry.
- A `MutationObserver` handles diffs that load late and navigation between pages.
- The bar's counts include files whose diffs haven't loaded yet, matched by path from the file tree.
- If you expand a muted file with its chevron, it stays expanded, even when GitHub unloads and reloads it as you scroll.
- Whitespace-only changes can only be detected once a diff loads, so a large file behind "Load diff" isn't sorted until you load it.

Config is saved in `storage.sync`, with one key per category to stay under the 8 KB limit for each item. Per-PR state (shown categories, read files, local viewed marks) is saved in `storage.local` for the 300 most recent PRs.

## Development

The TypeScript source is in `src/`, and the manifest, HTML and CSS are in `static/`. esbuild bundles both into `dist/`, which is what Firefox loads.

```bash
npm install
npm start              # build, watch, and open Firefox with the extension loaded
npm test               # vitest
npm run typecheck
npm run lint           # eslint
npm run format         # prettier
npm run dead-code      # fallow: unused files, exports and dependencies
npm run lint:ext       # build, then web-ext lint
npm run build:chrome   # Chrome build in dist-chrome/
npm run package        # zip in web-ext-artifacts/
```

`npm start` uses its own Firefox profile in `.firefox-profile/`, so you stay signed in to GitHub between runs. Changes to `src/` or `static/` rebuild and reload the extension.

Firefox and Chrome run the same code. In Chrome, the `chrome` API is used as `browser`, and the manifest uses a service worker instead of a background script.

CI checks formatting, lint, types, tests, dead code, web-ext lint and the Chrome build on pushes to main and on pull requests. It uses Node 24 (`.node-version`). The version number is only in `package.json`, and the build copies it into the manifest.
