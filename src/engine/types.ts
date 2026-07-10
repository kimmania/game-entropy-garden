// Core type definitions for Entropy Garden

export type Signal = 0 | 1 | 0.5; // 0.5 = X (unknown/weak)

export type GateType =
  | 'AND' | 'OR' | 'NOT' | 'XOR' | 'NAND'
  | 'CLOCK' | 'BUFFER' | 'COOLER' | 'REDUNDANT'
  | 'INPUT' | 'OUTPUT' | 'BROKEN_NOT';

export interface GateDef {
  type: GateType;
  inputs: number;       // number of input pins
  outputs: number;      // number of output pins
  heat: number;         // heat emitted per tick
  reliability: number;  // 0–1, chance of NOT drifting this tick
  decayRate: number;    // added to base decay per tick
  size: number;         // grid cells (1 = 1x1, 2 = 1x1 still but bigger footprint)
  unlocked: number;     // level at which this gate becomes available
  label: string;
  symbol: string;       // short text for canvas rendering
  color: string;
}

export interface PlacedGate {
  uid: number;          // unique instance id
  type: GateType;
  x: number;            // grid col
  y: number;            // grid row
  rotation: number;     // 0, 90, 180, 270
  drift: number;        // current drift level 0–1 (increases during sim)
  noiseTicks: number;   // remaining ticks of noise output
  lastOutput: Signal;   // last computed output (for buffer)
  powered: boolean;     // for COOLER - needs power to function
}

export interface WireSegment {
  uid: number;
  fromGate: number;     // gate uid
  fromPin: number;      // output pin index
  toGate: number;       // gate uid
  toPin: number;        // input pin index
  path: [number, number][]; // grid cells the wire traverses
  corrosion: number;    // 0–1, increases during sim
}

export interface InputDef {
  id: string;
  type: 'static' | 'clock';
  value?: number[];     // for static: sequence of 0/1 values per tick
  period?: number;      // for clock: period in ticks
}

export interface OutputDef {
  id: string;
  target: number[];     // expected sequence of 0/1 values
}

export interface LevelDef {
  id: string;
  name: string;
  garden: string;
  gardenName: string;
  grid: { width: number; height: number };
  inputs: InputDef[];
  outputs: OutputDef[];
  survivalTime: number;     // seconds the circuit must survive
  starGates: number[];      // [functionality, survival, efficiency] gate counts
  palette: GateType[];
  prePlaced?: { gate: GateType; x: number; y: number; drift?: number }[];
  startingEntropy: number;  // 0–1 initial corrosion/drift
  description: string;
}

export interface CircuitSave {
  levelId: string;
  gates: { type: GateType; x: number; y: number; rotation: number }[];
  wires: { fromGate: number; fromPin: number; toGate: number; toPin: number; path: [number, number][] }[];
  starsEarned: number;
  bestSurvival: number;
}

export type SimState = 'idle' | 'running' | 'paused' | 'won' | 'lost';

export interface GameState {
  level: LevelDef;
  gates: PlacedGate[];
  wires: WireSegment[];
  simState: SimState;
  tick: number;
  elapsed: number;       // seconds of simulation
  heatMap: Float32Array;  // per-cell heat values
  signals: Map<number, Signal[]>; // gate uid → output signals per pin
  inputValues: number[];  // current tick input values
  outputValues: number[];  // current tick output values
  targetOutput: number[]; // current tick target
  correctTicks: number;   // consecutive correct output ticks
  totalCorrect: number;  // total correct ticks this run
  totalTicks: number;     // total ticks this run
  seed: number;
  failures: string[];    // recent failure messages
  nextGateUid: number;
  nextWireUid: number;
}

export interface SaveData {
  version: number;
  completed: string[];    // level IDs
  unlocked: string[];     // level IDs
  circuits: Record<string, CircuitSave>; // levelId → circuit
  hasSeenHelp: boolean;
}
