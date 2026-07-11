import type { GameState, PlacedGate, WireSegment, Signal } from '../engine/types.js';
import { GATE_DEFS } from '../engine/gates.js';

const CELL = 64; // base cell size in px
const PAD = 16;  // canvas padding

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cellSize = CELL;
  private panX = 0;
  private panY = 0;
  private zoom = 1;

  // interaction state
  selectedGateUid: number | null = null;
  armedGateType: string | null = null;
  wireFrom: { gateUid: number; pin: number } | null = null;
  wirePreviewTo: { x: number; y: number } | null = null;
  hoverGateUid: number | null = null;
  hoverWireUid: number | null = null;

  // callbacks
  onPlaceGate: ((x: number, y: number) => void) | null = null;
  onSelectGate: ((uid: number | null) => void) | null = null;
  onRotateGate: ((uid: number) => void) | null = null;
  onRemoveGate: ((uid: number) => void) | null = null;
  onStartWire: ((gateUid: number, pin: number) => void) | null = null;
  onCompleteWire: ((toGateUid: number, toPin: number) => void) | null = null;
  onRemoveWire: ((uid: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const parent = this.canvas.parentElement;
    const rect = parent ? parent.getBoundingClientRect() : this.canvas.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;
    this.canvas.width = Math.floor(cssW * this.dpr);
    this.canvas.height = Math.floor(cssH * this.dpr);
    // Do NOT set canvas.style.width/height — let CSS flex layout control it
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.fitZoom(cssW, cssH);
  }

  private fitZoom(w?: number, h?: number): void {
    const cssW = w ?? this.canvas.clientWidth;
    const cssH = h ?? this.canvas.clientHeight;
    const grid = this._stateGrid();
    if (!grid) return;
    const totalW = grid.width * this.cellSize + PAD * 2;
    const totalH = grid.height * this.cellSize + PAD * 2;
    this.zoom = Math.min((cssW - 20) / totalW, (cssH - 20) / totalH, 1.5);
    this.panX = (cssW - totalW * this.zoom) / 2;
    this.panY = (cssH - totalH * this.zoom) / 2;
  }

  private _state: GameState | null = null;
  _lastPointer: { x: number; y: number } | null = null;

  setState(state: GameState): void {
    this._state = state;
    this.resize();
  }

  private _stateGrid(): { width: number; height: number } | null {
    if (!this._state) return null;
    return this._state.level.grid;
  }

  private toScreen(gx: number, gy: number): { x: number; y: number } {
    return {
      x: this.panX + (gx * this.cellSize + PAD) * this.zoom,
      y: this.panY + (gy * this.cellSize + PAD) * this.zoom,
    };
  }

  private toGrid(sx: number, sy: number): { x: number; y: number } {
    const gx = Math.floor(((sx - this.panX) / this.zoom - PAD) / this.cellSize);
    const gy = Math.floor(((sy - this.panY) / this.zoom - PAD) / this.cellSize);
    return { x: gx, y: gy };
  }

  getCellFromPointer(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return this.toGrid(clientX - rect.left, clientY - rect.top);
  }

  getGateFromPointer(clientX: number, clientY: number): PlacedGate | null {
    if (!this._state) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    // Distance-based hit detection: check each gate's center
    const hitRadius = (this.cellSize * this.zoom) * 0.55; // slightly generous
    for (let i = this._state.gates.length - 1; i >= 0; i--) {
      const g = this._state.gates[i];
      const center = this.toScreen(g.x + 0.5, g.y + 0.5);
      const dx = px - center.x;
      const dy = py - center.y;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) return g;
    }
    return null;
  }

  getWireFromPointer(clientX: number, clientY: number): WireSegment | null {
    if (!this._state) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const threshold = 12;
    for (const w of this._state.wires) {
      for (let i = 0; i < w.path.length - 1; i++) {
        const a = this.toScreen(w.path[i][0] + 0.5, w.path[i][1] + 0.5);
        const b = this.toScreen(w.path[i + 1][0] + 0.5, w.path[i + 1][1] + 0.5);
        const dist = this.distToSegment(px, py, a.x, a.y, b.x, b.y);
        if (dist < threshold) return w;
      }
    }
    return null;
  }

  private distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    if (len === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  render(): void {
    if (!this._state) return;
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    ctx.fillStyle = '#0a1208';
    ctx.fillRect(0, 0, w, h);
    this.drawGrid();
    this.drawHeat();
    this.drawWires();
    this.drawGates();
    this.drawHover();
  }

  private drawGrid(): void {
    if (!this._state) return;
    const ctx = this.ctx;
    const grid = this._state.level.grid;
    ctx.strokeStyle = 'rgba(80, 120, 60, 0.15)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= grid.width; x++) {
      const a = this.toScreen(x, 0);
      const b = this.toScreen(x, grid.height);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let y = 0; y <= grid.height; y++) {
      const a = this.toScreen(0, y);
      const b = this.toScreen(grid.width, y);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  private drawHeat(): void {
    if (!this._state) return;
    const ctx = this.ctx;
    const grid = this._state.level.grid;
    const heat = this._state.heatMap;
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        const idx = y * grid.width + x;
        const h = heat[idx];
        if (h > 0.5) {
          const a = this.toScreen(x, y);
          const alpha = Math.min(0.35, h * 0.05);
          ctx.fillStyle = `rgba(255, 80, 30, ${alpha})`;
          ctx.fillRect(a.x, a.y, this.cellSize * this.zoom, this.cellSize * this.zoom);
        }
      }
    }
  }

  private drawWires(): void {
    if (!this._state) return;
    const ctx = this.ctx;
    for (const wire of this._state.wires) {
      const isHover = this.hoverWireUid === wire.uid;
      const fromG = this._state.gates.find(g => g.uid === wire.fromGate);
      const toG = this._state.gates.find(g => g.uid === wire.toGate);
      if (!fromG || !toG) continue;

      // signal color
      const sigs = this._state.signals.get(wire.fromGate);
      const sig: Signal = sigs && wire.fromPin < sigs.length ? sigs[wire.fromPin] : 0.5;
      const color = sig === 1 ? '#4ade80' : sig === 0 ? '#5588ff' : '#888';

      ctx.strokeStyle = isHover ? '#ff4444' : color;
      ctx.lineWidth = isHover ? 4 : 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      for (let i = 0; i < wire.path.length; i++) {
        const p = this.toScreen(wire.path[i][0] + 0.5, wire.path[i][1] + 0.5);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();

      // corrosion effect - dashed overlay
      if (wire.corrosion > 0.2) {
        ctx.strokeStyle = `rgba(120, 80, 40, ${wire.corrosion * 0.6})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (let i = 0; i < wire.path.length; i++) {
          const p = this.toScreen(wire.path[i][0] + 0.5, wire.path[i][1] + 0.5);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // wire preview
    if (this.wireFrom && this.wirePreviewTo) {
      const fromG = this._state.gates.find(g => g.uid === this.wireFrom!.gateUid);
      if (fromG) {
        const a = this.toScreen(fromG.x + 0.5, fromG.y + 0.5);
        ctx.strokeStyle = 'rgba(120, 200, 255, 0.5)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(this.wirePreviewTo.x, this.wirePreviewTo.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  private drawGates(): void {
    if (!this._state) return;
    const ctx = this.ctx;
    const sz = this.cellSize * this.zoom * 0.85;
    for (const gate of this._state.gates) {
      const def = GATE_DEFS[gate.type];
      const pos = this.toScreen(gate.x, gate.y);
      const cx = pos.x + this.cellSize * this.zoom / 2;
      const cy = pos.y + this.cellSize * this.zoom / 2;
      const isSelected = this.selectedGateUid === gate.uid;

      // gate body
      ctx.fillStyle = def.color + '33';
      ctx.strokeStyle = isSelected ? '#fff' : def.color;
      ctx.lineWidth = isSelected ? 3 : 2;
      const r = 6;
      this.roundRect(cx - sz / 2, cy - sz / 2, sz, sz, r);
      ctx.fill();
      ctx.stroke();

      // symbol
      ctx.fillStyle = def.color;
      ctx.font = `${Math.max(10, sz * 0.3)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.symbol, cx, cy);

      // drift indicator
      if (gate.drift > 0.1) {
        ctx.fillStyle = `rgba(255, 100, 50, ${gate.drift * 0.7})`;
        ctx.font = `${Math.max(8, sz * 0.15)}px monospace`;
        ctx.fillText(`${Math.round(gate.drift * 100)}%`, cx, cy + sz * 0.3);
      }

      // noise indicator
      if (gate.noiseTicks > 0) {
        ctx.fillStyle = '#ff4444';
        ctx.font = `${Math.max(8, sz * 0.15)}px monospace`;
        ctx.fillText('⚡', cx, cy - sz * 0.3);
      }

      // output pin dot
      const outDef = def.outputs;
      if (outDef > 0) {
        const sigs = this._state.signals.get(gate.uid);
        const sig: Signal = sigs && sigs.length > 0 ? sigs[0] : 0.5;
        ctx.fillStyle = sig === 1 ? '#4ade80' : sig === 0 ? '#5588ff' : '#888';
        ctx.beginPath();
        ctx.arc(cx + sz / 2, cy, 4 * this.zoom, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawHover(): void {
    if (!this._state) return;
    const ctx = this.ctx;
    const sz = this.cellSize * this.zoom;

    // If armed with a gate type, show hover at the grid cell under the pointer
    if (this.armedGateType && this._lastPointer) {
      const cell = this.toGrid(this._lastPointer.x, this._lastPointer.y);
      if (cell.x >= 0 && cell.y >= 0 && cell.x < this._state.level.grid.width && cell.y < this._state.level.grid.height) {
        const pos = this.toScreen(cell.x, cell.y);
        ctx.strokeStyle = 'rgba(120, 200, 255, 0.6)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(pos.x + 2, pos.y + 2, sz - 4, sz - 4);
        ctx.setLineDash([]);
      }
      return;
    }

    // Otherwise highlight the gate under the pointer
    if (this.hoverGateUid === null) return;
    const gate = this._state.gates.find(g => g.uid === this.hoverGateUid);
    if (!gate) return;
    const pos = this.toScreen(gate.x, gate.y);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(pos.x + 2, pos.y + 2, sz - 4, sz - 4);
    ctx.setLineDash([]);
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}
