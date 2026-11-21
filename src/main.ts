import { GamepadController } from './game/GamepadController';
import { HDRI_PRESETS, DEFAULT_HDRI_PRESET, presetToEnvironmentSettings } from './core/HdriPresets';
import { EnvironmentSettings, ViewportShadingMode } from './core/Types';
import { OutlinerItem } from './ui/UIController';
import {
  Engine,
  Scene,
  Camera,
  Vector3,
  Matrix,
  Color3,
  Color4,
  HemisphericLight,
  DirectionalLight,
  PointerEventTypes,
  Mesh,
  AbstractMesh,
  InstancedMesh,
  LinesMesh,
  Node,
  VertexData,
  StandardMaterial,
  PBRMaterial,
  ShadowGenerator,
  CascadedShadowGenerator,
  HDRCubeTexture,
  GizmoManager,
  HighlightLayer,
  MeshBuilder,
  Quaternion,
  Texture,
  DynamicTexture,
  BoundingInfo,
  Material,
  MaterialPluginBase,
  UniformBuffer,
  MaterialDefines,
  ImageProcessingConfiguration
} from '@babylonjs/core';
import '@babylonjs/core/Materials/Textures/Loaders/hdrTextureLoader.js';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';

import './style.css';
import { GOLF_CONSTANTS, SurfaceType, SURFACE_PROPERTIES } from './core/Constants';
import { PresetFeature, ClubSpec } from './core/Types';
import { HavokManager } from './physics/HavokManager';
import { TerrainGrid, StampedFeatureRecord, FeatureMaterialSettings, FeatureSubMaterialId } from './terrain/TerrainGrid';
import { RealisticTextures } from './terrain/RealisticTextures';
import { SceneryFactory } from './terrain/Scenery';
import { GreenContourVisualizer } from './terrain/GreenContourVisualizer';
import { Ball, BallState } from './game/Ball';
import { GOLF_CLUBS, getRecommendedClub } from './game/ClubBag';
import { SwingEngine } from './game/SwingEngine';
import { CameraController } from './game/CameraController';
import { CourseManager } from './game/CourseManager';
import { AimSystem } from './game/AimSystem';
import { UIController } from './ui/UIController';
import { DesignerBrushVisualizer } from './terrain/DesignerBrushVisualizer';
import { FeatureTracer } from './terrain/FeatureTracer';
import {
  LoadedMapNGSource,
  UnifiedMapNGCourse,
  extractUnifiedCourseGrid,
  extractUnifiedSatelliteDataUrl,
  detectGolfCourseFootprint
} from './terrain/MapNGImporter';
import { PolygonPoint } from './terrain/PolygonMath';
import { KyalamiHoleGuide } from './data/KyalamiCourseData';
import { soundFx } from './core/Audio';
import { getDeviceProfile } from './core/DeviceProfile';

interface DesignerHistoryStep {
  description: string;
  stampedFeatures: StampedFeatureRecord[];
  selectedFeatureIndex: number;
  baseHeights: Float32Array;
  pristineHeights?: Float32Array;
  sceneryMeshes: {
    name: string;
    pos: [number, number, number];
    rot: [number, number, number];
    scale: [number, number, number];
  }[];
  holeState: {
    pinPos: [number, number, number];
    teePos: [number, number, number];
    teeRotY: number;
  };
}

/**
 * Seam-free spherical dome projection plugin for Babylon's PBR skybox.
 * Scales sky width (azimuth) and height (elevation) uniformly across all 360° with
 * cyclic rear-seam blending, working identically across all HDRI presets.
 */
class HdriUvScalePlugin extends MaterialPluginBase {
  public scaleU = 1.0;
  public scaleV = 1.0;
  public offsetU = 0.0;
  public offsetV = 0.0;

  constructor(material: Material) {
    super(material, 'HdriUvScale', 120, { HDRI_UV_TRANSFORM: true });
    this._enable(true);
  }

  prepareDefines(defines: MaterialDefines) {
    defines['HDRI_UV_TRANSFORM'] = true;
  }

  getUniforms() {
    return {
      ubo: [{ name: 'uHdriUvParams', size: 4, type: 'vec4' }]
    };
  }

  bindForSubMesh(uniformBuffer: UniformBuffer) {
    uniformBuffer.updateFloat4('uHdriUvParams', this.scaleU, this.scaleV, this.offsetU, this.offsetV);
  }

  getCustomCode(shaderType: string) {
    if (shaderType === 'fragment') {
      return {
        '!reflectionCoords=reflectionVector;': `
          #if defined(HDRI_UV_TRANSFORM) && defined(REFLECTIONMAP_SKYBOX) && (!defined(LODBASEDMICROSFURACE) || defined(REALTIME_FILTERING))
            if (abs(uHdriUvParams.x - 1.0) > 0.0005 || abs(uHdriUvParams.y - 1.0) > 0.0005 || abs(uHdriUvParams.z) > 0.0005 || abs(uHdriUvParams.w) > 0.0005) {
              vec3 hDir = normalize(reflectionVector);
              float phi = atan(hDir.z, hDir.x);
              float elev = asin(clamp(hDir.y, -0.9999, 0.9999));
              float elevScaled = clamp(elev * max(0.05, uHdriUvParams.y) - uHdriUvParams.w * 0.78, -1.56, 1.56);
              float cosEl = cos(elevScaled);
              float phiA = phi * max(0.05, uHdriUvParams.x) + uHdriUvParams.z * 6.28318530718;
              reflectionCoords = vec3(cosEl * cos(phiA), sin(elevScaled), cosEl * sin(phiA));
            } else {
              reflectionCoords = reflectionVector;
            }
          #else
            reflectionCoords = reflectionVector;
          #endif
        `,
        '!environmentRadiance=sampleReflectionLod\\(reflectionSampler,reflectionCoords,reflectionLOD\\);': `
          #if defined(HDRI_UV_TRANSFORM) && defined(REFLECTIONMAP_SKYBOX)
            if (abs(uHdriUvParams.x - 1.0) > 0.0005 || abs(uHdriUvParams.y - 1.0) > 0.0005 || abs(uHdriUvParams.z) > 0.0005 || abs(uHdriUvParams.w) > 0.0005) {
              vec3 hDir = normalize(reflectionCoords);
              float phi = atan(hDir.z, hDir.x);
              float elev = asin(clamp(hDir.y, -0.9999, 0.9999));
              float sU = max(0.05, uHdriUvParams.x);
              float sV = max(0.05, uHdriUvParams.y);
              float elevScaled = clamp(elev * sV - uHdriUvParams.w * 0.78, -1.56, 1.56);
              float cosEl = cos(elevScaled);
              float sinEl = sin(elevScaled);
              float phiA = phi * sU + uHdriUvParams.z * 6.28318530718;
              vec3 dirA = vec3(cosEl * cos(phiA), sinEl, cosEl * sin(phiA));
              environmentRadiance = sampleReflectionLod(reflectionSampler, dirA, reflectionLOD);
            } else {
              environmentRadiance = sampleReflectionLod(reflectionSampler, reflectionCoords, reflectionLOD);
            }
          #else
            environmentRadiance = sampleReflectionLod(reflectionSampler, reflectionCoords, reflectionLOD);
          #endif
        `
      };
    }
    return null;
  }
}

class FairwayStudioApp {
  private canvas: HTMLCanvasElement;
  private engine: Engine;
  private scene: Scene;

  private havok: HavokManager;
  private terrain!: TerrainGrid;
  private scenery!: SceneryFactory;
  private courseManager!: CourseManager;
  private greenVisualizer!: GreenContourVisualizer;
  private ball!: Ball;
  private swingEngine!: SwingEngine;
  private aimSystem!: AimSystem;
  private brushVisualizer!: DesignerBrushVisualizer;
  private featureTracer!: FeatureTracer;
  private macroSurroundMesh: Mesh | null = null;
  private lastMapNGSource: LoadedMapNGSource | null = null;
  private lastMapNGCropOpts: {
    cropCenterX: number;
    cropCenterZ: number;
    rotationDeg: number;
    elevationScale: number;
    isolateCourseOnly: boolean;
  } | null = null;
  private lastMapNGCourseCenter = { x: 110, z: 230 };
  private lastMapNGCourseSpan = 460;
  private lastUnifiedCourseMeta: UnifiedMapNGCourse['meta'] | null = null;
  private lastSatelliteFileName = '';
  private groundSelectionOutline: LinesMesh | null = null;
  private objectSelectionOutline: LinesMesh | null = null;
  private playFreezeTimerId: number | null = null;
  private wasCameraDetachedForTrace = false;
  private lastSavedSatelliteOpacity = 0.72;
  private cameraCtrl!: CameraController;
  private ui!: UIController;
  private sunLight!: DirectionalLight;
  private shadowGenerator: ShadowGenerator | CascadedShadowGenerator | null = null;
  private currentEnvSettings: EnvironmentSettings = presetToEnvironmentSettings(DEFAULT_HDRI_PRESET);
  private currentHdrTexture: HDRCubeTexture | null = null;
  private hdriTextureCache = new Map<string, HDRCubeTexture>();
  private hdriSkyboxTextureCache = new Map<string, HDRCubeTexture>();
  private activeRequestedHdriUrl: string | null = null;
  private skyboxMesh: Mesh | null = null;
  private hdriUvPlugin: HdriUvScalePlugin | null = null;
  private hdriPreloadStarted = false;
  private gamepadCtrl!: GamepadController;
  private currentShadingMode: ViewportShadingMode = 'rendered';
  private lastPerfHudUpdate: number = 0;

  // Designer State
  private activeMode: 'designer' | 'play' = 'play';
  private activeDesignerTool: 'select' | 'sculpt' | 'stamp' | 'set_tee' | 'set_pin' | 'erase' = 'select';
  private activeSculptMode: 'raise' | 'lower' | 'flatten' | 'smooth' = 'raise';
  private brushRadius = 12;
  private brushStrength = 0.5;
  private targetSurface: SurfaceType = SurfaceType.FAIRWAY;
  private activePreset: PresetFeature | null = null;
  private isPointerDownInDesigner = false;
  private pointerDownX = 0;
  private pointerDownY = 0;

  // Gizmo & Developer Zone
  private gizmoManager!: GizmoManager;
  private selectedMesh: (Mesh | InstancedMesh) | null = null;
  private activeGizmoMode: 'none' | 'position' | 'rotation' | 'scale' = 'none';
  private selectionHighlightLayer!: HighlightLayer;
  private selectedFeatureIndex: number = -1;
  private selectedFeatureSubMatId: FeatureSubMaterialId = 'surface';
  private selectedObjectSubMatIdx: number = 0;
  private featureGizmoProxy: Mesh | null = null;
  private featureDrapeMesh: Mesh | null = null;
  private featureDrapePointCount: number = 0;
  private featureDrapeMaterial: StandardMaterial | null = null;
  private featureSurfaceFillMesh: Mesh | null = null;
  private featureSurfaceFillMaterial: StandardMaterial | null = null;
  private physicsSyncTimeout: number | null = null;
  private isGizmoDragging = false;
  private hookedGizmoBehaviors = new WeakSet<any>();
  private gizmoRaf: number | null = null;

  // History & Undo/Redo System
  private historyUndoStack: DesignerHistoryStep[] = [];
  private historyRedoStack: DesignerHistoryStep[] = [];
  private isHistoryNavigating = false;
  private pendingHistorySnapshot: DesignerHistoryStep | null = null;
  public isInitialized = false;

  // 1m Grid mesh conforming to terrain surface
  private gridMesh: Mesh | null = null;
  private show1mGrid = false;
  private wasSettledOnGreen = false;
  private autoEnabledGreenOverlays = false;

  // Play state
  private activeClub: ClubSpec = GOLF_CLUBS[0];
  private currentAimAzimuth = 0; // degrees

  constructor() {
    this.canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
    const profile = getDeviceProfile();
    this.engine = new Engine(this.canvas, profile.antialias, {
      preserveDrawingBuffer: true,
      stencil: true,
      powerPreference: 'high-performance'
    });
    const dpr = window.devicePixelRatio || 1;
    this.engine.setHardwareScalingLevel(1 / Math.min(profile.maxDpr, dpr));
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.45, 0.70, 0.88, 1.0);
    // Skip redundant CPU picking on mouse move across 40k+ triangles
    this.scene.skipPointerMovePicking = true;

    this.havok = new HavokManager(this.scene);
  }

  public async start() {
    this.updatePreloader(15, 'Initializing Camera, Lighting & Physics...');

    // 1. Setup Camera first so CascadedShadowGenerator can bind to activeCamera
    this.cameraCtrl = new CameraController(this.scene, this.canvas);
    this.scene.activeCamera = this.cameraCtrl.camera;

    // 1b. Create SunLight & CascadedShadowGenerator synchronously BEFORE any mesh/tree shaders compile
    this.setupSunAndShadowsSync();

    // 2. Construct terrain & scenery managers early so GPU textures start loading in parallel
    this.terrain = new TerrainGrid(this.scene);
    this.terrain.buildMesh(true); // Defer empty initial rebuild until course JSON arrives
    if (this.terrain.terrainMesh) {
      this.terrain.terrainMesh.receiveShadows = true;
    }
    this.scenery = new SceneryFactory(this.scene);

    // 3. Parallelized Boot: HDRI Sky Dome + Havok WASM + PBR Rough Swatch + 3D Models + /default_hole.json
    const defaultHolePromise = (typeof fetch !== 'undefined')
      ? fetch(`/default_hole.json?t=${Date.now()}`)
          .then(r => (r.ok ? r.text() : null))
          .catch(() => null)
      : Promise.resolve(null);

    const [preloadedHoleJson] = await Promise.all([
      defaultHolePromise,
      this.setupHdriSkybox(),
      this.havok.initialize(),
      this.terrain.initHighResPhotoPatterns(),
      this.scenery.loadTreeModels(true) // Defer 26MB Cliff_01.glb until needed
    ]);

    this.updatePreloader(70, 'Hydrating Course Architecture & Colliders...');

    // 4. Initialize CourseManager in single-pass mode (skips redundant procedural rebuilds when saved JSON exists)
    this.courseManager = new CourseManager(this.terrain, this.scenery, true);
    this.courseManager.onEnvironmentSettingsLoaded = (env) => {
      const urlChanged = !!(env.hdriUrl && env.hdriUrl !== this.currentEnvSettings.hdriUrl);
      this.setHdriEnvironment(env, urlChanged || Boolean(this.currentHdrTexture?.isReady()));
      this.refreshShadowsAndMaterials(true);
    };
    await this.courseManager.initWithPreloadedCourse(preloadedHoleJson);

    this.scenery.syncColliders();
    if (this.terrain.terrainMesh) {
      this.havok.updateTerrainCollision(this.terrain.terrainMesh);
    }

    this.updatePreloader(85, 'Placing Flags, Aim Chevrons & Green Contours...');

    // 6. Green Contours
    this.greenVisualizer = new GreenContourVisualizer(this.scene, this.terrain);

    // 7. Dimpled Regulation Golf Ball & Swing Engine
    this.ball = new Ball(this.scene, this.terrain);
    this.ball.setTreeColliders(this.scenery.treeColliders);
    this.swingEngine = new SwingEngine(this.activeClub);

    // 8. Clean 3D Aim Chevron Indicator with real-time ground shadow
    this.aimSystem = new AimSystem(this.scene, this.terrain, this.shadowGenerator);

    // 9. Interactive 3D Circular Brush Visualizer & Satellite Feature Tracer for Course Designer
    this.brushVisualizer = new DesignerBrushVisualizer(this.scene, this.terrain);
    this.featureTracer = new FeatureTracer(this.scene, this.terrain, {
      onCommitTracedFeature: (surfaceType: SurfaceType, contour: PolygonPoint[]) => {
        this.runWithTerraformingLoader(() => {
          const snap = this.captureHistorySnapshot(`Trace ${surfaceType}`);
          const newIdx = this.terrain.addTracedFeature(surfaceType, contour);
          const createdFeat = this.terrain.stampedFeatures[newIdx];
          if (surfaceType === SurfaceType.WATER) {
            this.courseManager.refreshWaterMeshes();
          } else if (surfaceType === SurfaceType.TEE && createdFeat) {
            this.courseManager.ensureTeeMarkersForFeature(createdFeat);
            if (this.courseManager.currentStrokes === 0) {
              this.placeBallAtActiveTee();
            }
          } else if (surfaceType === SurfaceType.GREEN && createdFeat) {
            this.courseManager.ensurePinForGreenFeature(createdFeat);
            this.ball?.setTargetPin(this.courseManager.currentHole.pinPosition);
          } else {
            this.courseManager.refreshWaterMeshes();
          }
          this.courseManager.refreshSceneryForFeatures();
          if (this.terrain.terrainMesh) {
            this.havok.updateTerrainCollision(this.terrain.terrainMesh);
          }
          this.greenVisualizer?.rebuildSlopeGrid();
          this.selectCourseFeature(newIdx);
          this.ui?.updateFeatureList(this.terrain.stampedFeatures, newIdx);
          this.refreshOutliner();
          this.registerSceneryShadows();
          this.updateHUDDisplay();
          this.updateDevStats();
          this.recordHistoryStep(snap.description, snap);
          const label = (SURFACE_PROPERTIES[surfaceType]?.name || String(surfaceType)).toUpperCase();
          this.ui?.showToast(`✨ Created traced ${label} contour!`, 'success', 2400);
        }, 'Creating Traced Feature & Analytical Collars...');
      },
      onContourEdited: (featureIndex: number, newContour: PolygonPoint[], isFinal: boolean) => {
        if (!isFinal) {
          this.terrain.updateTracedFeatureContour(featureIndex, newContour, true);
          this.updateFeatureDrapeMesh(featureIndex);
          return;
        }
        this.runWithTerraformingLoader(() => {
          const snap = this.captureHistorySnapshot('Edit Traced Contour');
          this.terrain.updateTracedFeatureContour(featureIndex, newContour, false);
          this.courseManager.refreshWaterMeshes();
          if (this.terrain.terrainMesh) {
            this.havok.updateTerrainCollision(this.terrain.terrainMesh);
          }
          this.selectCourseFeature(featureIndex);
          this.recordHistoryStep(snap.description, snap);
        }, 'Updating Traced Contour...');
      },
      onTraceStateChange: ({ mode, targetSurface, pointCount }) => {
        this.ui?.updateTraceUi(mode, targetSurface, pointCount);
        this.terrain.setSatelliteOverlayOverFeatures(mode !== 'off' ? 0.30 : 0.0);
        if (mode === 'off' && this.wasCameraDetachedForTrace) {
          this.cameraCtrl.camera.attachControl(this.canvas, false, false);
          this.wasCameraDetachedForTrace = false;
        }
      }
    });

    // Safety net: ensure trace node drag can never leave camera detached if pointerup happens off-canvas
    window.addEventListener('pointerup', () => {
      if (this.wasCameraDetachedForTrace) {
        this.cameraCtrl.camera.attachControl(this.canvas, false, false);
        this.wasCameraDetachedForTrace = false;
      }
    });

    // 10. Setup UI & Event Handlers
    this.setupUI();
    this.initGamepad();
    this.ui.showMainMenu();

    // 10b. Setup Transform Gizmos and Thin Faint Blue Selection Halo (keeps textures & colors visible while editing)
    this.selectionHighlightLayer = new HighlightLayer('selectionHighlight', this.scene, {
      isStroke: true,
      blurHorizontalSize: 0.45,
      blurVerticalSize: 0.45
    });
    this.selectionHighlightLayer.innerGlow = false;
    this.selectionHighlightLayer.outerGlow = true;
    this.setupGizmoManager();

    // Register all course scenery & golf ball to cast real lighting shadows immediately on boot
    this.registerSceneryShadows();
    this.refreshShadowsAndMaterials(true);

    // Place ball flush on Hole 1 Tee
    this.placeBallAtActiveTee();

    // 11. Input & Pointer Interactions
    this.setupPointerInteractions();

    // Enforce zero-lag terrain collision right after camera.update() and BEFORE customRenderTargets/CSM
    // so shadow cascade frustum matrices and main camera view are locked to the exact same frame state
    this.scene.onBeforeRenderObservable.add(() => {
      const dt = this.engine.getDeltaTime() / 1000;
      this.cameraCtrl.enforceTerrainCollision((x, z) => this.getWorldElevation(x, z), dt);
    });

    // Update billboarded Toptracer ribbon to face the exact finalized camera position of this frame
    this.scene.onBeforeCameraRenderObservable.add(() => {
      this.ball.updateTracerForCamera(this.cameraCtrl.camera.position);
    });

    this.updatePreloader(95, 'Compiling Shaders & Level Geometry...');
    await this.scene.whenReadyAsync();

    this.updatePreloader(100, 'Teeing Off...');

    // 12. Start Render Loop (pauses idle 3D render when Main Menu covers screen after shader warmup)
    let framesRendered = 0;
    let wasMenuPaused = false;
    this.engine.runRenderLoop(() => {
      if (framesRendered >= 4 && this.ui?.isMainMenuOpen()) {
        wasMenuPaused = true;
        return;
      }
      const rawDt = this.engine.getDeltaTime() / 1000;
      const dt = wasMenuPaused ? 0.016 : Math.min(0.05, rawDt);
      wasMenuPaused = false;
      this.update(dt);
      this.scene.render();
      framesRendered++;
      if (framesRendered === 3) {
        this.dismissPreloader();
      }

      if (this.activeMode === 'play') {
        const now = performance.now();
        if (now - this.lastPerfHudUpdate >= 120) {
          this.lastPerfHudUpdate = now;
          const fps = this.engine.getFps();
          const frameTime = dt * 1000;
          const activeMeshes = this.scene.getActiveMeshes().length;
          this.ui.updatePerformanceHud(fps, frameTime, activeMeshes);
        }
      }
    });

    window.addEventListener('resize', () => {
      const dpr = window.devicePixelRatio || 1;
      const profile = getDeviceProfile();
      this.engine.setHardwareScalingLevel(1 / Math.min(profile.maxDpr, dpr));
      this.engine.resize();
    });
    this.isInitialized = true;
  }

  private updatePreloader(percent: number, status: string) {
    const bar = document.getElementById('preloader-bar');
    const percentEl = document.getElementById('preloader-percent');
    const statusEl = document.getElementById('preloader-status');
    if (bar) bar.style.width = `${percent}%`;
    if (percentEl) percentEl.textContent = `${Math.round(percent)}%`;
    if (statusEl) statusEl.textContent = status;
  }

  private dismissPreloader() {
    const preloader = document.getElementById('game-preloader');
    if (preloader) {
      preloader.classList.add('fade-out');
    }
  }

  private ensureHdriPreloading() {
    // Load HDRIs on-demand when selected instead of decoding/prefiltering 512px cubemaps
    // on a background timer, which stalled the main thread and froze camera rotation.
    this.hdriPreloadStarted = true;
  }

  private schedulePlayWorldFreeze() {
    if (this.playFreezeTimerId !== null) {
      cancelAnimationFrame(this.playFreezeTimerId);
      this.playFreezeTimerId = null;
    }
    this.playFreezeTimerId = requestAnimationFrame(() => {
      this.playFreezeTimerId = requestAnimationFrame(() => {
        this.playFreezeTimerId = null;
        if (this.activeMode === 'play' && !this.ui?.isMainMenuOpen()) {
          this.refreshShadowsAndMaterials(false);
          this.freezeStaticWorldMatrices(true);
        }
      });
    });
  }

  private refreshShadowsAndMaterials(forceAllDirty = true) {
    const prevBlock = this.scene.blockMaterialDirtyMechanism;
    this.scene.blockMaterialDirtyMechanism = false;
    const shadowsShouldBeOn = this.activeMode === 'play' || this.currentShadingMode === 'rendered';
    this.scene.shadowsEnabled = shadowsShouldBeOn;

    if (this.terrain?.terrainMesh && !this.terrain.terrainMesh.isDisposed()) {
      this.terrain.terrainMesh.receiveShadows = true;
    }
    this.registerSceneryShadows();
    if (this.shadowGenerator) {
      const clampedDarkness = Math.max(0.12, Math.min(0.45, this.currentEnvSettings.shadowDarkness ?? 0.22));
      this.shadowGenerator.darkness = clampedDarkness;
      if (this.shadowGenerator instanceof CascadedShadowGenerator) {
        this.shadowGenerator.penumbraDarkness = 0.85;
        if (this.cameraCtrl?.camera) {
          this.cameraCtrl.camera.getViewMatrix(true);
          this.cameraCtrl.camera.getProjectionMatrix(true);
        }
        this.shadowGenerator.splitFrustum();
      }
    }
    if (forceAllDirty) {
      this.scene.resetCachedMaterial();
      const tMesh = this.terrain?.terrainMesh;
      if (tMesh && !tMesh.isDisposed()) {
        for (const sub of tMesh.subMeshes) {
          sub.resetDrawCache();
        }
      }
    }
    this.scene.markAllMaterialsAsDirty(
      forceAllDirty
        ? Material.AllDirtyFlag
        : (Material.LightDirtyFlag | Material.TextureDirtyFlag | Material.MiscDirtyFlag)
    );
    this.scene.blockMaterialDirtyMechanism = prevBlock;

    if (shadowsShouldBeOn) {
      requestAnimationFrame(() => {
        if (this.shadowGenerator instanceof CascadedShadowGenerator) {
          if (this.cameraCtrl?.camera) {
            this.cameraCtrl.camera.getViewMatrix(true);
            this.cameraCtrl.camera.getProjectionMatrix(true);
          }
          this.shadowGenerator.splitFrustum();
        }
        const tMesh = this.terrain?.terrainMesh;
        if (tMesh && !tMesh.isDisposed() && tMesh.material) {
          tMesh.material.markAsDirty(Material.LightDirtyFlag);
        }
      });
    }
  }

  private freezeStaticWorldMatrices(freeze: boolean = true) {
    if (freeze) {
      const toFreeze: AbstractMesh[] = [];
      for (const m of this.scene.meshes) {
        const lower = (m.name || '').toLowerCase();
        if (
          lower.includes('ball') ||
          lower.includes('aim') ||
          lower.includes('toptracer') ||
          lower.includes('tracer') ||
          lower.includes('brush') ||
          lower.includes('gizmo') ||
          lower.includes('comet') ||
          lower.includes('grid') ||
          lower.includes('proxy') ||
          lower.includes('overlay') ||
          lower.includes('contour') ||
          lower.includes('water') ||
          lower.includes('skybox') ||
          lower.startsWith('flag_') ||
          lower.startsWith('master_')
        ) {
          continue;
        }
        toFreeze.push(m);
      }

      // Compute world matrices parent-first before freezing so child instances inherit exact transforms
      for (const m of toFreeze) {
        if (!m.parent && !m.isDisposed()) {
          try {
            m.unfreezeWorldMatrix();
            m.computeWorldMatrix(true);
            m.refreshBoundingInfo({});
          } catch {}
        }
      }
      for (const m of toFreeze) {
        if (m.parent && !m.isDisposed()) {
          try {
            m.unfreezeWorldMatrix();
            m.computeWorldMatrix(true);
            m.refreshBoundingInfo({});
          } catch {}
        }
      }
      for (const m of toFreeze) {
        if (!m.isDisposed()) {
          try {
            m.freezeWorldMatrix();
            m.doNotSyncBoundingInfo = true;
          } catch {}
        }
      }
      this.scene.blockMaterialDirtyMechanism = true;
    } else {
      this.scene.blockMaterialDirtyMechanism = false;
      for (const m of this.scene.meshes) {
        try {
          m.unfreezeWorldMatrix();
          m.doNotSyncBoundingInfo = false;
        } catch {}
      }
    }
  }

  private setupSunAndShadowsSync(): void {
    const savedEnv = this.courseManager?.getEnvironmentSettings();
    if (savedEnv) {
      this.currentEnvSettings = { syncSunWithHdri: true, ...savedEnv };
    } else {
      this.currentEnvSettings = presetToEnvironmentSettings(DEFAULT_HDRI_PRESET);
    }

    // 1. Natural Ambient Sky & Turf Bounce Light
    if (!this.scene.getLightByName('hemiLight')) {
      const hemiLight = new HemisphericLight('hemiLight', new Vector3(0, 1, 0), this.scene);
      hemiLight.intensity = 0.44;
      hemiLight.diffuse = new Color3(0.92, 0.96, 1.0);
      hemiLight.groundColor = new Color3(0.36, 0.42, 0.32);
    }

    // 2. Directional Sun Light calculated from Sun Azimuth & Elevation BEFORE mesh shaders compile
    if (!this.sunLight) {
      const courseCenter = new Vector3(110, 4, 210);
      const radAz = (this.currentEnvSettings.sunAzimuth * Math.PI) / 180;
      const radEl = (this.currentEnvSettings.sunElevation * Math.PI) / 180;
      const dirX = Math.sin(radAz) * Math.cos(radEl);
      const dirY = -Math.sin(radEl);
      const dirZ = Math.cos(radAz) * Math.cos(radEl);
      const lightDir = new Vector3(dirX, dirY, dirZ).normalize();

      const sun = new DirectionalLight('sunLight', lightDir, this.scene);
      sun.position = courseCenter.subtract(lightDir.scale(550));
      sun.intensity = this.currentEnvSettings.sunIntensity;
      sun.diffuse = Color3.FromHexString(this.currentEnvSettings.sunColor);
      sun.specular = new Color3(0.40, 0.38, 0.35);
      this.sunLight = sun;
    }

    // 3. Real Lighting-Generated AAA Soft-Edged Cascaded Shadows bound from frame 0
    if (!this.shadowGenerator && this.sunLight) {
      try {
        const profile = getDeviceProfile();
        if (CascadedShadowGenerator.IsSupported) {
          const csm = new CascadedShadowGenerator(profile.shadowMapSize, this.sunLight);
          csm.numCascades = profile.shadowCascades;
          csm.lambda = 0.58;
          csm.shadowMaxZ = 480;
          csm.stabilizeCascades = true;
          csm.depthClamp = true;
          csm.autoCalcDepthBounds = false;
          csm.cascadeBlendPercentage = 0.22;
          csm.frustumEdgeFalloff = 0.10;
          csm.usePercentageCloserFiltering = true;
          csm.filteringQuality =
            profile.shadowFilterQuality === 'medium'
              ? CascadedShadowGenerator.QUALITY_MEDIUM
              : CascadedShadowGenerator.QUALITY_LOW;
          csm.penumbraDarkness = 0.85;
          csm.darkness = Math.max(0.12, Math.min(0.45, this.currentEnvSettings.shadowDarkness ?? 0.22));
          csm.bias = 0.00045;
          csm.normalBias = 0.006;
          csm.transparencyShadow = true;
          csm.splitFrustum();
          this.shadowGenerator = csm;
        } else {
          this.sunLight.autoCalcShadowZBounds = false;
          this.sunLight.autoUpdateExtends = false;
          this.sunLight.orthoLeft = -180;
          this.sunLight.orthoRight = 180;
          this.sunLight.orthoTop = 240;
          this.sunLight.orthoBottom = -240;
          this.sunLight.shadowMinZ = 10;
          this.sunLight.shadowMaxZ = 650;

          const sg = new ShadowGenerator(Math.min(2048, profile.shadowMapSize), this.sunLight);
          sg.usePercentageCloserFiltering = true;
          sg.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
          sg.bias = 0.00008;
          sg.normalBias = 0.0001;
          sg.darkness = this.currentEnvSettings.shadowDarkness;
          sg.transparencyShadow = true;
          this.shadowGenerator = sg;
        }
      } catch (e) {
        console.warn('ShadowGenerator initialization fallback:', e);
      }
    }
  }

  private async setupHdriSkybox(): Promise<void> {
    const bootUrl = this.currentEnvSettings.hdriUrl;
    this.activeRequestedHdriUrl = bootUrl;
    await new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      const timer = setTimeout(finish, 4000);

      try {
        const hdrTexture = new HDRCubeTexture(
          bootUrl,
          this.scene,
          512,
          false,
          true,
          false,
          true,
          () => {
            const prevBlock = this.scene.blockMaterialDirtyMechanism;
            if (prevBlock) this.scene.blockMaterialDirtyMechanism = false;
            hdrTexture.coordinatesMode = Texture.CUBIC_MODE;
            this.currentHdrTexture = hdrTexture;
            this.scene.environmentTexture = hdrTexture;
            this.scene.environmentIntensity = this.currentEnvSettings.hdriIntensity;
            const skyTex = this.getOrCreateSkyboxTexture(bootUrl, hdrTexture);
            if (this.skyboxMesh && this.skyboxMesh.material) {
              const skyMat = this.skyboxMesh.material as PBRMaterial;
              skyMat.reflectionTexture = skyTex;
              skyMat.microSurface = 1.0 - 0.03;
              skyMat.disableLighting = true;
              skyMat.twoSidedLighting = true;
              skyMat.backFaceCulling = false;
              skyMat.markAsDirty(Material.TextureDirtyFlag | Material.MiscDirtyFlag);
              if (this.shadowGenerator) {
                this.shadowGenerator.removeShadowCaster(this.skyboxMesh, true);
              }
            }
            this.applyHdriTransform();
            this.scene.markAllMaterialsAsDirty(Material.TextureDirtyFlag | Material.LightDirtyFlag);
            if (prevBlock) this.scene.blockMaterialDirtyMechanism = true;
            clearTimeout(timer);
            finish();
          },
          (msg, err) => {
            console.warn('2K HDRI load issue, continuing:', msg, err);
            clearTimeout(timer);
            finish();
          }
        );
        this.currentHdrTexture = hdrTexture;
        this.scene.environmentTexture = hdrTexture;
        this.hdriTextureCache.set(bootUrl, hdrTexture);
        this.scene.environmentIntensity = this.currentEnvSettings.hdriIntensity;
        this.scene.imageProcessingConfiguration.toneMappingEnabled = true;
        this.scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
        this.scene.imageProcessingConfiguration.contrast = 1.18;
        this.scene.imageProcessingConfiguration.exposure = 1.0;

        const skybox = this.scene.createDefaultSkybox(hdrTexture, true, 12000, 0.03);
        if (skybox) {
          skybox.name = 'FairwaySkybox';
          skybox.isPickable = false;
          skybox.position.set(110, 0, 230);
          skybox.infiniteDistance = true;
          skybox.receiveShadows = false;
          this.skyboxMesh = skybox;
          const skyReflTex = (skybox.material as PBRMaterial | null)?.reflectionTexture as HDRCubeTexture | null;
          if (skyReflTex) {
            skyReflTex.coordinatesMode = Texture.SKYBOX_MODE;
            skyReflTex.level = 1.0;
            this.hdriSkyboxTextureCache.set(bootUrl, skyReflTex);
          }
          this.attachHdriUvPlugin(skybox);
          if (this.currentShadingMode === 'wireframe' || this.currentShadingMode === 'solid') {
            this.skyboxMesh.setEnabled(false);
          }
          this.applyHdriTransform();
        }
      } catch (e) {
        console.warn('HDRI environment fallback:', e);
        clearTimeout(timer);
        finish();
      }
    });
  }

  private registerSceneryShadows() {
    if (!this.shadowGenerator) return;

    const shadowMap = this.shadowGenerator.getShadowMap();
    const renderList = shadowMap?.renderList;
    if (renderList) {
      for (let i = renderList.length - 1; i >= 0; i--) {
        const entry = renderList[i];
        const entryLower = (entry?.name || '').toLowerCase();
        if (
          !entry ||
          entry.isDisposed() ||
          entryLower.startsWith('master_') ||
          entryLower.startsWith('hero_tree_branches_') ||
          entryLower.startsWith('bush_branches_') ||
          entryLower.startsWith('water_') ||
          entryLower.includes('skybox')
        ) {
          renderList.splice(i, 1);
        }
      }
    }

    const existing = new Set<AbstractMesh>(renderList || []);

    // Register every active scenery InstancedMesh and regular Mesh so Babylon's ShadowGenerator
    // renders all GPU instances per master in 1 hardware-instanced draw call per cascade.
    // (Skip hidden master_* templates and redundant interior twig meshes whose trunk+leaves already cast silhouette shadows.)
    for (const m of this.scene.meshes) {
      if (!m || m.isDisposed() || existing.has(m)) {
        continue;
      }
      const lower = (m.name || '').toLowerCase();
      if (
        lower.startsWith('master_') ||
        lower.startsWith('hero_tree_branches_') ||
        lower.startsWith('bush_branches_') ||
        lower === 'golfterrain' ||
        lower.includes('mapngmacrosurround') ||
        lower.includes('skybox') ||
        lower.includes('drape') ||
        lower.includes('proxy') ||
        lower.includes('overlay') ||
        lower.includes('grid') ||
        lower.includes('contour') ||
        lower.includes('brush') ||
        lower.includes('bead') ||
        lower.includes('aim') ||
        lower.includes('toptracer') ||
        lower.includes('tracer') ||
        lower.includes('comet') ||
        lower.includes('gizmo') ||
        lower.includes('outline') ||
        lower.startsWith('water_') ||
        lower.startsWith('cup_')
      ) {
        continue;
      }

      if (m instanceof InstancedMesh) {
        if (!m.sourceMesh || m.sourceMesh.isDisposed()) {
          continue;
        }
      } else if (m.getTotalVertices() === 0) {
        continue;
      }

      try {
        this.shadowGenerator.addShadowCaster(m, false);
        existing.add(m);
      } catch {
        // ignore if unsupported
      }
    }

    if (this.ball?.mesh && !this.ball.mesh.isDisposed() && !existing.has(this.ball.mesh)) {
      try {
        this.shadowGenerator.addShadowCaster(this.ball.mesh, true);
      } catch {}
    }

    if (this.shadowGenerator instanceof CascadedShadowGenerator) {
      // Lock a static caster envelope covering active course & high ball flight arc:
      // Prevents per-frame shadow depth-range resizing/shimmer while maximizing depth precision
      const maxW = Math.max(260, (this.terrain?.width || 220) + 40);
      const maxL = Math.max(500, (this.terrain?.length || 460) + 40);
      this.shadowGenerator.freezeShadowCastersBoundingInfo = true;
      this.shadowGenerator.shadowCastersBoundingInfo = new BoundingInfo(
        new Vector3(-40, -25, -40),
        new Vector3(maxW, 140, maxL)
      );
      this.shadowGenerator.splitFrustum();
    }
  }

  public getWorldElevation(x: number, z: number): number {
    return this.terrain.getElevation(x, z);
  }

  private placeBallAtActiveTee() {
    // Dynamic wind factor randomized on each hole start or reset
    this.swingEngine.randomizeWind();

    if (this.courseManager) {
      this.courseManager.snapTeeToTeeBox();
    }

    const hole = this.courseManager.currentHole;
    const tee = hole.teePosition;
    const groundY = this.terrain.getElevation(tee.x, tee.z);
    // Seat ball directly on the exact terrain surface at BALL_RENDER_RADIUS (zero floating!)
    this.ball.setPosition(tee.x, groundY + GOLF_CONSTANTS.BALL_RENDER_RADIUS, tee.z);

    const pin = hole.pinPosition;
    this.ball.setTargetPin(pin);

    // On dogleg holes, aim initial tee shot down the fairway toward the first dogleg landing waypoint
    const initialTarget = (hole.waypoints && hole.waypoints.length > 0) ? hole.waypoints[0] : pin;
    const aimDx = initialTarget.x - tee.x;
    const aimDz = initialTarget.z - tee.z;
    this.currentAimAzimuth = (Math.atan2(aimDx, aimDz) * 180) / Math.PI;
    this.swingEngine.aimAzimuthDeg = this.currentAimAzimuth;

    if (this.activeMode === 'play') {
      this.cameraCtrl.setMode('aim');
      this.cameraCtrl.snapAimBehindBall(this.ball.position, this.currentAimAzimuth);
    }

    const dx = pin.x - tee.x;
    const dz = pin.z - tee.z;
    const distToPin = Math.sqrt(dx * dx + dz * dz);
    this.activeClub = getRecommendedClub(distToPin, false);
    this.swingEngine.setClub(this.activeClub);

    if (this.aimSystem) {
      this.aimSystem.targetDistanceMeters = Math.min(distToPin, this.activeClub.typicalCarryMeters);
      this.aimSystem.aimHeadingDeg = this.currentAimAzimuth;
      this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
      this.aimSystem.setVisible(this.activeMode === 'play');
    }
    if (this.ui) {
      this.ui.setSwingEnabled(true);
    }

    if (this.greenVisualizer) {
      this.greenVisualizer.setVisible(false);
      this.ui?.setGreenToggleStates(false, false);
    }
    this.wasSettledOnGreen = false;
    this.autoEnabledGreenOverlays = false;

    this.registerSceneryShadows();
    this.updateHUDDisplay();
    this.updateDevStats();
  }

  private setupUI() {
    this.ui = new UIController({
      onMainMenuPlay: () => {
        this.ui.hideMainMenu();
        this.ensureHdriPreloading();
        this.freezeStaticWorldMatrices(false);
        this.updateGroundSelectionOutline(false);
        this.updateObjectSelectionOutline(null);
        this.activeMode = 'play';
        if (this.courseManager.currentHoleIndex !== 0) {
          this.courseManager.selectHole(0);
        }
        this.courseManager.setTeeDirectionArrowVisible(false);
        this.applyPlayModeCorridorCulling(true);
        this.ui.setMode('play');
        this.setViewportShadingMode('rendered', false);
        this.placeBallAtActiveTee();
        this.cameraCtrl.setMode('aim');
        this.cameraCtrl.snapAimBehindBall(this.ball.position, this.currentAimAzimuth);
        this.setHdriEnvironment(this.currentEnvSettings, true);
        this.refreshShadowsAndMaterials(true);
        requestAnimationFrame(() => {
          if (this.activeMode === 'play') {
            this.refreshShadowsAndMaterials(false);
          }
        });
        this.updateHUDDisplay();
        this.updateDevStats();
        this.schedulePlayWorldFreeze();
      },
      onMainMenuDesigner: () => {
        this.ui.hideMainMenu();
        this.ensureHdriPreloading();
        if (this.playFreezeTimerId !== null) {
          cancelAnimationFrame(this.playFreezeTimerId);
          this.playFreezeTimerId = null;
        }
        this.freezeStaticWorldMatrices(false);
        this.applyPlayModeCorridorCulling(false);
        this.activeMode = 'designer';
        this.courseManager.setTeeDirectionArrowVisible(true);
        this.wasCameraDetachedForTrace = false;
        this.cameraCtrl.setMode('designer');
        this.cameraCtrl.ensureDesignerCameraControl(this.canvas);
        this.ui.setMode('designer');
        this.setViewportShadingMode(this.currentShadingMode, true);
        if (this.currentShadingMode === 'rendered') {
          this.setHdriEnvironment(this.currentEnvSettings, true);
          this.refreshShadowsAndMaterials(true);
          requestAnimationFrame(() => {
            if (this.activeMode === 'designer' && this.currentShadingMode === 'rendered') {
              this.setHdriEnvironment(this.currentEnvSettings, true);
              this.refreshShadowsAndMaterials(true);
            }
          });
        }
        this.updateDevStats();
        this.ui.updateFeatureList(this.terrain.stampedFeatures, this.selectedFeatureIndex);
        this.refreshOutliner();
        this.ui.updateEnvironmentInputs(this.currentEnvSettings);
        if (this.selectedFeatureIndex < 0 && !this.selectedMesh) {
          this.ui.showGroundPbrInspector({
            ...this.terrain.getGroundUvSettings(),
            satelliteMapName: this.lastSatelliteFileName || undefined
          });
        }
      },
      onModeToggle: (mode) => {
        this.ensureHdriPreloading();
        this.activeMode = mode;
        if (mode === 'designer') {
          if (this.playFreezeTimerId !== null) {
            cancelAnimationFrame(this.playFreezeTimerId);
            this.playFreezeTimerId = null;
          }
          this.freezeStaticWorldMatrices(false);
          this.courseManager.setTeeDirectionArrowVisible(true);
          this.applyPlayModeCorridorCulling(false);
          this.setViewportShadingMode(this.currentShadingMode, true);
          this.wasCameraDetachedForTrace = false;
          this.cameraCtrl.setMode('designer');
          this.cameraCtrl.ensureDesignerCameraControl(this.canvas);
          if (this.currentShadingMode === 'rendered') {
            this.refreshShadowsAndMaterials(true);
          }
          if (this.aimSystem) this.aimSystem.setVisible(false);
          this.activeDesignerTool = 'select';
          this.brushVisualizer.setVisible(false);
          this.ui.setDesignerTool('select');
          this.updateDevStats();
          this.ui.updateFeatureList(this.terrain.stampedFeatures, this.selectedFeatureIndex);
          this.refreshOutliner();
          this.ui.updateEnvironmentInputs(this.currentEnvSettings);
          if (this.selectedFeatureIndex < 0 && !this.selectedMesh) {
            this.ui.showGroundPbrInspector({
              ...this.terrain.getGroundUvSettings(),
              satelliteMapName: this.lastSatelliteFileName || undefined
            });
          }
        } else {
          this.freezeStaticWorldMatrices(false);
          this.setViewportShadingMode('rendered', false);
          this.selectCourseFeature(-1);
          this.selectMesh(null);
          this.updateGroundSelectionOutline(false);
          this.updateObjectSelectionOutline(null);
          this.setGizmoMode('none');
          if (this.featureGizmoProxy) {
            this.featureGizmoProxy.setEnabled(false);
          }
          if (this.featureDrapeMesh) {
            this.featureDrapeMesh.dispose();
            this.featureDrapeMesh = null;
            this.featureDrapePointCount = 0;
          }
          if (this.featureSurfaceFillMesh) {
            this.featureSurfaceFillMesh.dispose();
            this.featureSurfaceFillMesh = null;
          }
          if (this.selectionHighlightLayer) this.selectionHighlightLayer.removeAllMeshes();
          if (this.courseManager) {
            this.courseManager.snapTeeToTeeBox();
            this.courseManager.snapPinToGreen();
            this.courseManager.setTeeDirectionArrowVisible(false);
            this.courseManager.refreshSceneryForFeatures();
            if (this.ball && this.courseManager.currentHole?.pinPosition) {
              this.ball.setTargetPin(this.courseManager.currentHole.pinPosition);
            }
          }
          this.applyPlayModeCorridorCulling(true);
          if (this.courseManager) {
            const cb = this.terrain.playCorridorBounds;
            const bp = this.ball.position;
            const ballOutsideCorridor = Boolean(
              cb && (bp.x < cb.minX || bp.x > cb.maxX || bp.z < cb.minZ || bp.z > cb.maxZ)
            );
            const ballOutsideTerrain =
              bp.x < 0 || bp.x > this.terrain.width || bp.z < 0 || bp.z > this.terrain.length;
            if (this.courseManager.currentStrokes === 0 || ballOutsideCorridor || ballOutsideTerrain) {
              this.courseManager.currentStrokes = 0;
              this.courseManager.currentPutts = 0;
              this.placeBallAtActiveTee();
            }
          }
          this.scenery.syncColliders();
          if (this.terrain.terrainMesh && this.terrain.width <= 400 && this.terrain.length <= 400) {
            this.havok.updateTerrainCollision(this.terrain.terrainMesh);
          }
          this.ball.setTreeColliders(this.scenery.treeColliders);
          this.greenVisualizer.rebuildSlopeGrid();
          this.cameraCtrl.setMode('aim');
          this.cameraCtrl.snapAimBehindBall(this.ball.position, this.currentAimAzimuth);
          this.brushVisualizer.setVisible(false);
          if (this.aimSystem) {
            this.aimSystem.setVisible(true);
            this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
          }
          this.refreshShadowsAndMaterials(true);
          this.updateDevStats();
          this.schedulePlayWorldFreeze();
        }
      },
      onToolSelect: (tool) => {
        this.activeDesignerTool = tool;
        if (tool === 'erase' || tool === 'select') {
          this.brushVisualizer.setVisible(false);
        } else {
          this.updateBrushVisualizerConfig();
        }
      },
      onGizmoModeChange: (mode) => {
        this.setGizmoMode(mode);
      },
      onDeleteSelectedObject: () => {
        if (!this.canDeleteMesh(this.selectedMesh)) {
          this.ui.showToast('Core course props can be moved or customized, not deleted.', 'warning', 2000);
          return;
        }
        this.deleteSelectedMesh();
      },
      onPushToPlay: () => {
        this.pushChangesToPlay();
      },
      onSnapPinToGreen: () => {
        const ok = this.courseManager.snapPinToGreen();
        if (ok) {
          if (this.selectedMesh === this.courseManager.activePinMesh && this.gizmoManager) {
            this.gizmoManager.attachToMesh(null);
            this.gizmoManager.attachToMesh(this.courseManager.activePinMesh);
          }
          if (this.ball) this.ball.setTargetPin(this.courseManager.currentHole.pinPosition);
          if (this.greenVisualizer) this.greenVisualizer.rebuildSlopeGrid();
          this.updateHUDDisplay();
          this.ui.showToast('🚩 Snapped Flag Stick, Flag & Hole to Center of Green!', 'success', 2500);
        }
      },
      onSnapTeeToBox: () => {
        const ok = this.courseManager.snapTeeToTeeBox();
        if (ok) {
          if (this.selectedMesh === this.courseManager.activeTeeMesh && this.gizmoManager) {
            this.gizmoManager.attachToMesh(null);
            this.gizmoManager.attachToMesh(this.courseManager.activeTeeMesh);
          }
          if (this.ball && this.courseManager.currentStrokes === 0) {
            this.placeBallAtActiveTee();
          }
          this.updateHUDDisplay();
          this.ui.showToast('⛳ Snapped Tee Markers & Ball to Center of Tee Box!', 'success', 2500);
        }
      },
      onRestoreChampionshipGreen: () => {
        this.restoreChampionshipLayout();
      },
      onSaveDefaultHole: () => {
        this.saveDefaultHole();
      },
      onViewportShadingChange: (mode) => {
        this.setViewportShadingMode(mode, true);
      },
      onHdriPresetSelect: (presetId) => {
        const preset = HDRI_PRESETS.find(p => p.id === presetId);
        if (preset) {
          this.setHdriEnvironment({
            hdriId: preset.id,
            hdriUrl: preset.file,
            hdriRotation: preset.rotationDeg,
            syncSunWithHdri: true,
            hdriIntensity: preset.envIntensity,
            hdriScaleU: 1.0,
            hdriScaleV: 1.0,
            hdriOffsetU: 0.0,
            hdriOffsetV: 0.0,
            sunAzimuth: preset.sunAzimuth,
            sunElevation: preset.sunElevation,
            sunIntensity: preset.sunIntensity,
            sunColor: preset.sunColor,
            shadowDarkness: preset.shadowDarkness
          }, true);
          this.ui.showToast(`☀️ Loaded ${preset.resolution} Skybox: ${preset.name}`, 'info', 2000);
        }
      },
      onEnvironmentChange: (settings) => {
        this.setHdriEnvironment(settings, false);
      },
      onDeleteFeature: (featureIndex) => {
        this.deleteFeature(featureIndex);
      },
      onApplyMapNGImport: (payload) => {
        this.applyMapNGImport(payload);
      },
      onApplySatelliteOnly: (img, fileName) => {
        this.applySatelliteImageOnly(img, fileName);
      },
      onCourseOverview3D: () => {
        if (this.activeMode === 'designer') {
          this.wasCameraDetachedForTrace = false;
          this.cameraCtrl.ensureDesignerCameraControl(this.canvas);
        }
        const centerY = this.terrain.getElevation(this.lastMapNGCourseCenter.x, this.lastMapNGCourseCenter.z);
        this.cameraCtrl.setCourseOverview3D(
          this.lastMapNGCourseCenter.x,
          this.lastMapNGCourseCenter.z,
          this.lastMapNGCourseSpan,
          centerY
        );
        this.ui.showToast('🌍 Framed isolated golf course overview', 'info', 1800);
      },
      onCreateFlatHole: (opts) => {
        this.createFlatHole(opts);
      },
      onLoadDemoHole: () => {
        this.loadDemoHole();
      },
      onSelectKyalamiHole: (hole) => {
        this.selectKyalamiHoleIn3D(hole);
      },
      onToggleSatelliteOverlay: () => {
        this.toggleSatelliteOverlay();
      },
      onSatelliteOpacityChange: (opacity) => {
        this.setSatelliteOverlayOpacity(opacity);
      },
      onTopDownTraceCam: () => {
        if (this.activeMode === 'designer') {
          this.wasCameraDetachedForTrace = false;
          this.cameraCtrl.ensureDesignerCameraControl(this.canvas);
        }
        const span = Math.max(this.terrain.width, this.terrain.length);
        this.cameraCtrl.setTopDownView(this.terrain.width * 0.5, this.terrain.length * 0.5, span);
        this.ui.showToast('📐 Top-Down Tracing Camera Ready', 'info', 1800);
      },
      onTraceModeChange: (mode, surface) => {
        this.featureTracer?.setTraceMode(mode, surface);
        if (mode !== 'off') {
          this.selectCourseFeature(-1);
        }
      },
      onTraceFinish: () => {
        if (!this.featureTracer?.finishTrace()) {
          this.ui.showToast('Place at least 3 points before closing contour.', 'warning', 2000);
        }
      },
      onTraceCancel: () => {
        this.featureTracer?.cancelTrace();
      },
      onTraceUndoPoint: () => {
        this.featureTracer?.undoLastPoint();
      },
      onOutlinerSelect: (item) => {
        if (item.featureIndex !== undefined) {
          this.selectCourseFeature(item.featureIndex);
        } else if (item.meshId) {
          const m = this.scene.getMeshById(item.meshId) || this.scene.getMeshByName(item.id);
          if (m && m instanceof Mesh) {
            this.selectMesh(m);
          }
        }
      },
      onOutlinerFrame: (item) => {
        if (item.featureIndex !== undefined) {
          const feats = this.terrain.stampedFeatures;
          const f = feats[item.featureIndex];
          if (f) {
            const y = this.terrain.getElevation(f.centerX, f.centerZ);
            this.cameraCtrl.frameOnTarget(new Vector3(f.centerX, y, f.centerZ), 20);
          }
        } else if (item.meshId) {
          const m = this.scene.getMeshById(item.meshId) || this.scene.getMeshByName(item.id);
          if (m && m instanceof Mesh) {
            this.selectMesh(m);
            this.frameSelectedObject();
          }
        }
      },
      onOutlinerToggleVisibility: (item) => {
        if (item.meshId) {
          const m = this.scene.getMeshById(item.meshId) || this.scene.getMeshByName(item.id);
          if (m) {
            m.isVisible = item.isVisible;
            m.getChildMeshes?.().forEach(c => c.isVisible = item.isVisible);
          }
        }
      },
      onOutlinerDelete: (item) => {
        if (item.featureIndex !== undefined) {
          this.deleteFeature(item.featureIndex);
        } else if (item.meshId) {
          const m = this.scene.getMeshById(item.meshId) || this.scene.getMeshByName(item.id);
          if (m && m instanceof Mesh) {
            this.deleteSceneryObject(m);
            this.refreshOutliner();
          }
        }
      },
      onResetFactoryLayout: () => {
        this.resetFactoryLayout();
      },
      onSelectGroundLayer: () => {
        this.selectGroundLayer();
      },
      onFrameSelectedObject: () => {
        this.frameSelectedObject();
      },
      onSelectObjectById: (meshId) => {
        const found = this.getSelectable3DModels().find(m => m.id === meshId);
        if (found) {
          this.selectMesh(found.mesh);
          this.ui.showToast(`Selected 3D model: ${found.label}`, 'info', 1800);
        }
      },
      onObjectSubMaterialSelect: (subIdx) => {
        this.selectedObjectSubMatIdx = subIdx;
        if (this.selectedMesh && this.selectedMesh !== this.featureGizmoProxy) {
          const info = this.getObjectMaterialInfo(this.selectedMesh, subIdx);
          this.ui.updateDevSelectedObjectMaterial(info);
        }
      },
      onReplaceObjectGlb: async (file) => {
        if (!this.selectedMesh || this.selectedMesh === this.featureGizmoProxy) {
          this.ui.showToast('Click any 3D model first before replacing it.', 'info', 2400);
          return;
        }
        let targetRoot: Mesh;
        if (this.selectedMesh instanceof InstancedMesh) {
          const inst = this.selectedMesh;
          const pos = inst.position.clone();
          const rot = inst.rotation.clone();
          const scale = inst.scaling.clone();
          const name = inst.name;
          this.courseManager.removeSceneryMesh(inst);
          inst.dispose(false, false);
          targetRoot = new Mesh(name, this.scene);
          targetRoot.position.copyFrom(pos);
          targetRoot.rotation.copyFrom(rot);
          targetRoot.scaling.copyFrom(scale);
          this.courseManager.getSceneryMeshes().push(targetRoot);
          this.selectedMesh = targetRoot;
        } else {
          targetRoot = this.selectedMesh as Mesh;
        }
        try {
          this.ui.showToast(`Loading replacement 3D model "${file.name}"...`, 'info', 2200);
          const buf = await file.arrayBuffer();
          const safePrefix = file.name.replace(/\.glb$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'custom';
          const res = await this.scenery.parseAndApplyReplacementGlb(targetRoot, buf, safePrefix);
          this.registerSceneryShadows();
          this.scenery.syncColliders();
          this.ball.setTreeColliders(this.scenery.treeColliders);
          this.selectedObjectSubMatIdx = 0;
          this.selectMesh(targetRoot, 0);
          this.ui.showToast(
            `Replaced 3D model with ${file.name} (${res.materialNames.length} material${res.materialNames.length === 1 ? '' : 's'})`,
            'success',
            2600
          );
        } catch (err: any) {
          console.error('[ReplaceGLB] Failed:', err);
          this.ui.showToast(`Could not load .glb: ${err?.message || 'Invalid file'}`, 'penalty', 3200);
        }
      },
      onSelectFeature: (idx) => {
        this.selectCourseFeature(idx);
      },
      onFeatureSubMaterialSelect: (idx, subId) => {
        this.selectedFeatureSubMatId = subId;
        this.presentSelectedFeatureMaterial(idx, subId);
      },
      onFeatureMaterialChange: (idx, subId, settings) => {
        this.selectedFeatureSubMatId = subId;
        const feat = this.terrain.stampedFeatures[idx];
        if (feat && subId === 'water_surface' && feat.surfaceType === SurfaceType.WATER) {
          const waterMesh = this.findWaterMeshForFeature(feat);
          if (waterMesh) {
            this.applyObjectMaterialSettings(waterMesh, settings, 0);
          }
          if (settings.showCollarRings !== undefined || settings.collarWidth !== undefined) {
            this.terrain.updateFeatureSubMaterial(idx, 'surface', {
              showCollarRings: settings.showCollarRings,
              collarWidth: settings.collarWidth
            });
          }
          return;
        }
        this.terrain.updateFeatureSubMaterial(idx, subId, settings);
      },
      onResetFeatureMaterial: (idx, subId) => {
        const feat = this.terrain.stampedFeatures[idx];
        if (feat && subId === 'water_surface' && feat.surfaceType === SurfaceType.WATER) {
          const waterMesh = this.findWaterMeshForFeature(feat);
          if (waterMesh) {
            this.resetObjectMaterial(waterMesh, 0);
          }
          this.presentSelectedFeatureMaterial(idx, subId);
          return;
        }
        this.terrain.resetFeatureSubMaterial(idx, subId);
        this.presentSelectedFeatureMaterial(idx, subId);
      },
      onFeatureTextureUpload: async (idx, subId, slot, dataUrl, fileName) => {
        const feat = this.terrain.stampedFeatures[idx];
        if (feat && subId === 'water_surface' && feat.surfaceType === SurfaceType.WATER) {
          const waterMesh = this.findWaterMeshForFeature(feat);
          if (waterMesh) {
            this.uploadTextureOnMaterial(waterMesh, 0, slot, dataUrl, fileName);
          }
          this.presentSelectedFeatureMaterial(idx, subId);
          this.ui.showToast(`Updated Water Surface ${slot.toUpperCase()} map`);
          return;
        }
        await this.terrain.setFeatureSubMaterialTexture(idx, subId, slot, dataUrl, fileName);
        this.presentSelectedFeatureMaterial(idx, subId);
        this.ui.showToast(`Updated ${subId.toUpperCase()} ${slot.toUpperCase()} map on feature #${idx}`);
      },
      onObjectTextureUpload: (slot, dataUrl, fileName) => {
        if (!this.selectedMesh || this.selectedMesh === this.featureGizmoProxy) return;
        this.uploadTextureOnMaterial(this.selectedMesh, this.selectedObjectSubMatIdx, slot, dataUrl, fileName);
        const info = this.getObjectMaterialInfo(this.selectedMesh, this.selectedObjectSubMatIdx);
        this.ui.updateDevSelectedObjectMaterial(info);
        this.ui.showToast(`Updated ${slot.toUpperCase()} map on ${this.selectedMesh.name}`);
      },
      onGroundTextureUpload: async (slot, dataUrl, fileName) => {
        if (slot === 'satellite') {
          const img = await new Promise<HTMLImageElement | null>((resolve) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => resolve(null);
            el.src = dataUrl;
          });
          if (img) {
            this.applySatelliteImageOnly(img, fileName);
          }
          return;
        }
        await this.terrain.setGroundTexture(slot, dataUrl, fileName);
        this.ui.showGroundPbrInspector({
          ...this.terrain.getGroundUvSettings(),
          satelliteMapName: this.lastSatelliteFileName || undefined
        });
        this.ui.showToast(`Updated Ground PBR ${slot.toUpperCase()} map`);
      },
      onObjectMaterialChange: (settings) => {
        if (!this.selectedMesh || this.selectedMesh === this.featureGizmoProxy) return;
        this.applyObjectMaterialSettings(this.selectedMesh, settings, this.selectedObjectSubMatIdx);
      },
      onResetObjectMaterial: () => {
        if (!this.selectedMesh || this.selectedMesh === this.featureGizmoProxy) return;
        this.resetObjectMaterial(this.selectedMesh, this.selectedObjectSubMatIdx);
        const info = this.getObjectMaterialInfo(this.selectedMesh, this.selectedObjectSubMatIdx);
        this.ui.updateDevSelectedObjectMaterial(info);
      },
      onUndo: () => {
        this.undo();
      },
      onRedo: () => {
        this.redo();
      },
      onMoveFeature: (idx, x, z, isLive) => {
        if (isLive && !this.pendingHistorySnapshot && idx >= 0) {
          const f = this.terrain.stampedFeatures[idx];
          this.pendingHistorySnapshot = this.captureHistorySnapshot('Move ' + (f?.name || f?.surfaceType || 'Feature'));
        }
        this.moveCourseFeature(idx, x, z, isLive);
        if (!isLive && this.pendingHistorySnapshot) {
          this.recordHistoryStep(this.pendingHistorySnapshot.description, this.pendingHistorySnapshot);
          this.pendingHistorySnapshot = null;
        }
      },
      onRotateFeature: (idx, rad, isLive) => {
        if (isLive && !this.pendingHistorySnapshot && idx >= 0) {
          const f = this.terrain.stampedFeatures[idx];
          this.pendingHistorySnapshot = this.captureHistorySnapshot('Rotate ' + (f?.name || f?.surfaceType || 'Feature'));
        }
        this.rotateCourseFeature(idx, rad, isLive);
        if (!isLive && this.pendingHistorySnapshot) {
          this.recordHistoryStep(this.pendingHistorySnapshot.description, this.pendingHistorySnapshot);
          this.pendingHistorySnapshot = null;
        }
      },
      onGroundUvChange: (settings) => {
        if (settings.satelliteMix !== undefined) {
          this.setSatelliteOverlayOpacity(settings.satelliteMix);
        }
        if (settings.enableSatelliteTex !== undefined) {
          if (settings.enableSatelliteTex && this.terrain.satelliteOverlayTex) {
            const nextOp = this.lastSavedSatelliteOpacity > 0.05 ? this.lastSavedSatelliteOpacity : 0.72;
            this.setSatelliteOverlayOpacity(nextOp);
          } else if (!settings.enableSatelliteTex) {
            this.terrain.setSatelliteOpacity(0, false);
            this.ui.updateSatelliteUi(false, 0);
          }
        }
        this.terrain.setGroundUvSettings(settings);
      },
      onResetGroundMaterial: () => {
        this.terrain.resetGroundMaterial();
        this.ui.showGroundPbrInspector({
          ...this.terrain.getGroundUvSettings(),
          satelliteMapName: this.lastSatelliteFileName || undefined
        });
        this.ui.showToast('Reset Main Ground to Grass007 PBR defaults 🌱', 'info', 1800);
      },
      onSculptModeSelect: (mode) => {
        this.activeSculptMode = mode;
        this.updateBrushVisualizerConfig();
      },
      onPresetSelect: (preset) => {
        this.activePreset = preset;
        this.activeDesignerTool = 'stamp';
        this.updateBrushVisualizerConfig();

        // If a feature is already selected and user clicks a matching preset card, update shape immediately!
        if (this.selectedFeatureIndex >= 0 && this.selectedFeatureIndex < this.terrain.stampedFeatures.length) {
          const feat = this.terrain.stampedFeatures[this.selectedFeatureIndex];
          if (feat && feat.surfaceType === SurfaceType.FAIRWAY && preset.category === 'fairway') {
            const shape = preset.id === 'fairway_dogleg_left' ? 'dogleg_left' : preset.id === 'fairway_landing_straight' ? 'straight' : 'dogleg_right';
            this.terrain.setFairwayShape(this.selectedFeatureIndex, shape);
            this.syncFeatureSubsystems(this.selectedFeatureIndex);
            this.updateFeatureDrapeMesh(this.selectedFeatureIndex);
            this.highlightFeatureComponents(this.selectedFeatureIndex);
            this.ui.updateDevSelectedFeature(feat, this.selectedFeatureIndex);
            this.ui.showToast(`Updated Fairway to ${preset.name}! ✨`, 'success');
            return;
          } else if (feat && feat.surfaceType === SurfaceType.BUNKER && preset.category === 'bunker' && preset.bunkerShapeIndex !== undefined) {
            this.terrain.setBunkerShape(this.selectedFeatureIndex, preset.bunkerShapeIndex);
            this.syncFeatureSubsystems(this.selectedFeatureIndex);
            this.updateFeatureDrapeMesh(this.selectedFeatureIndex);
            this.highlightFeatureComponents(this.selectedFeatureIndex);
            this.ui.updateDevSelectedFeature(feat, this.selectedFeatureIndex);
            this.ui.showToast(`Updated Bunker to ${preset.name}! ✨`, 'success');
            return;
          }
        }
      },
      onFairwayShapeChange: (idx, shape) => {
        if (idx >= 0 && idx < this.terrain.stampedFeatures.length) {
          this.terrain.setFairwayShape(idx, shape);
          const feat = this.terrain.stampedFeatures[idx];
          this.syncFeatureSubsystems(idx);
          this.updateFeatureDrapeMesh(idx);
          this.highlightFeatureComponents(idx);
          this.ui.updateDevSelectedFeature(feat, idx);
          const shapeLabel = shape === 'dogleg_left' ? 'Dogleg Left' : shape === 'straight' ? 'Straight' : 'Dogleg Right';
          this.ui.showToast(`Fairway shape changed to ${shapeLabel}! 🏌️`, 'success');
        }
      },
      onBunkerShapeChange: (idx, shapeIndex) => {
        if (idx >= 0 && idx < this.terrain.stampedFeatures.length) {
          this.terrain.setBunkerShape(idx, shapeIndex);
          const feat = this.terrain.stampedFeatures[idx];
          this.syncFeatureSubsystems(idx);
          this.updateFeatureDrapeMesh(idx);
          this.highlightFeatureComponents(idx);
          this.ui.updateDevSelectedFeature(feat, idx);
          this.ui.showToast(`Bunker shape updated! 🏖️`, 'success');
        }
      },
      onBrushRadiusChange: (radius) => {
        this.brushRadius = radius;
        this.updateBrushVisualizerConfig();
      },
      onBrushStrengthChange: (strength) => {
        this.brushStrength = strength;
      },
      onTargetSurfaceSelect: (surf) => {
        this.targetSurface = surf;
      },
      onHoleSelect: (idx) => {
        this.courseManager.selectHole(idx);
        this.placeBallAtActiveTee();
        this.ui.updateHolesList(this.courseManager.courseData.holes, this.courseManager.currentHoleIndex);
        this.updateHUDDisplay();
      },
      onHoleParChange: (par) => {
        this.courseManager.currentHole.par = par;
        this.ui.updateHolesList(this.courseManager.courseData.holes, this.courseManager.currentHoleIndex);
        this.updateHUDDisplay();
      },
      onToggleGrid: () => {
        return this.toggle1mGrid();
      },
      onToggleGreenGrid: () => {
        this.autoEnabledGreenOverlays = false;
        return this.greenVisualizer.toggleGrid();
      },
      onToggleGreenDots: () => {
        this.autoEnabledGreenOverlays = false;
        return this.greenVisualizer.toggleDots();
      },
      onExportCourse: () => {
        const json = this.courseManager.exportCourseJSON();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.courseManager.courseData.name.replace(/\s+/g, '_')}.json`;
        a.click();
        URL.revokeObjectURL(url);
      },
      onImportCourse: (json) => {
        const success = this.courseManager.importCourseJSON(json);
        if (success) {
          this.greenVisualizer.rebuildSlopeGrid();
          this.havok.updateTerrainCollision(this.terrain.terrainMesh!);
          this.update1mGridMesh();
          this.placeBallAtActiveTee();
          this.ui.updateHolesList(this.courseManager.courseData.holes, this.courseManager.currentHoleIndex);
          this.updateHUDDisplay();
          this.registerSceneryShadows();
          this.ui.showToast('Course successfully imported!', 'success');
        } else {
          this.ui.showToast('Failed to import course. Invalid format.', 'penalty');
        }
      },
      onSaveProjectDisk: () => {
        try {
          const json = this.courseManager.exportCourseJSON();
          const blob = new Blob([json], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          const filename = `${(this.courseManager.courseData.name || 'GolfCourse').replace(/[^a-zA-Z0-9_-]/g, '_')}_project.json`;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          const mb = (blob.size / (1024 * 1024)).toFixed(2);
          this.ui.showToast(`Saved project: ${filename} (${mb} MB) 💾`, 'success', 3200);
        } catch (err: any) {
          console.error('Save project failed:', err);
          this.ui.showToast(`Failed to save project: ${err?.message || 'Export error'}`, 'penalty', 4000);
        }
      },
      onOpenProjectDisk: (json: string) => {
        const success = this.courseManager.importCourseJSON(json);
        if (success) {
          this.lastUnifiedCourseMeta = (this.courseManager.courseData.mapngMeta as any) || null;
          this.lastMapNGCourseCenter = { x: this.terrain.width * 0.5, z: this.terrain.length * 0.5 };
          this.lastMapNGCourseSpan = Math.max(460, Math.max(this.terrain.width, this.terrain.length));
          this.cameraCtrl.setDesignerWorldBounds(
            -180,
            this.terrain.width + 180,
            -180,
            this.terrain.length + 180,
            Math.max(1400, this.lastMapNGCourseSpan * 1.65)
          );
          this.greenVisualizer.rebuildSlopeGrid();
          if (this.terrain.terrainMesh && this.terrain.width <= 400 && this.terrain.length <= 400) {
            this.havok.updateTerrainCollision(this.terrain.terrainMesh);
          }
          this.update1mGridMesh();
          this.courseManager.currentStrokes = 0;
          this.courseManager.currentPutts = 0;
          this.placeBallAtActiveTee();
          this.ui.updateHolesList(this.courseManager.courseData.holes, this.courseManager.currentHoleIndex);
          this.ui.updateSatelliteUi(Boolean(this.terrain.satellitePreviewDataUrl), this.terrain.satelliteOpacity);
          this.updateHUDDisplay();
          this.registerSceneryShadows();
          this.refreshOutliner();
          this.updateDevStats();
          if (this.courseManager.courseData.name) {
            this.ui.updateHeaderBranding(this.courseManager.courseData.name);
          }
          this.ui.showToast(`Course project '${this.courseManager.courseData.name}' loaded successfully! 📂`, 'success');
        } else {
          this.ui.showToast('Failed to load project file. Please ensure valid JSON course format.', 'penalty');
        }
      },
      onCourseBrandingChange: (branding) => {
        this.courseManager.courseData.name = branding.courseName;
        this.ui.updateHeaderBranding(branding.courseName, branding.logoUrl);
        this.updateHUDDisplay();
        this.ui.showToast(`Updated course branding: ${branding.courseName} 🏷️`, 'success');
      },
      onClubSelect: (club) => {
        this.activeClub = club;
        this.swingEngine.setClub(club);
        if (this.aimSystem) {
          const pin = this.courseManager.currentHole.pinPosition;
          const dx = pin.x - this.ball.position.x;
          const dz = pin.z - this.ball.position.z;
          const distToPin = Math.sqrt(dx * dx + dz * dz);
          this.aimSystem.targetDistanceMeters = Math.min(distToPin, club.typicalCarryMeters);
          this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
        }
        this.updateHUDDisplay();
      },
      onSwingAction: () => {
        if (this.activeMode !== 'play') return;
        if (this.ball.state === BallState.IN_FLIGHT || this.ball.state === BallState.ROLLING) return;
        if (this.aimSystem) {
          this.aimSystem.hideAimArrow();
        }
        this.swingEngine.handleActionClick();
      },
      onAimAdjust: (deltaDeg) => {
        if (this.activeMode !== 'play' || this.ball.state === BallState.IN_FLIGHT || this.ball.state === BallState.ROLLING) return;
        this.currentAimAzimuth += deltaDeg;
        this.swingEngine.aimAzimuthDeg = this.currentAimAzimuth;
        if (this.aimSystem) {
          this.aimSystem.aimHeadingDeg = this.currentAimAzimuth;
          this.aimSystem.showAimArrow(this.ball.position);
          this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
        }
        soundFx.playAimTick();
        // Adjusting arrow heading does NOT rotate or snap camera out of view
        this.updateHUDDisplay();
      },
      onAimToOverheadPoint: (worldX, worldZ) => {
        if (this.activeMode !== 'play' || this.ball.state === BallState.IN_FLIGHT || this.ball.state === BallState.ROLLING) return;
        const dx = worldX - this.ball.position.x;
        const dz = worldZ - this.ball.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        this.currentAimAzimuth = (Math.atan2(dx, dz) * 180) / Math.PI;
        this.swingEngine.aimAzimuthDeg = this.currentAimAzimuth;
        if (this.aimSystem) {
          this.aimSystem.aimHeadingDeg = this.currentAimAzimuth;
          this.aimSystem.targetDistanceMeters = dist;
          this.aimSystem.showAimArrow(this.ball.position);
          this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
        }
        this.cameraCtrl.setAimHeading(this.ball.position, this.currentAimAzimuth);
        soundFx.playAimTick();
        this.updateHUDDisplay();
        this.ui.showToast(`🎯 Aiming to ${Math.round(dist)}m target`, 'info', 1000);
      },
      onShotShapeChange: (shape) => {
        this.swingEngine.setShotShape(shape);
        soundFx.playAimTick();
        this.ui.showToast(`Shot Shape: ${shape.toUpperCase()}`, 'info', 1000);
      },
      onTargetDistanceAdjust: (deltaMeters) => {
        if (this.activeMode !== 'play' || this.ball.state === BallState.IN_FLIGHT || this.ball.state === BallState.ROLLING) return;
        if (this.aimSystem) {
          this.aimSystem.adjustDistance(deltaMeters);
          this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
          this.updateHUDDisplay();
        }
      },
      onCameraModeToggle: () => {
        if (this.activeMode !== 'play') return;
        const current = this.cameraCtrl.mode;
        if (current === 'aim') {
          this.cameraCtrl.setMode('scout');
          this.cameraCtrl.setScoutView(this.ball.position, this.courseManager.currentHole.pinPosition);
        } else if (current === 'scout') {
          this.cameraCtrl.setMode('green');
          this.cameraCtrl.focusOnPin(this.courseManager.currentHole.pinPosition);
        } else {
          this.cameraCtrl.setMode('aim');
          this.cameraCtrl.snapAimBehindBall(this.ball.position, this.currentAimAzimuth);
        }
      },
      onFocusBall: () => {
        // Strictly only when the ball has settled/is stationary
        if (this.activeMode !== 'play') return;
        if (this.ball.state !== BallState.AIMING && this.ball.state !== BallState.AT_REST) return;

        const hole = this.courseManager.currentHole;
        const pin = hole.pinPosition;
        const dxPin = pin.x - this.ball.position.x;
        const dzPin = pin.z - this.ball.position.z;
        const distToPin = Math.hypot(dxPin, dzPin);

        // If on the tee box of a dogleg hole, face the initial dogleg landing waypoint; otherwise face the pin
        let targetPt = pin;
        if (this.ball.currentSurface === SurfaceType.TEE && hole.waypoints && hole.waypoints.length > 0 && distToPin > 220) {
          targetPt = hole.waypoints[0];
        }

        const dx = targetPt.x - this.ball.position.x;
        const dz = targetPt.z - this.ball.position.z;
        this.currentAimAzimuth = (Math.atan2(dx, dz) * 180) / Math.PI;
        this.swingEngine.aimAzimuthDeg = this.currentAimAzimuth;

        if (this.aimSystem) {
          this.aimSystem.aimHeadingDeg = this.currentAimAzimuth;
          this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
        }

        this.cameraCtrl.setMode('aim');
        this.cameraCtrl.snapAimBehindBall(this.ball.position, this.currentAimAzimuth);
        this.ball.triggerReadyFlashIndicator();
        this.updateHUDDisplay();
      },
      onResetShot: () => {
        this.placeBallAtActiveTee();
        this.updateHUDDisplay();
      },
      onRestartHole: () => {
        if (this.courseManager) {
          this.courseManager.currentStrokes = 0;
          this.courseManager.currentPutts = 0;
          this.courseManager.snapTeeToTeeBox();
        }
        this.ball.clearTracer();
        this.placeBallAtActiveTee();
        this.ui.setSwingEnabled(true);
        this.updateHUDDisplay();
        this.ui.showToast('🔄 Hole restarted from Tee Box', 'info', 2000);
      }
    });

    // Club selector Prev / Next buttons
    document.getElementById('btn-prev-club')?.addEventListener('click', () => {
      const idx = GOLF_CLUBS.findIndex(c => c.id === this.activeClub.id);
      if (idx > 0) {
        this.activeClub = GOLF_CLUBS[idx - 1];
        this.swingEngine.setClub(this.activeClub);
        if (this.aimSystem) {
          const pin = this.courseManager.currentHole.pinPosition;
          const dx = pin.x - this.ball.position.x;
          const dz = pin.z - this.ball.position.z;
          const distToPin = Math.sqrt(dx * dx + dz * dz);
          this.aimSystem.targetDistanceMeters = Math.min(distToPin, this.activeClub.typicalCarryMeters);
          this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
        }
        this.updateHUDDisplay();
      }
    });

    document.getElementById('btn-next-club')?.addEventListener('click', () => {
      const idx = GOLF_CLUBS.findIndex(c => c.id === this.activeClub.id);
      if (idx < GOLF_CLUBS.length - 1) {
        this.activeClub = GOLF_CLUBS[idx + 1];
        this.swingEngine.setClub(this.activeClub);
        if (this.aimSystem) {
          const pin = this.courseManager.currentHole.pinPosition;
          const dx = pin.x - this.ball.position.x;
          const dz = pin.z - this.ball.position.z;
          const distToPin = Math.sqrt(dx * dx + dz * dz);
          this.aimSystem.targetDistanceMeters = Math.min(distToPin, this.activeClub.typicalCarryMeters);
          this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
        }
        this.updateHUDDisplay();
      }
    });

    // Swing Engine hooks
    this.swingEngine.onUpdate = (progress, phase, lockedPower) => {
      this.ui.updateSwingMeter(progress, phase, lockedPower);
    };

    this.swingEngine.onSwingCancelled = (reason) => {
      this.ui.setSwingFeedbackText(reason, 'miss');
    };

    this.swingEngine.onShotExecute = (shot) => {
      this.courseManager.recordStroke(this.activeClub.category === 'putter');
      this.cameraCtrl.setMode('flight');
      if (this.aimSystem) {
        this.aimSystem.setVisible(false);
      }
      if (this.autoEnabledGreenOverlays) {
        this.greenVisualizer.setVisible(false);
        this.ui.setGreenToggleStates(false, false);
        this.autoEnabledGreenOverlays = false;
        this.wasSettledOnGreen = false;
      }
      this.ui.setSwingEnabled(false);
      // Smooth slick transition out for Driver/Putter card as ball is hit
      this.ui.updateClubCard(this.activeClub.id, true);
      this.ball.launch(shot, this.courseManager.currentHole.pinPosition);

      if (Math.abs(shot.accuracyOffset) < 0.15) {
        this.ui.setSwingFeedbackText('PERFECT STRIKE! 🌟', 'perfect');
      } else if (shot.accuracyOffset > 0.45) {
        this.ui.setSwingFeedbackText('PUSH SLICE ➡️', 'slice');
      } else if (shot.accuracyOffset < -0.45) {
        this.ui.setSwingFeedbackText('SNAP HOOK ⬅️', 'hook');
      } else if (shot.accuracyOffset > 0) {
        this.ui.setSwingFeedbackText('BABY FADE ↗️', 'fade');
      } else {
        this.ui.setSwingFeedbackText('NICE DRAW ↖️', 'draw');
      }

      this.updateHUDDisplay();
    };

    // Backspin & Landing Divot System Callbacks
    this.ball.onBackspinTimingWindow = (active) => {
      this.ui.showBackspinTimingPrompt(active);
    };
    this.ball.onBackspinLocked = (intensity, rating) => {
      this.ui.showBackspinLocked(intensity, rating);
    };
    this.ball.onBackspinBiteEngaged = (intensity) => {
      this.ui.showBackspinBiteEngaged(intensity);
    };

    // Ball state changes & Distance Tracking
    this.ball.onStateChange = (state, lie, shotStats) => {
      if (shotStats) {
        this.ui.updateShotStats(shotStats.carry, shotStats.total, state === BallState.AT_REST);
      }

      if (state === BallState.AT_REST) {
        const holed = this.ball.checkHoleIn(this.courseManager.currentHole.pinPosition);
        if (!holed) {
          const pin = this.courseManager.currentHole.pinPosition;
          const dx = pin.x - this.ball.position.x;
          const dz = pin.z - this.ball.position.z;
          const dist = Math.hypot(dx, dz);
          this.currentAimAzimuth = (Math.atan2(dx, dz) * 180) / Math.PI;
          this.swingEngine.aimAzimuthDeg = this.currentAimAzimuth;

          const isGreen = (lie === SurfaceType.GREEN || this.ball.currentSurface === SurfaceType.GREEN);
          this.activeClub = getRecommendedClub(dist, isGreen);
          this.swingEngine.setClub(this.activeClub);
          this.swingEngine.setLie(this.ball.currentSurface);

          // Prompt and smooth 450ms settle transition so player is never stuck waiting
          setTimeout(() => {
            if (this.ball.state !== BallState.AT_REST && this.ball.state !== BallState.AIMING) return;

            const onPuttingGreen = (this.ball.currentSurface === SurfaceType.GREEN);
            this.cameraCtrl.setMode(onPuttingGreen ? 'green' : 'aim');

            // In BOTH green/putting and regular aim modes: snap camera right behind the ball aiming at the cup!
            this.cameraCtrl.snapAimBehindBall(this.ball.position, this.currentAimAzimuth);

            // Re-arm ball for next shot/putt and trigger the 3-flash ready indicator
            this.ball.state = BallState.AIMING;
            this.ball.triggerReadyFlashIndicator();

            this.swingEngine.reset();
            this.ui.setSwingEnabled(true);

            if (this.aimSystem && this.activeMode === 'play') {
              this.aimSystem.targetDistanceMeters = Math.min(dist, this.activeClub.typicalCarryMeters);
              this.aimSystem.aimHeadingDeg = this.currentAimAzimuth;
              this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
              this.aimSystem.setVisible(true);
            }

            this.updateHUDDisplay();
          }, 450);
        }
      } else if (state === BallState.IN_WATER) {
        this.courseManager.recordStroke();
        this.ui.showToast('💦 WATER HAZARD! 1 Penalty Stroke — Dropping at point of entry.', 'penalty', 4500);
        this.ui.setSwingEnabled(false);
        if (this.aimSystem) this.aimSystem.setVisible(false);

        // Find nearest point of relief on dry land outside water entry point
        const entry = this.ball.waterEntryPoint;
        const origin = this.ball.shotOrigin;
        let dirX = origin.x - entry.x;
        let dirZ = origin.z - entry.z;
        const dist = Math.hypot(dirX, dirZ);
        if (dist > 0.1) {
          dirX /= dist;
          dirZ /= dist;
        } else {
          dirX = 0;
          dirZ = -1;
        }

        // Step back 1.4m along approach line away from water hazard
        let dropX = entry.x + dirX * 1.4;
        let dropZ = entry.z + dirZ * 1.4;

        if (this.terrain.getSurfaceAt(dropX, dropZ) === SurfaceType.WATER) {
          dropX = entry.x + dirX * 2.8;
          dropZ = entry.z + dirZ * 2.8;
        }

        const dropGroundY = this.terrain.getElevation(dropX, dropZ);
        const finalRestY = dropGroundY + GOLF_CONSTANTS.BALL_RENDER_RADIUS;
        this.executeBallDropAnimation(dropX, dropGroundY, dropZ, finalRestY);
      }
    };

    this.ball.onHoleComplete = () => {
      if (this.aimSystem) {
        this.aimSystem.setVisible(false);
      }
      this.ui.setSwingEnabled(false);
      const score = this.courseManager.completeHole();
      const isLastHole = this.courseManager.currentHoleIndex >= this.courseManager.courseData.holes.length - 1;

      this.ui.showHoleCompleteModal(
        score,
        isLastHole,
        () => {
          if (!isLastHole) {
            this.courseManager.selectHole(this.courseManager.currentHoleIndex + 1);
            this.placeBallAtActiveTee();
          } else {
            this.courseManager.selectHole(0);
            this.placeBallAtActiveTee();
          }
        },
        () => {
          this.placeBallAtActiveTee();
        }
      );
      this.updateHUDDisplay();
    };

    this.ball.onOutOfBounds = () => {
      this.ui.showToast('⚠️ OUT OF BOUNDS! 1 penalty stroke. Ball returned to previous lie.', 'warning');
      this.courseManager.recordStroke();
      this.ball.setPosition(this.ball.shotOrigin.x, this.ball.shotOrigin.y, this.ball.shotOrigin.z);
      if (this.activeMode === 'play') {
        this.cameraCtrl.setMode('aim');
        this.cameraCtrl.snapAimBehindBall(this.ball.position, this.currentAimAzimuth);
      }
      this.ui.setSwingEnabled(true);
      if (this.aimSystem) {
        this.aimSystem.setVisible(true);
        this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
      }
      this.updateHUDDisplay();
    };

    this.ui.updateHolesList(this.courseManager.courseData.holes, this.courseManager.currentHoleIndex);
    this.updateHUDDisplay();
  }

  // --- History (Undo / Redo) System ---
  private captureHistorySnapshot(description: string): DesignerHistoryStep {
    const stampedFeatures = this.terrain.stampedFeatures.map(f => ({
      ...f,
      doglegPoints: f.doglegPoints ? f.doglegPoints.map(p => ({ ...p })) : undefined,
      contour: f.contour ? f.contour.map(p => ({ ...p })) : undefined
    }));
    const baseHeights = new Float32Array(this.terrain.baseHeights);
    const pristine = this.terrain.getPristineNaturalHeights();
    const pristineHeights = pristine ? new Float32Array(pristine) : undefined;
    const sceneryMeshes = this.courseManager.getSceneryMeshes().map(m => ({
      name: m.name,
      pos: [m.position.x, m.position.y, m.position.z] as [number, number, number],
      rot: [m.rotation.x, m.rotation.y, m.rotation.z] as [number, number, number],
      scale: [m.scaling.x, m.scaling.y, m.scaling.z] as [number, number, number]
    }));
    const activeHole = this.courseManager.getActiveHole();
    const holeState = {
      pinPos: [activeHole.pinPosition.x, activeHole.pinPosition.y, activeHole.pinPosition.z] as [number, number, number],
      teePos: [activeHole.teePosition.x, activeHole.teePosition.y, activeHole.teePosition.z] as [number, number, number],
      teeRotY: this.courseManager.activeTeeMesh ? this.courseManager.activeTeeMesh.rotation.y : 0
    };

    return {
      description,
      stampedFeatures,
      selectedFeatureIndex: this.selectedFeatureIndex,
      baseHeights,
      pristineHeights,
      sceneryMeshes,
      holeState
    };
  }

  private recordHistoryStep(description: string, preSnapshot?: DesignerHistoryStep) {
    if (this.isHistoryNavigating) return;
    const step = preSnapshot || this.captureHistorySnapshot(description);
    this.historyUndoStack.push(step);
    if (this.historyUndoStack.length > 50) {
      this.historyUndoStack.shift();
    }
    this.historyRedoStack = [];
    this.updateUndoRedoUI();
  }

  public undo() {
    if (this.historyUndoStack.length === 0) {
      this.ui.showToast('Nothing to undo', 'info', 1500);
      return;
    }
    this.isHistoryNavigating = true;
    const current = this.captureHistorySnapshot('Current State');
    this.historyRedoStack.push(current);

    const step = this.historyUndoStack.pop()!;
    this.applyHistorySnapshot(step);
    this.isHistoryNavigating = false;
    this.updateUndoRedoUI();
    this.ui.showToast(`↩ Undid: ${step.description}`, 'info', 2000);
  }

  public redo() {
    if (this.historyRedoStack.length === 0) {
      this.ui.showToast('Nothing to redo', 'info', 1500);
      return;
    }
    this.isHistoryNavigating = true;
    const current = this.captureHistorySnapshot('Current State');
    this.historyUndoStack.push(current);

    const step = this.historyRedoStack.pop()!;
    this.applyHistorySnapshot(step);
    this.isHistoryNavigating = false;
    this.updateUndoRedoUI();
    this.ui.showToast(`↪ Redid: ${step.description}`, 'info', 2000);
  }

  private updateUndoRedoUI() {
    if (this.ui) {
      this.ui.setUndoRedoEnabled(this.historyUndoStack.length > 0, this.historyRedoStack.length > 0);
    }
  }

  private applyHistorySnapshot(step: DesignerHistoryStep) {
    // 1. Restore stamped features
    this.terrain.stampedFeatures = step.stampedFeatures.map(f => ({
      ...f,
      doglegPoints: f.doglegPoints ? f.doglegPoints.map(p => ({ ...p })) : undefined
    }));

    // 2. Restore sculpted pristine natural heights and base heights
    if (step.pristineHeights) {
      this.terrain.setPristineNaturalHeights(step.pristineHeights);
    }
    if (step.baseHeights && step.baseHeights.length === this.terrain.baseHeights.length) {
      this.terrain.baseHeights.set(step.baseHeights);
    }

    // 3. Rebuild all stamped features and mesh with full quality
    this.terrain.rebuildAllStampedFeatures(false);

    // 4. Update Havok physics collision and 1m grid
    if (this.terrain.terrainMesh) {
      this.havok.updateTerrainCollision(this.terrain.terrainMesh);
    }
    this.update1mGridMesh();

    // 5. Restore active hole state
    if (this.courseManager) {
      const activeHole = this.courseManager.getActiveHole();
      if (step.holeState) {
        activeHole.pinPosition.x = step.holeState.pinPos[0];
        activeHole.pinPosition.y = step.holeState.pinPos[1];
        activeHole.pinPosition.z = step.holeState.pinPos[2];
        activeHole.teePosition.x = step.holeState.teePos[0];
        activeHole.teePosition.y = step.holeState.teePos[1];
        activeHole.teePosition.z = step.holeState.teePos[2];
      }
      if (this.courseManager.activePinMesh) {
        this.courseManager.activePinMesh.position.set(activeHole.pinPosition.x, activeHole.pinPosition.y, activeHole.pinPosition.z);
      }
      if (this.courseManager.activeTeeMesh) {
        this.courseManager.activeTeeMesh.position.set(activeHole.teePosition.x, activeHole.teePosition.y, activeHole.teePosition.z);
        this.courseManager.activeTeeMesh.rotation.y = step.holeState.teeRotY;
      }
    }

    // 6. Restore scenery meshes positions/rotations/scales
    if (step.sceneryMeshes) {
      const sceneryMap = new Map<string, Mesh | InstancedMesh>();
      for (const m of this.courseManager.getSceneryMeshes()) {
        sceneryMap.set(m.name, m);
      }
      for (const sm of step.sceneryMeshes) {
        const mesh = sceneryMap.get(sm.name);
        if (mesh) {
          mesh.position.set(sm.pos[0], sm.pos[1], sm.pos[2]);
          mesh.rotation.set(sm.rot[0], sm.rot[1], sm.rot[2]);
          mesh.scaling.set(sm.scale[0], sm.scale[1], sm.scale[2]);
        }
      }
    }

    // 7. Restore green visualizer slope grid
    this.greenVisualizer.rebuildSlopeGrid();

    // 8. Restore selection
    if (step.selectedFeatureIndex >= 0 && step.selectedFeatureIndex < this.terrain.stampedFeatures.length) {
      this.selectCourseFeature(step.selectedFeatureIndex);
    } else {
      this.selectCourseFeature(-1);
      this.selectMesh(null);
    }

    this.ui.updateFeatureList(this.terrain.stampedFeatures, this.selectedFeatureIndex);
    this.updateDevStats();
  }

  /**
   * 1m Grid Overlay that conforms to the sculpted terrain surface so it never cuts flat through bunkers
   */
  private update1mGridMesh() {
    if (!this.show1mGrid) return;
    if (!this.gridMesh) {
      this.gridMesh = new Mesh('gridOverlay', this.scene);
      this.gridMesh.isPickable = false;
      const mat = new StandardMaterial('gridMat', this.scene);
      mat.wireframe = true;
      mat.emissiveColor = new Color3(0.85, 0.95, 1.0);
      mat.disableLighting = true;
      mat.alpha = 0.16;
      this.gridMesh.material = mat;
    }

    const cols = this.terrain.cols;
    const rows = this.terrain.rows;
    const gridX = this.terrain.gridX;
    const gridZ = this.terrain.gridZ;
    const cellSize = this.terrain.cellSize;
    const totalVerts = cols * rows;
    const positions = new Float32Array(totalVerts * 3);
    const mask = this.terrain.courseBoundaryMask;

    for (let z = 0; z < rows; z++) {
      const wz = z * cellSize;
      for (let x = 0; x < cols; x++) {
        const idx = z * cols + x;
        positions[idx * 3] = x * cellSize;
        positions[idx * 3 + 1] = this.terrain.heights[idx] + 0.04;
        positions[idx * 3 + 2] = wz;
      }
    }

    let cellCount = 0;
    if (mask && mask.length === gridX * gridZ) {
      for (let i = 0; i < mask.length; i++) if (mask[i]) cellCount++;
    } else {
      cellCount = gridX * gridZ;
    }
    const indices = new Uint32Array(cellCount * 6);

    let iIdx = 0;
    for (let z = 0; z < gridZ; z++) {
      for (let x = 0; x < gridX; x++) {
        if (mask && mask.length === gridX * gridZ && mask[z * gridX + x] === 0) continue;
        const idx00 = z * cols + x;
        const idx10 = z * cols + (x + 1);
        const idx01 = (z + 1) * cols + x;
        const idx11 = (z + 1) * cols + (x + 1);
        indices[iIdx++] = idx00;
        indices[iIdx++] = idx01;
        indices[iIdx++] = idx10;
        indices[iIdx++] = idx10;
        indices[iIdx++] = idx01;
        indices[iIdx++] = idx11;
      }
    }

    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.applyToMesh(this.gridMesh, true);
  }

  private toggle1mGrid(): boolean {
    this.show1mGrid = !this.show1mGrid;
    if (this.show1mGrid) {
      this.update1mGridMesh();
      this.gridMesh?.setEnabled(true);
    } else {
      this.gridMesh?.setEnabled(false);
    }
    return this.show1mGrid;
  }

  private updateHUDDisplay() {
    if (!this.ui) return;
    const pin = this.courseManager.currentHole.pinPosition;
    const dx = pin.x - this.ball.position.x;
    const dz = pin.z - this.ball.position.z;
    const distToPin = Math.sqrt(dx * dx + dz * dz);

    this.ui.updateHUD(
      distToPin,
      this.ball.currentSurface,
      this.activeClub,
      this.courseManager.currentStrokes,
      this.courseManager.currentHole,
      this.swingEngine.windSpeedMps,
      this.swingEngine.windHeadingDeg
    );

    if (this.aimSystem) {
      const targetPos = this.aimSystem.targetPosition;
      const elevDiff = targetPos.y - this.ball.position.y;
      this.ui.updateAimStats(this.aimSystem.targetDistanceMeters, elevDiff);
    }

    this.ui.updateOverheadLayout({
      hole: this.courseManager.currentHole,
      ballPos: this.ball.position,
      pinPos: this.courseManager.currentHole.pinPosition,
      aimTargetPos: this.aimSystem ? this.aimSystem.targetPosition : undefined,
      aimAzimuthDeg: this.currentAimAzimuth,
      features: this.terrain.stampedFeatures,
      club: this.activeClub,
      terrainWidth: this.terrain.width,
      terrainLength: this.terrain.length,
      strokes: this.courseManager.currentStrokes
    });

    const hole = this.courseManager.currentHole;
    const tee = hole.teePosition;
    const teeDx = pin.x - tee.x;
    const teeDz = pin.z - tee.z;
    this.ui.updateCourseGuideTelemetry({
      activeHoleNum: hole.number,
      isDemoHole: Boolean(hole.isDemo),
      teeToPinMeters: Math.sqrt(teeDx * teeDx + teeDz * teeDz),
      ballToPinMeters: distToPin,
      elevDeltaMeters: pin.y - this.ball.position.y
    });
  }

  private updateBrushVisualizerConfig() {
    if (!this.brushVisualizer) return;
    const presetDims = this.activePreset ? { width: this.activePreset.width, length: this.activePreset.length } : undefined;
    this.brushVisualizer.setConfig(
      this.activeDesignerTool,
      this.activeSculptMode,
      this.brushRadius,
      presetDims
    );
  }

  private setupPointerInteractions() {
    // Backspin mouse-wheel listener:
    // Captures backwards scroll (wheel down towards user: deltaY > 0)
    // When ball is in flight/rolling and eligible for backspin, registers impulse
    window.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        if (
          this.activeMode === 'play' &&
          this.ball &&
          (this.ball.state === BallState.IN_FLIGHT || this.ball.state === BallState.ROLLING) &&
          this.ball.isBackspinEligible &&
          e.deltaY > 0
        ) {
          const registered = this.ball.registerScrollImpulse(e.deltaY);
          if (registered || this.ball.backspinWindowActive) {
            e.preventDefault();
            e.stopPropagation();
          }
        }
      },
      { passive: false }
    );

    this.scene.onPointerObservable.add((pointerInfo) => {
      // Guard: Never perform 3D scene picking or designer interactions when interacting with HTML UI (dock, panels, dialogs)
      const evtTarget = pointerInfo.event?.target as HTMLElement | null;
      if (evtTarget && evtTarget !== this.canvas) {
        if (pointerInfo.type === PointerEventTypes.POINTERDOWN || pointerInfo.type === PointerEventTypes.POINTERUP) {
          this.isPointerDownInDesigner = false;
        }
        return;
      }

      if (this.activeMode === 'designer') {
        const pickTerrainPt = () => {
          const p = this.scene.pick(
            this.scene.pointerX,
            this.scene.pointerY,
            (m) => m.name === 'GolfTerrain'
          );
          return p && p.hit && p.pickedPoint
            ? { x: p.pickedPoint.x, y: p.pickedPoint.y, z: p.pickedPoint.z }
            : null;
        };

        if (pointerInfo.type === PointerEventTypes.POINTERDOUBLETAP) {
          if (this.featureTracer?.getMode() === 'spline') {
            this.featureTracer.finishTrace();
            return;
          }
        }

        if (pointerInfo.type === PointerEventTypes.POINTERMOVE) {
          if (this.featureTracer && (this.featureTracer.getMode() !== 'off' || this.featureTracer.isBusyDragging())) {
            const consumedMove = this.featureTracer.handlePointerMove(pickTerrainPt());
            this.brushVisualizer.setVisible(false);
            if (consumedMove || this.featureTracer.getMode() !== 'off') return;
          }
          if (
            this.activeDesignerTool === 'erase' ||
            this.activeDesignerTool === 'select' ||
            (this.cameraCtrl.isUserDragging && !(pointerInfo.event.shiftKey && this.activeDesignerTool === 'sculpt'))
          ) {
            this.brushVisualizer.setVisible(false);
          } else {
            const pick = this.scene.pick(
              this.scene.pointerX,
              this.scene.pointerY,
              (m) => m.name === 'GolfTerrain'
            );
            if (pick && pick.hit && pick.pickedPoint) {
              this.brushVisualizer.setVisible(true);
              this.brushVisualizer.updatePosition(pick.pickedPoint);

              // Continuous brush sculpting when holding Shift + dragging on terrain in sculpt mode
              if (this.isPointerDownInDesigner && pointerInfo.event.shiftKey && this.activeDesignerTool === 'sculpt') {
                this.handleDesignerActionAtPoint(pick.pickedPoint);
              }
            } else {
              this.brushVisualizer.setVisible(false);
            }
          }
        } else if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
          if (pointerInfo.event.button === 0 && this.featureTracer && (this.featureTracer.getMode() !== 'off' || this.activeDesignerTool === 'select')) {
            if (this.featureTracer.handlePointerDown(pointerInfo.event as PointerEvent, pickTerrainPt())) {
              if (this.featureTracer.isBusyDragging() && !this.wasCameraDetachedForTrace) {
                this.cameraCtrl.camera.detachControl();
                this.wasCameraDetachedForTrace = true;
              }
              return;
            }
          }
          // Holding down LMB (0) orbits, MMB (1) pans, and RMB (2) pans & zooms.
          // A clean click without dragging (< 5px) selects, sculpts, or places!
          if (pointerInfo.event.button === 0 || pointerInfo.event.button === 2) {
            this.isPointerDownInDesigner = true;
            this.pointerDownX = pointerInfo.event.clientX;
            this.pointerDownY = pointerInfo.event.clientY;
          }
        } else if (pointerInfo.type === PointerEventTypes.POINTERUP) {
          if (this.wasCameraDetachedForTrace) {
            this.cameraCtrl.camera.attachControl(this.canvas, false, false);
            this.wasCameraDetachedForTrace = false;
          }
          if (this.featureTracer?.handlePointerUp()) {
            this.isPointerDownInDesigner = false;
            return;
          }
          if (this.isPointerDownInDesigner && (pointerInfo.event.button === 0 || pointerInfo.event.button === 2)) {
            this.isPointerDownInDesigner = false;

            // Check if clicking or dragging a transform gizmo - if so, ignore click selection!
            if (this.isGizmoDragging || (this.gizmoManager && this.gizmoManager.isDragging)) return;

            const dragDist = Math.hypot(
              pointerInfo.event.clientX - this.pointerDownX,
              pointerInfo.event.clientY - this.pointerDownY
            );
            if (dragDist < 12.0) {
              // 1. SELECT MODE [V]: Left click selects object/mesh for Move [G], Rotate [R], Scale [S]; clicking ground selects ground layer
              if (this.activeDesignerTool === 'select') {
                const pickScenery = this.scene.pick(
                  this.scene.pointerX,
                  this.scene.pointerY,
                  (m) => this.isModelOrSceneryPickable(m)
                );
                if (pickScenery && pickScenery.hit && pickScenery.pickedMesh) {
                  const picked = pickScenery.pickedMesh;
                  const resolved = this.resolvePickedModelAndSubIdx(picked);
                  if (resolved) {
                    this.selectMesh(resolved.rootMesh, resolved.subMatIdx);
                    return;
                  }

                  const featureIdx = this.findFeatureForNode(picked);
                  if (featureIdx >= 0) {
                    this.selectCourseFeature(featureIdx);
                    return;
                  }

                  const sceneryObj = this.findSceneryObjectForMesh(picked);
                  if (sceneryObj) {
                    const featIdx = this.findFeatureForNode(sceneryObj);
                    if (featIdx >= 0) {
                      this.selectCourseFeature(featIdx);
                    } else {
                      this.selectMesh(sceneryObj);
                    }
                    return;
                  }
                }

                // 2. Terrain ground raycast: Fairway, Green, Bunkers, Tee, Water
                const pickGround = this.scene.pick(
                  this.scene.pointerX,
                  this.scene.pointerY,
                  (m) => m === this.terrain.terrainMesh
                );
                if (pickGround && pickGround.hit && pickGround.pickedPoint) {
                  const hitFeat = this.terrain.findFeatureAt(pickGround.pickedPoint.x, pickGround.pickedPoint.z);
                  if (hitFeat) {
                    this.selectCourseFeature(hitFeat.index);
                  } else {
                    // Clicked main ground (rough/terrain outside features): select Main Ground material & textures!
                    this.selectGroundLayer();
                  }
                } else {
                  // Clicked in empty space / sky: cleanly DESELECT features/objects!
                  this.selectCourseFeature(-1);
                  this.selectMesh(null);
                }
                return;
              }

              // 2. ERASE MODE [X]: Left click deletes clicked scenery object immediately
              if (this.activeDesignerTool === 'erase') {
                const pick = this.scene.pick(
                  this.scene.pointerX,
                  this.scene.pointerY,
                  (m) => this.isPickableSceneryMesh(m)
                );
                if (pick && pick.hit && pick.pickedMesh) {
                  this.deleteSceneryObject(pick.pickedMesh as Mesh);
                }
                return;
              }

              // 3. SCULPT MODE [B]: Left click sculpts terrain at the brush cursor
              if (this.activeDesignerTool === 'sculpt') {
                const pick = this.scene.pick(
                  this.scene.pointerX,
                  this.scene.pointerY,
                  (m) => m.name === 'GolfTerrain'
                );
                if (pick && pick.hit && pick.pickedPoint) {
                  this.handleDesignerActionAtPoint(pick.pickedPoint);
                }
                return;
              }

              // 4. ADD OBJECT / PRESETS MODE [A]: Left click stamps scenery prop or surface feature
              if (this.activeDesignerTool === 'stamp') {
                const pick = this.scene.pick(
                  this.scene.pointerX,
                  this.scene.pointerY,
                  (m) => m.name === 'GolfTerrain'
                );
                if (pick && pick.hit && pick.pickedPoint) {
                  this.handleDesignerActionAtPoint(pick.pickedPoint);
                }
                return;
              }

              // 5. SET TEE / SET PIN
              if (this.activeDesignerTool === 'set_tee' || this.activeDesignerTool === 'set_pin') {
                const pick = this.scene.pick(
                  this.scene.pointerX,
                  this.scene.pointerY,
                  (m) => m.name === 'GolfTerrain'
                );
                if (pick && pick.hit && pick.pickedPoint) {
                  this.handleDesignerActionAtPoint(pick.pickedPoint);
                }
                return;
              }
            }
          }
        }
      } else {
        if (this.brushVisualizer?.isVisible) {
          this.brushVisualizer.setVisible(false);
        }
      }
    });
  }

  private handleDesignerActionAtPoint(pickedPoint: Vector3) {
    const gx = Math.round(pickedPoint.x);
    const gz = Math.round(pickedPoint.z);

    if (this.activeDesignerTool === 'sculpt') {
      const snap = this.captureHistorySnapshot('Sculpt Terrain');
      this.terrain.applySculptBrush(
        gx,
        gz,
        this.brushRadius,
        this.brushStrength,
        this.activeSculptMode,
        this.targetSurface
      );
      this.havok.updateTerrainCollision(this.terrain.terrainMesh!);
      this.greenVisualizer.rebuildSlopeGrid();
      this.update1mGridMesh();
      this.recordHistoryStep('Sculpt Terrain', snap);

    } else if (this.activeDesignerTool === 'stamp') {
      if (!this.activePreset) return;
      const snap = this.captureHistorySnapshot('Stamp ' + (this.activePreset.name || 'Object'));

      const p = this.activePreset;
      if (p.category === 'scenery') {
        const gy = this.terrain.getElevation(gx, gz);
        let createdMesh: Mesh | InstancedMesh | null = null;
        if (p.sceneryType === 'pine') createdMesh = this.scenery.createPineTree(gx, gy, gz);
        else if (p.sceneryType === 'hero_tree') createdMesh = this.scenery.createHeroTree(gx, gy, gz);
        else if (p.sceneryType === 'woodland_tree') createdMesh = this.scenery.createWoodlandTree(gx, gy, gz);
        else if (p.sceneryType === 'oak') createdMesh = this.scenery.createOakTree(gx, gy, gz);
        else if (p.sceneryType === 'rock_cluster') createdMesh = this.scenery.createRockCluster(gx, gy, gz);
        else if (p.sceneryType === 'dam_wall') createdMesh = this.scenery.createDamWall(gx, gy, gz, p.width, 4);

        if (createdMesh) {
          this.courseManager.addSceneryMesh(createdMesh);
          this.registerSceneryShadows();
          if (createdMesh instanceof Mesh || createdMesh instanceof InstancedMesh) {
            this.selectMesh(createdMesh);
          }
          this.refreshOutliner();
          this.updateDevStats();
        }
      } else {
        this.terrain.stampFeature(
          gx,
          gz,
          p.width,
          p.length,
          0,
          p.surfaceType,
          p.depthProfile ?? (p.surfaceType === SurfaceType.WATER ? -2.2 : 0),
          p.lipHeight ?? 0,
          undefined,
          p.bunkerShapeIndex,
          true,
          p.id
        );

        const newIdx = this.terrain.stampedFeatures.length - 1;
        const newFeat = this.terrain.stampedFeatures[newIdx];
        if (newFeat && p.name && (!newFeat.name || newFeat.name.startsWith('Feature'))) {
          const sameCount = this.terrain.stampedFeatures.filter(f => f.surfaceType === p.surfaceType).length;
          newFeat.name = `${p.name} #${sameCount}`;
        }

        if (p.surfaceType === SurfaceType.WATER) {
          this.courseManager?.refreshWaterMeshes();
        } else if (p.surfaceType === SurfaceType.TEE && newFeat) {
          this.courseManager?.ensureTeeMarkersForFeature(newFeat);
          if (this.courseManager) {
            this.courseManager.currentStrokes = 0;
            this.courseManager.currentPutts = 0;
            this.placeBallAtActiveTee();
          }
        } else if (p.surfaceType === SurfaceType.GREEN && newFeat) {
          this.courseManager?.ensurePinForGreenFeature(newFeat);
          this.ball?.setTargetPin(this.courseManager.currentHole.pinPosition);
          this.greenVisualizer.rebuildSlopeGrid();
        }

        this.havok.updateTerrainCollision(this.terrain.terrainMesh!);
        if (this.courseManager) {
          this.courseManager.refreshSceneryForFeatures();
        }
        this.update1mGridMesh();
        this.registerSceneryShadows();
        if (newIdx >= 0) {
          this.selectCourseFeature(newIdx);
          this.ui.updateFeatureList(this.terrain.stampedFeatures, newIdx);
        }
        this.refreshOutliner();
        this.updateHUDDisplay();
        this.updateDevStats();
      }
      this.recordHistoryStep('Stamp ' + (p.name || 'Object'), snap);

    } else if (this.activeDesignerTool === 'set_tee') {
      const snap = this.captureHistorySnapshot('Move Tee Position');
      const hole = this.courseManager.currentHole;

      // Auto-snap to center of Tee Box feature if clicking on or near one
      const teeFeat = this.terrain.stampedFeatures.find(f => {
        if (f.surfaceType !== SurfaceType.TEE) return false;
        const dx = gx - f.centerX;
        const dz = gz - f.centerZ;
        return Math.hypot(dx, dz) <= Math.max(f.width, f.length) * 0.75;
      });

      if (teeFeat) {
        hole.teePosition.x = teeFeat.centerX;
        hole.teePosition.z = teeFeat.centerZ;
        this.ui.showToast('⛳ Snapped Tee & Ball to Center of Tee Box!', 'success', 2500);
      } else {
        hole.teePosition.x = gx;
        hole.teePosition.z = gz;
      }

      this.courseManager.setupHoleVisuals();
      this.registerSceneryShadows();
      this.placeBallAtActiveTee();
      this.updateHUDDisplay();
      this.recordHistoryStep('Move Tee Position', snap);

    } else if (this.activeDesignerTool === 'set_pin') {
      const snap = this.captureHistorySnapshot('Move Pin Position');
      const hole = this.courseManager.currentHole;

      // Auto-snap to center of Green feature if clicking on or near one
      const greenFeat = this.terrain.stampedFeatures.find(f => {
        if (f.surfaceType !== SurfaceType.GREEN) return false;
        const dx = gx - f.centerX;
        const dz = gz - f.centerZ;
        return Math.hypot(dx, dz) <= Math.max(f.width, f.length) * 0.75;
      });

      if (greenFeat) {
        hole.pinPosition.x = greenFeat.centerX;
        hole.pinPosition.z = greenFeat.centerZ;
        this.ui.showToast('🚩 Snapped Pin to Center of Green!', 'success', 2500);
      } else {
        hole.pinPosition.x = gx;
        hole.pinPosition.z = gz;
      }

      this.courseManager.setupHoleVisuals();
      this.ball.setTargetPin(hole.pinPosition);
      if (this.greenVisualizer) this.greenVisualizer.rebuildSlopeGrid();
      this.registerSceneryShadows();
      this.updateHUDDisplay();
      this.recordHistoryStep('Move Pin Position', snap);
    }
  }

  private handleGizmoDragStart = () => {
    this.isGizmoDragging = true;
    if (this.selectedFeatureIndex >= 0 && this.featureGizmoProxy && this.selectedMesh === this.featureGizmoProxy) {
      const feat = this.terrain.stampedFeatures[this.selectedFeatureIndex];
      this.pendingHistorySnapshot = this.captureHistorySnapshot('Transform ' + (feat?.name || feat?.surfaceType || 'Feature'));
    } else if (this.selectedMesh) {
      this.pendingHistorySnapshot = this.captureHistorySnapshot('Transform ' + (this.selectedMesh.name || 'Object'));
    }
  };

  private handleGizmoDrag = () => {
    this.isGizmoDragging = true;
    if (this.selectedFeatureIndex >= 0 && this.featureGizmoProxy && this.selectedMesh === this.featureGizmoProxy) {
      this.featureGizmoProxy.position.y = this.terrain.getElevation(this.featureGizmoProxy.position.x, this.featureGizmoProxy.position.z) + 0.12;
      if (!this.gizmoRaf) {
        this.gizmoRaf = requestAnimationFrame(() => {
          this.gizmoRaf = null;
          this.applyFeatureGizmoTransform(true);
        });
      }
    }
  };

  private runWithTerraformingLoader(task: () => void, label = 'Conforming 3D Terrain & Analytical Collars...') {
    if (!this.ui) {
      task();
      return;
    }
    this.ui.showTerraformingLoader(label);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          task();
        } finally {
          void this.ui.completeTerraformingLoader();
        }
      });
    });
  }

  private handleGizmoDragEnd = () => {
    if (this.gizmoRaf) {
      cancelAnimationFrame(this.gizmoRaf);
      this.gizmoRaf = null;
    }
    setTimeout(() => {
      this.isGizmoDragging = false;
    }, 80);

    if (this.selectedFeatureIndex >= 0 && this.featureGizmoProxy && this.selectedMesh === this.featureGizmoProxy) {
      this.featureGizmoProxy.position.y = this.terrain.getElevation(this.featureGizmoProxy.position.x, this.featureGizmoProxy.position.z) + 0.12;
      this.runWithTerraformingLoader(() => {
        if (this.selectedFeatureIndex >= 0 && this.featureGizmoProxy && this.selectedMesh === this.featureGizmoProxy) {
          this.featureGizmoProxy.position.y = this.terrain.getElevation(this.featureGizmoProxy.position.x, this.featureGizmoProxy.position.z) + 0.12;
          this.applyFeatureGizmoTransform(false);
        }
        if (this.pendingHistorySnapshot) {
          this.recordHistoryStep(this.pendingHistorySnapshot.description, this.pendingHistorySnapshot);
          this.pendingHistorySnapshot = null;
        }
      });
    } else if (this.selectedMesh) {
      if (this.selectedMesh === this.courseManager.activeTeeMesh) {
        const p = this.selectedMesh.position;
        // Verify and constrain tee to stay on the Tee Box deck
        const teeFeatures = this.terrain.stampedFeatures.filter(
          f => f.surfaceType === SurfaceType.TEE || (f.surfaceType as any) === 'tee' || (f.surfaceType as any) === 'TEE'
        );
        if (teeFeatures.length > 0) {
          let bestTee = teeFeatures[0];
          let minDist = Infinity;
          for (const tf of teeFeatures) {
            const d = Math.hypot(p.x - tf.centerX, p.z - tf.centerZ);
            if (d < minDist) {
              minDist = d;
              bestTee = tf;
            }
          }
          const maxRadius = Math.min(bestTee.width, bestTee.length) * 0.45;
          const distToCenter = Math.hypot(p.x - bestTee.centerX, p.z - bestTee.centerZ);
          const surf = this.terrain.getSurfaceAt(p.x, p.z);
          if (distToCenter > maxRadius || surf !== SurfaceType.TEE) {
            p.x = bestTee.centerX;
            p.z = bestTee.centerZ;
            this.selectedMesh.position.x = p.x;
            this.selectedMesh.position.z = p.z;
            this.ui.showToast('⛳ Snapped Tee to Center of Tee Box deck!', 'info', 2200);
          }
        }
        const groundY = this.terrain.getElevation(p.x, p.z);
        this.selectedMesh.position.y = groundY;
        // Lock tee marker group rotation to clean flat Y-axis yaw around its central pivot
        // so individual ducks never tilt or change orientation relative to the group.
        let teeYaw = this.selectedMesh.rotation.y;
        if (this.selectedMesh.rotationQuaternion) {
          teeYaw = this.selectedMesh.rotationQuaternion.toEulerAngles().y;
          this.selectedMesh.rotationQuaternion = null;
        }
        this.selectedMesh.rotation.set(0, teeYaw, 0);
        this.currentAimAzimuth = (teeYaw * 180) / Math.PI;
        this.swingEngine.aimAzimuthDeg = this.currentAimAzimuth;
        this.courseManager.currentHole.teePosition.x = p.x;
        this.courseManager.currentHole.teePosition.y = groundY;
        this.courseManager.currentHole.teePosition.z = p.z;
        if (this.ball) {
          this.ball.setPosition(p.x, groundY + GOLF_CONSTANTS.BALL_RENDER_RADIUS, p.z);
        }
        this.updateHUDDisplay();
      } else if (this.selectedMesh === this.courseManager.activePinMesh) {
        const p = this.selectedMesh.position;
        // Verify and constrain pin to stay on the putting green surface
        const greenFeatures = this.terrain.stampedFeatures.filter(
          f => f.surfaceType === SurfaceType.GREEN || (f.surfaceType as any) === 'green' || (f.surfaceType as any) === 'GREEN'
        );
        if (greenFeatures.length > 0) {
          let bestGreen = greenFeatures[0];
          let minDist = Infinity;
          for (const gf of greenFeatures) {
            const d = Math.hypot(p.x - gf.centerX, p.z - gf.centerZ);
            if (d < minDist) {
              minDist = d;
              bestGreen = gf;
            }
          }
          const maxRadius = Math.min(bestGreen.width, bestGreen.length) * 0.45;
          const distToCenter = Math.hypot(p.x - bestGreen.centerX, p.z - bestGreen.centerZ);
          const surf = this.terrain.getSurfaceAt(p.x, p.z);
          if (distToCenter > maxRadius || (surf !== SurfaceType.GREEN && surf !== SurfaceType.FRINGE)) {
            if (distToCenter > maxRadius) {
              const ang = Math.atan2(p.z - bestGreen.centerZ, p.x - bestGreen.centerX);
              p.x = bestGreen.centerX + Math.cos(ang) * maxRadius;
              p.z = bestGreen.centerZ + Math.sin(ang) * maxRadius;
            } else {
              p.x = bestGreen.centerX;
              p.z = bestGreen.centerZ;
            }
            this.selectedMesh.position.x = p.x;
            this.selectedMesh.position.z = p.z;
            this.ui.showToast('🚩 Kept Pin within the Putting Green boundary!', 'info', 2200);
          }
        }
        const groundY = this.terrain.getElevation(p.x, p.z);
        this.selectedMesh.position.y = groundY;
        this.courseManager.currentHole.pinPosition.x = p.x;
        this.courseManager.currentHole.pinPosition.y = groundY;
        this.courseManager.currentHole.pinPosition.z = p.z;
        if (this.ball) {
          this.ball.setTargetPin(this.courseManager.currentHole.pinPosition);
        }
        this.updateHUDDisplay();
      }

      this.scenery.syncColliders();
      this.ball.setTreeColliders(this.scenery.treeColliders);
      this.ui.updateDevSelectedObject(this.selectedMesh);
      if (this.pendingHistorySnapshot) {
        this.recordHistoryStep(this.pendingHistorySnapshot.description, this.pendingHistorySnapshot);
        this.pendingHistorySnapshot = null;
      }
    }
  };

  private hookBehavior(target: any) {
    if (!target || this.hookedGizmoBehaviors.has(target)) return;
    this.hookedGizmoBehaviors.add(target);
    if (target.onDragStartObservable) {
      target.onDragStartObservable.add(this.handleGizmoDragStart);
    }
    if (target.onDragObservable) {
      target.onDragObservable.add(this.handleGizmoDrag);
    }
    if (target.onDragEndObservable) {
      target.onDragEndObservable.add(this.handleGizmoDragEnd);
    }
  }

  private hookGizmoListeners() {
    if (!this.gizmoManager || !this.gizmoManager.gizmos) return;

    const posGizmo = this.gizmoManager.gizmos.positionGizmo;
    if (posGizmo) {
      posGizmo.planarGizmoEnabled = true;
      this.hookBehavior(posGizmo);
      const subGizmos = [
        posGizmo.xGizmo,
        posGizmo.yGizmo,
        posGizmo.zGizmo,
        posGizmo.xPlaneGizmo,
        posGizmo.yPlaneGizmo,
        posGizmo.zPlaneGizmo
      ];
      for (const sg of subGizmos) {
        if (sg) {
          this.hookBehavior(sg);
          if (sg.dragBehavior) {
            this.hookBehavior(sg.dragBehavior);
          }
        }
      }
    }

    const rotGizmo = this.gizmoManager.gizmos.rotationGizmo;
    if (rotGizmo) {
      this.hookBehavior(rotGizmo);
      const rotSubGizmos = [rotGizmo.xGizmo, rotGizmo.yGizmo, rotGizmo.zGizmo];
      for (const rg of rotSubGizmos) {
        if (rg) {
          this.hookBehavior(rg);
          if (rg.dragBehavior) {
            this.hookBehavior(rg.dragBehavior);
          }
        }
      }
    }

    const scaleGizmo = this.gizmoManager.gizmos.scaleGizmo;
    if (scaleGizmo) {
      this.hookBehavior(scaleGizmo);
      const scaleSubGizmos = [scaleGizmo.xGizmo, scaleGizmo.yGizmo, scaleGizmo.zGizmo, (scaleGizmo as any).uniformScaleGizmo, (scaleGizmo as any).uniformGizmo];
      for (const sg of scaleSubGizmos) {
        if (sg) {
          this.hookBehavior(sg);
          if (sg.dragBehavior) {
            this.hookBehavior(sg.dragBehavior);
          }
        }
      }
    }
  }

  private setupGizmoManager() {
    this.gizmoManager = new GizmoManager(this.scene);
    this.gizmoManager.usePointerToAttachGizmos = false;
    this.gizmoManager.boundingBoxGizmoEnabled = false;

    this.gizmoManager.onAttachedToMeshObservable.add(() => {
      this.hookGizmoListeners();
    });

    // Reset initial state to none
    this.gizmoManager.positionGizmoEnabled = false;
    this.gizmoManager.rotationGizmoEnabled = false;
    this.gizmoManager.scaleGizmoEnabled = false;
  }

  private setGizmoMode(mode: 'none' | 'position' | 'rotation' | 'scale') {
    this.activeGizmoMode = mode;
    if (!this.gizmoManager) this.setupGizmoManager();
    this.gizmoManager.positionGizmoEnabled = (mode === 'position');
    this.gizmoManager.rotationGizmoEnabled = (mode === 'rotation');
    this.gizmoManager.scaleGizmoEnabled = (mode === 'scale');

    this.hookGizmoListeners();

    if (this.selectedMesh && mode !== 'none') {
      this.gizmoManager.attachToMesh(this.selectedMesh);
    } else {
      this.gizmoManager.attachToMesh(null);
    }
    this.ui.setGizmoModeButton(mode);
  }

  private updateGroundSelectionOutline(visible: boolean) {
    if (this.groundSelectionOutline) {
      this.groundSelectionOutline.dispose();
      this.groundSelectionOutline = null;
    }
    if (!visible || this.activeMode !== 'designer' || !this.terrain) return;
    const w = this.terrain.width;
    const l = this.terrain.length;
    const step = Math.max(8, Math.round(Math.max(w, l) / 48));
    const pts: Vector3[] = [];
    for (let x = 0; x <= w; x += step) {
      pts.push(new Vector3(x, this.terrain.getElevation(x, 0) + 0.16, 0));
    }
    if (pts[pts.length - 1].x < w) pts.push(new Vector3(w, this.terrain.getElevation(w, 0) + 0.16, 0));
    for (let z = step; z <= l; z += step) {
      pts.push(new Vector3(w, this.terrain.getElevation(w, z) + 0.16, z));
    }
    if (pts[pts.length - 1].z < l) pts.push(new Vector3(w, this.terrain.getElevation(w, l) + 0.16, l));
    for (let x = w - step; x >= 0; x -= step) {
      pts.push(new Vector3(x, this.terrain.getElevation(x, l) + 0.16, l));
    }
    if (pts[pts.length - 1].x > 0) pts.push(new Vector3(0, this.terrain.getElevation(0, l) + 0.16, l));
    for (let z = l - step; z >= 0; z -= step) {
      pts.push(new Vector3(0, this.terrain.getElevation(0, z) + 0.16, z));
    }
    pts.push(pts[0].clone());
    const lines = MeshBuilder.CreateLines('groundSelectionOutline', { points: pts }, this.scene);
    lines.color = new Color3(0.32, 0.72, 1.0);
    lines.alpha = 0.58;
    lines.isPickable = false;
    this.groundSelectionOutline = lines;
  }

  private updateObjectSelectionOutline(mesh: (Mesh | InstancedMesh) | null) {
    if (this.objectSelectionOutline) {
      this.objectSelectionOutline.dispose();
      this.objectSelectionOutline = null;
    }
    if (!mesh || mesh.isDisposed() || mesh === this.featureGizmoProxy || this.activeMode !== 'designer') return;
    mesh.computeWorldMatrix(true);
    let min: Vector3;
    let max: Vector3;
    if (mesh.getChildMeshes && mesh.getChildMeshes().length > 0 && typeof mesh.getHierarchyBoundingVectors === 'function') {
      const b = mesh.getHierarchyBoundingVectors(true);
      min = b.min.clone();
      max = b.max.clone();
    } else {
      mesh.refreshBoundingInfo({});
      const bb = mesh.getBoundingInfo().boundingBox;
      min = bb.minimumWorld.clone();
      max = bb.maximumWorld.clone();
    }
    if (!Number.isFinite(min.x) || !Number.isFinite(max.x) || min.equals(max)) return;
    const pad = 0.08;
    const x0 = min.x - pad, y0 = min.y - pad, z0 = min.z - pad;
    const x1 = max.x + pad, y1 = max.y + pad, z1 = max.z + pad;
    const segs: Vector3[][] = [
      [new Vector3(x0, y0, z0), new Vector3(x1, y0, z0), new Vector3(x1, y0, z1), new Vector3(x0, y0, z1), new Vector3(x0, y0, z0)],
      [new Vector3(x0, y1, z0), new Vector3(x1, y1, z0), new Vector3(x1, y1, z1), new Vector3(x0, y1, z1), new Vector3(x0, y1, z0)],
      [new Vector3(x0, y0, z0), new Vector3(x0, y1, z0)],
      [new Vector3(x1, y0, z0), new Vector3(x1, y1, z0)],
      [new Vector3(x1, y0, z1), new Vector3(x1, y1, z1)],
      [new Vector3(x0, y0, z1), new Vector3(x0, y1, z1)]
    ];
    const boxLines = MeshBuilder.CreateLineSystem('objectSelectionOutline', { lines: segs }, this.scene);
    boxLines.color = new Color3(0.35, 0.76, 1.0);
    boxLines.alpha = 0.62;
    boxLines.isPickable = false;
    this.objectSelectionOutline = boxLines;
  }

  private selectGroundLayer() {
    this.selectCourseFeature(-1);
    this.selectMesh(null);
    this.updateGroundSelectionOutline(true);
    this.ui.showGroundPbrInspector(this.terrain.getGroundUvSettings(), true);
    this.updateDevStats();
    this.ui.showToast('Selected Main Ground — edit material & textures in Developer Zone 🌱', 'info', 1800);
  }

  private executeBallDropAnimation(dropX: number, dropGroundY: number, dropZ: number, finalRestY: number) {
    const dropHeight = 1.85;
    const startY = dropGroundY + dropHeight;
    this.ball.setPosition(dropX, startY, dropZ);

    if (this.activeMode === 'play') {
      this.cameraCtrl.setMode('aim');
      this.cameraCtrl.camera.target.set(dropX, dropGroundY + 0.45, dropZ);
    }

    let currentY = startY;
    let velY = 0;
    const gravity = -20.0;
    let bounces = 0;

    const dropObserver = this.scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.033, this.scene.getEngine().getDeltaTime() / 1000);
      velY += gravity * dt;
      currentY += velY * dt;

      if (currentY <= finalRestY) {
        currentY = finalRestY;
        bounces++;
        soundFx.playBounce('rough', 0.6);

        if (bounces === 1) {
          velY = 2.4;
        } else if (bounces === 2) {
          velY = 0.8;
        } else {
          this.scene.onBeforeRenderObservable.remove(dropObserver);
          this.ball.setPosition(dropX, finalRestY, dropZ);
          this.cameraCtrl.snapAimBehindBall(this.ball.position, this.currentAimAzimuth);
          this.ui.setSwingEnabled(true);
          if (this.aimSystem) {
            this.aimSystem.setVisible(true);
            this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
          }
          this.updateHUDDisplay();
          return;
        }
      }

      this.ball.setPosition(dropX, currentY, dropZ);
    });
  }

  private selectMesh(mesh: (Mesh | InstancedMesh) | null, initialSubMatIdx: number = 0) {
    if (mesh !== this.selectedMesh) {
      this.selectedObjectSubMatIdx = initialSubMatIdx;
    } else if (initialSubMatIdx > 0) {
      this.selectedObjectSubMatIdx = initialSubMatIdx;
    }
    this.selectedMesh = mesh;
    if (!this.gizmoManager) this.setupGizmoManager();
    this.hookGizmoListeners();
    if (mesh && this.activeGizmoMode !== 'none') {
      this.gizmoManager.attachToMesh(mesh);
    } else if (mesh && this.activeGizmoMode === 'none') {
      this.setGizmoMode('position');
      this.gizmoManager.attachToMesh(mesh);
    } else {
      this.gizmoManager.attachToMesh(null);
    }
    this.ui.updateDevSelectedObject(mesh, this.canDeleteMesh(mesh), mesh === this.featureGizmoProxy);
    this.ui.updateDevObjectList(
      this.getSelectable3DModels().map(m => ({ id: m.id, label: m.label })),
      mesh && mesh !== this.featureGizmoProxy ? mesh.name : null
    );

    if (mesh && mesh !== this.featureGizmoProxy) {
      this.updateGroundSelectionOutline(false);
      this.terrain.setActiveFeatureSelection(-1, 'surface');
      const matInfo = this.getObjectMaterialInfo(mesh, this.selectedObjectSubMatIdx);
      this.ui.updateDevSelectedObjectMaterial(matInfo);
      this.ui.updateDevSelectedFeatureMaterial(null, null);
    } else if (!mesh && this.selectedFeatureIndex < 0) {
      this.terrain.setActiveFeatureSelection(-1, 'surface');
      this.ui.updateDevSelectedObjectMaterial(null);
      this.ui.updateDevSelectedFeatureMaterial(null, null);
    }

    this.updateObjectSelectionOutline(mesh && mesh !== this.featureGizmoProxy ? mesh : null);

    // Faint Thin Sky-Blue Selection Outline & Glow Layer
    if (this.selectionHighlightLayer) {
      this.selectionHighlightLayer.removeAllMeshes();
      const faintBlue = new Color3(0.28, 0.72, 1.0);
      if (mesh && mesh !== this.featureGizmoProxy) {
        if (this.featureDrapeMesh) {
          this.featureDrapeMesh.dispose();
          this.featureDrapeMesh = null;
          this.featureDrapePointCount = 0;
        }
        if (this.featureSurfaceFillMesh) {
          this.featureSurfaceFillMesh.dispose();
          this.featureSurfaceFillMesh = null;
        }
        if (this.featureGizmoProxy) {
          this.featureGizmoProxy.setEnabled(false);
        }
        this.selectedFeatureIndex = -1;
        this.ui.updateFeatureList(this.terrain.stampedFeatures, -1);
        if (mesh instanceof Mesh) {
          this.addMeshTreeToHighlight(mesh, faintBlue);
        }
      }
      if (mesh && mesh === this.featureGizmoProxy) {
        try {
          this.selectionHighlightLayer.addMesh(mesh, faintBlue);
        } catch (e) {}
      }
    }
    this.updateDevStats();
  }

  public frameSelectedObject() {
    if (!this.selectedMesh) {
      this.ui.showToast('Select an object or course feature first to frame [F]', 'info', 2000);
      return;
    }
    let targetPos = this.selectedMesh.getAbsolutePosition();
    let sphereRadius = this.selectedMesh.getBoundingInfo?.().boundingSphere.radiusWorld || 3.0;
    if (this.selectedMesh.getChildMeshes().length > 0 && typeof this.selectedMesh.getHierarchyBoundingVectors === 'function') {
      const bounds = this.selectedMesh.getHierarchyBoundingVectors(true);
      const size = bounds.max.subtract(bounds.min);
      const hierarchyRadius = size.length() * 0.5;
      if (hierarchyRadius > 0.05 && Number.isFinite(hierarchyRadius)) {
        targetPos = bounds.min.add(bounds.max).scale(0.5);
        sphereRadius = hierarchyRadius;
      }
    }
    const targetRadius = Math.max(3.5, Math.min(65, sphereRadius * 2.8));
    this.cameraCtrl.frameOnTarget(targetPos, targetRadius);
    this.ui.showToast(`🎯 Framed on ${this.selectedMesh.name} [F] — Orbiting around selection`, 'info', 2200);
  }

  public selectCourseFeature(index: number) {
    if (index < 0 || index >= this.terrain.stampedFeatures.length) {
      this.selectedFeatureIndex = -1;
      if (this.featureGizmoProxy) this.featureGizmoProxy.setEnabled(false);
      if (this.featureDrapeMesh) {
        this.featureDrapeMesh.dispose();
        this.featureDrapeMesh = null;
        this.featureDrapePointCount = 0;
      }
      if (this.featureSurfaceFillMesh) {
        this.featureSurfaceFillMesh.dispose();
        this.featureSurfaceFillMesh = null;
      }
      this.selectMesh(null);
      this.featureTracer?.syncSelectedFeatureNodes(-1);
      this.ui.updateFeatureList(this.terrain.stampedFeatures, -1);
      this.ui.updateDevSelectedFeatureMaterial(null, null);
      this.terrain.setGroundUvSettings(this.terrain.getGroundUvSettings());
      this.updateDevStats();
      return;
    }

    this.updateGroundSelectionOutline(false);
    this.updateObjectSelectionOutline(null);
    this.selectedFeatureIndex = index;
    const feat = this.terrain.stampedFeatures[index];

    if (!this.featureGizmoProxy) {
      this.featureGizmoProxy = MeshBuilder.CreateCylinder('courseFeatureProxy', { diameter: 2.4, height: 0.18 }, this.scene);
      this.featureGizmoProxy.isPickable = true;
      const mat = new StandardMaterial('featProxyMat', this.scene);
      mat.diffuseColor = new Color3(0.0, 0.85, 1.0);
      mat.emissiveColor = new Color3(0.0, 0.65, 1.0);
      mat.alpha = 0.65;
      this.featureGizmoProxy.material = mat;
    }
    this.featureGizmoProxy.isPickable = true;

    this.featureGizmoProxy.setEnabled(true);
    const elev = this.terrain.getElevation(feat.centerX, feat.centerZ);
    this.featureGizmoProxy.position.set(feat.centerX, elev + 0.15, feat.centerZ);
    this.featureGizmoProxy.rotation.y = feat.rotationRad;
    if (this.featureGizmoProxy.rotationQuaternion) {
      this.featureGizmoProxy.rotationQuaternion = Quaternion.RotationYawPitchRoll(feat.rotationRad, 0, 0);
    }
    this.featureGizmoProxy.name = feat.name || `${feat.surfaceType} Feature`;

    // 1. Build & update the terrain-conforming drape ribbon outline
    this.updateFeatureDrapeMesh(index);
    this.featureTracer?.syncSelectedFeatureNodes(index);

    // 2. Attach transform gizmo to central feature proxy
    this.selectMesh(this.featureGizmoProxy);

    // 3. Highlight all feature components together (drape, proxy, and attached objects)
    this.highlightFeatureComponents(index);

    this.ui.updateFeatureList(this.terrain.stampedFeatures, index);
    this.selectedFeatureSubMatId = 'surface';
    this.presentSelectedFeatureMaterial(index, 'surface');
    this.ui.updateDevSelectedObjectMaterial(null);
    this.ui.showToast(`Selected ${feat.name || feat.surfaceType} [All separate materials exposed]`, 'info', 2500);
  }

  public moveCourseFeature(index: number, newX: number, newZ: number, isLive = false) {
    if (index < 0 || index >= this.terrain.stampedFeatures.length) return;
    this.terrain.moveFeature(index, newX, newZ, isLive);
    this.syncFeatureSubsystems(index, isLive);
    this.updateFeatureDrapeMesh(index);
    this.highlightFeatureComponents(index);
  }

  public rotateCourseFeature(index: number, newRotRad: number, isLive = false) {
    if (index < 0 || index >= this.terrain.stampedFeatures.length) return;
    this.terrain.rotateFeature(index, newRotRad, isLive);
    this.syncFeatureSubsystems(index, isLive);
    this.updateFeatureDrapeMesh(index);
    this.highlightFeatureComponents(index);
  }

  private applyFeatureGizmoTransform(isLive = false) {
    if (this.selectedFeatureIndex < 0 || !this.featureGizmoProxy) return;
    const feat = this.terrain.stampedFeatures[this.selectedFeatureIndex];
    if (!feat) return;

    const newX = this.featureGizmoProxy.position.x;
    const newZ = this.featureGizmoProxy.position.z;
    let proxyYaw = this.featureGizmoProxy.rotation.y;
    if (this.featureGizmoProxy.rotationQuaternion) {
      proxyYaw = this.featureGizmoProxy.rotationQuaternion.toEulerAngles().y;
    }
    // TerrainGrid uses counter-clockwise +rotationRad (BabylonJS left-handed -Y yaw)
    const newRot = -proxyYaw;

    const sx = this.featureGizmoProxy.scaling.x;
    const sz = this.featureGizmoProxy.scaling.z;
    const scaleChanged = Math.abs(sx - 1.0) > 0.002 || Math.abs(sz - 1.0) > 0.002;
    const posChanged = Math.abs(newX - feat.centerX) > 0.001 || Math.abs(newZ - feat.centerZ) > 0.001;
    const rotChanged = Math.abs(newRot - feat.rotationRad) > 0.001;

    if (!posChanged && !rotChanged && !scaleChanged && isLive) return;

    if (scaleChanged) {
      const targetW = Math.max(2.0, Math.min(260.0, feat.width * Math.max(0.2, sx)));
      const targetL = Math.max(2.0, Math.min(380.0, feat.length * Math.max(0.2, sz)));
      this.featureGizmoProxy.scaling.set(1, 1, 1);
      this.terrain.resizeFeature(this.selectedFeatureIndex, targetW, targetL, isLive);
    }

    if (posChanged && rotChanged) {
      this.terrain.moveAndRotateFeature(this.selectedFeatureIndex, newX, newZ, newRot, isLive);
    } else if (posChanged) {
      this.terrain.moveFeature(this.selectedFeatureIndex, newX, newZ, isLive);
    } else if (rotChanged) {
      this.terrain.rotateFeature(this.selectedFeatureIndex, newRot, isLive);
    } else if (!isLive && !scaleChanged) {
      this.terrain.finalizeFeatureTransform(this.selectedFeatureIndex);
    }

    this.syncFeatureSubsystems(this.selectedFeatureIndex, isLive);
    this.updateFeatureDrapeMesh(this.selectedFeatureIndex);
    if (!isLive) {
      this.highlightFeatureComponents(this.selectedFeatureIndex);
    }
    this.ui.updateDevSelectedFeature(feat, this.selectedFeatureIndex);
  }

  private syncFeatureSubsystems(index: number, isLive = false) {
    const feat = this.terrain.stampedFeatures[index];
    if (!feat) return;

    if (this.featureGizmoProxy && !isLive) {
      const elev = this.terrain.getElevation(feat.centerX, feat.centerZ);
      this.featureGizmoProxy.position.set(feat.centerX, elev + 0.15, feat.centerZ);
      this.featureGizmoProxy.rotation.y = -feat.rotationRad;
      if (this.featureGizmoProxy.rotationQuaternion) {
        this.featureGizmoProxy.rotationQuaternion = Quaternion.RotationYawPitchRoll(-feat.rotationRad, 0, 0);
      }
    }

    if (feat.surfaceType === SurfaceType.GREEN && this.courseManager) {
      const activeHole = this.courseManager.getActiveHole();
      activeHole.pinPosition.x = feat.centerX;
      activeHole.pinPosition.z = feat.centerZ;
      activeHole.pinPosition.y = this.terrain.getElevation(feat.centerX, feat.centerZ);
      if (this.courseManager.activePinMesh) {
        this.courseManager.activePinMesh.position.set(feat.centerX, activeHole.pinPosition.y, feat.centerZ);
      }
      if (this.ball) {
        this.ball.setTargetPin(activeHole.pinPosition);
      }
      // Keep any overlapping Water Plane elevation aligned with Green movement
      for (const f of this.terrain.stampedFeatures) {
        if (f.surfaceType === SurfaceType.WATER) {
          const wm = this.findWaterMeshForFeature(f);
          if (wm) {
            wm.position.y = (f.baseElevation ?? this.terrain.getBaseElevation(f.centerX, f.centerZ)) - 0.19;
          }
        }
      }
      if (!isLive) {
        this.greenVisualizer.rebuildSlopeGrid();
      }
    } else if (feat.surfaceType === SurfaceType.TEE && this.courseManager) {
      const activeHole = this.courseManager.getActiveHole();
      activeHole.teePosition.x = feat.centerX;
      activeHole.teePosition.z = feat.centerZ;
      activeHole.teePosition.y = this.terrain.getElevation(feat.centerX, feat.centerZ);
      if (this.courseManager.activeTeeMesh) {
        this.courseManager.activeTeeMesh.position.set(feat.centerX, activeHole.teePosition.y, feat.centerZ);
        this.courseManager.activeTeeMesh.rotationQuaternion = null;
        this.courseManager.activeTeeMesh.rotation.set(0, -feat.rotationRad, 0);
      }
      if (this.ball && this.courseManager.currentStrokes === 0) {
        this.ball.setPosition(feat.centerX, activeHole.teePosition.y + GOLF_CONSTANTS.BALL_RENDER_RADIUS, feat.centerZ);
        if (this.aimSystem) {
          this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
        }
      }
    } else if (feat.surfaceType === SurfaceType.WATER) {
      const waterMesh = this.findWaterMeshForFeature(feat);
      if (waterMesh) {
        waterMesh.position.x = feat.centerX;
        waterMesh.position.z = feat.centerZ;
        waterMesh.position.y = this.terrain.getBaseElevation(feat.centerX, feat.centerZ) - 0.19;
        waterMesh.rotation.y = -feat.rotationRad;
      }
    }

    if (isLive) {
      // Heavy Havok collision, scenery clearance, and 1m grid rebuild run ONLY once on drag release for silky 60 FPS live dragging
      if (this.physicsSyncTimeout) {
        clearTimeout(this.physicsSyncTimeout);
        this.physicsSyncTimeout = null;
      }
    } else {
      if (this.physicsSyncTimeout) {
        clearTimeout(this.physicsSyncTimeout);
        this.physicsSyncTimeout = null;
      }
      this.havok.updateTerrainCollision(this.terrain.terrainMesh!);
      this.update1mGridMesh();
      if (this.courseManager) this.courseManager.refreshSceneryForFeatures();
    }
  }

  private updateFeatureDrapeMesh(index: number) {
    if (index < 0 || index >= this.terrain.stampedFeatures.length) {
      if (this.featureDrapeMesh) {
        this.featureDrapeMesh.dispose();
        this.featureDrapeMesh = null;
        this.featureDrapePointCount = 0;
      }
      if (this.featureSurfaceFillMesh) {
        this.featureSurfaceFillMesh.dispose();
        this.featureSurfaceFillMesh = null;
      }
      return;
    }

    const feat = this.terrain.stampedFeatures[index];
    const perim = this.terrain.getFeaturePerimeterPoints(feat);
    if (!perim || perim.length < 3) return;

    const pathInner: Vector3[] = [];
    const pathOuter: Vector3[] = [];
    const n = perim.length;

    for (let i = 0; i <= n; i++) {
      const p = perim[i % n];
      const dx = p.x - feat.centerX;
      const dz = p.z - feat.centerZ;
      const dist = Math.hypot(dx, dz) || 1;
      const nx = dx / dist;
      const nz = dz / dist;

      // Thin, crisp draped perimeter outline (+0.11m outward, -0.11m inward)
      const ox = p.x + nx * 0.11;
      const oz = p.z + nz * 0.11;
      const oy = this.terrain.getElevation(ox, oz) + 0.08;
      pathOuter.push(new Vector3(ox, oy, oz));

      const ix = p.x - nx * 0.11;
      const iz = p.z - nz * 0.11;
      const iy = this.terrain.getElevation(ix, iz) + 0.08;
      pathInner.push(new Vector3(ix, iy, iz));
    }

    if (
      this.featureDrapeMesh &&
      !this.featureDrapeMesh.isDisposed() &&
      this.featureDrapePointCount === pathInner.length
    ) {
      // Zero-allocation in-place ribbon vertex morph during live drag
      MeshBuilder.CreateRibbon(
        'featureDrapeRibbon',
        { pathArray: [pathInner, pathOuter], sideOrientation: Mesh.DOUBLESIDE, instance: this.featureDrapeMesh },
        this.scene
      );
      return;
    }

    if (this.featureDrapeMesh) {
      this.featureDrapeMesh.dispose();
      this.featureDrapeMesh = null;
      this.featureDrapePointCount = 0;
    }
    if (this.featureSurfaceFillMesh) {
      this.featureSurfaceFillMesh.dispose();
      this.featureSurfaceFillMesh = null;
    }

    this.featureDrapeMesh = MeshBuilder.CreateRibbon(
      'featureDrapeRibbon',
      { pathArray: [pathInner, pathOuter], closeArray: true, sideOrientation: Mesh.DOUBLESIDE, updatable: true },
      this.scene
    );
    this.featureDrapeMesh.isPickable = false;
    this.featureDrapePointCount = pathInner.length;

    if (!this.featureDrapeMaterial) {
      const mat = new StandardMaterial('featureDrapeMat', this.scene);
      mat.diffuseColor = new Color3(0.32, 0.72, 1.0);
      mat.emissiveColor = new Color3(0.22, 0.60, 0.96);
      mat.alpha = 0.62;
      mat.backFaceCulling = false;
      this.featureDrapeMaterial = mat;
    }
    this.featureDrapeMesh.material = this.featureDrapeMaterial;
  }

  private highlightFeatureComponents(index: number) {
    if (!this.selectionHighlightLayer || index < 0 || index >= this.terrain.stampedFeatures.length) return;
    const feat = this.terrain.stampedFeatures[index];
    const glowColor = new Color3(0.30, 0.74, 1.0);

    // 1. Highlight draped contour outline ribbon
    if (this.featureDrapeMesh) {
      try { this.selectionHighlightLayer.addMesh(this.featureDrapeMesh, glowColor); } catch (e) {}
    }
    // 2. Highlight central proxy
    if (this.featureGizmoProxy) {
      try { this.selectionHighlightLayer.addMesh(this.featureGizmoProxy, glowColor); } catch (e) {}
    }

    // 3. Highlight attached physical subcomponents
    if (feat.surfaceType === SurfaceType.GREEN && this.courseManager?.activePinMesh) {
      this.addMeshTreeToHighlight(this.courseManager.activePinMesh, glowColor);
    } else if (feat.surfaceType === SurfaceType.TEE && this.courseManager?.activeTeeMesh) {
      this.addMeshTreeToHighlight(this.courseManager.activeTeeMesh, glowColor);
    } else if (feat.surfaceType === SurfaceType.WATER) {
      const waterMesh = this.findWaterMeshForFeature(feat);
      if (waterMesh instanceof Mesh) {
        this.addMeshTreeToHighlight(waterMesh, glowColor);
      }
    }
  }

  private addMeshTreeToHighlight(mesh: Mesh, glowColor: Color3) {
    try { this.selectionHighlightLayer.addMesh(mesh, glowColor); } catch (e) {}
    mesh.getChildMeshes().forEach(c => {
      if (c instanceof Mesh) {
        try { this.selectionHighlightLayer.addMesh(c, glowColor); } catch (e) {}
      }
    });
  }

  private findFeatureForNode(node: Node | null): number {
    let curr: Node | null = node;
    while (curr) {
      if (curr === this.featureGizmoProxy || curr === this.featureDrapeMesh || curr === this.featureSurfaceFillMesh ||
          curr.name === 'courseFeatureProxy' || curr.name === 'featureDrapeRibbon' || curr.name === 'featureSurfaceFill') {
        if (this.selectedFeatureIndex >= 0) return this.selectedFeatureIndex;
      }
      if (curr === this.courseManager?.activePinMesh) {
        return this.terrain.stampedFeatures.findIndex(f => f.surfaceType === SurfaceType.GREEN);
      }
      if (curr === this.courseManager?.activeTeeMesh) {
        return this.terrain.stampedFeatures.findIndex(f => f.surfaceType === SurfaceType.TEE);
      }
      const name = (curr.name || '').toLowerCase();
      if (!name.includes('pine') && (
        name.includes('flag') ||
        name.includes('cup') ||
        name.includes('pole') ||
        name.includes('flagpole') ||
        name.includes('green_hole') ||
        name.startsWith('pin_') ||
        name.startsWith('flag_') ||
        name.startsWith('cup_') ||
        name.startsWith('pole_') ||
        name === 'pin'
      )) {
        return this.terrain.stampedFeatures.findIndex(f => f.surfaceType === SurfaceType.GREEN);
      }
      if (name.includes('tee') || name.includes('duck')) {
        return this.terrain.stampedFeatures.findIndex(f => f.surfaceType === SurfaceType.TEE);
      }
      if (name.includes('water') || name.includes('pond') || name.includes('lake')) {
        return this.terrain.stampedFeatures.findIndex(f => f.surfaceType === SurfaceType.WATER);
      }
      curr = curr.parent;
    }
    return -1;
  }

  private findFeatureForSceneryMesh(mesh: Mesh): number {
    return this.findFeatureForNode(mesh);
  }

  private findSceneryObjectForMesh(mesh: AbstractMesh): (Mesh | InstancedMesh) | null {
    if (!mesh || mesh.name === 'GolfTerrain') return null;
    if (mesh === this.courseManager?.activePinMesh || mesh === this.courseManager?.activeTeeMesh) return null;
    const name = (mesh.name || '').toLowerCase();
    if (
      name.startsWith('water_') ||
      (!name.includes('pine') && name.startsWith('pin_')) ||
      name.startsWith('flag_') ||
      name.startsWith('cup_') ||
      name.includes('pole') ||
      name.includes('duck') ||
      name === 'coursefeatureproxy' ||
      name === 'featuredraperibbon' ||
      name === 'featuresurfacefill' ||
      name.includes('greencontour') ||
      name.includes('contour') ||
      name.startsWith('comet_')
    ) {
      return null;
    }
    const sceneryList = this.courseManager ? this.courseManager.getSceneryMeshes() : [];
    let curr: Node | null = mesh;
    while (curr) {
      if (curr instanceof Mesh || curr instanceof InstancedMesh) {
        if (curr === this.courseManager?.activePinMesh || curr === this.courseManager?.activeTeeMesh) return null;
        const cName = (curr.name || '').toLowerCase();
        if (
          cName.startsWith('water_') ||
          (!cName.includes('pine') && cName.startsWith('pin_')) ||
          cName.startsWith('flag_') ||
          cName.startsWith('cup_') ||
          cName.includes('pole') ||
          cName.includes('duck') ||
          cName === 'coursefeatureproxy' ||
          cName === 'featuredraperibbon' ||
          cName === 'featuresurfacefill' ||
          cName.includes('greencontour') ||
          cName.includes('contour') ||
          cName.startsWith('comet_')
        ) return null;
        if (sceneryList.includes(curr as any) || cName.startsWith('pine_')) {
          return curr as (Mesh | InstancedMesh);
        }
      }
      curr = curr.parent;
    }
    return this.getRootSceneryMesh(mesh);
  }

  private isPickableSceneryMesh(abstractMesh: AbstractMesh): boolean {
    if (!abstractMesh || abstractMesh.name === 'GolfTerrain' || abstractMesh.name === 'ApproachingStormSkybox') return false;
    if (
      abstractMesh.name.includes('AimChevron') ||
      abstractMesh.name.includes('brush') ||
      abstractMesh.name.includes('contour') ||
      abstractMesh.name.includes('GreenContour') ||
      abstractMesh.name.startsWith('comet_')
    ) return false;
    if (abstractMesh.name.includes('Gizmo') && abstractMesh !== this.featureGizmoProxy) return false;
    if (abstractMesh.name === 'featureDrapeRibbon' || abstractMesh.name === 'featureSurfaceFill') return false;
    return true;
  }

  private getRootSceneryMesh(mesh: AbstractMesh): (Mesh | InstancedMesh) | null {
    let curr: Node | null = mesh;
    let highestScenery: (Mesh | InstancedMesh) | null = null;
    while (curr) {
      if ((curr instanceof Mesh || curr instanceof InstancedMesh) && curr.name !== 'GolfTerrain' && !curr.name.includes('Gizmo') && curr.name !== '__root__') {
        const name = (curr.name || '').toLowerCase();
        if (
          name.startsWith('water_') ||
          (!name.includes('pine') && name.startsWith('pin_')) ||
          name.startsWith('flag_') ||
          name.startsWith('cup_') ||
          name.includes('pole') ||
          name.includes('duck') ||
          name === 'coursefeatureproxy' ||
          name === 'featuredraperibbon' ||
          name === 'featuresurfacefill' ||
          name.includes('greencontour') ||
          name.includes('contour') ||
          name.startsWith('comet_')
        ) {
          return null;
        }
        highestScenery = curr as (Mesh | InstancedMesh);
      }
      curr = curr.parent;
    }
    return highestScenery;
  }

  private deleteSelectedMesh() {
    if (this.selectedMesh) {
      this.deleteSceneryObject(this.selectedMesh);
    }
  }

  private deleteSceneryObject(mesh: Mesh | InstancedMesh) {
    const root = this.getRootSceneryMesh(mesh) || mesh;
    if (!root || root.name === 'GolfTerrain') return;

    this.recordHistoryStep('Delete ' + (root.name || 'Object'));

    const wasSelected =
      this.selectedMesh === root ||
      this.selectedMesh === mesh ||
      (this.selectedMesh !== null && this.getRootSceneryMesh(this.selectedMesh) === root);
    if (wasSelected) {
      this.gizmoManager.attachToMesh(null);
      this.selectedMesh = null;
      this.updateObjectSelectionOutline(null);
      if (this.selectionHighlightLayer) {
        this.selectionHighlightLayer.removeAllMeshes();
      }
      this.ui.updateDevSelectedObject(null);
    }

    if (this.shadowGenerator) {
      this.shadowGenerator.removeShadowCaster(root, true);
    }

    const colliders = this.scenery.treeColliders;
    const pos = root.position;
    for (let i = colliders.length - 1; i >= 0; i--) {
      const c = colliders[i];
      if (c.mesh === root || Math.hypot(c.x - pos.x, c.z - pos.z) < 2.0) {
        colliders.splice(i, 1);
      }
    }

    this.courseManager.removeSceneryMesh(root);
    root.dispose(false, false);

    this.refreshOutliner();
    soundFx.playCupDrop();
    this.ui.showToast('Object deleted 🧹', 'info', 2000);
    this.updateDevStats();
  }

  private pushChangesToPlay() {
    this.selectCourseFeature(-1);
    this.selectMesh(null);
    this.setGizmoMode('none');
    if (this.featureGizmoProxy) {
      this.featureGizmoProxy.setEnabled(false);
    }
    if (this.featureDrapeMesh) {
      this.featureDrapeMesh.dispose();
      this.featureDrapeMesh = null;
      this.featureDrapePointCount = 0;
    }
    if (this.featureSurfaceFillMesh) {
      this.featureSurfaceFillMesh.dispose();
      this.featureSurfaceFillMesh = null;
    }
    if (this.selectionHighlightLayer) {
      this.selectionHighlightLayer.removeAllMeshes();
    }

    this.scenery.syncColliders();
    if (this.courseManager) {
      this.courseManager.refreshSceneryForFeatures();
    }
    this.havok.updateTerrainCollision(this.terrain.terrainMesh!);
    this.ball.setTreeColliders(this.scenery.treeColliders);
    this.greenVisualizer.rebuildSlopeGrid();
    this.registerSceneryShadows();
    this.ui.toggleMode();
    this.ui.showToast('Course changes pushed to Play mode! 🏌️', 'success', 3000);
  }

  private async saveDefaultHole() {
    const ok = await this.courseManager.saveCurrentAsDefault();
    if (ok) {
      if (this.ball && this.courseManager.currentStrokes === 0) {
        this.placeBallAtActiveTee();
      }
      this.updateDevStats();
      this.ui.showToast('Default hole saved to browser storage! 💾', 'success', 3000);
    } else {
      this.ui.showToast('Failed to save default hole', 'penalty', 3000);
    }
  }

  public async restoreChampionshipLayout() {
    await this.courseManager.restoreChampionshipGreenAndCourse();
    this.placeBallAtActiveTee();
    this.greenVisualizer.rebuildSlopeGrid();
    if (this.terrain.terrainMesh) {
      this.havok.updateTerrainCollision(this.terrain.terrainMesh);
    }
    this.selectCourseFeature(-1);
    this.selectMesh(null);
    this.ui.updateFeatureList(this.terrain.stampedFeatures, -1);
    this.updateHUDDisplay();
    this.ui.showToast('🟢 Restored Championship Green, Pin, Tee Box & Slope Grid!', 'success', 3500);
  }

  private resetFactoryLayout() {
    this.ui.showToast('Restoring factory championship layout...', 'warning', 2000);
    setTimeout(async () => {
      await this.courseManager.resetToFactoryDefault();
    }, 500);
  }

  private computeMeshGeoStats(mesh: Mesh | InstancedMesh | null): { tris: number; verts: number } {
    if (!mesh || mesh.isDisposed()) return { tris: 0, verts: 0 };
    if (mesh instanceof InstancedMesh) {
      const src = mesh.sourceMesh;
      if (!src || src.isDisposed()) return { tris: 0, verts: 0 };
      return {
        tris: Math.round((src.getTotalIndices() || 0) / 3),
        verts: src.getTotalVertices() || 0
      };
    }
    let tris = Math.round((mesh.getTotalIndices() || 0) / 3);
    let verts = mesh.getTotalVertices() || 0;
    const children = mesh.getChildMeshes ? mesh.getChildMeshes() : [];
    for (const c of children) {
      if (c.isDisposed()) continue;
      if (c instanceof InstancedMesh && c.sourceMesh && !c.sourceMesh.isDisposed()) {
        tris += Math.round((c.sourceMesh.getTotalIndices() || 0) / 3);
        verts += c.sourceMesh.getTotalVertices() || 0;
      } else if (c instanceof Mesh) {
        tris += Math.round((c.getTotalIndices() || 0) / 3);
        verts += c.getTotalVertices() || 0;
      }
    }
    return { tris, verts };
  }

  private computeSceneGeoStats(): { sceneTris: number; sceneVerts: number } {
    let sceneTris = 0;
    let sceneVerts = 0;
    for (const m of this.scene.meshes) {
      if (!m || m.isDisposed() || !m.isVisible || !m.isEnabled(false)) continue;
      const lower = (m.name || '').toLowerCase();
      if (
        lower.startsWith('master_') ||
        lower.includes('skybox') ||
        lower.includes('gizmo') ||
        lower.includes('outline') ||
        lower.includes('drape') ||
        lower.includes('proxy') ||
        lower.includes('gridoverlay') ||
        lower.includes('brush') ||
        lower.includes('aim') ||
        lower.includes('toptracer') ||
        lower.includes('tracer') ||
        lower.includes('comet') ||
        lower.includes('bead')
      ) {
        continue;
      }
      if (m instanceof InstancedMesh) {
        const src = m.sourceMesh;
        if (src && !src.isDisposed()) {
          sceneTris += Math.round((src.getTotalIndices() || 0) / 3);
          sceneVerts += src.getTotalVertices() || 0;
        }
      } else {
        sceneTris += Math.round((m.getTotalIndices() || 0) / 3);
        sceneVerts += m.getTotalVertices() || 0;
      }
    }
    return { sceneTris, sceneVerts };
  }

  private updateDevStats() {
    const scenery = this.courseManager.getSceneryMeshes();
    let trees = 0;
    let rocks = 0;
    let cliffs = 0;
    for (const m of scenery) {
      const n = (m.name || '').toLowerCase();
      if (n.includes('tree') || n.includes('pine') || n.includes('hero') || n.includes('oak') || n.includes('bush')) trees++;
      else if (n.includes('rock')) rocks++;
      else if (n.includes('cliff')) cliffs++;
    }
    const bunkers = this.terrain.stampedFeatures.filter(f => f.surfaceType === SurfaceType.BUNKER).length;
    const { sceneTris, sceneVerts } = this.computeSceneGeoStats();
    let selectedLabel: string | undefined;
    let selectedTris: number | undefined;
    let selectedVerts: number | undefined;

    if (this.selectedMesh && this.selectedMesh !== this.featureGizmoProxy) {
      selectedLabel = this.selectedMesh.name || 'Object';
      const st = this.computeMeshGeoStats(this.selectedMesh);
      selectedTris = st.tris;
      selectedVerts = st.verts;
    } else if (this.selectedFeatureIndex >= 0 && this.terrain.stampedFeatures[this.selectedFeatureIndex]) {
      const feat = this.terrain.stampedFeatures[this.selectedFeatureIndex];
      selectedLabel = feat.name || String(feat.surfaceType);
      const tSt = this.computeMeshGeoStats(this.terrain.terrainMesh);
      selectedTris = tSt.tris;
      selectedVerts = tSt.verts;
    } else if (this.terrain?.terrainMesh) {
      selectedLabel = 'GolfTerrain';
      const tSt = this.computeMeshGeoStats(this.terrain.terrainMesh);
      selectedTris = tSt.tris;
      selectedVerts = tSt.verts;
    }

    this.ui.updateDevStats(trees, rocks, cliffs, bunkers, {
      sceneTris,
      sceneVerts,
      selectedLabel,
      selectedTris,
      selectedVerts
    });
    this.ui.updateDevObjectList(
      this.getSelectable3DModels().map(m => ({ id: m.id, label: m.label })),
      this.selectedMesh && this.selectedMesh !== this.featureGizmoProxy ? this.selectedMesh.name : null
    );
  }

  private canDeleteMesh(mesh: Mesh | InstancedMesh | null): boolean {
    if (!mesh || mesh === this.featureGizmoProxy) return false;
    if (mesh === this.ball?.mesh) return false;
    if (mesh === this.courseManager?.activePinMesh || mesh === this.courseManager?.activeTeeMesh) return false;
    const n = (mesh.name || '').toLowerCase();
    if (n.startsWith('water_') || n.startsWith('pin_') || n.startsWith('tee_markers_') || n === 'golfball') {
      return false;
    }
    return true;
  }

  private isModelOrSceneryPickable(mesh: AbstractMesh): boolean {
    if (!mesh || !mesh.isVisible) return false;
    const name = (mesh.name || '').toLowerCase();
    if (
      name === 'golfterrain' ||
      name.includes('skybox') ||
      name.includes('aim') ||
      name.includes('tracer') ||
      name.includes('greenslope') ||
      name.includes('greencontour') ||
      name.includes('contour') ||
      name.startsWith('comet_') ||
      name.includes('grid') ||
      name.includes('brush') ||
      name.includes('ballcontactshadow') ||
      name.includes('readyindicator')
    ) {
      return false;
    }
    if (mesh.material && (mesh.material as any).name?.includes('Gizmo')) return false;
    return true;
  }

  private resolvePickedModelAndSubIdx(picked: AbstractMesh): { rootMesh: Mesh | InstancedMesh; subMatIdx: number } | null {
    if (!picked) return null;
    if (picked === this.ball?.mesh || (picked.name || '').toLowerCase() === 'golfball') {
      return { rootMesh: this.ball.mesh, subMatIdx: 0 };
    }
    const isDescendantOf = (node: Node | null, ancestor: Node | null | undefined): boolean => {
      if (!node || !ancestor) return false;
      let cur: Node | null = node;
      while (cur) {
        if (cur === ancestor) return true;
        cur = cur.parent;
      }
      return false;
    };
    const resolveSubIdxForRoot = (root: Mesh | InstancedMesh): number => {
      const mats = this.getUniqueMaterialsForMesh(root);
      const pickedMat = (picked as any).material;
      if (!pickedMat) return 0;
      const idx = mats.findIndex(m => m === pickedMat || (pickedMat as any).name?.includes(m.name));
      return idx >= 0 ? idx : 0;
    };
    // Check Pin & Flag Assembly parts cleanly
    const activePin = this.courseManager?.activePinMesh;
    const pName = (picked.name || '').toLowerCase();
    if (
      activePin &&
      (isDescendantOf(picked, activePin) || (!pName.includes('pine') && (pName.startsWith('pin_') || pName.startsWith('flag_') || pName.startsWith('cup_') || pName.startsWith('pole_'))))
    ) {
      return { rootMesh: activePin, subMatIdx: resolveSubIdxForRoot(activePin) };
    }
    // Check Tee Marker Ducks / custom Tee Marker replacements cleanly
    const activeTee = this.courseManager?.activeTeeMesh;
    if (activeTee && (isDescendantOf(picked, activeTee) || pName.includes('duck') || pName.startsWith('tee_duck_') || pName.startsWith('tee_markers_'))) {
      return { rootMesh: activeTee, subMatIdx: resolveSubIdxForRoot(activeTee) };
    }
    // Check multi-part placed scenery (e.g. Hero Tree trunk/branches/leaves, Bush branches/leaves, Pine trees)
    const sceneryObj = this.findSceneryObjectForMesh(picked);
    if (sceneryObj && this.findFeatureForNode(sceneryObj) < 0) {
      return { rootMesh: sceneryObj, subMatIdx: resolveSubIdxForRoot(sceneryObj) };
    }
    return null;
  }

  private getSelectable3DModels(): { id: string; label: string; mesh: Mesh | InstancedMesh; allowDelete: boolean }[] {
    const out: { id: string; label: string; mesh: Mesh | InstancedMesh; allowDelete: boolean }[] = [];
    const seen = new Set<AbstractMesh>();
    const pushItem = (mesh: Mesh | InstancedMesh | null | undefined, label: string, allowDelete: boolean) => {
      if (!mesh || mesh.isDisposed() || seen.has(mesh)) return;
      seen.add(mesh);
      out.push({ id: mesh.name, label, mesh, allowDelete });
    };

    if (this.ball?.mesh) {
      pushItem(this.ball.mesh, '⛳ Golf Ball (3D)', false);
    }
    if (this.courseManager?.activePinMesh) {
      pushItem(this.courseManager.activePinMesh, '🚩 Pin, Flag & Cup Assembly', false);
    }
    if (this.courseManager?.activeTeeMesh) {
      pushItem(this.courseManager.activeTeeMesh, '🦆 Tee Marker Ducks', false);
    }
    for (const m of this.scene.meshes) {
      if (m instanceof Mesh && !m.isDisposed() && (m.name || '').toLowerCase().startsWith('water_')) {
        pushItem(m, `🌊 Water Plane (${m.name})`, false);
      }
    }
    const scenery = this.courseManager.getSceneryMeshes();
    for (const m of scenery) {
      if (m instanceof Mesh || m instanceof InstancedMesh) {
        pushItem(m, `🌲 ${m.name}`, true);
      }
    }
    return out;
  }

  private findWaterMeshForFeature(feat: StampedFeatureRecord): Mesh | null {
    const cached = (feat as any)._waterMesh as Mesh | undefined;
    if (cached && !cached.isDisposed()) {
      return cached;
    }
    let best: Mesh | null = null;
    let bestDist = Infinity;
    for (const m of this.scene.meshes) {
      if (m instanceof Mesh && !m.isDisposed() && (m.name || '').toLowerCase().startsWith('water_')) {
        const d = Math.hypot(m.position.x - feat.centerX, m.position.z - feat.centerZ);
        if (d < bestDist) {
          bestDist = d;
          best = m;
        }
      }
    }
    if (best) {
      (feat as any)._waterMesh = best;
    }
    return best;
  }

  private presentSelectedFeatureMaterial(idx: number, subId: FeatureSubMaterialId) {
    if (idx < 0 || idx >= this.terrain.stampedFeatures.length) {
      this.terrain.setActiveFeatureSelection(-1, 'surface');
      this.ui.updateDevSelectedFeatureMaterial(null, null);
      return;
    }
    const feat = this.terrain.stampedFeatures[idx];
    const subOptions = this.terrain.getFeatureSubMaterialOptions(feat);
    const subColorMap: Partial<Record<FeatureSubMaterialId, string>> = {};
    for (const opt of subOptions) {
      if (opt.id === 'water_surface') {
        const wm = this.findWaterMeshForFeature(feat);
        const wInfo = wm ? this.getObjectMaterialInfo(wm, 0) : null;
        subColorMap.water_surface = wInfo?.baseColor || '#155068';
      } else {
        subColorMap[opt.id] = this.terrain.getFeatureSubMaterialSettings(idx, opt.id).baseColor || '#38b000';
      }
    }

    if (subId === 'water_surface' && feat.surfaceType === SurfaceType.WATER) {
      this.terrain.setActiveFeatureSelection(idx, 'water_surface');
      const waterMesh = this.findWaterMeshForFeature(feat);
      const info = waterMesh ? this.getObjectMaterialInfo(waterMesh, 0) : null;
      const surfSettings = this.terrain.getFeatureSubMaterialSettings(idx, 'surface');
      const waterFeatMat: FeatureMaterialSettings = info
        ? {
            baseColor: info.baseColor,
            colorTexLevel: info.colorTexLevel,
            roughnessLevel: info.roughnessLevel,
            uScale: info.uScale,
            vScale: info.vScale,
            uOffset: info.uOffset,
            vOffset: info.vOffset,
            normalLevel: info.normalLevel,
            enableBaseColorTex: info.enableBaseColorTex,
            enableRoughnessTex: info.enableRoughnessTex,
            enableNormalTex: info.enableNormalTex,
            showCollarRings: surfSettings.showCollarRings,
            collarWidth: surfSettings.collarWidth,
            customTextureUrls: {
              color: info.colorMapUrl,
              colorName: info.colorMapName,
              roughness: info.roughnessMapUrl,
              roughnessName: info.roughnessMapName,
              normal: info.normalMapUrl,
              normalName: info.normalMapName
            }
          }
        : surfSettings;
      this.ui.updateDevSelectedFeatureMaterial(feat, waterFeatMat, subOptions, subId, subColorMap);
      return;
    }

    this.terrain.setActiveFeatureSelection(idx, subId);
    const subMat = this.terrain.getFeatureSubMaterialSettings(idx, subId);
    this.ui.updateDevSelectedFeatureMaterial(feat, subMat, subOptions, subId, subColorMap);
  }

  private uploadTextureOnMaterial(
    mesh: Mesh | InstancedMesh,
    subMatIdx: number,
    slot: 'color' | 'roughness' | 'normal',
    dataUrl: string,
    fileName: string
  ) {
    const mats = this.getUniqueMaterialsForMesh(mesh);
    if (mats.length === 0) return;
    const mat = mats[Math.max(0, Math.min(mats.length - 1, subMatIdx))];
    const curUS = (mat as any)._uScale ?? 1.0;
    const curVS = (mat as any)._vScale ?? 1.0;
    const curUO = (mat as any)._uOffset ?? 0.0;
    const curVO = (mat as any)._vOffset ?? 0.0;
    const tex = new Texture(dataUrl, this.scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
    tex.name = fileName;
    tex.uScale = Math.max(0.02, curUS);
    tex.vScale = Math.max(0.02, curVS);
    tex.uOffset = curUO;
    tex.vOffset = curVO;
    (tex as any)._previewDataUrl = dataUrl;

    if (slot === 'color') {
      if (mat instanceof PBRMaterial) {
        mat.albedoTexture = tex;
      } else if (mat instanceof StandardMaterial) {
        mat.diffuseTexture = tex;
      }
      (mat as any)._origDiffuseTex = tex;
      (mat as any)._enableColorTex = true;
      if (((mat as any)._userColorTexLevel ?? 1.0) <= 0.01) {
        (mat as any)._userColorTexLevel = 1.0;
      }
      (mat as any)._customColorUrl = dataUrl;
      (mat as any)._customColorName = fileName;
    } else if (slot === 'roughness') {
      (mat as any)._roughnessTexture = tex;
      (mat as any)._origRoughnessTex = tex;
      (mat as any)._enableRoughTex = true;
      (mat as any)._customRoughUrl = dataUrl;
      (mat as any)._customRoughName = fileName;
      if (mat instanceof StandardMaterial) {
        mat.specularTexture = null;
      } else if (mat instanceof PBRMaterial) {
        mat.metallicTexture = tex;
      }
    } else if (slot === 'normal') {
      mat.bumpTexture = tex;
      (mat as any)._origBumpTex = tex;
      (mat as any)._enableNormalTex = true;
      if ((tex as any).level <= 0.01) {
        (tex as any).level = Math.max(0.0001, (mat as any)._userNormalLevel ?? 1.0);
      }
      (mat as any)._customNormalUrl = dataUrl;
      (mat as any)._customNormalName = fileName;
    }
    RealisticTextures.ensureObjectMaterialPlugin(mat);
    RealisticTextures.syncObjectMaterialPlugin(mat);
    mat.markAsDirty(1);
    mat.resetDrawCache();
  }

  private formatSubMaterialLabel(matName: string): string {
    const n = (matName || '').replace(/_inst_.*/i, '');
    switch (n) {
      case 'matHeroBranches': return 'Branches';
      case 'matHeroLeaves': return 'Leaves';
      case 'matHeroTrunk': return 'Trunk';
      case 'matWoodlandBark': return 'Trunk Bark';
      case 'matWoodlandLeaves': return 'Woodland Leaves';
      case 'matBushBranches': return 'Branches';
      case 'matBushLeaves': return 'Leaves';
      case 'matGlbPineTree': return 'Pine Foliage & Bark';
      case 'matGlbRock': return 'Boulders / Rock';
      case 'matRock': return 'Granite Rock';
      case 'matCliff': return 'Coastal Cliff';
      case 'matDam': return 'Stone Dam';
      case 'matWater': return 'Water Surface';
      case 'matPinPole': return 'Flag Pole';
      case 'matPinFlag': return 'Cloth Flag';
      case 'matCup': return 'Hole Cup';
      case 'matCupLiner': return 'Cup Liner';
      case 'matGoldTrim': return 'Gold Finial';
      case 'matDuckTeeMarker': return 'Rubber Duck';
      case 'ballMat': return 'Ball Urethane Cover';
      default: return n.replace(/^mat/, '') || 'Surface';
    }
  }

  private getObjectMaterialInfo(mesh: Mesh | InstancedMesh, subMatIdx: number = 0): any {
    if (!mesh || mesh === this.featureGizmoProxy) return null;
    const mats = this.getUniqueMaterialsForMesh(mesh);
    if (mats.length === 0) return null;

    const safeIdx = Math.max(0, Math.min(mats.length - 1, subMatIdx));
    const mat = mats[safeIdx];
    const isPbr = mat instanceof PBRMaterial;
    const subMaterials = mats.map((m, idx) => {
      const mIsPbr = m instanceof PBRMaterial;
      const mColor = (m as any)._userBaseColor || RealisticTextures.toSafeHex(mIsPbr ? (m as PBRMaterial).albedoColor : (m as StandardMaterial).diffuseColor, '#ffffff');
      return {
        index: idx,
        label: (m as any)._userSubMatLabel || this.formatSubMaterialLabel(m.name),
        colorHex: mColor
      };
    });

    const baseColor = (mat as any)._userBaseColor || RealisticTextures.toSafeHex(isPbr ? (mat as PBRMaterial).albedoColor : (mat as StandardMaterial).diffuseColor, '#ffffff');
    const colorTexLevel = Math.max(0, Math.min(1, (mat as any)._userColorTexLevel ?? 1.0));
    const roughnessLevel = Math.max(0, Math.min(1, (mat as any)._userRoughnessLevel ?? (isPbr ? ((mat as PBRMaterial).roughness ?? 0.65) : 0.65)));
    const metallicLevel = Math.max(0, Math.min(1, (mat as any)._userMetallicLevel ?? (isPbr && typeof (mat as PBRMaterial).metallic === 'number' ? (mat as PBRMaterial).metallic : 0.0)));

    const diffTex = isPbr ? (mat as PBRMaterial).albedoTexture : (mat as StandardMaterial).diffuseTexture;
    const roughTex = (mat as any)._roughnessTexture || (mat as any)._origRoughnessTex || (mat as any)._origSpecularTex || (isPbr ? (mat as PBRMaterial).metallicTexture : (mat as StandardMaterial).specularTexture);
    const bumpTex = mat.bumpTexture || (mat as any)._origBumpTex;
    const primaryTex = diffTex || bumpTex || roughTex || (mat as any)._origDiffuseTex || (mat as any)._origBumpTex;

    const uScale = (mat as any)._uScale ?? (primaryTex as any)?.uScale ?? 1.0;
    const vScale = (mat as any)._vScale ?? (primaryTex as any)?.vScale ?? 1.0;
    const uOffset = (mat as any)._uOffset ?? (primaryTex as any)?.uOffset ?? 0.0;
    const vOffset = (mat as any)._vOffset ?? (primaryTex as any)?.vOffset ?? 0.0;
    const normalLevel = (mat as any)._userNormalLevel ?? (mat.bumpTexture as any)?.level ?? (mat as any)._origBumpTex?.level ?? 1.0;

    const enableBaseColorTex = (mat as any)._enableColorTex !== undefined
      ? !!(mat as any)._enableColorTex
      : !!diffTex;
    const enableRoughnessTex = (mat as any)._enableRoughTex !== undefined
      ? !!(mat as any)._enableRoughTex
      : !!roughTex;
    const enableNormalTex = (mat as any)._enableNormalTex !== undefined
      ? !!(mat as any)._enableNormalTex
      : !!(mat.bumpTexture && (mat.bumpTexture as any).level > 0.001);

    const getTexUrl = (t: any) => {
      if (!t) return null;
      if (t._previewDataUrl) return t._previewDataUrl;
      if (t.url || t._url) return t.url || t._url;
      if (typeof t.getContext === 'function') {
        try {
          const srcCanvas = t.getContext()?.canvas;
          if (srcCanvas && typeof srcCanvas.toDataURL === 'function') {
            t._previewDataUrl = srcCanvas.toDataURL('image/png');
            return t._previewDataUrl;
          }
        } catch {}
      }
      return null;
    };
    const getTexName = (t: any, fallback: string) => {
      if (!t) return fallback;
      const raw = t.name || t.url || '';
      const parts = raw.split('/');
      return parts[parts.length - 1] || fallback;
    };

    const finalDiffTex = diffTex || (mat as any)._origDiffuseTex;
    const finalRoughTex = roughTex;

    const colorMapUrl = (mat as any)._customColorUrl || getTexUrl(finalDiffTex) || '/textures/pbr_grass/grass_pbr_diff_1k.jpg';
    const colorMapName = (mat as any)._customColorName || getTexName(finalDiffTex, 'model_diff.jpg');
    const roughnessMapUrl = (mat as any)._customRoughUrl || getTexUrl(finalRoughTex) || '/textures/pbr_grass/grass_pbr_rough_512.jpg';
    const roughnessMapName = (mat as any)._customRoughName || getTexName(finalRoughTex, 'model_rough.jpg');
    const normalMapUrl = (mat as any)._customNormalUrl || getTexUrl(bumpTex) || '/textures/pbr_grass/grass_pbr_nor_1k.jpg';
    const normalMapName = (mat as any)._customNormalName || getTexName(bumpTex, 'model_nor.jpg');

    return {
      name: mesh.name,
      subMaterials,
      activeSubMatIdx: safeIdx,
      baseColor,
      colorTexLevel,
      roughnessLevel,
      metallicLevel,
      uScale,
      vScale,
      uOffset,
      vOffset,
      normalLevel,
      enableBaseColorTex,
      enableRoughnessTex,
      enableNormalTex,
      colorMapUrl,
      colorMapName,
      roughnessMapUrl,
      roughnessMapName,
      normalMapUrl,
      normalMapName
    };
  }

  private cloneTextureSafe(tex: any, cache: Map<any, any>): any {
    if (!tex) return null;
    if (cache.has(tex)) return cache.get(tex);

    let clonedTex: any = null;
    if (tex instanceof DynamicTexture) {
      const sz = tex.getSize();
      const copy = new DynamicTexture(
        `${tex.name}_inst_${Math.floor(Math.random() * 1e6)}`,
        { width: Math.max(1, sz.width), height: Math.max(1, sz.height) },
        this.scene,
        (tex as any)._generateMipMaps !== false,
        tex.samplingMode
      );
      const srcCanvas = tex.getContext()?.canvas;
      const dstCtx = copy.getContext() as CanvasRenderingContext2D;
      if (srcCanvas && dstCtx) {
        dstCtx.clearRect(0, 0, sz.width, sz.height);
        dstCtx.drawImage(srcCanvas as unknown as CanvasImageSource, 0, 0, sz.width, sz.height);
      }
      copy.hasAlpha = tex.hasAlpha;
      copy.update(false);
      copy.wrapU = tex.wrapU;
      copy.wrapV = tex.wrapV;
      copy.uScale = tex.uScale;
      copy.vScale = tex.vScale;
      copy.uOffset = tex.uOffset;
      copy.vOffset = tex.vOffset;
      copy.level = tex.level;
      copy.anisotropicFilteringLevel = tex.anisotropicFilteringLevel;
      (copy as any)._previewDataUrl =
        (tex as any)._previewDataUrl || (srcCanvas as HTMLCanvasElement | undefined)?.toDataURL?.('image/png');
      clonedTex = copy;
    } else if (typeof tex.clone === 'function') {
      clonedTex = tex.clone();
      if (clonedTex) {
        (clonedTex as any)._previewDataUrl = (tex as any)._previewDataUrl || (tex as any).url || (tex as any)._url;
      }
    } else {
      clonedTex = tex;
    }

    cache.set(tex, clonedTex);
    return clonedTex;
  }

  private getUniqueMaterialsForMesh(mesh: Mesh | InstancedMesh): (StandardMaterial | PBRMaterial)[] {
    const mats: (StandardMaterial | PBRMaterial)[] = [];
    const perBaseKey = new Map<string, StandardMaterial | PBRMaterial>();

    const cloneMatSafe = (m: StandardMaterial | PBRMaterial, newName: string): StandardMaterial | PBRMaterial => {
      const texCache = new Map<any, any>();
      if (m instanceof PBRMaterial) {
        const cloned = new PBRMaterial(newName, this.scene);
        cloned.albedoColor = m.albedoColor ? m.albedoColor.clone() : Color3.White();
        cloned.metallic = m.metallic ?? 0.0;
        cloned.roughness = m.roughness ?? 0.65;
        cloned.alpha = m.alpha;
        cloned.transparencyMode = m.transparencyMode;
        cloned.alphaCutOff = m.alphaCutOff;
        cloned.useAlphaFromAlbedoTexture = m.useAlphaFromAlbedoTexture;
        cloned.backFaceCulling = m.backFaceCulling;
        cloned.needDepthPrePass = m.needDepthPrePass;
        cloned.separateCullingPass = m.separateCullingPass;
        cloned.twoSidedLighting = m.twoSidedLighting;
        cloned.environmentIntensity = m.environmentIntensity ?? 1.0;

        cloned.albedoTexture = this.cloneTextureSafe(m.albedoTexture, texCache);
        cloned.opacityTexture = this.cloneTextureSafe(m.opacityTexture, texCache);
        (cloned as any)._roughnessTexture = this.cloneTextureSafe((m as any)._roughnessTexture || m.metallicTexture, texCache);
        cloned.bumpTexture = this.cloneTextureSafe(m.bumpTexture, texCache);
        (cloned as any)._userBaseColor = (m as any)._userBaseColor || RealisticTextures.toSafeHex(m.albedoColor, '#ffffff');
        (cloned as any)._userColorTexLevel = (m as any)._userColorTexLevel ?? 1.0;
        (cloned as any)._userRoughnessLevel = (m as any)._userRoughnessLevel ?? m.roughness ?? 0.65;
        (cloned as any)._userMetallicLevel = (m as any)._userMetallicLevel ?? m.metallic ?? 0.0;
        (cloned as any)._enableColorTex = (m as any)._enableColorTex !== false;
        (cloned as any)._enableRoughTex = (m as any)._enableRoughTex !== false;
        (cloned as any)._enableNormalTex = (m as any)._enableNormalTex !== false;
        if ((m as any)._userSubMatLabel) {
          (cloned as any)._userSubMatLabel = (m as any)._userSubMatLabel;
        }
        return cloned;
      }

      const cloned = new StandardMaterial(newName, this.scene);
      cloned.diffuseColor = m.diffuseColor ? m.diffuseColor.clone() : Color3.White();
      cloned.ambientColor = m.ambientColor ? m.ambientColor.clone() : Color3.Black();
      cloned.emissiveColor = m.emissiveColor ? m.emissiveColor.clone() : Color3.Black();
      cloned.specularColor = m.specularColor ? m.specularColor.clone() : new Color3(0.08, 0.08, 0.08);
      cloned.specularPower = m.specularPower || 32;
      cloned.alpha = m.alpha;
      cloned.transparencyMode = m.transparencyMode;
      cloned.alphaCutOff = m.alphaCutOff;
      cloned.useAlphaFromDiffuseTexture = m.useAlphaFromDiffuseTexture;
      cloned.backFaceCulling = m.backFaceCulling;
      cloned.needDepthPrePass = m.needDepthPrePass;
      cloned.separateCullingPass = m.separateCullingPass;
      cloned.twoSidedLighting = m.twoSidedLighting;
      cloned.disableLighting = m.disableLighting;
      cloned.reflectionTexture = m.reflectionTexture;
      cloned.reflectionFresnelParameters = m.reflectionFresnelParameters;

      cloned.diffuseTexture = this.cloneTextureSafe(m.diffuseTexture, texCache);
      cloned.opacityTexture = this.cloneTextureSafe(m.opacityTexture, texCache);
      cloned.specularTexture = null;
      (cloned as any)._roughnessTexture = this.cloneTextureSafe((m as any)._roughnessTexture || m.specularTexture, texCache);
      cloned.bumpTexture = this.cloneTextureSafe(m.bumpTexture, texCache);
      (cloned as any)._userBaseColor = (m as any)._userBaseColor || RealisticTextures.toSafeHex(m.diffuseColor, '#ffffff');
      (cloned as any)._userColorTexLevel = (m as any)._userColorTexLevel ?? 1.0;
      (cloned as any)._userRoughnessLevel = (m as any)._userRoughnessLevel ?? 0.65;
      (cloned as any)._userMetallicLevel = (m as any)._userMetallicLevel ?? 0.0;
      (cloned as any)._enableColorTex = (m as any)._enableColorTex !== false;
      (cloned as any)._enableRoughTex = (m as any)._enableRoughTex !== false;
      (cloned as any)._enableNormalTex = (m as any)._enableNormalTex !== false;
      (cloned as any)._maxSpecScale = (m as any)._maxSpecScale ?? 1.0;
      if ((m as any)._userSubMatLabel) {
        (cloned as any)._userSubMatLabel = (m as any)._userSubMatLabel;
      }
      return cloned;
    };

    const processMat = (m: any, owner: Mesh): (StandardMaterial | PBRMaterial) | null => {
      if (m instanceof StandardMaterial || m instanceof PBRMaterial) {
        if (!m.name.includes('_inst_')) {
          const baseKey = m.name;
          const existing = perBaseKey.get(baseKey);
          if (existing) {
            owner.material = existing;
            return existing;
          }
          const cloned = cloneMatSafe(m, `${m.name}_inst_${mesh.name}`);
          const isPbr = cloned instanceof PBRMaterial;
          const colorTex = isPbr ? (cloned as PBRMaterial).albedoTexture : (cloned as StandardMaterial).diffuseTexture;
          (cloned as any)._origDiffuseTex = colorTex;
          (cloned as any)._origRoughnessTex = (cloned as any)._roughnessTexture;
          (cloned as any)._origBumpTex = cloned.bumpTexture;
          const initBaseColor = (cloned as any)._userBaseColor || RealisticTextures.toSafeHex(isPbr ? (cloned as PBRMaterial).albedoColor : (cloned as StandardMaterial).diffuseColor, '#ffffff');
          const initColorTexLevel = (cloned as any)._userColorTexLevel ?? 1.0;
          const initRoughnessLevel = (cloned as any)._userRoughnessLevel ?? (isPbr ? ((cloned as PBRMaterial).roughness ?? 0.65) : 0.65);
          const initMetallicLevel = (cloned as any)._userMetallicLevel ?? (isPbr ? ((cloned as PBRMaterial).metallic ?? 0.0) : 0.0);
          const initUScale = (colorTex as any)?.uScale ?? 1.0;
          const initVScale = (colorTex as any)?.vScale ?? 1.0;
          const initUOffset = (colorTex as any)?.uOffset ?? 0.0;
          const initVOffset = (colorTex as any)?.vOffset ?? 0.0;
          const initNormLvl = (cloned.bumpTexture as any)?.level ?? 1.0;
          (cloned as any)._initialSettings = {
            baseColor: initBaseColor,
            colorTexLevel: initColorTexLevel,
            roughnessLevel: initRoughnessLevel,
            metallicLevel: initMetallicLevel,
            uScale: initUScale,
            vScale: initVScale,
            uOffset: initUOffset,
            vOffset: initVOffset,
            normalLevel: initNormLvl,
            hasDiffuse: !!colorTex,
            hasRough: !!(cloned as any)._roughnessTexture,
            hasBump: !!cloned.bumpTexture,
            enableColorTex: (cloned as any)._enableColorTex !== false,
            enableRoughTex: (cloned as any)._enableRoughTex !== false,
            enableNormalTex: (cloned as any)._enableNormalTex !== false
          };
          (cloned as any)._uScale = initUScale;
          (cloned as any)._vScale = initVScale;
          (cloned as any)._uOffset = initUOffset;
          (cloned as any)._vOffset = initVOffset;
          (cloned as any)._userNormalLevel = initNormLvl;
          (cloned as any)._userMetallicLevel = initMetallicLevel;
          RealisticTextures.ensureObjectMaterialPlugin(cloned);
          cloned.markAsDirty(Material.TextureDirtyFlag);
          owner.material = cloned;
          perBaseKey.set(baseKey, cloned);
          return cloned;
        }
        RealisticTextures.ensureObjectMaterialPlugin(m);
        return m;
      }
      return null;
    };

    const actualMesh = (mesh instanceof InstancedMesh) ? mesh.sourceMesh : mesh;
    if (actualMesh.material) {
      const p = processMat(actualMesh.material, actualMesh);
      if (p && !mats.includes(p)) mats.push(p);
    }
    actualMesh.getChildMeshes().forEach(c => {
      if ((c instanceof Mesh || c instanceof InstancedMesh) && c.material) {
        const p = processMat(c.material, (c as any).sourceMesh || c);
        if (p && !mats.includes(p)) mats.push(p);
      }
    });
    return mats;
  }

  private applyObjectMaterialSettings(mesh: Mesh | InstancedMesh, settings: any, subMatIdx: number = 0) {
    const mats = this.getUniqueMaterialsForMesh(mesh);
    if (mats.length === 0) return;
    const targetMats = [mats[Math.max(0, Math.min(mats.length - 1, subMatIdx))]];
    for (const mat of targetMats) {
      const isPbr = mat instanceof PBRMaterial;
      if (settings.baseColor !== undefined) {
        (mat as any)._userBaseColor = settings.baseColor;
        if (isPbr) {
          (mat as PBRMaterial).albedoColor = Color3.White();
        } else {
          (mat as StandardMaterial).diffuseColor = Color3.White();
        }
      }
      if (settings.colorTexLevel !== undefined) {
        (mat as any)._userColorTexLevel = Math.max(0, Math.min(1, settings.colorTexLevel));
      }
      if (settings.roughnessLevel !== undefined) {
        (mat as any)._userRoughnessLevel = Math.max(0, Math.min(1, settings.roughnessLevel));
        if (isPbr) {
          (mat as PBRMaterial).roughness = (mat as any)._userRoughnessLevel;
        }
      }
      if (settings.metallicLevel !== undefined) {
        (mat as any)._userMetallicLevel = Math.max(0, Math.min(1, settings.metallicLevel));
        if (isPbr) {
          (mat as PBRMaterial).metallic = (mat as any)._userMetallicLevel;
        }
      }
      if (settings.uScale !== undefined) (mat as any)._uScale = settings.uScale;
      if (settings.vScale !== undefined) (mat as any)._vScale = settings.vScale;
      if (settings.uOffset !== undefined) (mat as any)._uOffset = settings.uOffset;
      if (settings.vOffset !== undefined) (mat as any)._vOffset = settings.vOffset;

      const curUScale = Math.max(0.02, (mat as any)._uScale ?? 1.0);
      const curVScale = Math.max(0.02, (mat as any)._vScale ?? 1.0);
      const curUOffset = (mat as any)._uOffset ?? 0.0;
      const curVOffset = (mat as any)._vOffset ?? 0.0;

      const applyUvToTex = (t: any) => {
        if (!t) return;
        t.uScale = curUScale;
        t.vScale = curVScale;
        t.uOffset = curUOffset;
        t.vOffset = curVOffset;
      };

      const allTexs = [
        isPbr ? (mat as PBRMaterial).albedoTexture : (mat as StandardMaterial).diffuseTexture,
        mat.bumpTexture,
        (mat as any)._roughnessTexture,
        isPbr ? (mat as PBRMaterial).metallicTexture : (mat as StandardMaterial).specularTexture,
        (mat as any)._origDiffuseTex,
        (mat as any)._origRoughnessTex,
        (mat as any)._origBumpTex,
        (mat as any)._origSpecularTex
      ];
      for (const t of allTexs) {
        applyUvToTex(t);
      }

      if (settings.normalLevel !== undefined) {
        (mat as any)._userNormalLevel = settings.normalLevel;
        const safeLevel = Math.max(0.0001, settings.normalLevel);
        if (!mat.bumpTexture) {
          mat.bumpTexture = (mat as any)._origBumpTex || new Texture('/textures/pbr_grass/grass_pbr_nor_1k.jpg', this.scene);
        }
        applyUvToTex(mat.bumpTexture);
        (mat.bumpTexture as any).level = safeLevel;
        if ((mat as any)._origBumpTex) {
          applyUvToTex((mat as any)._origBumpTex);
          (mat as any)._origBumpTex.level = safeLevel;
        }
      }

      if (settings.enableBaseColorTex !== undefined) {
        (mat as any)._enableColorTex = !!settings.enableBaseColorTex;
        if (isPbr) {
          if (settings.enableBaseColorTex && !(mat as PBRMaterial).albedoTexture && (mat as any)._origDiffuseTex) {
            (mat as PBRMaterial).albedoTexture = (mat as any)._origDiffuseTex;
          }
          applyUvToTex((mat as PBRMaterial).albedoTexture);
        } else {
          if (settings.enableBaseColorTex && !(mat as StandardMaterial).diffuseTexture && (mat as any)._origDiffuseTex) {
            (mat as StandardMaterial).diffuseTexture = (mat as any)._origDiffuseTex;
          }
          applyUvToTex((mat as StandardMaterial).diffuseTexture);
        }
      }

      if (settings.enableRoughnessTex !== undefined) {
        (mat as any)._enableRoughTex = !!settings.enableRoughnessTex;
      }

      if (settings.enableNormalTex !== undefined) {
        (mat as any)._enableNormalTex = !!settings.enableNormalTex;
        if (!settings.enableNormalTex) {
          if (mat.bumpTexture) (mat as any)._origBumpTex = mat.bumpTexture;
          mat.bumpTexture = null;
        } else {
          if ((mat as any)._origBumpTex) mat.bumpTexture = (mat as any)._origBumpTex;
          if (mat.bumpTexture) {
            (mat.bumpTexture as any).level = Math.max(0.0001, (mat as any)._userNormalLevel ?? 1.0);
          }
          applyUvToTex(mat.bumpTexture);
        }
      }

      RealisticTextures.ensureObjectMaterialPlugin(mat);
      RealisticTextures.syncObjectMaterialPlugin(mat);
      mat.markAsDirty(1);
      mat.resetDrawCache();
    }
  }

  private resetObjectMaterial(mesh: Mesh | InstancedMesh, subMatIdx: number = 0) {
    const mats = this.getUniqueMaterialsForMesh(mesh);
    if (mats.length === 0) return;
    const mat = mats[Math.max(0, Math.min(mats.length - 1, subMatIdx))];
    const init = (mat as any)._initialSettings;
    if (!init) return;
    (mat as any)._userBaseColor = init.baseColor;
    (mat as any)._userColorTexLevel = init.colorTexLevel ?? 1.0;
    (mat as any)._userRoughnessLevel = init.roughnessLevel ?? 0.65;
    (mat as any)._userMetallicLevel = init.metallicLevel ?? 0.0;
    (mat as any)._enableColorTex = init.enableColorTex !== false;
    (mat as any)._enableRoughTex = init.enableRoughTex !== false;
    (mat as any)._enableNormalTex = init.enableNormalTex !== false;
    (mat as any)._userNormalLevel = init.normalLevel;
    (mat as any)._uScale = init.uScale;
    (mat as any)._vScale = init.vScale;
    (mat as any)._uOffset = init.uOffset;
    (mat as any)._vOffset = init.vOffset;
    (mat as any)._customColorUrl = undefined;
    (mat as any)._customColorName = undefined;
    (mat as any)._customRoughUrl = undefined;
    (mat as any)._customRoughName = undefined;
    (mat as any)._customNormalUrl = undefined;
    (mat as any)._customNormalName = undefined;

    const isPbr = mat instanceof PBRMaterial;
    if (isPbr) {
      (mat as PBRMaterial).albedoColor = Color3.White();
      (mat as PBRMaterial).roughness = (mat as any)._userRoughnessLevel;
      (mat as PBRMaterial).metallic = (mat as any)._userMetallicLevel;
      if (init.hasDiffuse && (mat as any)._origDiffuseTex) {
        (mat as PBRMaterial).albedoTexture = (mat as any)._origDiffuseTex;
      }
    } else {
      (mat as StandardMaterial).diffuseColor = Color3.White();
      if (init.hasDiffuse && (mat as any)._origDiffuseTex) {
        (mat as StandardMaterial).diffuseTexture = (mat as any)._origDiffuseTex;
      }
    }
    if (init.hasRough && (mat as any)._origRoughnessTex) {
      (mat as any)._roughnessTexture = (mat as any)._origRoughnessTex;
      if (isPbr) {
        (mat as PBRMaterial).metallicTexture = (mat as any)._origRoughnessTex;
      }
    }
    if (init.hasBump && (mat as any)._origBumpTex) {
      mat.bumpTexture = (mat as any)._origBumpTex;
      (mat.bumpTexture as any).level = init.normalLevel;
    }

    const allTexs = [
      isPbr ? (mat as PBRMaterial).albedoTexture : (mat as StandardMaterial).diffuseTexture,
      mat.bumpTexture,
      (mat as any)._roughnessTexture,
      (mat as any)._origDiffuseTex,
      (mat as any)._origRoughnessTex,
      (mat as any)._origBumpTex
    ];
    for (const t of allTexs) {
      if (t) {
        (t as any).uScale = Math.max(0.02, init.uScale);
        (t as any).vScale = Math.max(0.02, init.vScale);
        (t as any).uOffset = init.uOffset;
        (t as any).vOffset = init.vOffset;
      }
    }
    RealisticTextures.ensureObjectMaterialPlugin(mat);
    RealisticTextures.syncObjectMaterialPlugin(mat);
    mat.markAsDirty(1);
    mat.resetDrawCache();
  }

  private update(dt: number) {
    if (this.gamepadCtrl && this.activeMode === 'play') {
      this.gamepadCtrl.update(dt);
    }
    this.swingEngine.update(dt);
    this.scenery.setWindState(this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
    // Advance ball physics and trail points BEFORE camera tracking so flight camera & tracer have zero 1-frame lag
    this.ball.step(dt);

    if (this.ball.state === BallState.IN_FLIGHT || this.ball.state === BallState.ROLLING) {
      this.ui.updateShotStats(this.ball.carryDistance, this.ball.totalDistance, false);
    }

    if (this.cameraCtrl.mode === 'flight') {
      const groundY = this.terrain.getElevation(this.ball.position.x, this.ball.position.z);
      this.cameraCtrl.updateFlightCamera(this.ball.position, this.ball.curVelocity, groundY, this.ball.hasLanded, dt);
    }

    if (this.aimSystem && this.activeMode === 'play' && this.ball.state === BallState.AT_REST) {
      this.aimSystem.update(
        this.ball.position,
        this.activeClub,
        this.swingEngine.windSpeedMps,
        this.swingEngine.windHeadingDeg
      );
    }

    // Note: Keep sunLight stationary so CSM cascade texel grids remain rock-solid without jumping during ball flight.

    // Automatically enable both Green Grid and Green Dots ONLY when the camera goes to shot view / for player's next shot to putt in Play Mode
    const isBallSettled = this.ball.state === BallState.AT_REST || this.ball.state === BallState.AIMING;
    const isOnGreen = this.terrain.getSurfaceAt(this.ball.position.x, this.ball.position.z) === SurfaceType.GREEN || this.ball.currentSurface === SurfaceType.GREEN;
    const isPuttingShotView =
      this.activeMode === 'play' &&
      isBallSettled &&
      (isOnGreen || this.activeClub.category === 'putter') &&
      (this.cameraCtrl.mode === 'green' || (this.cameraCtrl.mode === 'aim' && (isOnGreen || this.activeClub.category === 'putter')));

    if (isPuttingShotView) {
      if (!this.wasSettledOnGreen || !this.autoEnabledGreenOverlays) {
        this.greenVisualizer.setGridVisible(true);
        this.greenVisualizer.setDotsVisible(true);
        this.ui.setGreenToggleStates(true, true);
        this.autoEnabledGreenOverlays = true;
      }
    } else {
      if (this.autoEnabledGreenOverlays) {
        this.greenVisualizer.setVisible(false);
        this.ui.setGreenToggleStates(false, false);
        this.autoEnabledGreenOverlays = false;
      }
    }
    this.wasSettledOnGreen = isPuttingShotView;

    this.greenVisualizer.updatePuttingFade(dt);
  }

  private initGamepad() {
    this.gamepadCtrl = new GamepadController({
      onSwingTrigger: () => {
        if (this.activeMode !== 'play') return;
        if (this.ball.state === BallState.IN_FLIGHT || this.ball.state === BallState.ROLLING) return;
        if (this.aimSystem) this.aimSystem.hideAimArrow();
        this.swingEngine.handleActionClick();
      },
      onAimAdjust: (deltaDeg) => {
        if (this.activeMode !== 'play' || this.ball.state === BallState.IN_FLIGHT || this.ball.state === BallState.ROLLING) return;
        this.currentAimAzimuth += deltaDeg;
        this.swingEngine.aimAzimuthDeg = this.currentAimAzimuth;
        if (this.aimSystem) {
          this.aimSystem.aimHeadingDeg = this.currentAimAzimuth;
          this.aimSystem.showAimArrow(this.ball.position);
          this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
        }
        this.updateHUDDisplay();
      },
      onCameraOrbit: (deltaYaw, deltaPitch) => {
        this.cameraCtrl.orbitBy(deltaYaw, deltaPitch);
      },
      onClubChange: (direction) => {
        if (this.activeMode !== 'play') return;
        const currentIdx = GOLF_CLUBS.indexOf(this.activeClub);
        const nextIdx = Math.max(0, Math.min(GOLF_CLUBS.length - 1, currentIdx + direction));
        if (nextIdx !== currentIdx) {
          this.activeClub = GOLF_CLUBS[nextIdx];
          this.swingEngine.setClub(this.activeClub);
          if (this.aimSystem) {
            this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
          }
          this.updateHUDDisplay();
        }
      },
      onToggleCameraMode: () => {
        if (this.activeMode !== 'play') return;
        const current = this.cameraCtrl.mode;
        if (current === 'aim') {
          this.cameraCtrl.setMode('scout');
          this.cameraCtrl.setScoutView(this.ball.position, this.courseManager.currentHole.pinPosition);
        } else if (current === 'scout') {
          this.cameraCtrl.setMode('green');
          this.cameraCtrl.focusOnPin(this.courseManager.currentHole.pinPosition);
        } else {
          this.cameraCtrl.setMode('aim');
          this.cameraCtrl.setAimHeading(this.ball.position, this.currentAimAzimuth);
        }
      },
      onResetAim: () => {
        const pin = this.courseManager.currentHole.pinPosition;
        const aimDx = pin.x - this.ball.position.x;
        const aimDz = pin.z - this.ball.position.z;
        this.currentAimAzimuth = (Math.atan2(aimDx, aimDz) * 180) / Math.PI;
        this.swingEngine.aimAzimuthDeg = this.currentAimAzimuth;
        this.cameraCtrl.setAimHeading(this.ball.position, this.currentAimAzimuth);
        if (this.aimSystem) {
          this.aimSystem.aimHeadingDeg = this.currentAimAzimuth;
          this.aimSystem.showAimArrow(this.ball.position);
          this.aimSystem.update(this.ball.position, this.activeClub, this.swingEngine.windSpeedMps, this.swingEngine.windHeadingDeg);
        }
        this.updateHUDDisplay();
      },
      onToggleGreenOverlays: () => {
        const next = this.greenVisualizer.toggleVisible();
        this.ui.setGreenToggleStates(next, next);
      },
      onHudStateUpdate: (state) => {
        if (this.activeMode === 'play') {
          this.ui.updateGamepadHud(state);
        }
      }
    });
  }

  private attachHdriUvPlugin(skybox: Mesh) {
    if (!skybox.material) return;
    this.hdriUvPlugin = new HdriUvScalePlugin(skybox.material);
  }

  private getOrCreateSkyboxTexture(url: string, envTex: HDRCubeTexture): HDRCubeTexture {
    let skyTex = this.hdriSkyboxTextureCache.get(url);
    if (!skyTex) {
      skyTex = new HDRCubeTexture('', this.scene, 512);
      skyTex.name = `${url}_skybox`;
      skyTex.url = url;
      skyTex.hasAlpha = false;
      (skyTex as any).isCube = true;
      this.hdriSkyboxTextureCache.set(url, skyTex);
    }
    const internalTex = envTex.getInternalTexture();
    if (internalTex && (skyTex as any)._texture !== internalTex) {
      internalTex.incrementReferences();
      (skyTex as any)._texture = internalTex;
    }
    skyTex.coordinatesMode = Texture.SKYBOX_MODE;
    skyTex.gammaSpace = envTex.gammaSpace;
    skyTex.level = 1.0;
    skyTex.lodGenerationOffset = envTex.lodGenerationOffset;
    skyTex.lodGenerationScale = envTex.lodGenerationScale;
    (skyTex as any)._prefiltered = (envTex as any)._prefiltered;
    skyTex.sphericalPolynomial = envTex.sphericalPolynomial;
    return skyTex;
  }

  public async setHdriEnvironment(settings: Partial<EnvironmentSettings>, reloadTexture: boolean = false) {
    const prevRot = this.currentEnvSettings.hdriRotation ?? 0;
    const prevAz = this.currentEnvSettings.sunAzimuth ?? 145;
    this.currentEnvSettings = {
      ...this.currentEnvSettings,
      ...settings
    };

    if (
      settings.hdriRotation !== undefined &&
      settings.sunAzimuth === undefined &&
      !reloadTexture &&
      this.currentEnvSettings.syncSunWithHdri !== false
    ) {
      const delta = this.currentEnvSettings.hdriRotation - prevRot;
      this.currentEnvSettings.sunAzimuth = ((prevAz + delta) % 360 + 360) % 360;
    }

    if (this.courseManager) {
      this.courseManager.setEnvironmentSettings(this.currentEnvSettings);
    }

    if (this.sunLight) {
      const courseCenter = new Vector3(
        this.terrain ? this.terrain.width * 0.5 : 110,
        4,
        this.terrain ? this.terrain.length * 0.5 : 210
      );
      const radAz = (this.currentEnvSettings.sunAzimuth * Math.PI) / 180;
      const radEl = (this.currentEnvSettings.sunElevation * Math.PI) / 180;
      const dirX = Math.sin(radAz) * Math.cos(radEl);
      const dirY = -Math.sin(radEl);
      const dirZ = Math.cos(radAz) * Math.cos(radEl);
      const sunDir = new Vector3(dirX, dirY, dirZ).normalize();
      this.sunLight.direction = sunDir;
      this.sunLight.position = courseCenter.subtract(sunDir.scale(550));
      this.sunLight.intensity = this.currentEnvSettings.sunIntensity;
      this.sunLight.diffuse = Color3.FromHexString(this.currentEnvSettings.sunColor);
    }

    if (this.shadowGenerator) {
      this.shadowGenerator.darkness = Math.max(0.12, Math.min(0.45, this.currentEnvSettings.shadowDarkness ?? 0.22));
      if (this.shadowGenerator instanceof CascadedShadowGenerator) {
        this.shadowGenerator.penumbraDarkness = 0.85;
      }
      if (this.skyboxMesh) {
        this.shadowGenerator.removeShadowCaster(this.skyboxMesh, true);
      }
    }

    this.scene.environmentIntensity = this.currentEnvSettings.hdriIntensity;

    this.applyHdriTransform();

    if (reloadTexture && this.currentEnvSettings.hdriUrl) {
      const url = this.currentEnvSettings.hdriUrl;
      this.activeRequestedHdriUrl = url;
      const applyHdr = (hdrTex: HDRCubeTexture) => {
        if (this.activeRequestedHdriUrl !== url) return;

        const prevBlock = this.scene.blockMaterialDirtyMechanism;
        if (prevBlock) this.scene.blockMaterialDirtyMechanism = false;

        hdrTex.coordinatesMode = Texture.CUBIC_MODE;
        this.currentHdrTexture = hdrTex;
        this.scene.environmentTexture = hdrTex;

        const skyTex = this.getOrCreateSkyboxTexture(url, hdrTex);

        if (this.skyboxMesh && this.skyboxMesh.material) {
          const skyMat = this.skyboxMesh.material as PBRMaterial;
          skyMat.reflectionTexture = skyTex;
          skyMat.microSurface = 1.0 - 0.03;
          skyMat.disableLighting = true;
          skyMat.twoSidedLighting = true;
          skyMat.backFaceCulling = false;
          if (!this.hdriUvPlugin) {
            this.attachHdriUvPlugin(this.skyboxMesh);
          }
          skyMat.markAsDirty(Material.TextureDirtyFlag | Material.MiscDirtyFlag);
        } else {
          if (this.skyboxMesh) {
            this.skyboxMesh.dispose(false, true);
            this.skyboxMesh = null;
            this.hdriUvPlugin = null;
          }
          const skybox = this.scene.createDefaultSkybox(hdrTex, true, 12000, 0.03);
          if (skybox) {
            skybox.name = 'FairwaySkybox';
            skybox.isPickable = false;
            skybox.position.set(110, 0, 230);
            skybox.infiniteDistance = true;
            skybox.receiveShadows = false;
            if (this.shadowGenerator) {
              this.shadowGenerator.removeShadowCaster(skybox, true);
            }
            this.skyboxMesh = skybox;
            const defaultSkyRefl = (skybox.material as PBRMaterial | null)?.reflectionTexture as HDRCubeTexture | null;
            if (defaultSkyRefl && defaultSkyRefl !== skyTex) {
              defaultSkyRefl.dispose();
            }
            if (skybox.material) {
              (skybox.material as PBRMaterial).reflectionTexture = skyTex;
            }
            this.attachHdriUvPlugin(skybox);
            if (this.currentShadingMode === 'wireframe' || this.currentShadingMode === 'solid') {
              this.skyboxMesh.setEnabled(false);
            }
          }
        }

        this.scene.markAllMaterialsAsDirty(Material.TextureDirtyFlag);
        if (prevBlock) this.scene.blockMaterialDirtyMechanism = true;
        this.applyHdriTransform();
      };

      const cached = this.hdriTextureCache.get(url);
      if (cached && cached.isReady()) {
        applyHdr(cached);
      } else {
        try {
          const newHdr = new HDRCubeTexture(
            url,
            this.scene,
            512,
            false,
            true,
            false,
            true,
            () => {
              this.hdriTextureCache.set(url, newHdr);
              applyHdr(newHdr);
            },
            (msg, err) => {
              console.warn(`Failed to load HDRI (${url}):`, msg, err);
            }
          );
        } catch (e) {
          console.warn('Failed to load HDRI texture:', e);
        }
      }
    }

    this.ui?.updateEnvironmentInputs(this.currentEnvSettings);
  }

  private preloadHdriPresets() {
    // Only lazily cache lightweight 2K presets well after initial boot completes; massive 25MB 4K HDRIs load on-demand.
    const urlsToPreload = HDRI_PRESETS
      .map(p => p.file)
      .filter(url => url !== this.currentEnvSettings.hdriUrl && !url.includes('_4k'));
    let idx = 0;
    const loadNext = () => {
      if (idx >= urlsToPreload.length) return;
      const url = urlsToPreload[idx++];
      if (this.hdriTextureCache.has(url)) {
        setTimeout(loadNext, 250);
        return;
      }
      try {
        const tex = new HDRCubeTexture(url, this.scene, 512, false, true, false, true, () => {
          this.hdriTextureCache.set(url, tex);
          setTimeout(loadNext, 1200);
        }, () => {
          setTimeout(loadNext, 1200);
        });
      } catch (e) {
        setTimeout(loadNext, 1200);
      }
    };
    setTimeout(loadNext, 6000);
  }

  private applyHdriTransform() {
    const rotDeg = this.currentEnvSettings.hdriRotation || 0;
    const rotRad = (rotDeg * Math.PI) / 180;
    const scaleU = Math.max(0.05, this.currentEnvSettings.hdriScaleU ?? 1.0);
    const scaleV = scaleU;
    const offsetU = this.currentEnvSettings.hdriOffsetU ?? 0.0;
    const offsetV = this.currentEnvSettings.hdriOffsetV ?? 0.0;

    // Full 360 azimuth rotation angle in radians (combining base HDRI rotation + UV offset Width)
    const totalAzimuthRad = rotRad + offsetU * Math.PI * 2;

    if (this.skyboxMesh) {
      this.skyboxMesh.rotation.set(0, 0, 0);
      this.skyboxMesh.scaling.set(1, 1, 1);

      if (this.hdriUvPlugin) {
        this.hdriUvPlugin.scaleU = scaleU;
        this.hdriUvPlugin.scaleV = scaleV;
        this.hdriUvPlugin.offsetU = 0.0;
        this.hdriUvPlugin.offsetV = offsetV;
      }

      const skyMat = this.skyboxMesh.material as any;
      if (skyMat?.reflectionTexture) {
        if (skyMat.reflectionTexture.coordinatesMode !== Texture.SKYBOX_MODE) {
          skyMat.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
        }
        skyMat.reflectionTexture.rotationY = totalAzimuthRad;
      }
    }

    // Set rotation on environment texture for matching IBL lighting and reflections on course objects
    if (this.scene.environmentTexture) {
      if ((this.scene.environmentTexture as any).coordinatesMode !== Texture.CUBIC_MODE) {
        (this.scene.environmentTexture as any).coordinatesMode = Texture.CUBIC_MODE;
      }
      (this.scene.environmentTexture as any).rotationY = totalAzimuthRad;
    }
    if (this.currentHdrTexture && this.currentHdrTexture !== this.scene.environmentTexture) {
      (this.currentHdrTexture as any).rotationY = totalAzimuthRad;
    }
  }

  private refreshOutliner() {
    const items: OutlinerItem[] = [];

    // 1. Hole Markers
    const hole = this.courseManager.currentHole;
    if (this.courseManager.activeTeeMesh) {
      items.push({
        id: 'marker_tee',
        name: `Hole #${hole.number} Tee Box Marker`,
        category: 'markers',
        icon: '🏌️',
        posX: hole.teePosition.x,
        posZ: hole.teePosition.z,
        isVisible: this.courseManager.activeTeeMesh.isVisible,
        meshId: this.courseManager.activeTeeMesh.id
      });
    }
    if (this.courseManager.activePinMesh) {
      items.push({
        id: 'marker_pin',
        name: `Hole #${hole.number} Pin & Cup`,
        category: 'markers',
        icon: '⛳',
        posX: hole.pinPosition.x,
        posZ: hole.pinPosition.z,
        isVisible: this.courseManager.activePinMesh.isVisible,
        meshId: this.courseManager.activePinMesh.id
      });
    }

    // 2. Stamped Architecture Features
    const feats = this.terrain.stampedFeatures;
    for (let i = 0; i < feats.length; i++) {
      const feat = feats[i];
      let icon = '🌿';
      if (feat.surfaceType === SurfaceType.GREEN) icon = '⛳';
      else if (feat.surfaceType === SurfaceType.BUNKER) icon = '🏖️';
      else if (feat.surfaceType === SurfaceType.WATER) icon = '💧';
      else if (feat.surfaceType === SurfaceType.TEE) icon = '🌱';

      items.push({
        id: `feat_${i}`,
        name: feat.name || `${SurfaceType[feat.surfaceType] || 'Feature'} #${i + 1}`,
        category: 'architecture',
        icon,
        posX: feat.centerX,
        posZ: feat.centerZ,
        isVisible: true,
        featureIndex: i
      });
    }

    // 3. Scenery Meshes
    const sceneryMeshes = this.courseManager.getSceneryMeshes();
    for (const m of sceneryMeshes) {
      if (!m || m.isDisposed() || m === this.courseManager.activePinMesh || m === this.courseManager.activeTeeMesh) continue;
      const n = m.name || '';
      if (n === 'GolfTerrain' || n.includes('Skybox') || n.includes('drape') || n.includes('contour') || n.includes('courseFeatureProxy')) continue;

      let cat: 'foliage' | 'rocks' | 'architecture' | 'prop' = 'prop';
      let icon = '📦';
      let niceName = n;

      if (n.startsWith('pine_tree')) {
        cat = 'foliage';
        icon = '🌲';
        niceName = 'Scots Pine Tree';
      } else if (n.startsWith('hero_tree') || n.startsWith('woodland_tree') || n.startsWith('tree_')) {
        cat = 'foliage';
        icon = '🌳';
        niceName = 'Woodland Tree';
      } else if (n.startsWith('bush_')) {
        cat = 'foliage';
        icon = '🌿';
        niceName = 'Fairway Bush';
      } else if (n.startsWith('rock_') || n.startsWith('rocks_') || n.startsWith('cliff_')) {
        cat = 'rocks';
        icon = '🪨';
        niceName = n.startsWith('cliff') ? 'Granite Bluff Cliff' : 'Natural Rock Outcrop';
      } else if (n.startsWith('water_plane')) {
        cat = 'architecture';
        icon = '💧';
        niceName = 'Water Hazard Body';
      }

      items.push({
        id: m.id || m.name,
        name: `${niceName} [${Math.round(m.position.x)}, ${Math.round(m.position.z)}]`,
        category: cat,
        icon,
        posX: m.position.x,
        posZ: m.position.z,
        isVisible: m.isVisible,
        meshId: m.id
      });
    }

    this.ui.setOutlinerItems(items);
  }

  private deleteFeature(idx: number) {
    if (idx < 0) return;
    const feats = this.terrain.stampedFeatures;
    const feat = feats[idx];
    if (!feat) return;

    const featName = feat.name || `Feature #${idx + 1}`;
    this.recordHistoryStep('Delete Feature: ' + featName);
    const ok = this.terrain.removeFeature(idx);
    if (ok) {
      this.courseManager.refreshWaterMeshes();
      if (feat.surfaceType === SurfaceType.TEE || feat.surfaceType === SurfaceType.GREEN) {
        this.courseManager.setupHoleVisuals();
      }
      this.selectCourseFeature(-1);
      this.ui.showToast(`🗑️ Deleted ${featName}`, 'info', 2000);
      this.ui.updateFeatureList(this.terrain.stampedFeatures, -1);
      this.refreshOutliner();
      if (this.terrain.terrainMesh && (this.terrain.width <= 400 && this.terrain.length <= 400)) {
        this.havok.updateTerrainCollision(this.terrain.terrainMesh);
      }
      this.updateHUDDisplay();
      this.updateDevStats();
    }
  }

  private applyPlayModeCorridorCulling(enable: boolean) {
    const isLargeCourse = this.terrain.width > 400 || this.terrain.length > 400;
    if (!isLargeCourse) {
      if (this.terrain.playCorridorBounds) {
        this.terrain.setPlayCorridorBounds(null);
        if (this.terrain.terrainMesh) {
          this.havok.updateTerrainCollision(this.terrain.terrainMesh);
        }
      }
      return;
    }

    if (!enable) {
      if (this.terrain.playCorridorBounds) {
        this.terrain.setPlayCorridorBounds(null);
      }
      return;
    }

    const hole = this.courseManager.currentHole;
    const tee = hole?.teePosition || { x: this.terrain.width * 0.5, z: Math.max(20, this.terrain.length * 0.25) };
    const pin = hole?.pinPosition || { x: this.terrain.width * 0.5, z: Math.min(this.terrain.length - 20, this.terrain.length * 0.75) };

    let minX = Math.min(tee.x, pin.x);
    let maxX = Math.max(tee.x, pin.x);
    let minZ = Math.min(tee.z, pin.z);
    let maxZ = Math.max(tee.z, pin.z);

    if (hole?.waypoints) {
      for (const wp of hole.waypoints) {
        if (wp.x < minX) minX = wp.x;
        if (wp.x > maxX) maxX = wp.x;
        if (wp.z < minZ) minZ = wp.z;
        if (wp.z > maxZ) maxZ = wp.z;
      }
    }

    const margin = 280;
    minX = Math.max(0, minX - margin);
    maxX = Math.min(this.terrain.width, maxX + margin);
    minZ = Math.max(0, minZ - margin);
    maxZ = Math.min(this.terrain.length, maxZ + margin);

    for (const f of this.terrain.stampedFeatures) {
      const isPrimaryAnchor = f.surfaceType === SurfaceType.TEE || f.surfaceType === SurfaceType.GREEN;
      const pad = isPrimaryAnchor ? 90 : 40;
      const fx0 = f.centerX - f.width * 0.5 - pad;
      const fx1 = f.centerX + f.width * 0.5 + pad;
      const fz0 = f.centerZ - f.length * 0.5 - pad;
      const fz1 = f.centerZ + f.length * 0.5 + pad;
      if (isPrimaryAnchor || (fx1 >= minX && fx0 <= maxX && fz1 >= minZ && fz0 <= maxZ)) {
        minX = Math.max(0, Math.min(minX, fx0));
        maxX = Math.min(this.terrain.width, Math.max(maxX, fx1));
        minZ = Math.max(0, Math.min(minZ, fz0));
        maxZ = Math.min(this.terrain.length, Math.max(maxZ, fz1));
      }
    }

    this.terrain.setPlayCorridorBounds({ minX, maxX, minZ, maxZ });
    if (this.terrain.terrainMesh) {
      this.havok.updateTerrainCollision(this.terrain.terrainMesh);
    }
  }

  public async loadDemoHole() {
    let preloaded: string | null = null;
    try {
      const resp = await fetch(`/default_hole.json?t=${Date.now()}`);
      if (resp.ok) preloaded = await resp.text();
    } catch {}

    this.runWithTerraformingLoader(() => {
      if (this.macroSurroundMesh) {
        this.macroSurroundMesh.dispose();
        this.macroSurroundMesh = null;
      }
      this.lastMapNGSource = null;
      this.lastMapNGCropOpts = null;
      this.lastUnifiedCourseMeta = null;
      this.lastMapNGCourseCenter = { x: 110, z: 230 };
      this.lastMapNGCourseSpan = 460;
      this.cameraCtrl.setDesignerWorldBounds(-80, 300, -80, 540, 600);
      if (this.shadowGenerator instanceof CascadedShadowGenerator) {
        this.shadowGenerator.shadowMaxZ = 480;
      }

      const imported = preloaded ? this.courseManager.importCourseJSON(preloaded) : false;
      if (!imported) {
        this.terrain.createFlatTerrain(2.0, true, true, 220, 460, 1);
        this.terrain.generateInitialNaturalTerrain();
        this.courseManager.restoreChampionshipGreenAndCourse();
      }
      if (this.courseManager.currentHole) {
        this.courseManager.currentHole.isDemo = true;
      }
      this.courseManager.setupHoleVisuals(true);
      this.courseManager.refreshWaterMeshes();
      this.scenery.syncColliders();
      this.ball?.setTreeColliders(this.scenery.treeColliders);
      if (this.terrain.terrainMesh) {
        this.havok.updateTerrainCollision(this.terrain.terrainMesh);
      }
      this.greenVisualizer?.rebuildSlopeGrid();
      this.selectCourseFeature(-1);
      this.selectMesh(null);
      this.updateGroundSelectionOutline(false);
      this.updateObjectSelectionOutline(null);
      this.placeBallAtActiveTee();
      this.ui.updateHolesList(this.courseManager.courseData.holes, this.courseManager.currentHoleIndex);
      this.ui.updateFeatureList(this.terrain.stampedFeatures, -1);
      this.refreshOutliner();
      this.ui.updateSatelliteUi(
        Boolean(this.terrain.satelliteOverlayTex && this.terrain.satelliteEnabled),
        this.terrain.satelliteOpacity
      );
      this.ui.showGroundPbrInspector({
        ...this.terrain.getGroundUvSettings(),
        satelliteMapName: this.terrain.satelliteOverlayTex ? (this.lastSatelliteFileName || 'satellite.jpg') : undefined
      });
      this.updateHUDDisplay();
      this.updateDevStats();

      if (this.activeMode === 'designer') {
        this.cameraCtrl.setMode('designer');
        this.cameraCtrl.frameOnTarget(new Vector3(110, 4, 220), 230);
        this.setViewportShadingMode(this.currentShadingMode, true);
      } else {
        this.cameraCtrl.setMode('aim');
        this.cameraCtrl.snapAimBehindBall(this.ball.position, this.currentAimAzimuth);
      }
      this.refreshShadowsAndMaterials(true);
      this.ui.showToast('⛳ Loaded Demo Hole — ready to edit & play!', 'success', 2600);
    }, 'Loading Demo Hole...');
  }

  public toggleSatelliteOverlay() {
    if (!this.terrain.satelliteOverlayTex) {
      this.ui.showToast('Import a MapNG course or upload a Satellite Ortho texture first to toggle [T].', 'info', 2400);
      return;
    }
    if (this.terrain.satelliteEnabled && this.terrain.satelliteOpacity > 0.01) {
      this.lastSavedSatelliteOpacity = this.terrain.satelliteOpacity;
      this.terrain.setSatelliteOpacity(0.0, false);
      this.ui.updateSatelliteUi(false, 0.0);
      this.ui.showToast('🛰️ Satellite Overlay OFF [T]', 'info', 1400);
    } else {
      const nextOp = this.lastSavedSatelliteOpacity > 0.05 ? this.lastSavedSatelliteOpacity : 0.72;
      this.terrain.setSatelliteOpacity(nextOp, true);
      this.ui.updateSatelliteUi(true, nextOp);
      this.ui.showToast(`🛰️ Satellite Overlay ON (${Math.round(nextOp * 100)}%) [T]`, 'info', 1400);
    }
  }

  public setSatelliteOverlayOpacity(opacity: number) {
    if (opacity > 0.01) {
      this.lastSavedSatelliteOpacity = opacity;
    }
    const hasTex = Boolean(this.terrain.satelliteOverlayTex);
    const enabled = hasTex && opacity > 0.005;
    this.terrain.setSatelliteOpacity(opacity, enabled);
    this.ui.updateSatelliteUi(enabled, opacity);
  }

  public applySatelliteImageOnly(img: HTMLImageElement, fileName: string) {
    this.lastSatelliteFileName = fileName;
    let holeDataUrl: string | null = null;

    if (this.lastMapNGSource && this.lastUnifiedCourseMeta) {
      this.lastMapNGSource.satelliteImg = img;
      const footprint =
        this.lastMapNGSource.courseFootprint || detectGolfCourseFootprint(this.lastMapNGSource);
      this.lastMapNGSource.courseFootprint = footprint;
      holeDataUrl = extractUnifiedSatelliteDataUrl(
        img,
        this.lastMapNGSource.heightmap.width,
        this.lastMapNGSource.heightmap.height,
        this.lastMapNGSource.meta.metersPerPixel || 1.0,
        this.lastUnifiedCourseMeta.cropWestM,
        this.lastUnifiedCourseMeta.cropNorthM,
        this.lastUnifiedCourseMeta.worldWidth,
        this.lastUnifiedCourseMeta.worldLength,
        this.lastMapNGCropOpts?.isolateCourseOnly ?? true,
        footprint
      );
    } else {
      const maxTexDim = Math.min(2048, Math.max(img.width, img.height, 256));
      const scale = maxTexDim / Math.max(1, img.width, img.height);
      const cw = Math.max(128, Math.round(img.width * scale));
      const ch = Math.max(128, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, cw, ch);
        holeDataUrl = c.toDataURL('image/jpeg', 0.90);
      }
    }

    if (!holeDataUrl) {
      this.ui.showToast('Unable to encode satellite ortho texture.', 'warning', 2400);
      return;
    }

    const mix = Math.max(0.72, this.lastSavedSatelliteOpacity || 0.72);
    this.lastSavedSatelliteOpacity = mix;
    this.terrain.setSatelliteOverlayTexture(holeDataUrl, mix);
    this.ui.updateSatelliteUi(true, mix);
    this.ui.showGroundPbrInspector({
      ...this.terrain.getGroundUvSettings(),
      satelliteMapName: fileName
    });
    this.ui.showToast(`🛰️ Applied Satellite Ortho: ${fileName} (${Math.round(mix * 100)}%)`, 'success', 2800);
  }

  public createFlatHole(opts: {
    par: 3 | 4 | 5;
    mode: 'new_course' | 'add_hole';
    blankFlat: boolean;
    courseName?: string;
    kyalamiHoleNum?: number;
  }) {
    this.runWithTerraformingLoader(() => {
      if (this.macroSurroundMesh) {
        this.macroSurroundMesh.dispose();
        this.macroSurroundMesh = null;
      }
      this.lastMapNGSource = null;
      this.lastMapNGCropOpts = null;
      this.lastUnifiedCourseMeta = null;
      this.lastMapNGCourseCenter = { x: 110, z: 230 };
      this.lastMapNGCourseSpan = 460;
      this.cameraCtrl.setDesignerWorldBounds(-80, 300, -80, 540, 600);
      if (this.shadowGenerator instanceof CascadedShadowGenerator) {
        this.shadowGenerator.shadowMaxZ = 480;
      }

      const hole = this.courseManager.createFlatHoleTemplate(opts);
      this.scenery.syncColliders();
      this.ball?.setTreeColliders(this.scenery.treeColliders);
      if (this.terrain.terrainMesh) {
        this.havok.updateTerrainCollision(this.terrain.terrainMesh);
      }
      this.greenVisualizer?.rebuildSlopeGrid();
      this.selectCourseFeature(-1);
      this.updateGroundSelectionOutline(false);
      this.updateObjectSelectionOutline(null);
      if (!opts.blankFlat) {
        this.placeBallAtActiveTee();
      }
      this.ui.updateHolesList(this.courseManager.courseData.holes, this.courseManager.currentHoleIndex);
      this.ui.updateFeatureList(this.terrain.stampedFeatures, -1);
      this.refreshOutliner();
      this.updateDevStats();
      this.updateHUDDisplay();
      this.ui.updateSatelliteUi(false, 0);
      this.ui.showGroundPbrInspector({
        ...this.terrain.getGroundUvSettings(),
        satelliteMapName: undefined
      });
      if (this.activeMode === 'designer') {
        this.cameraCtrl.frameOnTarget(new Vector3(110, 2, 230), 210);
      } else {
        this.cameraCtrl.snapAimBehindBall(this.ball.position, this.currentAimAzimuth);
      }
      this.refreshShadowsAndMaterials(true);

      this.ui.showToast(
        `✨ Created Flat Hole ${hole.number} (Par ${hole.par}) — Ready to sculpt & build!`,
        'success',
        3200
      );
    }, `Creating Flat Par ${opts.par} Hole Terrain...`);
  }

  public selectKyalamiHoleIn3D(holeGuide: KyalamiHoleGuide) {
    this.courseManager.applyKyalamiHoleMetadata(holeGuide.number, true);

    if (this.lastUnifiedCourseMeta) {
      const m = this.lastUnifiedCourseMeta;
      const cx = Math.max(15, Math.min(this.terrain.width - 15, holeGuide.mapngCropHint.cropCenterX - m.cropWestM));
      const cz = Math.max(15, Math.min(this.terrain.length - 15, m.cropSouthMaxM - holeGuide.mapngCropHint.cropCenterZ));
      const rotRad = (holeGuide.mapngCropHint.rotationDeg * Math.PI) / 180;
      const halfSpan = Math.max(50, holeGuide.distances.yellow * 0.48);
      const dirE = Math.sin(rotRad);
      const dirN = Math.cos(rotRad);
      const teeX = Math.max(10, Math.min(this.terrain.width - 10, cx - dirE * halfSpan));
      const teeZ = Math.max(10, Math.min(this.terrain.length - 10, cz - dirN * halfSpan));
      const pinX = Math.max(10, Math.min(this.terrain.width - 10, cx + dirE * halfSpan));
      const pinZ = Math.max(10, Math.min(this.terrain.length - 10, cz + dirN * halfSpan));

      const hole = this.courseManager.currentHole;
      if (hole) {
        hole.teePosition = { x: teeX, y: this.terrain.getElevation(teeX, teeZ), z: teeZ };
        hole.pinPosition = { x: pinX, y: this.terrain.getElevation(pinX, pinZ), z: pinZ };
        hole.waypoints = [];
      }
      if (this.activeMode === 'play') {
        this.applyPlayModeCorridorCulling(true);
        this.placeBallAtActiveTee();
      } else {
        this.wasCameraDetachedForTrace = false;
        this.cameraCtrl.ensureDesignerCameraControl(this.canvas);
        this.cameraCtrl.frameOnTarget(
          new Vector3(cx, this.terrain.getElevation(cx, cz), cz),
          Math.max(180, holeGuide.distances.yellow * 0.85)
        );
      }
    } else if (this.activeMode === 'designer' && this.lastMapNGSource) {
      this.applyMapNGImport({
        source: this.lastMapNGSource,
        cropCenterX: holeGuide.mapngCropHint.cropCenterX,
        cropCenterZ: holeGuide.mapngCropHint.cropCenterZ,
        rotationDeg: holeGuide.mapngCropHint.rotationDeg,
        elevationScale: this.lastMapNGCropOpts?.elevationScale ?? 1.0,
        clearFeatures: false,
        isolateCourseOnly: this.lastMapNGCropOpts?.isolateCourseOnly ?? true,
        clearScenery: false,
        kyalamiHoleNumber: holeGuide.number
      });
      return;
    }

    this.ui.updateHolesList(this.courseManager.courseData.holes, this.courseManager.currentHoleIndex);
    this.ui.overheadLayout?.setViewMode('graphic');
    this.updateHUDDisplay();
    this.updateDevStats();
    this.ui.showToast(
      `⛳ Synced Kyalami Hole ${holeGuide.number} (Par ${holeGuide.par} • ${holeGuide.distances.yellow}m)`,
      'success',
      2800
    );
  }

  public applyMapNGImport(payload: {
    source: LoadedMapNGSource;
    cropCenterX: number;
    cropCenterZ: number;
    rotationDeg: number;
    elevationScale: number;
    clearFeatures: boolean;
    isolateCourseOnly?: boolean;
    clearScenery?: boolean;
    kyalamiHoleNumber?: number;
  }) {
    this.runWithTerraformingLoader(() => {
      const snap = this.captureHistorySnapshot('Import MapNG Terrain');
      const isolateCourseOnly = payload.isolateCourseOnly !== false;
      const footprint = isolateCourseOnly
        ? (payload.source.courseFootprint || detectGolfCourseFootprint(payload.source))
        : null;
      if (footprint) {
        payload.source.courseFootprint = footprint;
      }

      if (this.macroSurroundMesh) {
        this.macroSurroundMesh.dispose();
        this.macroSurroundMesh = null;
      }

      const unified = extractUnifiedCourseGrid(payload.source, {
        elevationScale: payload.elevationScale,
        isolateCourseOnly,
        courseFootprint: footprint
      });
      const satOpacity = unified.satelliteDataUrl ? 0.85 : 0.0;
      if (satOpacity > 0) this.lastSavedSatelliteOpacity = satOpacity;

      if (payload.clearScenery !== false) {
        this.courseManager.clearAllScenery();
      }
      if (payload.kyalamiHoleNumber) {
        this.courseManager.applyKyalamiHoleMetadata(payload.kyalamiHoleNumber, true);
      } else if (footprint?.sourceLabel.includes('Kyalami')) {
        this.courseManager.courseData.courseGuideId = 'kyalami';
      }

      this.terrain.loadUnifiedMapNGCourse(unified, satOpacity, payload.clearFeatures);
      this.lastUnifiedCourseMeta = unified.meta;
      this.lastMapNGSource = payload.source;
      this.lastMapNGCropOpts = {
        cropCenterX: payload.cropCenterX,
        cropCenterZ: payload.cropCenterZ,
        rotationDeg: payload.rotationDeg,
        elevationScale: payload.elevationScale,
        isolateCourseOnly
      };
      this.lastMapNGCourseCenter = { ...unified.courseCenterWorld };
      this.lastMapNGCourseSpan = Math.max(460, unified.courseSpanMeters);

      // Expand Designer world bounds & CSM shadow range to cover full isolated course
      this.cameraCtrl.setDesignerWorldBounds(
        -180,
        unified.worldWidth + 180,
        -180,
        unified.worldLength + 180,
        Math.max(1400, this.lastMapNGCourseSpan * 1.65)
      );
      if (this.shadowGenerator instanceof CascadedShadowGenerator) {
        this.shadowGenerator.shadowMaxZ = Math.max(550, Math.min(1200, this.lastMapNGCourseSpan * 0.85));
      }

      if (payload.clearFeatures) {
        this.courseManager.clearHoleMarkers();
        this.courseManager.currentStrokes = 0;
        this.courseManager.currentPutts = 0;
        const hole = this.courseManager.currentHole;
        if (hole) {
          const cx = unified.courseCenterWorld.x;
          const cz = unified.courseCenterWorld.z;
          const cy = this.terrain.getElevation(cx, cz);
          hole.teePosition = { x: Math.max(10, cx), y: cy, z: Math.max(10, cz - 80) };
          hole.pinPosition = { x: Math.min(unified.worldWidth - 10, cx), y: cy, z: Math.min(unified.worldLength - 10, cz + 80) };
          hole.waypoints = [];
          if (this.ball) {
            const teeGroundY = this.terrain.getElevation(hole.teePosition.x, hole.teePosition.z);
            this.ball.setPosition(hole.teePosition.x, teeGroundY + GOLF_CONSTANTS.BALL_RENDER_RADIUS, hole.teePosition.z);
            this.ball.setTargetPin(hole.pinPosition);
          }
        }
      } else {
        this.courseManager.setupHoleVisuals(false);
      }

      this.courseManager.courseData.mapngMeta = unified.meta;
      this.courseManager.refreshWaterMeshes();
      if (payload.clearScenery === false) {
        this.courseManager.refreshSceneryForFeatures();
      }
      this.scenery.syncColliders();
      this.ball?.setTreeColliders(this.scenery.treeColliders);

      if (this.activeMode === 'play') {
        this.applyPlayModeCorridorCulling(true);
      } else if (this.terrain.terrainMesh && this.terrain.width <= 400 && this.terrain.length <= 400) {
        this.havok.updateTerrainCollision(this.terrain.terrainMesh);
      }

      this.greenVisualizer?.rebuildSlopeGrid();
      this.selectCourseFeature(-1);
      this.updateGroundSelectionOutline(false);
      this.updateObjectSelectionOutline(null);
      this.ui.updateHolesList(this.courseManager.courseData.holes, this.courseManager.currentHoleIndex);
      this.ui.updateFeatureList(this.terrain.stampedFeatures, -1);
      this.refreshOutliner();
      this.ui.updateSatelliteUi(Boolean(unified.satelliteDataUrl), satOpacity);
      this.ui.showGroundPbrInspector({
        ...this.terrain.getGroundUvSettings(),
        satelliteMapName: this.lastSatelliteFileName || (unified.satelliteDataUrl ? 'mapng_satellite.jpg' : undefined)
      });
      if (this.activeMode === 'designer') {
        this.wasCameraDetachedForTrace = false;
        this.cameraCtrl.ensureDesignerCameraControl(this.canvas);
      }
      const overviewCenterY = this.terrain.getElevation(
        this.lastMapNGCourseCenter.x,
        this.lastMapNGCourseCenter.z
      );
      this.cameraCtrl.setCourseOverview3D(
        this.lastMapNGCourseCenter.x,
        this.lastMapNGCourseCenter.z,
        this.lastMapNGCourseSpan,
        overviewCenterY
      );
      this.refreshShadowsAndMaterials(true);
      this.recordHistoryStep(snap.description, snap);
      this.updateDevStats();
      this.updateHUDDisplay();

      const keptSuffix = footprint ? ` • ${Math.round(footprint.coveragePct)}% golf course isolated` : '';
      this.ui.showToast(
        `🗺️ Loaded ${payload.source.meta.levelName} (${unified.worldWidth}x${unified.worldLength}m @ ${unified.cellSize}m grid, ${unified.minHoleElev.toFixed(1)}m–${unified.maxHoleElev.toFixed(1)}m${keptSuffix})`,
        'success',
        3800
      );
    }, 'Building Unified Seamless MapNG Course Terrain...');
  }

  /**
   * Switches viewport shading mode: Wireframe, Solid (Clay), Material Preview, or Rendered.
   * Significantly reduces processing and memory load on large courses.
   */
  public setViewportShadingMode(mode: ViewportShadingMode, updateDesignerState: boolean = true) {
    if (updateDesignerState) {
      this.currentShadingMode = mode;
      if (this.ui) {
        this.ui.setViewportShadingMode(mode);
      }
    }

    this.scene.autoClear = mode === 'wireframe' || mode === 'solid';

    switch (mode) {
      case 'wireframe':
        this.scene.forceWireframe = true;
        this.scene.texturesEnabled = false;
        this.scene.shadowsEnabled = false;
        if (this.skyboxMesh) {
          this.skyboxMesh.setEnabled(false);
        }
        this.scene.clearColor = new Color4(0.11, 0.13, 0.17, 1.0);
        break;

      case 'solid':
        this.scene.forceWireframe = false;
        this.scene.texturesEnabled = false;
        this.scene.shadowsEnabled = false;
        if (this.skyboxMesh) {
          this.skyboxMesh.setEnabled(false);
        }
        this.scene.clearColor = new Color4(0.24, 0.27, 0.32, 1.0);
        break;

      case 'material': {
        const prevBlock = this.scene.blockMaterialDirtyMechanism;
        this.scene.blockMaterialDirtyMechanism = false;
        this.scene.forceWireframe = false;
        this.scene.texturesEnabled = true;
        this.scene.markAllMaterialsAsDirty(Material.TextureDirtyFlag | Material.MiscDirtyFlag);
        this.scene.blockMaterialDirtyMechanism = prevBlock;
        this.scene.shadowsEnabled = false;
        if (this.skyboxMesh) {
          this.skyboxMesh.setEnabled(true);
        }
        this.scene.clearColor = new Color4(0, 0, 0, 1.0);
        break;
      }

      case 'rendered': {
        const prevBlock = this.scene.blockMaterialDirtyMechanism;
        this.scene.blockMaterialDirtyMechanism = false;
        this.scene.forceWireframe = false;
        this.scene.texturesEnabled = true;
        this.scene.shadowsEnabled = true;
        if (this.skyboxMesh) {
          this.skyboxMesh.setEnabled(true);
        }
        this.scene.clearColor = new Color4(0, 0, 0, 1.0);
        this.registerSceneryShadows();
        if (this.shadowGenerator instanceof CascadedShadowGenerator) {
          this.shadowGenerator.splitFrustum();
        }
        this.scene.markAllMaterialsAsDirty(Material.LightDirtyFlag | Material.TextureDirtyFlag | Material.MiscDirtyFlag);
        this.scene.blockMaterialDirtyMechanism = prevBlock;
        break;
      }
    }
  }

}

window.addEventListener('DOMContentLoaded', async () => {
  const app = new FairwayStudioApp();
  (window as any).app = app;
  (window as any).__GOLF_APP__ = app;
  await app.start();
});
