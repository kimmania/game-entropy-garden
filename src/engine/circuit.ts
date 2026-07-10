import type { PlacedGate, WireSegment, LevelDef } from './types.js';

export interface GateNode {
  gate: PlacedGate;
  dependencies: number[]; // gate uids that must be evaluated first
  dependents: number[];   // gate uids that depend on this
}

export interface CircuitGraph {
  nodes: Map<number, GateNode>;
  order: number[]; // topological evaluation order (gate uids)
  inputGateUids: number[];
  outputGateUids: number[];
}

export function buildCircuitGraph(
  gates: PlacedGate[],
  wires: WireSegment[],
  _level: LevelDef,
): CircuitGraph {
  const nodes = new Map<number, GateNode>();
  const inputGateUids: number[] = [];
  const outputGateUids: number[] = [];

  // Find input and output gates (placed at edges)
  for (const g of gates) {
    const deps: number[] = [];
    const dpts: number[] = [];
    nodes.set(g.uid, { gate: g, dependencies: deps, dependents: dpts });

    if (g.type === 'INPUT') inputGateUids.push(g.uid);
    if (g.type === 'OUTPUT') outputGateUids.push(g.uid);
  }

  // Wire connections create dependencies
  // toGate depends on fromGate (fromGate output feeds toGate input)
  for (const w of wires) {
    const fromNode = nodes.get(w.fromGate);
    const toNode = nodes.get(w.toGate);
    if (fromNode && toNode) {
      if (!fromNode.dependents.includes(w.toGate)) {
        fromNode.dependents.push(w.toGate);
      }
      if (!toNode.dependencies.includes(w.fromGate)) {
        toNode.dependencies.push(w.fromGate);
      }
    }
  }

  // Topological sort using Kahn's algorithm
  const inDegree = new Map<number, number>();
  for (const [uid, node] of nodes) {
    inDegree.set(uid, node.dependencies.length);
  }

  const queue: number[] = [];
  for (const [uid, deg] of inDegree) {
    if (deg === 0) queue.push(uid);
  }

  const order: number[] = [];
  // Sort queue so inputs are processed first
  const inputSet = new Set(inputGateUids);
  queue.sort((a, b) => {
    if (inputSet.has(a) && !inputSet.has(b)) return -1;
    if (!inputSet.has(a) && inputSet.has(b)) return 1;
    return 0;
  });

  while (queue.length > 0) {
    const uid = queue.shift()!;
    order.push(uid);
    const node = nodes.get(uid);
    if (node) {
      for (const depUid of node.dependents) {
        const d = (inDegree.get(depUid) ?? 0) - 1;
        inDegree.set(depUid, d);
        if (d === 0) queue.push(depUid);
      }
    }
  }

  return { nodes, order, inputGateUids, outputGateUids };
}

export function hasCycle(graph: CircuitGraph): boolean {
  return graph.order.length < graph.nodes.size;
}


