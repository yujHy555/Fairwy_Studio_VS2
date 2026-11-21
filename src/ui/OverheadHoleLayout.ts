import { Vector3 } from '@babylonjs/core';
import { GolfHole, ClubSpec } from '../core/Types';
import { SurfaceType } from '../core/Constants';
import { StampedFeatureRecord } from '../terrain/TerrainGrid';

export interface OverheadLayoutData {
  hole: GolfHole;
  ballPos: { x: number; y: number; z: number } | Vector3;
  pinPos: { x: number; y: number; z: number } | Vector3;
  aimTargetPos?: { x: number; y: number; z: number } | Vector3;
  aimAzimuthDeg: number;
  features: StampedFeatureRecord[];
  club: ClubSpec;
  terrainWidth: number;
  terrainLength: number;
  strokes: number;
}

export class OverheadHoleLayout {
  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private isMinimized: boolean = false;
  private animFrameId: number | null = null;
  private pulsePhase: number = 0;
  private viewMode: 'graphic' | 'radar' = 'graphic';
  private showDistanceGraphic: boolean = false;
  private modeControlsBound: boolean = false;
  private onOpenCourseGuide?: () => void;
  private rulerBound: boolean = false;
  private isRulerDragging: boolean = false;
  private rulerStart: { x: number; y: number } | null = null;
  private rulerEnd: { x: number; y: number } | null = null;
  private lastRulerHoleNum: number | null = null;

  public setOnOpenCourseGuide(cb: () => void) {
    this.onOpenCourseGuide = cb;
  }

  public setViewMode(mode: 'graphic' | 'radar') {
    this.viewMode = mode;
    if (this.lastData) {
      this.syncOverheadViewUI(this.lastData.hole);
    }
  }

  public toggleDistanceGraphic(force?: boolean) {
    this.showDistanceGraphic = force !== undefined ? force : !this.showDistanceGraphic;
    if (this.showDistanceGraphic) {
      this.viewMode = 'graphic';
    }
    if (this.lastData) {
      this.syncOverheadViewUI(this.lastData.hole);
    }
  }

  private ensureModeControlsBound() {
    if (this.modeControlsBound) return;
    const btnGraphic = document.getElementById('btn-overhead-mode-graphic');
    const btnRadar = document.getElementById('btn-overhead-mode-radar');
    const btnDist = document.getElementById('btn-overhead-dist-toggle');
    const btnExpand = document.getElementById('btn-overhead-expand-guide');
    if (!btnGraphic && !btnRadar) return;

    this.modeControlsBound = true;
    btnGraphic?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setViewMode('graphic');
    });
    btnRadar?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setViewMode('radar');
    });
    btnDist?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDistanceGraphic();
    });
    btnExpand?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onOpenCourseGuide?.();
    });
  }

  private syncOverheadViewUI(hole: GolfHole) {
    this.ensureModeControlsBound();

    const hasGraphic = Boolean(hole.overheadImageUrl);
    const hasDist = Boolean(hole.distanceGuideImageUrl);
    const effectiveMode: 'graphic' | 'radar' = hasGraphic ? this.viewMode : 'radar';

    const graphicWrap = document.getElementById('overhead-graphic-wrap') as HTMLElement | null;
    const imgEl = document.getElementById('overhead-hole-img') as HTMLImageElement | null;
    const radarCanvas = document.getElementById('overhead-hole-canvas') as HTMLCanvasElement | null;
    const btnGraphic = document.getElementById('btn-overhead-mode-graphic') as HTMLButtonElement | null;
    const btnRadar = document.getElementById('btn-overhead-mode-radar') as HTMLButtonElement | null;
    const btnDist = document.getElementById('btn-overhead-dist-toggle') as HTMLButtonElement | null;

    if (btnGraphic) {
      btnGraphic.disabled = !hasGraphic;
      btnGraphic.style.display = hasGraphic ? 'inline-flex' : 'none';
      btnGraphic.classList.toggle('active', effectiveMode === 'graphic');
    }
    if (btnRadar) {
      btnRadar.classList.toggle('active', effectiveMode === 'radar');
    }
    if (btnDist) {
      btnDist.disabled = !hasDist;
      btnDist.style.display = hasDist && effectiveMode === 'graphic' ? 'inline-flex' : 'none';
      btnDist.classList.toggle('active', this.showDistanceGraphic);
    }

    if (effectiveMode === 'graphic' && hasGraphic && graphicWrap && imgEl) {
      const targetSrc = this.showDistanceGraphic && hole.distanceGuideImageUrl
        ? hole.distanceGuideImageUrl
        : (hole.overheadImageUrl || '');
      if (targetSrc && imgEl.getAttribute('src') !== targetSrc) {
        imgEl.src = targetSrc;
      }
      if (this.lastRulerHoleNum !== hole.number) {
        this.lastRulerHoleNum = hole.number;
        this.clearGraphicRuler();
      }
      this.ensureGraphicRulerBound();
      graphicWrap.style.display = 'flex';
      if (radarCanvas) radarCanvas.style.display = 'none';
    } else {
      if (graphicWrap) graphicWrap.style.display = 'none';
      if (radarCanvas) radarCanvas.style.display = 'block';
    }
  }

  private ensureGraphicRulerBound() {
    if (this.rulerBound) return;
    const canvas = document.getElementById('overhead-ruler-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    this.rulerBound = true;

    const getRelPt = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
        y: Math.max(0, Math.min(rect.height, e.clientY - rect.top))
      };
    };

    canvas.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.isRulerDragging = true;
      this.rulerStart = getRelPt(e);
      this.rulerEnd = { ...this.rulerStart };
      canvas.setPointerCapture?.(e.pointerId);
      this.redrawGraphicRuler();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.isRulerDragging || !this.rulerStart) return;
      e.stopPropagation();
      this.rulerEnd = getRelPt(e);
      this.redrawGraphicRuler();
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!this.isRulerDragging) return;
      e.stopPropagation();
      this.isRulerDragging = false;
      this.rulerEnd = getRelPt(e);
      this.redrawGraphicRuler();
    });
    canvas.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.clearGraphicRuler();
    });
  }

  private clearGraphicRuler() {
    this.isRulerDragging = false;
    this.rulerStart = null;
    this.rulerEnd = null;
    const canvas = document.getElementById('overhead-ruler-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  }

  private redrawGraphicRuler() {
    const canvas = document.getElementById('overhead-ruler-canvas') as HTMLCanvasElement | null;
    const img = document.getElementById('overhead-hole-img') as HTMLImageElement | null;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(rect.width * dpr));
    const ch = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!this.rulerStart || !this.rulerEnd || !this.lastData) return;

    const dx = this.rulerEnd.x - this.rulerStart.x;
    const dy = this.rulerEnd.y - this.rulerStart.y;
    const pxDist = Math.hypot(dx, dy);
    if (pxDist < 2) return;

    const imgRect = img?.getBoundingClientRect();
    const imgH = Math.max(40, imgRect?.height || rect.height);
    const teeToPin = Math.hypot(
      this.lastData.hole.pinPosition.x - this.lastData.hole.teePosition.x,
      this.lastData.hole.pinPosition.z - this.lastData.hole.teePosition.z
    );
    const holeDistMeters = this.lastData.hole.distances?.yellow || Math.max(60, teeToPin);
    const metersPerPx = holeDistMeters / (imgH * 0.78);
    const distM = pxDist * metersPerPx;
    const distY = distM * 1.09361;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(this.rulerStart.x, this.rulerStart.y);
    ctx.lineTo(this.rulerEnd.x, this.rulerEnd.y);
    ctx.stroke();

    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.rulerStart.x, this.rulerStart.y);
    ctx.lineTo(this.rulerEnd.x, this.rulerEnd.y);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const pt of [this.rulerStart, this.rulerEnd]) {
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }

    const label = `${Math.round(distM)}m (${Math.round(distY)}y)`;
    ctx.font = '700 11px Inter, system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    const bw = tw + 12;
    const bh = 20;
    const midX = (this.rulerStart.x + this.rulerEnd.x) * 0.5;
    const midY = (this.rulerStart.y + this.rulerEnd.y) * 0.5 - 16;
    const bx = Math.max(4, Math.min(rect.width - bw - 4, midX - bw * 0.5));
    const by = Math.max(4, Math.min(rect.height - bh - 4, midY));
    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e0f2fe';
    ctx.fillText(label, bx + 6, by + 14);
    ctx.restore();
  }

  private lastData: OverheadLayoutData | null = null;
  private onAimToPointCallback?: (worldX: number, worldZ: number) => void;

  // Viewport mapping cache
  private viewCenterX: number = 0;
  private viewCenterZ: number = 0;
  private viewAngle: number = 0; // rotation to align hole vertically
  private viewScale: number = 1.0;
  private canvasWidth: number = 210;
  private canvasHeight: number = 220;
  private rotMinZ: number = 0;

  // Tooltip
  private tooltipEl: HTMLElement | null = null;

  constructor(
    containerId: string = 'hud-overhead-layout-panel',
    onAimToPoint?: (worldX: number, worldZ: number) => void
  ) {
    this.onAimToPointCallback = onAimToPoint;
    this.init(containerId);
  }

  private init(containerId: string) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.canvas = document.getElementById('overhead-hole-canvas') as HTMLCanvasElement;
    if (this.canvas) {
      this.ctx = this.canvas.getContext('2d');
      this.canvasWidth = this.canvas.width;
      this.canvasHeight = this.canvas.height;
      this.setupCanvasInteractions();
    }

    // Toggle minimize
    const toggleBtn = document.getElementById('btn-toggle-overhead-min');
    toggleBtn?.addEventListener('click', () => {
      this.toggleMinimize();
    });

    const pillBtn = document.getElementById('overhead-minimized-pill');
    pillBtn?.addEventListener('click', () => {
      this.toggleMinimize(false);
    });

    // Keyboard shortcut [M]
    window.addEventListener('keydown', (e) => {
      if (e.key === 'm' || e.key === 'M') {
        const activeTag = (document.activeElement?.tagName || '').toLowerCase();
        if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return;
        this.toggleMinimize();
      }
    });

    this.startAnimationLoop();
  }

  public toggleMinimize(forceState?: boolean) {
    this.isMinimized = forceState !== undefined ? forceState : !this.isMinimized;
    if (this.container) {
      this.container.classList.toggle('minimized', this.isMinimized);
      const toggleBtn = document.getElementById('btn-toggle-overhead-min');
      if (toggleBtn) {
        toggleBtn.innerText = this.isMinimized ? '◀ 🗺️' : '▾';
        toggleBtn.title = this.isMinimized ? 'Expand Overhead View [M]' : 'Minimize Overhead View [M]';
      }
    }
  }

  public update(data: OverheadLayoutData) {
    this.lastData = data;
    this.syncOverheadViewUI(data.hole);

    // Update Header labels
    const holeTitle = document.getElementById('overhead-hole-name');
    if (holeTitle) {
      const label = data.hole.isDemo ? 'DEMO HOLE' : `HOLE ${data.hole.number}`;
      holeTitle.innerText = `${label} • PAR ${data.hole.par}`;
    }

    const pillHoleTitle = document.getElementById('overhead-pill-text');
    if (pillHoleTitle) {
      pillHoleTitle.innerText = data.hole.isDemo ? `DEMO PAR ${data.hole.par}` : `H${data.hole.number} PAR ${data.hole.par}`;
    }

    // Distance to pin
    const dx = data.pinPos.x - data.ballPos.x;
    const dz = data.pinPos.z - data.ballPos.z;
    const distToPin = Math.hypot(dx, dz);
    const pinDistEl = document.getElementById('overhead-pin-dist');
    if (pinDistEl) {
      pinDistEl.innerText = `${Math.round(distToPin)}m (${Math.round(distToPin * 1.09361)}y)`;
    }

    // Elevation delta
    const elevDiff = data.pinPos.y - data.ballPos.y;
    const elevEl = document.getElementById('overhead-elevation-delta');
    if (elevEl) {
      const sign = elevDiff >= 0 ? '+' : '';
      const icon = elevDiff >= 0.05 ? '▲' : elevDiff <= -0.05 ? '▼' : '●';
      elevEl.innerText = `${sign}${elevDiff.toFixed(1)}m ${icon}`;
      elevEl.className = elevDiff > 0.05 ? 'stat-val highlight-green' : elevDiff < -0.05 ? 'stat-val highlight-gold' : 'stat-val';
    }

    // Target carry
    const targetCarryEl = document.getElementById('overhead-target-dist');
    if (targetCarryEl) {
      targetCarryEl.innerText = `${Math.round(data.club.typicalCarryMeters)}m (${data.club.name.split(' ')[0]})`;
    }

    this.render();
  }

  private startAnimationLoop() {
    const loop = () => {
      this.pulsePhase = (this.pulsePhase + 0.04) % (Math.PI * 2);
      if (!this.isMinimized && this.lastData) {
        this.render();
      }
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  public destroy() {
    if (this.animFrameId != null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private setupCanvasInteractions() {
    if (!this.canvas) return;

    this.canvas.addEventListener('click', (e) => {
      if (!this.lastData) return;
      const rect = this.canvas!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      const worldPos = this.canvasToWorld(cx, cy);
      if (worldPos && this.onAimToPointCallback) {
        this.onAimToPointCallback(worldPos.x, worldPos.z);
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.lastData) return;
      const rect = this.canvas!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const worldPos = this.canvasToWorld(cx, cy);

      if (worldPos) {
        const dx = worldPos.x - this.lastData.ballPos.x;
        const dz = worldPos.z - this.lastData.ballPos.z;
        const dist = Math.hypot(dx, dz);
        this.canvas!.title = `Target: ${Math.round(dist)}m (${Math.round(dist * 1.09361)} yds) • Click to Aim`;
      }
    });
  }

  /**
   * Transforms metric world (x, z) into screen canvas space (cx, cy)
   * Hole corridor is oriented vertically: Tee near bottom, Pin near top!
   */
  private worldToCanvas(wx: number, wz: number): { x: number; y: number } {
    if (!this.lastData) return { x: 0, y: 0 };
    const tee = this.lastData.hole.teePosition;

    // Rotate around tee by viewAngle so pin is strictly positive Y (upwards)
    const relX = wx - tee.x;
    const relZ = wz - tee.z;
    const cosA = Math.cos(this.viewAngle);
    const sinA = Math.sin(this.viewAngle);

    const rotX = relX * cosA - relZ * sinA;
    const rotZ = relX * sinA + relZ * cosA;

    const padBottom = 32;
    const cx = this.canvasWidth * 0.5 + rotX * this.viewScale;
    const cy = this.canvasHeight - padBottom - (rotZ - this.rotMinZ) * this.viewScale;
    return { x: cx, y: cy };
  }

  /**
   * Transforms screen canvas space (cx, cy) back to metric world (wx, wz)
   */
  private canvasToWorld(cx: number, cy: number): { x: number; z: number } | null {
    if (!this.lastData || this.viewScale === 0) return null;
    const tee = this.lastData.hole.teePosition;
    const padBottom = 32;

    const rotX = (cx - this.canvasWidth * 0.5) / this.viewScale;
    const rotZ = (this.canvasHeight - padBottom - cy) / this.viewScale + this.rotMinZ;

    const cosNegA = Math.cos(-this.viewAngle);
    const sinNegA = Math.sin(-this.viewAngle);

    const wx = tee.x + rotX * cosNegA - rotZ * sinNegA;
    const wz = tee.z + rotX * sinNegA + rotZ * cosNegA;
    return { x: wx, z: wz };
  }

  private computeViewport() {
    if (!this.lastData) return;
    const tee = this.lastData.hole.teePosition;
    const pin = this.lastData.hole.pinPosition;
    const ball = this.lastData.ballPos;

    // Angle of vector from Tee to Pin
    const dx = pin.x - tee.x;
    const dz = pin.z - tee.z;
    // Align vector strictly to +Z in rotated frame
    this.viewAngle = -Math.atan2(dx, dz);

    // Transform key landmarks into rotated space
    const cosA = Math.cos(this.viewAngle);
    const sinA = Math.sin(this.viewAngle);

    const rotPinZ = (pin.x - tee.x) * sinA + (pin.z - tee.z) * cosA;
    const rotBallZ = (ball.x - tee.x) * sinA + (ball.z - tee.z) * cosA;
    const rotBallX = (ball.x - tee.x) * cosA - (ball.z - tee.z) * sinA;

    this.rotMinZ = Math.min(-15, rotBallZ - 10);
    const rotMaxZ = Math.max(rotPinZ + 25, rotBallZ + 15);
    const totalSpanZ = Math.max(80, rotMaxZ - this.rotMinZ);

    // Max fairway width envelope (typically 80-120m)
    let maxAbsX = Math.max(45, Math.abs(rotBallX) + 15);
    for (const feat of this.lastData.features) {
      const fRotX = (feat.centerX - tee.x) * cosA - (feat.centerZ - tee.z) * sinA;
      maxAbsX = Math.max(maxAbsX, Math.abs(fRotX) + feat.width * 0.6);
    }

    const availW = this.canvasWidth - 28;
    const availH = this.canvasHeight - 56;

    const scaleX = availW / (maxAbsX * 2);
    const scaleZ = availH / totalSpanZ;
    this.viewScale = Math.min(scaleX, scaleZ);
  }

  private render() {
    const ctx = this.ctx;
    if (!ctx || !this.lastData) return;

    this.computeViewport();

    const W = this.canvasWidth;
    const H = this.canvasHeight;
    const data = this.lastData;

    // 1. Tactical Deep Rough Dark Background
    ctx.clearRect(0, 0, W, H);
    const bgGrad = ctx.createRadialGradient(W * 0.5, H * 0.5, 10, W * 0.5, H * 0.5, W * 0.75);
    bgGrad.addColorStop(0, '#0c1a12');
    bgGrad.addColorStop(1, '#050c08');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // Subtle 50m tactical yardage grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    for (let y = 0; y < H; y += 35) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    for (let x = 0; x < W; x += 35) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // 2. Distance Arcs from the PIN (PGA Tour Broadcast Yardage Rings)
    const pinPt = this.worldToCanvas(data.pinPos.x, data.pinPos.z);
    const arcDistances = [50, 100, 150, 200, 250];

    for (const d of arcDistances) {
      const rPx = d * this.viewScale;
      ctx.beginPath();
      ctx.arc(pinPt.x, pinPt.y, rPx, 0, Math.PI * 2);
      ctx.strokeStyle = d === 100 || d === 150 ? 'rgba(56, 189, 248, 0.22)' : 'rgba(255, 255, 255, 0.10)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Subtle arc distance label
      ctx.fillStyle = d === 100 || d === 150 ? 'rgba(56, 189, 248, 0.75)' : 'rgba(255, 255, 255, 0.45)';
      ctx.font = '600 8px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (pinPt.y + rPx < H - 20) {
        ctx.fillText(`${d}m`, pinPt.x, pinPt.y + rPx);
      }
    }

    // 3. Stamped Hole Architecture Features (Fairways, Bunkers, Greens, Hazards)
    for (const feat of data.features) {
      this.drawFeatureOnOverhead(ctx, feat);
    }

    // 4. Tee Marker Box
    const teePt = this.worldToCanvas(data.hole.teePosition.x, data.hole.teePosition.z);
    ctx.save();
    ctx.fillStyle = '#f8fafc';
    ctx.strokeStyle = '#00ffcc';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(teePt.x - 7, teePt.y - 4, 14, 8, 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#00ffcc';
    ctx.font = '800 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('TEE', teePt.x, teePt.y + 6);
    ctx.restore();

    // 5. Dynamic Aim Line & Target Carry Zone
    const ballPt = this.worldToCanvas(data.ballPos.x, data.ballPos.z);
    const radAim = (data.aimAzimuthDeg * Math.PI) / 180;
    const carryM = data.club.typicalCarryMeters;
    const targetWx = data.ballPos.x + Math.sin(radAim) * carryM;
    const targetWz = data.ballPos.z + Math.cos(radAim) * carryM;
    const targetPt = this.worldToCanvas(targetWx, targetWz);

    // Neon laser dashed aim trajectory
    ctx.save();
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([5, 4]);
    ctx.shadowColor = '#00f0ff';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(ballPt.x, ballPt.y);
    ctx.lineTo(targetPt.x, targetPt.y);
    ctx.stroke();
    ctx.restore();

    // Target Landing Marker (Crosshair circle)
    ctx.save();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(targetPt.x, targetPt.y, 8, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(targetPt.x - 11, targetPt.y);
    ctx.lineTo(targetPt.x + 11, targetPt.y);
    ctx.moveTo(targetPt.x, targetPt.y - 11);
    ctx.lineTo(targetPt.x, targetPt.y + 11);
    ctx.stroke();

    // Carry distance label badge
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(targetPt.x + 12, targetPt.y - 7, 56, 14, 3);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#38bdf8';
    ctx.font = '700 8px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(carryM)}m Carry`, targetPt.x + 15, targetPt.y);
    ctx.restore();

    // 6. Pin / Cup & Flag Marker
    ctx.save();
    // Glowing beacon
    const pinPulse = 1.0 + 0.3 * Math.sin(this.pulsePhase * 2);
    ctx.beginPath();
    ctx.arc(pinPt.x, pinPt.y, 10 * pinPulse, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.2)';
    ctx.fill();

    // Flagpole
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pinPt.x, pinPt.y);
    ctx.lineTo(pinPt.x, pinPt.y - 14);
    ctx.stroke();

    // Vibrant Red Flag
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(pinPt.x, pinPt.y - 14);
    ctx.lineTo(pinPt.x + 9, pinPt.y - 10);
    ctx.lineTo(pinPt.x, pinPt.y - 6);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '800 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PIN', pinPt.x, pinPt.y + 7);
    ctx.restore();

    // 7. Realtime Pulsing Ball Marker
    ctx.save();
    const ballPulseR = 5 + 4 * Math.sin(this.pulsePhase);
    ctx.beginPath();
    ctx.arc(ballPt.x, ballPt.y, ballPulseR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(ballPt.x, ballPt.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.restore();
  }

  private drawFeatureOnOverhead(ctx: CanvasRenderingContext2D, feat: StampedFeatureRecord) {
    const halfW = feat.width * 0.5;
    const halfL = feat.length * 0.5;
    const shapeIdx = feat.bunkerShapeIndex ?? 0;

    // Generate local meter points
    let pts: { x: number; z: number }[] = [];

    if (feat.surfaceType === SurfaceType.FAIRWAY) {
      // Procedural Fairway outline based on preset
      const preset = feat.id || 'fairway_landing_straight';
      pts = this.generateFairwayPolygon(halfW, halfL, preset);
    } else if (feat.surfaceType === SurfaceType.GREEN) {
      pts = this.generateEllipsePoints(halfW * 0.95, halfL * 0.95, 32);
    } else if (feat.surfaceType === SurfaceType.BUNKER) {
      pts = this.generateBunkerPoints(halfW, halfL, 0.78, shapeIdx, 36);
    } else if (feat.surfaceType === SurfaceType.WATER) {
      pts = this.generateEllipsePoints(halfW * 0.95, halfL * 0.95, 32);
    } else {
      pts = this.generateEllipsePoints(halfW * 0.90, halfL * 0.90, 24);
    }

    if (pts.length < 3) return;

    // Transform local feature points to canvas coordinates
    const cosR = Math.cos(feat.rotationRad);
    const sinR = Math.sin(feat.rotationRad);

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const lx = pts[i].x;
      const lz = pts[i].z;
      const wx = feat.centerX + lx * cosR - lz * sinR;
      const wz = feat.centerZ + lx * sinR + lz * cosR;
      const c = this.worldToCanvas(wx, wz);
      if (i === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    }
    ctx.closePath();

    if (feat.surfaceType === SurfaceType.FAIRWAY) {
      ctx.fillStyle = '#2ea439';
      ctx.strokeStyle = '#227b2b';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    } else if (feat.surfaceType === SurfaceType.GREEN) {
      ctx.fillStyle = '#39db6e';
      ctx.strokeStyle = '#239648';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    } else if (feat.surfaceType === SurfaceType.BUNKER) {
      ctx.fillStyle = '#f6e4be';
      ctx.strokeStyle = '#7c6d48';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    } else if (feat.surfaceType === SurfaceType.WATER) {
      ctx.fillStyle = '#0284c7';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.2;
      ctx.fill();
      ctx.stroke();
    } else if (feat.surfaceType === SurfaceType.TEE) {
      ctx.fillStyle = '#43a047';
      ctx.strokeStyle = '#2e7d32';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }

  private generateEllipsePoints(halfW: number, halfL: number, segs: number): { x: number; z: number }[] {
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < segs; i++) {
      const theta = (i / segs) * Math.PI * 2;
      pts.push({
        x: Math.cos(theta) * halfW,
        z: Math.sin(theta) * halfL
      });
    }
    return pts;
  }

  private generateBunkerPoints(halfW: number, halfL: number, scale: number, shapeIdx: number, segs: number): { x: number; z: number }[] {
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < segs; i++) {
      const theta = (i / segs) * Math.PI * 2;
      let k = 1.0;
      if (shapeIdx === 0) {
        k = 1.0 + 0.38 * Math.cos(theta) - 0.22 * Math.cos(2 * theta);
      } else if (shapeIdx === 1) {
        k = 1.0 + 0.42 * Math.cos(theta + 0.4) - 0.18 * Math.sin(2 * theta);
      } else {
        k = 1.0 + 0.28 * Math.cos(theta) + 0.18 * Math.sin(3 * theta);
      }
      pts.push({
        x: Math.cos(theta) * halfW * k * scale,
        z: Math.sin(theta) * halfL * k * scale
      });
    }
    return pts;
  }

  private generateFairwayPolygon(halfW: number, halfL: number, preset: string): { x: number; z: number }[] {
    const isDoglegLeft = preset === 'fairway_dogleg_left';
    const isDoglegRight = preset === 'fairway_dogleg_right';
    const curveSign = isDoglegLeft ? -1 : isDoglegRight ? 1 : 0;

    const segs = 18;
    const leftSide: { x: number; z: number }[] = [];
    const rightSide: { x: number; z: number }[] = [];

    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const lz = -halfL + t * (halfL * 2);
      const bend = curveSign * Math.sin(t * Math.PI) * (halfW * 0.7);
      const w = halfW * (0.85 + 0.15 * Math.sin(t * Math.PI));

      leftSide.push({ x: bend - w, z: lz });
      rightSide.push({ x: bend + w, z: lz });
    }

    return [...leftSide, ...rightSide.reverse()];
  }
}
