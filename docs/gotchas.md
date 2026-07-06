# Gotchas — read before changing anything

Hard-won facts, roughly ordered by how expensive they were to learn.

## 0. Input polarity is per-field, from the graph (galaxian!)
Galaga/pacman inputs are classic active-low (released = 0xff). **Galaxian's
are ACTIVE-HIGH** (`IP_ACTIVE_HIGH` in the driver): a port initialized to
0xff reads as "coin switch permanently pressed" — the game boot-loops
slamming coin sounds and never leaves the self-test screen. The generator
computes each port's resting byte (`ports[].init`) and each binding's
polarity from the graph's PortField `activeLow`; KeyboardInput restores
init bits on keyup. Never assume 0xff = idle.

## 0b. boards/index.ts must not be imported by board modules
The registry imports every board module; if a board imports anything back
from `boards/index.ts` (e.g. it used to host `portHandlers`), running that
board's spec directly evaluates the registry mid-cycle and hits the class
TDZ ("Cannot access 'PacmanBoard' before initialization"). Shared board
helpers live in `input.ts` / `types.ts`, never in the registry.

## 0c. The Playwright MCP browser is shared with subagents
Parallel agents drive the SAME browser instance. If pages navigate
themselves between your calls or console errors appear from URLs you never
opened, another agent is testing — don't chase ghosts; verify after agents
finish.

## 1. The 51xx port-order trap
Modern MAME wires 51xx `input_callback<0..1>` = IN0 (joystick) and `<2..3>` =
IN1 (coins/start/buttons) — true to the real MCU. The **classic HLE**
(which `namco51.ts` transpiles) was written against the OLD port order (coins
on ports 0/1). `Namco51` accepts modern-order callbacks and reorders
internally. Verified against MAME 0.121's driver where old-IN0 = coins.
If credits stop working after a refactor, look here first.

## 2. Old MAME code lives in this repo's git history
The MAME checkout's history goes back to 0.121 (2007). The classic 51xx HLE:
`git show 7b77f121862:src/mame/machine/namcoio.c`. This trick generalizes —
pre-MCU HLE cores for 50xx/52xx/53xx/54xx are all there, useful references
for browser-friendly HLE implementations.

## 3. Romset filename drift → match by CRC
The user's galaga set uses dash names (`gg1-1b.3p`); current MAME defines
underscores (`gg1_1b.3p`). Same bytes, same CRCs. `assembleRegions` matches
name → dash/underscore-swapped name → CRC32. Don't remove the CRC path.

## 4. erasableSyntaxOnly (TS1294)
Node's native type-stripping forbids enums, namespaces, and **constructor
parameter properties** (`constructor(private x: T)`). tsconfig enforces via
`erasableSyntaxOnly`. Both the main build and the generated app build use it.
Also: import specifiers must end `.ts` (rewritten to `.js` at emit by
`rewriteRelativeImportExtensions`), and type-only imports need `import type`
(verbatimModuleSyntax).

## 5. Handler nodes are shared; tags live on edges
`handler:ls259_device.write_d0` is ONE node used by both misclatch and
videolatch. The per-use device tag is on the READS/WRITES **edge** props
(`deviceTag`). Storing it on the node silently corrupts the second latch.

## 6. Device-parser regex and wrapped instantiation
`ls259_device &misclatch(LS259(config, "misclatch"))` — the `&` before the
local var name broke DEVICE_MACRO_RE once (misclatch/51xx/54xx/06xx silently
missing from the graph). If a device is missing from the CLI digest, suspect
the instantiation form, check `parse.ts` DEVICE_MACRO_RE.

## 7. Bus shares must be passed in, not created per-Bus
All three Z80 buses share one `shares` object (videoram, galaga_ram1/2/3).
Constructing buses with separate share maps gives each CPU private RAM and
the game silently never boots (subs wait on shared-RAM mailboxes).

## 8. 06xx NMI pacing and the read-stretch
Galaga's ISR-driven I/O depends on the 06xx pulsing main-CPU NMIs at
clock/2^shifts (control 0x71 → 6 kHz → every 512 CPU cycles) and on the
FIRST pulse of a read burst being suppressed. Without the stretch the first
read returns garbage and coin-up misbehaves.

## 9. Misclatch Q3 semantics (inverted, multi-target)
Q3=0 holds sub, sub2 **and** 51xx/54xx in reset (boot state after latch
reset). On the 0→1 edge both sub CPUs must `.reset()` (fresh PC), not just
resume. The main CPU releases them once mailboxes are initialized.

## 10. Synthetic input needs real hold times
The 51xx samples inputs when polled (~per NMI burst). Playwright's
`press()` (~ms) can miss the edge entirely. Hold ≥200 ms. Same will apply to
any future input-replay/test automation.

## 11. Video facts that bite
- Frame is **native landscape 288×224**; ROT90 happens at blit time
  (translate + rotate π/2 onto a 224×288 canvas).
- Framebuffer packing is 0xAABBGGRR (ImageData byte order via a
  Uint8ClampedArray view over the same buffer).
- Sprite registers are the TOP 0x80 bytes (0x380-0x3ff) of each of
  ram1/ram2/ram3 — the rest is general work RAM.
- Char transparency: LUT nibble == 0x0f (not pen 0).

## 12. AudioWorklet serving
The worklet is a separate compiled module (`dist/runtime/wsg-worklet.js`)
that ES-imports `./wsg.js` (and `./namco54.js`) — all must be served; a
bundler-style inline would break. Audio needs user activation, but the menu
click that navigated to the game normally satisfies it (same-origin
carryover); the shell starts audio immediately and resumes on first input
as fallback. `AudioOutput` buffers pre-start register writes and replays
them.

## 13. Playwright MCP can't open file:// URLs
Use the dev server (`--serve`, :8280). The KG viewer works from file:// for
humans, but automated checks need http.

## 14. The symlink arrangement
Repo truth: `~/Projects/Github/mame2js`. `<mame>/mame2js` is a symlink kept
for convenience; the MAME repo excludes it via `.git/info/exclude` (entry
`/mame2js` — **no trailing slash**, symlinks aren't directories). The CLI
auto-detects MAME source at `../mame` or parent.

## 15. ROMs
`roms/` is gitignored because ROM images are copyrighted. Never commit them,
never fetch them. The user's local set (all six games) currently lives in
`_roms/` — the user renamed the dir on 2026-07-06 to exercise the drop-zone
path, so the dev server 404s zips until it's renamed back. **The rename
escaped the old `/roms/` ignore rule and the zips got committed and pushed**;
they were scrubbed with filter-branch + force-push, and `.gitignore` now
blocks `/roms/`, `/_roms/` and `*.zip`. Two lessons: (a) watch for ignore
escapes when dirs get renamed, (b) `git filter-branch`'s final checkout
REMOVES formerly-tracked files from the working tree — restore them from the
backup branch before deleting it.

## 16. `dist/.driver-cache.json`
Driver discovery caches game→driver-file mappings. If you point at a
different MAME checkout and things look stale, delete it.

## 17. No sound? Check the protocol, not the mixer
**AudioWorklet requires a secure context.** On plain http (real domains)
`audioWorklet.addModule` fails and every core is silent; localhost is
exempt, so "works locally, silent in prod" = missing HTTPS. GitHub-level
enforcement + a client-side http→https redirect in main.ts both exist —
keep them.

## 18. Relative URLs are load-bearing
The whole app is base-path agnostic (GitHub Pages serves under `/<repo>/`,
the custom domain at `/`). Every runtime fetch and generated URL is
relative to the `/app/` page; the pretty-route pages under `app/g/<game>/`
rely on `<base href="../../">`. A single leading-slash URL breaks the
deployed site while working fine on localhost:8280. The dev server
301-redirects bare directory paths to match Pages.

## 19. Pages CDN caching will gaslight you
`max-age=600` on everything. After a deploy, curl with a cache-busting
query (or check `age:` in headers) before concluding the deploy failed;
browsers additionally cache module scripts hard (hence the `?v=<stamp>` on
main.js). Pages builds take minutes with the 74 MB artwork tree, and a
superseded build can show `errored` — only the latest build matters.

## 20. history.dat is CRLF
The Gaming History dat uses `\r\n`. The extractor normalizes at the source;
if you ever re-extract by hand, `$`-anchored regexes (section splitting,
boilerplate stripping) silently fail against un-normalized text.

## 21. Macro-argument regexes must tolerate nested parens
`KONAMI_COINAGE_LOC(SW1)`-style port macros and `XTAL(3'579'545)` device
args both broke lazy regex captures (gyruss stuck-coin, mpatrol clock=0).
Use `matchParen`/balanced scanning for anything that can contain `()`.

## 22. ROMREGION_ERASEFF matters
Regions flagged ERASEFF must be 0xff-filled before gfx decode — zero-fill
decodes to transparent pen 0 (mpatrol's black ground strip). Handled in
video/m52.ts (`normalizeBgRegion`); a graph-driven region-fill flag is the
proper fix (TODO).

## 23. Map resolution traps (multi-game drivers)
Maps resolve same-class-first (alpha1v's identically-named map must not
shadow mpatrol's), then by name (irem_audio's base-class map). Cross-config
`set_addrmap` patches attach to the PATCHING config and resolve only along
a game's own CALLS chain — attaching them to the shared device node broke
pacman ("cannonbp_protection_r").

## 24. DreamHost DNS publishes slowly
Panel edits take ~5-15 min to reach ns1-3.dreamhost.com — `dig
@ns1.dreamhost.com` before blaming the records. GitHub Pages cert issuance
can stall on a domain set before DNS propagated; remove/re-add the cname to
kick it. The deploy script must own `dist/CNAME` or a force-push detaches
the custom domain.
