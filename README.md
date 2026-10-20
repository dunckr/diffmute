# diffmute

A Firefox extension that collapses or hides noisy files on GitHub pull request diffs: lockfiles, tests, snapshots, fixtures and generated code.

A toolbar at the top of the diff shows what was muted ("Collapsed 3 lockfiles, 12 tests") with a toggle per category, so nothing disappears silently. Toggles are remembered per PR.

## How it works

- Runs on `/pull/N/files`, `/pull/N/changes` and `/pull/N/commits/<sha>`. The content script is injected on all of `github.com` because GitHub navigates between PR tabs without a full page load.
- Each file container has `id="diff-<sha256(path)>"`, so files are keyed by that hash and the path is confirmed by hashing candidates from the header. Class names are not used.
- Collapse clicks GitHub's own toggle button so its UI state stays consistent. Hide sets `display: none` on the file and its file tree entry.
- Folders in the file tree whose files are all muted (such as `__tests__/`) are collapsed, and reopen when any of their files is shown again. A folder you open by hand stays open.
- A `MutationObserver` picks up lazily loaded diffs and SPA navigation.

## Rules

Edit rules from the toolbar's "rules" button or the extension's options page.

- A pattern without `/` matches the file name at any depth (`yarn.lock`).
- `**/` matches any number of folders, `*` and `?` stay within one folder.
- A leading `/` anchors to the repo root (`/test/**`).
- `{a,b}` and `[abc]` / `[!abc]` work.
- The first matching category wins, so put narrower categories first.

Per-repo overrides (keyed by `owner/repo`) can turn the extension off for a repo, change a category's mode or turn it off, and list "never mute" globs for paths that are product code in that repo.

Config is stored in `storage.sync`, per-PR toggles in `storage.local`.

## Development

TypeScript in `src/`, static files (manifest, HTML, CSS) in `static/`. esbuild bundles both into `dist/`, which is what Firefox loads.

```bash
npm install
npm start          # build, watch, and open Firefox with the extension loaded
npm test           # glob and rule tests
npm run typecheck
npm run lint       # build, then web-ext lint
npm run package    # zip in web-ext-artifacts/
```

`npm start` uses a dedicated Firefox profile in `.firefox-profile/`, so a GitHub sign-in there persists between runs. Edits to `src/` or `static/` rebuild and reload the extension automatically.

## Installing in your everyday Firefox

Release Firefox only installs signed extensions. Signing is free and unlisted (not published on addons.mozilla.org):

1. Create API credentials at https://addons.mozilla.org/developers/addon/api/key/
2. Put them in `.env` (git-ignored, see `.env.example`)
3. Run `npm run install:firefox`. It signs the build and opens the `.xpi` in Firefox, which prompts to install it.

Each signed upload needs a new `version` in `static/manifest.json`.

For a quick try without signing, open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on" and pick `dist/manifest.json` (run `npm run build` first). It stays until Firefox restarts.
