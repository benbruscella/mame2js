# Gotchas

## Clean before generation

Generated files are renamed and deleted as the compiler evolves. Every complete
generation must start by deleting `dist`; otherwise stale app copies can make a
broken target appear to work. `npm run gen:all` enforces this.

## One canonical copy

Game modules live only in `dist/games/<category>/<game>/generated`. Shared
hardware lives only in `dist/runtime/generated`. `dist/app` contains the app
entry, registry and route HTML, not copies of either tree.

## JSON is data

Large typed IR values belong in `.json` files. Generated source imports them
with JSON import attributes. Do not emit `JSON.parse("{...}")` or duplicate the
same IR in TypeScript and JSON.

## MAME-specific, not generic C++

The compiler may rely on MAME class patterns, macros, device conventions and
opcode DSLs. Add a source-preserving MAME AST/lowering rule instead of expanding
scope into a general C++ compiler.

## No handwritten MAME hardware in runtime

`src/runtime` is the browser host and generic IR executor. A file such as
`src/runtime/z80.ts` or `src/runtime/ay8910.ts` means the generation boundary has
failed. Fix the source compiler or generic operation vocabulary instead.

## Category is a source fact

Arcade `GAME` targets go to `games/arcade`; console/system declarations go to
`games/consoles`. Use generated `dataPath` values in app/runtime code. Do not
infer paths from a game name or default consoles into the arcade tree.

## Relative URLs have two bases

Pretty routes use `/app/g/<game>/` with `<base href="../../">`, so app URLs
resolve as if the page were `/app/`. Game README paths, however, start three
levels below `dist` and need `../../../app/g/<game>/`.

## Audio worklets are separate modules

Generated worklets live under `dist/runtime/generated/audio`. Their imports
must resolve from that directory to `dist/runtime/core`; browser audio also
requires a secure context or localhost and a user gesture.

## JSON modules need correct MIME types

Generated boards import `machine.json` in the browser. The static server must
serve `.json` as `application/json`. Browser checks must cover this import path,
not only Node-side dynamic imports.

## Input polarity comes from MAME

Released input values are not universally `0xff`. Preserve each MAME port
field's active polarity and generated initial value. Coin/start tests should
hold synthetic keys long enough for the generated machine's polling cadence.

## ROMs stay outside the app

Arcade ROMs are supplied by the user through a file picker/drop and are not
served or persisted. Console carts are stored only in the visitor's browser by
the console workflow. Real-ROM tests read local gitignored files directly.

## Node TypeScript constraints

Node runs the CLI TypeScript directly with type stripping. Keep
`erasableSyntaxOnly`, use type-only imports where required, and let the browser
build rewrite relative `.ts` imports to `.js`.

## Provenance and gaps are first-class

Every generated callback, handler and hardware artifact should retain MAME
source locations. Unsupported hardware must remain visible in runtime reports
and the generated audit; do not hide it behind a permissive fallback.
