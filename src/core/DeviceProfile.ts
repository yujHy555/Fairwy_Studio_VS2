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

  // Detect integrated / software laptop GPUs via WebGL renderer string so thin-and-light
  // laptops don't get saddled with 1.5x HiDPI + 3x 2048px CSM shadow cascades.
  let isIntegratedOrSoftwareGpu = false;
  if (typeof document !== 'undefined') {
    try {
      const probe = document.createElement('canvas');
      const gl = (probe.getContext('webgl2') || probe.getContext('webgl')) as WebGLRenderingContext | null;
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '').toLowerCase();
        if (
          /intel|uhd|iris|hd graphics|swiftshader|llvmpipe|mesa|microsoft basic|radeon\(tm\) graphics|vega\s*[0-9]|adreno|mali/.test(renderer) &&
          !/rtx|gtx|radeon rx|radeon pro|arc a\d|quadro|firepro/.test(renderer)
        ) {
          isIntegratedOrSoftwareGpu = true;
        }
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    } catch {
      // Ignore probe errors
    }
  }

  let tier: DeviceTier = 'high';
  if (isMobile) {
    tier = 'mobile';
  } else if (cores <= 4 || memGb <= 4 || isIntegratedOrSoftwareGpu) {
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
      maxDpr: 1.0,
      antialias: false,
      shadowMapSize: 1024,
      shadowCascades: 2,
      shadowFilterQuality: 'low',
      maxAnisotropy: 4,
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
