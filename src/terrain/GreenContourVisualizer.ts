import {
  Scene,
  Mesh,
  InstancedMesh,
  AbstractMesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Color4,
  Vector3,
  LinesMesh
} from '@babylonjs/core';
import { TerrainGrid } from './TerrainGrid';
import { SurfaceType } from '../core/Constants';

interface SlopeComet {
  baseX: number;
  baseZ: number;
  phaseOffset: number;
  slopeDirX: number;
  slopeDirZ: number;
  slopeMagnitude: number;
  headMesh: Mesh | InstancedMesh;
  midMesh: Mesh | InstancedMesh;
  tailMesh: Mesh | InstancedMesh;
}

export class GreenContourVisualizer {
  private scene: Scene;
  private terrain: TerrainGrid;

  public showGrid: boolean = false;
  public showDots: boolean = false;
  public gridAlpha: number = 0.0;
  public dotsAlpha: number = 0.0;

  private comets: SlopeComet[] = [];
  private beadParent: Mesh;
  private cometTemplate: Mesh | null = null;
  private matMild: StandardMaterial;
  private matMed: StandardMaterial;
  private matSteep: StandardMaterial;
  private contourLineGrid: LinesMesh | null = null;
  private waveTime: number = 0;

  constructor(scene: Scene, terrain: TerrainGrid) {
    this.scene = scene;
    this.terrain = terrain;

    this.beadParent = new Mesh('GreenContourParent', this.scene);
    this.beadParent.isPickable = false;
    this.beadParent.position.set(0, 0, 0);
    this.beadParent.rotation.set(0, 0, 0);
    this.beadParent.scaling.set(1, 1, 1);
    this.beadParent.setEnabled(false);

    // Color-coded luminous materials for slope comets (Mild = Lime/Cyan, Medium = Gold, Steep = Coral Red)
    this.matMild = new StandardMaterial('slopeBeadMild', this.scene);
    this.matMild.emissiveColor = new Color3(0.35, 1.0, 0.55);
    this.matMild.disableLighting = true;
    this.matMild.alpha = 0.0;

    this.matMed = new StandardMaterial('slopeBeadMed', this.scene);
    this.matMed.emissiveColor = new Color3(1.0, 0.88, 0.20);
    this.matMed.disableLighting = true;
    this.matMed.alpha = 0.0;

    this.matSteep = new StandardMaterial('slopeBeadSteep', this.scene);
    this.matSteep.emissiveColor = new Color3(1.0, 0.35, 0.15);
    this.matSteep.disableLighting = true;
    this.matSteep.alpha = 0.0;

    this.rebuildSlopeGrid();

    this.scene.onBeforeRenderObservable.add(() => {
      if (this.dotsAlpha <= 0.005 || this.comets.length === 0) return;
      const dt = this.scene.getEngine().getDeltaTime() / 1000;
      this.updateComets(dt);
    });
  }

  /**
   * Smoothly animates visibility of Green Grid and Green Slope Dots independently.
   */
  public updatePuttingFade(dt: number) {
    if (this.showGrid) {
      this.gridAlpha = Math.min(1.0, this.gridAlpha + dt * 2.2);
    } else {
      this.gridAlpha = Math.max(0.0, this.gridAlpha - dt * 2.0);
    }

    if (this.showDots) {
      this.dotsAlpha = Math.min(1.0, this.dotsAlpha + dt * 2.2);
    } else {
      this.dotsAlpha = Math.max(0.0, this.dotsAlpha - dt * 2.4);
    }

    if (this.contourLineGrid) {
      if (this.gridAlpha <= 0.005) {
        this.contourLineGrid.setEnabled(false);
      } else {
        this.contourLineGrid.setEnabled(true);
        this.contourLineGrid.visibility = this.gridAlpha;
      }
    }

    if (this.dotsAlpha <= 0.005) {
      this.beadParent.setEnabled(false);
    } else {
      this.beadParent.setEnabled(true);
      this.matMild.alpha = this.dotsAlpha;
      this.matMed.alpha = this.dotsAlpha;
      this.matSteep.alpha = this.dotsAlpha;
    }
  }

  public setGridVisible(visible: boolean) {
    this.showGrid = visible;
  }

  public setDotsVisible(visible: boolean) {
    this.showDots = visible;
  }

  public toggleGrid(): boolean {
    this.showGrid = !this.showGrid;
    return this.showGrid;
  }

  public toggleDots(): boolean {
    this.showDots = !this.showDots;
    return this.showDots;
  }

  public setVisible(visible: boolean) {
    this.setGridVisible(visible);
    this.setDotsVisible(visible);
  }

  public toggleVisible(): boolean {
    const next = !(this.showGrid || this.showDots);
    this.setVisible(next);
    return next;
  }

  /**
   * Builds:
   * 1. Clean 1.5m x 1.5m PGA Tour contour grid with smooth 0.3m elevation curve sampling
   * 2. Synchronized 3-dot comet trails that flow smoothly downhill in coherent wave fronts (zero random jitter)
   */
  public rebuildSlopeGrid() {
    this.beadParent.position.set(0, 0, 0);
    this.beadParent.rotation.set(0, 0, 0);
    this.beadParent.scaling.set(1, 1, 1);
    this.beadParent.isPickable = false;

    if (this.contourLineGrid) {
      this.contourLineGrid.dispose();
      this.contourLineGrid = null;
    }

    for (const c of this.comets) {
      c.headMesh.dispose();
      c.midMesh.dispose();
      c.tailMesh.dispose();
    }
    this.comets = [];

    const lines: Vector3[][] = [];
    const colors: Color4[][] = [];

    const gridSpacing = 1.5; // Clean 1.5m grid spacing for uncluttered readability
    const sampleStep = 0.3;  // Smooth 30cm curve vertices along each grid line

    let minX = this.terrain.width, maxX = 0;
    let minZ = this.terrain.length, maxZ = 0;
    let hasGreen = false;

    const greenFeat = this.terrain.stampedFeatures.find(
      f => f.surfaceType === SurfaceType.GREEN || (f.surfaceType as any) === 'green' || (f.surfaceType as any) === 'GREEN'
    );
    if (greenFeat) {
      const collarPad = Math.max(3.5, (greenFeat.materialSettings?.collarWidth ?? 2.0) + 3.5);
      const halfDim = Math.max(greenFeat.width, greenFeat.length) * 0.65 + collarPad;
      minX = Math.max(0, Math.floor(greenFeat.centerX - halfDim));
      maxX = Math.min(this.terrain.width, Math.ceil(greenFeat.centerX + halfDim));
      minZ = Math.max(0, Math.floor(greenFeat.centerZ - halfDim));
      maxZ = Math.min(this.terrain.length, Math.ceil(greenFeat.centerZ + halfDim));
      hasGreen = true;
    } else {
      const step = Math.max(1, this.terrain.cellSize || 1);
      for (let z = 0; z < this.terrain.length; z += step) {
        for (let x = 0; x < this.terrain.width; x += step) {
          const s = this.terrain.getSurfaceAt(x, z);
          if (s === SurfaceType.GREEN || s === SurfaceType.FRINGE) {
            hasGreen = true;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
          }
        }
      }
      minX = Math.max(0, Math.floor(minX - 4));
      maxX = Math.min(this.terrain.width, Math.ceil(maxX + 4));
      minZ = Math.max(0, Math.floor(minZ - 4));
      maxZ = Math.min(this.terrain.length, Math.ceil(maxZ + 4));
    }

    if (!hasGreen) return;

    const getSlopeColor = (slope: number): Color4 => {
      if (slope < 0.012) {
        return new Color4(0.75, 0.95, 1.0, 0.65); // Nearly flat: soft ice-white/cyan
      } else if (slope < 0.032) {
        return new Color4(0.30, 0.98, 0.48, 0.85); // Gentle break: emerald green
      } else if (slope < 0.060) {
        return new Color4(1.0, 0.88, 0.22, 0.92); // Medium break: warm gold
      } else {
        return new Color4(1.0, 0.35, 0.16, 1.0); // Strong break: coral red
      }
    };

    // Cover both the Putting Green AND its surrounding Collar / Fringe cleanly
    const isGreenOrCollar = (wx: number, wz: number): boolean => {
      const s = this.terrain.getSurfaceAt(wx, wz);
      if (s === SurfaceType.GREEN || s === SurfaceType.FRINGE) return true;
      if (greenFeat) {
        const collarW = Math.max(1.8, greenFeat.materialSettings?.collarWidth ?? 2.0);
        const dx = wx - greenFeat.centerX;
        const dz = wz - greenFeat.centerZ;
        const cosR = Math.cos(-(greenFeat.rotationRad || 0));
        const sinR = Math.sin(-(greenFeat.rotationRad || 0));
        const lx = dx * cosR - dz * sinR;
        const lz = dx * sinR + dz * cosR;
        const rx = Math.max(1, greenFeat.width * 0.5 + collarW);
        const rz = Math.max(1, greenFeat.length * 0.5 + collarW);
        return (lx * lx) / (rx * rx) + (lz * lz) / (rz * rz) <= 1.0;
      }
      return false;
    };

    // 1. X-direction contour lines (every 1.5m in Z)
    for (let z = minZ; z <= maxZ; z += gridSpacing) {
      let curSegment: Vector3[] = [];
      let curColors: Color4[] = [];

      for (let x = minX; x <= maxX; x += sampleStep) {
        if (isGreenOrCollar(x, z)) {
          const elev = this.terrain.getElevation(x, z) + 0.028;
          const normal = this.terrain.getNormal(x, z);
          const slope = Math.sqrt(normal.x * normal.x + normal.z * normal.z);
          curSegment.push(new Vector3(x, elev, z));
          curColors.push(getSlopeColor(slope));
        } else {
          if (curSegment.length >= 2) {
            lines.push(curSegment);
            colors.push(curColors);
          }
          curSegment = [];
          curColors = [];
        }
      }
      if (curSegment.length >= 2) {
        lines.push(curSegment);
        colors.push(curColors);
      }
    }

    // 2. Z-direction contour lines (every 1.5m in X)
    for (let x = minX; x <= maxX; x += gridSpacing) {
      let curSegment: Vector3[] = [];
      let curColors: Color4[] = [];

      for (let z = minZ; z <= maxZ; z += sampleStep) {
        if (isGreenOrCollar(x, z)) {
          const elev = this.terrain.getElevation(x, z) + 0.028;
          const normal = this.terrain.getNormal(x, z);
          const slope = Math.sqrt(normal.x * normal.x + normal.z * normal.z);
          curSegment.push(new Vector3(x, elev, z));
          curColors.push(getSlopeColor(slope));
        } else {
          if (curSegment.length >= 2) {
            lines.push(curSegment);
            colors.push(curColors);
          }
          curSegment = [];
          curColors = [];
        }
      }
      if (curSegment.length >= 2) {
        lines.push(curSegment);
        colors.push(curColors);
      }
    }

    if (lines.length > 0) {
      this.contourLineGrid = MeshBuilder.CreateLineSystem(
        'greenContourLineGrid',
        {
          lines,
          colors,
          useVertexAlpha: true,
          updatable: false
        },
        this.scene
      );
      this.contourLineGrid.isPickable = false;
      this.contourLineGrid.position.set(0, 0, 0);
      this.contourLineGrid.rotation.set(0, 0, 0);
      this.contourLineGrid.scaling.set(1, 1, 1);
      this.contourLineGrid.renderingGroupId = 0; // Under ball (groupId 2)
      this.contourLineGrid.visibility = this.gridAlpha;
      this.contourLineGrid.setEnabled(this.gridAlpha > 0.005);
    }

    // 3. Synchronized Downhill Comet Beads (placed at 2.0m intervals for crystal-clear reading)
    // Instanced GPU spheres for high-performance slope reading
    if (!this.cometTemplate || this.cometTemplate.isDisposed()) {
      this.cometTemplate = MeshBuilder.CreateSphere('cometTemplate', { diameter: 0.16, segments: 8 }, this.scene);
      this.cometTemplate.isVisible = false;
      this.cometTemplate.isPickable = false;
      this.cometTemplate.position.set(0, -9999, 0);
    }
    const templateSphere = this.cometTemplate;

    const dotSpacing = 2.0;
    for (let z = minZ + 0.75; z <= maxZ; z += dotSpacing) {
      for (let x = minX + 0.75; x <= maxX; x += dotSpacing) {
        if (isGreenOrCollar(x, z)) {
          const normal = this.terrain.getNormal(x, z);
          // Normal.x and normal.z point downhill (-dh/dx, -dh/dz), exactly matching ball break
          const slopeX = normal.x;
          const slopeZ = normal.z;
          const slopeMag = Math.sqrt(slopeX * slopeX + slopeZ * slopeZ);

          if (slopeMag > 0.002) {
            const dirX = slopeX / slopeMag;
            const dirZ = slopeZ / slopeMag;

            const mat = slopeMag < 0.032 ? this.matMild : slopeMag < 0.060 ? this.matMed : this.matSteep;

            const headMesh = templateSphere.createInstance(`comet_h_${x}_${z}`);
            headMesh.parent = this.beadParent;
            const midMesh = templateSphere.createInstance(`comet_m_${x}_${z}`);
            midMesh.parent = this.beadParent;
            const tailMesh = templateSphere.createInstance(`comet_t_${x}_${z}`);
            tailMesh.parent = this.beadParent;

            headMesh.material = mat;
            midMesh.material = mat;
            tailMesh.material = mat;

            headMesh.renderingGroupId = 1;
            midMesh.renderingGroupId = 1;
            tailMesh.renderingGroupId = 1;

            headMesh.isVisible = true;
            midMesh.isVisible = true;
            tailMesh.isVisible = true;

            headMesh.isPickable = false;
            midMesh.isPickable = false;
            tailMesh.isPickable = false;

            // Deterministic spatial wave phase along downhill direction so adjacent dots flow in unison!
            const spatialWave = (((x * dirX + z * dirZ) * 0.22) % 1.0 + 1.0) % 1.0;

            this.comets.push({
              baseX: x,
              baseZ: z,
              phaseOffset: spatialWave,
              slopeDirX: dirX,
              slopeDirZ: dirZ,
              slopeMagnitude: slopeMag,
              headMesh,
              midMesh,
              tailMesh
            });
          }
        }
      }
    }

    // Keep cometTemplate alive (invisible) so all InstancedMesh slope dots remain active and visible!
    this.beadParent.setEnabled(this.dotsAlpha > 0.005);
    this.updateComets(0.016);
  }

  private updateComets(dt: number) {
    if (this.beadParent.position.x !== 0 || this.beadParent.position.y !== 0 || this.beadParent.position.z !== 0) {
      this.beadParent.position.set(0, 0, 0);
      this.beadParent.rotation.set(0, 0, 0);
      this.beadParent.scaling.set(1, 1, 1);
    }
    this.beadParent.isPickable = false;

    this.waveTime += Math.min(0.05, Math.max(0.005, dt));

    for (const c of this.comets) {
      // Flow speed scales smoothly with slope steepness
      const cycleRate = 0.45 + Math.min(1.4, c.slopeMagnitude * 14.0);
      const t = (this.waveTime * cycleRate + c.phaseOffset) % 1.0;

      // Travel 1.2m along the downhill slope direction centered at (baseX, baseZ)
      const span = 1.15;
      const headDist = (t - 0.5) * span;
      const midDist = headDist - 0.16;
      const tailDist = headDist - 0.30;

      const placeDot = (mesh: AbstractMesh, dist: number, baseScale: number) => {
        const px = c.baseX + c.slopeDirX * dist;
        const pz = c.baseZ + c.slopeDirZ * dist;
        const py = this.terrain.getElevation(px, pz) + 0.038;
        mesh.position.set(px, py, pz);

        // Smooth fade envelope at start and end of stroke, modulated by active dotsAlpha fade
        const envelope = Math.sin(t * Math.PI);
        const s = Math.max(0.01, envelope * baseScale * this.dotsAlpha);
        mesh.scaling.set(s, s * 0.55, s);
      };

      placeDot(c.headMesh, headDist, 1.05);
      placeDot(c.midMesh, midDist, 0.72);
      placeDot(c.tailMesh, tailDist, 0.45);
    }
  }

  public dispose() {
    if (this.contourLineGrid) {
      this.contourLineGrid.dispose();
      this.contourLineGrid = null;
    }
    for (const c of this.comets) {
      c.headMesh.dispose();
      c.midMesh.dispose();
      c.tailMesh.dispose();
    }
    this.beadParent.dispose();
    this.matMild.dispose();
    this.matMed.dispose();
    this.matSteep.dispose();
  }
}
