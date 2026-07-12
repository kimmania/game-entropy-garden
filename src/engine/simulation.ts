import type { GameState, LevelDef, PlacedGate, Signal } from './types.js';
import { GATE_DEFS, evalGate, TICKS_PER_SECOND } from './gates.js';
import { buildCircuitGraph } from './circuit.js';

// Seeded RNG (mulberry32) - deterministic/replayable
export function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createGameState(level: LevelDef, seed: number): GameState {
  const gates: PlacedGate[] = [];
  let nextUid = 1;

  // Place input gates along the left edge
  for (let i = 0; i < level.inputs.length; i++) {
    gates.push({
      uid: nextUid++, type: 'INPUT', x: 0, y: 1 + i, rotation: 0,
      drift: 0, noiseTicks: 0, lastOutput: 0,
    });
  }

  // Place output gates along the right edge
  for (let i = 0; i < level.outputs.length; i++) {
    gates.push({
      uid: nextUid++, type: 'OUTPUT', x: level.grid.width - 1, y: 1 + i, rotation: 0,
      drift: 0, noiseTicks: 0, lastOutput: 0,
    });
  }

  // Place pre-placed gates
  if (level.prePlaced) {
    for (const pp of level.prePlaced) {
      gates.push({
        uid: nextUid++, type: pp.gate, x: pp.x, y: pp.y, rotation: 0,
        drift: pp.drift ?? 0, noiseTicks: 0, lastOutput: 0,
      });
    }
  }

  return {
    level,
    gates,
    wires: [],
    simState: 'idle',
    tick: 0,
    elapsed: 0,
    heatMap: new Float32Array(level.grid.width * level.grid.height),
    signals: new Map(),
    inputValues: [],
    outputValues: [],
    targetOutput: [],
    totalCorrect: 0,
    totalTicks: 0,
    pinnedInputs: [],
    seed,
    failures: [],
    nextGateUid: nextUid,
    nextWireUid: 1,
  };
}

export function addGate(state: GameState, type: PlacedGate['type'], x: number, y: number): boolean {
  // Check occupancy
  if (isOccupied(state, x, y)) return false;
  // Check within grid bounds
  if (x < 0 || y < 0 || x >= state.level.grid.width || y >= state.level.grid.height) return false;

  state.gates.push({
    uid: state.nextGateUid++, type, x, y, rotation: 0,
    drift: state.level.startingEntropy, noiseTicks: 0, lastOutput: 0,
  });
  return true;
}

export function addWire(
  state: GameState,
  fromGate: number, fromPin: number,
  toGate: number, toPin: number,
  path: [number, number][]
): boolean {
  // Validate endpoints
  const fromG = state.gates.find(g => g.uid === fromGate);
  const toG = state.gates.find(g => g.uid === toGate);
  if (!fromG || !toG) return false;
  const fromDef = GATE_DEFS[fromG.type];
  const toDef = GATE_DEFS[toG.type];
  if (fromPin >= fromDef.outputs) return false;
  if (toPin >= toDef.inputs) return false;

  state.wires.push({
    uid: state.nextWireUid++, fromGate, fromPin, toGate, toPin,
    path, corrosion: state.level.startingEntropy,
  });
  return true;
}

export function removeGate(state: GameState, uid: number): void {
  state.gates = state.gates.filter(g => g.uid !== uid);
  // Remove wires connected to this gate
  state.wires = state.wires.filter(w => w.fromGate !== uid && w.toGate !== uid);
}

export function removeWire(state: GameState, uid: number): void {
  state.wires = state.wires.filter(w => w.uid !== uid);
}

export function rotateGate(state: GameState, uid: number): void {
  const g = state.gates.find(g => g.uid === uid);
  if (g) g.rotation = (g.rotation + 90) % 360;
}

export function isOccupied(state: GameState, x: number, y: number): boolean {
  return state.gates.some(g => g.x === x && g.y === y);
}

export function getGateAt(state: GameState, x: number, y: number): PlacedGate | undefined {
  return state.gates.find(g => g.x === x && g.y === y);
}

export function canPlaceGate(state: GameState, x: number, y: number): boolean {
  if (x < 0 || y < 0) return false;
  if (x >= state.level.grid.width || y >= state.level.grid.height) return false;
  return !isOccupied(state, x, y);
}

// Run one simulation tick
export function tickSimulation(state: GameState): void {
  const rng = makeRng(state.seed + state.tick);

  // 1. Compute input values for this tick
  const inputValues: number[] = [];
  for (let i = 0; i < state.level.inputs.length; i++) {
    // Pinned inputs override the level's static/clock cycle so the player
    // can freeze one input combination and Step through it to observe how
    // a single case propagates (a controlled "probe" of the circuit).
    const pin = state.pinnedInputs[i];
    if (pin === 0 || pin === 1) {
      inputValues.push(pin);
      continue;
    }
    const inp = state.level.inputs[i];
    if (inp.type === 'static') {
      const vals = inp.value ?? [0];
      inputValues.push(vals[state.tick % vals.length]);
    } else if (inp.type === 'clock') {
      const period = inp.period ?? 4;
      inputValues.push(Math.floor(state.tick / period) % 2);
    }
  }

  // Compute target output for this tick
  const targetOutput: number[] = [];
  for (let i = 0; i < state.level.outputs.length; i++) {
    const tgt = state.level.outputs[i].target;
    targetOutput.push(tgt[state.tick % tgt.length]);
  }

  // 2. Build circuit graph
  const graph = buildCircuitGraph(state.gates, state.wires, state.level);

  // 3. Evaluate gates in topological order
  const newSignals = new Map<number, Signal[]>();
  const inputGateUids = graph.inputGateUids;

  // Set input gate outputs
  for (let i = 0; i < inputGateUids.length; i++) {
    const uid = inputGateUids[i];
    const val = inputValues[i] ?? 0;
    newSignals.set(uid, [val as Signal]);
  }

  // Evaluate each gate
  for (const uid of graph.order) {
    const gate = state.gates.find(g => g.uid === uid);
    if (!gate) continue;

    // Skip input gates (already set)
    if (gate.type === 'INPUT') continue;

    // Gather input signals from wires
    const inputSignals: Signal[] = [];
    const incomingWires = state.wires.filter(w => w.toGate === uid);
    // Sort by toPin
    incomingWires.sort((a, b) => a.toPin - b.toPin);
    for (const wire of incomingWires) {
      const sourceSignals = newSignals.get(wire.fromGate);
      if (sourceSignals && wire.fromPin < sourceSignals.length) {
        let sig = sourceSignals[wire.fromPin];
        // Apply wire corrosion. Longer wires (more grid cells spanned) gather
        // more corrosion, so they're more likely to weaken the signal to X.
        let cellLen = 0;
        for (let i = 0; i < wire.path.length - 1; i++) {
          cellLen += Math.abs(wire.path[i + 1][0] - wire.path[i][0])
                   + Math.abs(wire.path[i + 1][1] - wire.path[i][1]);
        }
        const corrosionLoss = cellLen * 0.05;
        const corrosionLevel = wire.corrosion + corrosionLoss;
        if (corrosionLevel > 0.3 && sig !== 0.5) {
          if (rng() < corrosionLevel * 0.3) sig = 0.5;
        }
        inputSignals.push(sig);
      } else {
        inputSignals.push(0.5);
      }
    }

    // Gate drift check
    const def = GATE_DEFS[gate.type];
    if (gate.noiseTicks > 0) {
      // Still noisy
      newSignals.set(uid, [rng() > 0.5 ? 1 : 0]);
      gate.noiseTicks--;
      gate.lastOutput = newSignals.get(uid)![0];
      continue;
    }

    // Drift roll
    const heatIdx = gate.y * state.level.grid.width + gate.x;
    const localHeat = state.heatMap[heatIdx] || 0;
    const driftChance = (1 - def.reliability) + gate.drift + (localHeat * 0.1);
    if (rng() < driftChance) {
      gate.noiseTicks = 1 + Math.floor(rng() * 3); // 1-3 ticks of noise
      // Cascade failure: boost adjacent gate drift
      for (const other of state.gates) {
        if (other.uid === uid) continue;
        const dist = Math.abs(other.x - gate.x) + Math.abs(other.y - gate.y);
        if (dist <= 1) {
          other.drift = Math.min(1, other.drift + 0.2);
        }
      }
      newSignals.set(uid, [rng() > 0.5 ? 1 : 0]);
      gate.lastOutput = newSignals.get(uid)![0];
      continue;
    }

    // Evaluate gate
    let output: Signal;
    if (gate.type === 'CLOCK') {
      const period = 4;
      output = (Math.floor(state.tick / period) % 2) as Signal;
    } else if (gate.type === 'COOLER') {
      output = 0;
    } else if (gate.type === 'OUTPUT') {
      output = inputSignals[0] ?? 0.5;
    } else if (gate.type === 'BROKEN_NOT') {
      output = evalGate(gate.type, inputSignals);
    } else {
      output = evalGate(gate.type, inputSignals);
    }

    // BUFFER cleans X signals
    if (gate.type === 'BUFFER' && output === 0.5) {
      output = gate.lastOutput !== 0.5 ? gate.lastOutput : 0;
    }

    newSignals.set(uid, [output]);
    gate.lastOutput = output;
    gate.drift = Math.min(1, gate.drift + def.decayRate * 0.5); // halved accumulation rate
  }

  state.signals = newSignals;
  state.inputValues = inputValues;
  state.targetOutput = targetOutput;

  // 4. Compute output values
  const outputValues: number[] = [];
  for (const uid of graph.outputGateUids) {
    const sigs = newSignals.get(uid);
    const val = sigs && sigs.length > 0 ? sigs[0] : 0.5;
    outputValues.push(val === 1 ? 1 : 0);
  }
  state.outputValues = outputValues;

  // 5. Check correctness
  let allCorrect = true;
  for (let i = 0; i < targetOutput.length; i++) {
    if (outputValues[i] !== targetOutput[i]) allCorrect = false;
  }
  if (allCorrect) {
    state.totalCorrect++;
  }
  state.totalTicks++;

  // 6. Update heat map
  const heatMap = new Float32Array(state.level.grid.width * state.level.grid.height);
  for (const gate of state.gates) {
    const def = GATE_DEFS[gate.type];
    if (def.heat === 0) continue;
    const idx = gate.y * state.level.grid.width + gate.x;
    if (def.heat > 0) {
      heatMap[idx] += def.heat;
      // Heat spread to neighbors (diminishing)
      const spread = 0.4;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = gate.x + dx;
          const ny = gate.y + dy;
          if (nx >= 0 && ny >= 0 && nx < state.level.grid.width && ny < state.level.grid.height) {
            heatMap[ny * state.level.grid.width + nx] += def.heat * spread;
          }
        }
      }
    } else if (def.heat < 0) {
      // COOLER reduces heat in 3x3
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gate.x + dx;
          const ny = gate.y + dy;
          if (nx >= 0 && ny >= 0 && nx < state.level.grid.width && ny < state.level.grid.height) {
            const ni = ny * state.level.grid.width + nx;
            heatMap[ni] = Math.max(0, heatMap[ni] + def.heat);
          }
        }
      }
    }
  }
  state.heatMap = heatMap;

  // 7. Update wire corrosion
  for (const wire of state.wires) {
    wire.corrosion = Math.min(1, wire.corrosion + 0.001);
  }

  state.tick++;
  state.elapsed = state.tick / TICKS_PER_SECOND;
}

export function checkWin(state: GameState): boolean {
  // Win when survival time is reached AND the circuit produced correct output
  // for a sufficient ratio of all ticks.
  if (state.elapsed < state.level.survivalTime) return false;
  if (state.totalTicks === 0) return false;
  const ratio = state.totalCorrect / state.totalTicks;
  // Tutorial levels (0% entropy) have a softer 70% threshold;
  // levels with entropy require 80%.
  const threshold = state.level.startingEntropy > 0 ? 0.8 : 0.7;
  return ratio >= threshold;
}

export function checkLoss(state: GameState): boolean {
  // Loss if we've exceeded survival time + 50% grace and haven't won
  const maxTime = state.level.survivalTime * 1.5;
  return state.elapsed > maxTime && !checkWin(state);
}

// Force (or clear) an input to a fixed value so the player can freeze one
// input combination and Step through it to observe propagation.
// val === null releases the pin back to the level's static/clock cycle.
export function setPinnedInput(state: GameState, index: number, val: number | null): void {
  // Ensure the array is long enough for all level inputs.
  while (state.pinnedInputs.length < state.level.inputs.length) {
    state.pinnedInputs.push(null);
  }
  state.pinnedInputs[index] = val;
}

export function resetSimulation(state: GameState): void {
  state.simState = 'idle';
  state.tick = 0;
  state.elapsed = 0;
  state.heatMap = new Float32Array(state.level.grid.width * state.level.grid.height);
  state.signals = new Map();
  state.inputValues = [];
  state.outputValues = [];
  state.targetOutput = [];
  state.totalCorrect = 0;
  state.totalTicks = 0;
  state.failures = [];

  // Reset gate drift to starting entropy
  for (const gate of state.gates) {
    gate.drift = state.level.startingEntropy;
    gate.noiseTicks = 0;
    gate.lastOutput = 0;
  }

  // Reset wire corrosion
  for (const wire of state.wires) {
    wire.corrosion = state.level.startingEntropy;
  }
}
