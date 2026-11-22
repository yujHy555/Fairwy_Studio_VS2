import { EnvironmentSettings } from './Types';

export interface HdriPreset {
  id: string;
  name: string;
  file: string;
  resolution: '2K' | '4K';
  vibe: string;
  category: 'championship' | 'parkland' | 'sunny' | 'dramatic';
  sunAzimuth: number;     // degrees (0 - 360)
  sunElevation: number;   // degrees (5 - 85)
  sunIntensity: number;   // 0.2 - 3.0
  sunColor: string;       // hex #ffffff
  envIntensity: number;   // 0.2 - 2.5
  shadowDarkness: number; // 0.05 - 0.70
  rotationDeg: number;    // 0 - 360
  thumbnailBg: string;    // CSS gradient fallback
  thumbnailImg: string;   // Actual HDRI sphere preview PNG
}

export const HDRI_PRESETS: HdriPreset[] = [
  {
    id: 'limpopo_golf_course',
    name: 'Limpopo Golf 2K',
    file: '/hdris/limpopo_golf_course_2k.hdr',
    resolution: '2K',
    vibe: 'Golden afternoon championship fairway with scattered trees',
    category: 'championship',
    sunAzimuth: 145,
    sunElevation: 38,
    sunIntensity: 1.65,
    sunColor: '#fff5e6',
    envIntensity: 0.65,
    shadowDarkness: 0.22,
    rotationDeg: 0,
    thumbnailBg: 'linear-gradient(135deg, #1e3a24 0%, #3f6212 50%, #854d0e 100%)',
    thumbnailImg: '/textures/hdri_thumbs/limpopo_golf_course.png'
  },
  {
    id: 'hausdorf_clear_sky',
    name: 'Hausdorf Azure 2K',
    file: '/hdris/hausdorf_clear_sky_2k.hdr',
    resolution: '2K',
    vibe: 'Pristine azure skies with crisp directional sun and clean contrast',
    category: 'sunny',
    sunAzimuth: 215,
    sunElevation: 48,
    sunIntensity: 1.85,
    sunColor: '#ffffff',
    envIntensity: 0.70,
    shadowDarkness: 0.25,
    rotationDeg: 45,
    thumbnailBg: 'linear-gradient(135deg, #0284c7 0%, #38bdf8 50%, #15803d 100%)',
    thumbnailImg: '/textures/hdri_thumbs/hausdorf_clear_sky.png'
  },
  {
    id: 'pretoria_gardens',
    name: 'Pretoria Gardens 2K',
    file: '/hdris/pretoria_gardens_2k.hdr',
    resolution: '2K',
    vibe: 'Botanical parkland environment with rich organic canopy light',
    category: 'parkland',
    sunAzimuth: 170,
    sunElevation: 42,
    sunIntensity: 1.55,
    sunColor: '#fff8eb',
    envIntensity: 0.60,
    shadowDarkness: 0.20,
    rotationDeg: 90,
    thumbnailBg: 'linear-gradient(135deg, #14532d 0%, #166534 50%, #065f46 100%)',
    thumbnailImg: '/textures/hdri_thumbs/pretoria_gardens.png'
  },
  {
    id: 'meadow',
    name: 'Highland Meadow 2K',
    file: '/hdris/meadow_2k.hdr',
    resolution: '2K',
    vibe: 'Rolling green pastures with warm balanced sunlight',
    category: 'parkland',
    sunAzimuth: 120,
    sunElevation: 50,
    sunIntensity: 1.60,
    sunColor: '#fffaee',
    envIntensity: 0.65,
    shadowDarkness: 0.22,
    rotationDeg: 180,
    thumbnailBg: 'linear-gradient(135deg, #15803d 0%, #4ade80 50%, #0284c7 100%)',
    thumbnailImg: '/textures/hdri_thumbs/meadow.png'
  },
  {
    id: 'meadow_2',
    name: 'Open Meadow 2K',
    file: '/hdris/meadow_2_2k.hdr',
    resolution: '2K',
    vibe: 'Broad open plains with bright midday skylight',
    category: 'sunny',
    sunAzimuth: 230,
    sunElevation: 55,
    sunIntensity: 1.70,
    sunColor: '#ffffff',
    envIntensity: 0.68,
    shadowDarkness: 0.24,
    rotationDeg: 270,
    thumbnailBg: 'linear-gradient(135deg, #16a34a 0%, #a3e635 50%, #38bdf8 100%)',
    thumbnailImg: '/textures/hdri_thumbs/meadow_2.png'
  },
  {
    id: 'noon_grass',
    name: 'Noon Grassland 2K',
    file: '/hdris/noon_grass_2k.hdr',
    resolution: '2K',
    vibe: 'High-noon overhead illumination with deep saturated turf',
    category: 'sunny',
    sunAzimuth: 180,
    sunElevation: 68,
    sunIntensity: 1.90,
    sunColor: '#fffdf5',
    envIntensity: 0.75,
    shadowDarkness: 0.28,
    rotationDeg: 0,
    thumbnailBg: 'linear-gradient(135deg, #ca8a04 0%, #eab308 50%, #15803d 100%)',
    thumbnailImg: '/textures/hdri_thumbs/noon_grass.png'
  },
  {
    id: 'the_lost_city',
    name: 'The Lost City 2K',
    file: '/hdris/the_lost_city_2k.hdr',
    resolution: '2K',
    vibe: 'Golden low-angle sun over dramatic stone ruins and crisp sky',
    category: 'dramatic',
    sunAzimuth: 216,
    sunElevation: 22,
    sunIntensity: 1.75,
    sunColor: '#ffeed6',
    envIntensity: 0.65,
    shadowDarkness: 0.24,
    rotationDeg: 0,
    thumbnailBg: 'linear-gradient(135deg, #1e293b 0%, #3b82f6 50%, #d97706 100%)',
    thumbnailImg: '/textures/hdri_thumbs/the_lost_city.png'
  },
  {
    id: 'approaching_storm',
    name: 'Approaching Storm 4K',
    file: '/approaching_storm_4k.hdr',
    resolution: '4K',
    vibe: 'Dramatic overcast thunderclouds with atmospheric mood',
    category: 'dramatic',
    sunAzimuth: 320,
    sunElevation: 32,
    sunIntensity: 1.35,
    sunColor: '#fff0db',
    envIntensity: 0.55,
    shadowDarkness: 0.18,
    rotationDeg: 0,
    thumbnailBg: 'linear-gradient(135deg, #1e293b 0%, #334155 50%, #475569 100%)',
    thumbnailImg: '/textures/hdri_thumbs/approaching_storm.png'
  },
  {
    id: 'misty_pines',
    name: 'Misty Pines 4K',
    file: '/misty_pines_4k.hdr',
    resolution: '4K',
    vibe: 'Serene morning alpine mist and soft diffuse horizon',
    category: 'dramatic',
    sunAzimuth: 90,
    sunElevation: 25,
    sunIntensity: 1.25,
    sunColor: '#ffedd5',
    envIntensity: 0.50,
    shadowDarkness: 0.15,
    rotationDeg: 60,
    thumbnailBg: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #047857 100%)',
    thumbnailImg: '/textures/hdri_thumbs/misty_pines.png'
  }
];

export const DEFAULT_HDRI_PRESET = HDRI_PRESETS[0]; // Limpopo Golf 2K

export function presetToEnvironmentSettings(p: HdriPreset): EnvironmentSettings {
  return {
    hdriId: p.id,
    hdriUrl: p.file,
    hdriRotation: p.rotationDeg,
    hdriIntensity: p.envIntensity,
    hdriScaleU: 1.0,
    hdriScaleV: 1.0,
    hdriOffsetU: 0.0,
    hdriOffsetV: 0.0,
    syncSunWithHdri: true,
    sunAzimuth: p.sunAzimuth,
    sunElevation: p.sunElevation,
    sunIntensity: p.sunIntensity,
    sunColor: p.sunColor,
    shadowDarkness: Number(Math.max(0.15, Math.min(0.95, 1.0 - p.shadowDarkness)).toFixed(2)),
    bloomEnabled: false,
    bloomThreshold: 0.85,
    bloomWeight: 0.32,
    bloomKernel: 48,
    anamorphicEnabled: false,
    anamorphicIntensity: 0.55,
    anamorphicThreshold: 0.82,
    anamorphicStretch: 1.10
  };
}
