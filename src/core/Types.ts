import { SurfaceType } from './Constants';

export interface Vector2D {
  x: number;
  z: number;
}

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export type PresetFeatureCategory = 
  | 'fairway' 
  | 'green' 
  | 'bunker' 
  | 'water' 
  | 'tee' 
  | 'fringe'
  | 'first_cut'
  | 'scenery';

export interface PresetFeature {
  id: string;
  name: string;
  category: PresetFeatureCategory;
  description: string;
  icon: string;
  surfaceType: SurfaceType;
  width: number;       // meters
  length: number;      // meters
  depthProfile?: number; // negative for depressions (bunkers: -0.8m, water: -1.8m), positive for elevated tees/greens
  lipHeight?: number;    // bunker lip elevation
  bunkerShapeIndex?: number; // variant shape index (0..4)
  contour?: Vector2D[]; // optional closed perimeter contour in local or world meters for traced MapNG features
  conformDemBlend?: number; // 0..1: blend between flattened pad and underlying MapNG DEM
  sceneryType?: 'pine' | 'hero_tree' | 'woodland_tree' | 'oak' | 'rock_cluster' | 'distance_marker' | 'dam_wall';
}

export interface MapNGCourseMeta {
  levelName: string;
  sourceWidthPx: number;
  sourceHeightPx: number;
  metersPerPixel: number;
  minHeightMeters: number;
  maxHeightMeters: number;
  centerLat?: number;
  centerLon?: number;
  cropOriginX?: number;
  cropOriginZ?: number;
  cropRotationRad?: number;
  cropWidthMeters?: number;
  cropLengthMeters?: number;
  sourceSpanW?: number;
  sourceSpanH?: number;
}

export interface PlacedFeature {
  id: string;
  presetId: string;
  position: Vector3D;
  rotationY: number; // radians
  scale: Vector3D;
  surfaceType: SurfaceType;
}

export interface GolfHole {
  number: number;       // 1 - 18
  par: 3 | 4 | 5;
  name: string;
  isDemo?: boolean;
  strokeIndex?: number;
  distances?: {
    yellow: number;
    white: number;
    blue: number;
    red: number;
  };
  proTip?: string;
  overheadImageUrl?: string;
  distanceGuideImageUrl?: string;
  courseGuideId?: string;
  teePosition: Vector3D;
  pinPosition: Vector3D;
  waypoints: Vector3D[]; // optional dogleg fairway target markers
}

export interface EnvironmentSettings {
  hdriId: string;
  hdriUrl: string;
  hdriRotation: number;       // in degrees (0 - 360)
  hdriIntensity: number;      // 0.2 - 2.5
  hdriScaleU?: number;        // UV scale U
  hdriScaleV?: number;        // UV scale V
  hdriOffsetU?: number;       // UV offset U
  hdriOffsetV?: number;       // UV offset V
  syncSunWithHdri?: boolean;  // rotate directional sun & shadows proportionally with HDRI rotation
  sunAzimuth: number;         // degrees (0 - 360)
  sunElevation: number;       // degrees (5 - 85)
  sunIntensity: number;       // 0.2 - 3.0
  sunColor: string;           // hex #ffffff
  shadowDarkness: number;     // 0.05 - 0.70
}

export interface GolfCourseData {
  id: string;
  name: string;
  author: string;
  gridWidth: number;
  gridLength: number;
  holes: GolfHole[];
  currentHoleIndex: number;
  features: PlacedFeature[];
  heightMap: number[]; // Flattened Float32 or 1D array of elevations
  surfaceMap: number[]; // Flattened array of SurfaceType
  environmentSettings?: EnvironmentSettings;
  mapngMeta?: MapNGCourseMeta;
  courseGuideId?: string;
}

export interface ClubSpec {
  id: string;
  name: string;
  shortName: string;
  category: 'wood' | 'iron' | 'wedge' | 'putter';
  loftDegrees: number;
  typicalCarryMeters: number;
  baseBallSpeedMps: number; // meters/second
  baseBackspinRPM: number;
  spinDecayFactor: number;
  maxSidespinRPM: number;
  sweetspotWidth: number; // tolerance window
}

export interface ShotResult {
  club: ClubSpec;
  powerPercent: number;     // 0 - 1.2 (can over-hit up to 120%)
  accuracyOffset: number;   // -1.0 (hook/pull) to +1.0 (slice/push)
  launchAngleDeg: number;
  launchSpeedMps: number;
  backspinRPM: number;
  sidespinRPM: number;
  azimuthDeg: number;       // Aiming direction in horizontal plane
  windSpeedMps: number;
  windHeadingDeg: number;   // Wind direction
}

export interface TrajectoryPoint {
  position: Vector3D;
  velocity: Vector3D;
  time: number;
  spinRPM: number;
  altitude: number;
}

export interface HoleScore {
  holeNumber: number;
  par: number;
  strokes: number;
  putts: number;
  scoreText: string; // e.g. "Birdie (-1)", "Par (E)", "Bogey (+1)"
}

export type ViewportShadingMode = 'wireframe' | 'solid' | 'material' | 'rendered';

