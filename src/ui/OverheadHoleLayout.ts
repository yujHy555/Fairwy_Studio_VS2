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
  satelliteImageUrl?: string;
  isBallMoving?: boolean;
}

export class OverheadHoleLayout {
  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private isMinimized: boolean = false;
  private liveAerialActive: boolean = false;
  private animFrameId: number | null = null;
  private pulsePhase: number = 0;
  private viewMode: 'graphic' | 'radar' = 'radar';
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

  public setExploreDragCallbacks(
    onDragBall?: (worldX: number, worldZ: number) => void,
    onDragPin?: (worldX: number, worldZ: number) => void
  ) {
    this.onDragBallCallback = onDragBall;
    this.onDragPinCallback = onDragPin;
  }

  public resetPanZoom() {
    this.panOffsetRotX = 0;
    this.panOffsetRotZ = 0;
    this.panZoom = 1.0;
    this.render();
  }

  public isRadarVisible(): boolean {
    if (this.isMinimized || !this.lastData) return false;
    return true;
  }

  public setLiveAerialActive(active: boolean) {
    if (this.liveAerialActive === active) return;
    this.liveAerialActive = active;
    if (this.container) {
      this.container.classList.toggle('live-aerial-active', active);
    }
    this.render();
  }

  private cachedAerialRect: DOMRect | null = null;
  private cachedAerialRectTime = 0;

  public getAerialCameraFrame(): {
    canvasRect: DOMRect;
    centerX: number;
    centerZ: number;
    upX: number;
    upZ: number;
    halfW: number;
    halfZ: number;
  } | null {
    if (!this.canvas || !this.lastData || !this.isRadarVisible()) return null;
    const now = performance.now();
    if (!this.cachedAerialRect || now - this.cachedAerialRectTime > 350) {
      this.cachedAerialRect = this.canvas.getBoundingClientRect();
      this.cachedAerialRectTime = now;
    }
    const rect = this.cachedAerialRect;
    if (rect.width < 20 || rect.height < 20) return null;
    this.computeViewport();
    const center = this.canvasToWorld(this.canvasWidth * 0.5, this.canvasHeight * 0.5);
    const topW = this.canvasToWorld(this.canvasWidth * 0.5, 0);
    const botW = this.canvasToWorld(this.canvasWidth * 0.5, this.canvasHeight);
    if (!center || !topW || !botW || this.viewScale <= 0.0001) return null;
    const ux = topW.x - botW.x;
    const uz = topW.z - botW.z;
    const uLen = Math.hypot(ux, uz) || 1;
    // Slight 1.18x aerial pullback so surrounding fairways, trees, and hazards frame the hole beautifully
    const halfW = (this.canvasWidth * 0.5) / this.viewScale;
    const halfZ = (this.canvasHeight * 0.5) / this.viewScale;
    return {
      canvasRect: rect,
      centerX: center.x,
      centerZ: center.z,
      upX: ux / uLen,
      upZ: uz / uLen,
      halfW,
      halfZ
    };
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

  private syncOverheadViewUI(_hole: GolfHole) {
    this.ensureModeControlsBound();
    const radarCanvas = document.getElementById('overhead-hole-canvas') as HTMLCanvasElement | null;
    if (radarCanvas) radarCanvas.style.display = 'block';
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

      // Clean click (< 6px drag) aims the shot toward that clicked spot along the hole corridor!
      if (this.rulerStart && this.rulerEnd && this.lastData) {
        const dragPx = Math.hypot(
          this.rulerEnd.x - this.rulerStart.x,
          this.rulerEnd.y - this.rulerStart.y
        );
        if (dragPx < 6) {
          const rect = canvas.getBoundingClientRect();
          const normY = 1 - Math.max(0.05, Math.min(0.95, this.rulerEnd.y / Math.max(1, rect.height)));
          const normX = (this.rulerEnd.x / Math.max(1, rect.width)) - 0.5;
          const tee = this.lastData.hole.teePosition;
          const pin = this.lastData.pinPos;
          const dx = pin.x - tee.x;
          const dz = pin.z - tee.z;
          const holeLen = Math.max(40, Math.hypot(dx, dz));
          const fwdX = dx / holeLen;
          const fwdZ = dz / holeLen;
          const rightX = fwdZ;
          const rightZ = -fwdX;
          const along = ((normY - 0.10) / 0.80) * holeLen;
          const lateral = normX * Math.min(110, holeLen * 0.42);
          const worldX = tee.x + fwdX * along + rightX * lateral;
          const worldZ = tee.z + fwdZ * along + rightZ * lateral;
          this.rulerStart = null;
          this.rulerEnd = null;
          this.onAimToPointCallback?.(worldX, worldZ);
        }
      }
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
    if (!this.lastData) return;

    const teeToPin = Math.hypot(
      this.lastData.hole.pinPosition.x - this.lastData.hole.teePosition.x,
      this.lastData.hole.pinPosition.z - this.lastData.hole.teePosition.z
    );
    const ballToPin = Math.hypot(
      this.lastData.pinPos.x - this.lastData.ballPos.x,
      this.lastData.pinPos.z - this.lastData.ballPos.z
    );
    const syncedHoleMeters = Math.max(40, Math.round(teeToPin));
    const syncedRemMeters = Math.max(0, Math.round(ballToPin));

    // Always draw Live Ball Beacon + Aim Direction Indicator over the hole graphic
    {
      const tee = this.lastData.hole.teePosition;
      const pin = this.lastData.pinPos;
      const ball = this.lastData.ballPos;
      const dxH = pin.x - tee.x;
      const dzH = pin.z - tee.z;
      const holeLen = Math.max(40, Math.hypot(dxH, dzH));
      const fwdX = dxH / holeLen;
      const fwdZ = dzH / holeLen;
      const rightX = fwdZ;
      const rightZ = -fwdX;

      const relX = ball.x - tee.x;
      const relZ = ball.z - tee.z;
      const alongFrac = Math.max(-0.08, Math.min(1.06, (relX * fwdX + relZ * fwdZ) / holeLen));
      const latFrac = Math.max(-0.42, Math.min(0.42, (relX * rightX + relZ * rightZ) / Math.min(110, holeLen * 0.42)));

      const ballPxX = rect.width * (0.5 + latFrac);
      const ballPxY = rect.height * (0.88 - alongFrac * 0.74);
      const pinPxX = rect.width * 0.5;
      const pinPxY = rect.height * 0.14;

      ctx.save();
      // Subtle dashed sightline from live ball to pin
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ballPxX, ballPxY);
      ctx.lineTo(pinPxX, pinPxY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Pulsing outer beacon ring
      const pulse = 7 + Math.sin(performance.now() * 0.006) * 2.5;
      ctx.beginPath();
      ctx.arc(ballPxX, ballPxY, pulse, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Crisp white golf ball dot
      ctx.beginPath();
      ctx.arc(ballPxX, ballPxY, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
    }

    // When Distances toggle is ON in Graphic mode, draw live synced 3D distances over the hole graphic
    if (this.showDistanceGraphic) {
      ctx.save();
      const topPill = `PIN ${syncedRemMeters}m (${Math.round(syncedRemMeters * 1.09361)}y) • HOLE ${syncedHoleMeters}m`;
      ctx.font = '700 10px Inter, system-ui, sans-serif';
      const tw0 = ctx.measureText(topPill).width;
      const bw0 = Math.min(rect.width - 12, tw0 + 14);
      const bx0 = (rect.width - bw0) * 0.5;
      ctx.fillStyle = 'rgba(8, 16, 28, 0.88)';
      ctx.beginPath();
      ctx.roundRect(bx0, 6, bw0, 20, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#e0f2fe';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(topPill, rect.width * 0.5, 16);

      // Synced 100m / 150m / 200m layup yardage markers from green along the graphic corridor
      for (const markM of [100, 150, 200]) {
        if (markM >= syncedHoleMeters - 20) continue;
        const fracFromPin = markM / syncedHoleMeters;
        const yPx = rect.height * (0.14 + fracFromPin * 0.74);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
        ctx.beginPath();
        ctx.roundRect(8, yPx - 8, 42, 16, 4);
        ctx.fill();
        ctx.strokeStyle = 'rgba(74, 222, 128, 0.65)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#86efac';
        ctx.font = '700 9px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${markM}m`, 29, yPx + 0.5);
      }
      ctx.restore();
    }

    if (!this.rulerStart || !this.rulerEnd) return;

    const dx = this.rulerEnd.x - this.rulerStart.x;
    const dy = this.rulerEnd.y - this.rulerStart.y;
    const pxDist = Math.hypot(dx, dy);
    if (pxDist < 2) return;

    const imgRect = img?.getBoundingClientRect();
    const imgH = Math.max(40, imgRect?.height || rect.height);
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
  private viewOriginX: number = 0;
  private viewOriginZ: number = 0;
  private viewAngle: number = 0; // rotation to align hole vertically
  private viewScale: number = 1.0;
  private canvasWidth: number = 536;
  private canvasHeight: number = 620;
  private rotCenterX: number = 0;
  private rotCenterZ: number = 0;
  private rotMinZ: number = 0;
  private panOffsetRotX: number = 0;
  private panOffsetRotZ: number = 0;
  private panZoom: number = 1.0;
  private isRmbPanning: boolean = false;
  private rmbLastX: number = 0;
  private rmbLastY: number = 0;
  private lastRmbDownTime: number = 0;
  private dragIconMode: 'none' | 'ball' | 'pin' = 'none';
  private lmbDownX: number = 0;
  private lmbDownY: number = 0;
  private onDragBallCallback?: (worldX: number, worldZ: number) => void;
  private onDragPinCallback?: (worldX: number, worldZ: number) => void;
  private satImg: HTMLImageElement | null = null;
  private satImgUrl: string = '';

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
    const canvas = this.canvas;

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    const getCanvasCoords = (e: MouseEvent | PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        cx: ((e.clientX - rect.left) / Math.max(1, rect.width)) * this.canvasWidth,
        cy: ((e.clientY - rect.top) / Math.max(1, rect.height)) * this.canvasHeight
      };
    };

    const canDragBall = (): boolean => {
      if (!this.lastData || !this.onDragBallCallback) return false;
      return !this.lastData.features.some((f) => f.surfaceType === SurfaceType.TEE);
    };

    const canDragPin = (): boolean => {
      if (!this.lastData || !this.onDragPinCallback) return false;
      return !this.lastData.features.some((f) => f.surfaceType === SurfaceType.GREEN);
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.lastData) return;
      const { cx, cy } = getCanvasCoords(e);

      // RMB: Pan entire terrain (double-click RMB resets pan & zoom)
      if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        const now = performance.now();
        if (now - this.lastRmbDownTime < 320) {
          this.resetPanZoom();
          this.lastRmbDownTime = 0;
          return;
        }
        this.lastRmbDownTime = now;
        this.isRmbPanning = true;
        this.rmbLastX = cx;
        this.rmbLastY = cy;
        canvas.setPointerCapture?.(e.pointerId);
        canvas.style.cursor = 'grabbing';
        return;
      }

      // LMB: Check if clicking Ball or Flag icon to drag across terrain (when Tee Box / Green not yet added)
      if (e.button === 0) {
        this.lmbDownX = cx;
        this.lmbDownY = cy;
        const ballPt = this.worldToCanvas(this.lastData.ballPos.x, this.lastData.ballPos.z);
        const { pin: effPin } = this.getEffectiveTeeAndPin();
        const pinPt = this.worldToCanvas(effPin.x, effPin.z);

        if (canDragBall() && Math.hypot(cx - ballPt.x, cy - ballPt.y) <= 20) {
          this.dragIconMode = 'ball';
          canvas.setPointerCapture?.(e.pointerId);
          canvas.style.cursor = 'grabbing';
          e.stopPropagation();
          return;
        }
        if (canDragPin() && Math.hypot(cx - pinPt.x, cy - pinPt.y) <= 22) {
          this.dragIconMode = 'pin';
          canvas.setPointerCapture?.(e.pointerId);
          canvas.style.cursor = 'grabbing';
          e.stopPropagation();
          return;
        }
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.lastData) return;
      const { cx, cy } = getCanvasCoords(e);

      if (this.isRmbPanning) {
        const dxPx = cx - this.rmbLastX;
        const dyPx = cy - this.rmbLastY;
        this.rmbLastX = cx;
        this.rmbLastY = cy;
        const sc = Math.max(0.05, this.viewScale);
        this.panOffsetRotX -= dxPx / sc;
        this.panOffsetRotZ += dyPx / sc;
        this.render();
        return;
      }

      if (this.dragIconMode !== 'none') {
        const wp = this.canvasToWorld(cx, cy);
        if (wp) {
          const clampedX = Math.max(2, Math.min(this.lastData.terrainWidth - 2, wp.x));
          const clampedZ = Math.max(2, Math.min(this.lastData.terrainLength - 2, wp.z));
          if (this.dragIconMode === 'ball') {
            this.onDragBallCallback?.(clampedX, clampedZ);
          } else if (this.dragIconMode === 'pin') {
            this.onDragPinCallback?.(clampedX, clampedZ);
          }
        }
        return;
      }

      // Hover cursor feedback for draggable Ball / Flag icons
      const ballPt = this.worldToCanvas(this.lastData.ballPos.x, this.lastData.ballPos.z);
      const { pin: effPin } = this.getEffectiveTeeAndPin();
      const pinPt = this.worldToCanvas(effPin.x, effPin.z);
      if (
        (canDragBall() && Math.hypot(cx - ballPt.x, cy - ballPt.y) <= 20) ||
        (canDragPin() && Math.hypot(cx - pinPt.x, cy - pinPt.y) <= 22)
      ) {
        canvas.style.cursor = 'grab';
      } else {
        canvas.style.cursor = 'crosshair';
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      if (this.isRmbPanning && e.button === 2) {
        this.isRmbPanning = false;
        canvas.releasePointerCapture?.(e.pointerId);
        canvas.style.cursor = 'crosshair';
        return;
      }
      if (this.dragIconMode !== 'none' && e.button === 0) {
        this.dragIconMode = 'none';
        canvas.releasePointerCapture?.(e.pointerId);
        canvas.style.cursor = 'crosshair';
        // Re-center & re-orient smoothly once the user finishes placing the icon
        this.computeViewport();
        this.render();
        return;
      }
      if (e.button === 0 && this.lastData) {
        const { cx, cy } = getCanvasCoords(e);
        if (Math.hypot(cx - this.lmbDownX, cy - this.lmbDownY) < 6) {
          const worldPos = this.canvasToWorld(cx, cy);
          if (worldPos && this.onAimToPointCallback) {
            this.onAimToPointCallback(worldPos.x, worldPos.z);
          }
        }
      }
    });

    canvas.addEventListener('wheel', (e) => {
      if (!this.lastData) return;
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.panZoom = Math.max(0.32, Math.min(3.5, this.panZoom * factor));
      this.render();
    }, { passive: false });

    canvas.addEventListener('mousemove', (e) => {
      if (!this.lastData) return;
      const rect = canvas.getBoundingClientRect();
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

    // Rotate around locked viewOrigin by viewAngle so map stays 100% rock-solid while dragging Ball/Flag icons
    const relX = wx - this.viewOriginX;
    const relZ = wz - this.viewOriginZ;
    const cosA = Math.cos(this.viewAngle);
    const sinA = Math.sin(this.viewAngle);

    const rotX = relX * cosA - relZ * sinA;
    const rotZ = relX * sinA + relZ * cosA;

    const cx = this.canvasWidth * 0.5 + (rotX - this.rotCenterX) * this.viewScale;
    const cy = this.canvasHeight * 0.5 - (rotZ - this.rotCenterZ) * this.viewScale;
    return { x: cx, y: cy };
  }

  /**
   * Transforms screen canvas space (cx, cy) back to metric world (wx, wz)
   */
  private canvasToWorld(cx: number, cy: number): { x: number; z: number } | null {
    if (!this.lastData || this.viewScale === 0) return null;

    const rotX = (cx - this.canvasWidth * 0.5) / this.viewScale + this.rotCenterX;
    const rotZ = (this.canvasHeight * 0.5 - cy) / this.viewScale + this.rotCenterZ;

    const cosNegA = Math.cos(-this.viewAngle);
    const sinNegA = Math.sin(-this.viewAngle);

    const wx = this.viewOriginX + rotX * cosNegA - rotZ * sinNegA;
    const wz = this.viewOriginZ + rotX * sinNegA + rotZ * cosNegA;
    return { x: wx, z: wz };
  }

  private computeViewport() {
    if (!this.lastData) return;
    // Freeze radar zoom, center & orientation while actively dragging Ball/Flag icon so the map never spins under the cursor!
    if (this.dragIconMode !== 'none') return;
    if (this.canvas) {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width >= 60 && rect.height >= 60) {
        const rw = Math.round(rect.width);
        const rh = Math.round(rect.height);
        if (Math.abs(this.canvas.width - rw) > 2 || Math.abs(this.canvas.height - rh) > 2) {
          this.canvas.width = rw;
          this.canvas.height = rh;
        }
        this.canvasWidth = this.canvas.width;
        this.canvasHeight = this.canvas.height;
      }
    }

    const { tee, pin } = this.getEffectiveTeeAndPin();
    this.viewOriginX = tee.x;
    this.viewOriginZ = tee.z;
    const ball = this.lastData.ballPos;

    // Angle of vector from Tee to Pin (oriented vertically: Tee near bottom, Pin near top)
    const dx = pin.x - tee.x;
    const dz = pin.z - tee.z;
    const holeDist = Math.hypot(dx, dz);
    this.viewAngle = holeDist > 2 ? -Math.atan2(dx, dz) : 0;

    const cosA = Math.cos(this.viewAngle);
    const sinA = Math.sin(this.viewAngle);

    const toRot = (wx: number, wz: number) => {
      const rx = wx - tee.x;
      const rz = wz - tee.z;
      return {
        x: rx * cosA - rz * sinA,
        z: rx * sinA + rz * cosA
      };
    };

    const rPin = toRot(pin.x, pin.z);
    const rBall = toRot(ball.x, ball.z);

    let minRX = Math.min(0, rPin.x, rBall.x);
    let maxRX = Math.max(0, rPin.x, rBall.x);
    let minRZ = Math.min(0, rPin.z, rBall.z);
    let maxRZ = Math.max(0, rPin.z, rBall.z);

    if (this.lastData.aimTargetPos) {
      const rAim = toRot(this.lastData.aimTargetPos.x, this.lastData.aimTargetPos.z);
      minRX = Math.min(minRX, rAim.x);
      maxRX = Math.max(maxRX, rAim.x);
      minRZ = Math.min(minRZ, rAim.z);
      maxRZ = Math.max(maxRZ, rAim.z);
    }

    // Include ONLY features belonging to the active hole corridor (within 95m laterally) so distant holes never skew centering!
    for (const feat of this.lastData.features) {
      const rf = toRot(feat.centerX, feat.centerZ);
      if (rf.z < -45 || rf.z > rPin.z + 65 || Math.abs(rf.x) > 95) continue;
      const padX = Math.min(45, feat.width * 0.52);
      const padZ = Math.min(45, feat.length * 0.52);
      minRX = Math.min(minRX, rf.x - padX);
      maxRX = Math.max(maxRX, rf.x + padX);
      minRZ = Math.min(minRZ, rf.z - padZ);
      maxRZ = Math.max(maxRZ, rf.z + padZ);
    }

    // Generous symmetric padding so the hole is dead-center and the ball in flight/roll stays comfortably inside frame
    const padBehind = 38;
    const padAhead = 44;
    minRZ -= padBehind;
    maxRZ += padAhead;

    const minHalfW = Math.max(58, (maxRZ - minRZ) * 0.24);
    const curHalfW = (maxRX - minRX) * 0.5 + 24;
    const effHalfW = Math.max(minHalfW, curHalfW);

    this.rotCenterX = (minRX + maxRX) * 0.5 + this.panOffsetRotX;
    this.rotCenterZ = (minRZ + maxRZ) * 0.5 + this.panOffsetRotZ;
    this.rotMinZ = minRZ;

    const totalSpanX = effHalfW * 2;
    const totalSpanZ = Math.max(110, maxRZ - minRZ);

    const availW = Math.max(60, this.canvasWidth - 24);
    const availH = Math.max(60, this.canvasHeight - 28);

    const scaleX = availW / totalSpanX;
    const scaleZ = availH / totalSpanZ;
    this.viewScale = Math.min(scaleX, scaleZ) * this.panZoom;
  }

  private getEffectiveTeeAndPin(): { tee: { x: number; z: number }; pin: { x: number; z: number } } {
    const data = this.lastData!;
    let tee = { x: data.hole.teePosition.x, z: data.hole.teePosition.z };
    let pin = { x: data.pinPos.x, z: data.pinPos.z };

    // Dynamically recognize user-added Tee Box and Green features so 3D Radar & aiming stay synced!
    const teeFeat = data.features.find((f) => f.surfaceType === SurfaceType.TEE);
    if (teeFeat && !data.hole.hasCustomTeePosition) {
      const distTee = Math.hypot(teeFeat.centerX - tee.x, teeFeat.centerZ - tee.z);
      if (distTee > 25) {
        tee = { x: teeFeat.centerX, z: teeFeat.centerZ };
      }
    }
    const greenFeat = data.features.find((f) => f.surfaceType === SurfaceType.GREEN);
    if (greenFeat) {
      const distPin = Math.hypot(greenFeat.centerX - pin.x, greenFeat.centerZ - pin.z);
      if (distPin > Math.max(greenFeat.width, greenFeat.length) * 0.75 + 15) {
        pin = { x: greenFeat.centerX, z: greenFeat.centerZ };
      }
    }
    return { tee, pin };
  }

  private ensureSatelliteImageLoaded(url?: string) {
    if (!url) return;
    if (this.satImgUrl === url) return;
    this.satImgUrl = url;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (this.satImgUrl === url) {
        this.satImg = img;
        this.render();
      }
    };
    img.src = url;
  }

  private render() {
    const ctx = this.ctx;
    if (!ctx || !this.lastData) return;

    this.ensureSatelliteImageLoaded(this.lastData.satelliteImageUrl);
    this.computeViewport();

    const W = this.canvasWidth;
    const H = this.canvasHeight;
    const data = this.lastData;
    const { tee: effTee, pin: effPin } = this.getEffectiveTeeAndPin();

    // 1. Live Dedicated 3D Aerial Camera Backdrop OR 2D Broadcast Backdrop
    ctx.clearRect(0, 0, W, H);
    if (!this.liveAerialActive) {
      const bgGrad = ctx.createRadialGradient(W * 0.5, H * 0.44, 18, W * 0.5, H * 0.5, Math.max(W, H) * 0.72);
      bgGrad.addColorStop(0, '#173620');
      bgGrad.addColorStop(0.55, '#0f2516');
      bgGrad.addColorStop(1, '#07120b');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);

      // Draw imported MapNG satellite/terrain texture synced 1:1 with the rotated hole corridor!
      if (this.satImg && this.satImg.complete && this.satImg.naturalWidth > 0 && data.terrainWidth > 0 && data.terrainLength > 0) {
        ctx.save();
        const originC = this.worldToCanvas(0, 0);
        const axisXC = this.worldToCanvas(data.terrainWidth, 0);
        const axisZC = this.worldToCanvas(0, data.terrainLength);
        const a = (axisXC.x - originC.x) / data.terrainWidth;
        const b = (axisXC.y - originC.y) / data.terrainWidth;
        const c = (axisZC.x - originC.x) / data.terrainLength;
        const d = (axisZC.y - originC.y) / data.terrainLength;
        ctx.globalAlpha = 0.86;
        ctx.transform(a, b, c, d, originC.x, originC.y);
        ctx.drawImage(this.satImg, 0, 0, data.terrainWidth, data.terrainLength);
        ctx.restore();
      }
    }

    // Subtle organic topographic contour bands (only in 2D fallback mode)
    if (!this.liveAerialActive) {
      ctx.save();
      ctx.strokeStyle = 'rgba(134, 239, 172, 0.055)';
      ctx.lineWidth = 1.1;
      for (let ring = 1; ring <= 6; ring++) {
        ctx.beginPath();
        const rx = W * (0.14 * ring);
        const ry = H * (0.13 * ring);
        for (let i = 0; i <= 48; i++) {
          const a = (i / 48) * Math.PI * 2;
          const wob = 1 + 0.08 * Math.sin(a * 3 + ring * 1.1) + 0.05 * Math.cos(a * 5 - ring * 0.7);
          const px = W * 0.5 + Math.cos(a) * rx * wob;
          const py = H * 0.48 + Math.sin(a) * ry * wob;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();

      // Subtle tactical yardage grid
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.032)';
      ctx.lineWidth = 1;
      for (let y = 0; y < H; y += 44) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      for (let x = 0; x < W; x += 44) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
    }

    // 2. Distance Arcs from the PIN (PGA Tour Broadcast Yardage Rings)
    const pinPt = this.worldToCanvas(effPin.x, effPin.z);
    const arcDistances = [50, 100, 150, 200, 250];

    for (const d of arcDistances) {
      const rPx = d * this.viewScale;
      ctx.beginPath();
      ctx.arc(pinPt.x, pinPt.y, rPx, 0, Math.PI * 2);
      ctx.strokeStyle = d === 100 || d === 150 ? 'rgba(56, 189, 248, 0.34)' : 'rgba(255, 255, 255, 0.16)';
      ctx.lineWidth = 1.15;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Subtle arc distance label
      ctx.fillStyle = d === 100 || d === 150 ? 'rgba(186, 230, 253, 0.92)' : 'rgba(255, 255, 255, 0.68)';
      ctx.font = '700 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (pinPt.y + rPx < H - 20) {
        ctx.fillText(`${d}m`, pinPt.x, pinPt.y + rPx);
      }
    }

    // 3. Stamped Hole Architecture Features (only needed in 2D fallback; live 3D Aerial Camera renders the actual 3D course!)
    if (!this.liveAerialActive) {
      for (const feat of data.features) {
        this.drawFeatureOnOverhead(ctx, feat);
      }
    }

    // 4. Tee Marker Box
    const teePt = this.worldToCanvas(effTee.x, effTee.z);
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

    // 5. Dynamic Aim Line & Target Carry Zone (hidden while ball is in flight/rolling, restored cleanly at rest)
    const ballPt = this.worldToCanvas(data.ballPos.x, data.ballPos.z);
    if (!data.isBallMoving) {
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
    }

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

    // Generate world-space polygon points (supports traced contours, organic dogleg splines, and harmonic shapes!)
    let worldPts: { x: number; z: number }[] = [];

    if (feat.contour && feat.contour.length >= 3) {
      worldPts = feat.contour.map((p) => ({ x: p.x, z: p.z }));
    } else if (feat.doglegPoints && feat.doglegPoints.length >= 3) {
      const wps = feat.doglegPoints;
      const leftPts: { x: number; z: number }[] = [];
      const rightPts: { x: number; z: number }[] = [];
      for (let i = 0; i < wps.length; i++) {
        const prev = wps[Math.max(0, i - 1)];
        const next = wps[Math.min(wps.length - 1, i + 1)];
        const tx = next.x - prev.x;
        const tz = next.z - prev.z;
        const len = Math.hypot(tx, tz) || 1;
        const nx = -tz / len;
        const nz = tx / len;
        const hw = Math.max(8, (wps[i].width || 28) * 0.52);
        leftPts.push({ x: wps[i].x + nx * hw, z: wps[i].z + nz * hw });
        rightPts.push({ x: wps[i].x - nx * hw, z: wps[i].z - nz * hw });
      }
      worldPts = [...leftPts, ...rightPts.reverse()];
    } else {
      let localPts: { x: number; z: number }[] = [];
      if (feat.surfaceType === SurfaceType.FAIRWAY) {
        const preset = feat.id || 'fairway_landing_straight';
        localPts = this.generateFairwayPolygon(halfW, halfL, preset);
      } else if (feat.surfaceType === SurfaceType.GREEN) {
        localPts = this.generateOrganicEllipsePoints(halfW * 0.96, halfL * 0.96, 44, 0.08, 1.3);
      } else if (feat.surfaceType === SurfaceType.BUNKER) {
        localPts = this.generateBunkerPoints(halfW, halfL, 0.80, shapeIdx, 44);
      } else if (feat.surfaceType === SurfaceType.WATER) {
        localPts = this.generateOrganicEllipsePoints(halfW * 0.96, halfL * 0.96, 44, 0.14, 2.7);
      } else {
        localPts = this.generateOrganicEllipsePoints(halfW * 0.92, halfL * 0.92, 32, 0.04, 0.5);
      }
      const cosR = Math.cos(feat.rotationRad);
      const sinR = Math.sin(feat.rotationRad);
      worldPts = localPts.map((pt) => ({
        x: feat.centerX + pt.x * cosR - pt.z * sinR,
        z: feat.centerZ + pt.x * sinR + pt.z * cosR
      }));
    }

    if (worldPts.length < 3) return;

    const canvasPts = worldPts.map((p) => this.worldToCanvas(p.x, p.z));
    let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity;
    for (const c of canvasPts) {
      if (c.x < minCx) minCx = c.x;
      if (c.x > maxCx) maxCx = c.x;
      if (c.y < minCy) minCy = c.y;
      if (c.y > maxCy) maxCy = c.y;
    }
    const midCx = (minCx + maxCx) * 0.5;
    const midCy = (minCy + maxCy) * 0.5;

    // Trace smooth quadratic-spline closed path for organic AAA golf map edges
    const traceSmoothClosedPath = (pts: { x: number; y: number }[]) => {
      const n = pts.length;
      ctx.beginPath();
      const firstMidX = (pts[n - 1].x + pts[0].x) * 0.5;
      const firstMidY = (pts[n - 1].y + pts[0].y) * 0.5;
      ctx.moveTo(firstMidX, firstMidY);
      for (let i = 0; i < n; i++) {
        const cur = pts[i];
        const next = pts[(i + 1) % n];
        ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) * 0.5, (cur.y + next.y) * 0.5);
      }
      ctx.closePath();
    };

    ctx.save();
    traceSmoothClosedPath(canvasPts);

    if (feat.surfaceType === SurfaceType.FAIRWAY) {
      // Soft first-cut rough outer halo
      ctx.save();
      ctx.strokeStyle = 'rgba(34, 139, 54, 0.55)';
      ctx.lineWidth = Math.max(4, 2.8 * this.viewScale);
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();

      const fwGrad = ctx.createLinearGradient(minCx, minCy, maxCx, maxCy);
      fwGrad.addColorStop(0, '#36b847');
      fwGrad.addColorStop(0.5, '#2ea43c');
      fwGrad.addColorStop(1, '#258a32');
      ctx.fillStyle = fwGrad;
      ctx.fill();

      // Clipped broadcast mowing stripes
      ctx.save();
      ctx.clip();
      const stripeW = Math.max(5, 4.8 * this.viewScale);
      ctx.fillStyle = 'rgba(210, 255, 175, 0.13)';
      for (let y = minCy - 20; y < maxCy + 20; y += stripeW * 2) {
        ctx.fillRect(minCx - 20, y, (maxCx - minCx) + 40, stripeW);
      }
      ctx.restore();

      ctx.strokeStyle = 'rgba(134, 239, 172, 0.45)';
      ctx.lineWidth = 1.25;
      ctx.stroke();
    } else if (feat.surfaceType === SurfaceType.GREEN) {
      // Sculpted Fringe Collar outer rim
      ctx.save();
      ctx.strokeStyle = 'rgba(34, 160, 74, 0.72)';
      ctx.lineWidth = Math.max(4.5, 2.2 * this.viewScale);
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();

      const gGrad = ctx.createRadialGradient(midCx - 4, midCy - 4, 2, midCx, midCy, Math.max(12, (maxCx - minCx) * 0.65));
      gGrad.addColorStop(0, '#5ef08b');
      gGrad.addColorStop(0.7, '#34d466');
      gGrad.addColorStop(1, '#22a84c');
      ctx.fillStyle = gGrad;
      ctx.fill();

      // Crisp putting green contour highlight & fine mowing sheen
      ctx.save();
      ctx.clip();
      const gStripe = Math.max(3, 2.0 * this.viewScale);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
      for (let x = minCx - 10; x < maxCx + 10; x += gStripe * 2) {
        ctx.fillRect(x, minCy - 10, gStripe, (maxCy - minCy) + 20);
      }
      ctx.restore();

      ctx.strokeStyle = 'rgba(187, 247, 208, 0.75)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
    } else if (feat.surfaceType === SurfaceType.BUNKER) {
      // Sculpted turf lip shadow around bunker
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 2;
      const bGrad = ctx.createRadialGradient(midCx - 2, midCy - 2, 1, midCx, midCy, Math.max(8, (maxCx - minCx) * 0.65));
      bGrad.addColorStop(0, '#fdf5dc');
      bGrad.addColorStop(0.65, '#f2ddb0');
      bGrad.addColorStop(1, '#c9af7a');
      ctx.fillStyle = bGrad;
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = '#8b7346';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    } else if (feat.surfaceType === SurfaceType.WATER) {
      const wGrad = ctx.createRadialGradient(midCx, midCy, 3, midCx, midCy, Math.max(14, (maxCx - minCx) * 0.65));
      wGrad.addColorStop(0, '#0369a1');
      wGrad.addColorStop(0.65, '#0284c7');
      wGrad.addColorStop(1, '#38bdf8');
      ctx.fillStyle = wGrad;
      ctx.fill();

      // Subtle water ripple shimmer
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(224, 242, 254, 0.25)';
      ctx.lineWidth = 1;
      for (let y = minCy + 6; y < maxCy - 4; y += 8) {
        ctx.beginPath();
        ctx.moveTo(minCx + 4, y);
        ctx.quadraticCurveTo(midCx, y - 2.5, maxCx - 4, y);
        ctx.stroke();
      }
      ctx.restore();

      ctx.strokeStyle = 'rgba(186, 230, 253, 0.75)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (feat.surfaceType === SurfaceType.TEE) {
      const tGrad = ctx.createLinearGradient(minCx, minCy, maxCx, maxCy);
      tGrad.addColorStop(0, '#4ade80');
      tGrad.addColorStop(1, '#228b3b');
      ctx.fillStyle = tGrad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(187, 247, 208, 0.7)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    ctx.restore();
  }

  private generateOrganicEllipsePoints(
    halfW: number,
    halfL: number,
    segs: number,
    organicAmp: number = 0.08,
    phase: number = 1.0
  ): { x: number; z: number }[] {
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < segs; i++) {
      const theta = (i / segs) * Math.PI * 2;
      const k =
        1.0 +
        organicAmp * Math.sin(theta * 2 + phase) +
        organicAmp * 0.55 * Math.cos(theta * 3 - phase * 1.4);
      pts.push({
        x: Math.cos(theta) * halfW * k,
        z: Math.sin(theta) * halfL * k
      });
    }
    return pts;
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
