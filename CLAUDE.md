# Project guide — Tongari Boushi archive

Astro static site → GitHub Pages. `npm run dev` (preview at `localhost:4321`
under the base path `/tongari-boushi-to-oshare-na-mahou-tsukai-archive`),
`npm run build` → `dist/`. Live at
https://darkenedforest.github.io/tongari-boushi-to-oshare-na-mahou-tsukai-archive

## ⛔ Cache-busting — REQUIRED on every deploy that changes site content

Any push that changes files under `public/` or `src/` (i.e. every real site
change) must bump **one asset cache-buster token** (a Unix-epoch timestamp) in
**TWO places, kept identical**. (A docs-only commit that doesn't alter the built
site — e.g. editing this file — is the one exception.) The two places:

1. **`public/data/version.json`** — the `"version"` string (and `"built"`).
2. **`public/data/manifest.json`** — the `?v=<token>` appended to every
   `png_path` (thousands of entries, all the same value).

Both are normally written together by `scripts/build_site_assets.py`
(`v = str(int(time.time()))`) — running that script bumps both automatically.
For content-only changes (no 2D-asset rebuild), bump both **by hand**:

```bash
cd <repo root>
OLD=$(grep -oE '[0-9]+' public/data/version.json | head -1)
NEW=$(date +%s)
sed -i "s/?v=${OLD}/?v=${NEW}/g" public/data/manifest.json          # place #2
printf '{"version": "%s", "built": %s}\n' "$NEW" "$NEW" > public/data/version.json  # place #1
# verify: one uniform ?v= that matches version.json
grep -oE '\?v=[0-9]+' public/data/manifest.json | sort | uniq -c
cat public/data/version.json
```

Why: `manifest.json` is fetched client-side and its `png_path`s point at the
2D-gallery images; the `?v=` forces browsers past stale cached images/manifest.
`version.json` is the standalone copy of the same token.

Note: the 3D gallery has a **separate** token in `public/data/3d-manifest.json`
(stamped by `scripts/build_3d_assets.py`). It is *not* one of the two routine
places — only touch it when 3D assets actually change.

## Deploy

Push to `main` → `.github/workflows/deploy.yml` runs `npm install` +
`npm run build` and publishes `dist/` to Pages. No manual deploy step.
Commit messages use `step-NNN: <description>` — increment N from the latest
commit.

When a new **patch release** ships (new entry in `public/data/patches.json`),
email the subscriber list after pushing:
`python scripts/send_patch_announcement.py send --dry-run` to preview, then
without `--dry-run`. Needs env vars — see SUPABASE_SETUP.md § "Patch release
email subscriptions". The RSS feed (`/feed.xml`) updates automatically from
patches.json at build time.

## Committing

The ~69k unstaged working-tree deletions that used to live here were restored
on 2026-08-29 (they were accidental; the deployed site always used the
committed tree). The tree is clean now. Still stage specific files explicitly
(`git add public/... src/...`) and confirm with
`git diff --cached --name-status | grep '^D'` that **no deletions are staged**.
Because the tree is dirty, integrating remote changes needs autostash:
`git -c rebase.autoStash=true rebase origin/main`.

## Git account

Personal GitHub account `darkenedforest` (folder-based routing, already
configured on this repo). Do not change it.

## Adding an app to the `/apps` store

Store lives at `src/pages/apps/` (index + `[slug].astro`) driven by
`public/data/apps.json`. To add an app: drop its APK + icon + screenshots under
`public/apps/<slug>/` and append an object to `apps.json` (the store renders any
number of apps). **Screenshots must be user-approved before publishing** — no
personal chat content.
