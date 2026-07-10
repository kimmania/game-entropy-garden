import type { SaveData, CircuitSave } from './types.js';

const SAVE_KEY = 'entropy-garden-save';
const SAVE_VERSION = 1;

export function createSave(): SaveData {
  return {
    version: SAVE_VERSION,
    completed: [],
    unlocked: [],
    circuits: {},
    hasSeenHelp: false,
  };
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return createSave();
    const parsed = JSON.parse(raw) as SaveData;
    if (parsed.version !== SAVE_VERSION) return createSave();
    return {
      ...createSave(),
      ...parsed,
    };
  } catch {
    return createSave();
  }
}

export function saveSave(data: SaveData): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    // storage full or unavailable
  }
}

export function saveCircuit(levelId: string, circuit: CircuitSave, data: SaveData): void {
  data.circuits[levelId] = circuit;
  saveSave(data);
}

export function loadCircuit(levelId: string, data: SaveData): CircuitSave | null {
  return data.circuits[levelId] ?? null;
}

export function completeLevel(levelId: string, stars: number, data: SaveData): void {
  if (!data.completed.includes(levelId)) {
    data.completed.push(levelId);
  }
  const existing = data.circuits[levelId];
  if (existing) {
    existing.starsEarned = Math.max(existing.starsEarned, stars);
  }
  saveSave(data);
}

export function unlockLevel(levelId: string, data: SaveData): void {
  if (!data.unlocked.includes(levelId)) {
    data.unlocked.push(levelId);
  }
  saveSave(data);
}

export function isCompleted(levelId: string, data: SaveData): boolean {
  return data.completed.includes(levelId);
}

export function isUnlocked(levelId: string, data: SaveData, allLevels: string[]): boolean {
  if (levelId === allLevels[0]) return true;
  return data.unlocked.includes(levelId);
}
