import type { GameState, LevelDef, GateType, SaveData } from './engine/types.js';
import { GATE_DEFS, TICKS_PER_SECOND } from './engine/gates.js';
import { createGameState, addGate, addWire, removeGate, removeWire, rotateGate, tickSimulation, resetSimulation, checkWin, checkLoss, canPlaceGate } from './engine/simulation.js';
import { loadSave, saveSave, loadCircuit, saveCircuit, completeLevel, unlockLevel, isCompleted, isUnlocked } from './engine/storage.js';
import { Renderer } from './ui/renderer.js';

interface LevelEntry extends LevelDef {}

export class App {
  private state: GameState | null = null;
  private save!: SaveData;
  private levels: LevelEntry[] = [];
  private renderer: Renderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private simTimer: number | null = null;
  private armedGate: GateType | null = null;
  private wireMode = false;
  private _dragState: { gateUid: number; startX: number; startY: number; moved: boolean } | null = null;

  static async bootstrap(): Promise<void> {
    const app = new App();
    await app.init();
    // Expose for debugging / smoke tests
    (window as unknown as { __app: App }).__app = app;
  }

  async init(): Promise<void> {
    this.save = loadSave();
    await this.loadLevels();
    this.buildDOM();
    this.bindElements();
    this.showMap();
    if (!this.save.hasSeenHelp) {
      this.showHelp();
    }
    window.addEventListener('resize', () => {
      if (this.renderer) this.renderer.resize();
      if (this.renderer) this.renderer.render();
    });
  }

  async loadLevels(): Promise<void> {
    try {
      const url = `${import.meta.env.BASE_URL}levels/levels.json`;
      const resp = await fetch(url);
      this.levels = await resp.json() as LevelEntry[];
    } catch {
      this.levels = [];
    }
    // Unlock first level if nothing unlocked
    if (this.levels.length > 0 && this.save.unlocked.length === 0) {
      unlockLevel(this.levels[0].id, this.save);
    }
  }

  private buildDOM(): void {
    const app = document.getElementById('app')!;
    app.innerHTML = `
      <div id="map-view" class="map-screen" style="display:none"></div>
      <div id="game-view" style="display:none">
        <div class="header">
          <button class="icon-btn" id="btn-back">← Map</button>
          <h1>Entropy Garden</h1>
          <span class="level-name" id="level-name"></span>
          <button class="icon-btn" id="btn-help">?</button>
        </div>
        <div class="game-area">
          <div class="goal-banner" id="goal-banner"></div>
          <div class="canvas-wrap"><canvas id="board"></canvas></div>
          <div class="bottom-panel">
            <div class="truth-table" id="truth-table"></div>
            <div class="status-bar" id="status-bar"></div>
            <div class="palette" id="palette"></div>
            <div class="controls" id="controls"></div>
          </div>
        </div>
      </div>
      <div class="modal-overlay" id="modal-overlay"><div class="modal-inner" id="modal-inner"></div></div>
      <div class="toast" id="toast"></div>
    `;
  }

  private bindElements(): void {
    const byId = (id: string) => document.getElementById(id)!;
    byId('btn-back').onclick = () => this.showMap();
    byId('btn-help').onclick = () => this.showHelp();
    byId('modal-overlay').onclick = (e) => {
      if (e.target === byId('modal-overlay')) this.hideModal();
    };
  }

  // === Map View ===
  showMap(): void {
    document.getElementById('map-view')!.style.display = '';
    document.getElementById('game-view')!.style.display = 'none';
    this.stopSimulation();

    const mapEl = document.getElementById('map-view')!;
    const gardens = new Map<string, LevelEntry[]>();
    for (const lvl of this.levels) {
      if (!gardens.has(lvl.garden)) gardens.set(lvl.garden, []);
      gardens.get(lvl.garden)!.push(lvl);
    }

    let html = '<div style="text-align:center;margin-bottom:16px"><h1 style="font-size:22px;color:var(--accent)">Entropy Garden</h1><p style="color:var(--text-dim);font-size:13px;margin-top:4px">Build circuits that survive decay</p></div>';
    for (const [, levels] of gardens) {
      html += `<div class="map-garden"><h3>${levels[0].gardenName}</h3><div class="map-levels">`;
      for (const lvl of levels) {
        const completed = isCompleted(lvl.id, this.save);
        const unlocked = isUnlocked(lvl.id, this.save, this.levels.map(l => l.id));
        const cls = completed ? 'completed' : unlocked ? 'unlocked' : 'locked';
        const check = completed ? '<span class="check">✓</span>' : '';
        html += `<div class="map-level ${cls}" data-level="${lvl.id}">${check}<span>${lvl.name}</span></div>`;
      }
      html += '</div></div>';
    }
    mapEl.innerHTML = html;

    mapEl.querySelectorAll('.map-level.unlocked').forEach(el => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.level!;
        this.startLevel(id);
      });
    });
  }

  // === Game View ===
  startLevel(levelId: string): void {
    const level = this.levels.find(l => l.id === levelId);
    if (!level) return;
    // Stop any running simulation from the previous level
    this.stopSimulation();
    document.getElementById('map-view')!.style.display = 'none';
    document.getElementById('game-view')!.style.display = '';
    document.getElementById('level-name')!.textContent = level.name;

    this.state = createGameState(level, Date.now() & 0xFFFFFFFF);

    // Load saved circuit if exists
    const saved = loadCircuit(levelId, this.save);
    if (saved) {
      for (const g of saved.gates) {
        addGate(this.state, g.type, g.x, g.y);
        const placed = this.state.gates[this.state.gates.length - 1];
        placed.rotation = g.rotation;
      }
      for (const w of saved.wires) {
        addWire(this.state, w.fromGate, w.fromPin, w.toGate, w.toPin, w.path);
      }
    }

    this.setupCanvas();
    this.buildPalette();
    this.buildControls();
    this.updateGoalBanner();
    this.updateTruthTable();
    this.updateStatus();

    // Defer render + resize to next frame so the browser has laid out game-view
    requestAnimationFrame(() => {
      if (this.renderer) {
        this.renderer.resize();
        this.renderer.render();
      }
    });

    if (!this.save.hasSeenHelp) this.showHelp();
  }

  private setupCanvas(): void {
    if (!this.state) return;
    this.canvas = document.getElementById('board') as HTMLCanvasElement;
    this.renderer = new Renderer(this.canvas);
    this.renderer.setState(this.state);
    this.renderer.resize();

    // Wire up renderer callbacks
    this.renderer.onPlaceGate = (x, y) => this.handlePlaceGate(x, y);
    this.renderer.onSelectGate = (uid) => this.handleSelectGate(uid);
    this.renderer.onRotateGate = (uid) => { if (this.state) rotateGate(this.state, uid); this.renderer?.render(); };
    this.renderer.onRemoveGate = (uid) => { if (this.state) { removeGate(this.state, uid); this.saveCircuitNow(); this.renderer?.render(); } };
    this.renderer.onRemoveWire = (uid) => { if (this.state) { removeWire(this.state, uid); this.saveCircuitNow(); this.renderer?.render(); } };
    this.renderer.onStartWire = (gateUid, pin) => this.handleStartWire(gateUid, pin);
    this.renderer.onCompleteWire = (toGateUid, toPin) => this.handleCompleteWire(toGateUid, toPin);

    this.bindCanvasEvents();
  }

  private bindCanvasEvents(): void {
    if (!this.canvas || !this.renderer) return;
    const canvas = this.canvas;
    const r = this.renderer;

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cell = r.getCellFromPointer(e.clientX, e.clientY);

      // If armed with a gate type, place it
      if (this.armedGate && this.state) {
        this.handlePlaceGate(cell.x, cell.y);
        r.render();
        return;
      }

      // Use distance-based hit detection
      const hitGate = r.getGateFromPointer(e.clientX, e.clientY);

      // In wire mode: handle wire connect/disconnect flow
      if (this.wireMode) {
        // If we have a pending wire and tap a different gate, complete the wire
        if (r.wireFrom && hitGate && hitGate.uid !== r.wireFrom.gateUid) {
          const def = GATE_DEFS[hitGate.type];
          if (def.inputs > 0 && this.state) {
            // Find the next available input pin on the target gate
            const usedPins = this.state.wires
              .filter(w => w.toGate === hitGate.uid)
              .map(w => w.toPin);
            const freePin = def.inputs > 1
              ? [0, 1].find(p => !usedPins.includes(p)) ?? 0
              : 0;
            this.handleCompleteWire(hitGate.uid, freePin);
          } else {
            // Target has no inputs — can't connect here
            r.wireFrom = null;
            r.wirePreviewTo = null;
          }
          // Don't auto-chain — let the user tap the next source manually
          r.wireFrom = null;
          r.wirePreviewTo = null;
          r.selectedGateUid = null; // clear selection so stray clicks don't delete
          r.render();
          return;
        }
        // No pending wire — start a new one from this gate
        if (hitGate) {
          const def = GATE_DEFS[hitGate.type];
          if (def.outputs > 0) {
            r.wireFrom = { gateUid: hitGate.uid, pin: 0 };
          }
          r.selectedGateUid = null; // don't select in wire mode
          r.render();
          return;
        }
        // Tapped empty space — cancel any pending wire
        if (r.wireFrom) {
          r.wireFrom = null;
          r.wirePreviewTo = null;
          r.render();
          return;
        }
        // Check wire deletion
        const wire = r.getWireFromPointer(e.clientX, e.clientY);
        if (wire && this.state) {
          removeWire(this.state, wire.uid);
          this.saveCircuitNow();
          r.render();
          return;
        }
        return;
      }

      // Not in wire mode: select gate, start drag, or delete wire
      if (hitGate) {
        r.selectedGateUid = hitGate.uid;
        // Start drag if movable
        if (hitGate.type !== 'INPUT' && hitGate.type !== 'OUTPUT' && hitGate.type !== 'BROKEN_NOT') {
          this._dragState = {
            gateUid: hitGate.uid,
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
          };
        }
        r.render();
        return;
      }

      // Check if tapping a wire (to delete)
      const wire = r.getWireFromPointer(e.clientX, e.clientY);
      if (wire && this.state) {
        removeWire(this.state, wire.uid);
        this.saveCircuitNow();
        r.render();
        return;
      }

      // Tapped empty space — deselect
      r.selectedGateUid = null;
      r.render();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.state) return;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      r._lastPointer = { x: px, y: py };
      // Update gate hover using distance-based detection
      const hoverGate = r.getGateFromPointer(e.clientX, e.clientY);
      r.hoverGateUid = hoverGate ? hoverGate.uid : null;

      // Handle drag-to-move (only when NOT in wire mode)
      if (!this.wireMode && this._dragState && this.state) {
        const dist = Math.hypot(e.clientX - this._dragState.startX, e.clientY - this._dragState.startY);
        if (dist > 10) {
          this._dragState.moved = true;
          const newCell = r.getCellFromPointer(e.clientX, e.clientY);
          const gate = this.state.gates.find(g => g.uid === this._dragState!.gateUid);
          if (gate) {
            const occupied = this.state.gates.some(g => g.uid !== gate.uid && g.x === newCell.x && g.y === newCell.y);
            if (!occupied && newCell.x >= 0 && newCell.y >= 0 &&
                newCell.x < this.state.level.grid.width && newCell.y < this.state.level.grid.height) {
              gate.x = newCell.x;
              gate.y = newCell.y;
              for (const w of this.state.wires) {
                if (w.fromGate === gate.uid || w.toGate === gate.uid) {
                  const fg = this.state.gates.find(g => g.uid === w.fromGate);
                  const tg = this.state.gates.find(g => g.uid === w.toGate);
                  if (fg && tg) {
                    w.path = [[fg.x, fg.y], [tg.x, fg.y], [tg.x, tg.y]];
                  }
                }
              }
            }
          }
          r.render();
          return;
        }
      }

      // Update wire preview if armed
      if (r.wireFrom) {
        r.wirePreviewTo = { x: px, y: py };
      }
      r.render();
    });

    canvas.addEventListener('pointerup', () => {
      if (this._dragState?.moved && this.state) {
        this.saveCircuitNow();
      }
      this._dragState = null;
      r.render();
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // === Gate placement ===
  private handlePlaceGate(x: number, y: number): void {
    if (!this.state || !this.armedGate) return;
    if (!canPlaceGate(this.state, x, y)) {
      this.toast('Cannot place gate there');
      return;
    }
    addGate(this.state, this.armedGate, x, y);
    this.armedGate = null;
    if (this.renderer) this.renderer.armedGateType = null;
    this.saveCircuitNow();
    this.renderer?.render();
    this.buildPalette();
  }

  private handleSelectGate(uid: number | null): void {
    if (this.renderer) this.renderer.selectedGateUid = uid;
    this.renderer?.render();
  }

  // === Wire drawing ===
  private handleStartWire(gateUid: number, pin: number): void {
    if (this.renderer) {
      this.renderer.wireFrom = { gateUid, pin };
    }
  }

  private handleCompleteWire(toGateUid: number, toPin: number): void {
    if (!this.state || !this.renderer?.wireFrom) return;
    const from = this.renderer.wireFrom;
    const fromGate = this.state.gates.find(g => g.uid === from.gateUid);
    const toGate = this.state.gates.find(g => g.uid === toGateUid);
    if (!fromGate || !toGate) return;

    // Simple L-shaped path
    const path: [number, number][] = [
      [fromGate.x, fromGate.y],
      [toGate.x, fromGate.y],
      [toGate.x, toGate.y],
    ];
    addWire(this.state, from.gateUid, from.pin, toGateUid, toPin, path);
    this.renderer.wireFrom = null;
    this.renderer.wirePreviewTo = null;
    this.saveCircuitNow();
    this.renderer.render();
  }

  // === Palette ===
  private buildPalette(): void {
    if (!this.state) return;
    const palette = document.getElementById('palette')!;
    const available = this.state.level.palette;
    let html = '<span class="palette-label">Gates:</span>';
    for (const type of available) {
      const def = GATE_DEFS[type];
      const armed = this.armedGate === type ? 'armed' : '';
      html += `<div class="gate-btn ${armed}" data-gate="${type}"><span class="symbol">${def.symbol}</span><span class="label">${def.label}</span></div>`;
    }
    // Tools
    html += `<div class="gate-btn ${this.wireMode ? 'armed' : ''}" data-tool="wire"><span class="symbol">⇄</span><span class="label">Wire</span></div>`;
    html += `<div class="gate-btn" data-tool="rotate"><span class="symbol">↻</span><span class="label">Rotate</span></div>`;
    html += `<div class="gate-btn" data-tool="delete"><span class="symbol">✕</span><span class="label">Delete</span></div>`;
    palette.innerHTML = html;

    palette.querySelectorAll('.gate-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const el = btn as HTMLElement;
        const gateType = el.dataset.gate;
        const tool = el.dataset.tool;
        if (gateType) {
          this.armedGate = this.armedGate === gateType ? null : gateType as GateType;
          this.wireMode = false; // selecting a gate turns off wire mode
          if (this.renderer) this.renderer.armedGateType = this.armedGate;
          if (this.renderer) this.renderer.wireFrom = null;
          this.buildPalette();
          this.renderer?.render();
        } else if (tool === 'wire') {
          this.wireMode = !this.wireMode;
          this.armedGate = null;
          if (this.renderer) this.renderer.armedGateType = null;
          if (!this.wireMode && this.renderer) {
            this.renderer.wireFrom = null;
            this.renderer.wirePreviewTo = null;
          }
          this.buildPalette();
          this.renderer?.render();
          this.toast(this.wireMode ? 'Wire mode on — tap a gate to start connecting' : 'Wire mode off');
        } else if (tool === 'rotate') {
          if (this.state && this.renderer?.selectedGateUid) {
            rotateGate(this.state, this.renderer.selectedGateUid);
            this.renderer.render();
          }
        } else if (tool === 'delete') {
          if (this.state && this.renderer?.selectedGateUid) {
            const gate = this.state.gates.find(g => g.uid === this.renderer!.selectedGateUid);
            if (gate && gate.type !== 'INPUT' && gate.type !== 'OUTPUT') {
              removeGate(this.state, this.renderer.selectedGateUid);
            }
            this.renderer.selectedGateUid = null;
            this.saveCircuitNow();
            this.renderer.render();
          }
        }
      });
    });
  }

  // === Controls ===
  private buildControls(): void {
    const controls = document.getElementById('controls')!;
    controls.innerHTML = `
      <button class="ctrl-btn primary" id="btn-run">▶ Run</button>
      <button class="ctrl-btn" id="btn-step">⏭ Step</button>
      <button class="ctrl-btn" id="btn-reset">↺ Reset</button>
      <button class="ctrl-btn" id="btn-clear">🗑 Clear</button>
    `;
    document.getElementById('btn-run')!.onclick = () => this.toggleRun();
    document.getElementById('btn-step')!.onclick = () => this.stepSim();
    document.getElementById('btn-reset')!.onclick = () => this.resetSim();
    document.getElementById('btn-clear')!.onclick = () => this.clearBoard();
  }

  private toggleRun(): void {
    if (!this.state) return;
    const btn = document.getElementById('btn-run')!;
    if (this.state.simState === 'running') {
      this.stopSimulation();
      btn.textContent = '▶ Run';
    } else {
      this.startSimulation();
      btn.textContent = '⏸ Pause';
    }
  }

  private startSimulation(): void {
    if (!this.state) return;
    this.state.simState = 'running';
    const interval = 1000 / TICKS_PER_SECOND;
    this.simTimer = window.setInterval(() => this.simTick(), interval);
  }

  private stopSimulation(): void {
    if (this.simTimer) {
      clearInterval(this.simTimer);
      this.simTimer = null;
    }
    if (this.state && this.state.simState === 'running') {
      this.state.simState = 'paused';
    }
    const btn = document.getElementById('btn-run');
    if (btn) btn.textContent = '▶ Run';
  }

  private simTick(): void {
    if (!this.state || !this.renderer) return;
    if (this.state.simState !== 'running') return;
    // Guard: if the timer was cleared but callback still queued
    if (!this.simTimer) return;
    tickSimulation(this.state);
    this.renderer.render();
    this.updateGoalBanner();
    this.updateTruthTable();
    this.updateStatus();

    if (checkWin(this.state)) {
      this.stopSimulation();
      this.handleWin();
    } else if (checkLoss(this.state)) {
      this.stopSimulation();
      this.handleLoss();
    }
  }

  private stepSim(): void {
    if (!this.state || !this.renderer) return;
    tickSimulation(this.state);
    this.renderer.render();
    this.updateGoalBanner();
    this.updateTruthTable();
    this.updateStatus();
  }

  private resetSim(): void {
    if (!this.state || !this.renderer) return;
    this.stopSimulation();
    // Rebuild gates from the original level — clean board, no user gates/wires
    const level = this.state.level;
    this.state.gates = [];
    this.state.wires = [];
    this.state.nextGateUid = 1;
    this.state.nextWireUid = 1;
    for (let i = 0; i < level.inputs.length; i++) {
      this.state.gates.push({
        uid: this.state.nextGateUid++, type: 'INPUT', x: 0, y: 1 + i, rotation: 0,
        drift: 0, noiseTicks: 0, lastOutput: 0, powered: true,
      });
    }
    for (let i = 0; i < level.outputs.length; i++) {
      this.state.gates.push({
        uid: this.state.nextGateUid++, type: 'OUTPUT', x: level.grid.width - 1, y: 1 + i, rotation: 0,
        drift: 0, noiseTicks: 0, lastOutput: 0, powered: true,
      });
    }
    if (level.prePlaced) {
      for (const pp of level.prePlaced) {
        this.state.gates.push({
          uid: this.state.nextGateUid++, type: pp.gate, x: pp.x, y: pp.y, rotation: 0,
          drift: pp.drift ?? 0, noiseTicks: 0, lastOutput: 0, powered: false,
        });
      }
    }
    resetSimulation(this.state);
    this.renderer.selectedGateUid = null;
    this.renderer.wireFrom = null;
    this.renderer.wirePreviewTo = null;
    this.renderer.render();
    this.updateGoalBanner();
    this.updateTruthTable();
    this.updateStatus();
  }

  private clearBoard(): void {
    if (!this.state || !this.renderer) return;
    this.stopSimulation();
    // Keep only input/output gates and pre-placed
    const keep = this.state.gates.filter(g => g.type === 'INPUT' || g.type === 'OUTPUT' || g.type === 'BROKEN_NOT');
    this.state.gates = keep;
    this.state.wires = [];
    resetSimulation(this.state);
    this.saveCircuitNow();
    this.renderer.render();
    this.updateGoalBanner();
    this.updateTruthTable();
    this.updateStatus();
  }

  // === Win/Loss ===
  private handleWin(): void {
    if (!this.state) return;
    const gateCount = this.state.gates.filter(g => g.type !== 'INPUT' && g.type !== 'OUTPUT' && g.type !== 'BROKEN_NOT').length;
    const stars = this.state.level.starGates;
    let starsEarned = 1; // functionality
    if (this.state.elapsed >= this.state.level.survivalTime) starsEarned = 2; // survival
    if (gateCount <= stars[2]) starsEarned = 3; // efficiency
    starsEarned = Math.max(starsEarned, 1);

    completeLevel(this.state.level.id, starsEarned, this.save);
    // Unlock next level
    const idx = this.levels.findIndex(l => l.id === this.state!.level.id);
    if (idx >= 0 && idx + 1 < this.levels.length) {
      unlockLevel(this.levels[idx + 1].id, this.save);
    }
    saveSave(this.save);

    const next = idx + 1 < this.levels.length ? this.levels[idx + 1] : null;
    this.showModal(`
      <h2>✓ Circuit Survived!</h2>
      <p>Gates used: ${gateCount} / ${stars[2]} for efficiency star</p>
      <p>Survival time: ${this.state.elapsed.toFixed(1)}s / ${this.state.level.survivalTime}s</p>
      <p>Correct ticks: ${this.state.totalCorrect} / ${this.state.totalTicks}</p>
      <p style="color:var(--accent);font-size:16px">${'★'.repeat(starsEarned)}${'☆'.repeat(3 - starsEarned)}</p>
      <div class="modal-buttons">
        ${next ? `<button class="ctrl-btn primary" id="modal-next">Next Level</button>` : ''}
        <button class="ctrl-btn" id="modal-retry">Replay</button>
        <button class="ctrl-btn" id="modal-map">Map</button>
      </div>
    `);
    if (next) document.getElementById('modal-next')!.onclick = () => { this.hideModal(); this.startLevel(next.id); };
    document.getElementById('modal-retry')!.onclick = () => { this.hideModal(); this.resetSim(); };
    document.getElementById('modal-map')!.onclick = () => { this.hideModal(); this.showMap(); };
  }

  private handleLoss(): void {
    if (!this.state) return;
    this.showModal(`
      <h2 style="color:var(--accent-red)">✕ Circuit Failed</h2>
      <p>Your circuit didn't maintain correct output long enough.</p>
      <p>Correct ticks: ${this.state.totalCorrect} / ${this.state.totalTicks}</p>
      <p>Survival time: ${this.state.elapsed.toFixed(1)}s / ${this.state.level.survivalTime}s</p>
      <div class="modal-buttons">
        <button class="ctrl-btn primary" id="modal-retry">Try Again</button>
        <button class="ctrl-btn" id="modal-map">Map</button>
      </div>
    `);
    document.getElementById('modal-retry')!.onclick = () => { this.hideModal(); this.resetSim(); };
    document.getElementById('modal-map')!.onclick = () => { this.hideModal(); this.showMap(); };
  }

  // === Goal Banner ===
  private updateGoalBanner(): void {
    if (!this.state) return;
    const banner = document.getElementById('goal-banner')!;
    const lvl = this.state.level;

    // Build truth table summary: inputs → target outputs
    const inputLabels = lvl.inputs.map(i => i.id).join(', ');
    const outputLabels = lvl.outputs.map(o => o.id).join(', ');
    const targetRows = lvl.outputs[0]?.target ?? [];
    const targetStr = targetRows.length <= 4 ? targetRows.join('') : targetRows.slice(0, 4).join('') + '…';

    // Count user-placed gates (exclude INPUT/OUTPUT/BROKEN_NOT)
    const gateCount = this.state.gates.filter(
      g => g.type !== 'INPUT' && g.type !== 'OUTPUT' && g.type !== 'BROKEN_NOT'
    ).length;
    const efficiencyTarget = lvl.starGates[2] ?? 0;

    // Build pills
    let pills = '';
    pills += `<span class="goal-pill survive">⏱ ${this.state.elapsed.toFixed(1)}/${lvl.survivalTime}s</span>`;
    pills += `<span class="goal-pill gates">⚙ ${gateCount}/${efficiencyTarget}</span>`;
    if (lvl.startingEntropy > 0) {
      pills += `<span class="goal-pill warn">⚡ ${Math.round(lvl.startingEntropy * 100)}% entropy</span>`;
    }

    // Build description text
    const desc = lvl.description;
    const ioStr = `Input: ${inputLabels} → Target: ${outputLabels} = [${targetStr}]`;

    banner.innerHTML = `
      <span class="goal-icon">🎯</span>
      <span class="goal-text"><strong>${lvl.name}</strong> — ${desc}<br><span style="color:var(--text-dim);font-size:11px">${ioStr}</span></span>
      <span class="goal-pills">${pills}</span>
    `;
  }

  // === Truth Table ===
  private updateTruthTable(): void {
    if (!this.state) return;
    const tt = document.getElementById('truth-table')!;
    let html = '';
    // Inputs
    for (let i = 0; i < this.state.level.inputs.length; i++) {
      const inp = this.state.level.inputs[i];
      const val = this.state.inputValues[i] ?? 0;
      html += `<div class="tt-section"><span class="tt-label">${inp.id}</span><div class="tt-row">`;
      html += `<span class="tt-cell ${val ? 'on' : 'off'}">${val}</span>`;
      html += `</div></div>`;
    }
    // Outputs
    for (let i = 0; i < this.state.level.outputs.length; i++) {
      const out = this.state.level.outputs[i];
      const actual = this.state.outputValues[i] ?? 0;
      const target = this.state.targetOutput[i] ?? 0;
      const correct = actual === target;
      html += `<div class="tt-section"><span class="tt-label">${out.id}</span><div class="tt-row">`;
      html += `<span class="tt-cell ${actual ? 'on' : 'off'}">${actual}</span>`;
      html += `<span class="tt-cell ${correct ? '' : 'miss'}">${target}</span>`;
      html += `</div></div>`;
    }
    tt.innerHTML = html;
  }

  // === Status Bar ===
  private updateStatus(): void {
    if (!this.state) return;
    const bar = document.getElementById('status-bar')!;
    const pct = this.state.level.survivalTime > 0 ? Math.min(100, (this.state.elapsed / this.state.level.survivalTime) * 100) : 0;
    bar.innerHTML = `
      <span>Time: <span class="val">${this.state.elapsed.toFixed(1)}s / ${this.state.level.survivalTime}s</span></span>
      <span>Tick: <span class="val">${this.state.tick}</span></span>
      <span>Correct: <span class="val">${this.state.totalCorrect}/${this.state.totalTicks}</span></span>
      <span>Gates: <span class="val">${this.state.gates.filter(g => g.type !== 'INPUT' && g.type !== 'OUTPUT' && g.type !== 'BROKEN_NOT').length}</span></span>
      <div style="flex:1;height:6px;background:var(--bg-card);border-radius:3px;margin-left:8px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:var(--accent);transition:width 0.1s"></div>
      </div>
    `;
  }

  // === Save ===
  private saveCircuitNow(): void {
    if (!this.state) return;
    // Save user-placed gates (not INPUT/OUTPUT which are auto-created)
    const gates = this.state.gates
      .filter(g => g.type !== 'INPUT' && g.type !== 'OUTPUT')
      .map(g => ({ type: g.type, x: g.x, y: g.y, rotation: g.rotation }));
    // Save ALL wires with their UIDs — UIDs are deterministic:
    // createGameState assigns INPUT=1,2.. OUTPUT=N+1,N+2.. then addGate continues sequentially
    const wires = this.state.wires
      .map(w => ({ fromGate: w.fromGate, fromPin: w.fromPin, toGate: w.toGate, toPin: w.toPin, path: w.path }));
    saveCircuit(this.state.level.id, { levelId: this.state.level.id, gates, wires, starsEarned: 0, bestSurvival: 0 }, this.save);
  }

  // === Help ===
  private showHelp(): void {
    this.save.hasSeenHelp = true;
    saveSave(this.save);

    // Build gate reference cards
    const gateRef = [
      { sym: '&', label: 'AND', color: '#4a9eff', desc: 'Output is 1 only if both inputs are 1. X acts as 1 (risky).' },
      { sym: '≥1', label: 'OR', color: '#4a9eff', desc: 'Output is 1 if either input is 1. X acts as 0.' },
      { sym: '!', label: 'NOT', color: '#4a9eff', desc: 'Inverts input: 1→0, 0→1. Adds 1 tick delay.' },
      { sym: '⊕', label: 'XOR', color: '#52d4a8', desc: 'Output is 1 if inputs differ. Most stable gate.' },
      { sym: '⊼', label: 'NAND', color: '#f0a830', desc: 'AND then NOT. Versatile but runs hot.' },
      { sym: '◷', label: 'CLOCK', color: '#d4696b', desc: 'Pulses 0/1 at a fixed interval. No inputs.' },
      { sym: '▷', label: 'BUFFER', color: '#a06ed4', desc: 'Passes signal through. Cleans weak (X) to last known value.' },
      { sym: '❄', label: 'COOLER', color: '#6bcfff', desc: 'Reduces heat in 3×3 area. Place near dense gates.' },
      { sym: '≡', label: 'REDUNDANT', color: '#e8d05c', desc: 'Majority-vote of two inputs. Very resilient, very large.' },
    ];
    let gateRefHtml = '';
    for (const g of gateRef) {
      gateRefHtml += `<div class="gate-ref-item"><span class="gate-sym" style="background:${g.color}22;color:${g.color};border:1px solid ${g.color}">${g.sym}</span><div><div>${g.label}</div><div class="gate-desc">${g.desc}</div></div></div>`;
    }

    this.showModal(`
      <h2>Entropy Garden</h2>
      <p><strong>Build logic circuits that survive decay.</strong></p>

      <div class="help-section">
        <h3>How to Play</h3>
        <p>1. <strong>Place gates</strong> — Tap a gate in the palette, then tap a grid cell to place it. <strong>Drag a placed gate</strong> to move it to a new cell.</p>
        <p>2. <strong>Wire gates</strong> — Tap the <strong>⇄ Wire</strong> button to enter Wire mode. Tap a gate with an output to arm a wire (blue pulsing ring appears), then tap a target gate with an input to connect them. Each connection is a separate tap: arm from source, then tap target. Tap empty space to cancel. For gates with two inputs, tap the source again then tap the gate to add the second input wire. Turn Wire mode off to drag gates again.</p>
        <p>3. <strong>Run the simulation</strong> — Press Run. The circuit must produce the correct output for the full survival time shown in the goal banner.</p>
        <p>4. <strong>Decay happens</strong> — Gates drift (⚡) and wires corrode over time. Use <strong style="color:#a06ed4">BUFFER</strong> to refresh weak signals and <strong style="color:#6bcfff">COOLER</strong> to reduce heat.</p>
        <p>5. <strong>Delete</strong> — Tap a wire to remove it. Select a gate (tap it), then tap the Delete button to remove it. Input/Output gates cannot be deleted.</p>
        <p>6. <strong>Reset</strong> — Clears all user-placed gates and wires, restoring the board to its initial state.</p>
      </div>

      <div class="help-section">
        <h3>Gate Reference</h3>
        <div class="gate-ref">${gateRefHtml}</div>
      </div>

      <div class="help-section">
        <h3>Example: A NOT Circuit</h3>
        <p>Input <strong>A</strong> passes through a <strong>NOT</strong> gate to produce output <strong>Y</strong>. The truth table shows every input value and its inverted result:</p>
        <div class="help-example">
          <div class="ex-node">
            <div class="ex-gate" style="border-color:#4ade80;color:#4ade80;background:#4ade8022">▶</div>
            <span class="ex-label">A (input)</span>
          </div>
          <div class="ex-wire on"></div>
          <div class="ex-node">
            <div class="ex-gate" style="border-color:#4a9eff;color:#4a9eff;background:#4a9eff22">!</div>
            <span class="ex-label">NOT</span>
          </div>
          <div class="ex-wire on"></div>
          <div class="ex-node">
            <div class="ex-gate" style="border-color:#4ade80;color:#4ade80;background:#4ade8022">◀</div>
            <span class="ex-label">Y (output)</span>
          </div>
        </div>
        <div class="ex-tt">
          <span style="color:var(--text-dim)">A:</span>
          <div class="ex-tt-row">
            <span class="ex-tt-cell on">1</span>
            <span class="ex-tt-cell off">0</span>
            <span class="ex-tt-cell on">1</span>
            <span class="ex-tt-cell off">0</span>
          </div>
          <span class="ex-arrow">→</span>
          <span style="color:var(--text-dim)">Y:</span>
          <div class="ex-tt-row">
            <span class="ex-tt-cell off target">0</span>
            <span class="ex-tt-cell on target">1</span>
            <span class="ex-tt-cell off target">0</span>
            <span class="ex-tt-cell on target">1</span>
          </div>
        </div>
        <p style="font-size:12px;color:var(--text-dim)">When A=1, NOT outputs 0. When A=0, NOT outputs 1. The goal is to match the target column for the entire survival duration.</p>
      </div>

      <div class="help-section">
        <h3>Reading the Interface</h3>
        <p><strong>Signals:</strong> <span style="color:var(--accent)">Green = 1</span>, <span style="color:var(--accent-blue)">Blue = 0</span>, <span style="color:#888">Gray = weak (X)</span></p>
        <p><strong>Goal banner:</strong> Shows the level objective, input→target mapping, and live status pills (survival time, gate count, entropy).</p>
        <p><strong>Truth table:</strong> Bottom panel shows current input (left), actual output (middle), and target (right). Red = mismatch.</p>
      </div>

      <div class="modal-buttons">
        <button class="ctrl-btn primary" id="modal-close">Start Building</button>
      </div>
    `);
    document.getElementById('modal-close')!.onclick = () => this.hideModal();
  }

  // === Modal ===
  private showModal(html: string): void {
    const overlay = document.getElementById('modal-overlay')!;
    const inner = document.getElementById('modal-inner')!;
    inner.innerHTML = html;
    overlay.classList.add('active');
  }

  private hideModal(): void {
    document.getElementById('modal-overlay')!.classList.remove('active');
  }

  // === Toast ===
  private toast(msg: string): void {
    const el = document.getElementById('toast')!;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2000);
  }
}
