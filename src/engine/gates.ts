import type { GateDef, GateType, Signal } from './types.js';

export const GATE_DEFS: Record<GateType, GateDef> = {
  AND:      { type: 'AND',      inputs: 2, outputs: 1, heat: 1, reliability: 0.95, decayRate: 0.001, size: 1, unlocked: 1, label: 'AND',   symbol: '&',    color: '#4a9eff' },
  OR:       { type: 'OR',       inputs: 2, outputs: 1, heat: 1, reliability: 0.95, decayRate: 0.001, size: 1, unlocked: 1, label: 'OR',    symbol: '≥1',   color: '#4a9eff' },
  NOT:      { type: 'NOT',      inputs: 1, outputs: 1, heat: 1, reliability: 0.93, decayRate: 0.002, size: 1, unlocked: 1, label: 'NOT',   symbol: '!',    color: '#4a9eff' },
  XOR:      { type: 'XOR',      inputs: 2, outputs: 1, heat: 0.8, reliability: 0.98, decayRate: 0.0005, size: 1, unlocked: 2, label: 'XOR',   symbol: '⊕',    color: '#52d4a8' },
  NAND:     { type: 'NAND',     inputs: 2, outputs: 1, heat: 1.5, reliability: 0.92, decayRate: 0.002, size: 1, unlocked: 3, label: 'NAND',  symbol: '⊼',    color: '#f0a830' },
  CLOCK:    { type: 'CLOCK',    inputs: 0, outputs: 1, heat: 0.5, reliability: 0.97, decayRate: 0.001, size: 1, unlocked: 4, label: 'CLOCK', symbol: '◷',    color: '#d4696b' },
  BUFFER:   { type: 'BUFFER',   inputs: 1, outputs: 1, heat: 1.2, reliability: 0.96, decayRate: 0.001, size: 1, unlocked: 5, label: 'BUFF',  symbol: '▷',    color: '#a06ed4' },
  COOLER:   { type: 'COOLER',   inputs: 0, outputs: 0, heat: -3, reliability: 0.99, decayRate: 0.0001, size: 1, unlocked: 6, label: 'COOL',  symbol: '❄',    color: '#6bcfff' },
  REDUNDANT:{ type: 'REDUNDANT',inputs: 2, outputs: 1, heat: 2, reliability: 0.99, decayRate: 0.0003, size: 1, unlocked: 8, label: 'RED',   symbol: '≡',    color: '#e8d05c' },
  INPUT:    { type: 'INPUT',    inputs: 0, outputs: 1, heat: 0, reliability: 1.0, decayRate: 0, size: 1, unlocked: 0, label: 'IN',    symbol: '▶',    color: '#4ade80' },
  OUTPUT:   { type: 'OUTPUT',   inputs: 1, outputs: 0, heat: 0, reliability: 1.0, decayRate: 0, size: 1, unlocked: 0, label: 'OUT',   symbol: '◀',    color: '#4ade80' },
  BROKEN_NOT:{ type: 'BROKEN_NOT', inputs: 1, outputs: 1, heat: 1.5, reliability: 0.3, decayRate: 0.01, size: 1, unlocked: 0, label: 'BROKEN', symbol: '✕', color: '#ff4444' },
};

export const TICKS_PER_SECOND = 10;

// Ternary logic evaluation
export function evalGate(type: GateType, inputs: Signal[]): Signal {
  switch (type) {
    case 'AND':
    case 'NAND': {
      // X propagates like 1 for AND (risky)
      const a = inputs[0] ?? 0.5;
      const b = inputs[1] ?? 0.5;
      const aVal = a === 0.5 ? 1 : a;
      const bVal = b === 0.5 ? 1 : b;
      const result: Signal = (aVal === 1 && bVal === 1) ? 1 : 0;
      return type === 'NAND' ? (result === 1 ? 0 : 1) : result;
    }
    case 'OR': {
      // X propagates like 0 for OR
      const a = inputs[0] ?? 0.5;
      const b = inputs[1] ?? 0.5;
      const aVal = a === 0.5 ? 0 : a;
      const bVal = b === 0.5 ? 0 : b;
      return (aVal === 1 || bVal === 1) ? 1 : 0;
    }
    case 'NOT':
    case 'BROKEN_NOT': {
      const a = inputs[0] ?? 0.5;
      return a === 1 ? 0 : (a === 0 ? 1 : 0.5);
    }
    case 'XOR': {
      const a = inputs[0] ?? 0.5;
      const b = inputs[1] ?? 0.5;
      if (a === 0.5 || b === 0.5) return 0.5;
      return a === b ? 0 : 1;
    }
    case 'BUFFER': {
      const a = inputs[0] ?? 0.5;
      return a === 0.5 ? 0.5 : a; // pass through, could clean later
    }
    case 'REDUNDANT': {
      // majority vote
      const a = inputs[0] ?? 0.5;
      const b = inputs[1] ?? 0.5;
      if (a === 0.5 && b === 0.5) return 0.5;
      if (a === 1 || b === 1) return a === 0 && b === 0 ? 0.5 : (a === 1 ? 1 : (b === 1 ? 1 : 0.5));
      return 0;
    }
    case 'CLOCK':
      return 0; // handled by simulation tick
    case 'COOLER':
      return 0;
    case 'INPUT':
      return 0;
    case 'OUTPUT':
      return inputs[0] ?? 0.5;
    default:
      return 0;
  }
}
