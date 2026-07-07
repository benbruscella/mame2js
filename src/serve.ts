// Tiny zero-dependency static file server for out/ (unified app + per-game
// data) and roms/. Also serves /games.json — a live manifest of every
// generated game, for the boot menu.
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
  '.cypher': 'text/plain; charset=utf-8',
};

/** Scan dist/ for generated games (meta.json + config.json) and flag artwork
 *  availability. ROMs are deliberately NOT scanned: the app never reads ROMs
 *  from the server — the visitor's browser store is the only source.
 *
 *  `supported` = the COMPILED app really contains this game's board module
 *  (dist/app/dist/runtime/boards/<family>.js). A game generated before its
 *  cores compile must show as "in development", not crash at Play — a stale
 *  bundle plus a fresh manifest burned us on junofrst. */
export async function gamesManifest(outRoot: string, artDir: string): Promise<string> {
  const games: unknown[] = [];
  for (const entry of await readdir(outRoot).catch(() => [] as string[])) {
    try {
      const meta = JSON.parse(await readFile(join(outRoot, entry, 'meta.json'), 'utf8'));
      await stat(join(outRoot, entry, 'config.json'));
      meta.hasArt = await stat(join(artDir, `${entry}.zip`)).then(() => true, () => false);
      meta.supported = await stat(join(outRoot, 'app/dist/runtime/boards', `${meta.family}.js`))
        .then(() => true, () => false);
      games.push(meta);
    } catch { /* not a generated game dir */ }
  }
  return JSON.stringify(games);
}

export function serve(rootDirs: Record<string, string>, port: number): Promise<number> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
      if (path.includes('..')) { res.writeHead(403).end(); return; }
      if (path === 'games.json') {
        res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
        res.end(await gamesManifest(rootDirs[''], rootDirs['artwork'] ?? ''));
        return;
      }
      // route by first segment if it names a mount, else default mount ''
      const [head, ...rest] = path.split('/');
      let root = rootDirs[''];
      if (head in rootDirs) { root = rootDirs[head]; path = rest.join('/'); }
      if (!path) path = 'index.html';
      let file = join(root, path);
      const s = await stat(file).catch(() => null);
      if (s?.isDirectory()) {
        // match github pages: redirect /app -> /app/ so relative URLs resolve
        if (!url.pathname.endsWith('/')) {
          res.writeHead(301, { location: `${url.pathname}/` }).end();
          return;
        }
        file = join(file, 'index.html');
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  return new Promise(resolvePort => {
    server.listen(port, () => {
      const addr = server.address();
      resolvePort(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}
