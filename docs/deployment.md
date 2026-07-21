# Deployment — mamehistory.com on GitHub Pages

Live site: **https://mamehistory.com** (GitHub Pages, `gh-pages` branch,
custom domain). The github.io URL redirects there. Shipped 2026-07-06
(issue #4, PR #7).

## One command

```sh
npm run deploy -- --artwork     # the normal ship command
```

The script (`scripts/deploy-pages.sh`):

1. `npm run gen:all` — regenerates all six games + the unified app.
2. Copies `artwork/` into `dist/artwork/` **only with `--artwork`**
   (minus `data/` — the 61 MB Gaming History dat is dev-time only; its text
   is already extracted to `dist/games/<category>/<game>/history.txt`). Without the flag the
   site ships without artwork and every image degrades gracefully.
3. Rewrites `dist/games.json`: `hasRom` always false (visitors bring their
   own zip via the drop zone), `hasArt` matches what shipped.
4. Writes `dist/.nojekyll` and `dist/CNAME` (default domain
   `mamehistory.com`; override `PAGES_DOMAIN=other.tld`, disable with
   `PAGES_DOMAIN=`). **The CNAME file must be owned here** — the deploy is a
   history-free force-push, which would otherwise wipe the CNAME GitHub
   writes and silently detach the domain.
5. Creates an ephemeral git repo inside `dist/`, commits everything as one
   snapshot, force-pushes to `origin gh-pages`, deletes `dist/.git`.

**ROMs are never published.** `dist/` contains none by design; the in-app
drop zone loads the visitor's own zip and validates it chip-by-chip against
the knowledge-graph manifest before booting.

Deploys are **manual by design**: the build needs the local MAME checkout,
the gitignored `artwork/` tree and the history dat — none exist in CI.

## Why the app is base-path agnostic

GitHub Pages serves project sites under `/<repo>/`, the custom domain at
`/`. Every URL in the app (games.json, configs, history, artwork, ROM zips,
viewer/dossier links, the root redirect) is therefore **relative to the
`/app/` page** (`../games.json`, `../roms/<g>.zip`, …). The dev server
301-redirects bare directory paths (`/app` → `/app/`) to match Pages, so
relative resolution is identical in both environments. Never reintroduce a
leading `/` in a runtime fetch or generated URL.

## Pretty routes

`https://mamehistory.com/app/g/<game>/` — static hosts have no rewrites, so
`buildApp()` emits a **real** `app/g/<game>/index.html` per generated game.
Each contains `<base href="../../">`, which makes every relative URL (and
`location.href` assignments like Esc-to-menu) resolve exactly as on
`/app/`. `main.ts` reads the game from the path (`/g/<game>/`) or the
legacy `?g=` param — both work.

## Caching

- Pages CDN caches everything with `max-age=600` — changes take up to
  10 minutes for returning visitors; **hard-reload when verifying a deploy**.
- `buildApp()` stamps the module URL (`main.js?v=<build-stamp>`) so each
  deploy busts the HTML→bundle edge; submodules still ride the 10-minute
  window.
- Pages builds take a few minutes with the 74 MB artwork tree. Check
  `gh api repos/benbruscella/mamekit/pages/builds/latest`. A superseded
  build can show as `errored` — only the latest matters.

## HTTPS (and why sound depends on it)

**AudioWorklet requires a secure context** — on plain http every sound core
is silent (localhost is exempt, which is why it "works locally"). Two
layers of enforcement:

1. GitHub-level `https_enforced` (301 http→https). Needs the Let's Encrypt
   cert, which auto-provisions after the custom domain's DNS resolves —
   took ~30 min; if it stalls on `state: none`, remove and re-add the
   domain (`gh api repos/.../pages -X PUT -f cname=…`).
2. A client-side redirect in `main.ts` (http → https on any non-local
   hostname) as belt-and-braces.

## DNS (DreamHost)

Domain registered at DreamHost, "DNS Only" hosting, DreamHost nameservers.
Records: four apex `A` → `185.199.108.153`/`109`/`110`/`111`, `www` CNAME →
`benbruscella.github.io.`. DreamHost takes ~5-15 min to publish panel edits
to its nameservers (verify with `dig @ns1.dreamhost.com mamehistory.com`).

## Content licensing status (deployment-relevant)

- **Gaming History story texts**: shipped with visible attribution per
  their terms; clear commercial use with arcade-history.com (Alexis
  Bousiges) directly.
- **Artwork** (flyers/marquees/cabinets/bezels): scans via Mr. Do's
  (mrdo.mameworld.info — MAMEWorld hosting, which the user founded) and
  Arcade Database (arcadeitalia.net). Shipped at the user's explicit
  decision ("risk it"); underlying art copyright rests with the original
  publishers.
- **ROMs**: never shipped, full stop.
