// Export the knowledge graph as a Cypher script for Neo4J:
//   cypher-shell -u neo4j -p <pass> < out/galaga/graph.cypher
// (or paste into Neo4J Browser). No driver dependency — plain text out.

import type { KnowledgeGraph, PropValue } from './types.ts';

function cypherValue(v: PropValue): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(x => cypherValue(x)).join(', ')}]`;
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function propsBlock(props: Record<string, PropValue>): string {
  const entries = Object.entries(props).filter(([, v]) => v !== undefined);
  if (!entries.length) return '';
  return `, ${entries.map(([k, v]) => `${k}: ${cypherValue(v)}`).join(', ')}`;
}

export function toCypher(graph: KnowledgeGraph): string {
  const lines: string[] = [
    `// mamekit knowledge graph — driver ${graph.meta.driverFile}`,
    `// generated ${graph.meta.generatedAt}`,
    `CREATE CONSTRAINT mamekit_id IF NOT EXISTS FOR (n:KG) REQUIRE n.id IS UNIQUE;`,
  ];
  for (const n of graph.nodes) {
    lines.push(`MERGE (n:KG {id: ${cypherValue(n.id)}}) SET n:${n.label} SET n += {${propsBlock(n.props).replace(/^, /, '')}};`);
  }
  for (const e of graph.edges) {
    lines.push(
      `MATCH (a:KG {id: ${cypherValue(e.from)}}), (b:KG {id: ${cypherValue(e.to)}}) ` +
      `MERGE (a)-[r:${e.rel}]->(b)${e.props ? ` SET r += {${propsBlock(e.props).replace(/^, /, '')}}` : ''};`,
    );
  }
  return lines.join('\n') + '\n';
}
