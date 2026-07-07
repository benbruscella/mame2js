// mamekit knowledge graph schema.
// The graph is the single source of truth between extraction (MAME C++ source)
// and generation (TypeScript machine config). Native store is JSON; a Cypher
// export exists for loading into Neo4J.

export type NodeLabel =
  | 'SourceFile'    // a MAME source file we parsed
  | 'Game'          // one GAME(...) macro row (galaga, galagao, ...)
  | 'MachineConfig' // void cls::name(machine_config&)
  | 'Device'        // a device instantiated inside a machine config (Z80, LS259, SCREEN, ...)
  | 'AddressMap'    // void cls::name(address_map&)
  | 'AddressRange'  // one map(start,end)... statement
  | 'Handler'       // a named read/write handler referenced by a range or callback
  | 'RomSet'        // ROM_START(name) ... ROM_END
  | 'RomRegion'     // ROM_REGION(size, "tag", flags)
  | 'Rom'           // ROM_LOAD(...)
  | 'InputPorts'    // INPUT_PORTS_START(name)
  | 'Port'          // PORT_START("tag")
  | 'PortField'     // PORT_BIT / PORT_DIPNAME / PORT_SERVICE
  | 'GfxLayout'     // static const gfx_layout name = {...}
  | 'GfxDecode'     // GFXDECODE_START(name)
  | 'GfxDecodeEntry';

export type RelType =
  | 'DEFINED_IN'      // anything -> SourceFile
  | 'INCLUDES'        // SourceFile -> SourceFile (by name)
  | 'CLONE_OF'        // Game -> Game
  | 'USES_MACHINE'    // Game -> MachineConfig
  | 'USES_INPUTS'     // Game -> InputPorts
  | 'USES_ROMSET'     // Game -> RomSet
  | 'HAS_DEVICE'      // MachineConfig -> Device
  | 'HAS_MAP'         // Device(cpu) -> AddressMap        props: { space }
  | 'HAS_RANGE'       // AddressMap -> AddressRange
  | 'READS'           // AddressRange -> Handler
  | 'WRITES'          // AddressRange -> Handler
  | 'ON_DEVICE'       // Handler -> Device (handler lives on a device rather than the driver state)
  | 'HAS_REGION'      // RomSet -> RomRegion
  | 'LOADS'           // RomRegion -> Rom
  | 'HAS_PORT'        // InputPorts -> Port
  | 'HAS_FIELD'       // Port -> PortField
  | 'INCLUDES_PORTS'  // InputPorts -> InputPorts (PORT_INCLUDE)
  | 'INCLUDES_MAP'    // AddressMap -> AddressMap (helper composition: galaxian_map -> galaxian_map_base)
  | 'CALLS'           // MachineConfig -> MachineConfig (helper chaining: galaxian -> galaxian_base)
  | 'PATCHES_MAP'     // MachineConfig -> AddressMap (set_addrmap on a device from a called config; props: space, deviceTag)
  | 'DECODES'         // MachineConfig -> GfxDecode
  | 'HAS_ENTRY'       // GfxDecode -> GfxDecodeEntry
  | 'USES_LAYOUT'     // GfxDecodeEntry -> GfxLayout
  | 'READS_REGION';   // GfxDecodeEntry -> RomRegion (by tag, resolved per romset at generation)

export type PropValue = string | number | boolean | null | (string | number)[];

export interface KGNode {
  id: string;                 // stable, human-readable: "game:galaga", "rom:galaga/gg1_1b.3p"
  label: NodeLabel;
  props: Record<string, PropValue>;
}

export interface KGEdge {
  from: string;
  to: string;
  rel: RelType;
  props?: Record<string, PropValue>;
}

export interface KnowledgeGraph {
  meta: {
    tool: 'mamekit';
    version: string;
    mameSrc: string;
    driverFile: string;
    generatedAt: string;
    /** driver header credits: // license: and // copyright-holders: lines */
    license?: string;
    copyrightHolders?: string;
  };
  nodes: KGNode[];
  edges: KGEdge[];
}

export class GraphBuilder {
  nodes = new Map<string, KGNode>();
  edges: KGEdge[] = [];
  private edgeKeys = new Set<string>();

  node(label: NodeLabel, id: string, props: Record<string, PropValue> = {}): KGNode {
    const existing = this.nodes.get(id);
    if (existing) {
      Object.assign(existing.props, props);
      return existing;
    }
    const n: KGNode = { id, label, props };
    this.nodes.set(id, n);
    return n;
  }

  edge(from: string, to: string, rel: RelType, props?: Record<string, PropValue>): void {
    const key = `${from}|${rel}|${to}|${props ? JSON.stringify(props) : ''}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push(props ? { from, to, rel, props } : { from, to, rel });
  }

  toGraph(meta: KnowledgeGraph['meta']): KnowledgeGraph {
    return { meta, nodes: [...this.nodes.values()], edges: this.edges };
  }
}
