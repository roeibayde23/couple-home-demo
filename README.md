# CASA · couple-home-demo

Static Hebrew RTL PWA demo hosted on GitHub Pages:
https://roeibayde23.github.io/couple-home-demo/

## Source of truth

Edit the local prototype at `/workspace/couple-home-prototype/` (not this folder first).
That folder is the working source; this repo is the published static snapshot.

## How to sync / deploy

1. Copy runtime files from the prototype into this checkout:
   - `app.js`, `style.css`, `index.html`
   - `fonts/` (runtime fonts only), `assets/`, `vendor/`
   - Do **not** copy `backups/`, `shots/`, `design/`, `node_modules/`, tests, or server scratch.
2. Bump the cache-bust query string on `style.css`, `app.js`, and `vendor/qrcode.min.js` in `index.html` (e.g. `?v=<epoch>`).
3. Commit as `roeibayde23` / `roeibayde23@users.noreply.github.com` and push to `main`.
4. Wait for GitHub Pages, then hard-refresh the live URL.

Prototype `.gitignore` excludes `backups/`, `shots/`, and `node_modules/` so future syncs stay clean.
