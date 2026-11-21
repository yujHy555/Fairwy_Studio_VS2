import { HDRI_PRESETS, HdriPreset } from '../core/HdriPresets';
import { EnvironmentSettings, ViewportShadingMode } from '../core/Types';
import { GamepadHudState } from '../game/GamepadController';
import { PresetFeature, GolfHole, ClubSpec, HoleScore } from '../core/Types';
import { SurfaceType, SURFACE_PROPERTIES } from '../core/Constants';
import { PRESET_FEATURES } from '../terrain/FeatureLibrary';
import { GOLF_CLUBS } from '../game/ClubBag';
import { SwingPhase } from '../game/SwingEngine';
import { soundFx } from '../core/Audio';
import { OverheadHoleLayout, OverheadLayoutData } from './OverheadHoleLayout';
import {
  FeatureMaterialSettings,
  FeatureSubMaterialId,
  FeatureSubMaterialOption,
  StampedFeatureRecord
} from '../terrain/TerrainGrid';
import {
  LoadedMapNGSource,
  CourseFootprintMask,
  detectGolfCourseFootprint,
  isPointInCourseFootprint,
  decode16BitPng,
  parseMapNGMetadata
} from '../terrain/MapNGImporter';
import { TraceToolMode } from '../terrain/FeatureTracer';
import { CourseGuideModal, CourseGuideTelemetry } from './CourseGuideModal';
import { KyalamiHoleGuide, KYALAMI_COURSE_GUIDE } from '../data/KyalamiCourseData';

export interface OutlinerItem {
  id: string;
  name: string;
  category: 'markers' | 'architecture' | 'foliage' | 'rocks' | 'prop';
  icon: string;
  posX: number;
  posZ: number;
  isVisible: boolean;
  featureIndex?: number;
  meshId?: string;
}

export interface UIEventCallbacks {
  onMainMenuPlay?: () => void;
  onMainMenuDesigner?: () => void;
  onModeToggle: (mode: 'designer' | 'play') => void;
  onToolSelect: (tool: 'select' | 'sculpt' | 'stamp' | 'set_tee' | 'set_pin' | 'erase') => void;
  onSculptModeSelect: (mode: 'raise' | 'lower' | 'flatten' | 'smooth') => void;
  onPresetSelect: (preset: PresetFeature) => void;
  onBrushRadiusChange: (radius: number) => void;
  onBrushStrengthChange: (strength: number) => void;
  onTargetSurfaceSelect: (surface: SurfaceType) => void;
  onHoleSelect: (holeIndex: number) => void;
  onHoleParChange: (par: 3 | 4 | 5) => void;
  onToggleGrid: () => boolean;
  onToggleGreenGrid: () => boolean;
  onToggleGreenDots: () => boolean;
  onExportCourse: () => void;
  onImportCourse: (json: string) => void;
  onClubSelect: (club: ClubSpec) => void;
  onSwingAction: () => void;
  onAimAdjust: (deltaDeg: number) => void;
  onTargetDistanceAdjust?: (deltaMeters: number) => void;
  onCameraModeToggle: () => void;
  onShotShapeChange?: (shape: 'straight' | 'draw' | 'fade') => void;
  onFocusBall?: () => void;
  onResetShot: () => void;
  onGizmoModeChange?: (mode: 'none' | 'position' | 'rotation' | 'scale') => void;
  onDeleteSelectedObject?: () => void;
  onPushToPlay?: () => void;
  onSnapPinToGreen?: () => void;
  onSnapTeeToBox?: () => void;
  onViewportShadingChange?: (mode: ViewportShadingMode) => void;
  onRestoreChampionshipGreen?: () => void;
  onSaveDefaultHole?: () => void;
  onHdriPresetSelect?: (presetId: string) => void;
  onEnvironmentChange?: (settings: Partial<EnvironmentSettings>) => void;
  onDeleteFeature?: (featureIndex: number) => void;
  onOutlinerSelect?: (item: OutlinerItem) => void;
  onOutlinerFrame?: (item: OutlinerItem) => void;
  onOutlinerToggleVisibility?: (item: OutlinerItem) => void;
  onOutlinerDelete?: (item: OutlinerItem) => void;
  onResetFactoryLayout?: () => void;
  onFairwayShapeChange?: (index: number, shape: 'straight' | 'dogleg_left' | 'dogleg_right') => void;
  onBunkerShapeChange?: (index: number, shapeIndex: number) => void;
  onSaveProjectDisk?: () => void;
  onOpenProjectDisk?: (json: string) => void;
  onAimToOverheadPoint?: (worldX: number, worldZ: number) => void;
  onCourseBrandingChange?: (branding: { courseName: string; tagline: string; logoUrl?: string; primaryColor?: string }) => void;
  onSelectGroundLayer?: () => void;
  onGroundUvChange?: (settings: {
    baseColor?: string;
    colorTexLevel?: number;
    roughnessLevel?: number;
    metallicLevel?: number;
    uScale?: number;
    vScale?: number;
    uOffset?: number;
    vOffset?: number;
    normalLevel?: number;
    detailBlendLevel?: number;
    enableBaseColorTex?: boolean;
    enableRoughnessTex?: boolean;
    enableNormalTex?: boolean;
    satelliteMix?: number;
    enableSatelliteTex?: boolean;
  }) => void;
  onResetGroundMaterial?: () => void;
  onFrameSelectedObject?: () => void;
  onSelectObjectById?: (meshId: string) => void;
  onObjectSubMaterialSelect?: (subMatIndex: number) => void;
  onReplaceObjectGlb?: (file: File) => void;
  onSelectFeature?: (featureIndex: number) => void;
  onFeatureSubMaterialSelect?: (featureIndex: number, subId: FeatureSubMaterialId) => void;
  onMoveFeature?: (featureIndex: number, newX: number, newZ: number, isLive?: boolean) => void;
  onRotateFeature?: (featureIndex: number, newRotRad: number, isLive?: boolean) => void;
  onFeatureMaterialChange?: (featureIndex: number, subId: FeatureSubMaterialId, settings: Partial<FeatureMaterialSettings>) => void;
  onResetFeatureMaterial?: (featureIndex: number, subId: FeatureSubMaterialId) => void;
  onObjectMaterialChange?: (settings: {
    baseColor?: string;
    colorTexLevel?: number;
    roughnessLevel?: number;
    metallicLevel?: number;
    uScale?: number;
    vScale?: number;
    uOffset?: number;
    vOffset?: number;
    normalLevel?: number;
    enableBaseColorTex?: boolean;
    enableRoughnessTex?: boolean;
    enableNormalTex?: boolean;
  }) => void;
  onResetObjectMaterial?: () => void;
  onFeatureTextureUpload?: (featureIndex: number, subId: FeatureSubMaterialId, slot: 'color' | 'roughness' | 'normal', dataUrl: string, fileName: string) => void;
  onObjectTextureUpload?: (slot: 'color' | 'roughness' | 'normal', dataUrl: string, fileName: string) => void;
  onGroundTextureUpload?: (slot: 'color' | 'roughness' | 'normal' | 'satellite', dataUrl: string, fileName: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onApplyMapNGImport?: (payload: {
    source: LoadedMapNGSource;
    cropCenterX: number;
    cropCenterZ: number;
    rotationDeg: number;
    elevationScale: number;
    clearFeatures: boolean;
    isolateCourseOnly: boolean;
    clearScenery: boolean;
    kyalamiHoleNumber?: number;
  }) => void;
  onApplySatelliteOnly?: (img: HTMLImageElement, fileName: string) => void;
  onCourseOverview3D?: () => void;
  onCreateFlatHole?: (opts: {
    par: 3 | 4 | 5;
    mode: 'new_course' | 'add_hole';
    blankFlat: boolean;
    courseName?: string;
    kyalamiHoleNum?: number;
  }) => void;
  onLoadDemoHole?: () => void;
  onSelectKyalamiHole?: (hole: KyalamiHoleGuide) => void;
  onToggleCourseGuide?: () => void;
  onToggleSatelliteOverlay?: () => void;
  onSatelliteOpacityChange?: (opacity: number) => void;
  onTopDownTraceCam?: () => void;
  onTraceModeChange?: (mode: TraceToolMode, surface: SurfaceType) => void;
  onTraceFinish?: () => void;
  onTraceCancel?: () => void;
  onTraceUndoPoint?: () => void;
  onRestartHole?: () => void;
}


interface TipSlide {
  badge: string;
  badgeColor: string;
  title: string;
  description: string;
  rows: { key: string; desc: string }[];
  proTip: string;
}

const TIP_SLIDES: TipSlide[] = [
  {
    badge: 'TEE & DRIVING',
    badgeColor: '#10b981',
    title: 'Teeing Off & Maximum Carry',
    description: 'Championship tee shots set up the entire hole. Plan around prevailing winds and dogleg corners.',
    rows: [
      { key: 'A / D or Drag', desc: 'Adjust aim direction with 3D Aim Chevrons' },
      { key: '1 - 9 / Tab', desc: 'Select Clubs (Driver max carry 300m, 3W, 5W, 3I-9I, PW-LW)' },
      { key: 'Wind Indicator', desc: 'Compensate for crosswinds and headwinds shown in top-left HUD' },
      { key: 'Duck Markers', desc: 'Oriented directly towards the green down the optimal fairway corridor' }
    ],
    proTip: 'Driver carries up to 300m with optimal tailwind. Aim slightly left on dogleg rights to stay clear of fairway bunkers.'
  },
  {
    badge: 'SWING MECHANICS',
    badgeColor: '#3b82f6',
    title: '3-Click Pro Tour Swing Engine',
    description: 'Master the 3-click rhythm for maximum distance and surgical accuracy.',
    rows: [
      { key: '1st Space / Click', desc: 'Starts backswing meter towards peak power' },
      { key: '2nd Space / Click', desc: 'Sets swing power percentage at target notch' },
      { key: '3rd Space / Click', desc: 'Locks impact in the green sweet spot for straight flight' },
      { key: 'Draw / Fade', desc: 'Select Shot Shaper curve: Draw (right-to-left) or Fade (left-to-right)' }
    ],
    proTip: 'Missing impact left produces a hook; missing right produces a slice. Hitting the white center line yields pure trajectory.'
  },
  {
    badge: 'TURF & HAZARDS',
    badgeColor: '#f59e0b',
    title: 'Lies, Bunkers & Water Hazards',
    description: 'Different course surfaces directly influence ball flight, spin, bounce, and roll.',
    rows: [
      { key: 'Fairway', desc: 'Pure 100% power transfer and true forward roll' },
      { key: 'First Cut / Rough', desc: '70% - 85% carry distance with reduced backspin' },
      { key: 'Sand Bunkers', desc: 'High loft sand shots with controlled roll and steep lip clearance' },
      { key: 'Water Hazard', desc: '1 Penalty stroke; ball automatically drops with physics bounce at point of entry' }
    ],
    proTip: 'Bunkers feature revetted sod lips with subtle bounce. Avoid water hazard edges where slopes feed directly into ponds.'
  },
  {
    badge: 'PUTTING GREEN',
    badgeColor: '#06b6d4',
    title: 'Velvety Greens & Dynamic Break Contours',
    description: 'When putting on the green, contour grid lines and animated flow beads activate automatically.',
    rows: [
      { key: 'Auto Activation', desc: 'Grid lines fade in first, followed by flowing downhill slope beads' },
      { key: 'Flow Direction', desc: 'Beads flow downhill in the exact direction the ball will break' },
      { key: 'Bead Color', desc: 'Green = Mild break (<1.8°), Gold = Medium break (<3.5°), Red = Severe break' },
      { key: 'Bead Speed', desc: 'Speed directly reflects the steepness of the green contour' }
    ],
    proTip: 'Aim uphill of the break to allow gravity to guide the putt into the cup liner.'
  },
  {
    badge: 'CAMERA NAVIGATION',
    badgeColor: '#8b5cf6',
    title: 'Silky Smooth View Controls',
    description: 'Full 3D camera navigation for scouting, shot alignment, and course inspection.',
    rows: [
      { key: 'Left Mouse Drag', desc: 'Orbit view smoothly around current target' },
      { key: 'MMB or RMB Drag', desc: 'Pure screen-plane pan with radius-proportional speed' },
      { key: 'Mouse Wheel', desc: 'Zoom camera in and out' },
      { key: 'C Key', desc: 'Toggle top-down aerial course map' },
      { key: 'F Key', desc: 'Toggle Fullscreen in Play mode / Frame Selected Object in Designer' }
    ],
    proTip: 'Middle-mouse button (MMB) and Right-mouse button (RMB) provide identical, ultra-smooth course panning.'
  },
  {
    badge: 'COURSE ARCHITECT',
    badgeColor: '#ec4899',
    title: 'Terrain Sculpting & Stamping',
    description: 'Design custom golf holes with real-time elevation sculpting and surface painting.',
    rows: [
      { key: 'M Key / Header', desc: 'Switch instantly between Play and Designer Architect mode' },
      { key: 'Sculpt Tools [1-5]', desc: 'Raise, Lower, Flatten, Smooth, and Paint brushes' },
      { key: '1m Grid [G]', desc: 'Toggle 1m x 1m terrain contour grid overlay' },
      { key: 'Radius & Strength', desc: 'Adjust brush size (3m - 40m) and sculpting intensity' }
    ],
    proTip: 'Use the Smooth brush along bunker rims and green edges to blend natural grade changes smoothly.'
  },
  {
    badge: 'VIEWPORT SHADING MODES',
    badgeColor: '#a855f7',
    title: 'Solid, Wireframe, Material & Rendered',
    description: 'Switch viewport rendering passes to accelerate course architecture and reduce GPU processing on large scenes.',
    rows: [
      { key: '1: Wireframe View', desc: 'Structural polygon rasterization with minimal GPU fillrate' },
      { key: '2: Solid / Clay View', desc: 'Clean untextured geometry with fast shading for grading & shaping' },
      { key: '3: Material Preview', desc: 'Full surface textures, normal maps, and skybox without shadow overhead' },
      { key: '4: Rendered View', desc: 'Full AAA PBR fidelity with real-time cascaded shadow maps' }
    ],
    proTip: 'Use Solid [2] or Wireframe [1] when sculpting expansive courses to maintain ultra-fast FPS without shadow map recalculations!'
  },
  {
    badge: 'TRANSFORMS & GIZMOS',
    badgeColor: '#38bdf8',
    title: 'Select, Move, Rotate, Scale & Frame',
    description: 'Full 3D object manipulation with electric blue selection glow and Blender-style gizmos.',
    rows: [
      { key: 'Select Tool [V]', desc: 'Click any tree, rock, cliff, duck marker, or pin flag' },
      { key: 'Blue Selection Glow', desc: 'Vibrant highlight layer wraps selected 3D geometry' },
      { key: 'G / R / S', desc: 'Activate Move [G], Rotate [R], and Scale [S] gizmos' },
      { key: 'F Key', desc: 'Frame camera directly onto selected object and orbit around its center' },
      { key: 'Del / Backspace', desc: 'Delete the selected object from the course' }
    ],
    proTip: 'Press F anytime in Designer mode to center the camera on whatever object or course feature you have selected.'
  },
  {
    badge: 'COURSE SLIDING & ROTATION',
    badgeColor: '#eab308',
    title: 'Slide & Rotate Greens, Fairways & Hazards',
    description: 'Select entire course features and re-position or rotate them across the terrain in real-time.',
    rows: [
      { key: 'Click Feature', desc: 'Click any Tee, Fairway, Green, Bunker, or Water Pond in Select mode [V]' },
      { key: 'Slide on Ground', desc: 'Move feature across terrain with automatic elevation tracking' },
      { key: 'Rotate Z (Blender Yaw)', desc: 'Rotate dogleg angles, hazard orientations, and green entries' },
      { key: 'Push to Play', desc: 'Test changes instantly in live Play mode with Havok physics' },
      { key: 'Save Default Hole', desc: 'Persist your custom hole layout as the new default' }
    ],
    proTip: 'You can select features either by clicking them directly on the course or selecting from the Developer Zone dropdown.'
  }
];

export class UIController {
  private callbacks: UIEventCallbacks;
  private currentMode: 'designer' | 'play' = 'play';
  private currentTipSlideIndex: number = 0;
  private isTipsModalOpen: boolean = false;
  private activeFeatureList: any[] = [];
  private selectedFeatureIdx: number = -1;
  private selectedFeatureSubMatId: FeatureSubMaterialId = 'surface';
  private selectedObjectSubMatIdx: number = 0;
  private bottomDock: HTMLElement | null = null;
  private isDockCollapsed: boolean = false;
  private activeDockTab: 'lighting' | 'outliner' = 'lighting';
  private outlinerItems: OutlinerItem[] = [];
  private outlinerSearchQuery: string = '';
  private outlinerActiveCat: string = 'all';
  private activeHdriPresetId: string = 'limpopo_golf_course';
  private activeTraceMode: TraceToolMode = 'off';
  public isSwingEnabled: boolean = true;

  // Performance HUD & Optimization Tips
  private readonly optimizationTips: string[] = [
    'CSM Soft Shadows auto-stabilize when aiming to lock rock-solid 60+ FPS frame pacing.',
    'Topographic contour lines and slope break flow dots auto-sleep outside putting view to maximize GPU fillrate.',
    '2K HDRIs use hardware anisotropic prefiltering for seamless 360° horizon clarity at zero runtime cost.',
    'Course terrain features share unified PBR shaders with GPU UV translation to minimize draw calls.',
    'Havok physics step sleep-cycles the golf ball at rest to reserve 100% compute for rendering.',
    'In Course Designer, switch to Solid [2] or Wireframe [1] when shaping large courses to bypass shadow passes.',
    'Terrain elevation queries utilize cached bilinear interpolators for zero-allocation trajectory physics.',
    'Forest ambience and golf swing SFX use compressed WebAudio audio graphs to avoid main-thread spikes.'
  ];
  private currentPerfTipIdx: number = 0;
  private perfTipTimer: number | null = null;
  private isPerfMinimized: boolean = false;
  private sparklineHistory: number[] = new Array(24).fill(16.6);
  private sparklineBars: HTMLElement[] = [];

  // Elements
  private container: HTMLDivElement;
  private menuOverlay!: HTMLDivElement;
  private menuBgTimer: number | null = null;
  private menuBgIndex: number = 0;
  private isMainMenuVisible: boolean = false;
  private isMenuAuthenticated: boolean = false;
  private menuFocusedIdx: 0 | 1 = 0;
  private musicAudio: HTMLAudioElement | null = null;
  private musicTrackIndex: number = 0;
  private musicIsPlaying: boolean = false;
  private musicIsLoop: boolean = false;
  private musicVolume: number = 0.55;
  private readonly musicTracks = [
    { title: 'Everything In Its Right Place', url: '/audio/music/track_01.mp3' },
    { title: 'Policy of Truth', url: '/audio/music/track_02.mp3' }
  ];
  private designerPanel!: HTMLDivElement;
  private playHUD!: HTMLDivElement;
  private swingMeterBar!: HTMLDivElement;
  private swingIndicator!: HTMLDivElement;
  private lockedMarker!: HTMLDivElement;
  private lockedLabel!: HTMLElement;
  private swingFeedback!: HTMLDivElement;
  private distanceToPinLabel!: HTMLElement;
  private lieBadge!: HTMLElement;
  private clubNameLabel!: HTMLElement;
  private clubLoftLabel!: HTMLElement;
  private clubCarryLabel!: HTMLElement;
  private windSpeedLabel!: HTMLElement;
  private windArrow!: HTMLElement;
  private holeTitleLabel!: HTMLElement;
  private holeParLabel!: HTMLElement;
  private strokeCounterLabel!: HTMLElement;
  public overheadLayout!: OverheadHoleLayout;
  private courseGuideModal!: CourseGuideModal;

  constructor(callbacks: UIEventCallbacks) {
    this.callbacks = callbacks;
    this.container = document.createElement('div');
    this.container.id = 'golf-ui-root';
    document.body.appendChild(this.container);

    this.createMainMenuOverlay();
    this.render();
    this.courseGuideModal = new CourseGuideModal({
      onSelectHoleIn3D: (hole) => {
        this.callbacks.onSelectKyalamiHole?.(hole);
      }
    });
    this.setupListeners();
    this.overheadLayout = new OverheadHoleLayout('hud-overhead-layout-panel', (wx, wz) => {
      this.callbacks.onAimToOverheadPoint?.(wx, wz);
    });
    this.overheadLayout.setOnOpenCourseGuide(() => {
      this.openCourseGuide();
    });
    this.updateHotkeysGuide('play');
  }

  private render() {
    this.container.innerHTML = `
      <!-- Top Navigation & Header -->
      <header id="ui-header">
        <div class="header-left">
          <div class="logo">
            <span class="logo-ball" id="header-logo-icon">⛳</span>
            <span class="logo-text" id="header-logo-text">FAIRWAY<strong>STUDIO</strong> <span class="badge" style="background: rgba(0, 255, 204, 0.2); border: 1px solid #00ffcc; color: #00ffcc; font-size: 10px; padding: 2px 6px; border-radius: 4px; vertical-align: middle; margin-left: 6px;">2.0</span></span>
          </div>

          <!-- File & Project Manager Menu -->
          <div class="file-project-menu" style="position: relative; margin-left: 6px;">
            <button id="btn-file-menu" class="btn btn-secondary btn-sm" style="display: flex; align-items: center; gap: 4px; font-weight: 700; background: rgba(30, 41, 59, 0.85); border: 1px solid rgba(255,255,255,0.2); padding: 5px 10px;">
              📁 File ▾
            </button>
            <div id="file-menu-dropdown" class="hidden" style="display: none; position: absolute; top: calc(100% + 4px); left: 0; background: #0f172a; border: 1px solid #334155; border-radius: 6px; box-shadow: 0 12px 30px rgba(0,0,0,0.6); z-index: 9999; min-width: 220px; padding: 6px 0;">
              <button id="btn-action-save-project" class="file-dropdown-item" style="width: 100%; text-align: left; padding: 8px 14px; background: none; border: none; color: #f8fafc; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px;">
                <span>💾</span> Save Project to Disk (.json)
              </button>
              <button id="btn-action-open-project" class="file-dropdown-item" style="width: 100%; text-align: left; padding: 8px 14px; background: none; border: none; color: #f8fafc; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px;">
                <span>📂</span> Open Project from Disk (.json)
              </button>
              <div style="height: 1px; background: #334155; margin: 4px 0;"></div>
              <button id="btn-action-new-hole" class="file-dropdown-item" style="width: 100%; text-align: left; padding: 8px 14px; background: none; border: none; color: #34d399; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px;">
                <span>➕</span> New Flat Hole / Course...
              </button>
              <button id="btn-action-course-branding" class="file-dropdown-item" style="width: 100%; text-align: left; padding: 8px 14px; background: none; border: none; color: #38bdf8; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px;">
                <span>🏷️</span> Course Branding & Logo...
              </button>
              <button id="btn-action-deploy-vercel" class="file-dropdown-item" style="width: 100%; text-align: left; padding: 8px 14px; background: none; border: none; color: #00ffcc; font-size: 11px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px;">
                <span>🚀</span> Deploy to Vercel...
              </button>
            </div>
            <input type="file" id="input-open-project-file" accept=".json" style="display: none;" />
          </div>

          <div class="hole-selector" id="hole-tabs">
            <!-- Populated dynamically -->
          </div>

          <button id="btn-open-new-hole" class="btn btn-icon" title="Create New Flat Hole or Start Course">
            <span>➕ New Hole</span>
          </button>

          <button id="btn-header-demo-hole" class="btn btn-icon" title="Load &amp; Edit/Play Demo Hole">
            <span>⛳ Demo Hole</span>
          </button>

          <button id="btn-header-course-guide" class="btn btn-icon" title="Interactive Kyalami Course Guide [L]">
            <span>🗺️ Course Guide</span>
          </button>

          <button id="btn-open-main-menu" class="btn btn-icon" title="Return to Main Menu [Esc]">
            <span>🏠 Menu</span>
          </button>

          <button id="btn-open-tips" class="btn btn-tips-header" title="Open Controls & Pro Tips Guide">
            <span>💡 Tips & Controls</span>
          </button>
        </div>

        <div class="header-center">
          <button id="btn-mode-toggle" class="btn btn-primary">
            <span id="mode-icon">🎨</span>
            <span id="mode-text">Switch to Designer</span>
          </button>

          <div id="viewport-shading-group" class="viewport-shading-group hidden" title="Designer Viewport Shading Modes">
            <button id="btn-shading-wireframe" class="btn-shading" data-mode="wireframe" title="Wireframe View [1] - High performance structural mesh view">
              <span class="shading-icon">🌐</span>
              <span class="shading-label">Wireframe</span>
              <span class="shading-badge">1</span>
            </button>
            <button id="btn-shading-solid" class="btn-shading" data-mode="solid" title="Solid / Clay View [2] - Untextured geometry for fast course shaping & grading">
              <span class="shading-icon">⚪</span>
              <span class="shading-label">Solid</span>
              <span class="shading-badge">2</span>
            </button>
            <button id="btn-shading-material" class="btn-shading" data-mode="material" title="Material Preview [3] - Surface materials and skybox without heavy shadow maps">
              <span class="shading-icon">🎨</span>
              <span class="shading-label">Material</span>
              <span class="shading-badge">3</span>
            </button>
            <button id="btn-shading-rendered" class="btn-shading active" data-mode="rendered" title="Rendered View [4] - Full AAA lighting, skybox and real-time cascaded shadows">
              <span class="shading-icon">✨</span>
              <span class="shading-label">Rendered</span>
              <span class="shading-badge">4</span>
            </button>
          </div>
        </div>

        <div class="header-right">
          <button id="btn-toggle-green-grid" class="btn btn-icon" title="Toggle Green Contour Grid Lines">
            <span>🔲 Green Grid</span>
          </button>
          <button id="btn-toggle-green-dots" class="btn btn-icon" title="Toggle Green Slope Flow Dots">
            <span>🟢 Green Dots</span>
          </button>
          <button id="btn-toggle-grid" class="btn btn-icon" title="Toggle 1m Course Grid Overlay">
            <span>📏 1m Grid</span>
          </button>
          <button id="btn-export-course" class="btn btn-icon" title="Export Course JSON">
            <span>💾 Export</span>
          </button>
          <label class="btn btn-icon btn-file" title="Import Course JSON">
            <span>📂 Import</span>
            <input type="file" id="input-import-course" accept=".json" style="display:none;" />
          </label>
          <button id="btn-ambient-mute" class="btn btn-icon" title="Forest Ambience (Mute/Unmute)">
            <span id="ambient-mute-icon">🌲 🔊</span>
          </button>
          <button id="btn-sfx-mute" class="btn btn-icon" title="Golf Hit & Cup SFX (Mute/Unmute)">
            <span id="sfx-mute-icon">⛳ 🔊</span>
          </button>
          <button id="btn-sound-mute" class="btn btn-icon" title="Master Audio Mute" style="display:none;">
            <span id="mute-icon">🔊</span>
          </button>
        </div>
      </header>

      <div id="designer-geo-stats" class="designer-geo-stats"></div>

      <!-- DESIGNER MODE DRAWER & TOOLBAR -->
      <aside id="designer-panel" class="hidden">
        <div class="panel-header" id="designer-panel-header" style="display: flex; align-items: center; justify-content: space-between; user-select: none;">
          <div style="display: flex; align-items: baseline; gap: 8px;">
            <h3 style="margin: 0; font-size: 15px;">Course Architect</h3>
            <span class="scale-info">1m x 1m Grid</span>
          </div>
          <button id="btn-toggle-designer-panel" class="btn-designer-collapse" title="Collapse / Expand Course Architect (Hotkey: [1])">✕</button>
        </div>
        <div class="designer-panel-body" id="designer-panel-body">
        <div class="designer-controls-hint" style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 6px; padding: 6px 10px; margin: 0 0 10px 0; font-size: 11px; color: #a7f3d0; line-height: 1.4;">
          <strong>LMB Hold:</strong> Orbit &nbsp;|&nbsp; <strong>RMB / MMB Hold:</strong> Pan &nbsp;|&nbsp; <strong>Scroll:</strong> Zoom<br/>
          <strong>Click Terrain:</strong> Place / Sculpt &nbsp;|&nbsp; <strong>Shift + Drag:</strong> Paint Sculpt
        </div>

        <div class="panel-section">
          <h4>Editor Modes</h4>
          <div class="tool-tabs">
            <button class="btn tool-tab active" data-tool="select">Select 🎯 [V]</button>
            <button class="btn tool-tab" data-tool="sculpt">Sculpt 🏔️ [B]</button>
            <button class="btn tool-tab" data-tool="stamp">Add Object 🌲 [A]</button>
            <button class="btn tool-tab" data-tool="erase">Erase 🧹 [X]</button>
            <button class="btn tool-tab" data-tool="set_tee">Set Tee ⛳</button>
            <button class="btn tool-tab" data-tool="set_pin">Set Pin 🚩</button>
          </div>
        </div>

        <!-- Select Mode Controls -->
        <div id="select-controls" class="panel-section">
          <h4>Selection Mode Active 🎯</h4>
          <div style="font-size: 11px; color: #a7f3d0; line-height: 1.45; background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 6px; padding: 8px 10px;">
            <strong>LMB Click</strong> any tree, rock, cliff, or prop to select it.<br/>
            Use <strong>Move [G]</strong>, <strong>Rotate [R]</strong>, and <strong>Scale [S]</strong> gizmos to adjust.
          </div>
          <button id="btn-select-ground-layer" class="btn btn-sm btn-block mt-2" style="background: rgba(34, 197, 94, 0.2); border: 1px solid #22c55e; color: #86efac; font-weight: 700; padding: 6px 10px;">
            🌱 Inspect Ground PBR Material
          </button>
        </div>

        <!-- Sculpt Controls -->
        <div id="sculpt-controls" class="panel-section hidden">
          <h4>Sculpt Brush</h4>
          <div class="btn-group">
            <button class="btn btn-sm sculpt-mode-btn active" data-sculpt="raise">Raise ⬆️</button>
            <button class="btn btn-sm sculpt-mode-btn" data-sculpt="lower">Lower ⬇️</button>
            <button class="btn btn-sm sculpt-mode-btn" data-sculpt="flatten">Flatten ⏸️</button>
            <button class="btn btn-sm sculpt-mode-btn" data-sculpt="smooth">Smooth 〰️</button>
          </div>

          <div class="slider-control">
            <label>Radius: <span id="val-brush-radius">12m</span></label>
            <input type="range" id="input-brush-radius" min="0" max="30" step="0.5" value="12" />
          </div>
          <div class="slider-control">
            <label>Strength: <span id="val-brush-strength">0.5</span></label>
            <input type="range" id="input-brush-strength" min="0" max="1.5" step="0.05" value="0.5" />
          </div>
        </div>

        <!-- Preset Feature Library -->
        <div id="preset-controls" class="panel-section hidden">
          <h4>Preset Library (Auto-Blending)</h4>
          <div class="preset-category-filter">
            <button class="btn-chip active" data-cat="all">All</button>
            <button class="btn-chip" data-cat="green">Greens</button>
            <button class="btn-chip" data-cat="bunker">Bunkers</button>
            <button class="btn-chip" data-cat="fairway">Fairways</button>
            <button class="btn-chip" data-cat="water">Water</button>
            <button class="btn-chip" data-cat="tee">Tees</button>
            <button class="btn-chip" data-cat="scenery">Props</button>
          </div>

          <div class="preset-grid" id="preset-grid-container">
            <!-- Populated dynamically -->
          </div>
        </div>

        <!-- MapNG Real-Course & Satellite Feature Tracing -->
        <div class="mapng-tool-card" id="mapng-tracing-section">
          <h4>🛰️ MapNG &amp; Satellite Tracing</h4>
          <button id="btn-open-mapng-modal" class="btn btn-sm btn-block" style="background: rgba(14, 165, 233, 0.18); border-color: #38bdf8; color: #bae6fd; font-weight: 700; margin-bottom: 6px;">
            🗺️ Import MapNG Course...
          </button>

          <div class="mapng-btn-row" style="margin-bottom: 6px;">
            <button id="btn-course-overview-3d" class="btn btn-sm" title="Frame full isolated golf course in 3D">🌍 3D Course View</button>
            <button id="btn-quick-upload-sat" class="btn btn-sm" title="Load &amp; apply Satellite Texture directly onto ground">🛰️ Load Satellite...</button>
            <input type="file" id="input-quick-sat-upload" accept=".png,.jpg,.jpeg,.webp" style="display:none;" />
          </div>

          <div class="mapng-btn-row" style="margin-bottom: 6px;">
            <button id="btn-toggle-satellite" class="btn btn-sm" title="Toggle Satellite Reference Overlay [T]">🛰️ Satellite [T]</button>
            <button id="btn-topdown-trace-cam" class="btn btn-sm" title="Snap Top-Down Architect Camera for zero-parallax tracing">📐 Top-Down Cam</button>
          </div>

          <div class="slider-control" style="margin-bottom: 8px;">
            <label>Ground ↔ Satellite Mix: <span id="val-satellite-opacity">0%</span></label>
            <input type="range" id="input-satellite-opacity" min="0" max="100" step="1" value="0" />
          </div>

          <div style="font-size: 11px; color: #94a3b8; margin-bottom: 4px; font-weight: 600;">Trace Surface Contour:</div>
          <select id="select-trace-surface" style="width: 100%; margin-bottom: 6px; padding: 5px 8px; border-radius: 6px; background: rgba(15,23,42,0.9); color: #e2e8f0; border: 1px solid rgba(56,189,248,0.35); font-size: 12px;">
            <option value="bunker">🏖️ Bunker (Sand + Sod Lip)</option>
            <option value="green">⛳ Putting Green (Keep DEM)</option>
            <option value="fairway">🌿 Fairway</option>
            <option value="tee">🏌️ Tee Box (2-Layer)</option>
            <option value="water">💧 Water Hazard + 3D Surface</option>
          </select>

          <div class="mapng-btn-row">
            <button id="btn-trace-spline" class="btn btn-sm" title="Click perimeter points on satellite photo">✏️ Trace Spline</button>
            <button id="btn-trace-lasso" class="btn btn-sm" title="Hold LMB and draw freehand around shape">〰️ Lasso</button>
          </div>
          <div class="mapng-btn-row hidden" id="trace-active-actions" style="margin-top: 6px;">
            <button id="btn-trace-finish" class="btn btn-sm" style="background: rgba(34, 197, 94, 0.25); border-color: #22c55e; color: #86efac;">✅ Finish [Enter]</button>
            <button id="btn-trace-cancel" class="btn btn-sm" style="background: rgba(239, 68, 68, 0.22); border-color: #ef4444; color: #fca5a5;">✖ Cancel [Esc]</button>
          </div>
          <div id="trace-status-badge" class="trace-status-badge hidden">
            Click points on terrain. Enter / click green start dot to close.
          </div>
        </div>
        </div>
      </aside>

      <!-- PLAY MODE HUD -->
      <div id="play-hud">
        <!-- Target Info Card -->
        <div class="hud-top-card">
          <div class="hole-meta">
            <h2 id="hud-hole-title">Demo Hole</h2>
            <span id="hud-hole-par" class="par-tag">PAR 4</span>
            <span class="stroke-tag">STROKES: <strong id="hud-strokes">0</strong></span>
            <button id="btn-open-course-guide" class="btn-hud-guide" title="Open Interactive Course Guide [L]">
              🗺️ Course Layout
            </button>
          </div>
          <div class="distance-display">
            <div class="dist-num" id="hud-dist-to-pin">320<span class="unit">m</span></div>
            <div class="dist-yards" id="hud-dist-yards">350 yds to pin</div>
          </div>
          <div class="lie-status">
            <span>Lie:</span>
            <span id="hud-lie-badge" class="badge-lie badge-tee">Tee Box</span>
          </div>

          <!-- Live Shot Distance Tracker -->
          <div class="shot-tracker-badge" id="hud-shot-tracker" style="display: none;">
            <span class="shot-tracker-label">LAST SHOT</span>
            <span class="shot-tracker-total" id="hud-shot-total">0m</span>
            <span class="shot-tracker-sub" id="hud-shot-breakdown">In flight...</span>
          </div>
        </div>

        <!-- Next-Gen Backspin Impact Timing HUD Indicator -->
        <div id="hud-backspin-indicator" class="hud-backspin-indicator hidden">
          <div class="backspin-header-row">
            <span class="backspin-icon-spin">⚡</span>
            <span id="backspin-badge-title" class="backspin-badge-title">BACKSPIN TIMING</span>
            <span id="backspin-rating-tag" class="backspin-rating-tag">READY</span>
          </div>
          <div class="backspin-prompt-row" id="backspin-prompt-text">
            SCROLL ▾ BACKWARDS AT GREEN BOUNCE
          </div>
          <div class="backspin-meter-bar">
            <div id="backspin-meter-level" class="backspin-meter-level" style="width: 0%;"></div>
          </div>
        </div>

        <div class="hud-top-right-widgets">
          <!-- Audio Soundtrack Player (Left of Wind Panel) -->
          <div class="hud-music-player" id="hud-music-player" title="Course Soundtrack Player">
            <div class="music-header-row">
              <span class="music-note-badge">🎵</span>
              <span class="music-track-title" id="music-track-title">Everything In Its Right Place</span>
              <span class="music-track-counter" id="music-track-counter">1/2</span>
            </div>
            <div class="music-controls-row">
              <button id="btn-music-prev" type="button" class="btn-music" title="Previous Track">⏮</button>
              <button id="btn-music-play" type="button" class="btn-music btn-music-primary" title="Play / Pause">▶</button>
              <button id="btn-music-stop" type="button" class="btn-music" title="Stop">⏹</button>
              <button id="btn-music-next" type="button" class="btn-music" title="Next Track">⏭</button>
              <button id="btn-music-loop" type="button" class="btn-music" title="Loop Track">🔁</button>
            </div>
            <div class="music-volume-row">
              <span class="music-vol-icon" id="music-vol-icon">🔊</span>
              <input type="range" id="music-volume-slider" class="music-vol-slider" min="0" max="1" step="0.01" value="0.55" title="Music Volume" />
              <span class="music-vol-pct" id="music-vol-pct">55%</span>
            </div>
          </div>

          <!-- Wind Gauge -->
          <div class="hud-wind-gauge">
            <div class="compass-circle">
              <div class="wind-arrow-wrapper" id="hud-wind-arrow">
                <div class="wind-arrow-head"></div>
              </div>
              <span class="compass-n">N</span>
            </div>
            <div class="wind-speed" id="hud-wind-speed">3.5 m/s</div>
            <div class="wind-sub">WIND</div>
          </div>
        </div>

        <!-- Next-Gen Realtime Overhead Hole Layout Panel (Middle-Right Play Mode) -->
        <div id="hud-overhead-layout-panel" class="hud-overhead-layout-panel">
          <div class="overhead-header">
            <div class="overhead-title-group">
              <span class="overhead-badge">OVERHEAD</span>
              <span id="overhead-hole-name" class="overhead-hole-name">DEMO HOLE • PAR 4</span>
            </div>
            <div class="overhead-header-actions">
              <button id="btn-overhead-expand-guide" class="btn-overhead-tool" title="Open Interactive Course Guide [L]">🗺️</button>
              <button id="btn-toggle-overhead-min" class="btn-overhead-tool" title="Minimize / Expand Overhead View [M]">▾</button>
            </div>
          </div>

          <div class="overhead-body" id="overhead-body">
            <div class="overhead-view-pills">
              <button id="btn-overhead-mode-graphic" class="btn-overhead-pill active" title="Course Overhead Graphic">Graphic</button>
              <button id="btn-overhead-mode-radar" class="btn-overhead-pill" title="Live 3D Overhead Radar">3D Radar</button>
              <button id="btn-overhead-dist-toggle" class="btn-overhead-pill" title="Toggle Distance Guide Image">Dist</button>
            </div>

            <!-- Dynamic Overhead 2D Canvas or Official Course Hole Graphic -->
            <div class="overhead-canvas-container">
              <div id="overhead-graphic-wrap" class="overhead-graphic-wrap" style="display: none;">
                <img id="overhead-hole-img" class="overhead-hole-img" alt="Hole Overhead Graphic" />
                <canvas id="overhead-ruler-canvas" class="overhead-ruler-canvas" title="Click to aim shot • Drag to measure distance • Double-click to clear"></canvas>
              </div>
              <canvas id="overhead-hole-canvas" width="324" height="350"></canvas>
            </div>

            <!-- Yardage Readout & Elevation Delta Footer -->
            <div class="overhead-footer-bar">
              <div class="overhead-stat-box">
                <span class="overhead-stat-label">PIN DIST</span>
                <span id="overhead-pin-dist" class="overhead-stat-val highlight-cyan">--m</span>
              </div>
              <div class="overhead-stat-box">
                <span class="overhead-stat-label">ELEVATION</span>
                <span id="overhead-elevation-delta" class="overhead-stat-val highlight-green">0.0m</span>
              </div>
              <div class="overhead-stat-box">
                <span class="overhead-stat-label">TARGET CARRY</span>
                <span id="overhead-target-dist" class="overhead-stat-val highlight-gold">--m</span>
              </div>
            </div>
          </div>

          <!-- Minimized floating pill button -->
          <div id="overhead-minimized-pill" class="overhead-minimized-pill" title="Expand Overhead Hole Map [M]">
            <span class="pill-radar-icon">🗺️</span>
            <span id="overhead-pill-text" class="pill-text">H1 PAR 4 [M]</span>
          </div>
        </div>

        <!-- Club Selection & Shot Info -->
        <div class="hud-club-selector">
          <button id="btn-prev-club" class="btn btn-icon">◀</button>
          <div class="club-info">
            <div class="club-title" id="hud-club-name">Driver 10.5°</div>
            <div class="club-details">
              <span id="hud-club-loft">Loft: 10.5°</span> | 
              <span id="hud-club-carry">Typical: 255m</span>
            </div>
          </div>
          <button id="btn-next-club" class="btn btn-icon">▶</button>
        </div>


        <!-- Next-Gen Bottom-Left Stack: In-Game Dev Controls, Frame Rate Counter & Gamepad HUD -->
        <div class="bottom-left-hud-stack">
          <!-- In-Game Developer Control Panel -->
          <div id="play-dev-controls" class="play-dev-controls">
            <div class="play-dev-header">
              <span class="play-dev-title">⚡ DEVELOPER CONTROLS</span>
            </div>
            <div class="play-dev-actions">
              <button id="btn-play-restart-hole" class="btn btn-sm play-dev-btn" title="Restart current hole from the Tee Box">🔄 Restart Hole</button>
              <button id="btn-play-open-designer" class="btn btn-sm play-dev-btn play-dev-btn-alt" title="Jump back into Course Designer">🛠️ Designer</button>
            </div>
          </div>

          <!-- Next-Gen Frame Rate Counter & Optimization Tips HUD -->
          <div id="perf-fps-hud" class="perf-fps-hud">
            <div class="perf-hud-header">
              <div class="perf-header-left">
                <span class="perf-pulse-dot" id="perf-pulse-dot"></span>
                <span class="perf-title">FPS & PERFORMANCE</span>
              </div>
              <div class="perf-header-right">
                <span id="perf-quality-badge" class="perf-quality-badge badge-optimal">OPTIMAL 60+</span>
                <button id="btn-toggle-perf-tips" class="btn-perf-min" title="Toggle Optimization Tips">▾</button>
              </div>
            </div>

            <div class="perf-metrics-row">
              <div class="perf-metric-primary">
                <span id="perf-fps-num" class="perf-fps-num">60.0</span>
                <span class="perf-fps-unit">FPS</span>
              </div>
              <div class="perf-metric-sub">
                <div class="perf-sub-item">
                  <span class="perf-sub-label">FRAME TIME</span>
                  <span id="perf-frametime-val" class="perf-sub-val">16.6 ms</span>
                </div>
                <div class="perf-sub-item">
                  <span class="perf-sub-label">ACTIVE MESHES</span>
                  <span id="perf-meshes-val" class="perf-sub-val">-- Meshes</span>
                </div>
              </div>
            </div>

            <!-- Frame latency sparkline graph -->
            <div class="perf-sparkline-track" title="Frame pacing telemetry (Last 24 frames)">
              <div id="perf-sparkline-bars" class="perf-sparkline-bars"></div>
            </div>

            <!-- Next-Gen Optimization Tips Box -->
            <div id="perf-tips-container" class="perf-tips-container">
              <div class="perf-tips-top">
                <div class="perf-tips-badge-row">
                  <span class="perf-tips-icon">💡</span>
                  <span class="perf-tips-tag">OPTIMIZATION TIP</span>
                  <span id="perf-tip-counter" class="perf-tip-counter">1/8</span>
                </div>
                <div class="perf-tips-nav">
                  <button id="btn-prev-perf-tip" class="btn-perf-nav" title="Previous Optimization Tip">◀</button>
                  <button id="btn-next-perf-tip" class="btn-perf-nav" title="Next Optimization Tip">▶</button>
                </div>
              </div>
              <div id="perf-tip-content" class="perf-tip-content">
                CSM Soft Shadows auto-stabilize when aiming to lock rock-solid 60+ FPS frame pacing.
              </div>
            </div>
          </div>

          <!-- Next-Gen Gamepad HUD (Bottom-Left Play Mode) -->
          <div id="gamepad-hud" class="gamepad-hud">
            <div class="gamepad-hud-header">
              <div class="gamepad-status-dot" id="gamepad-status-dot"></div>
              <span class="gamepad-status-title" id="gamepad-status-text">Gamepad Ready</span>
              <span class="gamepad-type-badge" id="gamepad-type-badge">Analog Input</span>
            </div>
            <div class="gamepad-controls-grid">
              <div class="pad-control-row">
                <div class="pad-stick-hud"><div class="pad-stick-puck" id="pad-puck-ls"></div></div>
                <span class="pad-key-label">LS Aim Direction</span>
              </div>
              <div class="pad-control-row">
                <span class="pad-key-pill pill-a" id="pad-key-a">A</span>
                <span class="pad-key-label">Swing Strike</span>
              </div>
              <div class="pad-control-row">
                <div class="pad-stick-hud"><div class="pad-stick-puck" id="pad-puck-rs"></div></div>
                <span class="pad-key-label">RS Orbit Cam</span>
              </div>
              <div class="pad-control-row">
                <span class="pad-key-pill pill-b" id="pad-key-b">B</span>
                <span class="pad-key-label">Reset Aim</span>
              </div>
              <div class="pad-control-row">
                <span class="pad-key-pill pill-bumper" id="pad-key-bumpers">LB/RB</span>
                <span class="pad-key-label">Camera View</span>
              </div>
              <div class="pad-control-row">
                <span class="pad-key-pill pill-x" id="pad-key-x">X</span> / <span class="pad-key-pill pill-y" id="pad-key-y">Y</span>
                <span class="pad-key-label">Club Down/Up</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Shot Shaper Controls -->
        <div class="hud-shot-shaper">
          <span class="shot-shaper-title">SHAPE:</span>
          <div class="shot-shaper-buttons">
            <button id="btn-shape-draw" class="btn btn-shaper" title="Draw shot: curves right-to-left [Q]">⤹ Draw [Q]</button>
            <button id="btn-shape-straight" class="btn btn-shaper active" title="Straight shot [W]">⇡ Straight [W]</button>
            <button id="btn-shape-fade" class="btn btn-shaper" title="Fade shot: curves left-to-right [E]">⤵ Fade [E]</button>
          </div>
        </div>

        <!-- 3-Click AAA Swing Meter -->
        <div class="hud-swing-container">
          <div class="swing-feedback" id="hud-swing-feedback">PRESS SPACE / CLICK TO SWING</div>
          <div class="swing-meter-track">
            <!-- Over-hit zone -->
            <div class="meter-zone meter-power-over"></div>
            <!-- Sweetspot power zone -->
            <div class="meter-zone meter-power-sweet"></div>
            <!-- Impact sweet spot zone (11% to 19%) -->
            <div class="meter-impact-zone"></div>
            <!-- Snap hash line with top & bottom target pointers -->
            <div class="meter-snap-line">
              <span class="snap-marker-top">▼</span>
              <span class="snap-marker-bottom">▲</span>
            </div>
            <!-- Dynamic moving meter bar -->
            <div class="swing-meter-bar" id="hud-meter-bar"></div>
            <!-- Locked power reference line -->
            <div class="meter-locked-marker" id="hud-meter-locked" style="display: none;">
              <span class="locked-power-label" id="hud-locked-label">85%</span>
            </div>
            <!-- High-contrast accuracy marker needle -->
            <div class="swing-accuracy-needle" id="hud-meter-needle">
              <span class="needle-tip-top">▼</span>
              <span class="needle-core"></span>
              <span class="needle-tip-bottom">▲</span>
            </div>
          </div>
          <div class="swing-action-bar">
            <button id="btn-swing-action" class="btn btn-swing">
              <span class="swing-main-btn-text">SWING [SPACE]</span>
            </button>
          </div>
          <div class="hud-aim-controls">
            <button id="btn-aim-left" class="btn btn-sm">◀ Aim Left [← / A]</button>
            <button id="btn-aim-right" class="btn btn-sm">Aim Right [→ / D] ▶</button>
            <button id="btn-focus-ball" class="btn btn-sm">⛳ Ball [B]</button>
            <button id="btn-camera-view" class="btn btn-sm">📷 View [C]</button>
            <button id="btn-fullscreen" class="btn btn-sm">⛶ Fullscreen [F]</button>
          </div>
        </div>
      </div>

      <!-- DEVELOPER ZONE RIGHT COLLAPSIBLE DRAWER -->
      <aside id="developer-zone-panel" class="hidden">
        <div class="dev-panel-header">
          <div class="dev-panel-title">
            <span class="dev-icon">🛠️</span>
            <h3>DEVELOPER ZONE</h3>
          </div>
          <button id="btn-toggle-dev-zone" class="btn-dev-collapse" title="Collapse / Expand Developer Zone">✕</button>
        </div>
        <div class="dev-panel-tabs">
          <button class="dev-panel-tab is-active" id="dev-tab-inspector" data-devtab="inspector">
            <span>🛠️</span>
            <span>Inspector</span>
          </button>
          <button class="dev-panel-tab" id="dev-tab-outliner" data-devtab="outliner">
            <span>📑</span>
            <span>Outliner</span>
            <span id="dock-outliner-badge" class="dock-badge">0</span>
          </button>
        </div>
        <div class="dev-panel-body" id="dev-zone-body">
          <div id="dev-pane-inspector" class="dev-tab-pane is-active">
          <!-- History: Undo & Redo -->
          <div class="dev-section" id="dev-history-section" style="padding-bottom: 4px;">
            <div class="dev-section-title">HISTORY (UNDO / REDO)</div>
            <div style="display: flex; gap: 8px;">
              <button id="btn-dev-undo" class="btn btn-secondary btn-sm" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; font-weight: 700;" title="Undo last action (Ctrl+Z)" disabled>
                <span>↩ Undo</span>
                <span style="font-size: 10px; opacity: 0.65; background: rgba(0,0,0,0.3); padding: 1px 4px; border-radius: 3px;">Ctrl+Z</span>
              </button>
              <button id="btn-dev-redo" class="btn btn-secondary btn-sm" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; font-weight: 700;" title="Redo action (Ctrl+Y)" disabled>
                <span>↪ Redo</span>
                <span style="font-size: 10px; opacity: 0.65; background: rgba(0,0,0,0.3); padding: 1px 4px; border-radius: 3px;">Ctrl+Y</span>
              </button>
            </div>
          </div>

          <!-- Transform Gizmo Mode -->
          <div class="dev-section">
            <div class="dev-section-title">TRANSFORM GIZMO</div>
            <div class="dev-gizmo-buttons">
              <button class="btn btn-dev-gizmo active" data-gizmo="none">None [Q]</button>
              <button class="btn btn-dev-gizmo" data-gizmo="position">Move [G]</button>
              <button class="btn btn-dev-gizmo" data-gizmo="rotation">Rotate [R]</button>
              <button class="btn btn-dev-gizmo" data-gizmo="scale">Scale [S]</button>
            </div>
          </div>

          <!-- Selected Object Inspector -->
          <div class="dev-section">
            <div class="dev-section-title">SELECTED OBJECT & 3D MODELS</div>
            <div class="dev-control-row" style="margin-bottom: 8px;">
              <span class="dev-control-lbl">3D Model</span>
              <select id="dev-object-select" class="dev-select" style="flex: 1; background: #0f172a; color: #f8fafc; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; padding: 4px 8px; font-size: 11px;">
                <option value="">-- Click Model in Scene or Pick --</option>
              </select>
            </div>
            <div class="dev-info-box" id="dev-selected-info">
              <div class="dev-info-empty">Click any 3D model, tree, rock, cliff, prop, or course feature to select</div>
            </div>
            <div style="display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap;">
              <button id="btn-dev-select-ground" class="btn btn-secondary btn-sm" style="flex: 1; background: rgba(34, 197, 94, 0.16); border-color: rgba(34, 197, 94, 0.45); color: #86efac;">
                🌱 Select Main Ground
              </button>
              <button id="btn-dev-frame-obj" class="btn btn-secondary btn-sm" style="display: none; flex: 1;">
                🎯 Frame Camera [F]
              </button>
              <button id="btn-dev-delete-obj" class="btn btn-danger btn-sm" style="display: none; flex: 1;">
                🗑️ Delete [Del]
              </button>
              <button id="btn-replace-object-glb" class="btn btn-secondary btn-sm" style="display: none; flex: 1 1 100%; border-color: rgba(56, 189, 248, 0.5); color: #7dd3fc;">
                📦 Replace Selected 3D Model (.glb)
              </button>
              <input type="file" id="input-replace-object-glb" accept=".glb" style="display: none;" />
            </div>
          </div>

          <!-- Course Architecture Features (Slide & Rotate) -->
          <div class="dev-section" id="dev-features-section">
            <div class="dev-section-title">COURSE ARCHITECTURE (Slide & Rotate)</div>
            <div style="font-size: 11px; color: #94a3b8; margin-bottom: 8px; line-height: 1.4;">
              Select greens, fairways, bunkers, tee boxes, or water hazards to slide across ground, rotate, or customize every separate material layer.
            </div>
            <div class="dev-control-row">
              <span class="dev-control-lbl">Feature</span>
              <select id="dev-feature-select" class="dev-select" style="flex: 1; background: #0f172a; color: #f8fafc; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; padding: 4px 8px; font-size: 11px;">
                <option value="-1">-- Click on Course or Pick --</option>
              </select>
            </div>
            <div id="dev-feature-sliders" style="display: none; margin-top: 8px;">
              <div class="dev-control-row">
                <span class="dev-control-lbl">Center X</span>
                <input type="range" id="feat-slide-x" min="0" max="240" step="1" value="0" class="dev-slider" />
                <span id="val-feat-x" class="dev-slider-val">0m</span>
              </div>
              <div class="dev-control-row">
                <span class="dev-control-lbl">Center Z</span>
                <input type="range" id="feat-slide-z" min="0" max="460" step="1" value="0" class="dev-slider" />
                <span id="val-feat-z" class="dev-slider-val">0m</span>
              </div>
              <div class="dev-control-row">
                <span class="dev-control-lbl">Rotate Z (Yaw)</span>
                <input type="range" id="feat-rotate-z" min="0" max="360" step="1" value="0" class="dev-slider" />
                <span id="val-feat-rot" class="dev-slider-val">0°</span>
              </div>

              <!-- Fairway Shape Selector (active when a Fairway is selected) -->
              <div id="feat-fairway-shape-row" style="display: none; margin-top: 8px; padding: 6px; background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 4px;">
                <span class="dev-control-lbl" style="display: block; margin-bottom: 4px; font-weight: 700; color: #38bdf8; font-size: 10px; letter-spacing: 0.4px;">FAIRWAY CONTOUR SHAPE</span>
                <div style="display: flex; gap: 4px;">
                  <button id="btn-fairway-shape-straight" class="btn btn-secondary btn-sm btn-fway-shape" data-shape="straight" style="flex: 1; font-size: 10px; padding: 4px 4px;">⇡ Straight</button>
                  <button id="btn-fairway-shape-left" class="btn btn-secondary btn-sm btn-fway-shape" data-shape="dogleg_left" style="flex: 1; font-size: 10px; padding: 4px 4px;">↩ Left</button>
                  <button id="btn-fairway-shape-right" class="btn btn-secondary btn-sm btn-fway-shape" data-shape="dogleg_right" style="flex: 1; font-size: 10px; padding: 4px 4px;">↪ Right</button>
                </div>
              </div>

              <!-- Bunker Shape Selector (active when a Bunker is selected) -->
              <div id="feat-bunker-shape-row" style="display: none; margin-top: 8px; padding: 6px; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 4px;">
                <span class="dev-control-lbl" style="display: block; margin-bottom: 4px; font-weight: 700; color: #f59e0b; font-size: 10px; letter-spacing: 0.4px;">BUNKER CONTOUR STYLE</span>
                <div style="display: flex; gap: 3px; flex-wrap: wrap;">
                  <button class="btn btn-secondary btn-sm btn-bunker-shape" data-shape="0" style="flex: 1; min-width: 42px; font-size: 9px; padding: 4px 2px;">Kidney 1</button>
                  <button class="btn btn-secondary btn-sm btn-bunker-shape" data-shape="1" style="flex: 1; min-width: 42px; font-size: 9px; padding: 4px 2px;">Kidney 2</button>
                  <button class="btn btn-secondary btn-sm btn-bunker-shape" data-shape="2" style="flex: 1; min-width: 42px; font-size: 9px; padding: 4px 2px;">Scallop</button>
                  <button class="btn btn-secondary btn-sm btn-bunker-shape" data-shape="3" style="flex: 1; min-width: 42px; font-size: 9px; padding: 4px 2px;">Amoeba</button>
                  <button class="btn btn-secondary btn-sm btn-bunker-shape" data-shape="4" style="flex: 1; min-width: 42px; font-size: 9px; padding: 4px 2px;">Waste</button>
                </div>
              </div>

              <div style="display: flex; gap: 6px; margin-top: 8px;">
                <button id="btn-dev-frame-feat" class="btn btn-secondary btn-sm" style="flex: 1;">
                  🎯 Frame Feature [F]
                </button>
                <button id="btn-dev-delete-feat" class="btn btn-danger btn-sm" style="flex: 1;">
                  🗑️ Delete Feature [Del]
                </button>
              </div>
            </div>
          </div>

          <!-- Course Feature Material & UV Settings Inspector -->
          <div class="dev-section" id="dev-feature-material-section" style="display: none;">
            <div class="dev-section-title" id="dev-feat-mat-title">FEATURE MATERIALS</div>
            <div style="font-size: 10px; color: #38bdf8; margin-bottom: 5px; font-weight: 700; letter-spacing: 0.3px;">SEPARATE FEATURE MATERIALS (SELECT LAYER TO EDIT)</div>
            <div id="feat-submat-pills" class="dev-submat-pills"></div>
            
            <div style="font-size: 10px; color: #94a3b8; margin-bottom: 6px; font-weight: 700; letter-spacing: 0.3px;">IMAGE MAPS (PREVIEW & UPLOAD)</div>
            <div class="dev-maps-grid">
              <!-- Color Map -->
              <div class="dev-map-card">
                <div class="dev-map-header">
                  <span class="dev-map-type">COLOR</span>
                  <label class="dev-map-toggle" title="Toggle Base Color Map">
                    <input type="checkbox" id="feat-mat-tex-color" checked />
                  </label>
                </div>
                <div class="dev-map-preview-wrap">
                  <img id="feat-thumb-color" class="dev-map-preview-img" src="/textures/short_grass_01.jpg" alt="Color Map" />
                  <label class="dev-map-upload-overlay" title="Upload custom color texture">
                    <span>📁 Upload</span>
                    <input type="file" id="feat-upload-color" accept="image/*" style="display:none;" />
                  </label>
                </div>
                <div class="dev-map-filename" id="feat-name-color">short_grass_01.jpg</div>
                <label class="dev-map-upload-btn" for="feat-upload-color" title="Upload custom color texture">
                  <span>📁 Upload</span>
                </label>
              </div>

              <!-- Roughness Map -->
              <div class="dev-map-card">
                <div class="dev-map-header">
                  <span class="dev-map-type">ROUGHNESS</span>
                  <label class="dev-map-toggle" title="Toggle Roughness Map">
                    <input type="checkbox" id="feat-mat-tex-rough" checked />
                  </label>
                </div>
                <div class="dev-map-preview-wrap">
                  <img id="feat-thumb-rough" class="dev-map-preview-img" src="/textures/pbr_grass/grass_pbr_rough_512.jpg" alt="Roughness Map" />
                  <label class="dev-map-upload-overlay" title="Upload custom roughness map">
                    <span>📁 Upload</span>
                    <input type="file" id="feat-upload-rough" accept="image/*" style="display:none;" />
                  </label>
                </div>
                <div class="dev-map-filename" id="feat-name-rough">grass_pbr_rough_512.jpg</div>
                <label class="dev-map-upload-btn" for="feat-upload-rough" title="Upload custom roughness map">
                  <span>📁 Upload</span>
                </label>
              </div>

              <!-- Normal Map -->
              <div class="dev-map-card">
                <div class="dev-map-header">
                  <span class="dev-map-type">NORMAL</span>
                  <label class="dev-map-toggle" title="Toggle Normal Map">
                    <input type="checkbox" id="feat-mat-tex-normal" checked />
                  </label>
                </div>
                <div class="dev-map-preview-wrap">
                  <img id="feat-thumb-normal" class="dev-map-preview-img" src="/textures/pbr_grass/grass_pbr_nor_1k.jpg" alt="Normal Map" />
                  <label class="dev-map-upload-overlay" title="Upload custom normal map">
                    <span>📁 Upload</span>
                    <input type="file" id="feat-upload-normal" accept="image/*" style="display:none;" />
                  </label>
                </div>
                <div class="dev-map-filename" id="feat-name-normal">grass_pbr_nor_1k.jpg</div>
                <label class="dev-map-upload-btn" for="feat-upload-normal" title="Upload custom normal map">
                  <span>📁 Upload</span>
                </label>
              </div>
            </div>

            <div class="dev-control-row mt-2">
              <span class="dev-control-lbl">Base Color</span>
              <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
                <input type="color" id="feat-mat-base-color" class="dev-color-input" value="#28a745" />
                <span id="val-feat-base-color" class="dev-color-hex">#28a745</span>
              </div>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">Color Texture</span>
              <input type="range" id="feat-mat-color-tex-level" min="0" max="1" step="0.01" value="0.72" class="dev-slider" />
              <span id="val-feat-color-tex-level" class="dev-slider-val">0.72</span>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">Roughness</span>
              <input type="range" id="feat-mat-rough-level" min="0" max="1" step="0.01" value="0.70" class="dev-slider" />
              <span id="val-feat-rough-level" class="dev-slider-val">0.70</span>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">Metallic</span>
              <input type="range" id="feat-mat-metallic-level" min="0" max="1" step="0.01" value="0.00" class="dev-slider" />
              <span id="val-feat-metallic-level" class="dev-slider-val">0.00</span>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">UV Scale U</span>
              <input type="range" id="feat-mat-uv-scale-u" min="0" max="25.00" step="0.05" value="1.00" class="dev-slider" />
              <span id="val-feat-scale-u" class="dev-slider-val">1.00</span>
            </div>
            <div class="dev-control-row">
              <span class="dev-control-lbl">UV Scale V</span>
              <input type="range" id="feat-mat-uv-scale-v" min="0" max="25.00" step="0.05" value="1.00" class="dev-slider" />
              <span id="val-feat-scale-v" class="dev-slider-val">1.00</span>
            </div>
            <div class="dev-control-row">
              <span class="dev-control-lbl">UV Offset U</span>
              <input type="range" id="feat-mat-uv-offset-u" min="0" max="1.00" step="0.01" value="0.00" class="dev-slider" />
              <span id="val-feat-offset-u" class="dev-slider-val">0.00</span>
            </div>
            <div class="dev-control-row">
              <span class="dev-control-lbl">UV Offset V</span>
              <input type="range" id="feat-mat-uv-offset-v" min="0" max="1.00" step="0.01" value="0.00" class="dev-slider" />
              <span id="val-feat-offset-v" class="dev-slider-val">0.00</span>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">Normal Relief</span>
              <input type="range" id="feat-mat-normal-level" min="0.00" max="2.50" step="0.02" value="0.35" class="dev-slider" />
              <span id="val-feat-normal" class="dev-slider-val">0.35</span>
            </div>

            <!-- Lawn Mowing Stripes & Collar Settings -->
            <div id="feat-mowing-section" style="margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);">
              <div style="font-size: 10px; color: #38bdf8; font-weight: 700; margin-bottom: 6px; letter-spacing: 0.3px;">LAWN MOWING & COLLAR RINGS</div>
              <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                <label class="dev-toggle-chip" id="chip-feat-stripes" style="flex: 1;" title="Toggle alternating lawn mowing stripes">
                  <input type="checkbox" id="feat-mat-stripes-toggle" checked />
                  <span>Mowing Stripes</span>
                </label>
                <label class="dev-toggle-chip" style="flex: 1;" title="Toggle outer fringe/first-cut collar rings and green perimeter border">
                  <input type="checkbox" id="feat-mat-collars-toggle" checked />
                  <span>Collar Rings</span>
                </label>
              </div>
              <div class="dev-control-row" id="row-feat-stripe-width">
                <span class="dev-control-lbl">Stripe Width</span>
                <input type="range" id="feat-mat-stripe-width" min="0" max="5.0" step="0.1" value="1.6" class="dev-slider" />
                <span id="val-feat-stripe-width" class="dev-slider-val">1.6m</span>
              </div>
              <div class="dev-control-row" id="row-feat-stripe-contrast">
                <span class="dev-control-lbl">Stripe Contrast</span>
                <input type="range" id="feat-mat-stripe-contrast" min="0.00" max="1.00" step="0.05" value="0.50" class="dev-slider" />
                <span id="val-feat-stripe-contrast" class="dev-slider-val">50%</span>
              </div>
              <div class="dev-control-row" id="row-feat-collar-width">
                <span class="dev-control-lbl">Collar Width</span>
                <input type="range" id="feat-mat-collar-width" min="0" max="6.0" step="0.1" value="0.5" class="dev-slider" />
                <span id="val-feat-collar-width" class="dev-slider-val">0.5m</span>
              </div>
            </div>

            <button id="btn-reset-feat-mat" class="btn btn-secondary btn-sm btn-block mt-2">
              🔄 Reset Selected Material
            </button>
          </div>

          <!-- 3D Object Material & UV Settings Inspector -->
          <div class="dev-section" id="dev-object-material-section" style="display: none;">
            <div class="dev-section-title" id="dev-obj-mat-title">3D OBJECT MATERIAL</div>
            <div id="obj-submat-pills-wrap" style="display: none;">
              <div style="font-size: 10px; color: #38bdf8; margin-bottom: 5px; font-weight: 700; letter-spacing: 0.3px;">MODEL SUB-MATERIALS</div>
              <div id="obj-submat-pills" class="dev-submat-pills"></div>
            </div>
            
            <div style="font-size: 10px; color: #94a3b8; margin-bottom: 6px; font-weight: 700; letter-spacing: 0.3px;">IMAGE MAPS (PREVIEW & UPLOAD)</div>
            <div class="dev-maps-grid">
              <!-- Color Map -->
              <div class="dev-map-card">
                <div class="dev-map-header">
                  <span class="dev-map-type">COLOR</span>
                  <label class="dev-map-toggle" title="Toggle Base Color Map">
                    <input type="checkbox" id="obj-mat-tex-color" checked />
                  </label>
                </div>
                <div class="dev-map-preview-wrap">
                  <img id="obj-thumb-color" class="dev-map-preview-img" src="/textures/pbr_grass/grass_pbr_diff_1k.jpg" alt="Color Map" />
                  <label class="dev-map-upload-overlay" title="Upload custom color texture">
                    <span>📁 Upload</span>
                    <input type="file" id="obj-upload-color" accept="image/*" style="display:none;" />
                  </label>
                </div>
                <div class="dev-map-filename" id="obj-name-color">model_diff.jpg</div>
                <label class="dev-map-upload-btn" for="obj-upload-color" title="Upload custom color texture">
                  <span>📁 Upload</span>
                </label>
              </div>

              <!-- Roughness Map -->
              <div class="dev-map-card">
                <div class="dev-map-header">
                  <span class="dev-map-type">ROUGHNESS</span>
                  <label class="dev-map-toggle" title="Toggle Roughness Map">
                    <input type="checkbox" id="obj-mat-tex-rough" checked />
                  </label>
                </div>
                <div class="dev-map-preview-wrap">
                  <img id="obj-thumb-rough" class="dev-map-preview-img" src="/textures/pbr_grass/grass_pbr_rough_512.jpg" alt="Roughness Map" />
                  <label class="dev-map-upload-overlay" title="Upload custom roughness map">
                    <span>📁 Upload</span>
                    <input type="file" id="obj-upload-rough" accept="image/*" style="display:none;" />
                  </label>
                </div>
                <div class="dev-map-filename" id="obj-name-rough">model_rough.jpg</div>
                <label class="dev-map-upload-btn" for="obj-upload-rough" title="Upload custom roughness map">
                  <span>📁 Upload</span>
                </label>
              </div>

              <!-- Normal Map -->
              <div class="dev-map-card">
                <div class="dev-map-header">
                  <span class="dev-map-type">NORMAL</span>
                  <label class="dev-map-toggle" title="Toggle Normal Map">
                    <input type="checkbox" id="obj-mat-tex-normal" checked />
                  </label>
                </div>
                <div class="dev-map-preview-wrap">
                  <img id="obj-thumb-normal" class="dev-map-preview-img" src="/textures/pbr_grass/grass_pbr_nor_1k.jpg" alt="Normal Map" />
                  <label class="dev-map-upload-overlay" title="Upload custom normal map">
                    <span>📁 Upload</span>
                    <input type="file" id="obj-upload-normal" accept="image/*" style="display:none;" />
                  </label>
                </div>
                <div class="dev-map-filename" id="obj-name-normal">model_nor.jpg</div>
                <label class="dev-map-upload-btn" for="obj-upload-normal" title="Upload custom normal map">
                  <span>📁 Upload</span>
                </label>
              </div>
            </div>

            <div class="dev-control-row mt-2">
              <span class="dev-control-lbl">Base Color</span>
              <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
                <input type="color" id="obj-mat-base-color" class="dev-color-input" value="#ffffff" />
                <span id="val-obj-base-color" class="dev-color-hex">#ffffff</span>
              </div>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">Color Texture</span>
              <input type="range" id="obj-mat-color-tex-level" min="0" max="1" step="0.01" value="1.00" class="dev-slider" />
              <span id="val-obj-color-tex-level" class="dev-slider-val">1.00</span>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">Roughness</span>
              <input type="range" id="obj-mat-rough-level" min="0" max="1" step="0.01" value="0.65" class="dev-slider" />
              <span id="val-obj-rough-level" class="dev-slider-val">0.65</span>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">Metallic</span>
              <input type="range" id="obj-mat-metallic-level" min="0" max="1" step="0.01" value="0.00" class="dev-slider" />
              <span id="val-obj-metallic-level" class="dev-slider-val">0.00</span>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">UV Scale U</span>
              <input type="range" id="obj-mat-uv-scale-u" min="0" max="25.00" step="0.05" value="1.00" class="dev-slider" />
              <span id="val-obj-scale-u" class="dev-slider-val">1.00</span>
            </div>
            <div class="dev-control-row">
              <span class="dev-control-lbl">UV Scale V</span>
              <input type="range" id="obj-mat-uv-scale-v" min="0" max="25.00" step="0.05" value="1.00" class="dev-slider" />
              <span id="val-obj-scale-v" class="dev-slider-val">1.00</span>
            </div>
            <div class="dev-control-row">
              <span class="dev-control-lbl">UV Offset U</span>
              <input type="range" id="obj-mat-uv-offset-u" min="0" max="1.00" step="0.01" value="0.00" class="dev-slider" />
              <span id="val-obj-offset-u" class="dev-slider-val">0.00</span>
            </div>
            <div class="dev-control-row">
              <span class="dev-control-lbl">UV Offset V</span>
              <input type="range" id="obj-mat-uv-offset-v" min="0" max="1.00" step="0.01" value="0.00" class="dev-slider" />
              <span id="val-obj-offset-v" class="dev-slider-val">0.00</span>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">Normal Relief</span>
              <input type="range" id="obj-mat-normal-level" min="0.00" max="2.50" step="0.02" value="1.00" class="dev-slider" />
              <span id="val-obj-normal" class="dev-slider-val">1.00</span>
            </div>

            <button id="btn-reset-obj-mat" class="btn btn-secondary btn-sm btn-block mt-2">
              🔄 Reset Object Material
            </button>
          </div>

          <!-- Ground PBR Material & UV Settings Inspector -->
          <div class="dev-section" id="dev-ground-pbr-section">
            <div class="dev-section-title">MAIN GROUND MATERIAL (GolfTerrain)</div>
            
            <div style="font-size: 10px; color: #94a3b8; margin-bottom: 6px; font-weight: 700; letter-spacing: 0.3px;">IMAGE MAPS (PREVIEW, TOGGLE & UPLOAD)</div>
            <div class="dev-maps-grid dev-maps-grid-4">
              <!-- Color Map -->
              <div class="dev-map-card">
                <div class="dev-map-header">
                  <span class="dev-map-type">COLOR</span>
                  <label class="dev-map-toggle" title="Toggle Ground Color Map">
                    <input type="checkbox" id="ground-mat-tex-color" checked />
                  </label>
                </div>
                <div class="dev-map-preview-wrap">
                  <img id="ground-thumb-color" class="dev-map-preview-img" src="/textures/pbr_grass/grass_pbr_diff_1k.jpg" onerror="this.onerror=null;this.src='/textures/pbr_grass/grass_pbr_diff_1k.jpg';" alt="Ground Color" />
                  <label class="dev-map-upload-overlay" title="Upload custom ground color texture">
                    <span>📁 Upload</span>
                    <input type="file" id="ground-upload-color" accept="image/*" style="display:none;" />
                  </label>
                </div>
                <div class="dev-map-filename" id="ground-name-color">grass_pbr_diff_1k.jpg</div>
                <label class="dev-map-upload-btn" for="ground-upload-color" title="Upload custom ground color texture">
                  <span>📁 Upload</span>
                </label>
              </div>

              <!-- Roughness Map -->
              <div class="dev-map-card">
                <div class="dev-map-header">
                  <span class="dev-map-type">ROUGH</span>
                  <label class="dev-map-toggle" title="Toggle Ground Roughness Map">
                    <input type="checkbox" id="ground-mat-tex-rough" checked />
                  </label>
                </div>
                <div class="dev-map-preview-wrap">
                  <img id="ground-thumb-rough" class="dev-map-preview-img" src="/textures/pbr_grass/grass_pbr_rough_512.jpg" onerror="this.onerror=null;this.src='/textures/pbr_grass/grass_pbr_rough_512.jpg';" alt="Ground Roughness" />
                  <label class="dev-map-upload-overlay" title="Upload custom ground roughness map">
                    <span>📁 Upload</span>
                    <input type="file" id="ground-upload-rough" accept="image/*" style="display:none;" />
                  </label>
                </div>
                <div class="dev-map-filename" id="ground-name-rough">grass_pbr_rough_512.jpg</div>
                <label class="dev-map-upload-btn" for="ground-upload-rough" title="Upload custom ground roughness map">
                  <span>📁 Upload</span>
                </label>
              </div>

              <!-- Normal Map -->
              <div class="dev-map-card">
                <div class="dev-map-header">
                  <span class="dev-map-type">NORMAL</span>
                  <label class="dev-map-toggle" title="Toggle Ground Normal Map">
                    <input type="checkbox" id="ground-mat-tex-normal" checked />
                  </label>
                </div>
                <div class="dev-map-preview-wrap">
                  <img id="ground-thumb-normal" class="dev-map-preview-img" src="/textures/pbr_grass/grass_pbr_nor_1k.jpg" onerror="this.onerror=null;this.src='/textures/pbr_grass/grass_pbr_nor_1k.jpg';" alt="Ground Normal" />
                  <label class="dev-map-upload-overlay" title="Upload custom ground normal map">
                    <span>📁 Upload</span>
                    <input type="file" id="ground-upload-normal" accept="image/*" style="display:none;" />
                  </label>
                </div>
                <div class="dev-map-filename" id="ground-name-normal">grass_pbr_nor_1k.jpg</div>
                <label class="dev-map-upload-btn" for="ground-upload-normal" title="Upload custom ground normal map">
                  <span>📁 Upload</span>
                </label>
              </div>

              <!-- Satellite Ortho Mix Map -->
              <div class="dev-map-card">
                <div class="dev-map-header">
                  <span class="dev-map-type">SATELLITE</span>
                  <label class="dev-map-toggle" title="Toggle Course Satellite Ortho">
                    <input type="checkbox" id="ground-mat-tex-satellite" />
                  </label>
                </div>
                <div class="dev-map-preview-wrap">
                  <div id="ground-satellite-empty" class="dev-map-empty-placeholder">🛰️ None</div>
                  <img id="ground-thumb-satellite" class="dev-map-preview-img" style="display:none;" alt="Satellite Ortho" />
                  <label class="dev-map-upload-overlay" title="Upload satellite ortho texture">
                    <span>📁 Upload</span>
                    <input type="file" id="ground-upload-satellite" accept="image/*" style="display:none;" />
                  </label>
                </div>
                <div class="dev-map-filename" id="ground-name-satellite">No satellite</div>
                <label class="dev-map-upload-btn" for="ground-upload-satellite" title="Upload satellite ortho texture">
                  <span>📁 Upload</span>
                </label>
              </div>
            </div>

            <div class="dev-control-row mt-2">
              <span class="dev-control-lbl" title="Mix between main PBR grass texture (0%) and satellite ortho map (100%)">Satellite Mix</span>
              <input type="range" id="ground-satellite-mix" min="0" max="100" step="1" value="0" class="dev-slider" />
              <span id="val-ground-satellite-mix" class="dev-slider-val">0%</span>
            </div>

            <div class="dev-control-row mt-2">
              <span class="dev-control-lbl">Base Color</span>
              <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
                <input type="color" id="ground-mat-base-color" class="dev-color-input" value="#ffffff" />
                <span id="val-ground-base-color" class="dev-color-hex">#ffffff</span>
              </div>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">Color Texture</span>
              <input type="range" id="ground-color-tex-level" min="0" max="1" step="0.01" value="1.00" class="dev-slider" />
              <span id="val-ground-color-tex-level" class="dev-slider-val">1.00</span>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">Roughness</span>
              <input type="range" id="ground-rough-level" min="0" max="1" step="0.01" value="0.78" class="dev-slider" />
              <span id="val-ground-rough-level" class="dev-slider-val">0.78</span>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">Metallic</span>
              <input type="range" id="ground-metallic-level" min="0" max="1" step="0.01" value="0.00" class="dev-slider" />
              <span id="val-ground-metallic-level" class="dev-slider-val">0.00</span>
            </div>

            <div class="dev-control-row">
              <span class="dev-control-lbl">UV Scale U</span>
              <input type="range" id="ground-uv-scale-u" min="0" max="1500" step="1" value="110" class="dev-slider" />
              <span id="val-ground-scale-u" class="dev-slider-val">110</span>
            </div>
            <div class="dev-control-row">
              <span class="dev-control-lbl">UV Scale V</span>
              <input type="range" id="ground-uv-scale-v" min="0" max="3000" step="1" value="230" class="dev-slider" />
              <span id="val-ground-scale-v" class="dev-slider-val">230</span>
            </div>
            <div class="dev-control-row">
              <span class="dev-control-lbl">UV Offset U</span>
              <input type="range" id="ground-uv-offset-u" min="0" max="1" step="0.01" value="0" class="dev-slider" />
              <span id="val-ground-offset-u" class="dev-slider-val">0.00</span>
            </div>
            <div class="dev-control-row">
              <span class="dev-control-lbl">UV Offset V</span>
              <input type="range" id="ground-uv-offset-v" min="0" max="1" step="0.01" value="0" class="dev-slider" />
              <span id="val-ground-offset-v" class="dev-slider-val">0.00</span>
            </div>
            <div class="dev-control-row">
              <span class="dev-control-lbl">Normal Relief</span>
              <input type="range" id="ground-normal-level" min="0.00" max="2.50" step="0.02" value="0.45" class="dev-slider" />
              <span id="val-ground-normal" class="dev-slider-val">0.45</span>
            </div>

            <button id="btn-reset-ground-mat" class="btn btn-secondary btn-sm btn-block mt-2">
              🔄 Reset Ground Material
            </button>
          </div>

          <!-- Deploy & Persist Zone Actions -->
          <div class="dev-section">
            <div class="dev-section-title">DEPLOY & PERSIST</div>
            <div style="display: flex; gap: 6px; margin-bottom: 8px;">
              <button id="btn-dev-snap-pin" class="btn btn-dev-action" style="flex: 1; font-size: 11px; padding: 7px 4px; background: rgba(56, 189, 248, 0.16); border: 1px solid rgba(56, 189, 248, 0.45); color: #bae6fd; border-radius: 6px; cursor: pointer; font-weight: 600;">
                🚩 Snap Pin to Green
              </button>
              <button id="btn-dev-snap-tee" class="btn btn-dev-action" style="flex: 1; font-size: 11px; padding: 7px 4px; background: rgba(34, 197, 94, 0.16); border: 1px solid rgba(34, 197, 94, 0.45); color: #bbf7d0; border-radius: 6px; cursor: pointer; font-weight: 600;">
                ⛳ Snap Tee to Box
              </button>
            </div>
            <button id="btn-dev-restore-green-grid" class="btn btn-dev-action btn-block" style="margin-bottom: 8px; font-size: 11px; padding: 7px 6px; background: rgba(34, 197, 94, 0.22); border: 1px solid rgba(34, 197, 94, 0.55); color: #86efac; border-radius: 6px; cursor: pointer; font-weight: 600;">
              🟢 Restore Green, Pin & Slope Grid
            </button>
            <button id="btn-dev-save-default" class="btn btn-dev-action btn-dev-save btn-block">
              💾 Save Default Hole
            </button>
            <button id="btn-dev-reset-default" class="btn btn-dev-action btn-dev-reset btn-block mt-2">
              🔄 Reset to Factory Default
            </button>
          </div>

          <!-- Scenery & Hole Architecture Stats -->
          <div class="dev-section">
            <div class="dev-section-title">SCENERY METRICS</div>
            <div class="dev-stats-grid">
              <div class="dev-stat-card"><span class="dev-stat-val" id="stat-trees-count">0</span><span class="dev-stat-lbl">Trees</span></div>
              <div class="dev-stat-card"><span class="dev-stat-val" id="stat-rocks-count">0</span><span class="dev-stat-lbl">Rocks</span></div>
              <div class="dev-stat-card"><span class="dev-stat-val" id="stat-cliffs-count">0</span><span class="dev-stat-lbl">Cliffs</span></div>
              <div class="dev-stat-card"><span class="dev-stat-val" id="stat-bunkers-count">0</span><span class="dev-stat-lbl">Bunkers</span></div>
              <div class="dev-stat-card"><span class="dev-stat-val" id="stat-tris-count">0</span><span class="dev-stat-lbl">Triangles</span></div>
              <div class="dev-stat-card"><span class="dev-stat-val" id="stat-verts-count">0</span><span class="dev-stat-lbl">Vertices</span></div>
            </div>
          </div>
          </div>

          <!-- Vertical Level Outliner Pane (Moved to Developer Zone) -->
          <div id="dev-pane-outliner" class="dev-tab-pane dev-outliner-pane">
            <div class="outliner-toolbar dev-outliner-toolbar">
              <div class="outliner-search-wrap">
                <span class="outliner-search-icon">🔍</span>
                <input type="text" id="input-outliner-search" placeholder="Filter elements (green, tee, bunker, pine...)" />
              </div>
              <div class="outliner-filter-chips">
                <button class="outliner-chip is-active" data-cat="all">All (<span id="cnt-outliner-all">0</span>)</button>
                <button class="outliner-chip" data-cat="markers">Markers (<span id="cnt-outliner-markers">0</span>)</button>
                <button class="outliner-chip" data-cat="architecture">Arch (<span id="cnt-outliner-arch">0</span>)</button>
                <button class="outliner-chip" data-cat="foliage">Foliage (<span id="cnt-outliner-foliage">0</span>)</button>
                <button class="outliner-chip" data-cat="rocks">Rocks (<span id="cnt-outliner-rocks">0</span>)</button>
              </div>
            </div>

            <div class="outliner-list-container dev-outliner-list" id="outliner-items-list">
              <!-- Dynamically rendered vertical rows -->
            </div>
          </div>
        </div>
      </aside>

      <!-- Next-Gen Designer Bottom Dock (Collapsible Lighting & HDRI Atmosphere) -->
      <div id="designer-bottom-dock" class="designer-bottom-dock hidden">
        <div class="dock-header">
          <div class="dock-tabs">
            <button class="dock-tab is-active" id="dock-tab-lighting" data-tab="lighting">
              <span>☀️</span>
              <span>Lighting & Atmosphere</span>
            </button>
          </div>
          
          <div class="dock-actions">
            <button id="btn-dock-collapse" class="btn-dock-toggle" title="Collapse / Expand Dock [H]">
              <span id="dock-collapse-icon" class="dock-collapse-arrow">▾</span>
              <span id="dock-collapse-text">Collapse</span>
            </button>
          </div>
        </div>

        <div class="dock-body">
          <!-- Tab 1: Lighting & HDRI -->
          <div id="dock-pane-lighting" class="dock-pane is-active">
            <div class="lighting-hdri-col">
              <div class="dock-subhead">
                <span>2K SKYBOX & HDRI PRESETS</span>
                <span class="dock-subtag">2K IBL Resolution</span>
              </div>
              <div class="hdri-cards-carousel" id="hdri-cards-container">
                <!-- Populated dynamically from HDRI_PRESETS -->
              </div>
            </div>

            <div class="dock-vertical-divider"></div>

            <div class="lighting-controls-col">
              <div class="dock-subhead">
                <span>HDRI & SKYBOX TWEAKS</span>
              </div>
              <div class="dock-slider-row">
                <label>HDRI Rotation <span id="val-hdri-rot">0°</span></label>
                <input type="range" id="input-hdri-rot" min="0" max="360" step="1" value="0" />
              </div>
              <label class="dock-check-row" title="Keep directional sunlight and cast shadows synchronized with HDRI sky rotation">
                <input type="checkbox" id="chk-sync-sun-hdri" checked />
                <span>Sync Sun &amp; Shadows with HDRI</span>
              </label>
              <div class="dock-slider-row">
                <label>Sky Exposure / Intensity <span id="val-hdri-intensity">0.65</span></label>
                <input type="range" id="input-hdri-intensity" min="0.1" max="2.5" step="0.05" value="0.65" />
              </div>
              <div class="dock-slider-row">
                <label>HDRI Texture UV Scale <span id="val-hdri-uv-scale">1.00</span></label>
                <input type="range" id="input-hdri-uv-scale" min="0.05" max="10.0" step="0.05" value="1.0" />
              </div>
              <div class="dock-slider-row">
                <label>UV Offset (Width) <span id="val-hdri-uv-offset-u">0.00</span></label>
                <input type="range" id="input-hdri-uv-offset-u" min="-1.0" max="1.0" step="0.02" value="0.0" />
              </div>
              <div class="dock-slider-row">
                <label>UV Offset (Height) <span id="val-hdri-uv-offset-v">0.00</span></label>
                <input type="range" id="input-hdri-uv-offset-v" min="-1.0" max="1.0" step="0.02" value="0.0" />
              </div>
            </div>

            <div class="dock-vertical-divider"></div>

            <div class="lighting-controls-col">
              <div class="dock-subhead">
                <span>SUN & DIRECTIONAL LIGHT</span>
              </div>
              <div class="dock-slider-row">
                <label>Sun Azimuth <span id="val-sun-azimuth">145°</span></label>
                <input type="range" id="input-sun-azimuth" min="0" max="360" step="1" value="145" />
              </div>
              <div class="dock-slider-row">
                <label>Sun Elevation <span id="val-sun-elevation">38°</span></label>
                <input type="range" id="input-sun-elevation" min="5" max="85" step="1" value="38" />
              </div>
              <div class="dock-slider-row">
                <label>Sun Intensity <span id="val-sun-intensity">1.65</span></label>
                <input type="range" id="input-sun-intensity" min="0.2" max="3.0" step="0.05" value="1.65" />
              </div>
              <div class="dock-color-row">
                <label>Sun Light Color</label>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <input type="color" id="input-sun-color" value="#fff5e6" class="dock-color-picker" />
                  <span id="val-sun-color" style="font-family: monospace; font-size: 11px; color: #cbd5e1;">#fff5e6</span>
                </div>
              </div>
              <div class="dock-slider-row">
                <label>Shadow Darkness <span id="val-shadow-darkness">0.22</span></label>
                <input type="range" id="input-shadow-darkness" min="0.0" max="0.75" step="0.02" value="0.22" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- FLOATING DRAGGABLE CONTROLS & TIPS SLIDESHOW MODAL -->
      <div id="tips-floating-modal" class="tips-modal hidden">
        <div class="tips-modal-header" id="tips-modal-header">
          <div class="tips-modal-title">
            <span class="tips-modal-icon">💡</span>
            <span class="tips-modal-heading">CONTROLS & PRO TIPS</span>
            <span id="tips-mode-badge" class="tips-mode-badge">PLAY MODE</span>
          </div>
          <button id="btn-close-tips-modal" class="tips-modal-close" title="Close Guide [Esc]">✕</button>
        </div>
        <div class="tips-modal-body">
          <div id="tips-slide-content" class="tips-slide-content">
            <!-- Rendered 1 screen per tip -->
          </div>
        </div>
        <div class="tips-modal-footer">
          <button id="btn-prev-tip" class="btn btn-sm btn-tips-nav">◀ Prev</button>
          <div class="tips-pagination">
            <span id="tips-slide-counter" class="tips-slide-counter">Tip 1 of 8</span>
            <div id="tips-dots-container" class="tips-dots-container"></div>
          </div>
          <button id="btn-next-tip" class="btn btn-sm btn-tips-nav">Next ▶</button>
        </div>
      </div>

      <!-- MapNG Real-Course Terrain Import Wizard Modal -->
      <div id="modal-mapng-import" class="modal-overlay hidden">
        <div class="mapng-modal-card">
          <div class="mapng-modal-header">
            <div>
              <h3 style="margin: 0; font-size: 16px; color: #38bdf8;">🗺️ Import MapNG Course Bundle</h3>
              <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">Load 16-bit PNG heightmap, satellite ortho texture &amp; export report JSON/MD independently</div>
            </div>
            <button id="btn-close-mapng-modal" class="tips-modal-close" title="Close [Esc]">✕</button>
          </div>

          <div style="margin-bottom: 10px;">
            <label style="display: block; font-size: 11px; font-weight: 700; color: #cbd5e1; margin-bottom: 5px;">
              Quick Multi-File Bundle OR Load Files Separately Below (choosing a file keeps previously loaded files intact):
            </label>
            <input type="file" id="input-mapng-files" multiple accept=".png,.jpg,.jpeg,.webp,.json,.md,.txt" style="width: 100%; padding: 6px 8px; border-radius: 8px; background: rgba(15,23,42,0.85); border: 1px dashed rgba(56,189,248,0.45); color: #e2e8f0; font-size: 12px;" />
            <div class="mapng-separate-inputs">
              <label class="mapng-slot-btn" for="input-mapng-hm">
                <span>⛰️ Heightmap PNG</span>
                <input type="file" id="input-mapng-hm" accept=".png" style="display:none;" />
              </label>
              <label class="mapng-slot-btn mapng-slot-sat" for="input-mapng-sat">
                <span>🛰️ Satellite Ortho</span>
                <input type="file" id="input-mapng-sat" accept=".png,.jpg,.jpeg,.webp" style="display:none;" />
              </label>
              <label class="mapng-slot-btn" for="input-mapng-meta">
                <span>📄 Metadata JSON/MD</span>
                <input type="file" id="input-mapng-meta" accept=".json,.md,.txt" style="display:none;" />
              </label>
            </div>
          </div>

          <div class="mapng-modal-grid">
            <div>
              <canvas id="canvas-mapng-crop" width="280" height="280" class="mapng-crop-canvas"></canvas>
              <div style="font-size: 10px; color: #94a3b8; margin-top: 4px; text-align: center;">
                Drag crop box • Isolated Golf Course Perimeter highlighted (non-golf suburbs excluded)
              </div>
              <div id="mapng-footprint-badge" class="mapng-footprint-badge">
                Course Isolation: Waiting for MapNG tile...
              </div>
            </div>
            <div>
              <div class="mapng-status-list">
                <div id="mapng-status-hm" class="mapng-status-item">Heightmap (16-bit PNG): Not loaded</div>
                <div id="mapng-status-sat" class="mapng-status-item">Satellite Ortho: Optional / Not loaded</div>
                <div id="mapng-status-meta" class="mapng-status-item">Metadata JSON/MD: Defaults (0–78m)</div>
              </div>

              <div class="slider-control" style="margin-top: 8px;">
                <label style="font-size: 11px; color: #cbd5e1;">Hole Window Target (18-Hole Kyalami Presets):</label>
                <select id="select-mapng-kyalami-hole" style="width: 100%; margin-top: 3px; padding: 5px 8px; border-radius: 6px; background: rgba(15,23,42,0.92); color: #e2e8f0; border: 1px solid rgba(56,189,248,0.35); font-size: 11px;">
                  <option value="0">Full Isolated Golf Course (~1400m × 920m surround)</option>
                  ${KYALAMI_COURSE_GUIDE.holes.map(h => `<option value="${h.number}">Hole ${h.number} • Par ${h.par} (${h.distances.yellow}m) • SI ${h.strokeIndex}</option>`).join('')}
                </select>
              </div>

              <div class="slider-control" style="margin-top: 6px;">
                <label>Hole Window Heading: <span id="val-mapng-rotation">0°</span></label>
                <input type="range" id="input-mapng-rotation" min="0" max="355" step="5" value="0" />
              </div>

              <div class="slider-control">
                <label>Elevation Relief Scale: <span id="val-mapng-elev-scale">1.00x</span></label>
                <input type="range" id="input-mapng-elev-scale" min="0.25" max="2.0" step="0.05" value="1.0" />
              </div>

              <div style="font-size: 11px; color: #cbd5e1; margin: 4px 0 8px;">
                Crop Center: <strong id="val-mapng-center">1024m, 1024m</strong>
              </div>

              <label style="display: flex; align-items: center; gap: 8px; font-size: 11px; color: #86efac; margin-bottom: 6px; cursor: pointer; font-weight: 600;">
                <input type="checkbox" id="chk-mapng-isolate-course" checked />
                Identify golf course holes &amp; discard surrounding buildings/streets
              </label>

              <label style="display: flex; align-items: center; gap: 8px; font-size: 11px; color: #e2e8f0; margin-bottom: 6px; cursor: pointer;">
                <input type="checkbox" id="chk-mapng-clear-features" checked />
                Clear procedural features &amp; start fresh for tracing
              </label>

              <label style="display: flex; align-items: center; gap: 8px; font-size: 11px; color: #e2e8f0; margin-bottom: 10px; cursor: pointer;">
                <input type="checkbox" id="chk-mapng-clear-scenery" checked />
                Clear Demo trees/rocks so imported course renders cleanly
              </label>

              <div style="display: flex; flex-direction: column; gap: 6px;">
                <button id="btn-apply-mapng" class="btn btn-primary btn-block" disabled style="padding: 9px 14px; font-weight: 800;">
                  ⚡ Apply MapNG Terrain &amp; Isolated Course
                </button>
                <button id="btn-apply-mapng-sat-only" class="btn btn-secondary btn-block" disabled style="padding: 7px 12px; font-size: 12px;">
                  🛰️ Apply Satellite Texture Only (Keep Terrain)
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Create New Flat Hole / Start Course Dialog -->
      <div id="modal-new-hole" class="modal-overlay hidden">
        <div class="new-hole-modal-card">
          <div class="mapng-modal-header">
            <div>
              <h3 style="margin: 0; font-size: 16px; color: #34d399;">➕ Create Flat Course Hole</h3>
              <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">Keep the Demo Hole intact and start building a flat Par 3, Par 4, or Par 5</div>
            </div>
            <button id="btn-close-new-hole" class="tips-modal-close" title="Close [Esc]">✕</button>
          </div>

          <div class="new-hole-section">
            <label class="new-hole-label">1. Select Hole Par &amp; Flat Playable Length</label>
            <div class="new-hole-par-grid" id="new-hole-par-options">
              <button class="new-hole-par-card" data-par="3">
                <span class="nh-par-num">PAR 3</span>
                <span class="nh-par-len">~155m Flat</span>
                <span class="nh-par-desc">Short iron / tee-to-green template</span>
              </button>
              <button class="new-hole-par-card active" data-par="4">
                <span class="nh-par-num">PAR 4</span>
                <span class="nh-par-len">~365m Flat</span>
                <span class="nh-par-desc">Classic drive + approach runway</span>
              </button>
              <button class="new-hole-par-card" data-par="5">
                <span class="nh-par-num">PAR 5</span>
                <span class="nh-par-len">~490m Flat</span>
                <span class="nh-par-desc">Long championship reach hole</span>
              </button>
            </div>
          </div>

          <div class="new-hole-section">
            <label class="new-hole-label">2. Course Action &amp; Optional Hole Link</label>
            <div class="new-hole-mode-row">
              <label class="new-hole-radio">
                <input type="radio" name="new-hole-mode" value="new_course" checked />
                <span>Start New Course (Hole 1)</span>
              </label>
              <label class="new-hole-radio">
                <input type="radio" name="new-hole-mode" value="add_hole" />
                <span>Append Next Hole to Course</span>
              </label>
            </div>
            <input type="text" id="input-new-course-name" class="new-hole-input" value="Kyalami Country Club" placeholder="Course Name..." />
            <div style="margin-top: 8px; display: flex; gap: 10px; align-items: center;">
              <select id="select-new-kyalami-hole" class="new-hole-input" style="flex: 1;">
                <option value="0">Optional: Link Kyalami Hole Pro Tip &amp; Graphic (None)</option>
                ${KYALAMI_COURSE_GUIDE.holes.map(h => `<option value="${h.number}">Kyalami Hole ${h.number} (Par ${h.par} • ${h.distances.yellow}m)</option>`).join('')}
              </select>
              <label style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: #cbd5e1; white-space: nowrap; cursor: pointer;">
                <input type="checkbox" id="chk-new-hole-blank" />
                Blank flat only
              </label>
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px;">
            <button id="btn-cancel-new-hole" class="btn btn-secondary btn-sm">Cancel</button>
            <button id="btn-confirm-new-hole" class="btn btn-primary btn-sm" style="padding: 8px 18px; font-weight: 800;">
              ✨ Create Flat Hole
            </button>
          </div>
        </div>
      </div>

      <!-- In-App Notification Toast Container (Global across Play & Designer modes) -->
      <div id="hud-toast-container" class="hud-toast-container"></div>
    `;

    // Cache elements
    this.designerPanel = document.getElementById('designer-panel') as HTMLDivElement;
    this.bottomDock = document.getElementById('designer-bottom-dock');
    this.playHUD = document.getElementById('play-hud') as HTMLDivElement;
    this.swingMeterBar = document.getElementById('hud-meter-bar') as HTMLDivElement;
    this.swingIndicator = document.getElementById('hud-meter-needle') as HTMLDivElement;
    this.lockedMarker = document.getElementById('hud-meter-locked') as HTMLDivElement;
    this.lockedLabel = document.getElementById('hud-locked-label') as HTMLElement;
    this.swingFeedback = document.getElementById('hud-swing-feedback') as HTMLDivElement;
    this.distanceToPinLabel = document.getElementById('hud-dist-to-pin') as HTMLElement;
    this.lieBadge = document.getElementById('hud-lie-badge') as HTMLElement;
    this.clubNameLabel = document.getElementById('hud-club-name') as HTMLElement;
    this.clubLoftLabel = document.getElementById('hud-club-loft') as HTMLElement;
    this.clubCarryLabel = document.getElementById('hud-club-carry') as HTMLElement;
    this.windSpeedLabel = document.getElementById('hud-wind-speed') as HTMLElement;
    this.windArrow = document.getElementById('hud-wind-arrow') as HTMLElement;
    this.holeTitleLabel = document.getElementById('hud-hole-title') as HTMLElement;
    this.holeParLabel = document.getElementById('hud-hole-par') as HTMLElement;
    this.strokeCounterLabel = document.getElementById('hud-strokes') as HTMLElement;

    this.renderPresets('all');
  }

  public renderPresets(category: string) {
    const grid = document.getElementById('preset-grid-container');
    if (!grid) return;

    const filtered = category === 'all'
      ? PRESET_FEATURES
      : PRESET_FEATURES.filter(p => p.category === category);

    grid.innerHTML = filtered.map((p, idx) => `
      <div class="preset-card ${idx === 0 ? 'selected' : ''}" data-preset-id="${p.id}">
        <span class="preset-icon">${p.icon}</span>
        <div class="preset-info">
          <div class="preset-title">${p.name}</div>
          <div class="preset-desc">${p.description}</div>
        </div>
      </div>
    `).join('');

    // Attach card click handlers
    grid.querySelectorAll('.preset-card').forEach(card => {
      card.addEventListener('click', () => {
        grid.querySelectorAll('.preset-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        const id = card.getAttribute('data-preset-id');
        const preset = PRESET_FEATURES.find(p => p.id === id);
        if (preset) this.callbacks.onPresetSelect(preset);
      });
    });
  }

  public isMainMenuOpen(): boolean {
    return this.isMainMenuVisible;
  }

  public openCourseGuide(holeNumber?: number) {
    if (!this.courseGuideModal) return;
    if (holeNumber !== undefined) {
      this.courseGuideModal.open(holeNumber);
    } else {
      this.courseGuideModal.toggle();
    }
    this.callbacks.onToggleCourseGuide?.();
  }

  public updateCourseGuideTelemetry(telemetry: CourseGuideTelemetry) {
    this.courseGuideModal?.updateTelemetry(telemetry);
  }

  public syncSatelliteUi(pct: number) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    const sOpacity = document.getElementById('input-satellite-opacity') as HTMLInputElement | null;
    const vOpacity = document.getElementById('val-satellite-opacity');
    if (sOpacity) sOpacity.value = String(clamped);
    if (vOpacity) vOpacity.innerText = `${clamped}%`;

    const sMix = document.getElementById('ground-satellite-mix') as HTMLInputElement | null;
    const vMix = document.getElementById('val-ground-satellite-mix');
    if (sMix) sMix.value = String(clamped);
    if (vMix) vMix.innerText = `${clamped}%`;
  }

  public updateHolesList(holes: GolfHole[], activeIndex: number) {
    const container = document.getElementById('hole-tabs');
    if (container) {
      container.innerHTML = holes.map((h, i) => `
        <button class="hole-tab-btn ${i === activeIndex ? 'active' : ''}" data-hole-idx="${i}">
          ${h.isDemo ? 'Demo Hole' : `Hole ${h.number}`} (Par ${h.par})
        </button>
      `).join('');

      container.querySelectorAll('.hole-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.getAttribute('data-hole-idx') || '0', 10);
          this.callbacks.onHoleSelect(idx);
        });
      });
    }

    const activeHole = holes[activeIndex] || holes[0];
    const playMenuLbl = document.querySelector('#btn-menu-play .menu-option-label');
    if (playMenuLbl && activeHole) {
      playMenuLbl.textContent = activeHole.isDemo ? 'PLAY DEMO HOLE' : `PLAY HOLE ${activeHole.number}`;
    }
  }

  public updateHUD(
    distMeters: number,
    lie: SurfaceType,
    club: ClubSpec,
    strokes: number,
    hole: GolfHole,
    windMps: number,
    windDeg: number
  ) {
    this.distanceToPinLabel.innerHTML = `${Math.round(distMeters)}<span class="unit">m</span>`;
    const ydsElem = document.getElementById('hud-dist-yards');
    if (ydsElem) ydsElem.innerText = `${Math.round(distMeters)}m to pin`;

    this.strokeCounterLabel.innerText = `${strokes}`;
    this.holeTitleLabel.innerText = hole.isDemo
      ? `Demo Hole: ${hole.name}`
      : `Hole ${hole.number}: ${hole.name}`;
    this.holeParLabel.innerText = `PAR ${hole.par}`;

    // Lie badge
    const lieProps = SURFACE_PROPERTIES[lie];
    this.lieBadge.innerText = lieProps.name;
    this.lieBadge.className = `badge-lie badge-${lieProps.name.toLowerCase().replace(/\s+/g, '-')}`;

    // Club
    this.clubNameLabel.innerText = club.name;
    this.clubLoftLabel.innerText = `Loft: ${club.loftDegrees}°`;
    const maxPrefix = club.id === 'driver' ? 'Max: 300m • ' : '';
    this.clubCarryLabel.innerText = `${maxPrefix}Typical: ${club.typicalCarryMeters}m`;
    this.updateClubCard(club.id);

    // Wind
    this.windSpeedLabel.innerText = `${windMps.toFixed(1)} m/s (${Math.round(windMps * 2.23694)} mph)`;
    this.windArrow.style.transform = `rotate(${windDeg}deg)`;
  }

  public updateOverheadLayout(data: OverheadLayoutData) {
    this.overheadLayout?.update(data);
  }

  public updateSwingMeter(progress: number, phase: SwingPhase, lockedPower?: number | null) {
    const swingBtnText = document.querySelector('.swing-main-btn-text') as HTMLElement;

    if (phase === SwingPhase.IDLE) {
      this.swingMeterBar.style.width = '0%';
      this.lockedMarker.style.display = 'none';
      this.swingIndicator.style.left = '15%';
      this.swingIndicator.classList.remove('downswing-active');
      this.swingFeedback.innerText = 'PRESS SPACE / CLICK TO SWING';
      this.swingFeedback.className = 'swing-feedback';
      if (swingBtnText) swingBtnText.innerText = 'SWING [SPACE]';
    } else if (phase === SwingPhase.BACKSWING) {
      const pct = Math.max(0, Math.min(100, progress * 100));
      this.swingMeterBar.style.width = `${pct}%`;
      this.swingIndicator.style.left = `${pct}%`;
      this.lockedMarker.style.display = 'none';
      this.swingIndicator.classList.remove('downswing-active');
      this.swingFeedback.innerText = `BACKSWING: ${Math.round(pct)}% (CLICK TO LOCK POWER)`;
      this.swingFeedback.className = 'swing-feedback feedback-active';
      if (swingBtnText) swingBtnText.innerText = 'LOCK POWER!';
    } else if (phase === SwingPhase.DOWNSWING) {
      // Progress goes down towards 0.0, needle travels across width
      const needlePct = Math.max(0, Math.min(100, progress * 100));
      this.swingIndicator.style.left = `${needlePct}%`;
      this.swingIndicator.classList.add('downswing-active');

      if (lockedPower != null) {
        const lockPct = Math.max(15, Math.min(100, lockedPower * 100));
        this.lockedMarker.style.display = 'flex';
        this.lockedMarker.style.left = `${lockPct}%`;
        this.lockedLabel.innerText = `${Math.round(lockPct)}%`;
        this.swingMeterBar.style.width = `${lockPct}%`;
      }

      this.swingFeedback.innerText = 'DOWNSWING: CLICK ON WHITE IMPACT LINE!';
      this.swingFeedback.className = 'swing-feedback feedback-snap';
      if (swingBtnText) swingBtnText.innerText = 'SNAP STRIKE!';
    } else if (phase === SwingPhase.COMPLETE) {
      this.swingFeedback.innerText = 'STRIKE!';
      if (swingBtnText) swingBtnText.innerText = 'SHOT DISPATCHED!';
    }
  }

  public setSwingFeedbackText(text: string, type: 'perfect' | 'great' | 'draw' | 'fade' | 'hook' | 'slice' | 'miss') {
    this.swingFeedback.innerText = text;
    this.swingFeedback.className = `swing-feedback feedback-${type}`;
  }

  public updateShotStats(carry: number, total: number, isFinal = false) {
    const badge = document.getElementById('hud-shot-tracker');
    const totalLabel = document.getElementById('hud-shot-total');
    const breakdownLabel = document.getElementById('hud-shot-breakdown');
    if (!badge || !totalLabel || !breakdownLabel) return;

    if (total <= 1.5) {
      badge.style.display = 'none';
      return;
    }

    badge.style.display = 'flex';
    const totalMeters = Math.round(total);
    const carryMeters = Math.round(carry || total);
    const rollMeters = Math.max(0, totalMeters - carryMeters);

    totalLabel.innerHTML = `${totalMeters}m`;
    breakdownLabel.innerText = isFinal
      ? `Carry: ${carryMeters}m | Roll: ${rollMeters}m`
      : `In flight... ${totalMeters}m`;
  }

  public showBackspinTimingPrompt(active: boolean) {
    const el = document.getElementById('hud-backspin-indicator');
    const title = document.getElementById('backspin-badge-title');
    const tag = document.getElementById('backspin-rating-tag');
    const prompt = document.getElementById('backspin-prompt-text');
    const level = document.getElementById('backspin-meter-level');
    if (!el || !title || !tag || !prompt || !level) return;

    if (active) {
      el.classList.remove('hidden', 'locked', 'bite');
      title.innerText = 'BACKSPIN TIMING';
      tag.innerText = 'READY';
      tag.className = 'backspin-rating-tag';
      prompt.innerText = 'SCROLL ▾ BACKWARDS AT GREEN BOUNCE';
      level.style.width = '25%';
    } else {
      el.classList.add('hidden');
    }
  }

  public showBackspinLocked(intensity: number, rating: 'PERFECT' | 'GREAT' | 'GOOD') {
    const el = document.getElementById('hud-backspin-indicator');
    const title = document.getElementById('backspin-badge-title');
    const tag = document.getElementById('backspin-rating-tag');
    const prompt = document.getElementById('backspin-prompt-text');
    const level = document.getElementById('backspin-meter-level');
    if (!el || !title || !tag || !prompt || !level) return;

    el.classList.remove('hidden');
    el.classList.add('locked');
    title.innerText = 'BACKSPIN LOCKED!';
    tag.innerText = rating;
    tag.className = 'backspin-rating-tag perfect';
    const estimatedRPM = Math.round(7200 + intensity * 3600);
    prompt.innerText = `${estimatedRPM.toLocaleString()} RPM • REVERSE BITE ARMED`;
    level.style.width = `${Math.round(intensity * 100)}%`;
  }

  public showBackspinBiteEngaged(intensity: number) {
    const el = document.getElementById('hud-backspin-indicator');
    const title = document.getElementById('backspin-badge-title');
    const tag = document.getElementById('backspin-rating-tag');
    const prompt = document.getElementById('backspin-prompt-text');
    const level = document.getElementById('backspin-meter-level');
    if (!el || !title || !tag || !prompt || !level) return;

    el.classList.remove('hidden', 'locked');
    el.classList.add('bite');
    title.innerText = '⚡ BITE & REVERSE!';
    tag.innerText = 'ACTIVE';
    tag.className = 'backspin-rating-tag bite';
    prompt.innerText = `SPINNING BACK • ${Math.round(intensity * 100)}% POWER`;
    level.style.width = '100%';

    setTimeout(() => {
      el.classList.add('hidden');
    }, 2400);
  }

  public updateClubCard(clubId: string, isBallInMotion = false) {
    const driverCard = document.getElementById('club-card-driver');
    const putterCard = document.getElementById('club-card-putter');
    if (!driverCard || !putterCard) return;

    if (this.currentMode === 'designer' || isBallInMotion) {
      driverCard.classList.add('fade-out');
      putterCard.classList.add('fade-out');
      driverCard.classList.add('hidden');
      putterCard.classList.add('hidden');
      return;
    }

    if (clubId === 'driver') {
      putterCard.classList.add('hidden');
      putterCard.classList.add('fade-out');
      driverCard.classList.remove('hidden');
      driverCard.classList.remove('fade-out');
    } else if (clubId === 'putter') {
      driverCard.classList.add('hidden');
      driverCard.classList.add('fade-out');
      putterCard.classList.remove('hidden');
      putterCard.classList.remove('fade-out');
    } else {
      driverCard.classList.add('hidden');
      driverCard.classList.add('fade-out');
      putterCard.classList.add('hidden');
      putterCard.classList.add('fade-out');
    }
  }

  public setSwingEnabled(enabled: boolean) {
    this.isSwingEnabled = enabled;
    const swingBtn = document.getElementById('btn-swing-action') as HTMLButtonElement | null;
    const swingBtnText = document.querySelector('.swing-main-btn-text') as HTMLElement | null;
    if (swingBtn) {
      swingBtn.disabled = !enabled;
      if (!enabled) {
        swingBtn.classList.add('btn-swing-disabled');
        if (swingBtnText) swingBtnText.innerText = 'BALL IN FLIGHT...';
        this.swingFeedback.innerText = 'BALL IN MOTION — FREE ORBIT CAMERA ACTIVE';
        this.swingFeedback.className = 'swing-feedback feedback-active';
      } else {
        swingBtn.classList.remove('btn-swing-disabled');
        if (swingBtnText) swingBtnText.innerText = 'SWING [SPACE]';
        this.swingFeedback.innerText = 'PRESS SPACE / CLICK TO SWING';
        this.swingFeedback.className = 'swing-feedback';
      }
    }
  }

  public updateAimStats(targetDistMeters: number, elevationDiffMeters: number) {
    const distElem = document.getElementById('hud-aim-target-dist');
    const elevElem = document.getElementById('hud-aim-elev');
    if (distElem) {
      distElem.innerText = `TARGET: ${Math.round(targetDistMeters)}m`;
    }
    if (elevElem) {
      const sign = elevationDiffMeters >= 0 ? '+' : '';
      elevElem.innerText = `ELEV: ${sign}${elevationDiffMeters.toFixed(1)}m`;
    }
  }

  public showToast(message: string, type: 'info' | 'warning' | 'penalty' | 'success' = 'info', durationMs = 3500) {
    const toastContainer = document.getElementById('hud-toast-container');
    if (!toastContainer) return;

    const toast = document.createElement('div');
    toast.className = `hud-toast hud-toast-${type}`;
    toast.innerText = message;
    toastContainer.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('hud-toast-visible');
    });

    setTimeout(() => {
      toast.classList.remove('hud-toast-visible');
      setTimeout(() => toast.remove(), 400);
    }, durationMs);
  }

  public showTerraformingLoader(label = 'Conforming 3D Terrain & Analytical Collars...') {
    const overlay = document.getElementById('terraforming-overlay');
    const title = document.getElementById('terraforming-title');
    const sub = document.getElementById('terraforming-sub');
    const bar = document.getElementById('terraforming-bar');
    if (!overlay) return;
    overlay.classList.remove('is-complete', 'hidden');
    if (title) title.textContent = 'TERRAFORMING';
    if (sub) sub.textContent = label;
    if (bar) bar.style.width = '38%';
  }

  public completeTerraformingLoader(): Promise<void> {
    return new Promise((resolve) => {
      const overlay = document.getElementById('terraforming-overlay');
      const title = document.getElementById('terraforming-title');
      const sub = document.getElementById('terraforming-sub');
      const bar = document.getElementById('terraforming-bar');
      if (!overlay) {
        resolve();
        return;
      }
      overlay.classList.add('is-complete');
      if (title) title.textContent = 'TERRAFORMING COMPLETE';
      if (sub) sub.textContent = '3D Terrain & Collars Updated';
      if (bar) bar.style.width = '100%';
      setTimeout(() => {
        overlay.classList.add('hidden');
        setTimeout(() => {
          overlay.classList.remove('is-complete');
          if (bar) bar.style.width = '18%';
          resolve();
        }, 200);
      }, 220);
    });
  }

  public showHoleCompleteModal(
    score: HoleScore,
    isCourseComplete: boolean,
    onNext: () => void,
    onReplay: () => void
  ) {
    const existing = document.getElementById('modal-hole-complete');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modal-hole-complete';
    modal.className = 'modal-overlay';

    const diff = score.strokes - score.par;
    const badgeClass = diff <= -2 ? 'badge-eagle' :
                       diff === -1 ? 'badge-birdie' :
                       diff === 0 ? 'badge-par' : 'badge-bogey';

    modal.innerHTML = `
      <div class="modal-card celebration-card">
        <div class="celebration-confetti">✨ ⛳ 🎉</div>
        <h2 class="celebration-title">HOLE ${score.holeNumber} COMPLETED!</h2>
        <div class="score-badge ${badgeClass}">${score.scoreText}</div>

        <div class="celebration-stats-grid">
          <div class="stat-col">
            <div class="stat-val">${score.strokes}</div>
            <div class="stat-lbl">STROKES</div>
          </div>
          <div class="stat-divider"></div>
          <div class="stat-col">
            <div class="stat-val">${score.par}</div>
            <div class="stat-lbl">PAR</div>
          </div>
          <div class="stat-divider"></div>
          <div class="stat-col">
            <div class="stat-val">${score.putts}</div>
            <div class="stat-lbl">PUTTS</div>
          </div>
        </div>

        <div class="celebration-actions">
          ${!isCourseComplete ? `
            <button id="btn-next-hole" class="btn btn-celebration-next">
              NEXT HOLE ➔
            </button>
          ` : `
            <button id="btn-finish-round" class="btn btn-celebration-next">
              ROUND COMPLETE 🏆
            </button>
          `}
          <button id="btn-replay-hole" class="btn btn-celebration-replay">
            ↺ REPLAY HOLE
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('btn-next-hole')?.addEventListener('click', () => {
      modal.remove();
      onNext();
    });

    document.getElementById('btn-finish-round')?.addEventListener('click', () => {
      modal.remove();
      onNext();
    });

    document.getElementById('btn-replay-hole')?.addEventListener('click', () => {
      modal.remove();
      onReplay();
    });
  }

  public showCourseBrandingModal(
    courseName: string = 'Kyalami Country Club',
    tagline: string = 'Championship 18-Hole Parkland Course',
    logoUrl?: string
  ) {
    const existing = document.getElementById('modal-course-branding');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modal-course-branding';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card" style="max-width: 480px; width: 92%; padding: 24px; background: #0f172a; border: 1px solid #334155; border-radius: 12px; color: #f8fafc; box-shadow: 0 20px 50px rgba(0,0,0,0.8);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #334155; padding-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 24px;">🏷️</span>
            <div>
              <h3 style="margin: 0; font-size: 16px; font-weight: 800; color: #38bdf8;">COURSE BRANDING & LOGO</h3>
              <div style="font-size: 11px; color: #94a3b8;">Customize club crest, header branding & main menu presentation</div>
            </div>
          </div>
          <button id="btn-close-branding-modal" style="background: none; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 4px;">✕</button>
        </div>

        <div style="display: flex; flex-direction: column; gap: 14px;">
          <div>
            <label style="font-size: 10px; font-weight: 700; color: #94a3b8; display: block; margin-bottom: 4px;">GOLF CLUB / COURSE NAME</label>
            <input type="text" id="input-brand-course-name" value="${courseName}" style="width: 100%; padding: 8px 10px; background: #1e293b; border: 1px solid #334155; border-radius: 4px; color: #f8fafc; font-weight: 700; font-size: 14px;" />
          </div>

          <div>
            <label style="font-size: 10px; font-weight: 700; color: #94a3b8; display: block; margin-bottom: 4px;">SUBTITLE / TAGLINE</label>
            <input type="text" id="input-brand-tagline" value="${tagline}" style="width: 100%; padding: 8px 10px; background: #1e293b; border: 1px solid #334155; border-radius: 4px; color: #f8fafc; font-size: 12px;" />
          </div>

          <!-- Logo Upload & Preview -->
          <div>
            <label style="font-size: 10px; font-weight: 700; color: #94a3b8; display: block; margin-bottom: 4px;">GOLF COURSE CREST / LOGO (PREDEFINED 256x256 OR BANNER)</label>
            <div style="display: flex; gap: 12px; align-items: center; padding: 12px; background: rgba(30, 41, 59, 0.5); border: 1px solid #334155; border-radius: 6px;">
              <div id="brand-logo-preview-box" style="width: 64px; height: 64px; border-radius: 8px; background: #1e293b; border: 2px dashed #475569; display: flex; align-items: center; justify-content: center; overflow: hidden;">
                ${logoUrl ? `<img id="brand-logo-preview-img" src="${logoUrl}" style="width: 100%; height: 100%; object-fit: contain;" />` : `<span id="brand-logo-preview-placeholder" style="font-size: 28px;">⛳</span>`}
              </div>
              <div style="flex: 1;">
                <label for="input-brand-logo-file" class="btn btn-secondary btn-sm" style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer; padding: 6px 12px;">
                  <span>📁 Upload Logo...</span>
                </label>
                <input type="file" id="input-brand-logo-file" accept="image/*" style="display: none;" />
                <div style="font-size: 10px; color: #94a3b8; margin-top: 4px;">Recommended: Transparent PNG or SVG (Square or Crest)</div>
              </div>
            </div>
          </div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; border-top: 1px solid #334155; padding-top: 14px;">
          <button id="btn-cancel-branding" class="btn btn-secondary">Cancel</button>
          <button id="btn-save-branding" class="btn btn-primary" style="background: #38bdf8; color: #022c22; font-weight: 800; border: none;">
            💾 Apply Branding
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    let currentLogoDataUrl: string | undefined = logoUrl;
    const fileInput = document.getElementById('input-brand-logo-file') as HTMLInputElement | null;
    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          currentLogoDataUrl = e.target?.result as string;
          const box = document.getElementById('brand-logo-preview-box');
          if (box && currentLogoDataUrl) {
            box.innerHTML = `<img src="${currentLogoDataUrl}" style="width: 100%; height: 100%; object-fit: contain;" />`;
          }
        };
        reader.readAsDataURL(file);
      }
    });

    const closeModal = () => modal.remove();
    document.getElementById('btn-close-branding-modal')?.addEventListener('click', closeModal);
    document.getElementById('btn-cancel-branding')?.addEventListener('click', closeModal);

    document.getElementById('btn-save-branding')?.addEventListener('click', () => {
      const cName = (document.getElementById('input-brand-course-name') as HTMLInputElement)?.value || 'Kyalami Country Club';
      const tag = (document.getElementById('input-brand-tagline') as HTMLInputElement)?.value || '';

      modal.remove();
      this.callbacks.onCourseBrandingChange?.({
        courseName: cName,
        tagline: tag,
        logoUrl: currentLogoDataUrl
      });
      this.showToast(`Applied branding: ${cName}! 🏷️`, 'success');
    });
  }

  public showDeployVercelModal() {
    const existing = document.getElementById('modal-deploy-vercel');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'modal-deploy-vercel';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card" style="max-width: 520px; width: 92%; padding: 24px; background: #0f172a; border: 1px solid #334155; border-radius: 12px; color: #f8fafc; box-shadow: 0 20px 50px rgba(0,0,0,0.8);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #334155; padding-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 24px;">🚀</span>
            <div>
              <h3 style="margin: 0; font-size: 16px; font-weight: 800; color: #00ffcc;">DEPLOY TO VERCEL</h3>
              <div style="font-size: 11px; color: #94a3b8;">Publish your 18-hole golf course as a live high-speed WebGL game</div>
            </div>
          </div>
          <button id="btn-close-deploy-modal" style="background: none; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 4px;">✕</button>
        </div>

        <div style="display: flex; flex-direction: column; gap: 12px; font-size: 12px;">
          <div style="padding: 12px; background: rgba(0, 255, 204, 0.08); border: 1px solid rgba(0, 255, 204, 0.25); border-radius: 6px;">
            <div style="font-weight: 700; color: #00ffcc; margin-bottom: 4px;">⚡ 2K PBR Materials & Zero-Lag Production Build</div>
            <div style="color: #94a3b8; font-size: 11px;">All textures have been optimized to 2K, reducing bundle size by 75% for instant mobile & desktop streaming!</div>
          </div>

          <div style="font-weight: 700; color: #f8fafc;">DEPLOYMENT IN 3 SIMPLE STEPS:</div>

          <div style="display: flex; gap: 10px; align-items: flex-start;">
            <div style="background: #1e293b; border-radius: 50%; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #38bdf8; flex-shrink: 0;">1</div>
            <div>
              <strong>Save your latest course layout:</strong>
              <div style="color: #94a3b8; font-size: 11px;">Save project to disk or click Push to Play to persist all 18 holes to default storage.</div>
            </div>
          </div>

          <div style="display: flex; gap: 10px; align-items: flex-start;">
            <div style="background: #1e293b; border-radius: 50%; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #38bdf8; flex-shrink: 0;">2</div>
            <div>
              <strong>Push to GitHub Repository:</strong>
              <div style="background: #1e293b; padding: 6px 10px; border-radius: 4px; font-family: monospace; color: #e2e8f0; margin-top: 4px; font-size: 11px;">
                git add .<br/>git commit -m "Deploy 18-hole championship course"<br/>git push
              </div>
            </div>
          </div>

          <div style="display: flex; gap: 10px; align-items: flex-start;">
            <div style="background: #1e293b; border-radius: 50%; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #38bdf8; flex-shrink: 0;">3</div>
            <div>
              <strong>Deploy with Vercel CLI (or link in Vercel Dashboard):</strong>
              <div style="background: #1e293b; padding: 6px 10px; border-radius: 4px; font-family: monospace; color: #00ffcc; margin-top: 4px; font-size: 11px;">
                npx vercel --prod
              </div>
            </div>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 20px; border-top: 1px solid #334155; padding-top: 14px;">
          <button id="btn-deploy-download-json" class="btn btn-secondary btn-sm" style="display: flex; align-items: center; gap: 6px;">
            <span>💾</span> Download Course JSON
          </button>
          <button id="btn-close-deploy" class="btn btn-primary" style="background: #00ffcc; color: #022c22; font-weight: 800; border: none;">
            Got it! 🚀
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const closeModal = () => modal.remove();
    document.getElementById('btn-close-deploy-modal')?.addEventListener('click', closeModal);
    document.getElementById('btn-close-deploy')?.addEventListener('click', closeModal);
    document.getElementById('btn-deploy-download-json')?.addEventListener('click', () => {
      this.callbacks.onSaveProjectDisk?.();
    });
  }

  public updateHeaderBranding(courseName: string, logoUrl?: string) {
    const textEl = document.getElementById('header-logo-text');
    const iconEl = document.getElementById('header-logo-icon');
    if (textEl) {
      textEl.innerHTML = `${courseName.toUpperCase()} <span class="badge" style="background: rgba(0, 255, 204, 0.2); border: 1px solid #00ffcc; color: #00ffcc; font-size: 10px; padding: 2px 6px; border-radius: 4px; vertical-align: middle; margin-left: 6px;">2.0</span>`;
    }
    if (iconEl && logoUrl) {
      iconEl.innerHTML = `<img src="${logoUrl}" style="width: 22px; height: 22px; object-fit: contain; vertical-align: middle; border-radius: 4px;" />`;
    }
    const menuTitle = document.querySelector('.menu-brand-title');
    if (menuTitle) {
      menuTitle.textContent = `${courseName.toUpperCase()} 2.0`;
    }
  }

  private createMainMenuOverlay() {
    const existing = document.getElementById('main-menu-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'main-menu-overlay';
    overlay.className = 'main-menu-overlay hidden is-locked';
    overlay.innerHTML = `
      <div class="menu-bg-layer">
        <img class="menu-bg-slide active" decoding="async" src="/images/menu/menu_bg_1.jpg" alt="Coastal Links Course" />
        <img class="menu-bg-slide" decoding="async" src="/images/menu/menu_bg_2.jpg" alt="Desert Windmill Course" />
        <img class="menu-bg-slide" decoding="async" src="/images/menu/menu_bg_3.jpg" alt="Red Rock Canyon Course" />
      </div>
      <div class="menu-scrim"></div>

      <div class="menu-brand-header">
        <div class="menu-brand-title">FAIRWAY STUDIO 2.0</div>
        <div class="menu-brand-sub">
          <span class="menu-brand-line"></span>
          <span class="menu-brand-tag">3D PRO</span>
          <span class="menu-brand-line"></span>
        </div>
      </div>

      <!-- Center-Screen Passcode Login Gate -->
      <div id="menu-login-gate" class="menu-login-gate" role="dialog" aria-label="Course Access Login">
        <div class="menu-login-emblem">🔐</div>
        <div class="menu-login-heading">CLUBHOUSE LOGIN</div>
        <div class="menu-login-sub">Enter password to unlock main menu</div>
        <form id="menu-login-form" class="menu-login-form" autocomplete="off">
          <div class="menu-login-input-wrap">
            <input
              type="password"
              id="menu-login-password"
              class="menu-login-input"
              placeholder="Password"
              autocomplete="off"
              aria-label="Password"
            />
            <button id="btn-login-toggle-vis" type="button" class="menu-login-eye" title="Show / Hide Password">👁</button>
          </div>
          <div id="menu-login-error" class="menu-login-error" aria-live="polite"></div>
          <button id="btn-menu-login" type="submit" class="menu-login-submit">ENTER CLUBHOUSE</button>
        </form>
      </div>

      <nav class="menu-glass-card" aria-label="Main Menu">
        <button id="btn-menu-play" type="button" class="menu-option-btn is-active" data-menu-idx="0">
          <span class="menu-option-icon" aria-hidden="true">
            <svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="18" cy="18" r="15.5" />
              <polygon points="15,12 25,18 15,24" fill="none" stroke-linejoin="round" />
            </svg>
          </span>
          <span class="menu-option-label">PLAY HOLE 1</span>
        </button>

        <div class="menu-card-divider"></div>

        <button id="btn-menu-designer" type="button" class="menu-option-btn" data-menu-idx="1">
          <span class="menu-option-icon" aria-hidden="true">
            <svg viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 6H9a3 3 0 0 0-3 3v18a3 3 0 0 0 3 3h18a3 3 0 0 0 3-3V14" />
              <path d="M16 20l13-13 3 3-13 13-4 1 1-4z" />
              <path d="M10 15h4M10 21h2" />
            </svg>
          </span>
          <span class="menu-option-label menu-option-label-stacked">COURSE<br/>DESIGNER</span>
        </button>
      </nav>

      <div class="menu-bottom-hints">
        <button id="btn-menu-hint-select" type="button" class="menu-hint-item" title="Confirm selection [Enter]">
          <span class="menu-hint-glyph">✕</span>
          <span>SELECT</span>
        </button>
        <button id="btn-menu-hint-back" type="button" class="menu-hint-item" title="Close menu [Esc]">
          <span class="menu-hint-glyph">◯</span>
          <span>BACK</span>
        </button>
      </div>
    `;
    document.body.appendChild(overlay);
    this.menuOverlay = overlay;

    const btnPlay = document.getElementById('btn-menu-play');
    const btnDesigner = document.getElementById('btn-menu-designer');
    const btnHintSelect = document.getElementById('btn-menu-hint-select');
    const btnHintBack = document.getElementById('btn-menu-hint-back');

    const updateFocus = (idx: 0 | 1, playHoverSfx = false) => {
      this.menuFocusedIdx = idx;
      btnPlay?.classList.toggle('is-active', idx === 0);
      btnDesigner?.classList.toggle('is-active', idx === 1);
      if (playHoverSfx) soundFx.playMenuHover();
    };

    btnPlay?.addEventListener('mouseenter', () => updateFocus(0, true));
    btnDesigner?.addEventListener('mouseenter', () => updateFocus(1, true));
    btnHintSelect?.addEventListener('mouseenter', () => soundFx.playMenuHover());
    btnHintBack?.addEventListener('mouseenter', () => soundFx.playMenuHover());

    btnPlay?.addEventListener('click', () => {
      updateFocus(0, false);
      soundFx.playMenuSelect();
      this.callbacks.onMainMenuPlay?.();
    });

    btnDesigner?.addEventListener('click', () => {
      updateFocus(1, false);
      soundFx.playMenuSelect();
      this.callbacks.onMainMenuDesigner?.();
    });

    btnHintSelect?.addEventListener('click', () => {
      soundFx.playMenuSelect();
      if (this.menuFocusedIdx === 0) this.callbacks.onMainMenuPlay?.();
      else this.callbacks.onMainMenuDesigner?.();
    });

    btnHintBack?.addEventListener('click', () => {
      soundFx.playMenuSelect();
      if (this.currentMode === 'designer') this.callbacks.onMainMenuDesigner?.();
      else this.callbacks.onMainMenuPlay?.();
    });

    // Center-screen password login validation (password = "5")
    const loginForm = document.getElementById('menu-login-form') as HTMLFormElement | null;
    const loginInput = document.getElementById('menu-login-password') as HTMLInputElement | null;
    const loginErr = document.getElementById('menu-login-error');
    const loginGate = document.getElementById('menu-login-gate');
    const loginBtn = document.getElementById('btn-menu-login');
    const toggleVis = document.getElementById('btn-login-toggle-vis');

    loginBtn?.addEventListener('mouseenter', () => soundFx.playMenuHover());

    toggleVis?.addEventListener('click', () => {
      if (!loginInput) return;
      loginInput.type = loginInput.type === 'password' ? 'text' : 'password';
      soundFx.playMenuHover();
    });

    loginForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const entered = (loginInput?.value ?? '').trim();
      if (entered === '5') {
        this.isMenuAuthenticated = true;
        overlay.classList.remove('is-locked');
        loginGate?.classList.add('hidden');
        if (loginErr) loginErr.textContent = '';
        if (loginInput) {
          loginInput.value = '';
          loginInput.blur();
        }
        soundFx.playMenuSelect();
        this.setMenuFocus(0, false);
      } else {
        soundFx.playAimTick();
        if (loginErr) loginErr.textContent = 'Incorrect password. Please try again.';
        loginGate?.classList.remove('shake');
        void (loginGate as HTMLElement | null)?.offsetWidth;
        loginGate?.classList.add('shake');
        if (loginInput) {
          loginInput.focus();
          loginInput.select();
        }
      }
    });
  }

  public advanceMenuBackground() {
    const slides = this.menuOverlay?.querySelectorAll('.menu-bg-slide');
    if (!slides || slides.length === 0) return;
    const prevIdx = this.menuBgIndex % slides.length;
    const nextIdx = (this.menuBgIndex + 1) % slides.length;
    this.menuBgIndex = nextIdx;
    slides.forEach((slide, i) => {
      slide.classList.toggle('is-prev', i === prevIdx && i !== nextIdx);
      slide.classList.toggle('active', i === nextIdx);
    });
  }

  public showMainMenu() {
    this.isMainMenuVisible = true;
    document.body.classList.add('in-main-menu');
    this.menuOverlay.classList.remove('hidden');
    // Pre-decode all hero menu backdrops asynchronously so slide transitions never stutter
    this.menuOverlay.querySelectorAll<HTMLImageElement>('.menu-bg-slide').forEach((img) => {
      if (typeof img.decode === 'function') {
        img.decode().catch(() => {});
      }
    });
    if (this.isMenuAuthenticated) {
      this.menuOverlay.classList.remove('is-locked');
      document.getElementById('menu-login-gate')?.classList.add('hidden');
      this.setMenuFocus(0);
    } else {
      this.menuOverlay.classList.add('is-locked');
      document.getElementById('menu-login-gate')?.classList.remove('hidden');
    }
    if (this.menuBgTimer !== null) {
      window.clearInterval(this.menuBgTimer);
    }
    this.menuBgTimer = window.setInterval(() => {
      this.advanceMenuBackground();
    }, 10000);
  }

  public hideMainMenu() {
    this.isMainMenuVisible = false;
    document.body.classList.remove('in-main-menu');
    this.menuOverlay.classList.add('hidden');
    if (this.menuBgTimer !== null) {
      window.clearInterval(this.menuBgTimer);
      this.menuBgTimer = null;
    }
  }

  private setMenuFocus(idx: 0 | 1, playSound = false) {
    const changed = this.menuFocusedIdx !== idx;
    this.menuFocusedIdx = idx;
    document.getElementById('btn-menu-play')?.classList.toggle('is-active', idx === 0);
    document.getElementById('btn-menu-designer')?.classList.toggle('is-active', idx === 1);
    if (playSound && changed) {
      soundFx.playMenuHover();
    }
  }

  public setGreenToggleStates(gridActive: boolean, dotsActive: boolean) {
    document.getElementById('btn-toggle-green-grid')?.classList.toggle('active', gridActive);
    document.getElementById('btn-toggle-green-dots')?.classList.toggle('active', dotsActive);
  }

  public setViewportShadingMode(mode: ViewportShadingMode) {
    document.querySelectorAll('.btn-shading').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
  }

  private toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  public setMode(mode: 'designer' | 'play') {
    if (this.currentMode !== mode) {
      this.toggleMode();
    } else {
      const devPanel = document.getElementById('developer-zone-panel');
      const driverCard = document.getElementById('club-card-driver');
      const putterCard = document.getElementById('club-card-putter');
      const shadingGroup = document.getElementById('viewport-shading-group');
      if (shadingGroup) shadingGroup.classList.toggle('hidden', mode !== 'designer');
      document.body.classList.toggle('in-designer-mode', mode === 'designer');
      if (mode === 'designer') {
        this.designerPanel.classList.remove('hidden');
        this.bottomDock?.classList.remove('hidden');
        this.playHUD.classList.add('hidden');
        if (devPanel) devPanel.classList.remove('hidden');
        if (driverCard) {
          driverCard.classList.add('hidden');
          driverCard.classList.add('fade-out');
        }
        if (putterCard) {
          putterCard.classList.add('hidden');
          putterCard.classList.add('fade-out');
        }
      } else {
        this.designerPanel.classList.add('hidden');
        this.bottomDock?.classList.add('hidden');
        this.playHUD.classList.remove('hidden');
        if (devPanel) devPanel.classList.add('hidden');
      }
      this.callbacks.onModeToggle(this.currentMode);
    }
  }

  public toggleMode(): 'designer' | 'play' {
    const devPanel = document.getElementById('developer-zone-panel');
    const driverCard = document.getElementById('club-card-driver');
    const putterCard = document.getElementById('club-card-putter');
    const shadingGroup = document.getElementById('viewport-shading-group');

    if (this.currentMode === 'play') {
      this.currentMode = 'designer';
      document.body.classList.add('in-designer-mode');
      this.designerPanel.classList.remove('hidden');
      this.bottomDock?.classList.remove('hidden');
      this.playHUD.classList.add('hidden');
      if (devPanel) devPanel.classList.remove('hidden');
      if (shadingGroup) shadingGroup.classList.remove('hidden');
      if (driverCard) {
        driverCard.classList.add('hidden');
        driverCard.classList.add('fade-out');
      }
      if (putterCard) {
        putterCard.classList.add('hidden');
        putterCard.classList.add('fade-out');
      }
      document.getElementById('mode-text')!.innerText = 'Switch to Play';
      document.getElementById('mode-icon')!.innerText = '🏌️';
      this.setDesignerTool('select');
    } else {
      this.currentMode = 'play';
      document.body.classList.remove('in-designer-mode');
      this.designerPanel.classList.add('hidden');
      this.bottomDock?.classList.add('hidden');
      this.playHUD.classList.remove('hidden');
      if (devPanel) devPanel.classList.add('hidden');
      if (shadingGroup) shadingGroup.classList.add('hidden');
      document.getElementById('mode-text')!.innerText = 'Switch to Designer';
      document.getElementById('mode-icon')!.innerText = '🎨';
    }
    this.updateHotkeysGuide(this.currentMode);
    this.callbacks.onModeToggle(this.currentMode);
    return this.currentMode;
  }

  private setupMusicPlayer() {
    const titleEl = document.getElementById('music-track-title');
    const counterEl = document.getElementById('music-track-counter');
    const btnPlay = document.getElementById('btn-music-play');
    const btnStop = document.getElementById('btn-music-stop');
    const btnPrev = document.getElementById('btn-music-prev');
    const btnNext = document.getElementById('btn-music-next');
    const btnLoop = document.getElementById('btn-music-loop');
    const volSlider = document.getElementById('music-volume-slider') as HTMLInputElement | null;
    const volIcon = document.getElementById('music-vol-icon');
    const volPct = document.getElementById('music-vol-pct');
    const playerEl = document.getElementById('hud-music-player');

    // Keep camera/canvas pointer drag from stealing slider/button interactions
    playerEl?.addEventListener('pointerdown', (e) => e.stopPropagation());
    playerEl?.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    const audio = new Audio(this.musicTracks[this.musicTrackIndex].url);
    audio.volume = this.musicVolume;
    audio.loop = this.musicIsLoop;
    audio.preload = 'metadata';
    this.musicAudio = audio;

    const syncUI = () => {
      const track = this.musicTracks[this.musicTrackIndex];
      if (titleEl) {
        titleEl.textContent = track.title;
        titleEl.title = track.title;
      }
      if (counterEl) {
        counterEl.textContent = `${this.musicTrackIndex + 1}/${this.musicTracks.length}`;
      }
      if (btnPlay) {
        btnPlay.textContent = this.musicIsPlaying ? '⏸' : '▶';
        btnPlay.classList.toggle('active', this.musicIsPlaying);
      }
      if (btnLoop) {
        btnLoop.classList.toggle('active', this.musicIsLoop);
        btnLoop.title = this.musicIsLoop ? 'Looping Current Track (ON)' : 'Loop Track (OFF — Auto Next)';
      }
      if (volIcon) {
        volIcon.textContent = this.musicVolume <= 0.01 ? '🔇' : (this.musicVolume < 0.45 ? '🔉' : '🔊');
      }
      if (volPct) {
        volPct.textContent = `${Math.round(this.musicVolume * 100)}%`;
      }
    };

    const loadAndMaybePlay = (shouldPlay: boolean) => {
      audio.src = this.musicTracks[this.musicTrackIndex].url;
      audio.currentTime = 0;
      audio.loop = this.musicIsLoop;
      if (shouldPlay) {
        audio.play().then(() => {
          this.musicIsPlaying = true;
          syncUI();
        }).catch(() => {
          this.musicIsPlaying = false;
          syncUI();
        });
      } else {
        audio.pause();
        this.musicIsPlaying = false;
      }
      syncUI();
    };

    btnPlay?.addEventListener('click', () => {
      if (this.musicIsPlaying) {
        audio.pause();
        this.musicIsPlaying = false;
        syncUI();
      } else {
        audio.play().then(() => {
          this.musicIsPlaying = true;
          syncUI();
        }).catch(() => {
          // Even if blocked before audio load, reflect attempt safely
          this.musicIsPlaying = !audio.paused;
          syncUI();
        });
      }
    });

    btnStop?.addEventListener('click', () => {
      audio.pause();
      audio.currentTime = 0;
      this.musicIsPlaying = false;
      syncUI();
    });

    btnPrev?.addEventListener('click', () => {
      this.musicTrackIndex = (this.musicTrackIndex - 1 + this.musicTracks.length) % this.musicTracks.length;
      loadAndMaybePlay(this.musicIsPlaying);
    });

    btnNext?.addEventListener('click', () => {
      this.musicTrackIndex = (this.musicTrackIndex + 1) % this.musicTracks.length;
      loadAndMaybePlay(this.musicIsPlaying);
    });

    btnLoop?.addEventListener('click', () => {
      this.musicIsLoop = !this.musicIsLoop;
      audio.loop = this.musicIsLoop;
      syncUI();
    });

    volSlider?.addEventListener('input', () => {
      this.musicVolume = Math.max(0, Math.min(1, parseFloat(volSlider.value)));
      audio.volume = this.musicVolume;
      syncUI();
    });

    audio.addEventListener('ended', () => {
      if (!this.musicIsLoop) {
        this.musicTrackIndex = (this.musicTrackIndex + 1) % this.musicTracks.length;
        loadAndMaybePlay(true);
      }
    });

    syncUI();
  }

  private setupListeners() {
    this.setupMusicPlayer();
    this.setupPerformanceHud();

    // Open Main Menu
    document.getElementById('btn-open-main-menu')?.addEventListener('click', () => {
      soundFx.playMenuSelect();
      this.showMainMenu();
    });

    // Mode toggle
    document.getElementById('btn-mode-toggle')!.addEventListener('click', () => {
      this.toggleMode();
    });

    // Viewport Shading Buttons (Designer Mode)
    document.querySelectorAll('.btn-shading').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode') as ViewportShadingMode;
        if (mode) {
          this.setViewportShadingMode(mode);
          this.callbacks.onViewportShadingChange?.(mode);
        }
      });
    });

    // Ambience & SFX Independent Audio Controls
    const btnAmbient = document.getElementById('btn-ambient-mute');
    if (btnAmbient) {
      btnAmbient.addEventListener('click', () => {
        const muted = soundFx.toggleAmbientMute();
        const icon = document.getElementById('ambient-mute-icon');
        if (icon) icon.innerText = muted ? '🌲 🔇' : '🌲 🔊';
        btnAmbient.classList.toggle('active-muted', muted);
      });
    }

    const btnSfx = document.getElementById('btn-sfx-mute');
    if (btnSfx) {
      btnSfx.addEventListener('click', () => {
        const muted = soundFx.toggleSfxMute();
        const icon = document.getElementById('sfx-mute-icon');
        if (icon) icon.innerText = muted ? '⛳ 🔇' : '⛳ 🔊';
        btnSfx.classList.toggle('active-muted', muted);
      });
    }

    // Legacy Master Mute fallback
    const btnSound = document.getElementById('btn-sound-mute');
    if (btnSound) {
      btnSound.addEventListener('click', () => {
        const muted = soundFx.toggleMute();
        const icon = document.getElementById('mute-icon');
        if (icon) icon.innerText = muted ? '🔇' : '🔊';
        const ambIcon = document.getElementById('ambient-mute-icon');
        if (ambIcon) ambIcon.innerText = muted ? '🌲 🔇' : '🌲 🔊';
        const sfxIcon = document.getElementById('sfx-mute-icon');
        if (sfxIcon) sfxIcon.innerText = muted ? '⛳ 🔇' : '⛳ 🔊';
      });
    }

    // Grid toggle
    document.getElementById('btn-toggle-grid')!.addEventListener('click', () => {
      const active = this.callbacks.onToggleGrid();
      document.getElementById('btn-toggle-grid')!.classList.toggle('active', active);
    });

    // Separate Green Grid & Green Dots toggles
    document.getElementById('btn-toggle-green-grid')!.addEventListener('click', () => {
      const active = this.callbacks.onToggleGreenGrid();
      document.getElementById('btn-toggle-green-grid')!.classList.toggle('active', active);
    });

    document.getElementById('btn-toggle-green-dots')!.addEventListener('click', () => {
      const active = this.callbacks.onToggleGreenDots();
      document.getElementById('btn-toggle-green-dots')!.classList.toggle('active', active);
    });

    // File & Project Dropdown Menu
    const btnFileMenu = document.getElementById('btn-file-menu');
    const fileDropdown = document.getElementById('file-menu-dropdown');
    if (btnFileMenu && fileDropdown) {
      const toggleFileDropdown = (open?: boolean) => {
        const isHidden = fileDropdown.classList.contains('hidden') || fileDropdown.style.display === 'none';
        const shouldOpen = open !== undefined ? open : isHidden;
        if (shouldOpen) {
          fileDropdown.classList.remove('hidden');
          fileDropdown.style.display = 'block';
          btnFileMenu.classList.add('active');
        } else {
          fileDropdown.classList.add('hidden');
          fileDropdown.style.display = 'none';
          btnFileMenu.classList.remove('active');
        }
      };

      btnFileMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFileDropdown();
      });

      document.addEventListener('click', (e) => {
        if (!fileDropdown.contains(e.target as Node) && e.target !== btnFileMenu) {
          toggleFileDropdown(false);
        }
      });

      document.getElementById('btn-action-save-project')?.addEventListener('click', () => {
        toggleFileDropdown(false);
        this.callbacks.onSaveProjectDisk?.();
      });

      document.getElementById('btn-action-new-hole')?.addEventListener('click', () => {
        toggleFileDropdown(false);
        this.openNewHoleModal();
      });

      const openProjectInput = document.getElementById('input-open-project-file') as HTMLInputElement | null;
      document.getElementById('btn-action-open-project')?.addEventListener('click', () => {
        toggleFileDropdown(false);
        openProjectInput?.click();
      });

      if (openProjectInput) {
        openProjectInput.addEventListener('change', () => {
          const file = openProjectInput.files?.[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
              const content = e.target?.result as string;
              if (content) {
                this.callbacks.onOpenProjectDisk?.(content);
              }
            };
            reader.readAsText(file);
            openProjectInput.value = '';
          }
        });
      }

      document.getElementById('btn-action-course-branding')?.addEventListener('click', () => {
        toggleFileDropdown(false);
        this.showCourseBrandingModal();
      });

      document.getElementById('btn-action-deploy-vercel')?.addEventListener('click', () => {
        toggleFileDropdown(false);
        this.showDeployVercelModal();
      });
    }

    // Course Architect Left Panel Collapsible Toggle
    const designerPanel = document.getElementById('designer-panel');
    const designerToggle = document.getElementById('btn-toggle-designer-panel');
    const designerHeader = document.getElementById('designer-panel-header');
    if (designerToggle && designerPanel) {
      const toggleDesignerPanel = () => {
        const isCollapsed = designerPanel.classList.toggle('designer-collapsed');
        designerToggle.innerText = isCollapsed ? '▶ 📐' : '✕';
        designerToggle.title = isCollapsed ? 'Expand Course Architect' : 'Collapse Course Architect';
      };
      designerToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDesignerPanel();
      });
      designerHeader?.addEventListener('click', (e) => {
        if (designerPanel.classList.contains('designer-collapsed')) {
          toggleDesignerPanel();
        }
      });
    }

    // Export / Import
    document.getElementById('btn-export-course')!.addEventListener('click', () => {
      this.callbacks.onExportCourse();
    });

    const fileInput = document.getElementById('input-import-course') as HTMLInputElement;
    fileInput.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.files && target.files[0]) {
        const reader = new FileReader();
        reader.onload = (re) => {
          if (re.target?.result) {
            this.callbacks.onImportCourse(re.target.result as string);
          }
        };
        reader.readAsText(target.files[0]);
      }
    });

    // Designer tool tabs
    document.querySelectorAll('.tool-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.getAttribute('data-tool') as 'select' | 'sculpt' | 'stamp' | 'set_tee' | 'set_pin' | 'erase';
        this.setDesignerTool(tool);
      });
    });

    // Developer Zone collapsible toggle
    const devPanel = document.getElementById('developer-zone-panel');
    const devToggle = document.getElementById('btn-toggle-dev-zone');
    if (devPanel) {
      devPanel.addEventListener('wheel', (e) => {
        e.stopPropagation();
      }, { passive: true });
    }
    if (devToggle && devPanel) {
      devToggle.addEventListener('click', () => {
        devPanel.classList.toggle('dev-collapsed');
        devToggle.innerText = devPanel.classList.contains('dev-collapsed') ? '◀ 🛠️' : '✕';
      });
    }

    // Developer Zone Gizmo Buttons
    document.querySelectorAll('.btn-dev-gizmo').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-gizmo') as 'none' | 'position' | 'rotation' | 'scale';
        this.setGizmoModeButton(mode);
        this.callbacks.onGizmoModeChange?.(mode);
      });
    });

    // Undo & Redo buttons
    document.getElementById('btn-dev-undo')?.addEventListener('click', () => {
      this.callbacks.onUndo?.();
    });
    document.getElementById('btn-dev-redo')?.addEventListener('click', () => {
      this.callbacks.onRedo?.();
    });

    // Delete Selected Object button
    
    // --- Bottom Dock Listeners ---
    if (this.bottomDock) {
      const stopEvt = (e: Event) => e.stopPropagation();
      ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend'].forEach((evt) => {
        this.bottomDock!.addEventListener(evt, stopEvt);
      });
    }

    const btnCollapse = document.getElementById('btn-dock-collapse');
    const collapseText = document.getElementById('dock-collapse-text');
    btnCollapse?.addEventListener('click', () => {
      this.isDockCollapsed = !this.isDockCollapsed;
      if (this.bottomDock) {
        this.bottomDock.classList.toggle('is-collapsed', this.isDockCollapsed);
      }
      if (collapseText) {
        collapseText.innerText = this.isDockCollapsed ? 'Expand' : 'Collapse';
      }
    });

    // Developer Zone Vertical Tabs (Inspector | Outliner)
    const devTabInspector = document.getElementById('dev-tab-inspector');
    const devTabOutliner = document.getElementById('dev-tab-outliner');
    const devPaneInspector = document.getElementById('dev-pane-inspector');
    const devPaneOutliner = document.getElementById('dev-pane-outliner');

    const switchDevTab = (tab: 'inspector' | 'outliner') => {
      this.activeDockTab = tab === 'outliner' ? 'outliner' : 'lighting';
      devTabInspector?.classList.toggle('is-active', tab === 'inspector');
      devTabOutliner?.classList.toggle('is-active', tab === 'outliner');
      devPaneInspector?.classList.toggle('is-active', tab === 'inspector');
      devPaneOutliner?.classList.toggle('is-active', tab === 'outliner');
      if (tab === 'outliner') {
        this.renderOutlinerList();
      }
    };

    devTabInspector?.addEventListener('click', () => switchDevTab('inspector'));
    devTabOutliner?.addEventListener('click', () => switchDevTab('outliner'));

    // Header & HUD Course Guide + New Flat Hole Triggers
    document.getElementById('btn-header-course-guide')?.addEventListener('click', () => {
      this.openCourseGuide();
    });
    document.getElementById('btn-open-course-guide')?.addEventListener('click', () => {
      this.openCourseGuide();
    });
    document.getElementById('btn-open-new-hole')?.addEventListener('click', () => {
      this.openNewHoleModal();
    });
    document.getElementById('btn-header-demo-hole')?.addEventListener('click', () => {
      this.callbacks.onLoadDemoHole?.();
    });
    this.setupNewHoleModal();

    // HDRI & Skybox Tweaks Listeners
    const rotInput = document.getElementById('input-hdri-rot') as HTMLInputElement | null;
    const valRot = document.getElementById('val-hdri-rot');
    rotInput?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (valRot) valRot.innerText = `${v}°`;
      this.callbacks.onEnvironmentChange?.({ hdriRotation: v });
    });

    const syncSunChk = document.getElementById('chk-sync-sun-hdri') as HTMLInputElement | null;
    syncSunChk?.addEventListener('change', () => {
      this.callbacks.onEnvironmentChange?.({ syncSunWithHdri: syncSunChk.checked });
    });

    const hdriIntInput = document.getElementById('input-hdri-intensity') as HTMLInputElement | null;
    const valHdriInt = document.getElementById('val-hdri-intensity');
    hdriIntInput?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (valHdriInt) valHdriInt.innerText = v.toFixed(2);
      this.callbacks.onEnvironmentChange?.({ hdriIntensity: v });
    });

    const hdriScaleInput = document.getElementById('input-hdri-uv-scale') as HTMLInputElement | null;
    const valHdriScale = document.getElementById('val-hdri-uv-scale');
    hdriScaleInput?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (valHdriScale) valHdriScale.innerText = v.toFixed(2);
      this.callbacks.onEnvironmentChange?.({ hdriScaleU: v, hdriScaleV: v });
    });

    const hdriOffUInput = document.getElementById('input-hdri-uv-offset-u') as HTMLInputElement | null;
    const valHdriOffU = document.getElementById('val-hdri-uv-offset-u');
    hdriOffUInput?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (valHdriOffU) valHdriOffU.innerText = v.toFixed(2);
      this.callbacks.onEnvironmentChange?.({ hdriOffsetU: v });
    });

    const hdriOffVInput = document.getElementById('input-hdri-uv-offset-v') as HTMLInputElement | null;
    const valHdriOffV = document.getElementById('val-hdri-uv-offset-v');
    hdriOffVInput?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (valHdriOffV) valHdriOffV.innerText = v.toFixed(2);
      this.callbacks.onEnvironmentChange?.({ hdriOffsetV: v });
    });

    // Sun & Directional Light Controls Listeners
    const sunAzInput = document.getElementById('input-sun-azimuth') as HTMLInputElement | null;
    const valSunAz = document.getElementById('val-sun-azimuth');
    sunAzInput?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (valSunAz) valSunAz.innerText = `${v}°`;
      if (syncSunChk) syncSunChk.checked = false;
      this.callbacks.onEnvironmentChange?.({ sunAzimuth: v, syncSunWithHdri: false });
    });

    const sunElInput = document.getElementById('input-sun-elevation') as HTMLInputElement | null;
    const valSunEl = document.getElementById('val-sun-elevation');
    sunElInput?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (valSunEl) valSunEl.innerText = `${v}°`;
      this.callbacks.onEnvironmentChange?.({ sunElevation: v });
    });

    const sunIntInput = document.getElementById('input-sun-intensity') as HTMLInputElement | null;
    const valSunInt = document.getElementById('val-sun-intensity');
    sunIntInput?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (valSunInt) valSunInt.innerText = v.toFixed(2);
      this.callbacks.onEnvironmentChange?.({ sunIntensity: v });
    });

    const sunColorInput = document.getElementById('input-sun-color') as HTMLInputElement | null;
    const valSunColor = document.getElementById('val-sun-color');
    sunColorInput?.addEventListener('input', (e) => {
      const hex = (e.target as HTMLInputElement).value;
      if (valSunColor) valSunColor.innerText = hex;
      this.callbacks.onEnvironmentChange?.({ sunColor: hex });
    });

    const shadowDarkInput = document.getElementById('input-shadow-darkness') as HTMLInputElement | null;
    const valShadowDark = document.getElementById('val-shadow-darkness');
    shadowDarkInput?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (valShadowDark) valShadowDark.innerText = v.toFixed(2);
      this.callbacks.onEnvironmentChange?.({ shadowDarkness: v });
    });

    // Delete Feature in Developer Zone
    document.getElementById('btn-dev-delete-feat')?.addEventListener('click', () => {
      if (this.selectedFeatureIdx >= 0) {
        this.callbacks.onDeleteFeature?.(this.selectedFeatureIdx);
      }
    });

    // Outliner Search & Filter Listeners
    const outlinerSearch = document.getElementById('input-outliner-search') as HTMLInputElement | null;
    outlinerSearch?.addEventListener('input', (e) => {
      this.outlinerSearchQuery = (e.target as HTMLInputElement).value.toLowerCase();
      this.renderOutlinerList();
    });

    const chips = document.querySelectorAll('.outliner-chip');
    chips.forEach((c) => {
      c.addEventListener('click', (e) => {
        chips.forEach((x) => x.classList.remove('is-active'));
        const target = e.currentTarget as HTMLElement;
        target.classList.add('is-active');
        this.outlinerActiveCat = target.getAttribute('data-cat') || 'all';
        this.renderOutlinerList();
      });
    });

    // Initial render of HDRI presets cards
    this.renderHdriPresets(HDRI_PRESETS, this.activeHdriPresetId);

    document.getElementById('btn-dev-delete-obj')?.addEventListener('click', () => {
      this.callbacks.onDeleteSelectedObject?.();
    });

    // Fairway Shape selection buttons
    document.querySelectorAll('.btn-fway-shape').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const shape = (e.currentTarget as HTMLElement).getAttribute('data-shape') as 'straight' | 'dogleg_left' | 'dogleg_right';
        if (this.selectedFeatureIdx >= 0 && shape) {
          this.callbacks.onFairwayShapeChange?.(this.selectedFeatureIdx, shape);
        }
      });
    });

    // Bunker Shape selection buttons
    document.querySelectorAll('.btn-bunker-shape').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const shapeIdx = parseInt((e.currentTarget as HTMLElement).getAttribute('data-shape') || '0', 10);
        if (this.selectedFeatureIdx >= 0 && !isNaN(shapeIdx)) {
          this.callbacks.onBunkerShapeChange?.(this.selectedFeatureIdx, shapeIdx);
        }
      });
    });

    // Snap Pin to Green & Snap Tee to Box buttons
    document.getElementById('btn-dev-snap-pin')?.addEventListener('click', () => {
      this.callbacks.onSnapPinToGreen?.();
    });
    document.getElementById('btn-dev-snap-tee')?.addEventListener('click', () => {
      this.callbacks.onSnapTeeToBox?.();
    });
    document.getElementById('btn-dev-restore-green-grid')?.addEventListener('click', () => {
      this.callbacks.onRestoreChampionshipGreen?.();
    });

    // Save Default Hole button
    document.getElementById('btn-dev-save-default')?.addEventListener('click', () => {
      this.callbacks.onSaveDefaultHole?.();
    });

    // Reset to Factory Default button
    document.getElementById('btn-dev-reset-default')?.addEventListener('click', () => {
      this.callbacks.onResetFactoryLayout?.();
    });

    // Select Ground Layer buttons (Architect & Developer Zone)
    document.getElementById('btn-select-ground-layer')?.addEventListener('click', () => {
      this.callbacks.onSelectGroundLayer?.();
    });
    document.getElementById('btn-dev-select-ground')?.addEventListener('click', () => {
      this.callbacks.onSelectGroundLayer?.();
    });

    // Ground PBR Material Controls
    const bindGroundSlider = (id: string, valId: string, prop: string, decimals = 0) => {
      const slider = document.getElementById(id) as HTMLInputElement | null;
      const valSpan = document.getElementById(valId);
      if (slider && valSpan) {
        slider.addEventListener('input', () => {
          const num = parseFloat(slider.value);
          valSpan.innerText = decimals > 0 ? num.toFixed(decimals) : num.toString();
          this.callbacks.onGroundUvChange?.({ [prop]: num });
        });
      }
    };

    bindGroundSlider('ground-uv-scale-u', 'val-ground-scale-u', 'uScale', 0);
    bindGroundSlider('ground-uv-scale-v', 'val-ground-scale-v', 'vScale', 0);
    bindGroundSlider('ground-uv-offset-u', 'val-ground-offset-u', 'uOffset', 2);
    bindGroundSlider('ground-uv-offset-v', 'val-ground-offset-v', 'vOffset', 2);
    bindGroundSlider('ground-normal-level', 'val-ground-normal', 'normalLevel', 2);
    bindGroundSlider('ground-color-tex-level', 'val-ground-color-tex-level', 'colorTexLevel', 2);
    bindGroundSlider('ground-rough-level', 'val-ground-rough-level', 'roughnessLevel', 2);
    bindGroundSlider('ground-metallic-level', 'val-ground-metallic-level', 'metallicLevel', 2);

    const groundBaseColor = document.getElementById('ground-mat-base-color') as HTMLInputElement | null;
    const valGroundBaseColor = document.getElementById('val-ground-base-color');
    groundBaseColor?.addEventListener('input', () => {
      if (valGroundBaseColor) valGroundBaseColor.innerText = groundBaseColor.value;
      this.callbacks.onGroundUvChange?.({ baseColor: groundBaseColor.value });
    });

    const chkGroundColor = document.getElementById('ground-mat-tex-color') as HTMLInputElement | null;
    const chkGroundRough = document.getElementById('ground-mat-tex-rough') as HTMLInputElement | null;
    const chkGroundNormal = document.getElementById('ground-mat-tex-normal') as HTMLInputElement | null;
    const chkGroundSatellite = document.getElementById('ground-mat-tex-satellite') as HTMLInputElement | null;
    const groundSatMix = document.getElementById('ground-satellite-mix') as HTMLInputElement | null;
    const valGroundSatMix = document.getElementById('val-ground-satellite-mix');

    chkGroundColor?.addEventListener('change', () => {
      this.callbacks.onGroundUvChange?.({ enableBaseColorTex: chkGroundColor.checked });
    });
    chkGroundRough?.addEventListener('change', () => {
      this.callbacks.onGroundUvChange?.({ enableRoughnessTex: chkGroundRough.checked });
    });
    chkGroundNormal?.addEventListener('change', () => {
      this.callbacks.onGroundUvChange?.({ enableNormalTex: chkGroundNormal.checked });
    });
    chkGroundSatellite?.addEventListener('change', () => {
      this.callbacks.onGroundUvChange?.({ enableSatelliteTex: chkGroundSatellite.checked });
    });
    groundSatMix?.addEventListener('input', () => {
      const pct = Math.max(0, Math.min(100, Number(groundSatMix.value)));
      if (valGroundSatMix) valGroundSatMix.innerText = `${Math.round(pct)}%`;
      const sOpacity = document.getElementById('input-satellite-opacity') as HTMLInputElement | null;
      const vOpacity = document.getElementById('val-satellite-opacity');
      if (sOpacity) sOpacity.value = String(pct);
      if (vOpacity) vOpacity.innerText = `${Math.round(pct)}%`;
      this.callbacks.onSatelliteOpacityChange?.(pct / 100);
      this.callbacks.onGroundUvChange?.({ satelliteMix: pct / 100 });
    });

    document.getElementById('btn-reset-ground-mat')?.addEventListener('click', () => {
      this.callbacks.onResetGroundMaterial?.();
    });

    // Tips modal & feature controls setup
    this.setupTipsModal();
    this.setupFeatureControls();
    this.setupFeatureMaterialControls();
    this.setupObjectMaterialControls();
    this.setupGroundTextureControls();

    document.getElementById('btn-dev-frame-obj')?.addEventListener('click', () => {
      this.callbacks.onFrameSelectedObject?.();
    });
    document.getElementById('btn-dev-frame-feat')?.addEventListener('click', () => {
      this.callbacks.onFrameSelectedObject?.();
    });

    const btnReplaceGlb = document.getElementById('btn-replace-object-glb');
    const inputReplaceGlb = document.getElementById('input-replace-object-glb') as HTMLInputElement | null;
    btnReplaceGlb?.addEventListener('click', () => {
      inputReplaceGlb?.click();
    });
    inputReplaceGlb?.addEventListener('change', () => {
      const file = inputReplaceGlb.files?.[0];
      if (file) {
        this.callbacks.onReplaceObjectGlb?.(file);
      }
      inputReplaceGlb.value = '';
    });

    // Sculpt mode buttons
    document.querySelectorAll('.sculpt-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sculpt-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.getAttribute('data-sculpt') as 'raise' | 'lower' | 'flatten' | 'smooth';
        this.callbacks.onSculptModeSelect(mode);
      });
    });

    // Sliders
    const radiusInput = document.getElementById('input-brush-radius') as HTMLInputElement;
    radiusInput.addEventListener('input', () => {
      const val = parseFloat(radiusInput.value);
      document.getElementById('val-brush-radius')!.innerText = `${val}m`;
      this.callbacks.onBrushRadiusChange(val);
    });

    const strengthInput = document.getElementById('input-brush-strength') as HTMLInputElement;
    strengthInput.addEventListener('input', () => {
      const val = parseFloat(strengthInput.value);
      document.getElementById('val-brush-strength')!.innerText = `${val.toFixed(1)}`;
      this.callbacks.onBrushStrengthChange(val);
    });

    // Preset category filter chips
    document.querySelectorAll('.btn-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.btn-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const cat = chip.getAttribute('data-cat') || 'all';
        this.renderPresets(cat);
      });
    });

    // Par buttons
    document.querySelectorAll('.par-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.par-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const par = parseInt(btn.getAttribute('data-par') || '4', 10) as 3 | 4 | 5;
        this.callbacks.onHoleParChange(par);
      });
    });

    // Play Mode Controls
    document.getElementById('btn-swing-action')!.addEventListener('click', () => {
      if (!this.isSwingEnabled) return;
      this.callbacks.onSwingAction();
    });

    document.getElementById('btn-aim-left')!.addEventListener('click', () => {
      this.callbacks.onAimAdjust(-2.0);
    });

    document.getElementById('btn-aim-right')!.addEventListener('click', () => {
      this.callbacks.onAimAdjust(2.0);
    });

    document.getElementById('btn-target-closer')?.addEventListener('click', () => {
      this.callbacks.onTargetDistanceAdjust?.(-10);
    });

    document.getElementById('btn-target-farther')?.addEventListener('click', () => {
      this.callbacks.onTargetDistanceAdjust?.(10);
    });

    document.getElementById('btn-camera-view')!.addEventListener('click', () => {
      this.callbacks.onCameraModeToggle();
    });

    document.getElementById('btn-focus-ball')?.addEventListener('click', () => {
      this.callbacks.onFocusBall?.();
    });

    document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    document.getElementById('btn-reset-shot')?.addEventListener('click', () => {
      this.callbacks.onResetShot();
    });

    // Shot Shaper Button Handlers
    document.getElementById('btn-shape-draw')?.addEventListener('click', () => {
      this.setShotShape('draw');
    });
    document.getElementById('btn-shape-straight')?.addEventListener('click', () => {
      this.setShotShape('straight');
    });
    document.getElementById('btn-shape-fade')?.addEventListener('click', () => {
      this.setShotShape('fade');
    });

    this.bindMapNGAndTracingEvents();

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      const targetTag = (e.target as HTMLElement | null)?.tagName;
      const isTextTyping =
        (targetTag === 'INPUT' && (e.target as HTMLInputElement).type !== 'range' && (e.target as HTMLInputElement).type !== 'checkbox' && (e.target as HTMLInputElement).type !== 'file') ||
        targetTag === 'TEXTAREA' ||
        targetTag === 'SELECT';

      if (this.isMainMenuVisible) {
        if (!isTextTyping && e.code === 'KeyF') {
          this.toggleFullscreen();
          return;
        }
        if (!this.isMenuAuthenticated) {
          return;
        }
        if (e.key === 'ArrowUp' || e.code === 'KeyW') {
          e.preventDefault();
          this.setMenuFocus(0, true);
        } else if (e.key === 'ArrowDown' || e.code === 'KeyS') {
          e.preventDefault();
          this.setMenuFocus(1, true);
        } else if (e.key === 'Enter' || e.code === 'Space') {
          e.preventDefault();
          soundFx.playMenuSelect();
          if (this.menuFocusedIdx === 0) this.callbacks.onMainMenuPlay?.();
          else this.callbacks.onMainMenuDesigner?.();
        }
        return;
      }

      if (isTextTyping) return;

      const mapngModal = document.getElementById('modal-mapng-import');
      if (e.key === 'Escape' && mapngModal && !mapngModal.classList.contains('hidden')) {
        mapngModal.classList.add('hidden');
        return;
      }

      const newHoleModal = document.getElementById('modal-new-hole');
      if (e.key === 'Escape' && newHoleModal && !newHoleModal.classList.contains('hidden')) {
        newHoleModal.classList.add('hidden');
        return;
      }

      if (e.key === 'Escape' && this.courseGuideModal?.isVisible()) {
        this.courseGuideModal.close();
        return;
      }

      if (e.key === 'Escape' && this.currentMode === 'designer' && this.activeTraceMode !== 'off') {
        this.callbacks.onTraceCancel?.();
        return;
      }

      if (e.key === 'Escape' && !this.isTipsModalOpen && !document.getElementById('modal-hole-complete')) {
        soundFx.playMenuSelect();
        this.showMainMenu();
        return;
      }

      if (e.code === 'KeyF' || e.code === 'NumpadDecimal') {
        if (this.currentMode === 'designer') {
          this.callbacks.onFrameSelectedObject?.();
          return;
        }
        this.toggleFullscreen();
        return;
      }

      if (this.currentMode === 'designer') {
        if (this.activeTraceMode !== 'off') {
          if (e.key === 'Enter' || e.code === 'Space') {
            e.preventDefault();
            this.callbacks.onTraceFinish?.();
            return;
          } else if (e.code === 'Backspace') {
            e.preventDefault();
            this.callbacks.onTraceUndoPoint?.();
            return;
          }
        }

        if (e.code === 'KeyT') {
          e.preventDefault();
          this.callbacks.onToggleSatelliteOverlay?.();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) {
          e.preventDefault();
          this.callbacks.onUndo?.();
          return;
        } else if (((e.ctrlKey || e.metaKey) && e.code === 'KeyY') || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyZ')) {
          e.preventDefault();
          this.callbacks.onRedo?.();
          return;
        }

        if (e.code === 'Digit1' || e.key === '1') {
          this.setViewportShadingMode('wireframe');
          this.callbacks.onViewportShadingChange?.('wireframe');
          return;
        } else if (e.code === 'Digit2' || e.key === '2') {
          this.setViewportShadingMode('solid');
          this.callbacks.onViewportShadingChange?.('solid');
          return;
        } else if (e.code === 'Digit3' || e.key === '3') {
          this.setViewportShadingMode('material');
          this.callbacks.onViewportShadingChange?.('material');
          return;
        } else if (e.code === 'Digit4' || e.key === '4') {
          this.setViewportShadingMode('rendered');
          this.callbacks.onViewportShadingChange?.('rendered');
          return;
        }

        if (e.code === 'KeyV') {
          this.setDesignerTool('select');
        } else if (e.code === 'KeyB') {
          this.setDesignerTool('sculpt');
        } else if (e.code === 'KeyA') {
          this.setDesignerTool('stamp');
        } else if (e.code === 'KeyX') {
          this.setDesignerTool('erase');
        } else if (e.code === 'KeyG') {
          this.setGizmoModeButton('position');
          this.callbacks.onGizmoModeChange?.('position');
        } else if (e.code === 'KeyR') {
          this.setGizmoModeButton('rotation');
          this.callbacks.onGizmoModeChange?.('rotation');
        } else if (e.code === 'KeyS') {
          this.setGizmoModeButton('scale');
          this.callbacks.onGizmoModeChange?.('scale');
        } else if (e.code === 'KeyQ') {
          this.setGizmoModeButton('none');
          this.callbacks.onGizmoModeChange?.('none');
        } else if (e.code === 'Delete' || e.code === 'Backspace') {
          if (this.selectedFeatureIdx >= 0) {
            this.callbacks.onDeleteFeature?.(this.selectedFeatureIdx);
          } else {
            this.callbacks.onDeleteSelectedObject?.();
          }
        }
        return;
      }

      if (this.currentMode !== 'play') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!this.isSwingEnabled) return;
        this.callbacks.onSwingAction();
      } else if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
        this.callbacks.onAimAdjust(-1.5);
      } else if (e.code === 'KeyD' || e.code === 'ArrowRight') {
        this.callbacks.onAimAdjust(1.5);
      } else if (e.code === 'KeyQ') {
        this.setShotShape('draw');
      } else if (e.code === 'KeyW') {
        this.setShotShape('straight');
      } else if (e.code === 'KeyE') {
        this.setShotShape('fade');
      } else if (e.code === 'KeyB') {
        this.callbacks.onFocusBall?.();
      } else if (e.code === 'KeyC') {
        this.callbacks.onCameraModeToggle();
      } else if (e.code === 'KeyL') {
        this.openCourseGuide();
      } else if (e.code === 'KeyR') {
        this.callbacks.onResetShot();
      }
    });
  }

  public openNewHoleModal() {
    const modal = document.getElementById('modal-new-hole');
    if (modal) modal.classList.remove('hidden');
  }

  private setupNewHoleModal() {
    const modal = document.getElementById('modal-new-hole');
    const closeBtn = document.getElementById('btn-close-new-hole');
    const cancelBtn = document.getElementById('btn-cancel-new-hole');
    const confirmBtn = document.getElementById('btn-confirm-new-hole');
    const kyalamiSel = document.getElementById('select-new-kyalami-hole') as HTMLSelectElement | null;
    let selectedPar: 3 | 4 | 5 = 4;

    const selectParCard = (par: 3 | 4 | 5) => {
      selectedPar = par;
      modal?.querySelectorAll('.new-hole-par-card').forEach((card) => {
        const cardPar = Number(card.getAttribute('data-par'));
        card.classList.toggle('active', cardPar === par);
      });
    };

    modal?.querySelectorAll('.new-hole-par-card').forEach((card) => {
      card.addEventListener('click', () => {
        const par = Number(card.getAttribute('data-par') || '4') as 3 | 4 | 5;
        selectParCard(par === 3 || par === 5 ? par : 4);
      });
    });

    kyalamiSel?.addEventListener('change', () => {
      const num = parseInt(kyalamiSel.value || '0', 10);
      const found = KYALAMI_COURSE_GUIDE.holes.find((h) => h.number === num);
      if (found) {
        selectParCard(found.par);
      }
    });

    const hideModal = () => modal?.classList.add('hidden');
    closeBtn?.addEventListener('click', hideModal);
    cancelBtn?.addEventListener('click', hideModal);
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) hideModal();
    });

    confirmBtn?.addEventListener('click', () => {
      const modeRadio = document.querySelector<HTMLInputElement>('input[name="new-hole-mode"]:checked');
      const mode = (modeRadio?.value === 'add_hole' ? 'add_hole' : 'new_course') as 'new_course' | 'add_hole';
      const blankChk = document.getElementById('chk-new-hole-blank') as HTMLInputElement | null;
      const nameInput = document.getElementById('input-new-course-name') as HTMLInputElement | null;
      const kyalamiNum = parseInt(kyalamiSel?.value || '0', 10);
      hideModal();
      this.callbacks.onCreateFlatHole?.({
        par: selectedPar,
        mode,
        blankFlat: Boolean(blankChk?.checked),
        courseName: nameInput?.value?.trim() || undefined,
        kyalamiHoleNum: kyalamiNum > 0 ? kyalamiNum : undefined
      });
    });
  }

  public setDesignerTool(tool: 'select' | 'sculpt' | 'stamp' | 'set_tee' | 'set_pin' | 'erase') {
    document.querySelectorAll('.tool-tab').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-tool') === tool);
    });

    const selectControls = document.getElementById('select-controls');
    const sculptControls = document.getElementById('sculpt-controls');
    const presetControls = document.getElementById('preset-controls');

    if (selectControls) selectControls.classList.toggle('hidden', tool !== 'select');
    if (sculptControls) sculptControls.classList.toggle('hidden', tool !== 'sculpt');
    if (presetControls) presetControls.classList.toggle('hidden', tool !== 'stamp');

    this.callbacks.onToolSelect(tool);
  }

  public currentShotShape: 'straight' | 'draw' | 'fade' = 'straight';

  public setShotShape(shape: 'straight' | 'draw' | 'fade') {
    this.currentShotShape = shape;
    const btnDraw = document.getElementById('btn-shape-draw');
    const btnStraight = document.getElementById('btn-shape-straight');
    const btnFade = document.getElementById('btn-shape-fade');
    btnDraw?.classList.toggle('active', shape === 'draw');
    btnStraight?.classList.toggle('active', shape === 'straight');
    btnFade?.classList.toggle('active', shape === 'fade');
    this.callbacks.onShotShapeChange?.(shape);
  }

  public showGroundPbrInspector(settings: {
    baseColor?: string;
    colorTexLevel?: number;
    roughnessLevel?: number;
    metallicLevel?: number;
    uScale: number;
    vScale: number;
    uOffset: number;
    vOffset: number;
    normalLevel: number;
    detailBlendLevel: number;
    enableBaseColorTex?: boolean;
    enableRoughnessTex?: boolean;
    enableNormalTex?: boolean;
    enableSatelliteTex?: boolean;
    satelliteMix?: number;
    satelliteOpacity?: number;
    satelliteEnabled?: boolean;
    colorMapUrl?: string;
    colorMapName?: string;
    roughnessMapUrl?: string;
    roughnessMapName?: string;
    normalMapUrl?: string;
    normalMapName?: string;
    satelliteMapUrl?: string;
    satelliteMapName?: string;
    satellitePreviewDataUrl?: string;
  }, scrollIntoView = false) {
    const groundSec = document.getElementById('dev-ground-pbr-section');
    if (groundSec) groundSec.style.display = 'block';
    const featSec = document.getElementById('dev-feature-material-section');
    if (featSec) featSec.style.display = 'none';
    const objSec = document.getElementById('dev-object-material-section');
    if (objSec) objSec.style.display = 'none';

    const baseColorEl = document.getElementById('ground-mat-base-color') as HTMLInputElement | null;
    const valBaseColor = document.getElementById('val-ground-base-color');
    const colorTexEl = document.getElementById('ground-color-tex-level') as HTMLInputElement | null;
    const valColorTex = document.getElementById('val-ground-color-tex-level');
    const roughEl = document.getElementById('ground-rough-level') as HTMLInputElement | null;
    const valRough = document.getElementById('val-ground-rough-level');
    const metallicEl = document.getElementById('ground-metallic-level') as HTMLInputElement | null;
    const valMetallic = document.getElementById('val-ground-metallic-level');

    const scaleU = document.getElementById('ground-uv-scale-u') as HTMLInputElement | null;
    const scaleV = document.getElementById('ground-uv-scale-v') as HTMLInputElement | null;
    const offU = document.getElementById('ground-uv-offset-u') as HTMLInputElement | null;
    const offV = document.getElementById('ground-uv-offset-v') as HTMLInputElement | null;
    const nor = document.getElementById('ground-normal-level') as HTMLInputElement | null;

    if (baseColorEl && settings.baseColor) {
      baseColorEl.value = settings.baseColor;
      if (valBaseColor) valBaseColor.innerText = settings.baseColor;
    }
    const ctl = Math.max(0, Math.min(1, settings.colorTexLevel ?? 1.0));
    if (colorTexEl) {
      colorTexEl.value = ctl.toFixed(2);
      if (valColorTex) valColorTex.innerText = ctl.toFixed(2);
    }
    const rl = Math.max(0, Math.min(1, settings.roughnessLevel ?? 0.78));
    if (roughEl) {
      roughEl.value = rl.toFixed(2);
      if (valRough) valRough.innerText = rl.toFixed(2);
    }
    const ml = Math.max(0, Math.min(1, settings.metallicLevel ?? 0.0));
    if (metallicEl) {
      metallicEl.value = ml.toFixed(2);
      if (valMetallic) valMetallic.innerText = ml.toFixed(2);
    }

    if (scaleU) scaleU.value = Math.max(0, settings.uScale).toString();
    if (scaleV) scaleV.value = Math.max(0, settings.vScale).toString();
    const normOff = (v: number) => (((v % 1) + 1) % 1);
    const uo = normOff(settings.uOffset);
    const vo = normOff(settings.vOffset);
    if (offU) offU.value = uo.toString();
    if (offV) offV.value = vo.toString();
    if (nor) nor.value = Math.max(0, settings.normalLevel).toString();

    const valScaleU = document.getElementById('val-ground-scale-u');
    const valScaleV = document.getElementById('val-ground-scale-v');
    const valOffU = document.getElementById('val-ground-offset-u');
    const valOffV = document.getElementById('val-ground-offset-v');
    const valNor = document.getElementById('val-ground-normal');

    if (valScaleU) valScaleU.innerText = Math.round(Math.max(0, settings.uScale)).toString();
    if (valScaleV) valScaleV.innerText = Math.round(Math.max(0, settings.vScale)).toString();
    if (valOffU) valOffU.innerText = uo.toFixed(2);
    if (valOffV) valOffV.innerText = vo.toFixed(2);
    if (valNor) valNor.innerText = Math.max(0, settings.normalLevel).toFixed(2);

    const chkColor = document.getElementById('ground-mat-tex-color') as HTMLInputElement | null;
    const chkRough = document.getElementById('ground-mat-tex-rough') as HTMLInputElement | null;
    const chkNormal = document.getElementById('ground-mat-tex-normal') as HTMLInputElement | null;
    const chkSat = document.getElementById('ground-mat-tex-satellite') as HTMLInputElement | null;
    const satMixEl = document.getElementById('ground-satellite-mix') as HTMLInputElement | null;
    const valSatMix = document.getElementById('val-ground-satellite-mix');

    if (chkColor) chkColor.checked = settings.enableBaseColorTex !== false;
    if (chkRough) chkRough.checked = settings.enableRoughnessTex !== false;
    if (chkNormal) chkNormal.checked = settings.enableNormalTex !== false;
    const satSrc = settings.satellitePreviewDataUrl || settings.satelliteMapUrl || '';
    const satMixPct = Math.round(Math.max(0, Math.min(1, settings.satelliteMix ?? settings.satelliteOpacity ?? 0)) * 100);
    if (chkSat) chkSat.checked = settings.enableSatelliteTex ?? settings.satelliteEnabled ?? (Boolean(satSrc) && satMixPct > 0);
    if (satMixEl) satMixEl.value = String(satMixPct);
    if (valSatMix) valSatMix.innerText = `${satMixPct}%`;

    const thumbColor = document.getElementById('ground-thumb-color') as HTMLImageElement | null;
    const nameColor = document.getElementById('ground-name-color');
    const thumbRough = document.getElementById('ground-thumb-rough') as HTMLImageElement | null;
    const nameRough = document.getElementById('ground-name-rough');
    const thumbNormal = document.getElementById('ground-thumb-normal') as HTMLImageElement | null;
    const nameNormal = document.getElementById('ground-name-normal');
    const thumbSat = document.getElementById('ground-thumb-satellite') as HTMLImageElement | null;
    const emptySat = document.getElementById('ground-satellite-empty');
    const nameSat = document.getElementById('ground-name-satellite');

    const safeGroundUrl = (url: string | undefined, fallback: string) => {
      if (!url || !url.trim()) return fallback;
      if (url.includes('grass_pbr_diff')) return '/textures/pbr_grass/grass_pbr_diff_1k.jpg';
      if (url.includes('grass_pbr_nor')) return '/textures/pbr_grass/grass_pbr_nor_1k.jpg';
      if (url.includes('grass_pbr_rough')) return '/textures/pbr_grass/grass_pbr_rough_512.jpg';
      return url;
    };

    if (thumbColor) thumbColor.src = safeGroundUrl(settings.colorMapUrl, '/textures/pbr_grass/grass_pbr_diff_1k.jpg');
    if (nameColor) nameColor.innerText = settings.colorMapName || 'grass_pbr_diff_1k.jpg';
    if (thumbRough) thumbRough.src = safeGroundUrl(settings.roughnessMapUrl, '/textures/pbr_grass/grass_pbr_rough_512.jpg');
    if (nameRough) nameRough.innerText = settings.roughnessMapName || 'grass_pbr_rough_512.jpg';
    if (thumbNormal) thumbNormal.src = safeGroundUrl(settings.normalMapUrl, '/textures/pbr_grass/grass_pbr_nor_1k.jpg');
    if (nameNormal) nameNormal.innerText = settings.normalMapName || 'grass_pbr_nor_1k.jpg';

    if (thumbSat && emptySat) {
      if (satSrc) {
        thumbSat.src = satSrc;
        thumbSat.style.display = 'block';
        emptySat.style.display = 'none';
      } else {
        thumbSat.removeAttribute('src');
        thumbSat.style.display = 'none';
        emptySat.style.display = 'flex';
      }
    }
    if (nameSat) nameSat.innerText = settings.satelliteMapName || (satSrc ? 'course_satellite.jpg' : 'No satellite');

    // Also update selected info box to show Main Ground Layer
    const info = document.getElementById('dev-selected-info');
    if (info) {
      info.innerHTML = `
        <div class="dev-obj-name" style="color: #4ade80;">🌱 Main Ground (GolfTerrain)</div>
        <div class="dev-obj-details">Material: Main Ground PBR${satSrc ? ' + Satellite Ortho' : ''}<br/>Textures: Color, Roughness, NormalGL${satSrc ? ', Satellite' : ''}</div>
      `;
    }
    if (scrollIntoView) {
      groundSec?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  private formatGeoCount(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return `${Math.round(n)}`;
  }

  public updateDevStats(
    trees: number,
    rocks: number,
    cliffs: number,
    bunkers: number,
    geoStats?: {
      sceneTris: number;
      sceneVerts: number;
      selectedLabel?: string;
      selectedTris?: number;
      selectedVerts?: number;
    }
  ) {
    const elTrees = document.getElementById('stat-trees-count');
    const elRocks = document.getElementById('stat-rocks-count');
    const elCliffs = document.getElementById('stat-cliffs-count');
    const elBunkers = document.getElementById('stat-bunkers-count');
    const elTris = document.getElementById('stat-tris-count');
    const elVerts = document.getElementById('stat-verts-count');
    const pillEl = document.getElementById('designer-geo-stats');

    if (elTrees) elTrees.innerText = `${trees}`;
    if (elRocks) elRocks.innerText = `${rocks}`;
    if (elCliffs) elCliffs.innerText = `${cliffs}`;
    if (elBunkers) elBunkers.innerText = `${bunkers}`;

    if (geoStats) {
      const trisText = this.formatGeoCount(geoStats.sceneTris);
      const vertsText = this.formatGeoCount(geoStats.sceneVerts);
      if (elTris) elTris.innerText = trisText;
      if (elVerts) elVerts.innerText = vertsText;
      if (pillEl) {
        const selPart =
          geoStats.selectedLabel && geoStats.selectedTris !== undefined && geoStats.selectedVerts !== undefined
            ? ` &nbsp;|&nbsp; <strong>Sel:</strong> ${geoStats.selectedLabel} (${this.formatGeoCount(geoStats.selectedTris)} tris • ${this.formatGeoCount(geoStats.selectedVerts)} verts)`
            : '';
        pillEl.innerHTML = `<span>▲ <strong>Scene:</strong> ${trisText} tris • ${vertsText} verts${selPart}</span>`;
      }
    }

    this.syncTypeableSliders();
  }

  public setGizmoModeButton(mode: 'none' | 'position' | 'rotation' | 'scale') {
    document.querySelectorAll('.btn-dev-gizmo').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-gizmo') === mode);
    });
  }

  private setupTipsModal() {
    const modal = document.getElementById('tips-floating-modal');
    const header = document.getElementById('tips-modal-header');
    const btnOpen = document.getElementById('btn-open-tips');
    const btnClose = document.getElementById('btn-close-tips-modal');
    const btnPrev = document.getElementById('btn-prev-tip') as HTMLButtonElement | null;
    const btnNext = document.getElementById('btn-next-tip') as HTMLButtonElement | null;

    btnOpen?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleTipsModal();
    });

    btnClose?.addEventListener('click', () => {
      this.closeTipsModal();
    });

    btnPrev?.addEventListener('click', () => {
      if (this.currentTipSlideIndex > 0) {
        this.renderTipSlide(this.currentTipSlideIndex - 1);
      }
    });

    btnNext?.addEventListener('click', () => {
      if (this.currentTipSlideIndex < TIP_SLIDES.length - 1) {
        this.renderTipSlide(this.currentTipSlideIndex + 1);
      }
    });

    // Keyboard navigation when tips window is open
    window.addEventListener('keydown', (e) => {
      if (!this.isTipsModalOpen) return;
      if (e.key === 'Escape') {
        this.closeTipsModal();
      } else if (e.key === 'ArrowLeft') {
        if (this.currentTipSlideIndex > 0) this.renderTipSlide(this.currentTipSlideIndex - 1);
      } else if (e.key === 'ArrowRight') {
        if (this.currentTipSlideIndex < TIP_SLIDES.length - 1) this.renderTipSlide(this.currentTipSlideIndex + 1);
      }
    });

    // Floating window draggable logic
    if (modal && header) {
      let isDragging = false;
      let startX = 0;
      let startY = 0;
      let initialLeft = 20;
      let initialTop = 72;

      header.addEventListener('mousedown', (e: MouseEvent) => {
        if ((e.target as HTMLElement).tagName === 'BUTTON') return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = modal.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        header.style.cursor = 'grabbing';
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e: MouseEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const newLeft = Math.max(10, Math.min(window.innerWidth - modal.offsetWidth - 10, initialLeft + dx));
        const newTop = Math.max(10, Math.min(window.innerHeight - modal.offsetHeight - 10, initialTop + dy));
        modal.style.left = `${newLeft}px`;
        modal.style.top = `${newTop}px`;
      });

      window.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          header.style.cursor = 'grab';
        }
      });
    }

    this.renderTipSlide(0);
  }

  public openTipsModal(slideIndex?: number) {
    const modal = document.getElementById('tips-floating-modal');
    if (!modal) return;
    this.isTipsModalOpen = true;
    modal.classList.remove('hidden');

    const badge = document.getElementById('tips-mode-badge');
    if (badge) {
      badge.innerText = this.currentMode === 'play' ? 'PLAY MODE' : 'DESIGNER MODE';
    }

    if (slideIndex !== undefined) {
      this.renderTipSlide(slideIndex);
    } else {
      // Jump to relevant slide for current mode if not already on one
      if (this.currentMode === 'designer' && this.currentTipSlideIndex < 5) {
        this.renderTipSlide(5);
      } else if (this.currentMode === 'play' && this.currentTipSlideIndex >= 5) {
        this.renderTipSlide(0);
      } else {
        this.renderTipSlide(this.currentTipSlideIndex);
      }
    }
  }

  public closeTipsModal() {
    const modal = document.getElementById('tips-floating-modal');
    if (!modal) return;
    this.isTipsModalOpen = false;
    modal.classList.add('hidden');
  }

  public toggleTipsModal() {
    if (this.isTipsModalOpen) {
      this.closeTipsModal();
    } else {
      this.openTipsModal();
    }
  }

  private renderTipSlide(index: number) {
    this.currentTipSlideIndex = Math.max(0, Math.min(TIP_SLIDES.length - 1, index));
    const slide = TIP_SLIDES[this.currentTipSlideIndex];
    const container = document.getElementById('tips-slide-content');
    const counter = document.getElementById('tips-slide-counter');
    const dotsContainer = document.getElementById('tips-dots-container');
    const btnPrev = document.getElementById('btn-prev-tip') as HTMLButtonElement | null;
    const btnNext = document.getElementById('btn-next-tip') as HTMLButtonElement | null;

    if (btnPrev) btnPrev.disabled = this.currentTipSlideIndex === 0;
    if (btnNext) btnNext.disabled = this.currentTipSlideIndex === TIP_SLIDES.length - 1;
    if (counter) counter.innerText = `Tip ${this.currentTipSlideIndex + 1} of ${TIP_SLIDES.length}`;

    if (container) {
      container.innerHTML = `
        <span class="tip-card-badge" style="background: ${slide.badgeColor}22; border: 1px solid ${slide.badgeColor}66; color: ${slide.badgeColor};">
          ${slide.badge}
        </span>
        <div class="tip-card-title">${slide.title}</div>
        <div class="tip-card-desc">${slide.description}</div>
        <div class="tip-card-rows">
          ${slide.rows.map(r => `
            <div class="tip-row">
              <span class="tip-key">${r.key}</span>
              <span class="tip-text">${r.desc}</span>
            </div>
          `).join('')}
        </div>
        <div class="tip-protip-box">
          <strong>💡 PRO TIP:</strong> ${slide.proTip}
        </div>
      `;
    }

    if (dotsContainer) {
      dotsContainer.innerHTML = TIP_SLIDES.map((_, i) => `
        <div class="tip-dot ${i === this.currentTipSlideIndex ? 'active' : ''}" data-dot-idx="${i}"></div>
      `).join('');
      dotsContainer.querySelectorAll('.tip-dot').forEach(d => {
        d.addEventListener('click', () => {
          const idx = parseInt(d.getAttribute('data-dot-idx') || '0', 10);
          this.renderTipSlide(idx);
        });
      });
    }
  }

  private setupFeatureControls() {
    const sel = document.getElementById('dev-feature-select') as HTMLSelectElement | null;
    const sliderX = document.getElementById('feat-slide-x') as HTMLInputElement | null;
    const sliderZ = document.getElementById('feat-slide-z') as HTMLInputElement | null;
    const sliderRot = document.getElementById('feat-rotate-z') as HTMLInputElement | null;
    const valX = document.getElementById('val-feat-x');
    const valZ = document.getElementById('val-feat-z');
    const valRot = document.getElementById('val-feat-rot');

    sel?.addEventListener('change', () => {
      const idx = parseInt(sel.value, 10);
      this.selectedFeatureIdx = idx;
      this.callbacks.onSelectFeature?.(idx);
    });

    let moveRaf: number | null = null;
    let pendingX: number | null = null;
    let pendingZ: number | null = null;

    const dispatchMove = (isLive: boolean) => {
      if (pendingX !== null && pendingZ !== null && this.selectedFeatureIdx >= 0) {
        this.callbacks.onMoveFeature?.(this.selectedFeatureIdx, pendingX, pendingZ, isLive);
      }
      moveRaf = null;
    };

    const triggerMove = (x: number, z: number, isLive: boolean) => {
      pendingX = x;
      pendingZ = z;
      if (!isLive) {
        if (moveRaf) cancelAnimationFrame(moveRaf);
        dispatchMove(false);
        return;
      }
      if (!moveRaf) {
        moveRaf = requestAnimationFrame(() => dispatchMove(true));
      }
    };

    sliderX?.addEventListener('input', () => {
      const x = parseFloat(sliderX.value);
      if (valX) valX.innerText = `${x}m`;
      const curZ = sliderZ ? parseFloat(sliderZ.value) : 200;
      triggerMove(x, curZ, true);
    });

    sliderX?.addEventListener('change', () => {
      const x = parseFloat(sliderX.value);
      const curZ = sliderZ ? parseFloat(sliderZ.value) : 200;
      triggerMove(x, curZ, false);
    });

    sliderZ?.addEventListener('input', () => {
      const z = parseFloat(sliderZ.value);
      if (valZ) valZ.innerText = `${z}m`;
      const curX = sliderX ? parseFloat(sliderX.value) : 100;
      triggerMove(curX, z, true);
    });

    sliderZ?.addEventListener('change', () => {
      const z = parseFloat(sliderZ.value);
      const curX = sliderX ? parseFloat(sliderX.value) : 100;
      triggerMove(curX, z, false);
    });

    let rotRaf: number | null = null;
    let pendingRad: number | null = null;

    const dispatchRot = (isLive: boolean) => {
      if (pendingRad !== null && this.selectedFeatureIdx >= 0) {
        this.callbacks.onRotateFeature?.(this.selectedFeatureIdx, pendingRad, isLive);
      }
      rotRaf = null;
    };

    const triggerRot = (rad: number, isLive: boolean) => {
      pendingRad = rad;
      if (!isLive) {
        if (rotRaf) cancelAnimationFrame(rotRaf);
        dispatchRot(false);
        return;
      }
      if (!rotRaf) {
        rotRaf = requestAnimationFrame(() => dispatchRot(true));
      }
    };

    sliderRot?.addEventListener('input', () => {
      const deg = parseFloat(sliderRot.value);
      if (valRot) valRot.innerText = `${deg}°`;
      const rad = (deg * Math.PI) / 180.0;
      triggerRot(rad, true);
    });

    sliderRot?.addEventListener('change', () => {
      const deg = parseFloat(sliderRot.value);
      const rad = (deg * Math.PI) / 180.0;
      triggerRot(rad, false);
    });
  }

  private setupFeatureMaterialControls() {
    const baseColorInput = document.getElementById('feat-mat-base-color') as HTMLInputElement | null;
    const valBaseColor = document.getElementById('val-feat-base-color');
    const colorTexInput = document.getElementById('feat-mat-color-tex-level') as HTMLInputElement | null;
    const valColorTex = document.getElementById('val-feat-color-tex-level');
    const roughInput = document.getElementById('feat-mat-rough-level') as HTMLInputElement | null;
    const valRough = document.getElementById('val-feat-rough-level');
    const metallicInput = document.getElementById('feat-mat-metallic-level') as HTMLInputElement | null;
    const valMetallic = document.getElementById('val-feat-metallic-level');

    const scaleUInput = document.getElementById('feat-mat-uv-scale-u') as HTMLInputElement | null;
    const valScaleU = document.getElementById('val-feat-scale-u');
    const scaleVInput = document.getElementById('feat-mat-uv-scale-v') as HTMLInputElement | null;
    const valScaleV = document.getElementById('val-feat-scale-v');
    const offsetUInput = document.getElementById('feat-mat-uv-offset-u') as HTMLInputElement | null;
    const valOffsetU = document.getElementById('val-feat-offset-u');
    const offsetVInput = document.getElementById('feat-mat-uv-offset-v') as HTMLInputElement | null;
    const valOffsetV = document.getElementById('val-feat-offset-v');

    const normalInput = document.getElementById('feat-mat-normal-level') as HTMLInputElement | null;
    const valNormal = document.getElementById('val-feat-normal');

    const chkColor = document.getElementById('feat-mat-tex-color') as HTMLInputElement | null;
    const chkRough = document.getElementById('feat-mat-tex-rough') as HTMLInputElement | null;
    const chkNormal = document.getElementById('feat-mat-tex-normal') as HTMLInputElement | null;
    const btnReset = document.getElementById('btn-reset-feat-mat');

    const notifyChange = (settings: Partial<FeatureMaterialSettings>) => {
      if (this.selectedFeatureIdx >= 0) {
        this.callbacks.onFeatureMaterialChange?.(this.selectedFeatureIdx, this.selectedFeatureSubMatId, settings);
      }
    };

    baseColorInput?.addEventListener('input', () => {
      if (valBaseColor) valBaseColor.innerText = baseColorInput.value;
      notifyChange({ baseColor: baseColorInput.value });
    });

    colorTexInput?.addEventListener('input', () => {
      const val = Math.max(0, Math.min(1, parseFloat(colorTexInput.value)));
      if (valColorTex) valColorTex.innerText = val.toFixed(2);
      notifyChange({ colorTexLevel: val });
    });

    roughInput?.addEventListener('input', () => {
      const val = Math.max(0, Math.min(1, parseFloat(roughInput.value)));
      if (valRough) valRough.innerText = val.toFixed(2);
      notifyChange({ roughnessLevel: val });
    });

    metallicInput?.addEventListener('input', () => {
      const val = Math.max(0, Math.min(1, parseFloat(metallicInput.value)));
      if (valMetallic) valMetallic.innerText = val.toFixed(2);
      notifyChange({ metallicLevel: val });
    });

    scaleUInput?.addEventListener('input', () => {
      const val = parseFloat(scaleUInput.value);
      if (valScaleU) valScaleU.innerText = val.toFixed(2);
      notifyChange({ uScale: val });
    });

    scaleVInput?.addEventListener('input', () => {
      const val = parseFloat(scaleVInput.value);
      if (valScaleV) valScaleV.innerText = val.toFixed(2);
      notifyChange({ vScale: val });
    });

    offsetUInput?.addEventListener('input', () => {
      const val = parseFloat(offsetUInput.value);
      if (valOffsetU) valOffsetU.innerText = val.toFixed(2);
      notifyChange({ uOffset: val });
    });

    offsetVInput?.addEventListener('input', () => {
      const val = parseFloat(offsetVInput.value);
      if (valOffsetV) valOffsetV.innerText = val.toFixed(2);
      notifyChange({ vOffset: val });
    });

    normalInput?.addEventListener('input', () => {
      const val = parseFloat(normalInput.value);
      if (valNormal) valNormal.innerText = val.toFixed(2);
      notifyChange({ normalLevel: val });
    });

    chkColor?.addEventListener('change', () => {
      notifyChange({ enableBaseColorTex: chkColor.checked });
    });
    chkRough?.addEventListener('change', () => {
      notifyChange({ enableRoughnessTex: chkRough.checked });
    });
    chkNormal?.addEventListener('change', () => {
      notifyChange({ enableNormalTex: chkNormal.checked });
    });

    btnReset?.addEventListener('click', () => {
      if (this.selectedFeatureIdx >= 0) {
        this.callbacks.onResetFeatureMaterial?.(this.selectedFeatureIdx, this.selectedFeatureSubMatId);
      }
    });

    // Wire Mowing Stripes & Collar Rings
    const chkStripes = document.getElementById('feat-mat-stripes-toggle') as HTMLInputElement | null;
    const chkCollars = document.getElementById('feat-mat-collars-toggle') as HTMLInputElement | null;
    const sliderStripeWidth = document.getElementById('feat-mat-stripe-width') as HTMLInputElement | null;
    const valStripeWidth = document.getElementById('val-feat-stripe-width');
    const sliderStripeContrast = document.getElementById('feat-mat-stripe-contrast') as HTMLInputElement | null;
    const valStripeContrast = document.getElementById('val-feat-stripe-contrast');
    const sliderCollarWidth = document.getElementById('feat-mat-collar-width') as HTMLInputElement | null;
    const valCollarWidth = document.getElementById('val-feat-collar-width');

    chkStripes?.addEventListener('change', () => {
      notifyChange({ showMowingStripes: chkStripes.checked });
    });

    chkCollars?.addEventListener('change', () => {
      notifyChange({ showCollarRings: chkCollars.checked });
    });

    let stripeWidthRaf: number | null = null;
    sliderStripeWidth?.addEventListener('input', () => {
      const val = parseFloat(sliderStripeWidth.value);
      if (valStripeWidth) valStripeWidth.innerText = `${val.toFixed(1)}m`;
      if (stripeWidthRaf) cancelAnimationFrame(stripeWidthRaf);
      stripeWidthRaf = requestAnimationFrame(() => {
        stripeWidthRaf = null;
        notifyChange({ mowingStripeWidth: val });
      });
    });

    let stripeContrastRaf: number | null = null;
    sliderStripeContrast?.addEventListener('input', () => {
      const val = parseFloat(sliderStripeContrast.value);
      if (valStripeContrast) valStripeContrast.innerText = `${Math.round(val * 100)}%`;
      if (stripeContrastRaf) cancelAnimationFrame(stripeContrastRaf);
      stripeContrastRaf = requestAnimationFrame(() => {
        stripeContrastRaf = null;
        notifyChange({ mowingStripeContrast: val });
      });
    });

    let collarWidthRaf: number | null = null;
    sliderCollarWidth?.addEventListener('input', () => {
      const val = parseFloat(sliderCollarWidth.value);
      if (valCollarWidth) valCollarWidth.innerText = `${val.toFixed(1)}m`;
      if (collarWidthRaf) cancelAnimationFrame(collarWidthRaf);
      collarWidthRaf = requestAnimationFrame(() => {
        collarWidthRaf = null;
        notifyChange({ collarWidth: val });
      });
    });

    // Wire Feature Image Map Uploads
    const bindFeatureUpload = (inputId: string, thumbId: string, nameId: string, slot: 'color' | 'roughness' | 'normal') => {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
      input?.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result as string;
          if (!dataUrl) return;
          const thumb = document.getElementById(thumbId) as HTMLImageElement | null;
          const nameEl = document.getElementById(nameId);
          if (thumb) thumb.src = dataUrl;
          if (nameEl) nameEl.innerText = file.name;
          if (this.selectedFeatureIdx >= 0) {
            this.callbacks.onFeatureTextureUpload?.(this.selectedFeatureIdx, this.selectedFeatureSubMatId, slot, dataUrl, file.name);
          }
        };
        reader.readAsDataURL(file);
        input.value = '';
      });
    };
    bindFeatureUpload('feat-upload-color', 'feat-thumb-color', 'feat-name-color', 'color');
    bindFeatureUpload('feat-upload-rough', 'feat-thumb-rough', 'feat-name-rough', 'roughness');
    bindFeatureUpload('feat-upload-normal', 'feat-thumb-normal', 'feat-name-normal', 'normal');
  }

  private setupObjectMaterialControls() {
    const objSelect = document.getElementById('dev-object-select') as HTMLSelectElement | null;
    objSelect?.addEventListener('change', () => {
      if (objSelect.value) {
        this.callbacks.onSelectObjectById?.(objSelect.value);
      }
    });

    const baseColorInput = document.getElementById('obj-mat-base-color') as HTMLInputElement | null;
    const valBaseColor = document.getElementById('val-obj-base-color');
    const colorTexInput = document.getElementById('obj-mat-color-tex-level') as HTMLInputElement | null;
    const valColorTex = document.getElementById('val-obj-color-tex-level');
    const roughInput = document.getElementById('obj-mat-rough-level') as HTMLInputElement | null;
    const valRough = document.getElementById('val-obj-rough-level');
    const metallicInput = document.getElementById('obj-mat-metallic-level') as HTMLInputElement | null;
    const valMetallic = document.getElementById('val-obj-metallic-level');

    const scaleUInput = document.getElementById('obj-mat-uv-scale-u') as HTMLInputElement | null;
    const valScaleU = document.getElementById('val-obj-scale-u');
    const scaleVInput = document.getElementById('obj-mat-uv-scale-v') as HTMLInputElement | null;
    const valScaleV = document.getElementById('val-obj-scale-v');
    const offsetUInput = document.getElementById('obj-mat-uv-offset-u') as HTMLInputElement | null;
    const valOffsetU = document.getElementById('val-obj-offset-u');
    const offsetVInput = document.getElementById('obj-mat-uv-offset-v') as HTMLInputElement | null;
    const valOffsetV = document.getElementById('val-obj-offset-v');

    const normalInput = document.getElementById('obj-mat-normal-level') as HTMLInputElement | null;
    const valNormal = document.getElementById('val-obj-normal');

    const chkColor = document.getElementById('obj-mat-tex-color') as HTMLInputElement | null;
    const chkRough = document.getElementById('obj-mat-tex-rough') as HTMLInputElement | null;
    const chkNormal = document.getElementById('obj-mat-tex-normal') as HTMLInputElement | null;
    const btnReset = document.getElementById('btn-reset-obj-mat');

    const notifyChange = (settings: any) => {
      this.callbacks.onObjectMaterialChange?.(settings);
    };

    baseColorInput?.addEventListener('input', () => {
      if (valBaseColor) valBaseColor.innerText = baseColorInput.value;
      notifyChange({ baseColor: baseColorInput.value });
    });

    colorTexInput?.addEventListener('input', () => {
      const val = Math.max(0, Math.min(1, parseFloat(colorTexInput.value)));
      if (valColorTex) valColorTex.innerText = val.toFixed(2);
      notifyChange({ colorTexLevel: val });
    });

    roughInput?.addEventListener('input', () => {
      const val = Math.max(0, Math.min(1, parseFloat(roughInput.value)));
      if (valRough) valRough.innerText = val.toFixed(2);
      notifyChange({ roughnessLevel: val });
    });

    metallicInput?.addEventListener('input', () => {
      const val = Math.max(0, Math.min(1, parseFloat(metallicInput.value)));
      if (valMetallic) valMetallic.innerText = val.toFixed(2);
      notifyChange({ metallicLevel: val });
    });

    scaleUInput?.addEventListener('input', () => {
      const val = parseFloat(scaleUInput.value);
      if (valScaleU) valScaleU.innerText = val.toFixed(2);
      notifyChange({ uScale: val });
    });

    scaleVInput?.addEventListener('input', () => {
      const val = parseFloat(scaleVInput.value);
      if (valScaleV) valScaleV.innerText = val.toFixed(2);
      notifyChange({ vScale: val });
    });

    offsetUInput?.addEventListener('input', () => {
      const val = parseFloat(offsetUInput.value);
      if (valOffsetU) valOffsetU.innerText = val.toFixed(2);
      notifyChange({ uOffset: val });
    });

    offsetVInput?.addEventListener('input', () => {
      const val = parseFloat(offsetVInput.value);
      if (valOffsetV) valOffsetV.innerText = val.toFixed(2);
      notifyChange({ vOffset: val });
    });

    normalInput?.addEventListener('input', () => {
      const val = parseFloat(normalInput.value);
      if (valNormal) valNormal.innerText = val.toFixed(2);
      notifyChange({ normalLevel: val });
    });

    chkColor?.addEventListener('change', () => {
      notifyChange({ enableBaseColorTex: chkColor.checked });
    });
    chkRough?.addEventListener('change', () => {
      notifyChange({ enableRoughnessTex: chkRough.checked });
    });
    chkNormal?.addEventListener('change', () => {
      notifyChange({ enableNormalTex: chkNormal.checked });
    });

    btnReset?.addEventListener('click', () => {
      this.callbacks.onResetObjectMaterial?.();
    });

    // Wire 3D Object Image Map Uploads
    const bindObjectUpload = (inputId: string, thumbId: string, nameId: string, slot: 'color' | 'roughness' | 'normal') => {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
      input?.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result as string;
          if (!dataUrl) return;
          const thumb = document.getElementById(thumbId) as HTMLImageElement | null;
          const nameEl = document.getElementById(nameId);
          if (thumb) thumb.src = dataUrl;
          if (nameEl) nameEl.innerText = file.name;
          this.callbacks.onObjectTextureUpload?.(slot, dataUrl, file.name);
        };
        reader.readAsDataURL(file);
        input.value = '';
      });
    };
    bindObjectUpload('obj-upload-color', 'obj-thumb-color', 'obj-name-color', 'color');
    bindObjectUpload('obj-upload-rough', 'obj-thumb-rough', 'obj-name-rough', 'roughness');
    bindObjectUpload('obj-upload-normal', 'obj-thumb-normal', 'obj-name-normal', 'normal');
  }

  private setupGroundTextureControls() {
    const bindGroundUpload = (
      inputId: string,
      thumbId: string,
      nameId: string,
      chkId: string,
      slot: 'color' | 'roughness' | 'normal' | 'satellite'
    ) => {
      const input = document.getElementById(inputId) as HTMLInputElement | null;
      input?.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result as string;
          if (!dataUrl) return;
          const thumb = document.getElementById(thumbId) as HTMLImageElement | null;
          const nameEl = document.getElementById(nameId);
          const chkEl = document.getElementById(chkId) as HTMLInputElement | null;
          if (thumb) {
            thumb.src = dataUrl;
            thumb.style.display = 'block';
          }
          if (slot === 'satellite') {
            const emptySat = document.getElementById('ground-satellite-empty');
            if (emptySat) emptySat.style.display = 'none';
          }
          if (nameEl) nameEl.innerText = file.name;
          if (chkEl) chkEl.checked = true;
          this.callbacks.onGroundTextureUpload?.(slot, dataUrl, file.name);
        };
        reader.readAsDataURL(file);
        input.value = '';
      });
    };
    bindGroundUpload('ground-upload-color', 'ground-thumb-color', 'ground-name-color', 'ground-mat-tex-color', 'color');
    bindGroundUpload('ground-upload-rough', 'ground-thumb-rough', 'ground-name-rough', 'ground-mat-tex-rough', 'roughness');
    bindGroundUpload('ground-upload-normal', 'ground-thumb-normal', 'ground-name-normal', 'ground-mat-tex-normal', 'normal');
    bindGroundUpload('ground-upload-satellite', 'ground-thumb-satellite', 'ground-name-satellite', 'ground-mat-tex-satellite', 'satellite');
  }

  public updateFeatureList(features: any[], selectedIndex: number = -1) {
    this.activeFeatureList = features;
    this.selectedFeatureIdx = selectedIndex;

    const sel = document.getElementById('dev-feature-select') as HTMLSelectElement | null;
    if (sel) {
      sel.innerHTML = '<option value="-1">-- Click on Course or Pick --</option>' +
        features.map((f, i) => `
          <option value="${i}" ${i === selectedIndex ? 'selected' : ''}>
            ${f.name || f.surfaceType} (${Math.round(f.centerX)}m, ${Math.round(f.centerZ)}m)
          </option>
        `).join('');
    }

    const controls = document.getElementById('dev-feature-sliders');
    if (selectedIndex >= 0 && selectedIndex < features.length) {
      const feat = features[selectedIndex];
      if (controls) controls.style.display = 'block';
      this.updateDevSelectedFeature(feat, selectedIndex);
    } else {
      if (controls) controls.style.display = 'none';
    }
  }

  public updateDevSelectedFeature(feat: any | null, index: number) {
    this.selectedFeatureIdx = index;
    const controls = document.getElementById('dev-feature-sliders');
    const sel = document.getElementById('dev-feature-select') as HTMLSelectElement | null;
    if (sel) sel.value = index.toString();

    if (!feat || index < 0) {
      if (controls) controls.style.display = 'none';
      return;
    }

    if (controls) controls.style.display = 'block';
    const sliderX = document.getElementById('feat-slide-x') as HTMLInputElement | null;
    const sliderZ = document.getElementById('feat-slide-z') as HTMLInputElement | null;
    const sliderRot = document.getElementById('feat-rotate-z') as HTMLInputElement | null;
    const valX = document.getElementById('val-feat-x');
    const valZ = document.getElementById('val-feat-z');
    const valRot = document.getElementById('val-feat-rot');

    if (sliderX) sliderX.value = feat.centerX.toString();
    if (sliderZ) sliderZ.value = feat.centerZ.toString();
    const rotRawDeg = Math.round((feat.rotationRad * 180.0) / Math.PI);
    const deg = ((rotRawDeg % 360) + 360) % 360;
    if (sliderRot) sliderRot.value = deg.toString();

    if (valX) valX.innerText = `${Math.round(feat.centerX)}m`;
    if (valZ) valZ.innerText = `${Math.round(feat.centerZ)}m`;
    if (valRot) valRot.innerText = `${deg}°`;

    const fwayRow = document.getElementById('feat-fairway-shape-row');
    const bunkerRow = document.getElementById('feat-bunker-shape-row');
    if (fwayRow) {
      if (feat.surfaceType === SurfaceType.FAIRWAY) {
        fwayRow.style.display = 'block';
        const curShape = feat.id === 'fairway_dogleg_left' ? 'dogleg_left' : feat.id === 'fairway_landing_straight' ? 'straight' : 'dogleg_right';
        document.querySelectorAll('.btn-fway-shape').forEach(b => {
          if (b.getAttribute('data-shape') === curShape) {
            b.classList.add('btn-primary');
            b.classList.remove('btn-secondary');
          } else {
            b.classList.remove('btn-primary');
            b.classList.add('btn-secondary');
          }
        });
      } else {
        fwayRow.style.display = 'none';
      }
    }

    if (bunkerRow) {
      if (feat.surfaceType === SurfaceType.BUNKER) {
        bunkerRow.style.display = 'block';
        const bIdx = feat.bunkerShapeIndex ?? 0;
        document.querySelectorAll('.btn-bunker-shape').forEach(b => {
          const s = parseInt(b.getAttribute('data-shape') || '0', 10);
          if (s === bIdx) {
            b.classList.add('btn-primary');
            b.classList.remove('btn-secondary');
          } else {
            b.classList.remove('btn-primary');
            b.classList.add('btn-secondary');
          }
        });
      } else {
        bunkerRow.style.display = 'none';
      }
    }

    // Also reflect in the dev-selected-info box
    const info = document.getElementById('dev-selected-info');
    if (info) {
      info.innerHTML = `
        <div class="dev-obj-name" style="color: #38bdf8;">${feat.name || feat.surfaceType}</div>
        <div class="dev-obj-details">
          Center: X: ${feat.centerX.toFixed(1)}m, Z: ${feat.centerZ.toFixed(1)}m<br/>
          Rotation Z: ${deg}° | Size: ${Math.round(feat.width)}m x ${Math.round(feat.length)}m
        </div>
      `;
    }
  }

  public updateDevObjectList(models: { id: string; label: string }[], selectedId: string | null) {
    const sel = document.getElementById('dev-object-select') as HTMLSelectElement | null;
    if (!sel) return;
    sel.innerHTML =
      '<option value="">-- Click Model in Scene or Pick --</option>' +
      models
        .map(
          (m) =>
            `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${m.label}</option>`
        )
        .join('');
    if (selectedId) {
      sel.value = selectedId;
    }
  }

  public updateDevSelectedObject(mesh: any | null, allowDelete: boolean = true, isFeatureProxy: boolean = false) {
    const info = document.getElementById('dev-selected-info');
    const btnDel = document.getElementById('btn-dev-delete-obj');
    const btnFrame = document.getElementById('btn-dev-frame-obj');
    const btnReplaceGlb = document.getElementById('btn-replace-object-glb');
    const selObj = document.getElementById('dev-object-select') as HTMLSelectElement | null;
    if (!info) return;

    if (!mesh || isFeatureProxy) {
      if (!mesh && !isFeatureProxy && this.selectedFeatureIdx < 0) {
        info.innerHTML = '<div class="dev-info-empty">Click any 3D model, tree, rock, cliff, prop, or course feature to select</div>';
      }
      if (btnDel) btnDel.style.display = 'none';
      if (btnFrame) btnFrame.style.display = 'none';
      if (btnReplaceGlb) btnReplaceGlb.style.display = 'none';
      if (selObj) selObj.value = '';
      return;
    }

    if (selObj && mesh.name) {
      selObj.value = mesh.name;
    }
    if (btnDel) btnDel.style.display = allowDelete ? 'block' : 'none';
    if (btnFrame) btnFrame.style.display = 'block';
    if (btnReplaceGlb) btnReplaceGlb.style.display = 'block';

    const p = mesh.position;
    const r = mesh.rotation;
    const s = mesh.scaling;
    const rawDeg = Math.round((r.y * 180) / Math.PI);
    const rotZDeg = ((rawDeg % 360) + 360) % 360;

    info.innerHTML = `
      <div class="dev-obj-name">${mesh.name}</div>
      <div class="dev-obj-details">
        Pos: (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})<br/>
        Rot Z: ${rotZDeg}° | Scale: (${s.x.toFixed(2)}, ${s.y.toFixed(2)}, ${s.z.toFixed(2)})
      </div>
    `;
  }

  private renderSubMaterialPills(
    container: HTMLElement | null,
    items: { key: string; label: string; colorHex?: string }[],
    activeKey: string,
    onPick: (key: string) => void
  ) {
    if (!container) return;
    container.innerHTML = '';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `dev-submat-pill${item.key === activeKey ? ' active' : ''}`;
      btn.setAttribute('data-submat-key', item.key);
      if (item.colorHex) {
        const dot = document.createElement('span');
        dot.className = 'dev-submat-swatch';
        dot.style.background = item.colorHex;
        btn.appendChild(dot);
      }
      const txt = document.createElement('span');
      txt.innerText = item.label;
      btn.appendChild(txt);
      btn.addEventListener('click', () => onPick(item.key));
      container.appendChild(btn);
    }
  }

  public updateDevSelectedFeatureMaterial(
    feat: StampedFeatureRecord | null,
    mat: FeatureMaterialSettings | null,
    subOptions?: FeatureSubMaterialOption[],
    activeSubId: FeatureSubMaterialId = 'surface',
    subColorMap?: Partial<Record<FeatureSubMaterialId, string>>
  ) {
    const sec = document.getElementById('dev-feature-material-section');
    if (!sec) return;

    if (!feat || !mat || this.selectedFeatureIdx < 0) {
      sec.style.display = 'none';
      return;
    }

    this.selectedFeatureSubMatId = activeSubId;
    sec.style.display = 'block';
    const objSec = document.getElementById('dev-object-material-section');
    if (objSec) objSec.style.display = 'none';
    const groundSec = document.getElementById('dev-ground-pbr-section');
    if (groundSec) groundSec.style.display = 'none';

    const title = document.getElementById('dev-feat-mat-title');
    if (title) {
      title.innerText = `FEATURE MATERIALS (${String(feat.name || feat.surfaceType).toUpperCase()} #${this.selectedFeatureIdx})`;
    }

    const pillsWrap = document.getElementById('feat-submat-pills');
    const resolvedOpts: FeatureSubMaterialOption[] = subOptions && subOptions.length > 0
      ? subOptions
      : [{ id: 'surface', label: 'Primary Surface' }];

    this.renderSubMaterialPills(
      pillsWrap,
      resolvedOpts.map((o) => ({
        key: o.id,
        label: o.label,
        colorHex: subColorMap?.[o.id] || mat.baseColor || '#28a745'
      })),
      activeSubId,
      (pickedKey) => {
        this.selectedFeatureSubMatId = pickedKey as FeatureSubMaterialId;
        this.callbacks.onFeatureSubMaterialSelect?.(this.selectedFeatureIdx, this.selectedFeatureSubMatId);
      }
    );

    const baseColorInput = document.getElementById('feat-mat-base-color') as HTMLInputElement | null;
    const valBaseColor = document.getElementById('val-feat-base-color');
    const colorTexInput = document.getElementById('feat-mat-color-tex-level') as HTMLInputElement | null;
    const valColorTex = document.getElementById('val-feat-color-tex-level');
    const roughInput = document.getElementById('feat-mat-rough-level') as HTMLInputElement | null;
    const valRough = document.getElementById('val-feat-rough-level');
    const metallicInput = document.getElementById('feat-mat-metallic-level') as HTMLInputElement | null;
    const valMetallic = document.getElementById('val-feat-metallic-level');

    const scaleUInput = document.getElementById('feat-mat-uv-scale-u') as HTMLInputElement | null;
    const valScaleU = document.getElementById('val-feat-scale-u');
    const scaleVInput = document.getElementById('feat-mat-uv-scale-v') as HTMLInputElement | null;
    const valScaleV = document.getElementById('val-feat-scale-v');
    const offsetUInput = document.getElementById('feat-mat-uv-offset-u') as HTMLInputElement | null;
    const valOffsetU = document.getElementById('val-feat-offset-u');
    const offsetVInput = document.getElementById('feat-mat-uv-offset-v') as HTMLInputElement | null;
    const valOffsetV = document.getElementById('val-feat-offset-v');

    const normalInput = document.getElementById('feat-mat-normal-level') as HTMLInputElement | null;
    const valNormal = document.getElementById('val-feat-normal');

    const chkColor = document.getElementById('feat-mat-tex-color') as HTMLInputElement | null;
    const chkRough = document.getElementById('feat-mat-tex-rough') as HTMLInputElement | null;
    const chkNormal = document.getElementById('feat-mat-tex-normal') as HTMLInputElement | null;

    if (baseColorInput && mat.baseColor) {
      baseColorInput.value = mat.baseColor;
      if (valBaseColor) valBaseColor.innerText = mat.baseColor;
    }
    const ctl = Math.max(0, Math.min(1, mat.colorTexLevel ?? 0.72));
    if (colorTexInput) {
      colorTexInput.value = ctl.toFixed(2);
      if (valColorTex) valColorTex.innerText = ctl.toFixed(2);
    }
    const rl = Math.max(0, Math.min(1, mat.roughnessLevel ?? 0.70));
    if (roughInput) {
      roughInput.value = rl.toFixed(2);
      if (valRough) valRough.innerText = rl.toFixed(2);
    }
    const ml = Math.max(0, Math.min(1, mat.metallicLevel ?? 0.0));
    if (metallicInput) {
      metallicInput.value = ml.toFixed(2);
      if (valMetallic) valMetallic.innerText = ml.toFixed(2);
    }
    if (scaleUInput && mat.uScale !== undefined) {
      scaleUInput.value = Math.max(0, mat.uScale).toString();
      if (valScaleU) valScaleU.innerText = Math.max(0, mat.uScale).toFixed(2);
    }
    if (scaleVInput && mat.vScale !== undefined) {
      scaleVInput.value = Math.max(0, mat.vScale).toString();
      if (valScaleV) valScaleV.innerText = Math.max(0, mat.vScale).toFixed(2);
    }
    const normOff = (v: number) => (((v % 1) + 1) % 1);
    if (offsetUInput && mat.uOffset !== undefined) {
      const uo = normOff(mat.uOffset);
      offsetUInput.value = uo.toString();
      if (valOffsetU) valOffsetU.innerText = uo.toFixed(2);
    }
    if (offsetVInput && mat.vOffset !== undefined) {
      const vo = normOff(mat.vOffset);
      offsetVInput.value = vo.toString();
      if (valOffsetV) valOffsetV.innerText = vo.toFixed(2);
    }
    if (normalInput && mat.normalLevel !== undefined) {
      normalInput.value = Math.max(0, mat.normalLevel).toString();
      if (valNormal) valNormal.innerText = Math.max(0, mat.normalLevel).toFixed(2);
    }
    if (chkColor) chkColor.checked = mat.enableBaseColorTex !== false;
    if (chkRough) chkRough.checked = mat.enableRoughnessTex !== false;
    if (chkNormal) chkNormal.checked = mat.enableNormalTex !== false;

    // Show relevant Mowing / Collar options cleanly for the selected sub-material
    const mowingSec = document.getElementById('feat-mowing-section');
    const chipStripes = document.getElementById('chip-feat-stripes');
    const rowStripeWidth = document.getElementById('row-feat-stripe-width');
    const rowStripeContrast = document.getElementById('row-feat-stripe-contrast');
    const chipCollars = document.getElementById('feat-mat-collars-toggle')?.closest('label') as HTMLElement | null;
    const rowCollarWidth = document.getElementById('row-feat-collar-width');

    const supportsStripes =
      activeSubId === 'surface' &&
      (feat.surfaceType === SurfaceType.GREEN || feat.surfaceType === SurfaceType.FAIRWAY || feat.surfaceType === SurfaceType.TEE);
    const supportsCollars =
      ((activeSubId === 'surface' || activeSubId === 'fringe') &&
      (feat.surfaceType === SurfaceType.GREEN || feat.surfaceType === SurfaceType.FAIRWAY || feat.surfaceType === SurfaceType.TEE || feat.surfaceType === SurfaceType.BUNKER || feat.surfaceType === SurfaceType.WATER)) ||
      (feat.surfaceType === SurfaceType.WATER && activeSubId === 'water_surface');

    if (mowingSec) {
      mowingSec.style.display = supportsStripes || supportsCollars ? 'block' : 'none';
    }
    if (chipStripes) chipStripes.style.display = supportsStripes ? 'flex' : 'none';
    if (rowStripeWidth) rowStripeWidth.style.display = supportsStripes ? 'flex' : 'none';
    if (rowStripeContrast) rowStripeContrast.style.display = supportsStripes ? 'flex' : 'none';
    if (chipCollars) chipCollars.style.display = supportsCollars ? 'flex' : 'none';
    if (rowCollarWidth) rowCollarWidth.style.display = supportsCollars ? 'flex' : 'none';

    const chkStripes = document.getElementById('feat-mat-stripes-toggle') as HTMLInputElement | null;
    const chkCollars = document.getElementById('feat-mat-collars-toggle') as HTMLInputElement | null;
    const sliderStripeWidth = document.getElementById('feat-mat-stripe-width') as HTMLInputElement | null;
    const valStripeWidth = document.getElementById('val-feat-stripe-width');
    const sliderStripeContrast = document.getElementById('feat-mat-stripe-contrast') as HTMLInputElement | null;
    const valStripeContrast = document.getElementById('val-feat-stripe-contrast');
    const sliderCollarWidth = document.getElementById('feat-mat-collar-width') as HTMLInputElement | null;
    const valCollarWidth = document.getElementById('val-feat-collar-width');

    if (chkStripes) chkStripes.checked = mat.showMowingStripes !== false;
    if (chkCollars) chkCollars.checked = mat.showCollarRings !== false;
    const stripeW = mat.mowingStripeWidth ?? (feat.surfaceType === SurfaceType.TEE ? 1.6 : feat.surfaceType === SurfaceType.GREEN ? 1.8 : 4.6);
    if (sliderStripeWidth) sliderStripeWidth.value = Math.max(0, stripeW).toString();
    if (valStripeWidth) valStripeWidth.innerText = `${Math.max(0, stripeW).toFixed(1)}m`;
    const stripeC = mat.mowingStripeContrast ?? 0.5;
    if (sliderStripeContrast) sliderStripeContrast.value = Math.max(0, stripeC).toString();
    if (valStripeContrast) valStripeContrast.innerText = `${Math.round(Math.max(0, stripeC) * 100)}%`;

    const defCollar = feat.surfaceType === SurfaceType.TEE ? 0.5 :
                      feat.surfaceType === SurfaceType.GREEN ? 2.2 :
                      feat.surfaceType === SurfaceType.FAIRWAY ? 2.0 :
                      feat.surfaceType === SurfaceType.BUNKER ? 1.2 : 2.15;
    const collarW = mat.collarWidth ?? defCollar;
    if (sliderCollarWidth) sliderCollarWidth.value = Math.max(0, collarW).toString();
    if (valCollarWidth) valCollarWidth.innerText = `${Math.max(0, collarW).toFixed(1)}m`;

    // Populate Feature Sub-Material Map Thumbnails & Filenames using real valid asset paths
    const featThumbColor = document.getElementById('feat-thumb-color') as HTMLImageElement | null;
    const featNameColor = document.getElementById('feat-name-color');
    const featThumbRough = document.getElementById('feat-thumb-rough') as HTMLImageElement | null;
    const featNameRough = document.getElementById('feat-name-rough');
    const featThumbNormal = document.getElementById('feat-thumb-normal') as HTMLImageElement | null;
    const featNameNormal = document.getElementById('feat-name-normal');

    const cUrls = mat.customTextureUrls || (activeSubId === 'surface' ? feat.customTextureUrls : undefined);
    const defColor = '/textures/short_grass_01.jpg';
    const defRough = '/textures/pbr_grass/grass_pbr_rough_512.jpg';
    const defNormal = '/textures/pbr_grass/grass_pbr_nor_1k.jpg';

    const safeFeatUrl = (u: string | undefined, fb: string) => {
      if (!u || !u.trim()) return fb;
      if (u.includes('grass_pbr_diff')) return '/textures/pbr_grass/grass_pbr_diff_1k.jpg';
      if (u.includes('grass_pbr_nor')) return '/textures/pbr_grass/grass_pbr_nor_1k.jpg';
      if (u.includes('grass_pbr_rough')) return '/textures/pbr_grass/grass_pbr_rough_512.jpg';
      return u;
    };

    if (featThumbColor) {
      featThumbColor.onerror = () => { featThumbColor.onerror = null; featThumbColor.src = defColor; };
      featThumbColor.src = safeFeatUrl(cUrls?.color, defColor);
    }
    if (featNameColor) featNameColor.innerText = cUrls?.colorName || 'short_grass_01.jpg';
    if (featThumbRough) {
      featThumbRough.onerror = () => { featThumbRough.onerror = null; featThumbRough.src = defRough; };
      featThumbRough.src = safeFeatUrl(cUrls?.roughness, defRough);
    }
    if (featNameRough) featNameRough.innerText = cUrls?.roughnessName || 'grass_pbr_rough_512.jpg';
    if (featThumbNormal) {
      featThumbNormal.onerror = () => { featThumbNormal.onerror = null; featThumbNormal.src = defNormal; };
      featThumbNormal.src = safeFeatUrl(cUrls?.normal, defNormal);
    }
    if (featNameNormal) featNameNormal.innerText = cUrls?.normalName || 'grass_pbr_nor_1k.jpg';
  }

  public updateDevSelectedObjectMaterial(info: any | null) {
    const sec = document.getElementById('dev-object-material-section');
    if (!sec) return;

    if (!info) {
      sec.style.display = 'none';
      return;
    }

    sec.style.display = 'block';
    const featSec = document.getElementById('dev-feature-material-section');
    if (featSec) featSec.style.display = 'none';
    const groundSec = document.getElementById('dev-ground-pbr-section');
    if (groundSec) groundSec.style.display = 'none';

    const title = document.getElementById('dev-obj-mat-title');
    if (title) {
      title.innerText = `3D OBJECT MATERIAL (${info.name || 'OBJECT'})`;
    }

    // Render Model Sub-Materials Switcher (e.g. Hero Tree Trunk / Branches / Leaves, Flag / Pole / Cup)
    const subWrap = document.getElementById('obj-submat-pills-wrap');
    const subPills = document.getElementById('obj-submat-pills');
    const subMats: { index: number; label: string; colorHex: string }[] = info.subMaterials || [];
    this.selectedObjectSubMatIdx = info.activeSubMatIdx ?? 0;

    if (subWrap && subMats.length > 0) {
      subWrap.style.display = 'block';
      this.renderSubMaterialPills(
        subPills,
        subMats.map((s) => ({
          key: String(s.index),
          label: s.label,
          colorHex: s.colorHex
        })),
        String(this.selectedObjectSubMatIdx),
        (pickedKey) => {
          const idx = parseInt(pickedKey, 10);
          this.selectedObjectSubMatIdx = idx;
          this.callbacks.onObjectSubMaterialSelect?.(idx);
        }
      );
    } else if (subWrap) {
      subWrap.style.display = 'none';
    }

    const baseColorInput = document.getElementById('obj-mat-base-color') as HTMLInputElement | null;
    const valBaseColor = document.getElementById('val-obj-base-color');
    const colorTexInput = document.getElementById('obj-mat-color-tex-level') as HTMLInputElement | null;
    const valColorTex = document.getElementById('val-obj-color-tex-level');
    const roughInput = document.getElementById('obj-mat-rough-level') as HTMLInputElement | null;
    const valRough = document.getElementById('val-obj-rough-level');
    const metallicInput = document.getElementById('obj-mat-metallic-level') as HTMLInputElement | null;
    const valMetallic = document.getElementById('val-obj-metallic-level');

    const scaleUInput = document.getElementById('obj-mat-uv-scale-u') as HTMLInputElement | null;
    const valScaleU = document.getElementById('val-obj-scale-u');
    const scaleVInput = document.getElementById('obj-mat-uv-scale-v') as HTMLInputElement | null;
    const valScaleV = document.getElementById('val-obj-scale-v');
    const offsetUInput = document.getElementById('obj-mat-uv-offset-u') as HTMLInputElement | null;
    const valOffsetU = document.getElementById('val-obj-offset-u');
    const offsetVInput = document.getElementById('obj-mat-uv-offset-v') as HTMLInputElement | null;
    const valOffsetV = document.getElementById('val-obj-offset-v');

    const normalInput = document.getElementById('obj-mat-normal-level') as HTMLInputElement | null;
    const valNormal = document.getElementById('val-obj-normal');

    const chkColor = document.getElementById('obj-mat-tex-color') as HTMLInputElement | null;
    const chkRough = document.getElementById('obj-mat-tex-rough') as HTMLInputElement | null;
    const chkNormal = document.getElementById('obj-mat-tex-normal') as HTMLInputElement | null;

    if (baseColorInput && info.baseColor) {
      baseColorInput.value = info.baseColor;
      if (valBaseColor) valBaseColor.innerText = info.baseColor;
    }
    const ctl = Math.max(0, Math.min(1, info.colorTexLevel ?? 1.0));
    if (colorTexInput) {
      colorTexInput.value = ctl.toFixed(2);
      if (valColorTex) valColorTex.innerText = ctl.toFixed(2);
    }
    const rl = Math.max(0, Math.min(1, info.roughnessLevel ?? 0.65));
    if (roughInput) {
      roughInput.value = rl.toFixed(2);
      if (valRough) valRough.innerText = rl.toFixed(2);
    }
    const ml = Math.max(0, Math.min(1, info.metallicLevel ?? 0.0));
    if (metallicInput) {
      metallicInput.value = ml.toFixed(2);
      if (valMetallic) valMetallic.innerText = ml.toFixed(2);
    }
    if (scaleUInput && info.uScale !== undefined) {
      scaleUInput.value = Math.max(0, info.uScale).toString();
      if (valScaleU) valScaleU.innerText = Math.max(0, info.uScale).toFixed(2);
    }
    if (scaleVInput && info.vScale !== undefined) {
      scaleVInput.value = Math.max(0, info.vScale).toString();
      if (valScaleV) valScaleV.innerText = Math.max(0, info.vScale).toFixed(2);
    }
    const normOff = (v: number) => (((v % 1) + 1) % 1);
    if (offsetUInput && info.uOffset !== undefined) {
      const uo = normOff(info.uOffset);
      offsetUInput.value = uo.toString();
      if (valOffsetU) valOffsetU.innerText = uo.toFixed(2);
    }
    if (offsetVInput && info.vOffset !== undefined) {
      const vo = normOff(info.vOffset);
      offsetVInput.value = vo.toString();
      if (valOffsetV) valOffsetV.innerText = vo.toFixed(2);
    }
    if (normalInput && info.normalLevel !== undefined) {
      normalInput.value = Math.max(0, info.normalLevel).toString();
      if (valNormal) valNormal.innerText = Math.max(0, info.normalLevel).toFixed(2);
    }
    if (chkColor) chkColor.checked = info.enableBaseColorTex !== false;
    if (chkRough) chkRough.checked = info.enableRoughnessTex !== false;
    if (chkNormal) chkNormal.checked = info.enableNormalTex !== false;

    // Populate 3D Object Map Thumbnails & Filenames
    const objThumbColor = document.getElementById('obj-thumb-color') as HTMLImageElement | null;
    const objNameColor = document.getElementById('obj-name-color');
    const objThumbRough = document.getElementById('obj-thumb-rough') as HTMLImageElement | null;
    const objNameRough = document.getElementById('obj-name-rough');
    const objThumbNormal = document.getElementById('obj-thumb-normal') as HTMLImageElement | null;
    const objNameNormal = document.getElementById('obj-name-normal');

    const safeObjUrl = (u: string | undefined, fb: string) => {
      if (!u || !u.trim()) return fb;
      if (u.includes('grass_pbr_diff')) return '/textures/pbr_grass/grass_pbr_diff_1k.jpg';
      if (u.includes('grass_pbr_nor')) return '/textures/pbr_grass/grass_pbr_nor_1k.jpg';
      if (u.includes('grass_pbr_rough')) return '/textures/pbr_grass/grass_pbr_rough_512.jpg';
      return u;
    };

    if (objThumbColor) {
      objThumbColor.onerror = () => { objThumbColor.onerror = null; objThumbColor.src = '/textures/pbr_grass/grass_pbr_diff_1k.jpg'; };
      objThumbColor.src = safeObjUrl(info.colorMapUrl, '/textures/pbr_grass/grass_pbr_diff_1k.jpg');
    }
    if (objNameColor) objNameColor.innerText = info.colorMapName || 'model_diff.jpg';
    if (objThumbRough) {
      objThumbRough.onerror = () => { objThumbRough.onerror = null; objThumbRough.src = '/textures/pbr_grass/grass_pbr_rough_512.jpg'; };
      objThumbRough.src = safeObjUrl(info.roughnessMapUrl, '/textures/pbr_grass/grass_pbr_rough_512.jpg');
    }
    if (objNameRough) objNameRough.innerText = info.roughnessMapName || 'model_rough.jpg';
    if (objThumbNormal) {
      objThumbNormal.onerror = () => { objThumbNormal.onerror = null; objThumbNormal.src = '/textures/pbr_grass/grass_pbr_nor_1k.jpg'; };
      objThumbNormal.src = safeObjUrl(info.normalMapUrl, '/textures/pbr_grass/grass_pbr_nor_1k.jpg');
    }
    if (objNameNormal) objNameNormal.innerText = info.normalMapName || 'model_nor.jpg';
  }

  public setUndoRedoEnabled(canUndo: boolean, canRedo: boolean) {
    const btnUndo = document.getElementById('btn-dev-undo') as HTMLButtonElement | null;
    const btnRedo = document.getElementById('btn-dev-redo') as HTMLButtonElement | null;
    if (btnUndo) {
      btnUndo.disabled = !canUndo;
      btnUndo.style.opacity = canUndo ? '1.0' : '0.45';
      btnUndo.style.cursor = canUndo ? 'pointer' : 'not-allowed';
    }
    if (btnRedo) {
      btnRedo.disabled = !canRedo;
      btnRedo.style.opacity = canRedo ? '1.0' : '0.45';
      btnRedo.style.cursor = canRedo ? 'pointer' : 'not-allowed';
    }
  }

  public updateHotkeysGuide(mode: 'play' | 'designer') {
    this.currentMode = mode;
    const badge = document.getElementById('tips-mode-badge');
    if (badge) {
      badge.innerText = mode === 'play' ? 'PLAY MODE' : 'DESIGNER MODE';
    }
  }

  public renderHdriPresets(presets: HdriPreset[], activeId: string) {
    this.activeHdriPresetId = activeId;
    const container = document.getElementById('hdri-cards-container');
    if (!container) return;
    container.innerHTML = '';

    for (const preset of presets) {
      const card = document.createElement('div');
      card.className = 'hdri-card' + (preset.id === activeId ? ' is-active' : '');
      card.dataset.id = preset.id;

      card.innerHTML = `
        <div class="hdri-card-thumb" style="background: ${preset.thumbnailBg};">
          <img class="hdri-sphere-img" src="${preset.thumbnailImg}" alt="${preset.name} sphere preview" loading="lazy" />
          <span class="hdri-card-res-badge">${preset.resolution}</span>
        </div>
        <div class="hdri-card-name" title="${preset.name}">${preset.name}</div>
        <div class="hdri-card-vibe" title="${preset.vibe}">${preset.vibe}</div>
      `;

      card.addEventListener('click', (e) => {
        e.stopPropagation();
        container.querySelectorAll('.hdri-card').forEach((el) => el.classList.remove('is-active'));
        card.classList.add('is-active');
        this.activeHdriPresetId = preset.id;
        this.callbacks.onHdriPresetSelect?.(preset.id);
      });

      container.appendChild(card);
    }
  }

  public updateEnvironmentInputs(env: EnvironmentSettings) {
    if (env.hdriId) {
      this.activeHdriPresetId = env.hdriId;
      const cards = document.querySelectorAll('.hdri-card');
      cards.forEach((c) => {
        const id = (c as HTMLElement).dataset.id;
        c.classList.toggle('is-active', id === env.hdriId);
      });
    }

    const rotInput = document.getElementById('input-hdri-rot') as HTMLInputElement | null;
    const valRot = document.getElementById('val-hdri-rot');
    if (rotInput && env.hdriRotation !== undefined) {
      rotInput.value = String(env.hdriRotation);
      if (valRot) valRot.innerText = `${env.hdriRotation}°`;
    }

    const syncSunChk = document.getElementById('chk-sync-sun-hdri') as HTMLInputElement | null;
    if (syncSunChk) {
      syncSunChk.checked = env.syncSunWithHdri !== false;
    }

    const hdriInt = document.getElementById('input-hdri-intensity') as HTMLInputElement | null;
    const valHdriInt = document.getElementById('val-hdri-intensity');
    if (hdriInt && env.hdriIntensity !== undefined) {
      hdriInt.value = String(env.hdriIntensity);
      if (valHdriInt) valHdriInt.innerText = env.hdriIntensity.toFixed(2);
    }

    const scaleInput = document.getElementById('input-hdri-uv-scale') as HTMLInputElement | null;
    const valScale = document.getElementById('val-hdri-uv-scale');
    if (scaleInput && env.hdriScaleU !== undefined) {
      scaleInput.value = String(env.hdriScaleU);
      if (valScale) valScale.innerText = env.hdriScaleU.toFixed(2);
    }

    const offUInput = document.getElementById('input-hdri-uv-offset-u') as HTMLInputElement | null;
    const valOffU = document.getElementById('val-hdri-uv-offset-u');
    if (offUInput && env.hdriOffsetU !== undefined) {
      offUInput.value = String(env.hdriOffsetU);
      if (valOffU) valOffU.innerText = env.hdriOffsetU.toFixed(2);
    }

    const offVInput = document.getElementById('input-hdri-uv-offset-v') as HTMLInputElement | null;
    const valOffV = document.getElementById('val-hdri-uv-offset-v');
    if (offVInput && env.hdriOffsetV !== undefined) {
      offVInput.value = String(env.hdriOffsetV);
      if (valOffV) valOffV.innerText = env.hdriOffsetV.toFixed(2);
    }

    const sunAz = document.getElementById('input-sun-azimuth') as HTMLInputElement | null;
    const valSunAz = document.getElementById('val-sun-azimuth');
    if (sunAz && env.sunAzimuth !== undefined) {
      sunAz.value = String(env.sunAzimuth);
      if (valSunAz) valSunAz.innerText = `${env.sunAzimuth}°`;
    }

    const sunEl = document.getElementById('input-sun-elevation') as HTMLInputElement | null;
    const valSunEl = document.getElementById('val-sun-elevation');
    if (sunEl && env.sunElevation !== undefined) {
      sunEl.value = String(env.sunElevation);
      if (valSunEl) valSunEl.innerText = `${env.sunElevation}°`;
    }

    const sunInt = document.getElementById('input-sun-intensity') as HTMLInputElement | null;
    const valSunInt = document.getElementById('val-sun-intensity');
    if (sunInt && env.sunIntensity !== undefined) {
      sunInt.value = String(env.sunIntensity);
      if (valSunInt) valSunInt.innerText = env.sunIntensity.toFixed(2);
    }

    const sunColor = document.getElementById('input-sun-color') as HTMLInputElement | null;
    const valSunColor = document.getElementById('val-sun-color');
    if (sunColor && env.sunColor) {
      sunColor.value = env.sunColor;
      if (valSunColor) valSunColor.innerText = env.sunColor;
    }

    const shadowDark = document.getElementById('input-shadow-darkness') as HTMLInputElement | null;
    const valShadowDark = document.getElementById('val-shadow-darkness');
    if (shadowDark && env.shadowDarkness !== undefined) {
      shadowDark.value = String(env.shadowDarkness);
      if (valShadowDark) valShadowDark.innerText = env.shadowDarkness.toFixed(2);
    }
  }

  public setOutlinerItems(items: OutlinerItem[]) {
    this.outlinerItems = items;
    const totalEl = document.getElementById('dock-outliner-badge');
    if (totalEl) totalEl.innerText = String(items.length);

    const cntAll = document.getElementById('cnt-outliner-all');
    const cntMarkers = document.getElementById('cnt-outliner-markers');
    const cntArch = document.getElementById('cnt-outliner-arch');
    const cntFoliage = document.getElementById('cnt-outliner-foliage');
    const cntRocks = document.getElementById('cnt-outliner-rocks');

    if (cntAll) cntAll.innerText = String(items.length);
    if (cntMarkers) cntMarkers.innerText = String(items.filter((i) => i.category === 'markers').length);
    if (cntArch) cntArch.innerText = String(items.filter((i) => i.category === 'architecture').length);
    if (cntFoliage) cntFoliage.innerText = String(items.filter((i) => i.category === 'foliage').length);
    if (cntRocks) cntRocks.innerText = String(items.filter((i) => i.category === 'rocks').length);

    this.renderOutlinerList();
  }

  public renderOutlinerList() {
    const listEl = document.getElementById('outliner-items-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const q = this.outlinerSearchQuery.trim();
    const cat = this.outlinerActiveCat;

    const filtered = this.outlinerItems.filter((item) => {
      if (cat !== 'all' && item.category !== cat) return false;
      if (q && !item.name.toLowerCase().includes(q) && !item.id.toLowerCase().includes(q)) return false;
      return true;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = '<div style="color: #64748b; font-size: 11px; padding: 12px; text-align: center;">No elements matching criteria</div>';
      return;
    }

    for (const item of filtered) {
      const row = document.createElement('div');
      row.className = 'outliner-row';
      row.dataset.id = item.id;

      const isFeature = item.featureIndex !== undefined;
      const isSelected = isFeature ? this.selectedFeatureIdx === item.featureIndex : false;
      if (isSelected) row.classList.add('is-selected');

      row.innerHTML = `
        <span class="outliner-row-icon">${item.icon}</span>
        <div class="outliner-row-info">
          <span class="outliner-row-name" title="${item.name}">${item.name}</span>
          <span class="outliner-row-meta">X:${item.posX.toFixed(0)} Z:${item.posZ.toFixed(0)}</span>
        </div>
        <div class="outliner-row-actions">
          <button class="outliner-btn-action ${item.isVisible ? '' : 'is-hidden-item'}" title="Toggle Visibility" data-action="vis">${item.isVisible ? '👁️' : '🕶️'}</button>
          <button class="outliner-btn-action" title="Frame Camera [F]" data-action="frame">🎯</button>
          <button class="outliner-btn-action is-delete" title="Delete Element" data-action="delete">🗑️</button>
        </div>
      `;

      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = e.target as HTMLElement;
        const actionBtn = target.closest('[data-action]');
        if (actionBtn) {
          e.stopPropagation();
          const action = actionBtn.getAttribute('data-action');
          if (action === 'vis') {
            item.isVisible = !item.isVisible;
            this.callbacks.onOutlinerToggleVisibility?.(item);
            this.renderOutlinerList();
          } else if (action === 'frame') {
            this.callbacks.onOutlinerFrame?.(item);
          } else if (action === 'delete') {
            this.callbacks.onOutlinerDelete?.(item);
          }
          return;
        }
        listEl.querySelectorAll('.outliner-row').forEach(r => r.classList.remove('is-selected'));
        row.classList.add('is-selected');
        this.callbacks.onOutlinerSelect?.(item);
      });

      listEl.appendChild(row);
    }
  }

  public updateGamepadHud(state: GamepadHudState) {
    const dot = document.getElementById('gamepad-status-dot');
    const text = document.getElementById('gamepad-status-text');
    const badge = document.getElementById('gamepad-type-badge');

    if (dot) dot.classList.toggle('is-connected', state.connected);
    if (text) text.innerText = state.connected ? state.padName : 'Gamepad Ready';
    if (badge) badge.innerText = state.connected ? 'Analog Active' : 'Waiting Input';

    const pillA = document.getElementById('pad-key-a');
    const pillB = document.getElementById('pad-key-b');
    const pillX = document.getElementById('pad-key-x');
    const pillY = document.getElementById('pad-key-y');
    const pillBumpers = document.getElementById('pad-key-bumpers');

    if (pillA) pillA.classList.toggle('active', state.btnA);
    if (pillB) pillB.classList.toggle('active', state.btnB);
    if (pillX) pillX.classList.toggle('active', state.btnX || state.dpadDown);
    if (pillY) pillY.classList.toggle('active', state.btnY || state.dpadUp);
    if (pillBumpers) pillBumpers.classList.toggle('active', state.btnLB || state.btnRB);

    const puckLs = document.getElementById('pad-puck-ls');
    const puckRs = document.getElementById('pad-puck-rs');
    if (puckLs) {
      const tx = (state.leftStickX * 6).toFixed(1);
      const ty = (state.leftStickY * 6).toFixed(1);
      puckLs.style.transform = `translate(${tx}px, ${ty}px)`;
    }
    if (puckRs) {
      const tx = (state.rightStickX * 6).toFixed(1);
      const ty = (state.rightStickY * 6).toFixed(1);
      puckRs.style.transform = `translate(${tx}px, ${ty}px)`;
    }
  }

  private setupPerformanceHud() {
    const barsContainer = document.getElementById('perf-sparkline-bars');
    if (barsContainer) {
      barsContainer.innerHTML = '';
      this.sparklineBars = [];
      for (let i = 0; i < 24; i++) {
        const bar = document.createElement('div');
        bar.className = 'perf-spark-bar';
        bar.style.height = '65%';
        barsContainer.appendChild(bar);
        this.sparklineBars.push(bar);
      }
    }

    this.setPerfTip(0);

    document.getElementById('btn-prev-perf-tip')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.prevPerfTip();
    });

    document.getElementById('btn-next-perf-tip')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.nextPerfTip();
    });

    document.getElementById('btn-toggle-perf-tips')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePerfMinimized();
    });
    document.getElementById('btn-play-restart-hole')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onRestartHole?.();
    });
    document.getElementById('btn-play-open-designer')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.currentMode === 'play') {
        this.toggleMode();
      }
    });

    if (this.perfTipTimer) clearInterval(this.perfTipTimer);
    this.perfTipTimer = window.setInterval(() => {
      this.nextPerfTip(true);
    }, 7000);
  }

  private setPerfTip(idx: number, isAuto: boolean = false) {
    this.currentPerfTipIdx = (idx + this.optimizationTips.length) % this.optimizationTips.length;
    const contentEl = document.getElementById('perf-tip-content');
    const counterEl = document.getElementById('perf-tip-counter');
    if (counterEl) {
      counterEl.innerText = `${this.currentPerfTipIdx + 1}/${this.optimizationTips.length}`;
    }
    if (contentEl) {
      if (isAuto) {
        contentEl.style.opacity = '0';
        setTimeout(() => {
          contentEl.innerText = this.optimizationTips[this.currentPerfTipIdx];
          contentEl.style.opacity = '1';
        }, 180);
      } else {
        contentEl.innerText = this.optimizationTips[this.currentPerfTipIdx];
      }
    }
  }

  private nextPerfTip(isAuto: boolean = false) {
    this.setPerfTip(this.currentPerfTipIdx + 1, isAuto);
  }

  private prevPerfTip() {
    this.setPerfTip(this.currentPerfTipIdx - 1, false);
  }

  private togglePerfMinimized() {
    this.isPerfMinimized = !this.isPerfMinimized;
    const hud = document.getElementById('perf-fps-hud');
    const btn = document.getElementById('btn-toggle-perf-tips');
    if (hud) hud.classList.toggle('is-minimized', this.isPerfMinimized);
    if (btn) btn.innerText = this.isPerfMinimized ? '▴' : '▾';
  }

  public updatePerformanceHud(fps: number, frameTimeMs: number, activeMeshes: number) {
    const fpsEl = document.getElementById('perf-fps-num');
    const frametimeEl = document.getElementById('perf-frametime-val');
    const meshesEl = document.getElementById('perf-meshes-val');
    const badgeEl = document.getElementById('perf-quality-badge');
    const dotEl = document.getElementById('perf-pulse-dot');

    const cleanFps = Math.max(0, Math.min(240, fps));
    const cleanFt = Math.max(0, Math.min(200, frameTimeMs));

    if (fpsEl) fpsEl.innerText = cleanFps.toFixed(1);
    if (frametimeEl) frametimeEl.innerText = `${cleanFt.toFixed(1)} ms`;
    if (meshesEl) meshesEl.innerText = `${activeMeshes} Meshes`;

    if (badgeEl) {
      if (cleanFps >= 55) {
        badgeEl.innerText = 'OPTIMAL 60+';
        badgeEl.className = 'perf-quality-badge badge-optimal';
        if (fpsEl) fpsEl.style.color = '#4ade80';
        if (dotEl) { dotEl.style.background = '#22c55e'; dotEl.style.boxShadow = '0 0 8px #22c55e'; }
      } else if (cleanFps >= 45) {
        badgeEl.innerText = 'SMOOTH';
        badgeEl.className = 'perf-quality-badge badge-smooth';
        if (fpsEl) fpsEl.style.color = '#38bdf8';
        if (dotEl) { dotEl.style.background = '#38bdf8'; dotEl.style.boxShadow = '0 0 8px #38bdf8'; }
      } else if (cleanFps >= 30) {
        badgeEl.innerText = 'STABLE';
        badgeEl.className = 'perf-quality-badge badge-warning';
        if (fpsEl) fpsEl.style.color = '#fbbf24';
        if (dotEl) { dotEl.style.background = '#fbbf24'; dotEl.style.boxShadow = '0 0 8px #fbbf24'; }
      } else {
        badgeEl.innerText = 'HEAVY LOAD';
        badgeEl.className = 'perf-quality-badge badge-heavy';
        if (fpsEl) fpsEl.style.color = '#fb7185';
        if (dotEl) { dotEl.style.background = '#f43f5e'; dotEl.style.boxShadow = '0 0 8px #f43f5e'; }
      }
    }

    // Update Sparkline History (24 frames)
    this.sparklineHistory.push(cleanFt);
    if (this.sparklineHistory.length > 24) {
      this.sparklineHistory.shift();
    }

    if (this.sparklineBars.length === 24) {
      for (let i = 0; i < 24; i++) {
        const ft = this.sparklineHistory[i];
        const heightPct = Math.max(12, Math.min(100, Math.round((ft / 28) * 75)));
        const bar = this.sparklineBars[i];
        bar.style.height = `${heightPct}%`;
        if (ft <= 18) {
          bar.style.backgroundColor = '#22c55e';
        } else if (ft <= 26) {
          bar.style.backgroundColor = '#38bdf8';
        } else if (ft <= 35) {
          bar.style.backgroundColor = '#fbbf24';
        } else {
          bar.style.backgroundColor = '#f43f5e';
        }
      }
    }
  }

  public updateSatelliteUi(enabled: boolean, opacity: number) {
    const btn = document.getElementById('btn-toggle-satellite');
    const slider = document.getElementById('input-satellite-opacity') as HTMLInputElement | null;
    const label = document.getElementById('val-satellite-opacity');
    const pct = Math.round(Math.max(0, Math.min(1, opacity)) * 100);
    if (btn) btn.classList.toggle('mapng-trace-active', enabled && pct > 0);
    if (slider) slider.value = String(pct);
    if (label) label.innerText = enabled ? `${pct}%` : 'OFF';

    const gMix = document.getElementById('ground-satellite-mix') as HTMLInputElement | null;
    const gVal = document.getElementById('val-ground-satellite-mix');
    const gChk = document.getElementById('ground-mat-tex-satellite') as HTMLInputElement | null;
    if (gMix) gMix.value = String(pct);
    if (gVal) gVal.innerText = `${pct}%`;
    if (gChk && enabled) gChk.checked = pct > 0;
  }

  public updateTraceUi(mode: TraceToolMode, surface: SurfaceType, pointCount: number) {
    this.activeTraceMode = mode;
    const btnSpline = document.getElementById('btn-trace-spline');
    const btnLasso = document.getElementById('btn-trace-lasso');
    const actionsRow = document.getElementById('trace-active-actions');
    const badge = document.getElementById('trace-status-badge');
    const sel = document.getElementById('select-trace-surface') as HTMLSelectElement | null;

    if (btnSpline) btnSpline.classList.toggle('mapng-trace-active', mode === 'spline');
    if (btnLasso) btnLasso.classList.toggle('mapng-trace-active', mode === 'freehand');
    if (sel && mode !== 'off') {
      sel.value =
        surface === SurfaceType.GREEN ? 'green' :
        surface === SurfaceType.FAIRWAY ? 'fairway' :
        surface === SurfaceType.TEE ? 'tee' :
        surface === SurfaceType.WATER ? 'water' : 'bunker';
    }
    if (actionsRow) actionsRow.classList.toggle('hidden', mode === 'off');
    if (badge) {
      badge.classList.toggle('hidden', mode === 'off');
      const surfLabel = (SURFACE_PROPERTIES[surface]?.name || String(surface)).toUpperCase();
      if (mode === 'spline') {
        badge.innerText = `Spline (${surfLabel}): ${pointCount} pts placed. Click green start or press Enter to close.`;
      } else if (mode === 'freehand') {
        badge.innerText = `Lasso (${surfLabel}): Hold Left-Click and trace contour on satellite image.`;
      }
    }
  }

  private bindMapNGAndTracingEvents() {
    const modal = document.getElementById('modal-mapng-import');
    const btnOpen = document.getElementById('btn-open-mapng-modal');
    const btnClose = document.getElementById('btn-close-mapng-modal');
    const filesInput = document.getElementById('input-mapng-files') as HTMLInputElement | null;
    const hmInput = document.getElementById('input-mapng-hm') as HTMLInputElement | null;
    const satInput = document.getElementById('input-mapng-sat') as HTMLInputElement | null;
    const metaInput = document.getElementById('input-mapng-meta') as HTMLInputElement | null;
    const canvas = document.getElementById('canvas-mapng-crop') as HTMLCanvasElement | null;
    const statusHm = document.getElementById('mapng-status-hm');
    const statusSat = document.getElementById('mapng-status-sat');
    const statusMeta = document.getElementById('mapng-status-meta');
    const footprintBadge = document.getElementById('mapng-footprint-badge');
    const holeSelect = document.getElementById('select-mapng-kyalami-hole') as HTMLSelectElement | null;
    const rotInput = document.getElementById('input-mapng-rotation') as HTMLInputElement | null;
    const valRot = document.getElementById('val-mapng-rotation');
    const elevScaleInput = document.getElementById('input-mapng-elev-scale') as HTMLInputElement | null;
    const valElevScale = document.getElementById('val-mapng-elev-scale');
    const valCenter = document.getElementById('val-mapng-center');
    const chkIsolate = document.getElementById('chk-mapng-isolate-course') as HTMLInputElement | null;
    const chkClear = document.getElementById('chk-mapng-clear-features') as HTMLInputElement | null;
    const chkClearScenery = document.getElementById('chk-mapng-clear-scenery') as HTMLInputElement | null;
    const btnApply = document.getElementById('btn-apply-mapng') as HTMLButtonElement | null;
    const btnApplySatOnly = document.getElementById('btn-apply-mapng-sat-only') as HTMLButtonElement | null;

    let decodedHm: Awaited<ReturnType<typeof decode16BitPng>> | null = null;
    let hmName = '';
    let satImg: HTMLImageElement | null = null;
    let satUrl: string | null = null;
    let satName = '';
    let metaTexts: { name: string; text: string }[] = [];
    let loadedSource: LoadedMapNGSource | null = null;
    let footprintMask: CourseFootprintMask | null = null;
    let footprintOverlayCanvas: HTMLCanvasElement | null = null;
    let hmPreviewCanvas: HTMLCanvasElement | null = null;
    let cropCenterX = 1095;
    let cropCenterZ = 1080;
    let rotationDeg = 0;
    let elevationScale = 1.0;
    let selectedKyalamiHole = 0;

    const buildFootprintOverlay = (fp: CourseFootprintMask, spanW: number, spanH: number) => {
      const fCanvas = document.createElement('canvas');
      const sz = 280;
      fCanvas.width = sz;
      fCanvas.height = sz;
      const fCtx = fCanvas.getContext('2d');
      if (!fCtx) return null;

      fCtx.fillStyle = 'rgba(2, 6, 23, 0.58)';
      fCtx.fillRect(0, 0, sz, sz);

      if (fp.polygonMeters && fp.polygonMeters.length >= 3) {
        fCtx.save();
        fCtx.globalCompositeOperation = 'destination-out';
        fCtx.beginPath();
        fp.polygonMeters.forEach((pt, i) => {
          const px = (pt.x / Math.max(1, spanW)) * sz;
          const py = (pt.z / Math.max(1, spanH)) * sz;
          if (i === 0) fCtx.moveTo(px, py);
          else fCtx.lineTo(px, py);
        });
        fCtx.closePath();
        fCtx.fill();
        fCtx.restore();

        fCtx.strokeStyle = '#22c55e';
        fCtx.lineWidth = 1.8;
        fCtx.beginPath();
        fp.polygonMeters.forEach((pt, i) => {
          const px = (pt.x / Math.max(1, spanW)) * sz;
          const py = (pt.z / Math.max(1, spanH)) * sz;
          if (i === 0) fCtx.moveTo(px, py);
          else fCtx.lineTo(px, py);
        });
        fCtx.closePath();
        fCtx.stroke();
      } else if (fp.gridMask && fp.gridRes) {
        const res = fp.gridRes;
        const cellW = sz / res;
        fCtx.save();
        fCtx.globalCompositeOperation = 'destination-out';
        for (let gz = 0; gz < res; gz++) {
          for (let gx = 0; gx < res; gx++) {
            const eastM = ((gx + 0.5) / res) * spanW;
            const southM = ((gz + 0.5) / res) * spanH;
            if (isPointInCourseFootprint(fp, eastM, southM, spanW, spanH)) {
              fCtx.fillRect(gx * cellW, gz * cellW, cellW + 0.6, cellW + 0.6);
            }
          }
        }
        fCtx.restore();
      }
      return fCanvas;
    };

    const drawCropPreview = () => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const cw = canvas.width;
      const ch = canvas.height;
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, cw, ch);

      const mpp = loadedSource?.meta.metersPerPixel || 1.0;
      const spanW = (loadedSource?.heightmap.width || 2048) * mpp;
      const spanH = (loadedSource?.heightmap.height || 2048) * mpp;

      if (satImg) {
        ctx.drawImage(satImg, 0, 0, cw, ch);
      } else if (hmPreviewCanvas) {
        ctx.drawImage(hmPreviewCanvas, 0, 0, cw, ch);
      }

      if (chkIsolate?.checked && footprintOverlayCanvas) {
        ctx.drawImage(footprintOverlayCanvas, 0, 0, cw, ch);
      }

      const cxPx = (cropCenterX / spanW) * cw;
      const cyPx = (cropCenterZ / spanH) * ch;
      const boxW = (220 / spanW) * cw;
      const boxH = (460 / spanH) * ch;
      const rotRad = (rotationDeg * Math.PI) / 180;

      ctx.save();
      ctx.translate(cxPx, cyPx);
      ctx.rotate(rotRad);
      ctx.fillStyle = 'rgba(56, 189, 248, 0.20)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.fillRect(-boxW * 0.5, -boxH * 0.5, boxW, boxH);
      ctx.strokeRect(-boxW * 0.5, -boxH * 0.5, boxW, boxH);

      // Green/North direction arrow inside crop box
      ctx.strokeStyle = '#facc15';
      ctx.beginPath();
      ctx.moveTo(0, boxH * 0.35);
      ctx.lineTo(0, -boxH * 0.38);
      ctx.lineTo(-5, -boxH * 0.28);
      ctx.moveTo(0, -boxH * 0.38);
      ctx.lineTo(5, -boxH * 0.28);
      ctx.stroke();
      ctx.restore();

      if (valCenter) valCenter.innerText = `${Math.round(cropCenterX)}m, ${Math.round(cropCenterZ)}m`;
    };

    const buildHmPreview = (hm: NonNullable<typeof decodedHm>) => {
      const pCanvas = document.createElement('canvas');
      const sz = 280;
      pCanvas.width = sz;
      pCanvas.height = sz;
      const pCtx = pCanvas.getContext('2d');
      if (!pCtx) return null;
      const imgData = pCtx.createImageData(sz, sz);
      const { width, height, pixels } = hm;
      for (let py = 0; py < sz; py++) {
        const sy = Math.min(height - 1, Math.floor((py / sz) * height));
        for (let px = 0; px < sz; px++) {
          const sx = Math.min(width - 1, Math.floor((px / sz) * width));
          const v = pixels[sy * width + sx] >> 8;
          const idx = (py * sz + px) * 4;
          imgData.data[idx] = v;
          imgData.data[idx + 1] = Math.min(255, Math.round(v * 1.1));
          imgData.data[idx + 2] = v;
          imgData.data[idx + 3] = 255;
        }
      }
      pCtx.putImageData(imgData, 0, 0);
      return pCanvas;
    };

    const rebuildMapNGState = (recenterIfNewHm = false) => {
      const metaParsed = parseMapNGMetadata(metaTexts);
      const mpp = metaParsed.metersPerPixel ?? 1.0;
      const minH = metaParsed.minHeightMeters ?? 0;
      const maxH = metaParsed.maxHeightMeters ?? 78;
      const wPx = metaParsed.sourceWidthPx || decodedHm?.width || 2048;
      const hPx = metaParsed.sourceHeightPx || decodedHm?.height || 2048;
      const metaObj = {
        levelName: metaParsed.levelName || (hmName ? hmName.replace(/\.png$/i, '') : 'MapNG Course'),
        sourceWidthPx: wPx,
        sourceHeightPx: hPx,
        metersPerPixel: mpp,
        minHeightMeters: minH,
        maxHeightMeters: maxH,
        centerLat: metaParsed.centerLat,
        centerLon: metaParsed.centerLon
      };

      if (decodedHm) {
        const tempSrc: LoadedMapNGSource = {
          meta: metaObj,
          heightmap: decodedHm,
          satelliteImg: satImg,
          satelliteUrl: satUrl
        };
        footprintMask = detectGolfCourseFootprint(tempSrc);
        tempSrc.courseFootprint = footprintMask;
        loadedSource = tempSrc;
        footprintOverlayCanvas = buildFootprintOverlay(footprintMask, wPx * mpp, hPx * mpp);

        if (recenterIfNewHm && selectedKyalamiHole === 0) {
          cropCenterX = Math.abs((metaParsed.centerLat ?? 0) + 25.9754) < 0.08 ? 1095 : Math.round(wPx * mpp * 0.5);
          cropCenterZ = Math.abs((metaParsed.centerLon ?? 0) - 28.0589) < 0.08 ? 1080 : Math.round(hPx * mpp * 0.5);
        }
      } else if (satImg) {
        const dummyHm = { width: wPx, height: hPx, bitDepth: 16, pixels: new Uint16Array(wPx * hPx) };
        const pseudoSrc: LoadedMapNGSource = {
          meta: metaObj,
          heightmap: dummyHm,
          satelliteImg: satImg,
          satelliteUrl: satUrl
        };
        footprintMask = detectGolfCourseFootprint(pseudoSrc);
        footprintOverlayCanvas = buildFootprintOverlay(footprintMask, wPx * mpp, hPx * mpp);
      }

      if (statusHm && decodedHm) {
        statusHm.classList.add('ready');
        statusHm.innerText = `✅ Heightmap: ${decodedHm.width}×${decodedHm.height} (${decodedHm.bitDepth}-bit) • ${hmName}`;
      }
      if (statusSat) {
        statusSat.classList.toggle('ready', Boolean(satImg));
        statusSat.innerText = satImg
          ? `✅ Satellite Ortho: ${satImg.width}×${satImg.height} (${satName || 'loaded'})`
          : '⚠️ No satellite texture attached (grayscale DEM only)';
      }
      if (statusMeta) {
        statusMeta.classList.toggle('ready', metaTexts.length > 0);
        statusMeta.innerText = `${metaTexts.length > 0 ? '✅' : 'ℹ️'} ${metaObj.levelName} (${minH.toFixed(1)}m – ${maxH.toFixed(1)}m, ${wPx}×${hPx}px)`;
      }
      if (footprintBadge && footprintMask) {
        const keptPct = Math.round(footprintMask.coveragePct);
        const discardedPct = Math.max(0, 100 - keptPct);
        footprintBadge.classList.add('is-ready');
        footprintBadge.innerText = `⛳ ${footprintMask.sourceLabel}: ${keptPct}% golf course kept (~${discardedPct}% non-golf excluded)`;
      }

      if (btnApply) btnApply.disabled = !loadedSource;
      if (btnApplySatOnly) btnApplySatOnly.disabled = !satImg;
      drawCropPreview();
    };

    const loadImageFromFile = (file: File): Promise<{ img: HTMLImageElement | null; url: string }> => {
      const url = URL.createObjectURL(file);
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ img, url });
        img.onerror = () => resolve({ img: null, url });
        img.src = url;
      });
    };

    const ingestMapNGFiles = async (files: File[]) => {
      if (!files.length) return;
      let hmFile: File | null = null;
      let satFile: File | null = null;
      const newMetas: { name: string; text: string }[] = [];

      for (const file of files) {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.json') || lower.endsWith('.md') || lower.endsWith('.txt')) {
          newMetas.push({ name: file.name, text: await file.text() });
        } else if (lower.includes('heightmap')) {
          hmFile = file;
        } else if (lower.includes('texture') || lower.includes('satellite') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp')) {
          satFile = file;
        } else if (lower.endsWith('.png')) {
          const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
          const isPng = head[0] === 0x89 && head[1] === 0x50;
          if (isPng && head[24] === 16) {
            hmFile = file;
          } else {
            satFile = file;
          }
        }
      }

      try {
        if (newMetas.length > 0) {
          for (const nm of newMetas) {
            const idx = metaTexts.findIndex((m) => m.name === nm.name);
            if (idx >= 0) metaTexts[idx] = nm;
            else metaTexts.push(nm);
          }
        }

        if (satFile) {
          const res = await loadImageFromFile(satFile);
          if (res.img) {
            satImg = res.img;
            satUrl = res.url;
            satName = satFile.name;
          } else {
            this.showToast(`Could not decode satellite image: ${satFile.name}`, 'warning', 3000);
          }
        }

        if (hmFile) {
          if (statusHm) {
            statusHm.classList.remove('ready');
            statusHm.innerText = `Decoding ${hmFile.name}...`;
          }
          const hmBuf = await hmFile.arrayBuffer();
          decodedHm = await decode16BitPng(hmBuf);
          hmName = hmFile.name;
          hmPreviewCanvas = buildHmPreview(decodedHm);
        }

        rebuildMapNGState(Boolean(hmFile));
      } catch (err: any) {
        console.error('MapNG decode error:', err);
        this.showToast(`MapNG Import Error: ${err?.message || 'Failed to decode file'}`, 'penalty', 4000);
      }
    };

    btnOpen?.addEventListener('click', () => {
      modal?.classList.remove('hidden');
      drawCropPreview();
    });

    btnClose?.addEventListener('click', () => {
      modal?.classList.add('hidden');
    });

    filesInput?.addEventListener('change', async () => {
      const files = Array.from(filesInput.files || []);
      await ingestMapNGFiles(files);
      filesInput.value = '';
    });

    hmInput?.addEventListener('change', async () => {
      const file = hmInput.files?.[0];
      if (!file) return;
      try {
        if (statusHm) {
          statusHm.classList.remove('ready');
          statusHm.innerText = `Decoding ${file.name}...`;
        }
        decodedHm = await decode16BitPng(await file.arrayBuffer());
        hmName = file.name;
        hmPreviewCanvas = buildHmPreview(decodedHm);
        rebuildMapNGState(true);
      } catch (err: any) {
        this.showToast(`Heightmap Error: ${err?.message || 'Invalid 16-bit PNG'}`, 'penalty', 3600);
      } finally {
        hmInput.value = '';
      }
    });

    satInput?.addEventListener('change', async () => {
      const file = satInput.files?.[0];
      if (!file) return;
      const res = await loadImageFromFile(file);
      if (res.img) {
        satImg = res.img;
        satUrl = res.url;
        satName = file.name;
        rebuildMapNGState(false);
        this.showToast(`🛰️ Loaded Satellite Texture: ${file.name} (${res.img.width}×${res.img.height})`, 'success', 2600);
      } else {
        this.showToast(`Could not load satellite image: ${file.name}`, 'warning', 3000);
      }
      satInput.value = '';
    });

    metaInput?.addEventListener('change', async () => {
      const file = metaInput.files?.[0];
      if (!file) return;
      const text = await file.text();
      const idx = metaTexts.findIndex((m) => m.name === file.name);
      if (idx >= 0) metaTexts[idx] = { name: file.name, text };
      else metaTexts.push({ name: file.name, text });
      rebuildMapNGState(false);
      metaInput.value = '';
    });

    holeSelect?.addEventListener('change', () => {
      selectedKyalamiHole = parseInt(holeSelect.value || '0', 10);
      if (selectedKyalamiHole > 0) {
        const hole = KYALAMI_COURSE_GUIDE.holes.find((h) => h.number === selectedKyalamiHole);
        if (hole) {
          cropCenterX = hole.mapngCropHint.cropCenterX;
          cropCenterZ = hole.mapngCropHint.cropCenterZ;
          rotationDeg = hole.mapngCropHint.rotationDeg;
        }
      } else {
        cropCenterX = 1095;
        cropCenterZ = 1080;
        rotationDeg = 0;
      }
      if (rotInput) rotInput.value = String(rotationDeg);
      if (valRot) valRot.innerText = `${rotationDeg}°`;
      drawCropPreview();
    });

    chkIsolate?.addEventListener('change', () => {
      drawCropPreview();
    });

    let isDraggingCrop = false;
    const updateCropFromPointer = (clientX: number, clientY: number) => {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const mpp = loadedSource?.meta.metersPerPixel || 1.0;
      const spanW = (loadedSource?.heightmap.width || 2048) * mpp;
      const spanH = (loadedSource?.heightmap.height || 2048) * mpp;
      cropCenterX = Math.max(115, Math.min(spanW - 115, nx * spanW));
      cropCenterZ = Math.max(235, Math.min(spanH - 235, ny * spanH));
      drawCropPreview();
    };
    canvas?.addEventListener('pointerdown', (e) => {
      isDraggingCrop = true;
      updateCropFromPointer(e.clientX, e.clientY);
    });
    window.addEventListener('pointermove', (e) => {
      if (isDraggingCrop) updateCropFromPointer(e.clientX, e.clientY);
    });
    window.addEventListener('pointerup', () => {
      isDraggingCrop = false;
    });

    rotInput?.addEventListener('input', () => {
      rotationDeg = Number(rotInput.value);
      if (valRot) valRot.innerText = `${rotationDeg}°`;
      drawCropPreview();
    });
    elevScaleInput?.addEventListener('input', () => {
      elevationScale = Number(elevScaleInput.value);
      if (valElevScale) valElevScale.innerText = `${elevationScale.toFixed(2)}x`;
    });

    btnApply?.addEventListener('click', () => {
      if (!loadedSource) return;
      modal?.classList.add('hidden');
      this.callbacks.onApplyMapNGImport?.({
        source: loadedSource,
        cropCenterX,
        cropCenterZ,
        rotationDeg,
        elevationScale,
        clearFeatures: chkClear ? chkClear.checked : true,
        isolateCourseOnly: chkIsolate ? chkIsolate.checked : true,
        clearScenery: chkClearScenery ? chkClearScenery.checked : true,
        kyalamiHoleNumber: selectedKyalamiHole > 0 ? selectedKyalamiHole : undefined
      });
    });

    btnApplySatOnly?.addEventListener('click', () => {
      if (!satImg) return;
      modal?.classList.add('hidden');
      this.callbacks.onApplySatelliteOnly?.(satImg, satName || 'satellite_ortho.png');
    });

    // Designer Panel Satellite, Course View & Tracing buttons
    document.getElementById('btn-course-overview-3d')?.addEventListener('click', () => {
      this.callbacks.onCourseOverview3D?.();
    });

    const quickSatInput = document.getElementById('input-quick-sat-upload') as HTMLInputElement | null;
    document.getElementById('btn-quick-upload-sat')?.addEventListener('click', () => {
      quickSatInput?.click();
    });
    quickSatInput?.addEventListener('change', async () => {
      const file = quickSatInput.files?.[0];
      if (!file) return;
      const res = await loadImageFromFile(file);
      if (res.img) {
        satImg = res.img;
        satUrl = res.url;
        satName = file.name;
        rebuildMapNGState(false);
        this.callbacks.onApplySatelliteOnly?.(res.img, file.name);
      }
      quickSatInput.value = '';
    });

    document.getElementById('btn-toggle-satellite')?.addEventListener('click', () => {
      this.callbacks.onToggleSatelliteOverlay?.();
    });
    document.getElementById('btn-topdown-trace-cam')?.addEventListener('click', () => {
      this.callbacks.onTopDownTraceCam?.();
    });
    document.getElementById('input-satellite-opacity')?.addEventListener('input', (e) => {
      const pct = Number((e.target as HTMLInputElement).value);
      this.syncSatelliteUi(pct);
      this.callbacks.onSatelliteOpacityChange?.(pct / 100);
    });

    const getTraceSurf = (): SurfaceType => {
      const sel = document.getElementById('select-trace-surface') as HTMLSelectElement | null;
      switch (sel?.value) {
        case 'green': return SurfaceType.GREEN;
        case 'fairway': return SurfaceType.FAIRWAY;
        case 'tee': return SurfaceType.TEE;
        case 'water': return SurfaceType.WATER;
        default: return SurfaceType.BUNKER;
      }
    };
    document.getElementById('select-trace-surface')?.addEventListener('change', () => {
      if (this.activeTraceMode !== 'off') {
        this.callbacks.onTraceModeChange?.(this.activeTraceMode, getTraceSurf());
      }
    });
    document.getElementById('btn-trace-spline')?.addEventListener('click', () => {
      const next: TraceToolMode = this.activeTraceMode === 'spline' ? 'off' : 'spline';
      this.callbacks.onTraceModeChange?.(next, getTraceSurf());
    });
    document.getElementById('btn-trace-lasso')?.addEventListener('click', () => {
      const next: TraceToolMode = this.activeTraceMode === 'freehand' ? 'off' : 'freehand';
      this.callbacks.onTraceModeChange?.(next, getTraceSurf());
    });
    document.getElementById('btn-trace-finish')?.addEventListener('click', () => {
      this.callbacks.onTraceFinish?.();
    });
    document.getElementById('btn-trace-cancel')?.addEventListener('click', () => {
      this.callbacks.onTraceCancel?.();
    });

    this.enhanceSlidersWithTypeableInputs();
  }

  private sliderPairs: { range: HTMLInputElement; num: HTMLInputElement }[] = [];

  private syncTypeableSliders() {
    for (let i = this.sliderPairs.length - 1; i >= 0; i--) {
      const pair = this.sliderPairs[i];
      if (!document.body.contains(pair.range) || !document.body.contains(pair.num)) {
        this.sliderPairs.splice(i, 1);
        continue;
      }
      if (document.activeElement !== pair.num && pair.num.value !== pair.range.value) {
        pair.num.value = pair.range.value;
      }
    }
  }

  private enhanceSlidersWithTypeableInputs() {
    const upgradeRoot = (root: ParentNode) => {
      const sliders = root.querySelectorAll('input[type="range"]');
      sliders.forEach((el) => {
        const range = el as HTMLInputElement;
        if (range.dataset.typeableEnhanced === '1') return;
        range.dataset.typeableEnhanced = '1';

        const num = document.createElement('input');
        num.type = 'number';
        num.className = 'slider-num-input';
        if (range.min !== '') num.min = range.min;
        if (range.max !== '') num.max = range.max;
        num.step = range.step || 'any';
        num.value = range.value;
        num.title = 'Type an exact numeric value and press Enter';

        const stopKeys = (ev: Event) => ev.stopPropagation();
        num.addEventListener('pointerdown', stopKeys);
        num.addEventListener('mousedown', stopKeys);
        num.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') {
            commitValue();
            num.blur();
          }
        });

        const commitValue = () => {
          const parsed = parseFloat(num.value);
          if (!Number.isFinite(parsed)) {
            num.value = range.value;
            return;
          }
          const minVal = range.min !== '' ? parseFloat(range.min) : -Infinity;
          const maxVal = range.max !== '' ? parseFloat(range.max) : Infinity;
          const clamped = Math.max(minVal, Math.min(maxVal, parsed));
          range.value = String(clamped);
          num.value = range.value;
          range.dispatchEvent(new Event('input', { bubbles: true }));
          range.dispatchEvent(new Event('change', { bubbles: true }));
        };

        num.addEventListener('change', commitValue);
        num.addEventListener('blur', commitValue);

        range.addEventListener('input', () => {
          if (document.activeElement !== num) num.value = range.value;
        });
        range.addEventListener('change', () => {
          if (document.activeElement !== num) num.value = range.value;
        });

        const next = range.nextElementSibling;
        if (next && next.matches('span, .dev-slider-val, .val-badge')) {
          next.insertAdjacentElement('afterend', num);
        } else {
          range.insertAdjacentElement('afterend', num);
        }
        this.sliderPairs.push({ range, num });
      });
    };

    upgradeRoot(document);

    let obsTimer: number | null = null;
    const observer = new MutationObserver(() => {
      if (obsTimer !== null) return;
      obsTimer = window.setTimeout(() => {
        obsTimer = null;
        upgradeRoot(document);
        this.syncTypeableSliders();
      }, 60);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}
