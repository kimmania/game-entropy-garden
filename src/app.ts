import type { GameState, LevelDef, GateType, SaveData } from './engine/types.js';
import { GATE_DEFS, TICKS_PER_SECOND } from './engine/gates.js';
import { createGameState, addGate, addWire, removeGate, removeWire, rotateGate, tickSimulation, resetSimulation, checkWin, checkLoss, canPlaceGate, getGateAt } from './engine/simulation.js';
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

  static async bootstrap(): Promise<void> {
    const app = new App();
    await app.init();
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
    this.updateTruthTable();
    this.updateStatus();
    this.renderer?.render();

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
      const cell = r.getCellFromPointer(e.clientX, e.clientY);
      r.hoverCell = cell;

      // If armed with a gate type, place it
      if (this.armedGate && this.state) {
        this.handlePlaceGate(cell.x, cell.y);
        r.render();
        return;
      }

      // Check if tapping a gate
      const gate = getGateAt(this.state!, cell.x, cell.y);
      if (gate) {
        r.selectedGateUid = gate.uid;
        // Start wire from gate's output
        const def = GATE_DEFS[gate.type];
        if (def.outputs > 0) {
          r.wireFrom = { gateUid: gate.uid, pin: 0 };
        }
        r.render();
        return;
      }

      // Check if tapping another gate (to complete wire)
      if (r.wireFrom && this.state) {
        const targetGate = getGateAt(this.state, cell.x, cell.y);
        if (targetGate && targetGate.uid !== r.wireFrom.gateUid) {
          const def = GATE_DEFS[targetGate.type];
          if (def.inputs > 0) {
            this.handleCompleteWire(targetGate.uid, 0);
          }
        }
        r.wireFrom = null;
        r.wirePreviewTo = null;
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
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.state) return;
      const rect = canvas.getBoundingClientRect();
      r.hoverCell = r.getCellFromPointer(e.clientX, e.clientY);
      if (r.wireFrom) {
        r.wirePreviewTo = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }
      r.render();
    });

    canvas.addEventListener('pointerup', () => {
      // Wire completion on pointerup is handled in pointerdown
      r.wirePreviewTo = null;
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
          if (this.renderer) this.renderer.armedGateType = this.armedGate;
          this.buildPalette();
          this.renderer?.render();
        } else if (tool === 'rotate') {
          if (this.state && this.renderer?.selectedGateUid) {
            rotateGate(this.state, this.renderer.selectedGateUid);
            this.renderer.render();
          }
        } else if (tool === 'delete') {
          if (this.state && this.renderer?.selectedGateUid) {
            removeGate(this.state, this.renderer.selectedGateUid);
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
    tickSimulation(this.state);
    this.renderer.render();
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
    this.updateTruthTable();
    this.updateStatus();
  }

  private resetSim(): void {
    if (!this.state || !this.renderer) return;
    this.stopSimulation();
    resetSimulation(this.state);
    this.renderer.render();
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
    const gates = this.state.gates
      .filter(g => g.type !== 'INPUT' && g.type !== 'OUTPUT')
      .map(g => ({ type: g.type, x: g.x, y: g.y, rotation: g.rotation }));
    const wires = this.state.wires
      .filter(w => {
        const fg = this.state!.gates.find(g => g.uid === w.fromGate);
        const tg = this.state!.gates.find(g => g.uid === w.toGate);
        return fg && tg && fg.type !== 'OUTPUT' && tg.type !== 'INPUT';
      })
      .map(w => ({ fromGate: w.fromGate, fromPin: w.fromPin, toGate: w.toGate, toPin: w.toPin, path: w.path }));
    saveCircuit(this.state.level.id, { levelId: this.state.level.id, gates, wires, starsEarned: 0, bestSurvival: 0 }, this.save);
  }

  // === Help ===
  private showHelp(): void {
    this.save.hasSeenHelp = true;
    saveSave(this.save);
    this.showModal(`
      <h2>Entropy Garden</h2>
      <p><strong>Build logic circuits that survive decay.</strong></p>
      <p><strong>How to play:</strong></p>
      <p>1. <strong>Place gates</strong> — Tap a gate in the palette, then tap a grid cell to place it.</p>
      <p>2. <strong>Wire gates</strong> — Tap a gate's output (right side), then tap another gate's input (left side) to connect them.</p>
      <p>3. <strong>Run the simulation</strong> — Press Run to start. The circuit must produce correct output for the full survival time.</p>
      <p>4. <strong>Decay happens</strong> — Gates drift and wires corrode over time. Use BUFFERS to refresh signals and COOLERS to reduce heat.</p>
      <p>5. <strong>Delete</strong> — Tap a wire to delete it. Select a gate and press Delete to remove it.</p>
      <p><strong>Signals:</strong> Green = 1, Blue = 0, Gray = weak (X)</p>
      <p><strong>Truth table:</strong> Bottom panel shows current input (left), actual output (middle), and target (right). Red = mismatch.</p>
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
