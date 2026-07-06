#!/usr/bin/env bash
# Publish dist/ to the gh-pages branch as a single history-free commit.
#
#   npm run deploy              # site without artwork (safe default)
#   npm run deploy -- --artwork # include artwork/ (copyrighted scans — your call)
#
# ROMs are NEVER published: dist/ contains none, and visitors load their own
# zip through the in-app drop zone (validated against the chip manifest).
set -euo pipefail
cd "$(dirname "$0")/.."

ART="${1:-}"

npm run gen:all

# artwork is copyrighted (same treatment as roms/) — opt-in only
rm -rf dist/artwork
if [[ "$ART" == "--artwork" ]]; then
  mkdir -p dist/artwork
  # everything the app fetches at runtime; data/ (61 MB history dat) is
  # dev-time only — its text is already extracted to dist/<game>/history.txt
  rsync -a --exclude 'data' --exclude '.DS_Store' artwork/ dist/artwork/
fi

# visitors have no server-side roms; artwork flags match what we shipped
ART="$ART" node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const games = JSON.parse(readFileSync("dist/games.json", "utf8"));
  for (const g of games) {
    g.hasRom = false;
    if (process.env.ART !== "--artwork") g.hasArt = false;
  }
  writeFileSync("dist/games.json", JSON.stringify(games));
'

touch dist/.nojekyll

URL="$(git remote get-url origin)"
trap 'rm -rf dist/.git' EXIT
rm -rf dist/.git
git -C dist init -q -b gh-pages
git -C dist add -A
git -C dist commit -qm "deploy"
git -C dist push -f "$URL" gh-pages
echo "pushed gh-pages — site: https://benbruscella.github.io/mame2js/"
