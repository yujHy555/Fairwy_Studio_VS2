import {
  Scene,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  LinesMesh
} from '@babylonjs/core';
import { SurfaceType } from '../core/Constants';
import { TerrainGrid } from './TerrainGrid';
import {
  PolygonPoint,
  catmullRomClosed,
  rdpSimplify
} from './PolygonMath';

export type TraceToolMode = 'off' | 'spline' | 'freehand';

export interface FeatureTracerCallbacks {
  onCommitTracedFeature: (surfaceType: SurfaceType, contour: PolygonPoint[]) => void;
  onContourEdited: (featureIndex: number, newContour: PolygonPoint[], isFinal: boolean) => void;
  onTraceStateChange?: (state: {
    mode: TraceToolMode;
    targetSurface: SurfaceType;
    pointCount: number;
  }) => void;
}

export class FeatureTracer {
  private scene: Scene;
  private terrain: TerrainGrid;
  private callbacks: FeatureTracerCallbacks;

  private mode: TraceToolMode = 'off';
  private targetSurface: SurfaceType = SurfaceType.BUNKER;

  private activePoints: PolygonPoint[] = [];
  private isFreehandDrawing = false;
  private cursorWorld: { x: number; z: number } | null = null;

  private previewLine: LinesMesh | null = null;
  private pointMarkers: Mesh[] = [];
  private matPoint: StandardMaterial;
  private matStartPoint: StandardMaterial;
  private matEditNode: StandardMaterial;

  // Perimeter node editing on selected traced feature
  private editFeatureIndex = -1;
  private editNodeHandles: Mesh[] = [];
  private editHandleContourIdx: number[] = [];
  private activeDragHandlePos = -1;
  private editContourStep = 1;

  constructor(scene: Scene, terrain: TerrainGrid, callbacks: FeatureTracerCallbacks) {
    this.scene = scene;
    this.terrain = terrain;
    this.callbacks = callbacks;

    this.matPoint = new StandardMaterial('tracerPointMat', this.scene);
    this.matPoint.diffuseColor = new Color3(0.1, 0.85, 1.0);
    this.matPoint.emissiveColor = new Color3(0.05, 0.65, 0.95);
    this.matPoint.disableLighting = true;

    this.matStartPoint = new StandardMaterial('tracerStartMat', this.scene);
    this.matStartPoint.diffuseColor = new Color3(0.2, 1.0, 0.45);
    this.matStartPoint.emissiveColor = new Color3(0.15, 0.9, 0.38);
    this.matStartPoint.disableLighting = true;

    this.matEditNode = new StandardMaterial('tracerEditNodeMat', this.scene);
    this.matEditNode.diffuseColor = new Color3(1.0, 0.78, 0.15);
    this.matEditNode.emissiveColor = new Color3(0.95, 0.58, 0.05);
    this.matEditNode.disableLighting = true;
  }

  public getMode(): TraceToolMode {
    return this.mode;
  }

  public getTargetSurface(): SurfaceType {
    return this.targetSurface;
  }

  public isBusyDragging(): boolean {
    return this.isFreehandDrawing || this.activeDragHandlePos >= 0;
  }

  public setTargetSurface(surface: SurfaceType) {
    this.targetSurface = surface;
    this.emitState();
  }

  public setTraceMode(mode: TraceToolMode, targetSurface?: SurfaceType) {
    if (targetSurface !== undefined) {
      this.targetSurface = targetSurface;
    }
    this.mode = mode;
    this.isFreehandDrawing = false;
    this.activePoints = [];
    this.cursorWorld = null;
    this.clearPreviewVisuals();
    if (mode !== 'off') {
      this.clearEditHandles();
    }
    this.emitState();
  }

  private emitState() {
    this.callbacks.onTraceStateChange?.({
      mode: this.mode,
      targetSurface: this.targetSurface,
      pointCount: this.activePoints.length
    });
  }

  public handlePointerDown(
    event: PointerEvent,
    worldPt: { x: number; y: number; z: number } | null
  ): boolean {
    if (event.button !== 0) return false;

    // 1. Check draggable perimeter node handles on currently selected traced feature
    if (this.mode === 'off' && this.editFeatureIndex >= 0 && this.editHandleContourIdx.length > 0 && worldPt) {
      let bestHandle = -1;
      let bestDist = 2.6;
      const feat = this.terrain.stampedFeatures[this.editFeatureIndex];
      const contour = feat?.contour;
      if (contour) {
        for (let hIdx = 0; hIdx < this.editHandleContourIdx.length; hIdx++) {
          const cIdx = this.editHandleContourIdx[hIdx];
          const p = contour[cIdx];
          if (!p) continue;
          const d = Math.hypot(p.x - worldPt.x, p.z - worldPt.z);
          if (d < bestDist) {
            bestDist = d;
            bestHandle = hIdx;
          }
        }
      }
      if (bestHandle >= 0) {
        this.activeDragHandlePos = bestHandle;
        return true;
      }
    }

    if (this.mode === 'off' || !worldPt) return false;

    if (this.mode === 'spline') {
      // Snap & close if clicking near start node with >= 3 points
      if (this.activePoints.length >= 3) {
        const start = this.activePoints[0];
        if (Math.hypot(worldPt.x - start.x, worldPt.z - start.z) <= 3.0) {
          this.finishTrace();
          return true;
        }
      }
      this.activePoints.push({ x: worldPt.x, z: worldPt.z });
      this.cursorWorld = { x: worldPt.x, z: worldPt.z };
      this.rebuildPreviewVisuals();
      this.emitState();
      return true;
    }

    if (this.mode === 'freehand') {
      this.isFreehandDrawing = true;
      this.activePoints = [{ x: worldPt.x, z: worldPt.z }];
      this.cursorWorld = { x: worldPt.x, z: worldPt.z };
      this.rebuildPreviewVisuals();
      this.emitState();
      return true;
    }

    return false;
  }

  public handlePointerMove(worldPt: { x: number; y: number; z: number } | null): boolean {
    if (this.activeDragHandlePos >= 0 && worldPt && this.editFeatureIndex >= 0) {
      const feat = this.terrain.stampedFeatures[this.editFeatureIndex];
      const centerIdx = this.editHandleContourIdx[this.activeDragHandlePos];
      if (feat?.contour && centerIdx !== undefined && feat.contour[centerIdx]) {
        const n = feat.contour.length;
        const deltaX = worldPt.x - feat.contour[centerIdx].x;
        const deltaZ = worldPt.z - feat.contour[centerIdx].z;
        const influenceRadius = Math.max(1, this.editContourStep);

        const updated = feat.contour.map((p, idx) => {
          let ringDist = Math.abs(idx - centerIdx);
          ringDist = Math.min(ringDist, n - ringDist);
          if (ringDist === 0) {
            return { ...p, x: worldPt.x, z: worldPt.z };
          }
          if (ringDist < influenceRadius) {
            const w = 0.5 * (1 + Math.cos((ringDist / influenceRadius) * Math.PI));
            return { ...p, x: p.x + deltaX * w, z: p.z + deltaZ * w };
          }
          return { ...p };
        });

        const h = this.terrain.getElevation(worldPt.x, worldPt.z);
        const mesh = this.editNodeHandles[this.activeDragHandlePos];
        if (mesh) {
          mesh.position.set(worldPt.x, h + 0.35, worldPt.z);
        }
        this.callbacks.onContourEdited(this.editFeatureIndex, updated, false);
        return true;
      }
    }

    if (this.mode === 'off' || !worldPt) return false;
    this.cursorWorld = { x: worldPt.x, z: worldPt.z };

    if (this.mode === 'freehand' && this.isFreehandDrawing) {
      const last = this.activePoints[this.activePoints.length - 1];
      if (!last || Math.hypot(worldPt.x - last.x, worldPt.z - last.z) >= 1.25) {
        this.activePoints.push({ x: worldPt.x, z: worldPt.z });
        this.rebuildPreviewVisuals();
        this.emitState();
      }
      return true;
    }

    if (this.mode === 'spline' && this.activePoints.length > 0) {
      this.rebuildPreviewVisuals();
    }
    return false;
  }

  public handlePointerUp(): boolean {
    if (this.activeDragHandlePos >= 0 && this.editFeatureIndex >= 0) {
      const feat = this.terrain.stampedFeatures[this.editFeatureIndex];
      const idx = this.editFeatureIndex;
      this.activeDragHandlePos = -1;
      if (feat?.contour) {
        this.callbacks.onContourEdited(idx, feat.contour.map((p) => ({ ...p })), true);
      }
      return true;
    }

    if (this.mode === 'freehand' && this.isFreehandDrawing) {
      this.isFreehandDrawing = false;
      if (this.activePoints.length >= 3) {
        const simplified = rdpSimplify(this.activePoints, 1.45);
        if (simplified.length >= 3) {
          const smoothed = catmullRomClosed(simplified, 3);
          this.activePoints = [];
          this.cursorWorld = null;
          this.clearPreviewVisuals();
          this.mode = 'off';
          this.callbacks.onCommitTracedFeature(this.targetSurface, smoothed);
          this.emitState();
          return true;
        }
      }
      this.activePoints = [];
      this.clearPreviewVisuals();
      this.emitState();
      return true;
    }

    return false;
  }

  public undoLastPoint(): boolean {
    if (this.mode !== 'spline' || this.activePoints.length === 0) return false;
    this.activePoints.pop();
    this.rebuildPreviewVisuals();
    this.emitState();
    return true;
  }

  /**
   * Chaikin corner-cutting subdivision: automatically rounds sharp hand-clicked
   * spline corners into organic PGA Tour curves while keeping vertex count lightweight.
   */
  private chaikinSmoothClosed(pts: PolygonPoint[], iterations: number = 2): PolygonPoint[] {
    let cur = pts.map((p) => ({ x: p.x, z: p.z }));
    for (let it = 0; it < iterations; it++) {
      const n = cur.length;
      if (n < 3) break;
      const next: PolygonPoint[] = [];
      for (let i = 0; i < n; i++) {
        const p0 = cur[i];
        const p1 = cur[(i + 1) % n];
        next.push({ x: p0.x * 0.75 + p1.x * 0.25, z: p0.z * 0.75 + p1.z * 0.25 });
        next.push({ x: p0.x * 0.25 + p1.x * 0.75, z: p0.z * 0.25 + p1.z * 0.75 });
      }
      cur = next;
      if (cur.length >= 48) break;
    }
    return cur;
  }

  public finishTrace(): boolean {
    if (this.activePoints.length < 3) return false;
    const raw =
      this.mode === 'freehand'
        ? rdpSimplify(this.activePoints, 1.45)
        : this.activePoints.map((p) => ({ ...p }));
    // Auto-round corners with Chaikin subdivision + Catmull-Rom spline for silky, optimized contours
    const rounded = this.chaikinSmoothClosed(raw, 2);
    const segsPerSpan = rounded.length > 24 ? 1 : 2;
    const smoothed = catmullRomClosed(rounded, segsPerSpan);
    const surf = this.targetSurface;
    this.activePoints = [];
    this.cursorWorld = null;
    this.isFreehandDrawing = false;
    this.clearPreviewVisuals();
    this.mode = 'off';
    this.callbacks.onCommitTracedFeature(surf, smoothed);
    this.emitState();
    return true;
  }

  public cancelTrace() {
    this.activePoints = [];
    this.cursorWorld = null;
    this.isFreehandDrawing = false;
    this.clearPreviewVisuals();
    this.setTraceMode('off');
  }

  public syncSelectedFeatureNodes(featureIndex: number) {
    this.clearEditHandles();
    if (featureIndex < 0 || featureIndex >= this.terrain.stampedFeatures.length) return;
    const feat = this.terrain.stampedFeatures[featureIndex];
    if (!feat.contour || feat.contour.length < 3 || this.mode !== 'off') return;

    this.editFeatureIndex = featureIndex;
    const step = Math.max(1, Math.ceil(feat.contour.length / 28));
    this.editContourStep = step;
    for (let i = 0; i < feat.contour.length; i += step) {
      const p = feat.contour[i];
      const y = this.terrain.getElevation(p.x, p.z) + 0.35;
      const nodeMesh = MeshBuilder.CreateSphere(
        `traceNode_${featureIndex}_${i}`,
        { diameter: 0.9, segments: 8 },
        this.scene
      );
      nodeMesh.position.set(p.x, y, p.z);
      nodeMesh.material = this.matEditNode;
      nodeMesh.isPickable = false;
      this.editNodeHandles.push(nodeMesh);
      this.editHandleContourIdx.push(i);
    }
  }

  private rebuildPreviewVisuals() {
    this.clearPreviewVisuals();
    if (this.activePoints.length === 0) return;

    for (let i = 0; i < this.activePoints.length; i++) {
      // In freehand mode only place start/end markers so stroke stays ultra fast
      if (this.mode === 'freehand' && i > 0 && i < this.activePoints.length - 1) continue;
      const p = this.activePoints[i];
      const y = this.terrain.getElevation(p.x, p.z) + 0.25;
      const dot = MeshBuilder.CreateSphere(
        `tracerPt_${i}`,
        { diameter: i === 0 ? 1.05 : 0.72, segments: 8 },
        this.scene
      );
      dot.position.set(p.x, y, p.z);
      dot.material = i === 0 ? this.matStartPoint : this.matPoint;
      dot.isPickable = false;
      this.pointMarkers.push(dot);
    }

    const linePts: Vector3[] = [];
    const srcPts =
      this.activePoints.length >= 3 && this.mode === 'spline'
        ? catmullRomClosed(this.activePoints, 4)
        : this.activePoints;

    for (const p of srcPts) {
      const y = this.terrain.getElevation(p.x, p.z) + 0.22;
      linePts.push(new Vector3(p.x, y, p.z));
    }
    if (this.mode === 'spline' && this.cursorWorld && this.activePoints.length < 3) {
      const cy = this.terrain.getElevation(this.cursorWorld.x, this.cursorWorld.z) + 0.22;
      linePts.push(new Vector3(this.cursorWorld.x, cy, this.cursorWorld.z));
    }
    if (this.activePoints.length >= 3) {
      linePts.push(linePts[0].clone());
    }

    if (linePts.length >= 2) {
      this.previewLine = MeshBuilder.CreateLines(
        'tracerPreviewRibbon',
        { points: linePts },
        this.scene
      );
      this.previewLine.color = new Color3(0.05, 0.92, 1.0);
      this.previewLine.isPickable = false;
    }
  }

  private clearPreviewVisuals() {
    if (this.previewLine) {
      this.previewLine.dispose();
      this.previewLine = null;
    }
    for (const m of this.pointMarkers) {
      m.dispose();
    }
    this.pointMarkers = [];
  }

  private clearEditHandles() {
    this.editFeatureIndex = -1;
    this.activeDragHandlePos = -1;
    this.editHandleContourIdx = [];
    for (const m of this.editNodeHandles) {
      m.dispose();
    }
    this.editNodeHandles = [];
  }

  public dispose() {
    this.clearPreviewVisuals();
    this.clearEditHandles();
    this.matPoint.dispose();
    this.matStartPoint.dispose();
    this.matEditNode.dispose();
  }
}
