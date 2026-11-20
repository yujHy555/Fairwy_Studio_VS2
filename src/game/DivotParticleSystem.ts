import {
  Scene,
  Vector3,
  Color4,
  ParticleSystem,
  DynamicTexture,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Mesh,
  Material,
  Observer
} from '@babylonjs/core';

export class DivotParticleSystem {
  private scene: Scene;
  private turfTexture: DynamicTexture;
  private soilTexture: DynamicTexture;
  private pitchMarkTexture: DynamicTexture;
  private activeDivotMark: Mesh | null = null;
  private activeFadeObserver: Observer<Scene> | null = null;

  constructor(scene: Scene) {
    this.scene = scene;

    // 1. Procedural Fine Turf Fleck Particle Texture (Tiny grass specks, NOT big leaves)
    this.turfTexture = new DynamicTexture('divotTurfTex', 64, this.scene, false);
    this.turfTexture.hasAlpha = true;
    const turfCtx = this.turfTexture.getContext() as CanvasRenderingContext2D;
    turfCtx.clearRect(0, 0, 64, 64);
    turfCtx.fillStyle = '#4ade80';
    turfCtx.beginPath();
    turfCtx.ellipse(32, 32, 14, 4, Math.PI / 4, 0, Math.PI * 2);
    turfCtx.fill();
    turfCtx.fillStyle = '#22c55e';
    turfCtx.beginPath();
    turfCtx.ellipse(31, 31, 10, 3, Math.PI / 4, 0, Math.PI * 2);
    turfCtx.fill();
    this.turfTexture.update(true);

    // 2. Procedural Soil / Earth Crumb Particle Texture (Tiny soil specks)
    this.soilTexture = new DynamicTexture('divotSoilTex', 64, this.scene, false);
    this.soilTexture.hasAlpha = true;
    const soilCtx = this.soilTexture.getContext() as CanvasRenderingContext2D;
    soilCtx.clearRect(0, 0, 64, 64);
    soilCtx.fillStyle = '#3e2723';
    soilCtx.beginPath();
    soilCtx.arc(32, 32, 8, 0, Math.PI * 2);
    soilCtx.fill();
    soilCtx.fillStyle = '#5d4037';
    soilCtx.beginPath();
    soilCtx.arc(30, 30, 5, 0, Math.PI * 2);
    soilCtx.fill();
    this.soilTexture.update(true);

    // 3. Authentic Championship Putting Green Pitch Mark Decal Texture
    // Matching photographic bentgrass ball crater (depressed earth center, bruised grass lip, feathered border)
    this.pitchMarkTexture = new DynamicTexture('pitchMarkTex', 128, this.scene, false);
    this.pitchMarkTexture.hasAlpha = true;
    const mCtx = this.pitchMarkTexture.getContext() as CanvasRenderingContext2D;
    mCtx.clearRect(0, 0, 128, 128);

    // Radial gradient: dark loam crater center -> compressed turf rim -> feathered green grass fade
    const grad = mCtx.createRadialGradient(64, 60, 6, 64, 64, 52);
    grad.addColorStop(0.0, 'rgba(38, 26, 16, 0.94)');   // Deep soil crater center
    grad.addColorStop(0.38, 'rgba(54, 38, 24, 0.86)');  // Earth loam bed
    grad.addColorStop(0.68, 'rgba(28, 62, 24, 0.65)');  // Bruised green sod rim
    grad.addColorStop(0.88, 'rgba(38, 92, 34, 0.22)');  // Outer green grass fringe
    grad.addColorStop(1.0, 'rgba(38, 92, 34, 0.0)');    // Fully transparent feathered perimeter
    mCtx.fillStyle = grad;
    mCtx.beginPath();
    mCtx.ellipse(64, 64, 46, 30, 0, 0, Math.PI * 2);
    mCtx.fill();

    // Subtle micro soil specks inside the crater for high photographic fidelity
    mCtx.fillStyle = 'rgba(20, 14, 8, 0.75)';
    for (let i = 0; i < 16; i++) {
      const sx = 64 + (Math.sin(i * 1.7) * 28);
      const sy = 62 + (Math.cos(i * 2.3) * 16);
      mCtx.fillRect(sx, sy, 2, 2);
    }
    this.pitchMarkTexture.update(true);
  }

  /**
   * Spawns fine turf and soil particles when the ball impacts the green with backspin.
   * Particles are very small (fine specks) and fall quickly to earth under gravity.
   * If !isSecondBounce, creates strictly 1 authentic pitch mark on the turf that quickly fades out.
   */
  public spawnDivotBurst(
    position: Vector3,
    approachVelocity: { x: number; y: number; z: number },
    intensity: number = 1.0,
    isSecondBounce: boolean = false
  ) {
    const burstScale = Math.max(0.6, Math.min(1.3, intensity));
    const emitPos = new Vector3(position.x, position.y + 0.02, position.z);

    // Direction vector of ball approach in XZ plane
    const speedH = Math.hypot(approachVelocity.x, approachVelocity.z) || 1.0;
    const dirX = approachVelocity.x / speedH;
    const dirZ = approachVelocity.z / speedH;

    // --- 1. Grass Blades & Turf Flecks (Very small specks: 7mm - 14mm) ---
    const turfPS = new ParticleSystem('turfDivotPS', Math.floor(25 * burstScale), this.scene);
    turfPS.particleTexture = this.turfTexture;
    turfPS.emitter = emitPos;

    turfPS.minSize = 0.007 * burstScale;
    turfPS.maxSize = 0.014 * burstScale;

    turfPS.minLifeTime = 0.28;
    turfPS.maxLifeTime = 0.48;

    turfPS.color1 = new Color4(0.35, 0.88, 0.42, 0.95);
    turfPS.color2 = new Color4(0.18, 0.72, 0.32, 0.90);
    turfPS.colorDead = new Color4(0.12, 0.45, 0.20, 0.0);

    const forwardBias = isSecondBounce ? -0.6 : 0.45;
    turfPS.direction1 = new Vector3(
      dirX * forwardBias - 0.4,
      1.4 * burstScale,
      dirZ * forwardBias - 0.4
    );
    turfPS.direction2 = new Vector3(
      dirX * forwardBias + 0.4,
      2.4 * burstScale,
      dirZ * forwardBias + 0.4
    );

    turfPS.minEmitPower = 0.8 * burstScale;
    turfPS.maxEmitPower = 1.8 * burstScale;
    turfPS.gravity = new Vector3(0, -9.81, 0);

    turfPS.minAngularSpeed = -Math.PI * 3;
    turfPS.maxAngularSpeed = Math.PI * 3;

    turfPS.manualEmitCount = Math.floor(22 * burstScale);
    turfPS.disposeOnStop = true;
    turfPS.start();

    // --- 2. Earth / Soil Crumb Burst (Tiny specks: 4mm - 9mm) ---
    const soilPS = new ParticleSystem('soilDivotPS', Math.floor(18 * burstScale), this.scene);
    soilPS.particleTexture = this.soilTexture;
    soilPS.emitter = emitPos;

    soilPS.minSize = 0.004 * burstScale;
    soilPS.maxSize = 0.009 * burstScale;

    soilPS.minLifeTime = 0.22;
    soilPS.maxLifeTime = 0.38;

    soilPS.color1 = new Color4(0.32, 0.20, 0.12, 0.95);
    soilPS.color2 = new Color4(0.22, 0.14, 0.08, 0.90);
    soilPS.colorDead = new Color4(0.18, 0.12, 0.06, 0.0);

    soilPS.direction1 = new Vector3(-0.35, 0.9 * burstScale, -0.35);
    soilPS.direction2 = new Vector3(0.35, 1.8 * burstScale, 0.35);

    soilPS.minEmitPower = 0.6 * burstScale;
    soilPS.maxEmitPower = 1.4 * burstScale;
    soilPS.gravity = new Vector3(0, -9.81, 0);

    soilPS.manualEmitCount = Math.floor(16 * burstScale);
    soilPS.disposeOnStop = true;
    soilPS.start();

    // --- 3. Single Ground Divot Mark (First Bounce on Green ONLY, strictly 1 mark that fades quickly) ---
    if (!isSecondBounce) {
      this.createGroundDivotMark(position, dirX, dirZ, burstScale);
    }
  }

  /**
   * Creates exactly 1 authentic pitch mark on the green turf that smoothly fades out in ~2.5s.
   * Completely eliminates black planes, floating artifacts, and multiple stacked marks.
   */
  private createGroundDivotMark(
    position: Vector3,
    dirX: number,
    dirZ: number,
    scale: number
  ) {
    // 1. Immediately clean up any previous active divot mark so strictly only 1 exists
    this.clearAllDivots();

    // 2. Realistic putting green pitch mark dimensions (~8cm x ~5.5cm)
    const markWidth = 0.08 * scale;
    const markHeight = 0.055 * scale;
    const mark = MeshBuilder.CreatePlane(
      'greenPitchMark',
      { width: markWidth, height: markHeight },
      this.scene
    );

    // Place 3mm above terrain surface so it hugs the green turf with zero floating and zero z-fighting
    mark.position.set(position.x, position.y + 0.003, position.z);
    mark.rotation.x = Math.PI / 2;
    mark.rotation.z = Math.atan2(dirX, dirZ);

    // Dedicated material with full alpha transparency support
    const mat = new StandardMaterial('pitchMarkMat_' + Date.now(), this.scene);
    mat.diffuseTexture = this.pitchMarkTexture;
    mat.opacityTexture = this.pitchMarkTexture;
    mat.useAlphaFromDiffuseTexture = true;
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND;
    mat.diffuseColor = new Color3(1, 1, 1);
    mat.specularColor = new Color3(0, 0, 0);
    mat.backFaceCulling = false;
    mat.alpha = 0.92;

    mark.material = mat;
    mark.isPickable = false;
    this.activeDivotMark = mark;

    // Smoothly fade out over 2.5 seconds, then dispose mesh & material completely
    let life = 2.5;
    const totalLife = 2.5;

    this.activeFadeObserver = this.scene.onBeforeRenderObservable.add(() => {
      const dt = this.scene.getEngine().getDeltaTime() / 1000.0;
      life -= dt;
      if (life <= 0) {
        if (this.activeFadeObserver) {
          this.scene.onBeforeRenderObservable.remove(this.activeFadeObserver);
          this.activeFadeObserver = null;
        }
        if (this.activeDivotMark === mark) {
          this.activeDivotMark = null;
        }
        mark.dispose();
        mat.dispose();
      } else {
        const ratio = Math.max(0, life / totalLife);
        mat.alpha = ratio * 0.92;
      }
    });
  }

  public clearAllDivots() {
    if (this.activeFadeObserver) {
      this.scene.onBeforeRenderObservable.remove(this.activeFadeObserver);
      this.activeFadeObserver = null;
    }
    if (this.activeDivotMark) {
      this.activeDivotMark.dispose(false, true);
      this.activeDivotMark = null;
    }
  }

  public destroy() {
    this.clearAllDivots();
    this.turfTexture.dispose();
    this.soilTexture.dispose();
    this.pitchMarkTexture.dispose();
  }
}
