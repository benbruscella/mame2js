// Self-contained knowledge-graph viewer: one HTML file, graph data inlined,
// vanilla canvas force-directed layout. No libraries, works from file://.

import type { KnowledgeGraph } from './types.ts';

// Node-label -> color family (7 validated categorical slots; hue = semantic
// family, so related labels read as one cluster).
const FAMILY: Record<string, number> = {
  Game: 0,
  MachineConfig: 1, Device: 1, Callback: 1,
  AddressMap: 2, AddressRange: 2, Handler: 2,
  RomSet: 3, RomRegion: 3, Rom: 3,
  InputPorts: 4, Port: 4, PortField: 4,
  GfxDecode: 5, GfxDecodeEntry: 5, GfxLayout: 5,
  SourceFile: 6,
};
const FAMILY_NAMES = ['Game', 'Machine', 'Memory map', 'ROMs', 'Inputs', 'Graphics', 'Source files'];
// validated: scripts/validate_palette.js — light worst adjacent CVD ΔE 24.2, dark 10.3
const LIGHT = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4'];
const DARK = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181'];

export function viewerHtml(graph: KnowledgeGraph, title: string): string {
  const data = JSON.stringify({
    nodes: graph.nodes.map(n => ({ id: n.id, label: n.label, props: n.props })),
    edges: graph.edges.map(e => ({ from: e.from, to: e.to, rel: e.rel, props: e.props ?? null })),
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — mamekit knowledge graph</title>
<style>
  :root {
    --surface: #fcfcfb; --panel: #f4f4f2; --border: #dddcd8;
    --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #8a897f;
    --edge: rgba(82,81,78,.28); --edge-hi: rgba(11,11,11,.75);
    --halo: rgba(252,252,251,.85); --accent: #2a78d6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #1a1a19; --panel: #232322; --border: #3a3a38;
      --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #86857b;
      --edge: rgba(195,194,183,.22); --edge-hi: rgba(255,255,255,.8);
      --halo: rgba(26,26,25,.85); --accent: #3987e5;
    }
  }
  * { margin: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
  body { background: var(--surface); color: var(--ink);
         font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; display: flex; flex-direction: column; }
  header { display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
           padding: 8px 14px; border-bottom: 1px solid var(--border); }
  header h1 { font-size: 14px; font-weight: 600; margin-right: 6px; }
  header input[type=search] { background: var(--panel); color: var(--ink); border: 1px solid var(--border);
           border-radius: 6px; padding: 4px 10px; width: 210px; outline: none; }
  header input[type=search]:focus { border-color: var(--accent); }
  header button { background: var(--panel); color: var(--ink); border: 1px solid var(--border);
                  border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  header button:hover { border-color: var(--accent); }
  .legend { display: flex; gap: 10px; flex-wrap: wrap; }
  .legend label { display: inline-flex; align-items: center; gap: 5px; color: var(--ink-2);
                  cursor: pointer; user-select: none; }
  .legend .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .legend input { accent-color: var(--accent); margin: 0; }
  main { flex: 1; display: flex; min-height: 0; }
  #canvas { flex: 1; cursor: grab; touch-action: none; }
  #canvas.dragging { cursor: grabbing; }
  aside { width: min(380px, 46vw); border-left: 1px solid var(--border); background: var(--panel);
          overflow-y: auto; padding: 14px; display: none; }
  aside.open { display: block; }
  aside h2 { font-size: 13px; word-break: break-all; }
  aside .lbl { color: var(--ink-3); font-size: 11px; text-transform: uppercase;
               letter-spacing: .04em; margin: 12px 0 4px; }
  aside table { width: 100%; border-collapse: collapse; }
  aside td { padding: 3px 6px 3px 0; vertical-align: top; border-bottom: 1px solid var(--border);
             color: var(--ink-2); word-break: break-all; }
  aside td:first-child { color: var(--ink-3); white-space: nowrap; }
  aside pre { white-space: pre-wrap; word-break: break-all; background: var(--surface);
              border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
              font-size: 11px; color: var(--ink-2); }
  aside a { color: var(--accent); cursor: pointer; text-decoration: none; display: block;
            padding: 2px 0; word-break: break-all; }
  aside a:hover { text-decoration: underline; }
  aside .rel { color: var(--ink-3); font-size: 11px; }
  aside .metric { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0;
                  border-bottom: 1px solid var(--border); }
  aside .metric strong { font-variant-numeric: tabular-nums; }
  aside .warn { color: #b85b00; }
  @media (prefers-color-scheme: dark) { aside .warn { color: #eda100; } }
  #tip { position: fixed; pointer-events: none; background: var(--panel); color: var(--ink);
         border: 1px solid var(--border); border-radius: 6px; padding: 4px 9px;
         font-size: 12px; display: none; max-width: 340px; word-break: break-all;
         box-shadow: 0 2px 10px rgba(0,0,0,.18); z-index: 10; }
  #stats { color: var(--ink-3); margin-left: auto; }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <button id="overview" type="button">Overview</button>
  <input id="search" type="search" placeholder="search nodes…">
  <div class="legend" id="legend"></div>
  <span id="stats"></span>
</header>
<main>
  <canvas id="canvas"></canvas>
  <aside id="panel" class="open"></aside>
</main>
<div id="tip"></div>
<script type="application/json" id="graph-data">${data}</script>
<script>
'use strict';
const GRAPH = JSON.parse(document.getElementById('graph-data').textContent);
const FAMILY = ${JSON.stringify(FAMILY)};
const FAMILY_NAMES = ${JSON.stringify(FAMILY_NAMES)};
const LIGHT = ${JSON.stringify(LIGHT)}, DARK = ${JSON.stringify(DARK)};
const darkMq = matchMedia('(prefers-color-scheme: dark)');
const palette = () => darkMq.matches ? DARK : LIGHT;
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// --- graph model -----------------------------------------------------------
const nodes = GRAPH.nodes.map(n => ({
  ...n, fam: FAMILY[n.label] ?? 6,
  x: 0, y: 0, vx: 0, vy: 0, deg: 0, r: 5, fixed: false,
}));
const byId = new Map(nodes.map(n => [n.id, n]));
const edges = GRAPH.edges.filter(e => byId.has(e.from) && byId.has(e.to))
  .map(e => ({ ...e, a: byId.get(e.from), b: byId.get(e.to) }));
for (const e of edges) { e.a.deg++; e.b.deg++; }
for (const n of nodes) n.r = 4 + Math.min(10, Math.sqrt(n.deg) * 2.1);
const adj = new Map(nodes.map(n => [n, []]));
for (const e of edges) { adj.get(e.a).push(e); adj.get(e.b).push(e); }

// deterministic initial placement: ring per family
nodes.forEach((n, i) => {
  const golden = i * 2.39996 + n.fam;
  const rad = 120 + 240 * ((i * 0.618) % 1);
  n.x = Math.cos(golden) * rad; n.y = Math.sin(golden) * rad;
});

// --- state -----------------------------------------------------------------
const hidden = new Set();           // hidden families
let selected = null, hovered = null;
let searchTerm = '';
let scale = 1, ox = 0, oy = 0;      // view transform
let alpha = 1;                       // simulation heat

// --- canvas setup ----------------------------------------------------------
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
function resize() {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(() => { resize(); draw(); }).observe(canvas);

const visible = n => !hidden.has(n.fam);

// --- physics (O(n^2) fine at this scale) ------------------------------------
function tick() {
  const vs = nodes.filter(visible);
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i];
    for (let j = i + 1; j < vs.length; j++) {
      const b = vs[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = (Math.random ? ((i * 7 + j) % 13) / 13 - .5 : .1); dy = ((i * 5 + j) % 11) / 11 - .5; d2 = dx*dx+dy*dy+.01; }
      const f = Math.min(12, 1400 / d2) * alpha;
      const d = Math.sqrt(d2);
      a.vx += dx / d * f; a.vy += dy / d * f;
      b.vx -= dx / d * f; b.vy -= dy / d * f;
    }
  }
  for (const e of edges) {
    if (!visible(e.a) || !visible(e.b)) continue;
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const want = 46 + (e.a.r + e.b.r);
    const f = (d - want) * 0.02 * alpha;
    e.a.vx += dx / d * f; e.a.vy += dy / d * f;
    e.b.vx -= dx / d * f; e.b.vy -= dy / d * f;
  }
  for (const n of vs) {
    n.vx -= n.x * 0.0016 * alpha; n.vy -= n.y * 0.0016 * alpha; // gravity
    if (!n.fixed) { n.x += n.vx; n.y += n.vy; }
    n.vx *= 0.6; n.vy *= 0.6;
  }
  alpha = Math.max(0.02, alpha * 0.995);
}

// --- rendering ---------------------------------------------------------------
function draw() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2 + ox, h / 2 + oy);
  ctx.scale(scale, scale);
  const pal = palette();
  const focus = hovered || selected;
  const inFocus = new Set();
  if (focus) {
    inFocus.add(focus);
    for (const e of adj.get(focus)) { inFocus.add(e.a); inFocus.add(e.b); }
  }
  const match = n => searchTerm && (n.id.toLowerCase().includes(searchTerm) || String(n.props.name ?? '').toLowerCase().includes(searchTerm));

  ctx.lineWidth = 1 / scale;
  for (const e of edges) {
    if (!visible(e.a) || !visible(e.b)) continue;
    const hi = focus && (e.a === focus || e.b === focus);
    ctx.strokeStyle = hi ? cssVar('--edge-hi') : cssVar('--edge');
    ctx.globalAlpha = focus && !hi ? 0.25 : 1;
    ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const n of nodes) {
    if (!visible(n)) continue;
    const dim = (focus && !inFocus.has(n)) || (searchTerm && !match(n));
    ctx.globalAlpha = dim ? 0.22 : 1;
    ctx.fillStyle = pal[n.fam];
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.fill();
    if (n === selected) {
      ctx.strokeStyle = cssVar('--ink'); ctx.lineWidth = 2 / scale;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 2 / scale, 0, 7); ctx.stroke();
    }
  }
  // direct labels: hubs always, everything when zoomed, neighborhood on focus
  ctx.font = \`\${11 / scale}px ui-sans-serif, system-ui\`;
  ctx.textBaseline = 'middle';
  for (const n of nodes) {
    if (!visible(n)) continue;
    const show = scale > 1.6 || n.deg >= 6 || inFocus.has(n) || match(n);
    if (!show) continue;
    const dim = focus && !inFocus.has(n);
    const text = shortName(n);
    const x = n.x + n.r + 4 / scale;
    ctx.globalAlpha = dim ? 0.3 : 1;
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = cssVar('--halo');
    ctx.strokeText(text, x, n.y);
    ctx.fillStyle = cssVar('--ink-2');
    ctx.fillText(text, x, n.y);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function shortName(n) {
  const p = n.props;
  return String(p.name ?? p.tag ?? p.file ?? p.path ?? p.method ?? n.id.split(':').pop());
}

function loop() { tick(); draw(); requestAnimationFrame(loop); }

// --- interaction -------------------------------------------------------------
const tip = document.getElementById('tip');
function pick(mx, my) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const gx = (mx - w / 2 - ox) / scale, gy = (my - h / 2 - oy) / scale;
  let best = null, bestD = 1e9;
  for (const n of nodes) {
    if (!visible(n)) continue;
    const d = Math.hypot(n.x - gx, n.y - gy);
    if (d < n.r + 4 / scale && d < bestD) { best = n; bestD = d; }
  }
  return best;
}
let drag = null; // {node} | {pan:true}
canvas.addEventListener('pointerdown', ev => {
  const n = pick(ev.offsetX, ev.offsetY);
  drag = n ? { node: n } : { pan: true, sx: ev.clientX, sy: ev.clientY, ox, oy };
  if (n) { n.fixed = true; alpha = Math.max(alpha, 0.3); }
  canvas.classList.add('dragging');
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener('pointermove', ev => {
  if (drag?.node) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    drag.node.x = (ev.offsetX - w / 2 - ox) / scale;
    drag.node.y = (ev.offsetY - h / 2 - oy) / scale;
    drag.moved = true;
  } else if (drag?.pan) {
    ox = drag.ox + ev.clientX - drag.sx; oy = drag.oy + ev.clientY - drag.sy;
    drag.moved = true;
  } else {
    hovered = pick(ev.offsetX, ev.offsetY);
    if (hovered) {
      tip.style.display = 'block';
      tip.style.left = Math.min(innerWidth - 360, ev.clientX + 14) + 'px';
      tip.style.top = (ev.clientY + 12) + 'px';
      tip.textContent = hovered.label + ' · ' + hovered.id;
    } else tip.style.display = 'none';
  }
});
canvas.addEventListener('pointerup', ev => {
  if (drag?.node && !drag.moved) select(drag.node);
  else if (drag?.pan && !drag.moved) select(null);
  if (drag?.node) drag.node.fixed = false;
  drag = null;
  canvas.classList.remove('dragging');
});
canvas.addEventListener('wheel', ev => {
  ev.preventDefault();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const f = Math.exp(-ev.deltaY * 0.0015);
  const nx = ev.offsetX - w / 2, ny = ev.offsetY - h / 2;
  ox = nx - (nx - ox) * f; oy = ny - (ny - oy) * f;
  scale = Math.min(8, Math.max(0.15, scale * f));
}, { passive: false });

// --- panel -------------------------------------------------------------------
const panel = document.getElementById('panel');
function select(n) {
  selected = n;
  panel.classList.add('open');
  if (!n) { showOverview(); return; }
  const rows = Object.entries(n.props).map(([k, v]) =>
    \`<tr><td>\${esc(k)}</td><td>\${fmtProp(n, k, v)}</td></tr>\`).join('');
  const links = dir => adj.get(n)
    .filter(e => (dir === 'out' ? e.a : e.b) === n)
    .map(e => {
      const other = dir === 'out' ? e.b : e.a;
      return \`<a data-id="\${esc(other.id)}"><span class="rel">\${dir === 'out' ? '→' : '←'} \${e.rel}</span> \${esc(shortName(other))}</a>\`;
    }).join('') || '<span class="rel">none</span>';
  panel.innerHTML = \`
    <h2>\${esc(n.id)}</h2>
    <div class="lbl">\${esc(n.label)} · \${FAMILY_NAMES[n.fam]}</div>
    <div class="lbl">properties</div><table>\${rows || '<tr><td colspan=2>none</td></tr>'}</table>
    <div class="lbl">outgoing</div>\${links('out')}
    <div class="lbl">incoming</div>\${links('in')}\`;
  panel.querySelectorAll('a[data-id]').forEach(a =>
    a.addEventListener('click', () => { const t = byId.get(a.dataset.id); if (t) { select(t); alpha = Math.max(alpha, .15); } }));
}
function showOverview() {
  selected = null;
  const game = nodes.find(n => n.label === 'Game');
  const devices = nodes.filter(n => n.label === 'Device');
  const maps = nodes.filter(n => n.label === 'AddressMap');
  const ranges = nodes.filter(n => n.label === 'AddressRange');
  const callbacks = nodes.filter(n => n.label === 'Callback');
  const handlers = nodes.filter(n => n.label === 'Handler');
  const roms = nodes.filter(n => n.label === 'Rom');
  const romBytes = roms.reduce((sum, n) => sum + Number(n.props.size || 0), 0);
  const sourceable = nodes.filter(n => n.label !== 'SourceFile');
  const covered = sourceable.filter(n => n.props.sourceFile).length;
  const driverHandlers = handlers.filter(n =>
    String(n.props.ownerClass || '').endsWith('_state') || n.props.ownerClass === 'driver');
  const gaps = ranges.filter(n => {
    if (!/\\.(?:l[wr]+8|select|umask\\w*)\\s*\\(/.test(String(n.props.raw || ''))) return false;
    return !edges.some(e => e.a === n && (e.rel === 'READS' || e.rel === 'WRITES'));
  });
  const gameSource = game?.props.sourceFile
    ? sourceAnchor(game.props.sourceFile, game.props.sourceLine, 'Open MAME definition')
    : '';
  panel.innerHTML = \`
    <h2>\${esc(game?.props.fullname || game?.props.name || 'Machine overview')}</h2>
    <div class="lbl">MAME compiler overview</div>
    <div class="metric"><span>Devices</span><strong>\${devices.length}</strong></div>
    <div class="metric"><span>Address ranges</span><strong>\${ranges.length}</strong></div>
    <div class="metric"><span>ROM chips / bytes</span><strong>\${roms.length} / \${romBytes.toLocaleString()}</strong></div>
    <div class="metric"><span>Callback wires extracted</span><strong>\${callbacks.length}</strong></div>
    <div class="metric"><span>Source provenance</span><strong>\${covered}/\${sourceable.length}</strong></div>
    <div class="metric"><span>Family behavior entry points</span><strong>\${driverHandlers.length}</strong></div>
    <div class="metric"><span>Detected parser gaps</span><strong class="\${gaps.length ? 'warn' : ''}">\${gaps.length}</strong></div>
    <div class="lbl">Compiler outputs</div>
    \${gameSource}
    <a href="runtime-report.md" target="_blank">Open runtime transpilation report</a>
    <div class="lbl">Machine maps</div>
    \${maps.map(n => \`<a data-id="\${esc(n.id)}">\${esc(shortName(n))} <span class="rel">\${adj.get(n).length} links</span></a>\`).join('') || '<span class="rel">none</span>'}
    <div class="lbl">Extracted callback wiring</div>
    \${callbacks.slice(0, 16).map(n => \`<a data-id="\${esc(n.id)}">\${esc(shortName(n))} <span class="rel">→ \${esc(n.props.targetTag || n.props.targetMethod || n.props.operation)}</span></a>\`).join('') || '<span class="rel">none</span>'}
    \${callbacks.length > 16 ? \`<span class="rel">+\${callbacks.length - 16} more in the graph</span>\` : ''}
    \${gaps.length ? \`<div class="lbl warn">Parser gaps</div>\${gaps.map(n => \`<a data-id="\${esc(n.id)}">\${esc(n.props.raw)}</a>\`).join('')}\` : ''}
  \`;
  bindPanelLinks();
}
function bindPanelLinks() {
  panel.querySelectorAll('a[data-id]').forEach(a =>
    a.addEventListener('click', () => {
      const target = byId.get(a.dataset.id);
      if (target) { select(target); alpha = Math.max(alpha, .15); }
    }));
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmt(v) {
  if (Array.isArray(v)) return '<pre>' + v.map(esc).join('\\n') + '</pre>';
  if (typeof v === 'number' && v > 255 && Number.isInteger(v)) return esc(v) + ' <span class="rel">(0x' + v.toString(16) + ')</span>';
  return esc(v);
}
function fmtProp(n, key, value) {
  if (key === 'sourceFile') return sourceAnchor(value, n.props.sourceLine, value);
  return fmt(value);
}
function sourceAnchor(file, line, label) {
  const href = 'https://github.com/mamedev/mame/blob/master/' + encodeURI(String(file)) +
    (line ? '#L' + Number(line) : '');
  return \`<a href="\${esc(href)}" target="_blank" rel="noreferrer">\${esc(label)}\${line ? ':' + Number(line) : ''}</a>\`;
}

// --- legend + search + stats ---------------------------------------------------
const legend = document.getElementById('legend');
const famCounts = FAMILY_NAMES.map((_, i) => nodes.filter(n => n.fam === i).length);
FAMILY_NAMES.forEach((name, i) => {
  if (!famCounts[i]) return;
  const label = document.createElement('label');
  label.innerHTML = \`<input type="checkbox" checked><span class="sw"></span>\${name} <span style="color:var(--ink-3)">\${famCounts[i]}</span>\`;
  label.querySelector('.sw').style.background = palette()[i];
  label.querySelector('input').addEventListener('change', ev => {
    ev.target.checked ? hidden.delete(i) : hidden.add(i);
    alpha = Math.max(alpha, 0.3);
  });
  legend.appendChild(label);
});
darkMq.addEventListener('change', () => {
  legend.querySelectorAll('.sw').forEach((sw, idx) => {
    const fams = FAMILY_NAMES.map((_, i) => i).filter(i => famCounts[i]);
    sw.style.background = palette()[fams[idx]];
  });
});
document.getElementById('search').addEventListener('input', ev => {
  searchTerm = ev.target.value.trim().toLowerCase();
});
document.getElementById('overview').addEventListener('click', showOverview);
document.getElementById('stats').textContent = \`\${nodes.length} nodes · \${edges.length} edges\`;

resize();
showOverview();
loop();
</script>
</body>
</html>
`;
}
