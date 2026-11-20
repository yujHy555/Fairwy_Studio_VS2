export type DeviceTier = 'mobile' | 'mid' | 'high';

export interface DeviceProfile {
  tier: DeviceTier;
  maxDpr: number;
  antialias: boolean;
  shadowMapSize: 1024 | 2048;
  shadowCascades: 2 | 3;
  shadowFilterQuality: 'low' | 'medium';
  maxAnisotropy: number;
  maxGlbTextureSize: 512 | 1024;
  maxSatelliteTextureSize: 1024 | 2048;
  splatResolution: number;
}

let cachedProfile: DeviceProfile | null = null;

/**
 * Computes a hardware-aware GPU quality & memory budget once at startup so the app
 * runs smoothly across desktop GPUs, laptops, tablets, and mobile browsers.
 */
export function getDeviceProfile(): DeviceProfile {
  if (cachedProfile) return cachedProfile;

  const hasWindow = typeof window !== 'undefined';
  const hasNavigator = typeof navigator !== 'undefined';

  const isCoarsePointer = hasWindow && Boolean(window.matchMedia?.('(pointer: coarse)').matches);
  const maxTouch = hasNavigator ? navigator.maxTouchPoints || 0 : 0;
  const minScreen = typeof screen !== 'undefined' ? Math.min(screen.width || 1920, screen.height || 1080) : 1080;
  const isMobile = isCoarsePointer || (maxTouch > 1 && minScreen < 900);

  const cores = hasNavigator ? navigator.hardwareConcurrency || 8 : 8;
  const memGb = hasNavigator ? Number((navigator as any).deviceMemory || 8) : 8;

  let tier: DeviceTier = 'high';
  if (isMobile) {
    tier = 'mobile';
  } else if (cores <= 4 || memGb <= 4) {
    tier = 'mid';
  }

  if (tier === 'mobile') {
    cachedProfile = {
      tier: 'mobile',
      maxDpr: 1.0,
      antialias: false,
      shadowMapSize: 1024,
      shadowCascades: 2,
      shadowFilterQuality: 'low',
      maxAnisotropy: 4,
      maxGlbTextureSize: 512,
      maxSatelliteTextureSize: 1024,
      splatResolution: 1024
    };
  } else if (tier === 'mid') {
    cachedProfile = {
      tier: 'mid',
      maxDpr: 1.25,
      antialias: true,
      shadowMapSize: 1024,
      shadowCascades: 3,
      shadowFilterQuality: 'low',
      maxAnisotropy: 8,
      maxGlbTextureSize: 1024,
      maxSatelliteTextureSize: 2048,
      splatResolution: 1024
    };
  } else {
    cachedProfile = {
      tier: 'high',
      maxDpr: 1.5,
      antialias: true,
      shadowMapSize: 2048,
      shadowCascades: 3,
      shadowFilterQuality: 'medium',
      maxAnisotropy: 8,
      maxGlbTextureSize: 1024,
      maxSatelliteTextureSize: 2048,
      splatResolution: 1024
    };
  }

  return cachedProfile;
}
