# The knowledge graph

Schema: `src/kg/types.ts`. Builders: `src/kg/parse.ts` (DSL parsers),
`src/kg/build.ts` (graph assembly + subgraph), `src/kg/cypher.ts`,
`src/kg/viewer.ts`.

## Node labels and id conventions

| Label | id pattern | Key props |
|---|---|---|
| `Game` | `game:galaga` | name, year, company, fullname, monitor (ROT90), cls, init, flags |
| `MachineConfig` | `machine:galaga_state.galaga` | cls, name, calls (helper configs it invokes) |
| `Device` | `device:<cfgname>/<tag>` e.g. `device:galaga/maincpu` | type (Z80/LS259/NAMCO_51XX/...), tag, clock (Hz, evaluated), config (raw C++ statements), screenRaw [pixclock,htotal,hbend,hbstart,vtotal,vbend,vbstart], gfxDecodeName |
| `AddressMap` | `map:galaga_state.galaga_map` | cls, name, calls (composed helper maps), globalMask?, unmapHigh? |
| `AddressRange` | `<mapId>/range<N>` | start, end, mirror?, rom/ram/writeonly/nopw/nopr flags, share?, portRead/portWrite (from .portr/.portw, port tag), raw |
| `Handler` | `handler:<ownerClass>.<method>` | method, ownerClass. **Shared across uses** — per-use device tag lives on the READS/WRITES edge props (`deviceTag`), NOT here (two LS259s share `ls259_device.write_d0`) |
| `RomSet` / `RomRegion` / `Rom` | `romset:galaga`, `region:galaga/gfx1`, `rom:galaga/gg1_1b.3p` | region: tag,size,flags; rom: file, offset, size, crc, sha1, reloadOffsets |
| `InputPorts` / `Port` / `PortField` | `inputs:galaga`, `.../IN0`, `.../f<N>` | field: kind (bit/dip/service), mask, activeLow, type (IPT_*), modifiers (PORT_COCKTAIL...), name, defaultValue, location, settings. PORT_CONFNAME/CONFSETTING parse as dip (bit-identical semantics — pacman's Ghost Names/Cabinet bits; dropping them silently flips config bits to active) |
| `GfxLayout` / `GfxDecode` / `GfxDecodeEntry` | `gfxlayout:spritelayout_galaga` etc. | layout: width,height,total (number or "RGN_FRAC(a,b)"), planes, planeOffsets/xOffsets/yOffsets (numbers; STEPn expanded; RGN_FRAC kept symbolic), charIncrement (bits) |
| `SourceFile` | `file:src/mame/namco/galaga.cpp` | path, external? |

## Edge types

`DEFINED_IN`, `INCLUDES`, `CLONE_OF`, `USES_MACHINE`, `USES_INPUTS`,
`USES_ROMSET`, `HAS_DEVICE`, `HAS_MAP` (props: space e.g. AS_PROGRAM),
`HAS_RANGE`, `READS`/`WRITES` (props: deviceTag when the handler is on a
device), `HAS_REGION`, `LOADS`, `HAS_PORT`, `HAS_FIELD`, `INCLUDES_PORTS`
(PORT_INCLUDE — the generator resolves the merge root-first), `DECODES`,
`HAS_ENTRY`, `USES_LAYOUT`, `READS_REGION`, `ON_DEVICE`, `INCLUDES_MAP`
(address-map composition: `galaxian_map -> galaxian_map_base`), `CALLS`
(machine-config helper chaining AND device `device_add_mconfig` — the
generator collects devices/maps across this chain), `PATCHES_MAP`
(cross-config `set_addrmap`: attached to the **patching config**, resolved
only along a game's own CALLS chain so one game's override can't leak into
siblings sharing the device).

Id conventions added under issue #3: rom ids are **region-scoped**
(`rom:<set>/<region>/<file>` — gyruss has two different chips named
`gyrussk.4`), device ids from device_add_mconfig are
`device:<cls>.<name>/<tag>`. `resolveMap` prefers same-class matches first
(an alpha1v map with the same name must not shadow mpatrol's), then falls
back by name (irem_audio's `m52_small_sound_map` lives on a base class).
`graph.meta` carries `driverFile`, `license` and `copyrightHolders` parsed
from the driver header's RAW text (`// copyright-holders:` — comments are
stripped before parsing everywhere else).

## What the parsers handle (and don't)

`parse.ts` works on comment-stripped source with balanced-paren scanning
(`splitArgs`, `matchParen`) — regexes alone are not enough for nested
`FUNC(...)` args.

- **Expressions**: `evalExpr` evaluates clock/size arithmetic
  (`MASTER_CLOCK/6/2`, `XTAL(18'432'000)`, `18.432_MHz_XTAL` /
  `_kHz_XTAL` / `_Hz_XTAL` literals, hex, digit separators, decimals,
  + - * / and parens) with constants collected first — both classic
  `#define NAME expr` and modern
  `static constexpr XTAL/int NAME(expr)` / `= expr` (galaxian.h style).
  Returns null on anything else — callers keep the raw string (`clockExpr`).
- **Address-map composition**: `helper_map(map);` statements become `calls`
  + `INCLUDES_MAP` edges; `map.global_mask(...)`/`map.unmap_value_high()`
  become map props; `.portr("IN0")`/`.portw` become range `portRead`/
  `portWrite` props. Machine-config helper calls (`galaxian_base(config);`)
  become `CALLS` edges.
- **GFXDECODE_SCALE** entries parse like GFXDECODE_ENTRY with extra
  xscale/yscale props (galaxian renders 3× wide in MAME; the generator
  divides screen h-params back to native).
- **Device instantiation forms**: `Z80(config, m_maincpu, CLK)`,
  wrapped `ls259_device &misclatch(LS259(config, "misclatch"))` (the `&` cost
  us a bug once — see gotchas), chained `WATCHDOG_TIMER(config, "watchdog").set_vblank_count(...)`.
  Member refs resolve via constructor initializer lists parsed from the
  header (`m_subcpu(*this, "sub")` → `m_subcpu`→`sub`).
- **Callback wiring lines** (`misclatch.q_out_cb<0>().set(FUNC(...))`) are
  attached to the device's raw `config` string array — parsed by humans, not
  machines. The generator does not interpret them; board modules encode that
  knowledge. Templated FUNCs (`bgxpos_w<0>`) normalize to `bgxpos_w_0`.
- **Multi-line `#define` port macros** (`parseTextMacros` +
  `expandPortMacros`): KONAMI8_MONO_B12_UNK, KONAMI_COINAGE_LOC(...) etc.
  are text-expanded before INPUT_PORTS parsing; macro args use a
  nested-paren-tolerant regex (a lazy one truncated KONAMI_COINAGE's args
  and cost gyruss a stuck coin). `PORT_SERVICE_DIPLOC` parses as a service
  dip. `PORT_CUSTOM_MEMBER` fields carry the member name for board wiring.
- **Device args are re-parsed with `matchParen`** — the original lazy
  DEVICE_MACRO_RE capture truncated `XTAL(3'579'545)` and mpatrol's audio
  CPU got clock 0.
- **Includes**: same-directory `#include`s are followed (plus `.cpp` twins
  of included headers) so audio/irem.cpp-style split drivers land in one
  graph.
- **NOT parsed yet**: ROM_CONTINUE/ROM_FILL, source line numbers (wanted
  for deep-links, TODO). PORT_INCLUDE is now resolved (generator-side
  merge); per-CPU maps are handled (each cpu entry carries its own ranges).

## Subgraph extraction

`gameSubgraph(graph, 'galaga')` = BFS over outgoing edges from `game:galaga`.
Clones reach their parent's machine/inputs via `CLONE_OF` + the GAME row's own
machine/input references. The CLI writes both the subgraph (`graph.json`) and
the full driver graph (`graph.full.json` — all ~30 games in galaga.cpp).

## Viewer (`src/kg/viewer.ts`)

Self-contained single HTML file, data inlined (`</` escaped as `<`),
vanilla canvas force layout (O(n²) repulsion — fine ≤ a few hundred nodes),
pan/zoom/drag, hover tooltip, click → inspector panel (props + in/out edges,
click-through navigation), search, per-family legend filters, light/dark via
`prefers-color-scheme`.

Colors: 7 semantic families (hue = family), palette validated with the
dataviz skill validator in both modes (light worst adjacent CVD ΔE 24.2).
Families: Game=blue, Machine=aqua, Memory map=yellow, ROMs=green,
Inputs=violet, Graphics=red, Source files=magenta. If you add node labels,
map them into a family in `FAMILY` — don't add an 8th hue without re-running
the validator.

## Cypher export

`MERGE`-based, idempotent, single `:KG` supertype label + specific label, id
uniqueness constraint. Load: `cypher-shell -u neo4j -p <pass> < dist/galaga/graph.cypher`.
No Neo4J driver dependency anywhere — by design.
