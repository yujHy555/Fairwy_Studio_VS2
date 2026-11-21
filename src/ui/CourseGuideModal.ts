import { CourseGuideData, KYALAMI_COURSE_GUIDE, KyalamiHoleGuide } from '../data/KyalamiCourseData';

export interface CourseGuideTelemetry {
  activeHoleNum: number;
  isDemoHole: boolean;
  teeToPinMeters: number;
  ballToPinMeters: number;
  elevDeltaMeters: number;
}

export interface CourseGuideCallbacks {
  onSelectHoleIn3D?: (hole: KyalamiHoleGuide) => void;
  onSyncMapNGToHole?: (hole: KyalamiHoleGuide) => void;
}

export class CourseGuideModal {
  private guide: CourseGuideData = KYALAMI_COURSE_GUIDE;
  private callbacks: CourseGuideCallbacks;
  private overlay: HTMLDivElement | null = null;
  private isOpen = false;
  private currentView: 'overview' | 'hole' = 'overview';
  private activeDetailHoleNum = 1;
  private showDistanceGuide = true;
  private rulerStart: { x: number; y: number } | null = null;
  private rulerEnd: { x: number; y: number } | null = null;
  private isRulerDragging = false;
  private telemetry: CourseGuideTelemetry = {
    activeHoleNum: 1,
    isDemoHole: true,
    teeToPinMeters: 0,
    ballToPinMeters: 0,
    elevDeltaMeters: 0
  };

  constructor(callbacks: CourseGuideCallbacks = {}) {
    this.callbacks = callbacks;
    this.createDOM();
  }

  private createDOM() {
    const existing = document.getElementById('modal-course-guide');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'modal-course-guide';
    overlay.className = 'course-guide-overlay hidden';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Kyalami Country Club Interactive Course Guide');

    overlay.innerHTML = `
      <div class="course-guide-card" id="course-guide-card">
        <div class="cg-header">
          <div class="cg-brand">
            <img src="${this.guide.logoUrl}" alt="GCL" class="cg-logo" />
            <div>
              <div class="cg-title">${this.guide.name.toUpperCase()} <span class="cg-badge">PAR ${this.guide.parTotal} • 18 HOLES</span></div>
              <div class="cg-subtitle" id="cg-subtitle">Interactive Course Layout, Tee Distances &amp; Caddie Strategy</div>
            </div>
          </div>
          <div class="cg-header-actions">
            <button id="btn-cg-view-overview" class="cg-nav-pill is-active" title="Show Full 18-Hole Course Map">🗺️ Course Map</button>
            <button id="btn-cg-close" class="cg-close-btn" title="Close Course Guide [Esc / L]">✕</button>
          </div>
        </div>

        <div class="cg-hole-strip" id="cg-hole-strip">
          <!-- 1..18 quick hole selector -->
        </div>

        <!-- VIEW 1: INTERACTIVE 18-HOLE COURSE MAP -->
        <div id="cg-view-overview" class="cg-body cg-overview-body">
          <div class="cg-overview-top-meta">
            <span class="cg-hint-pill">👆 Click any hole pin on the map or numbered pill above to inspect yardage guides &amp; pro tips</span>
            <div class="cg-course-totals">
              <span class="cg-tee-chip tee-yellow" title="Championship Tees">${this.guide.totals.yellow}m</span>
              <span class="cg-tee-chip tee-white" title="Club Men Tees">${this.guide.totals.white}m</span>
              <span class="cg-tee-chip tee-blue" title="Forward / Senior Tees">${this.guide.totals.blue}m</span>
              <span class="cg-tee-chip tee-red" title="Ladies Tees">${this.guide.totals.red}m</span>
            </div>
          </div>

          <div class="cg-layout-map-stage">
            <div class="cg-layout-map-wrap" id="cg-layout-map-wrap">
              <img src="${this.guide.layoutImageUrl}" alt="Kyalami Country Club Course Layout" class="cg-layout-img" />
              <div id="cg-hotspots-layer" class="cg-hotspots-layer"></div>
            </div>
          </div>
        </div>

        <!-- VIEW 2: HOLE DETAIL CARD -->
        <div id="cg-view-hole" class="cg-body cg-hole-body hidden">
          <div class="cg-hole-topbar">
            <div class="cg-hole-identity">
              <span id="cg-detail-hole-num" class="cg-hole-num-circle">1</span>
              <div>
                <div class="cg-hole-par-si" id="cg-detail-par-si">PAR 4 • STROKE INDEX 11</div>
                <div class="cg-hole-sync-status" id="cg-detail-sync-status">Linked 3D Hole Telemetry</div>
              </div>
            </div>

            <div class="cg-tees-grid" id="cg-detail-tees">
              <!-- Populated per hole -->
            </div>

            <div class="cg-detail-nav">
              <button id="btn-cg-prev-hole" class="cg-arrow-btn" title="Previous Hole [←]">◀ Prev</button>
              <button id="btn-cg-next-hole" class="cg-arrow-btn" title="Next Hole [→]">Next ▶</button>
              <button id="btn-cg-load-hole-3d" class="cg-load3d-btn" title="Apply this Kyalami hole graphic &amp; specs to active 3D hole">🏌️ Load Hole in 3D</button>
            </div>
          </div>

          <div class="cg-detail-columns">
            <div class="cg-detail-left">
              <div class="cg-hole-graphic-frame">
                <img id="cg-hole-img" class="cg-hole-graphic-img" src="" alt="Hole Overhead Graphic" />
                <img id="cg-hole-dist-img" class="cg-hole-dist-overlay" src="" alt="Distance Guide Overlay" />
                <canvas id="cg-ruler-canvas" class="cg-ruler-canvas" title="Click &amp; drag anywhere on hole graphic to measure distance (double-click to clear)"></canvas>
              </div>
              <div class="cg-graphic-toolbar">
                <button id="btn-cg-toggle-dist" class="cg-dist-toggle is-active">🎯 Distance Guide: ON</button>
                <span class="cg-metric-note">Drag anywhere on hole to measure • Distances in meters from Tee</span>
              </div>
              <div class="cg-3d-telemetry-strip" id="cg-3d-telemetry-strip">
                <!-- Populated dynamically from 3D scene -->
              </div>
            </div>

            <div class="cg-detail-right">
              <div class="cg-protip-card">
                <div class="cg-protip-title">💡 CADDIE PRO TIP</div>
                <p id="cg-detail-protip" class="cg-protip-text"></p>
              </div>

              <div class="cg-minimap-card" id="btn-cg-minimap-back" title="Click to return to Full 18-Hole Course Map">
                <div class="cg-minimap-header">
                  <span>📍 COURSE LOCATOR</span>
                  <span class="cg-minimap-action">Return to Map ↗</span>
                </div>
                <div class="cg-minimap-stage">
                  <img src="${this.guide.miniLayoutImageUrl}" alt="Kyalami Course Locator" class="cg-minimap-img" />
                  <div id="cg-minimap-beacon" class="cg-minimap-beacon">
                    <span class="cg-beacon-ring"></span>
                    <span class="cg-beacon-dot"></span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.bindEvents();
    this.renderHoleStrip();
    this.renderHotspots();
  }

  private bindEvents() {
    const card = document.getElementById('course-guide-card');
    card?.addEventListener('pointerdown', (e) => e.stopPropagation());
    card?.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    this.overlay?.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });

    document.getElementById('btn-cg-close')?.addEventListener('click', () => this.close());
    document.getElementById('btn-cg-view-overview')?.addEventListener('click', () => this.showOverview());
    document.getElementById('btn-cg-minimap-back')?.addEventListener('click', () => this.showOverview());

    document.getElementById('btn-cg-prev-hole')?.addEventListener('click', () => {
      const prev = this.activeDetailHoleNum <= 1 ? 18 : this.activeDetailHoleNum - 1;
      this.showHole(prev);
    });

    document.getElementById('btn-cg-next-hole')?.addEventListener('click', () => {
      const next = this.activeDetailHoleNum >= 18 ? 1 : this.activeDetailHoleNum + 1;
      this.showHole(next);
    });

    document.getElementById('btn-cg-toggle-dist')?.addEventListener('click', () => {
      this.showDistanceGuide = !this.showDistanceGuide;
      this.syncDistanceOverlayVisual();
    });

    document.getElementById('btn-cg-load-hole-3d')?.addEventListener('click', () => {
      const hole = this.getHole(this.activeDetailHoleNum);
      if (hole) {
        this.callbacks.onSelectHoleIn3D?.(hole);
        this.updateTelemetry({ ...this.telemetry, activeHoleNum: hole.number, isDemoHole: false });
      }
    });

    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'ArrowLeft' && this.currentView === 'hole') {
        e.preventDefault();
        this.showHole(this.activeDetailHoleNum <= 1 ? 18 : this.activeDetailHoleNum - 1);
      } else if (e.key === 'ArrowRight' && this.currentView === 'hole') {
        e.preventDefault();
        this.showHole(this.activeDetailHoleNum >= 18 ? 1 : this.activeDetailHoleNum + 1);
      }
    });

    this.bindRulerEvents();
  }

  private bindRulerEvents() {
    const canvas = document.getElementById('cg-ruler-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

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
      this.redrawRuler();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.isRulerDragging || !this.rulerStart) return;
      e.stopPropagation();
      this.rulerEnd = getRelPt(e);
      this.redrawRuler();
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!this.isRulerDragging) return;
      e.stopPropagation();
      this.isRulerDragging = false;
      this.rulerEnd = getRelPt(e);
      this.redrawRuler();
    });
    canvas.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.clearRuler();
    });
  }

  private clearRuler() {
    this.isRulerDragging = false;
    this.rulerStart = null;
    this.rulerEnd = null;
    const canvas = document.getElementById('cg-ruler-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
  }

  private redrawRuler() {
    const canvas = document.getElementById('cg-ruler-canvas') as HTMLCanvasElement | null;
    const img = document.getElementById('cg-hole-img') as HTMLImageElement | null;
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
    if (!this.rulerStart || !this.rulerEnd) return;

    const dx = this.rulerEnd.x - this.rulerStart.x;
    const dy = this.rulerEnd.y - this.rulerStart.y;
    const pxDist = Math.hypot(dx, dy);
    if (pxDist < 2) return;

    const hole = this.getHole(this.activeDetailHoleNum);
    const matches3D = !this.telemetry.isDemoHole && this.telemetry.activeHoleNum === this.activeDetailHoleNum;
    const holeDistMeters =
      matches3D && this.telemetry.teeToPinMeters > 25
        ? this.telemetry.teeToPinMeters
        : (hole?.distances.yellow ?? 360);
    const imgRect = img?.getBoundingClientRect();
    const imgH = Math.max(60, imgRect?.height || rect.height);
    const metersPerPx = holeDistMeters / (imgH * 0.78);
    const distM = pxDist * metersPerPx;
    const distY = distM * 1.09361;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(this.rulerStart.x, this.rulerStart.y);
    ctx.lineTo(this.rulerEnd.x, this.rulerEnd.y);
    ctx.stroke();

    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(this.rulerStart.x, this.rulerStart.y);
    ctx.lineTo(this.rulerEnd.x, this.rulerEnd.y);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const pt of [this.rulerStart, this.rulerEnd]) {
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const label = `${Math.round(distM)}m (${Math.round(distY)} yds)`;
    ctx.font = '700 12px Inter, system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    const bw = tw + 16;
    const bh = 24;
    const midX = (this.rulerStart.x + this.rulerEnd.x) * 0.5;
    const midY = (this.rulerStart.y + this.rulerEnd.y) * 0.5 - 20;
    const bx = Math.max(6, Math.min(rect.width - bw - 6, midX - bw * 0.5));
    const by = Math.max(6, Math.min(rect.height - bh - 6, midY));

    ctx.fillStyle = 'rgba(10, 20, 34, 0.94)';
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fef08a';
    ctx.fillText(label, bx + 8, by + 16);
    ctx.restore();
  }

  private getHole(holeNum: number): KyalamiHoleGuide | undefined {
    return this.guide.holes.find((h) => h.number === holeNum);
  }

  private renderHoleStrip() {
    const strip = document.getElementById('cg-hole-strip');
    if (!strip) return;
    strip.innerHTML = this.guide.holes
      .map(
        (h) => `
          <button
            type="button"
            class="cg-hole-pill ${this.currentView === 'hole' && h.number === this.activeDetailHoleNum ? 'is-selected' : ''} ${h.number === this.telemetry.activeHoleNum && !this.telemetry.isDemoHole ? 'is-live-3d' : ''}"
            data-hole-num="${h.number}"
            title="Hole ${h.number} • Par ${h.par} • ${h.distances.yellow}m"
          >
            ${h.number}
          </button>
        `
      )
      .join('');

    strip.querySelectorAll('.cg-hole-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        const num = parseInt(btn.getAttribute('data-hole-num') || '1', 10);
        this.showHole(num);
      });
    });
  }

  private renderHotspots() {
    const layer = document.getElementById('cg-hotspots-layer');
    if (!layer) return;
    layer.innerHTML = this.guide.holes
      .map(
        (h) => `
          <button
            type="button"
            class="cg-map-hotspot ${h.number === this.telemetry.activeHoleNum && !this.telemetry.isDemoHole ? 'is-live-3d' : ''}"
            data-hole-num="${h.number}"
            style="top: ${h.hotspot.topPct}%; left: ${h.hotspot.leftPct}%; width: ${h.hotspot.widthPct}%; height: ${h.hotspot.heightPct}%;"
            title="Hole ${h.number} • Par ${h.par} • SI ${h.strokeIndex} • ${h.distances.yellow}m"
          >
            <span class="cg-hotspot-ring"></span>
            <span class="cg-hotspot-tip">H${h.number} • P${h.par} • ${h.distances.yellow}m</span>
          </button>
        `
      )
      .join('');

    layer.querySelectorAll('.cg-map-hotspot').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const num = parseInt(btn.getAttribute('data-hole-num') || '1', 10);
        this.showHole(num);
      });
    });
  }

  private syncDistanceOverlayVisual() {
    const distImg = document.getElementById('cg-hole-dist-img') as HTMLImageElement | null;
    const btn = document.getElementById('btn-cg-toggle-dist');
    if (distImg) {
      distImg.style.opacity = this.showDistanceGuide ? '1' : '0';
    }
    if (btn) {
      btn.classList.toggle('is-active', this.showDistanceGuide);
      btn.innerText = this.showDistanceGuide ? '🎯 Distance Guide: ON' : '🎯 Distance Guide: OFF';
    }
  }

  public showOverview() {
    this.clearRuler();
    this.currentView = 'overview';
    document.getElementById('cg-view-overview')?.classList.remove('hidden');
    document.getElementById('cg-view-hole')?.classList.add('hidden');
    document.getElementById('btn-cg-view-overview')?.classList.add('is-active');
    const sub = document.getElementById('cg-subtitle');
    if (sub) sub.innerText = 'Interactive 18-Hole Map • Click Any Hole Marker for Strategy & Distances';
    this.renderHoleStrip();
    this.renderHotspots();
  }

  public showHole(holeNum: number) {
    const hole = this.getHole(holeNum);
    if (!hole) return;
    this.clearRuler();
    this.activeDetailHoleNum = hole.number;
    this.currentView = 'hole';

    document.getElementById('cg-view-overview')?.classList.add('hidden');
    document.getElementById('cg-view-hole')?.classList.remove('hidden');
    document.getElementById('btn-cg-view-overview')?.classList.remove('is-active');

    const numEl = document.getElementById('cg-detail-hole-num');
    const parSiEl = document.getElementById('cg-detail-par-si');
    const teesEl = document.getElementById('cg-detail-tees');
    const proTipEl = document.getElementById('cg-detail-protip');
    const holeImg = document.getElementById('cg-hole-img') as HTMLImageElement | null;
    const distImg = document.getElementById('cg-hole-dist-img') as HTMLImageElement | null;
    const beacon = document.getElementById('cg-minimap-beacon');
    const sub = document.getElementById('cg-subtitle');

    if (numEl) numEl.innerText = String(hole.number);
    if (parSiEl) parSiEl.innerText = `PAR ${hole.par} • STROKE INDEX ${hole.strokeIndex}`;
    if (sub) sub.innerText = `Hole ${hole.number} • Par ${hole.par} • Championship ${hole.distances.yellow}m (${Math.round(hole.distances.yellow * 1.09361)} yds)`;

    if (teesEl) {
      const mY = (m: number) => `${m}m`;
      teesEl.innerHTML = `
        <div class="cg-tee-pill tee-yellow" title="Yellow Championship (${Math.round(hole.distances.yellow * 1.09361)} yds)"><span>YELLOW</span><strong>${mY(hole.distances.yellow)}</strong></div>
        <div class="cg-tee-pill tee-white" title="White Club (${Math.round(hole.distances.white * 1.09361)} yds)"><span>WHITE</span><strong>${mY(hole.distances.white)}</strong></div>
        <div class="cg-tee-pill tee-blue" title="Blue Forward (${Math.round(hole.distances.blue * 1.09361)} yds)"><span>BLUE</span><strong>${mY(hole.distances.blue)}</strong></div>
        <div class="cg-tee-pill tee-red" title="Red Ladies (${Math.round(hole.distances.red * 1.09361)} yds)"><span>RED</span><strong>${mY(hole.distances.red)}</strong></div>
      `;
    }

    if (proTipEl) proTipEl.innerText = hole.proTip;
    if (holeImg) holeImg.src = hole.imageUrl;
    if (distImg) distImg.src = hole.distanceGuideUrl;

    if (beacon) {
      beacon.style.top = `${hole.hotspot.topPct + hole.hotspot.heightPct * 0.5}%`;
      beacon.style.left = `${hole.hotspot.leftPct + hole.hotspot.widthPct * 0.5}%`;
    }

    this.syncDistanceOverlayVisual();
    this.renderHoleStrip();
    this.renderTelemetryStrip();
  }

  private renderTelemetryStrip() {
    const strip = document.getElementById('cg-3d-telemetry-strip');
    const syncStatus = document.getElementById('cg-detail-sync-status');
    if (!strip) return;

    const matches3D = !this.telemetry.isDemoHole && this.telemetry.activeHoleNum === this.activeDetailHoleNum;
    const hole = this.getHole(this.activeDetailHoleNum);
    const cardDist = hole?.distances.yellow ?? 0;

    if (syncStatus) {
      syncStatus.innerText = matches3D
        ? 'Live 3D Active Hole Synced'
        : this.telemetry.isDemoHole
        ? `Previewing Kyalami Hole ${this.activeDetailHoleNum} (Currently on Demo Hole)`
        : `Active 3D Hole: #${this.telemetry.activeHoleNum}`;
    }

    const elevSign = this.telemetry.elevDeltaMeters >= 0 ? '+' : '';
    strip.innerHTML = matches3D
      ? `
        <div class="cg-tel-item"><span>3D TEE→PIN</span><strong>${Math.round(this.telemetry.teeToPinMeters)}m</strong></div>
        <div class="cg-tel-item"><span>BALL→PIN</span><strong>${Math.round(this.telemetry.ballToPinMeters)}m</strong></div>
        <div class="cg-tel-item"><span>ELEVATION</span><strong>${elevSign}${this.telemetry.elevDeltaMeters.toFixed(1)}m</strong></div>
      `
      : `
        <div class="cg-tel-item"><span>CARD LENGTH</span><strong>${cardDist}m / ${Math.round(cardDist * 1.09361)}y</strong></div>
        <div class="cg-tel-item"><span>ACTIVE 3D</span><strong>${this.telemetry.isDemoHole ? 'Demo Hole' : `Hole ${this.telemetry.activeHoleNum}`}</strong></div>
        <div class="cg-tel-item"><span>PIN DIST</span><strong>${Math.round(this.telemetry.ballToPinMeters)}m</strong></div>
      `;
  }

  public updateTelemetry(next: CourseGuideTelemetry) {
    this.telemetry = next;
    if (this.isOpen) {
      this.renderHoleStrip();
      if (this.currentView === 'overview') {
        this.renderHotspots();
      } else {
        this.renderTelemetryStrip();
      }
    }
  }

  public open(initialHoleNum?: number) {
    this.isOpen = true;
    this.overlay?.classList.remove('hidden');
    if (initialHoleNum && initialHoleNum >= 1 && initialHoleNum <= 18 && !this.telemetry.isDemoHole) {
      this.showHole(initialHoleNum);
    } else {
      this.showOverview();
    }
  }

  public close() {
    this.isOpen = false;
    this.clearRuler();
    this.overlay?.classList.add('hidden');
  }

  public toggle(initialHoleNum?: number) {
    if (this.isOpen) this.close();
    else this.open(initialHoleNum);
  }

  public isVisible(): boolean {
    return this.isOpen;
  }
}
