import {
  Scene,
  Mesh,
  VertexData,
  VertexBuffer,
  Material,
  StandardMaterial,
  PBRMaterial,
  Color3,
  DynamicTexture,
  RawTexture,
  Constants,
  Texture,
  MaterialPluginBase,
  ShaderStore,
  Matrix,
  UniformBuffer,
  MaterialDefines,
  BaseTexture
} from '@babylonjs/core';
import { GOLF_CONSTANTS, SurfaceType } from '../core/Constants';
import { getDeviceProfile } from '../core/DeviceProfile';
import { Vector3D } from '../core/Types';
import { RealisticTextures } from './RealisticTextures';
import {
  PolygonPoint,
  computePolygonBounds,
  pointInPolygon,
  signedDistanceToPolygon
} from './PolygonMath';
import type { UnifiedMapNGCourse } from './MapNGImporter';

/**
 * Patch Babylon.js bump shaders to guarantee stable TBN frame and clean normal mapping.
 */
const patchBumpShaders = () => {
  // 1. Direct patch ShaderStore.IncludesShadersStore['bumpFragment']
  // Babylon's default bumpFragment calls cotangent_frame(normalW*normalScale, ...)
  // When normalScale (bumpTexture.level) is 0.0, normalW*0 is vec3(0), which completely collapses
  // TBN into an all-zero matrix and corrupts normals.
  // Passing normalW directly into cotangent_frame ensures TBN is ALWAYS a stable, unit-length basis.
  let bumpFrag = ShaderStore.IncludesShadersStore['bumpFragment'];
  if (bumpFrag && bumpFrag.includes('normalW*normalScale')) {
    bumpFrag = bumpFrag.replace(
      /cotangent_frame\(normalW\*normalScale,/g,
      'cotangent_frame(normalW,'
    );
  }
  // Prevent detailMap from corrupting bump normal z-component to 0.0 which produced scattered black dot artifacts
  if (bumpFrag && bumpFrag.includes('blendedNormal')) {
    bumpFrag = bumpFrag.replace(
      /#ifdef BUMP[\s\S]*?#elif defined\(DETAIL\)/,
      `#ifdef BUMP
#ifdef OBJECTSPACE_NORMALMAP
#define CUSTOM_FRAGMENT_BUMP_FRAGMENT
normalW=normalize(TEXRD(bumpSampler,vBumpUV).xyz *2.0-1.0);normalW=normalize(mat3(normalMatrix)*normalW);
#else
vec3 bumpNormal=TEXRD(bumpSampler,vBumpUV+uvOffset).xyz*2.0-1.0;
normalW=perturbNormalBase(TBN,bumpNormal,vBumpInfos.y);
#endif
#elif defined(DETAIL)`
    );
  }
  ShaderStore.IncludesShadersStore['bumpFragment'] = bumpFrag;

  // 2. Patch perturbNormalBase in bumpFragmentMainFunctions to smoothly scale normal bumps.
  // Babylon passes scale = vBumpInfos.y = 1.0 / bumpTexture.level.
  // Therefore, bumpStrength = 1.0 / scale = bumpTexture.level!
  // When scale <= 0.001 or scale > 500.0 (or level <= 0.001), immediately return the unperturbed
  // vertex normal cotangentFrame[2] (= normalW), guaranteeing 0.0 is completely flat with zero NaNs.
  // Clamping normal.z to at least 0.05 guarantees the tangent normal never points downwards or creates black dot artifacts.
  let bumpMain = ShaderStore.IncludesShadersStore['bumpFragmentMainFunctions'];
  if (bumpMain) {
    bumpMain = bumpMain.replace(
      /vec3 perturbNormalBase\(mat3 cotangentFrame,vec3 normal,float scale\)[\s\S]*?\{[\s\S]*?return normalize\(cotangentFrame\*normal\);?\}/,
      `vec3 perturbNormalBase(mat3 cotangentFrame, vec3 normal, float scale) {
  if (scale <= 0.001 || scale > 500.0) return normalize(cotangentFrame[2]);
  float bumpStrength = 1.0 / scale;
  vec3 scaledNormal = normalize(vec3(normal.xy * bumpStrength, max(0.05, normal.z)));
  return normalize(cotangentFrame * scaledNormal);
}`
    );
    ShaderStore.IncludesShadersStore['bumpFragmentMainFunctions'] = bumpMain;
  }

  // 3. Patch defaultPixelShader so roughness/specular maps respect vSpecularColor.rgb tint & intensity
  let defaultFrag = ShaderStore.ShadersStore['defaultPixelShader'];
  if (defaultFrag && defaultFrag.includes('specularColor=specularMapColor.rgb;')) {
    defaultFrag = defaultFrag.replace(
      /specularColor=specularMapColor\.rgb;/g,
      'specularColor=specularMapColor.rgb*vSpecularColor.rgb;'
    );
    ShaderStore.ShadersStore['defaultPixelShader'] = defaultFrag;
  }
};
patchBumpShaders();

export type FeatureSubMaterialId =
  | 'surface'
  | 'fringe'
  | 'first_cut'
  | 'shore'
  | 'water_surface';

export interface FeatureSubMaterialOption {
  id: FeatureSubMaterialId;
  label: string;
}

/**
 * Babylon.js material plugin that renders isolated per-surface PBR/Standard Color,
 * Roughness, Normal & UV transforms across:
 *   surfaceMaskSampler.R = Sand Weight (0.0 -> 1.0, strictly non-zero ONLY on Bunker Sand)
 *   surfaceMaskSampler.G = Active Selected Sub-Layer Weight (0.0 -> 1.0)
 *   surfaceMaskSampler.B = Turf Grass Detail Mask (1.0 on Fairway/Green/Tee/Fringe/FirstCut/BunkerLip, 0.0 on Sand/Shore/Bed)
 * Uses smooth analytical heightfield tangents (zero dFdx/dFdy cross-hatching) and unified PBR roughness.
 */
/**
 * Multi-layer Full-Resolution PBR Terrain Plugin:
 * Eliminates blurry splat-baked textures and crosstalk between features/sub-materials by:
 *   1. Giving every (featureIndex, subMaterialId) its own independent row (1..255) in `layerPropsSampler`
 *      (256x2 RGBA32F LUT: UV Scale U/V, UV Offset U/V, ColorTex mix, Roughness level/toggle, Normal relief, texKind).
 *   2. Encoding 2048x2048 high-resolution feature masks in `surfaceMaskSampler` (NEAREST + manual 2x2 sub-texel bilinear):
 *        R = Smooth Feathered Sand Weight (0.0 -> 1.0)
 *        G = Smooth Feathered Water-Bed Weight (0.0 -> 1.0)
 *        B = Exact Integer Layer ID (1..255) for crisp independent UVs/props
 *        A = Owning Sand Layer ID (1..255) inside feathered bunker transition rims
 *   3. Using orthonormal terrain TBN with steep-slope normal damping (zero black grazing stippling on bunker walls).
 */
class BunkerGrassExclusionPlugin extends MaterialPluginBase {
  public groundColorTex: Texture | null = null;
  public groundRoughTex: BaseTexture | null = null;
  public fallbackSplatTex: BaseTexture | null = null;
  public surfaceMaskTex: BaseTexture | null = null;
  public layerPropsTex: BaseTexture | null = null;

  public sandColorTex: BaseTexture | null = null;
  public waterBedColorTex: BaseTexture | null = null;
  public featColorTex: BaseTexture | null = null;
  public featNormalTex: BaseTexture | null = null;
  public featRoughTex: BaseTexture | null = null;
  public neutralRoughTex: RawTexture | null = null;
  public neutralNormalTex: RawTexture | null = null;
  public satelliteOverlayTex: BaseTexture | null = null;
  public tracedSdfTex: BaseTexture | null = null;

  public satelliteOpacity: number = 0.0;
  public satelliteEnabled: boolean = false;
  public overlayOverFeatures: number = 0.0;
  public tracedCount: number = 0;
  public tracedSurfIds: [number, number, number, number] = [0, 0, 0, 0];
  public tracedFringeIds: [number, number, number, number] = [0, 0, 0, 0];
  public tracedCollarW: [number, number, number, number] = [1.8, 1.65, 1.2, 2.15];
  public tracedShowCollar: [number, number, number, number] = [1, 1, 1, 1];
  public tracedFairwayStripes: [number, number, number, number] = [1, 4.6, 0.5, 0];
  public tracedGreenStripes: [number, number, number, number] = [1, 1.8, 0.45, 0];
  public tracedTeeBounds: [number, number, number, number] = [0, 0, 0, 0]; // minX, minZ, maxX, maxZ
  public tracedTeeIds: [number, number, number, number] = [0, 0, 0.5, 0];  // surfId, fringeId, collarW, showCollar
  public tracedTeeStripes: [number, number, number, number] = [1, 1.6, 0.45, 0]; // show, width, contrast, rotRad
  public tracedTeePolyCount: number = 0;
  public tracedTeePolyArray: Float32Array = new Float32Array(40); // 10 * vec4(x0, z0, x1, z1) = 20 smooth vertices!

  public groundBaseColor: Color3 = Color3.FromHexString('#4c7426');
  public groundColorTexLevel: number = 1.0;
  public enableGroundColorTex: boolean = true;
  public enableGroundNormalTex: boolean = true;
  public enableGroundRoughTex: boolean = true;
  public groundNormalLevel: number = 0.45;
  public groundRoughnessLevel: number = 0.78;
  public groundMetallicLevel: number = 0.0;

  public bunkerCount: number = 0;
  public terrainWidth: number = 400;
  public terrainLength: number = 400;
  public bunkersArray: Float32Array = new Float32Array(64);
  public bunkerRotShapeArray: Float32Array = new Float32Array(64);
  public bunkerParamsArray: Float32Array = new Float32Array(64);

  public greenCount: number = 0;
  public greensArray: Float32Array = new Float32Array(16);          // 4 * vec4(centerX, centerZ, halfW, halfL)
  public greenRotCollarArray: Float32Array = new Float32Array(16);  // 4 * vec4(cosNegRot, sinNegRot, showCollar, fringeWidth)
  public greenIdsArray: Float32Array = new Float32Array(16);        // 4 * vec4(surfId, fringeId, firstCutId, 0)
  public greenStripesArray: Float32Array = new Float32Array(16);    // 4 * vec4(showStripes, stripeWidth, stripeContrast, 0)

  public waterCount: number = 0;
  public watersArray: Float32Array = new Float32Array(16);          // 4 * vec4(centerX, centerZ, effHalfW, effHalfL)
  public waterRotCollarArray: Float32Array = new Float32Array(16);  // 4 * vec4(cosNegRot, sinNegRot, showCollar, collarWidth)
  public waterIdsArray: Float32Array = new Float32Array(16);        // 4 * vec4(surfId, fringeId, 0, 0)

  public teeCount: number = 0;
  public teesArray: Float32Array = new Float32Array(16);            // 4 * vec4(centerX, centerZ, effHalfW, effHalfL)
  public teeRotCollarArray: Float32Array = new Float32Array(16);    // 4 * vec4(cosNegRot, sinNegRot, showCollar, collarWidth)
  public teeIdsArray: Float32Array = new Float32Array(16);          // 4 * vec4(surfId, fringeId, 0, 0)
  public teeStripesArray: Float32Array = new Float32Array(16);      // 4 * vec4(showStripes, stripeWidth, stripeContrast, 0)

  constructor(material: Material | StandardMaterial | PBRMaterial) {
    super(material, 'BunkerGrassExclusion', 100, { BUNKER_MASK: true });
    this._enable(true);
    patchBumpShaders();
    const scene = material.getScene();
    if (scene) {
      const roughData = new Uint8Array(4 * 4 * 4);
      const normData = new Uint8Array(4 * 4 * 4);
      for (let i = 0; i < 16; i++) {
        roughData[i * 4 + 0] = 204;
        roughData[i * 4 + 1] = 204;
        roughData[i * 4 + 2] = 204;
        roughData[i * 4 + 3] = 255;
        normData[i * 4 + 0] = 128;
        normData[i * 4 + 1] = 128;
        normData[i * 4 + 2] = 255;
        normData[i * 4 + 3] = 255;
      }
      this.neutralRoughTex = RawTexture.CreateRGBATexture(roughData, 4, 4, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
      this.neutralRoughTex.wrapU = Texture.WRAP_ADDRESSMODE;
      this.neutralRoughTex.wrapV = Texture.WRAP_ADDRESSMODE;
      this.neutralNormalTex = RawTexture.CreateRGBATexture(normData, 4, 4, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
      this.neutralNormalTex.wrapU = Texture.WRAP_ADDRESSMODE;
      this.neutralNormalTex.wrapV = Texture.WRAP_ADDRESSMODE;
    }
  }

  prepareDefines(defines: MaterialDefines) {
    defines['BUNKER_MASK'] = RealisticTextures.syncDefinesForSceneTextures(defines, this._material.getScene());
  }

  getSamplers(samplers: string[]) {
    samplers.push(
      'groundColorSampler',
      'groundRoughSampler',
      'surfaceMaskSampler',
      'layerPropsSampler',
      'sandColorSampler',
      'waterBedColorSampler',
      'featColorSampler',
      'featNormalSampler',
      'featRoughSampler',
      'satelliteOverlaySampler',
      'tracedSdfSampler'
    );
  }

  getActiveTextures(activeTextures: BaseTexture[]) {
    if (this.groundColorTex) activeTextures.push(this.groundColorTex);
    if (this.groundRoughTex) activeTextures.push(this.groundRoughTex);
    if (this.surfaceMaskTex) activeTextures.push(this.surfaceMaskTex);
    if (this.layerPropsTex) activeTextures.push(this.layerPropsTex);
    if (this.sandColorTex) activeTextures.push(this.sandColorTex);
    if (this.waterBedColorTex) activeTextures.push(this.waterBedColorTex);
    if (this.featColorTex) activeTextures.push(this.featColorTex);
    if (this.featNormalTex) activeTextures.push(this.featNormalTex);
    if (this.featRoughTex) activeTextures.push(this.featRoughTex);
    if (this.satelliteOverlayTex) activeTextures.push(this.satelliteOverlayTex);
    if (this.tracedSdfTex) activeTextures.push(this.tracedSdfTex);
  }

  hasTexture(texture: BaseTexture): boolean {
    return (
      this.groundColorTex === texture ||
      this.groundRoughTex === texture ||
      this.surfaceMaskTex === texture ||
      this.layerPropsTex === texture ||
      this.sandColorTex === texture ||
      this.waterBedColorTex === texture ||
      this.featColorTex === texture ||
      this.featNormalTex === texture ||
      this.featRoughTex === texture ||
      this.satelliteOverlayTex === texture ||
      this.tracedSdfTex === texture
    );
  }

  getUniforms() {
    return {
      ubo: [
        { name: 'groundColorMatrix', size: 16, type: 'mat4' },
        { name: 'uGroundColorParams', size: 4, type: 'vec4' },
        { name: 'uGroundRoughParams', size: 4, type: 'vec4' },
        { name: 'uBunkerMeta', size: 4, type: 'vec4' },
        { name: 'uBunkers', size: 4, type: 'vec4', arraySize: 16 },
        { name: 'uBunkerRotShape', size: 4, type: 'vec4', arraySize: 16 },
        { name: 'uBunkerParams', size: 4, type: 'vec4', arraySize: 16 },
        { name: 'uGreens', size: 4, type: 'vec4', arraySize: 4 },
        { name: 'uGreenRotCollar', size: 4, type: 'vec4', arraySize: 4 },
        { name: 'uGreenIds', size: 4, type: 'vec4', arraySize: 4 },
        { name: 'uGreenStripes', size: 4, type: 'vec4', arraySize: 4 },
        { name: 'uWaterMeta', size: 4, type: 'vec4' },
        { name: 'uWaters', size: 4, type: 'vec4', arraySize: 4 },
        { name: 'uWaterRotCollar', size: 4, type: 'vec4', arraySize: 4 },
        { name: 'uWaterIds', size: 4, type: 'vec4', arraySize: 4 },
        { name: 'uTeeMeta', size: 4, type: 'vec4' },
        { name: 'uTees', size: 4, type: 'vec4', arraySize: 4 },
        { name: 'uTeeRotCollar', size: 4, type: 'vec4', arraySize: 4 },
        { name: 'uTeeIds', size: 4, type: 'vec4', arraySize: 4 },
        { name: 'uTeeStripes', size: 4, type: 'vec4', arraySize: 4 },
        { name: 'uSatelliteParams', size: 4, type: 'vec4' },
        { name: 'uTracedMeta', size: 4, type: 'vec4' },
        { name: 'uTracedSurfIds', size: 4, type: 'vec4' },
        { name: 'uTracedFringeIds', size: 4, type: 'vec4' },
        { name: 'uTracedCollarW', size: 4, type: 'vec4' },
        { name: 'uTracedShowCollar', size: 4, type: 'vec4' },
        { name: 'uTracedFairwayStripes', size: 4, type: 'vec4' },
        { name: 'uTracedGreenStripes', size: 4, type: 'vec4' },
        { name: 'uTracedTeeBounds', size: 4, type: 'vec4' },
        { name: 'uTracedTeeIds', size: 4, type: 'vec4' },
        { name: 'uTracedTeeStripes', size: 4, type: 'vec4' },
        { name: 'uTracedTeePoly', size: 4, type: 'vec4', arraySize: 10 }
      ]
    };
  }

  private pickReadyTex(preferred: BaseTexture | null, backup: BaseTexture | null): BaseTexture | null {
    if (preferred && preferred.isReady()) return preferred;
    if (backup && backup.isReady()) return backup;
    return this.fallbackSplatTex;
  }

  bindForSubMesh(uniformBuffer: UniformBuffer, scene: Scene) {
    const groundReady = !!(this.groundColorTex && this.groundColorTex.isReady());
    const useGroundColorTex = this.enableGroundColorTex && groundReady && scene.texturesEnabled;
    const mat4 = this.groundColorTex
      ? this.groundColorTex.getTextureMatrix()
      : Matrix.Identity();
    uniformBuffer.updateMatrix('groundColorMatrix', mat4);

    const mixLvl = useGroundColorTex ? Math.max(0.0, Math.min(1.0, this.groundColorTexLevel)) : 0.0;
    uniformBuffer.updateFloat4(
      'uGroundColorParams',
      this.groundBaseColor.r,
      this.groundBaseColor.g,
      this.groundBaseColor.b,
      mixLvl
    );
    uniformBuffer.updateFloat4(
      'uGroundRoughParams',
      Math.max(0.0, Math.min(1.0, this.groundRoughnessLevel)),
      this.enableGroundRoughTex ? 1.0 : 0.0,
      this.enableGroundNormalTex ? this.groundNormalLevel : 0.0,
      Math.max(0.0, Math.min(1.0, this.groundMetallicLevel))
    );

    uniformBuffer.updateFloat4(
      'uBunkerMeta',
      this.bunkerCount,
      this.terrainWidth,
      this.terrainLength,
      this.greenCount
    );
    uniformBuffer.updateFloatArray('uBunkers', this.bunkersArray);
    uniformBuffer.updateFloatArray('uBunkerRotShape', this.bunkerRotShapeArray);
    uniformBuffer.updateFloatArray('uBunkerParams', this.bunkerParamsArray);
    uniformBuffer.updateFloatArray('uGreens', this.greensArray);
    uniformBuffer.updateFloatArray('uGreenRotCollar', this.greenRotCollarArray);
    uniformBuffer.updateFloatArray('uGreenIds', this.greenIdsArray);
    uniformBuffer.updateFloatArray('uGreenStripes', this.greenStripesArray);

    uniformBuffer.updateFloat4(
      'uWaterMeta',
      this.waterCount,
      this.terrainWidth,
      this.terrainLength,
      this.teeCount
    );
    uniformBuffer.updateFloatArray('uWaters', this.watersArray);
    uniformBuffer.updateFloatArray('uWaterRotCollar', this.waterRotCollarArray);
    uniformBuffer.updateFloatArray('uWaterIds', this.waterIdsArray);

    uniformBuffer.updateFloat4(
      'uTeeMeta',
      this.teeCount,
      this.terrainWidth,
      this.terrainLength,
      0.0
    );
    uniformBuffer.updateFloatArray('uTees', this.teesArray);
    uniformBuffer.updateFloatArray('uTeeRotCollar', this.teeRotCollarArray);
    uniformBuffer.updateFloatArray('uTeeIds', this.teeIdsArray);
    uniformBuffer.updateFloatArray('uTeeStripes', this.teeStripesArray);

    const safeGroundTex = this.pickReadyTex(this.groundColorTex, this.fallbackSplatTex);
    if (safeGroundTex) uniformBuffer.setTexture('groundColorSampler', safeGroundTex);

    const safeRoughTex = this.pickReadyTex(this.groundRoughTex, this.neutralRoughTex);
    if (safeRoughTex) uniformBuffer.setTexture('groundRoughSampler', safeRoughTex);

    const maskTex = this.pickReadyTex(this.surfaceMaskTex, this.fallbackSplatTex);
    if (maskTex) uniformBuffer.setTexture('surfaceMaskSampler', maskTex);

    const propsTex = this.pickReadyTex(this.layerPropsTex, this.fallbackSplatTex);
    if (propsTex) uniformBuffer.setTexture('layerPropsSampler', propsTex);

    const sColTex = this.pickReadyTex(this.sandColorTex, this.fallbackSplatTex);
    if (sColTex) uniformBuffer.setTexture('sandColorSampler', sColTex);

    const wColTex = this.pickReadyTex(this.waterBedColorTex, safeGroundTex);
    if (wColTex) uniformBuffer.setTexture('waterBedColorSampler', wColTex);

    const fColTex = this.pickReadyTex(this.featColorTex, safeGroundTex);
    if (fColTex) uniformBuffer.setTexture('featColorSampler', fColTex);

    const fNormTex = this.pickReadyTex(this.featNormalTex, this.neutralNormalTex);
    if (fNormTex) uniformBuffer.setTexture('featNormalSampler', fNormTex);

    const fRoughTex = this.pickReadyTex(this.featRoughTex, this.neutralRoughTex);
    if (fRoughTex) uniformBuffer.setTexture('featRoughSampler', fRoughTex);

    uniformBuffer.updateFloat4(
      'uSatelliteParams',
      this.satelliteOpacity,
      this.satelliteEnabled && this.satelliteOverlayTex?.isReady() ? 1.0 : 0.0,
      this.overlayOverFeatures,
      0.0
    );
    uniformBuffer.updateFloat4('uTracedMeta', this.tracedCount, 16.0, 0.0, 0.0);
    uniformBuffer.updateFloat4(
      'uTracedSurfIds',
      this.tracedSurfIds[0],
      this.tracedSurfIds[1],
      this.tracedSurfIds[2],
      this.tracedSurfIds[3]
    );
    uniformBuffer.updateFloat4(
      'uTracedFringeIds',
      this.tracedFringeIds[0],
      this.tracedFringeIds[1],
      this.tracedFringeIds[2],
      this.tracedFringeIds[3]
    );
    uniformBuffer.updateFloat4(
      'uTracedCollarW',
      this.tracedCollarW[0],
      this.tracedCollarW[1],
      this.tracedCollarW[2],
      this.tracedCollarW[3]
    );
    uniformBuffer.updateFloat4(
      'uTracedShowCollar',
      this.tracedShowCollar[0],
      this.tracedShowCollar[1],
      this.tracedShowCollar[2],
      this.tracedShowCollar[3]
    );
    uniformBuffer.updateFloat4(
      'uTracedFairwayStripes',
      this.tracedFairwayStripes[0],
      this.tracedFairwayStripes[1],
      this.tracedFairwayStripes[2],
      this.tracedFairwayStripes[3]
    );
    uniformBuffer.updateFloat4(
      'uTracedGreenStripes',
      this.tracedGreenStripes[0],
      this.tracedGreenStripes[1],
      this.tracedGreenStripes[2],
      this.tracedGreenStripes[3]
    );

    const satTex = this.pickReadyTex(this.satelliteOverlayTex, this.fallbackSplatTex);
    if (satTex) uniformBuffer.setTexture('satelliteOverlaySampler', satTex);

    const tSdfTex = this.pickReadyTex(this.tracedSdfTex, this.neutralRoughTex);
    if (tSdfTex) uniformBuffer.setTexture('tracedSdfSampler', tSdfTex);

    uniformBuffer.updateFloat4(
      'uTracedTeeBounds',
      this.tracedTeeBounds[0],
      this.tracedTeeBounds[1],
      this.tracedTeeBounds[2],
      this.tracedTeeBounds[3]
    );
    uniformBuffer.updateFloat4(
      'uTracedTeeIds',
      this.tracedTeeIds[0],
      this.tracedTeeIds[1],
      this.tracedTeeIds[2],
      this.tracedTeeIds[3]
    );
    uniformBuffer.updateFloat4(
      'uTracedTeeStripes',
      this.tracedTeeStripes[0],
      this.tracedTeeStripes[1],
      this.tracedTeeStripes[2],
      this.tracedTeeStripes[3]
    );
    uniformBuffer.updateFloatArray('uTracedTeePoly', this.tracedTeePolyArray);
  }

  getCustomCode(shaderType: string) {
    if (shaderType === 'vertex') {
      return {
        'CUSTOM_VERTEX_DEFINITIONS': `
          #if defined(BUNKER_MASK)
            varying vec2 vGroundColorUV;
            varying vec2 vRawTerrainUV;
          #endif
        `,
        'CUSTOM_VERTEX_MAIN_END': `
          #if defined(BUNKER_MASK)
            vGroundColorUV = vec2(groundColorMatrix * vec4(uvUpdated, 1.0, 0.0));
            vRawTerrainUV = uvUpdated;
          #endif
        `
      };
    }
    if (shaderType === 'fragment') {
      return {
        'CUSTOM_FRAGMENT_DEFINITIONS': `
          #if defined(BUNKER_MASK)
            uniform sampler2D groundColorSampler;
            uniform sampler2D groundRoughSampler;
            uniform sampler2D surfaceMaskSampler;
            uniform sampler2D layerPropsSampler;
            uniform sampler2D sandColorSampler;
            uniform sampler2D waterBedColorSampler;
            uniform sampler2D featColorSampler;
            uniform sampler2D featNormalSampler;
            uniform sampler2D featRoughSampler;
            uniform sampler2D satelliteOverlaySampler;
            uniform sampler2D tracedSdfSampler;
            varying vec2 vGroundColorUV;
            varying vec2 vRawTerrainUV;

            // Zero-sampler analytical 20-vertex polygon SDF for spline-traced Tee Boxes (infinite precision!)
            float evalTracedTeePolySDF(vec2 p) {
              vec2 v[20];
              for (int k = 0; k < 10; k++) {
                vec4 pack = uTracedTeePoly[k];
                v[k * 2] = pack.xy;
                v[k * 2 + 1] = pack.zw;
              }
              float d = dot(p - v[0], p - v[0]);
              float s = 1.0;
              for (int i = 0; i < 20; i++) {
                int j = (i == 0) ? 19 : (i - 1);
                vec2 e = v[j] - v[i];
                vec2 w = p - v[i];
                vec2 b = w - e * clamp(dot(w, e) / max(1e-6, dot(e, e)), 0.0, 1.0);
                d = min(d, dot(b, b));
                bvec3 c = bvec3(p.y >= v[i].y, p.y < v[j].y, e.x * w.y > e.y * w.x);
                if (all(c) || all(not(c))) s *= -1.0;
              }
              return s * sqrt(d);
            }

            // Next-Gen GPU-Optimized Dual-Scale Rotated Anti-Tiling Sampler (2 taps, ultra-lean for fast D3D11 compile & 60+ FPS!)
            vec3 sampleSeamlessTurf(sampler2D samp, vec2 uv) {
              vec3 nearCol = texture2D(samp, uv).rgb;
              vec2 rotUv = vec2(uv.x * 0.7986 - uv.y * 0.6018, uv.x * 0.6018 + uv.y * 0.7986) * 0.43 + vec2(0.37, 0.71);
              vec3 macroCol = texture2D(samp, rotUv).rgb;
              float blendW = 0.28 + 0.24 * (sin(uv.x * 1.15) * cos(uv.y * 1.05));
              float macroVar = 0.96 + 0.08 * (sin(uv.x * 0.37 + uv.y * 0.29) * 0.5 + 0.5);
              return mix(nearCol, macroCol, blendW) * macroVar;
            }

            // Fetches per-layer GPU transforms & properties cleanly for any independent sub-material ID (0..255)
            void readLayerEntry(float lid, out vec4 uvParams, out vec4 matParams, out vec4 extraParams) {
              float lu = (lid + 0.5) / 256.0;
              uvParams = texture2D(layerPropsSampler, vec2(lu, 0.1667));
              matParams = texture2D(layerPropsSampler, vec2(lu, 0.50));
              extraParams = texture2D(layerPropsSampler, vec2(lu, 0.8333));
            }

            // Samples color, normal relief, roughness, metallic, and baseColor for a given independent layer ID & base terrain UV
            void evalSingleLayer(
              float lid,
              vec2 baseUv,
              mat3 terrainTBN,
              vec3 geomN,
              float slopeSafe,
              out vec3 outColor,
              out float outColorMix,
              out vec3 outNormal,
              out float outRough,
              out float outMetallic,
              out vec3 outBaseColor
            ) {
              vec4 lpUv;
              vec4 lpMat;
              vec4 lpExtra;
              readLayerEntry(lid, lpUv, lpMat, lpExtra);
              vec2 layerUv = baseUv * lpUv.xy + lpUv.zw;
              float kind = lpMat.w;

              vec3 texCol;
              vec3 normRaw;
              float roughRaw;

              if (kind > 3.5) {
                texCol = sampleSeamlessTurf(featColorSampler, layerUv);
                normRaw = texture2D(featNormalSampler, layerUv).xyz * 2.0 - 1.0;
                roughRaw = texture2D(featRoughSampler, layerUv).r;
              } else if (kind > 2.5) {
                texCol = texture2D(waterBedColorSampler, layerUv).rgb;
                #if defined(BUMP)
                  normRaw = texture2D(bumpSampler, layerUv).xyz * 2.0 - 1.0;
                #else
                  normRaw = vec3(0.0, 0.0, 1.0);
                #endif
                roughRaw = texture2D(groundRoughSampler, layerUv).r;
              } else if (kind > 1.5) {
                texCol = sampleSeamlessTurf(sandColorSampler, layerUv);
                normRaw = texture2D(featNormalSampler, layerUv).xyz * 2.0 - 1.0;
                roughRaw = texture2D(featRoughSampler, layerUv).r;
              } else if (kind > 0.5) {
                texCol = sampleSeamlessTurf(groundColorSampler, layerUv);
                #if defined(BUMP)
                  normRaw = texture2D(bumpSampler, layerUv).xyz * 2.0 - 1.0;
                #else
                  normRaw = vec3(0.0, 0.0, 1.0);
                #endif
                roughRaw = texture2D(groundRoughSampler, layerUv).r;
              } else {
                texCol = sampleSeamlessTurf(featColorSampler, layerUv);
                #if defined(BUMP)
                  normRaw = texture2D(bumpSampler, layerUv).xyz * 2.0 - 1.0;
                #else
                  normRaw = vec3(0.0, 0.0, 1.0);
                #endif
                roughRaw = texture2D(groundRoughSampler, layerUv).r;
              }

              outColor = texCol;
              outColorMix = clamp(lpMat.x, 0.0, 1.0);
              float effSlope = kind > 1.5 && kind < 2.5 ? slopeSafe : 1.0;
              float normLvl = max(0.0, lpMat.z) * effSlope * (outColorMix < 0.01 ? 0.0 : 1.0);
              outNormal = normLvl > 0.001
                ? normalize(terrainTBN * normalize(vec3(normRaw.xy * normLvl, max(0.55, normRaw.z))))
                : geomN;
              float smoothRough = outColorMix < 0.01 ? 1.0 : mix(0.88, roughRaw, 0.12);
              outRough = lpMat.y < -0.05 ? 0.14 : clamp(smoothRough * lpMat.y, 0.04, 1.0);
              outMetallic = clamp(lpExtra.x, 0.0, 1.0);
              outBaseColor = lpExtra.yzw;
            }

            // GPU harmonic organic contour generator (matches TerrainGrid.getBunkerRadiusFactor 1:1)
            float getBunkerRadiusFactorGLSL(float theta, float shapeIdx) {
              int s = int(mod(mod(floor(shapeIdx + 0.5), 5.0) + 5.0, 5.0) + 0.5);
              if (s == 1) {
                return 0.96 - 0.20 * sin(theta) + 0.22 * cos(3.0 * theta) - 0.10 * sin(2.0 * theta) + 0.08 * cos(4.0 * theta);
              } else if (s == 2) {
                return 0.98 - 0.20 * cos(theta) + 0.22 * sin(3.0 * theta) + 0.12 * cos(4.0 * theta) - 0.09 * sin(2.0 * theta);
              } else if (s == 3) {
                return 0.96 + 0.20 * sin(3.0 * theta) * (0.85 + 0.25 * cos(theta)) + 0.16 * cos(4.0 * theta) - 0.10 * sin(5.0 * theta);
              } else if (s == 4) {
                return 0.95 - 0.14 * cos(theta) + 0.18 * sin(2.0 * theta) + 0.15 * cos(4.0 * theta) - 0.08 * sin(3.0 * theta) + 0.06 * cos(5.0 * theta);
              } else {
                return 0.96 + 0.22 * cos(3.0 * theta) - 0.14 * sin(2.0 * theta) + 0.11 * cos(5.0 * theta) - 0.08 * sin(4.0 * theta);
              }
            }

            // Ultra-precise analytical Signed Distance Field (SDF) evaluation for all active bunkers:
            // Evaluated at screen-pixel resolution with infinite mathematical precision.
            void evaluateBunkerSDF(
              vec2 rawTerrainUV,
              vec4 bunkerMeta,
              out float outSandWeight,
              out float outBunkerWeight,
              out float outSandLid,
              out float outLipLid,
              out float outShowCollar
            ) {
              outSandWeight = 0.0;
              outBunkerWeight = 0.0;
              outSandLid = 0.0;
              outLipLid = 0.0;
              outShowCollar = 0.0;

              int bunkerCount = int(bunkerMeta.x + 0.5);
              float worldX = rawTerrainUV.x * bunkerMeta.y;
              float worldZ = rawTerrainUV.y * bunkerMeta.z;

              for (int bi = 0; bi < 16; bi++) {
                if (bi >= bunkerCount) break;
                vec4 bCenterHalf = uBunkers[bi];
                vec4 bRot = uBunkerRotShape[bi];
                vec4 bPar = uBunkerParams[bi];

                float dx = worldX - bCenterHalf.x;
                float dz = worldZ - bCenterHalf.y;
                float halfW = bCenterHalf.z;
                float halfL = bCenterHalf.w;
                float collarW = bPar.x;
                float sandFeather = bPar.y;
                float surfLid = bPar.z;
                float fringeLid = bPar.w;
                float showCollar = bRot.w;

                float maxDim = max(halfW, halfL) * 1.5 + collarW + 3.0;
                if (abs(dx) > maxDim || abs(dz) > maxDim) continue;

                // Unrotate into local coordinate space
                float lx = dx * bRot.x - dz * bRot.y;
                float lz = dx * bRot.y + dz * bRot.x;

                // Compute contour radius via harmonic equations
                float normX = lx / max(0.1, halfW);
                float normZ = lz / max(0.1, halfL);
                float theta = atan(normZ, normX);
                float k = getBunkerRadiusFactorGLSL(theta, bRot.z);
                float cosT = cos(theta);
                float sinT = sin(theta);
                float sandBx = cosT * halfW * k * 0.78;
                float sandBz = sinT * halfL * k * 0.78;
                float rSand = length(vec2(sandBx, sandBz));
                float rDist = length(vec2(lx, lz));
                float d = rDist - rSand; // < 0 inside sand, > 0 outside sand

                float blendWidth = 1.40;
                float lipW = max(0.20, collarW);
                float rBlendOffset = (showCollar > 0.5) ? (lipW + blendWidth) : sandFeather;
                if (d > rBlendOffset) continue;

                float sWeight = 1.0 - smoothstep(-sandFeather, sandFeather, d);
                float bWeight = (showCollar > 0.5)
                  ? (d <= lipW ? 1.0 : (1.0 - smoothstep(lipW, rBlendOffset, d)))
                  : sWeight;

                if (bWeight > outBunkerWeight) {
                  outBunkerWeight = bWeight;
                  outSandWeight = sWeight;
                  outSandLid = surfLid;
                  outLipLid = fringeLid;
                  outShowCollar = showCollar;
                }
              }
            }

            // Ultra-precise analytical SDF evaluation for Putting Greens + Fringe + First Cut collars:
            // Gradient-normalized Euclidean ellipse distance guarantees uniform collar ring widths 360 deg
            // with zero 20cm canvas pixel stair-stepping.
            void evaluateGreenSDF(
              vec2 rawTerrainUV,
              vec4 meta,
              out float outTotalWeight,
              out float outGreenWeight,
              out float outFringeMask,
              out float outSurfLid,
              out float outFringeLid,
              out float outFirstCutLid,
              out float outShowCollar,
              out float outLocalZ,
              out float outHalfL,
              out vec3 outStripeParams
            ) {
              outTotalWeight = 0.0;
              outGreenWeight = 0.0;
              outFringeMask = 0.0;
              outSurfLid = 0.0;
              outFringeLid = 0.0;
              outFirstCutLid = 0.0;
              outShowCollar = 0.0;
              outLocalZ = 0.0;
              outHalfL = 10.0;
              outStripeParams = vec3(0.0);

              int greenCount = int(meta.w + 0.5);
              float worldX = rawTerrainUV.x * meta.y;
              float worldZ = rawTerrainUV.y * meta.z;

              for (int gi = 0; gi < 4; gi++) {
                if (gi >= greenCount) break;
                vec4 gCH = uGreens[gi];
                vec4 gRC = uGreenRotCollar[gi];
                vec4 gIds = uGreenIds[gi];
                vec4 gStr = uGreenStripes[gi];

                float halfW = max(0.5, gCH.z);
                float halfL = max(0.5, gCH.w);
                float showCollar = gRC.z;
                float fringeW = max(0.0, gRC.w);
                bool hasCollar = (showCollar > 0.5 && fringeW > 0.02);
                float firstCutW = hasCollar ? (fringeW * 2.0) : 0.0;
                float outerFeather = hasCollar ? 0.45 : 0.18;

                float dx = worldX - gCH.x;
                float dz = worldZ - gCH.y;
                float maxDim = max(halfW, halfL) + firstCutW + outerFeather + 1.0;
                if (abs(dx) > maxDim || abs(dz) > maxDim) continue;

                float lx = dx * gRC.x - dz * gRC.y;
                float lz = dx * gRC.y + dz * gRC.x;

                vec2 p = vec2(lx, lz);
                vec2 ab = vec2(halfW, halfL);
                float k0 = length(p / ab);
                float k1 = length(p / (ab * ab));
                float d = (k0 > 0.0001) ? (k0 * (k0 - 1.0) / max(0.0001, k1)) : -min(halfW, halfL);

                if (d > firstCutW + outerFeather) continue;

                float gWeight = 1.0 - smoothstep(-0.08, 0.08, d);
                float fMask = 0.0;
                float totW = 0.0;
                if (hasCollar) {
                  fMask = 1.0 - smoothstep(fringeW - 0.10, fringeW + 0.10, d);
                  totW = 1.0 - smoothstep(firstCutW - 0.10, firstCutW + outerFeather, d);
                } else {
                  totW = gWeight;
                }

                if (totW > outTotalWeight) {
                  outTotalWeight = totW;
                  outGreenWeight = gWeight;
                  outFringeMask = fMask;
                  outSurfLid = gIds.x;
                  outFringeLid = gIds.y;
                  outFirstCutLid = gIds.z;
                  outShowCollar = hasCollar ? 1.0 : 0.0;
                  outLocalZ = lz;
                  outHalfL = halfL;
                  outStripeParams = gStr.xyz;
                }
              }
            }

            // Ultra-precise analytical SDF evaluation for Water Hazards (2-Component: Shoreline & Bank + optional Bank Collar):
            // Gradient-normalized Euclidean ellipse distance guarantees uniform shoreline/bank widths with zero pixel stair-stepping.
            void evaluateWaterSDF(
              vec2 rawTerrainUV,
              vec4 wMeta,
              out float outTotalWeight,
              out float outBedShoreWeight,
              out float outDepthFactor,
              out float outSurfLid,
              out float outFringeLid,
              out float outShowCollar
            ) {
              outTotalWeight = 0.0;
              outBedShoreWeight = 0.0;
              outDepthFactor = 1.0;
              outSurfLid = 0.0;
              outFringeLid = 0.0;
              outShowCollar = 0.0;

              int waterCount = int(wMeta.x + 0.5);
              float worldX = rawTerrainUV.x * wMeta.y;
              float worldZ = rawTerrainUV.y * wMeta.z;

              for (int wi = 0; wi < 4; wi++) {
                if (wi >= waterCount) break;
                vec4 wCH = uWaters[wi];
                vec4 wRC = uWaterRotCollar[wi];
                vec4 wIds = uWaterIds[wi];

                float halfW = max(0.5, wCH.z);
                float halfL = max(0.5, wCH.w);
                bool hasCollar = (wRC.z > 0.5 && wRC.w > 0.02);
                float collarW = hasCollar ? max(0.35, wRC.w) : 0.0;
                float shoreW = hasCollar ? clamp(0.28 + collarW * 0.16, 0.32, 0.72) : 0.50;
                float outerFeather = hasCollar ? 0.65 : 0.48;
                float maxReach = hasCollar ? max(shoreW + 0.35, shoreW + collarW * 0.85) : shoreW;

                float dx = worldX - wCH.x;
                float dz = worldZ - wCH.y;
                float maxDim = max(halfW, halfL) + maxReach + outerFeather + 1.0;
                if (abs(dx) > maxDim || abs(dz) > maxDim) continue;

                float lx = dx * wRC.x - dz * wRC.y;
                float lz = dx * wRC.y + dz * wRC.x;

                vec2 p = vec2(lx, lz);
                vec2 ab = vec2(halfW, halfL);
                float k0 = length(p / ab);
                float k1 = length(p / (ab * ab));
                float d = (k0 > 0.0001) ? (k0 * (k0 - 1.0) / max(0.0001, k1)) : -min(halfW, halfL);

                if (d > maxReach + outerFeather) continue;

                float bedShoreW = 1.0 - smoothstep(shoreW - 0.16, shoreW + 0.26, d);
                float totW = hasCollar
                  ? (1.0 - smoothstep(maxReach - 0.18, maxReach + outerFeather, d))
                  : (1.0 - smoothstep(shoreW - 0.16, shoreW + outerFeather, d));
                float dFac = smoothstep(-2.8, 0.08, d);

                if (totW > outTotalWeight) {
                  outTotalWeight = totW;
                  outBedShoreWeight = bedShoreW;
                  outDepthFactor = dFac;
                  outSurfLid = wIds.x;
                  outFringeLid = wIds.y;
                  outShowCollar = hasCollar ? 1.0 : 0.0;
                }
              }
            }

            // Ultra-precise analytical SDF evaluation for Tee Boxes (2-Component: Tee Box Turf + optional Tee Collar/Fringe):
            // Gradient-normalized Euclidean ellipse distance guarantees uniform collar ring & mowing stripes with zero stair-stepping.
            void evaluateTeeSDF(
              vec2 rawTerrainUV,
              vec4 tMeta,
              out float outTotalWeight,
              out float outTeeWeight,
              out float outSurfLid,
              out float outFringeLid,
              out float outShowCollar,
              out float outLocalX,
              out float outLocalZ,
              out float outHalfW,
              out vec3 outStripeParams
            ) {
              outTotalWeight = 0.0;
              outTeeWeight = 0.0;
              outSurfLid = 0.0;
              outFringeLid = 0.0;
              outShowCollar = 0.0;
              outLocalX = 0.0;
              outLocalZ = 0.0;
              outHalfW = 5.0;
              outStripeParams = vec3(0.0);

              int teeCount = int(tMeta.x + 0.5);
              float worldX = rawTerrainUV.x * tMeta.y;
              float worldZ = rawTerrainUV.y * tMeta.z;

              for (int ti = 0; ti < 4; ti++) {
                if (ti >= teeCount) break;
                vec4 tCH = uTees[ti];
                vec4 tRC = uTeeRotCollar[ti];
                vec4 tIds = uTeeIds[ti];
                vec4 tStr = uTeeStripes[ti];

                float halfW = max(0.5, tCH.z);
                float halfL = max(0.5, tCH.w);
                float showCollar = tRC.z;
                float collarW = max(0.0, tRC.w);
                bool hasCollar = (showCollar > 0.5 && collarW > 0.02);
                float outerFeather = hasCollar ? 0.55 : 0.28;

                float dx = worldX - tCH.x;
                float dz = worldZ - tCH.y;
                float maxDim = max(halfW, halfL) + collarW + outerFeather + 1.5;
                if (abs(dx) > maxDim || abs(dz) > maxDim) continue;

                float lx = dx * tRC.x - dz * tRC.y;
                float lz = dx * tRC.y + dz * tRC.x;

                vec2 p = vec2(lx, lz);
                vec2 ab = vec2(halfW, halfL);
                float k0 = length(p / ab);
                float k1 = length(p / (ab * ab));
                float d = (k0 > 0.0001) ? (k0 * (k0 - 1.0) / max(0.0001, k1)) : -min(halfW, halfL);

                if (d > collarW + outerFeather) continue;

                float tWeight = 1.0 - smoothstep(-0.14, 0.14, d);
                float totW = hasCollar
                  ? (1.0 - smoothstep(collarW - 0.16, collarW + outerFeather, d))
                  : tWeight;

                if (totW > outTotalWeight) {
                  outTotalWeight = totW;
                  outTeeWeight = tWeight;
                  outSurfLid = tIds.x;
                  outFringeLid = tIds.y;
                  outShowCollar = hasCollar ? 1.0 : 0.0;
                  outLocalX = lx;
                  outLocalZ = lz;
                  outHalfW = halfW;
                  outStripeParams = tStr.xyz;
                }
              }
            }

            void applyTracedLayerCol(
              float dVal,
              float surfLid,
              float fringeLid,
              float collarW,
              float showCol,
              vec4 stripeParams,
              vec2 baseUv,
              mat3 tbn,
              vec3 geomN,
              float slopeSafe,
              vec3 vTint,
              inout vec3 ioCol,
              inout vec3 ioNorm
            ) {
              if (surfLid < 0.5 || dVal > collarW + 0.55) return;
              float coreW = 1.0 - smoothstep(-0.18, 0.18, dVal);
              float effColW = showCol > 0.5 ? max(0.24, collarW) : 0.0;
              float totW = effColW > 0.05
                ? (1.0 - smoothstep(effColW - 0.22, effColW + 0.34, dVal))
                : coreW;
              if (totW <= 0.001) return;

              vec3 sTex; float sMix; vec3 sNorm; float sR; float sM; vec3 sBase;
              evalSingleLayer(surfLid, baseUv, tbn, geomN, slopeSafe, sTex, sMix, sNorm, sR, sM, sBase);
              vec3 sCol = mix(sBase, sTex, sMix);
              if (stripeParams.x > 0.5 && stripeParams.y > 0.05 && stripeParams.z > 0.001) {
                float wx = baseUv.x * uTeeMeta.y;
                float wz = baseUv.y * uTeeMeta.z;
                float cosS = cos(stripeParams.w);
                float sinS = sin(stripeParams.w);
                float stripeCoord = wx * sinS + wz * cosS;
                float sPhase = stripeCoord / max(0.25, stripeParams.y);
                float sSide = smoothstep(-0.18, 0.18, sin(sPhase * 3.14159265));
                float opLight = 0.02 + 0.14 * stripeParams.z;
                float opDark  = 0.02 + 0.13 * stripeParams.z;
                vec3 lightTint = mix(sCol, vec3(0.882, 1.0, 0.725), opLight);
                vec3 darkTint  = mix(sCol, vec3(0.039, 0.149, 0.039), opDark);
                sCol = mix(darkTint, lightTint, sSide);
              }
              sCol *= vTint;

              if (effColW > 0.05 && fringeLid > 0.5) {
                vec3 fTex; float fMix; vec3 fNorm; float fR; float fM; vec3 fBase;
                evalSingleLayer(fringeLid, baseUv, tbn, geomN, slopeSafe, fTex, fMix, fNorm, fR, fM, fBase);
                vec3 fCol = mix(fBase, fTex, fMix) * vTint;
                vec3 compCol = mix(fCol, sCol, coreW);
                vec3 compNorm = normalize(mix(fNorm, sNorm, coreW));
                ioCol = mix(ioCol, compCol, totW);
                ioNorm = normalize(mix(ioNorm, compNorm, totW));
              } else {
                ioCol = mix(ioCol, sCol, totW);
                ioNorm = normalize(mix(ioNorm, sNorm, totW));
              }
            }

            void applyTracedLayerRough(
              float dVal,
              float surfLid,
              float fringeLid,
              float collarW,
              float showCol,
              vec2 baseUv,
              inout float ioRough,
              inout float ioMet
            ) {
              if (surfLid < 0.5 || dVal > collarW + 0.55) return;
              float coreW = 1.0 - smoothstep(-0.18, 0.18, dVal);
              float effColW = showCol > 0.5 ? max(0.24, collarW) : 0.0;
              float totW = effColW > 0.05
                ? (1.0 - smoothstep(effColW - 0.22, effColW + 0.34, dVal))
                : coreW;
              if (totW <= 0.001) return;

              vec3 uC; float uM; vec3 uN; vec3 uB;
              float sR; float sM;
              evalSingleLayer(surfLid, baseUv, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, uC, uM, uN, sR, sM, uB);
              if (effColW > 0.05 && fringeLid > 0.5) {
                float fR; float fM;
                evalSingleLayer(fringeLid, baseUv, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, uC, uM, uN, fR, fM, uB);
                ioRough = mix(ioRough, mix(fR, sR, coreW), totW);
                ioMet = mix(ioMet, mix(fM, sM, coreW), totW);
              } else {
                ioRough = mix(ioRough, sR, totW);
                ioMet = mix(ioMet, sM, totW);
              }
            }
          #endif
        `,
        // PBR & Standard diffuse/albedo & normal hook
        'CUSTOM_FRAGMENT_BEFORE_LIGHTS': `
          #if defined(BUNKER_MASK)
            // 1. Course feature Base Color + Mowing Stripes (RGB) and Ground-vs-Feature blend (A)
            #if defined(ALBEDO)
              vec4 pureSplat = texture2D(albedoSampler, vAlbedoUV);
            #elif defined(DIFFUSE)
              vec4 pureSplat = texture2D(diffuseSampler, vDiffuseUV);
            #else
              vec4 pureSplat = vec4(1.0, 1.0, 1.0, 0.502);
            #endif
            #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
              pureSplat.rgb *= vColor.rgb;
            #endif

            // 2. Full-resolution Main Ground GPU color with Next-Gen Anti-Tiling
            vec3 gTexRgb = (uGroundColorParams.a > 0.001)
              ? sampleSeamlessTurf(groundColorSampler, vGroundColorUV)
              : uGroundColorParams.rgb;
            vec3 mainGroundColor = mix(uGroundColorParams.rgb, gTexRgb, clamp(uGroundColorParams.a, 0.0, 1.0));
            #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
              vec3 vertTint = vColor.rgb;
              mainGroundColor *= vertTint;
            #else
              vec3 vertTint = vec3(1.0);
            #endif

            vec3 satOverlayCol = mainGroundColor;
            float hasSat = (uSatelliteParams.y > 0.5 && uSatelliteParams.x > 0.001) ? 1.0 : 0.0;
            if (hasSat > 0.5) {
              satOverlayCol = texture2D(satelliteOverlaySampler, vRawTerrainUV).rgb * vertTint;
              mainGroundColor = mix(mainGroundColor, satOverlayCol, clamp(uSatelliteParams.x, 0.0, 1.0));
            }

            vec4 dTraced = (uTracedMeta.x > 0.5)
              ? (texture2D(tracedSdfSampler, vRawTerrainUV) * 32.0 - 16.0)
              : vec4(16.0);

            // 3. 2x2 sub-texel filter on 1024x1024 surfaceMaskSampler (water masks + crisp integer layerIds for Fairways)
            float mRes = 1024.0;
            vec2 tc = vRawTerrainUV * mRes - 0.5;
            vec2 f = fract(tc);
            vec2 baseCell = (floor(tc) + 0.5) / mRes;
            float pxStep = 1.0 / mRes;

            vec4 s00 = texture2D(surfaceMaskSampler, baseCell);
            vec4 s10 = texture2D(surfaceMaskSampler, baseCell + vec2(pxStep, 0.0));
            vec4 s01 = texture2D(surfaceMaskSampler, baseCell + vec2(0.0, pxStep));
            vec4 s11 = texture2D(surfaceMaskSampler, baseCell + vec2(pxStep, pxStep));

            float id00 = floor(s00.b * 255.0 + 0.5);
            float id10 = floor(s10.b * 255.0 + 0.5);
            float id01 = floor(s01.b * 255.0 + 0.5);
            float id11 = floor(s11.b * 255.0 + 0.5);

            // Orthonormal heightfield tangent frame with steep-slope anti-stipple safety
            #if defined(BUMP) && defined(NORMAL)
              vec3 geomN = normalize(vNormalW);
              vec3 txRaw = cross(geomN, vec3(0.0, 0.0, 1.0));
              vec3 tAxis = length(txRaw) > 0.001 ? normalize(txRaw) : vec3(1.0, 0.0, 0.0);
              vec3 bAxis = normalize(cross(geomN, tAxis));
              mat3 terrainTBN = mat3(tAxis, bAxis, geomN);
              float slopeSafe = smoothstep(0.45, 0.85, geomN.y) * 0.62 + 0.38;

              vec3 gNormRaw = texture2D(bumpSampler, vBumpUV).xyz * 2.0 - 1.0;
              float gNormLvl = uGroundRoughParams.z;
              vec3 groundN = gNormLvl > 0.001
                ? normalize(terrainTBN * normalize(vec3(gNormRaw.xy * gNormLvl, max(0.45, gNormRaw.z))))
                : geomN;
            #else
              vec3 geomN = vec3(0.0, 1.0, 0.0);
              mat3 terrainTBN = mat3(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), geomN);
              float slopeSafe = 1.0;
              vec3 groundN = geomN;
            #endif

            // Evaluate Layer A (id00)
            vec3 layerTexRgb;
            float layerColMix;
            vec3 layerNorm;
            float layerRoughUnused;
            float layerMetUnused;
            vec3 layerBase;
            evalSingleLayer(id00, vRawTerrainUV, terrainTBN, geomN, slopeSafe, layerTexRgb, layerColMix, layerNorm, layerRoughUnused, layerMetUnused, layerBase);

            // Smooth bilinear blend across any sub-layer border (e.g. Tee Turf -> Fringe -> First Cut)
            if (abs(id00 - id10) + abs(id00 - id01) + abs(id00 - id11) > 0.5) {
              float w00 = (1.0 - f.x) * (1.0 - f.y);
              float w10 = f.x * (1.0 - f.y);
              float w01 = (1.0 - f.x) * f.y;
              float w11 = f.x * f.y;

              float wA = w00
                + (abs(id10 - id00) < 0.5 ? w10 : 0.0)
                + (abs(id01 - id00) < 0.5 ? w01 : 0.0)
                + (abs(id11 - id00) < 0.5 ? w11 : 0.0);
              float idB = abs(id10 - id00) > 0.5 ? id10 : (abs(id01 - id00) > 0.5 ? id01 : id11);

              vec3 texB;
              float mixB;
              vec3 normB;
              float roughBUnused;
              float metBUnused;
              vec3 baseB;
              evalSingleLayer(idB, vRawTerrainUV, terrainTBN, geomN, slopeSafe, texB, mixB, normB, roughBUnused, metBUnused, baseB);

              layerTexRgb = mix(texB, layerTexRgb, wA);
              layerColMix = mix(mixB, layerColMix, wA);
              layerNorm = normalize(mix(normB, layerNorm, wA));
              layerBase = mix(baseB, layerBase, wA);
            }

            #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
              layerTexRgb *= vColor.rgb;
              vec3 refBase = max(vec3(0.08), layerBase * vColor.rgb);
            #else
              vec3 refBase = max(vec3(0.08), layerBase);
            #endif

            // Preserve fairway mowing stripe modulation cleanly even when full PBR grass texture is active!
            float splatLum = dot(pureSplat.rgb, vec3(0.299, 0.587, 0.114));
            float baseLum = max(0.06, dot(refBase, vec3(0.299, 0.587, 0.114)));
            float stripeFactor = clamp(splatLum / baseLum, 0.72, 1.32);
            vec3 featureColor = mix(pureSplat.rgb, layerTexRgb * stripeFactor, layerColMix);
            float featureBlend = clamp((pureSplat.a - 0.52) / 0.48, 0.0, 1.0);

            vec3 hostTerrainColor = mix(mainGroundColor, featureColor, featureBlend);
            vec3 hostNormal = normalize(mix(groundN, layerNorm, featureBlend));

            // Layer 0a-traced: Traced MapNG Fairways (RGBA8 linear-filtered GPU SDF + live mowing stripes)
            if (uTracedMeta.x > 0.5 && uTracedSurfIds.x > 0.5) {
              applyTracedLayerCol(
                dTraced.r,
                uTracedSurfIds.x,
                uTracedFringeIds.x,
                uTracedCollarW.x,
                uTracedShowCollar.x,
                uTracedFairwayStripes,
                vRawTerrainUV,
                terrainTBN,
                geomN,
                slopeSafe,
                vertTint,
                hostTerrainColor,
                hostNormal
              );
            }

            // Layer 0b: Analytical SDF Tee Boxes (2-Component: Tee Box Turf + optional Tee Collar / Fringe + mowing stripes)
            float tTotalWeight;
            float tWeight;
            float tSurfLid;
            float tFringeLid;
            float tShowCollar;
            float tLocalX;
            float tLocalZ;
            float tHalfW;
            vec3 tStripeParams;
            evaluateTeeSDF(
              vRawTerrainUV,
              uTeeMeta,
              tTotalWeight,
              tWeight,
              tSurfLid,
              tFringeLid,
              tShowCollar,
              tLocalX,
              tLocalZ,
              tHalfW,
              tStripeParams
            );

            if (tSurfLid > 0.5 && tTotalWeight > 0.001) {
              vec3 tSurfTex; float tSurfMix; vec3 tSurfNorm; float tSR; float tSM; vec3 tSurfBase;
              evalSingleLayer(tSurfLid, vRawTerrainUV, terrainTBN, geomN, slopeSafe, tSurfTex, tSurfMix, tSurfNorm, tSR, tSM, tSurfBase);
              vec3 tSurfCol = mix(tSurfBase, tSurfTex, tSurfMix);

              if (tStripeParams.x > 0.5 && tStripeParams.y > 0.05 && tStripeParams.z > 0.001) {
                float tStripePhase = (tLocalX + tHalfW * 1.3) / max(0.25, tStripeParams.y);
                float tStripeSide = smoothstep(-0.18, 0.18, sin(tStripePhase * 3.14159265));
                float opLight = 0.02 + 0.12 * tStripeParams.z;
                float opDark  = 0.02 + 0.11 * tStripeParams.z;
                vec3 lightTint = mix(tSurfCol, vec3(0.882, 1.0, 0.725), opLight);
                vec3 darkTint  = mix(tSurfCol, vec3(0.039, 0.149, 0.039), opDark);
                tSurfCol = mix(darkTint, lightTint, tStripeSide);
              }
              #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                tSurfCol *= vColor.rgb;
              #endif

              if (tShowCollar > 0.5 && tFringeLid > 0.5) {
                vec3 tFrTex; float tFrMix; vec3 tFrNorm; float tFR; float tFM; vec3 tFrBase;
                evalSingleLayer(tFringeLid, vRawTerrainUV, terrainTBN, geomN, slopeSafe, tFrTex, tFrMix, tFrNorm, tFR, tFM, tFrBase);
                vec3 tFringeCol = mix(tFrBase, tFrTex, tFrMix);
                #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                  tFringeCol *= vColor.rgb;
                #endif

                vec3 teeCompCol = mix(tFringeCol, tSurfCol, tWeight);
                vec3 teeCompNorm = normalize(mix(tFrNorm, tSurfNorm, tWeight));

                hostTerrainColor = mix(hostTerrainColor, teeCompCol, tTotalWeight);
                hostNormal = normalize(mix(hostNormal, teeCompNorm, tTotalWeight));
              } else {
                hostTerrainColor = mix(hostTerrainColor, tSurfCol, tTotalWeight);
                hostNormal = normalize(mix(hostNormal, tSurfNorm, tTotalWeight));
              }
            }

            // Layer 0b-traced: Zero-Sampler Analytical 20-Vertex GPU Polygon SDF for Spline Tee Boxes (infinite resolution!)
            if (uTracedTeeIds.x > 0.5) {
              vec2 tWorldXZ = vec2(vRawTerrainUV.x * uTeeMeta.y, vRawTerrainUV.y * uTeeMeta.z);
              if (tWorldXZ.x >= uTracedTeeBounds.x && tWorldXZ.x <= uTracedTeeBounds.z && tWorldXZ.y >= uTracedTeeBounds.y && tWorldXZ.y <= uTracedTeeBounds.w) {
                float dTrTee = evalTracedTeePolySDF(tWorldXZ);
                applyTracedLayerCol(
                  dTrTee,
                  uTracedTeeIds.x,
                  uTracedTeeIds.y,
                  uTracedTeeIds.z,
                  uTracedTeeIds.w,
                  uTracedTeeStripes,
                  vRawTerrainUV,
                  terrainTBN,
                  geomN,
                  slopeSafe,
                  vertTint,
                  hostTerrainColor,
                  hostNormal
                );
              }
            }

            // Layer 1: Analytical SDF Putting Greens + Uniform Fringe + First Cut collars
            float gTotalWeight;
            float gWeight;
            float gFringeMask;
            float gSurfLid;
            float gFringeLid;
            float gFirstCutLid;
            float gShowCollar;
            float gLocalZ;
            float gHalfL;
            vec3 gStripeParams;
            evaluateGreenSDF(
              vRawTerrainUV,
              uBunkerMeta,
              gTotalWeight,
              gWeight,
              gFringeMask,
              gSurfLid,
              gFringeLid,
              gFirstCutLid,
              gShowCollar,
              gLocalZ,
              gHalfL,
              gStripeParams
            );

            if (gSurfLid > 0.5 && gTotalWeight > 0.001) {
              vec3 gSurfTex; float gSurfMix; vec3 gSurfNorm; float gSR; float gSM; vec3 gSurfBase;
              evalSingleLayer(gSurfLid, vRawTerrainUV, terrainTBN, geomN, slopeSafe, gSurfTex, gSurfMix, gSurfNorm, gSR, gSM, gSurfBase);
              vec3 gSurfCol = mix(gSurfBase, gSurfTex, gSurfMix);

              if (gStripeParams.x > 0.5 && gStripeParams.y > 0.05 && gStripeParams.z > 0.001) {
                float stripePhase = (gLocalZ + gHalfL * 1.4) / max(0.25, gStripeParams.y);
                float stripeSide = smoothstep(-0.18, 0.18, sin(stripePhase * 3.14159265));
                float opLight = 0.02 + 0.12 * gStripeParams.z;
                float opDark  = 0.02 + 0.11 * gStripeParams.z;
                vec3 lightTint = mix(gSurfCol, vec3(0.882, 1.0, 0.725), opLight);
                vec3 darkTint  = mix(gSurfCol, vec3(0.039, 0.149, 0.039), opDark);
                gSurfCol = mix(darkTint, lightTint, stripeSide);
              }
              #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                gSurfCol *= vColor.rgb;
              #endif

              if (gShowCollar > 0.5) {
                vec3 gFrTex; float gFrMix; vec3 gFrNorm; float gFR; float gFM; vec3 gFrBase;
                evalSingleLayer(gFringeLid, vRawTerrainUV, terrainTBN, geomN, slopeSafe, gFrTex, gFrMix, gFrNorm, gFR, gFM, gFrBase);
                vec3 gFringeCol = mix(gFrBase, gFrTex, gFrMix);

                vec3 gFcTex; float gFcMix; vec3 gFcNorm; float gFcR; float gFcM; vec3 gFcBase;
                evalSingleLayer(gFirstCutLid, vRawTerrainUV, terrainTBN, geomN, slopeSafe, gFcTex, gFcMix, gFcNorm, gFcR, gFcM, gFcBase);
                vec3 gFirstCutCol = mix(gFcBase, gFcTex, gFcMix);

                #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                  gFringeCol *= vColor.rgb;
                  gFirstCutCol *= vColor.rgb;
                #endif

                vec3 greenCompCol = mix(gFirstCutCol, gFringeCol, gFringeMask);
                vec3 greenCompNorm = normalize(mix(gFcNorm, gFrNorm, gFringeMask));
                greenCompCol = mix(greenCompCol, gSurfCol, gWeight);
                greenCompNorm = normalize(mix(greenCompNorm, gSurfNorm, gWeight));

                hostTerrainColor = mix(hostTerrainColor, greenCompCol, gTotalWeight);
                hostNormal = normalize(mix(hostNormal, greenCompNorm, gTotalWeight));
              } else {
                hostTerrainColor = mix(hostTerrainColor, gSurfCol, gTotalWeight);
                hostNormal = normalize(mix(hostNormal, gSurfNorm, gTotalWeight));
              }
            }

            if (uTracedMeta.x > 0.5 && uTracedSurfIds.y > 0.5) {
              applyTracedLayerCol(
                dTraced.g,
                uTracedSurfIds.y,
                uTracedFringeIds.y,
                uTracedCollarW.y,
                uTracedShowCollar.y,
                uTracedGreenStripes,
                vRawTerrainUV,
                terrainTBN,
                geomN,
                slopeSafe,
                vertTint,
                hostTerrainColor,
                hostNormal
              );
            }

            // Layer 2: Analytical SDF evaluation for Water Hazards (2-Component: Shoreline & Bank + optional Bank Collar)
            float wTotalW;
            float wBedShoreW;
            float wDepthFactor;
            float wSurfLid;
            float wFringeLid;
            float wShowCollar;
            evaluateWaterSDF(
              vRawTerrainUV,
              uWaterMeta,
              wTotalW,
              wBedShoreW,
              wDepthFactor,
              wSurfLid,
              wFringeLid,
              wShowCollar
            );

            if (wSurfLid > 0.5 && wTotalW > 0.001) {
              vec3 wSurfTex; float wSurfMix; vec3 wSurfNorm; float wSR; float wSM; vec3 wSurfBase;
              evalSingleLayer(wSurfLid, vRawTerrainUV, terrainTBN, geomN, slopeSafe, wSurfTex, wSurfMix, wSurfNorm, wSR, wSM, wSurfBase);
              vec3 wSurfCol = mix(wSurfBase, wSurfTex, wSurfMix) * mix(0.62, 1.0, wDepthFactor);
              #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                wSurfCol *= vColor.rgb;
              #endif

              if (wShowCollar > 0.5 && wFringeLid > 0.5) {
                vec3 wFrTex; float wFrMix; vec3 wFrNorm; float wFR; float wFM; vec3 wFrBase;
                evalSingleLayer(wFringeLid, vRawTerrainUV, terrainTBN, geomN, slopeSafe, wFrTex, wFrMix, wFrNorm, wFR, wFM, wFrBase);
                vec3 wBankCol = mix(wFrBase, wFrTex, wFrMix);
                #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                  wBankCol *= vColor.rgb;
                #endif

                vec3 waterCompCol = mix(wBankCol, wSurfCol, wBedShoreW);
                vec3 waterCompNorm = normalize(mix(wFrNorm, wSurfNorm, wBedShoreW));

                hostTerrainColor = mix(hostTerrainColor, waterCompCol, wTotalW);
                hostNormal = normalize(mix(hostNormal, waterCompNorm, wTotalW));
              } else {
                hostTerrainColor = mix(hostTerrainColor, wSurfCol, wTotalW);
                hostNormal = normalize(mix(hostNormal, wSurfNorm, wTotalW));
              }
            }

            if (uTracedMeta.x > 0.5 && uTracedSurfIds.w > 0.5) {
              applyTracedLayerCol(
                dTraced.a,
                uTracedSurfIds.w,
                uTracedFringeIds.w,
                uTracedCollarW.w,
                uTracedShowCollar.w,
                vec4(0.0),
                vRawTerrainUV,
                terrainTBN,
                geomN,
                slopeSafe,
                vertTint,
                hostTerrainColor,
                hostNormal
              );
            }

            // Layer 3: Analytical SDF evaluation for tournament bunkers (overlays Greens, Fairways, Water, Rough seamlessly)
            float bestSandWeight;
            float bestBunkerWeight;
            float bestSandLid;
            float bestLipLid;
            float bestShowCollar;
            evaluateBunkerSDF(vRawTerrainUV, uBunkerMeta, bestSandWeight, bestBunkerWeight, bestSandLid, bestLipLid, bestShowCollar);

            vec3 finalAlbedo = hostTerrainColor;
            vec3 finalNormal = hostNormal;

            if (bestSandLid > 0.5 && bestBunkerWeight > 0.001) {
              vec3 sTexRgb; float sColMix; vec3 sNorm; float sRough; float sMet; vec3 sBase;
              evalSingleLayer(bestSandLid, vRawTerrainUV, terrainTBN, geomN, slopeSafe, sTexRgb, sColMix, sNorm, sRough, sMet, sBase);
              vec3 sCol = mix(sBase, sTexRgb, sColMix);
              #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                sCol *= vColor.rgb;
              #endif

              if (bestShowCollar > 0.5) {
                vec3 lipTex; float lipColMix; vec3 lipNorm; float lipRough; float lipMet; vec3 lipBase;
                evalSingleLayer(bestLipLid, vRawTerrainUV, terrainTBN, geomN, slopeSafe, lipTex, lipColMix, lipNorm, lipRough, lipMet, lipBase);
                vec3 lipCol = mix(lipBase, lipTex, lipColMix);
                #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                  lipCol *= vColor.rgb;
                #endif

                vec3 hazardColor = mix(lipCol, sCol, bestSandWeight);
                vec3 hazardNorm  = normalize(mix(lipNorm, sNorm, bestSandWeight));

                finalAlbedo = mix(hostTerrainColor, hazardColor, bestBunkerWeight);
                finalNormal = normalize(mix(hostNormal, hazardNorm, bestBunkerWeight));
              } else {
                finalAlbedo = mix(hostTerrainColor, sCol, bestBunkerWeight);
                finalNormal = normalize(mix(hostNormal, sNorm, bestBunkerWeight));
              }
            }

            if (uTracedMeta.x > 0.5 && uTracedSurfIds.z > 0.5) {
              applyTracedLayerCol(
                dTraced.b,
                uTracedSurfIds.z,
                uTracedFringeIds.z,
                uTracedCollarW.z,
                uTracedShowCollar.z,
                vec4(0.0),
                vRawTerrainUV,
                terrainTBN,
                geomN,
                slopeSafe,
                vertTint,
                finalAlbedo,
                finalNormal
              );
            }

            if (hasSat > 0.5 && uSatelliteParams.z > 0.01) {
              finalAlbedo = mix(finalAlbedo, satOverlayCol, clamp(uSatelliteParams.z * uSatelliteParams.x, 0.0, 0.75));
            }

            #if defined(ALBEDO)
              surfaceAlbedo = toLinearSpace(finalAlbedo);
            #endif
            #if defined(DIFFUSE)
              baseColor.rgb = finalAlbedo;
            #endif
            #if defined(BUMP) && defined(NORMAL)
              normalW = finalNormal;
            #endif
          #endif
        `,
        // StandardMaterial fallback for diffuse
        'CUSTOM_FRAGMENT_UPDATE_DIFFUSE': `
          #if defined(DIFFUSE) && !defined(ALBEDO)
            // Handled in CUSTOM_FRAGMENT_BEFORE_LIGHTS
          #endif
        `,
        // PBR native Metallic-Roughness hook
        'CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS': `
          #if defined(BUNKER_MASK)
            float gRoughSample = (uGroundRoughParams.y > 0.5) ? texture2D(groundRoughSampler, vGroundColorUV).r : 0.78;
            float gEffRough = (uGroundRoughParams.y > 0.5) ? clamp(gRoughSample * uGroundRoughParams.x, 0.04, 1.0) : clamp(uGroundRoughParams.x, 0.04, 1.0);

            float spRes = 1024.0;
            vec2 spTc = vRawTerrainUV * spRes - 0.5;
            vec2 spF = fract(spTc);
            vec2 spBase = (floor(spTc) + 0.5) / spRes;
            float spStep = 1.0 / spRes;

            vec4 sp00 = texture2D(surfaceMaskSampler, spBase);
            vec4 sp10 = texture2D(surfaceMaskSampler, spBase + vec2(spStep, 0.0));
            vec4 sp01 = texture2D(surfaceMaskSampler, spBase + vec2(0.0, spStep));
            vec4 sp11 = texture2D(surfaceMaskSampler, spBase + vec2(spStep, spStep));

            float spId00 = floor(sp00.b * 255.0 + 0.5);
            float spId10 = floor(sp10.b * 255.0 + 0.5);
            float spId01 = floor(sp01.b * 255.0 + 0.5);
            float spId11 = floor(sp11.b * 255.0 + 0.5);

            vec3 unusedC; float unusedM; vec3 unusedN; vec3 unusedBase;
            float layerRough;
            float layerMetallic;
            evalSingleLayer(spId00, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, layerRough, layerMetallic, unusedBase);

            if (abs(spId00 - spId10) + abs(spId00 - spId01) + abs(spId00 - spId11) > 0.5) {
              float w00 = (1.0 - spF.x) * (1.0 - spF.y);
              float w10 = spF.x * (1.0 - spF.y);
              float w01 = (1.0 - spF.x) * spF.y;
              float w11 = spF.x * spF.y;
              float wA = w00
                + (abs(spId10 - spId00) < 0.5 ? w10 : 0.0)
                + (abs(spId01 - spId00) < 0.5 ? w01 : 0.0)
                + (abs(spId11 - spId00) < 0.5 ? w11 : 0.0);
              float spIdB = abs(spId10 - spId00) > 0.5 ? spId10 : (abs(spId01 - spId00) > 0.5 ? spId01 : spId11);
              float layerRoughB;
              float layerMetB;
              evalSingleLayer(spIdB, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, layerRoughB, layerMetB, unusedBase);
              layerRough = mix(layerRoughB, layerRough, wA);
              layerMetallic = mix(layerMetB, layerMetallic, wA);
            }

            #if defined(ALBEDO)
              float spFeatBlend = clamp((texture2D(albedoSampler, vAlbedoUV).a - 0.52) / 0.48, 0.0, 1.0);
            #elif defined(DIFFUSE)
              float spFeatBlend = clamp((texture2D(diffuseSampler, vDiffuseUV).a - 0.52) / 0.48, 0.0, 1.0);
            #else
              float spFeatBlend = 0.0;
            #endif

            float hostRough = mix(gEffRough, layerRough, spFeatBlend);
            float hostMet = 0.0;
            #ifdef METALLICWORKFLOW
              float gEffMetallic = clamp(uGroundRoughParams.w, 0.0, 1.0);
              hostMet = mix(gEffMetallic, layerMetallic, spFeatBlend);
            #endif

            vec4 dTracedSp = (uTracedMeta.x > 0.5)
              ? (texture2D(tracedSdfSampler, vRawTerrainUV) * 32.0 - 16.0)
              : vec4(16.0);
            if (uTracedMeta.x > 0.5 && uTracedSurfIds.x > 0.5) {
              applyTracedLayerRough(dTracedSp.r, uTracedSurfIds.x, uTracedFringeIds.x, uTracedCollarW.x, uTracedShowCollar.x, vRawTerrainUV, hostRough, hostMet);
            }

            // Layer 0b: Analytical Tee Box roughness & metallic
            float spTTotalW; float spTWeight;
            float spTSurfLid; float spTFringeLid; float spTShowCollar;
            float spTLocalX; float spTLocalZ; float spTHalfW; vec3 spTStripe;
            evaluateTeeSDF(
              vRawTerrainUV, uTeeMeta,
              spTTotalW, spTWeight,
              spTSurfLid, spTFringeLid, spTShowCollar,
              spTLocalX, spTLocalZ, spTHalfW, spTStripe
            );

            if (spTSurfLid > 0.5 && spTTotalW > 0.001) {
              float tSR; float tSM;
              evalSingleLayer(spTSurfLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, tSR, tSM, unusedBase);
              if (spTShowCollar > 0.5 && spTFringeLid > 0.5) {
                float tFR; float tFM;
                evalSingleLayer(spTFringeLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, tFR, tFM, unusedBase);
                float teeCompR = mix(tFR, tSR, spTWeight);
                float teeCompM = mix(tFM, tSM, spTWeight);
                hostRough = mix(hostRough, teeCompR, spTTotalW);
                hostMet   = mix(hostMet, teeCompM, spTTotalW);
              } else {
                hostRough = mix(hostRough, tSR, spTTotalW);
                hostMet   = mix(hostMet, tSM, spTTotalW);
              }
            }

            if (uTracedTeeIds.x > 0.5) {
              vec2 tWorldXZSp = vec2(vRawTerrainUV.x * uTeeMeta.y, vRawTerrainUV.y * uTeeMeta.z);
              if (tWorldXZSp.x >= uTracedTeeBounds.x && tWorldXZSp.x <= uTracedTeeBounds.z && tWorldXZSp.y >= uTracedTeeBounds.y && tWorldXZSp.y <= uTracedTeeBounds.w) {
                float dTrTeeSp = evalTracedTeePolySDF(tWorldXZSp);
                applyTracedLayerRough(dTrTeeSp, uTracedTeeIds.x, uTracedTeeIds.y, uTracedTeeIds.z, uTracedTeeIds.w, vRawTerrainUV, hostRough, hostMet);
              }
            }

            // Layer 1: Analytical Green roughness & metallic
            float spGTotalW; float spGWeight; float spGFringeMask;
            float spGSurfLid; float spGFringeLid; float spGFirstCutLid; float spGShowCollar;
            float spGLocalZ; float spGHalfL; vec3 spGStripe;
            evaluateGreenSDF(
              vRawTerrainUV, uBunkerMeta,
              spGTotalW, spGWeight, spGFringeMask,
              spGSurfLid, spGFringeLid, spGFirstCutLid, spGShowCollar,
              spGLocalZ, spGHalfL, spGStripe
            );

            if (spGSurfLid > 0.5 && spGTotalW > 0.001) {
              float gSR; float gSM;
              evalSingleLayer(spGSurfLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, gSR, gSM, unusedBase);
              if (spGShowCollar > 0.5) {
                float gFR; float gFM;
                evalSingleLayer(spGFringeLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, gFR, gFM, unusedBase);
                float gFcR; float gFcM;
                evalSingleLayer(spGFirstCutLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, gFcR, gFcM, unusedBase);

                float greenCompR = mix(gFcR, gFR, spGFringeMask);
                float greenCompM = mix(gFcM, gFM, spGFringeMask);
                greenCompR = mix(greenCompR, gSR, spGWeight);
                greenCompM = mix(greenCompM, gSM, spGWeight);

                hostRough = mix(hostRough, greenCompR, spGTotalW);
                hostMet   = mix(hostMet, greenCompM, spGTotalW);
              } else {
                hostRough = mix(hostRough, gSR, spGTotalW);
                hostMet   = mix(hostMet, gSM, spGTotalW);
              }
            }

            // Layer 2: Analytical Water roughness & metallic (wet shoreline sheen -> natural bank collar)
            float spWTotalW; float spWBedShoreW; float spWDepthFactor;
            float spWSurfLid; float spWFringeLid; float spWShowCollar;
            evaluateWaterSDF(
              vRawTerrainUV, uWaterMeta,
              spWTotalW, spWBedShoreW, spWDepthFactor,
              spWSurfLid, spWFringeLid, spWShowCollar
            );

            if (spWSurfLid > 0.5 && spWTotalW > 0.001) {
              float wSR; float wSM;
              evalSingleLayer(spWSurfLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, wSR, wSM, unusedBase);
              float effWetRough = wSR * mix(0.74, 1.0, 1.0 - spWBedShoreW);
              if (spWShowCollar > 0.5 && spWFringeLid > 0.5) {
                float wFR; float wFM;
                evalSingleLayer(spWFringeLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, wFR, wFM, unusedBase);
                float waterCompR = mix(wFR, effWetRough, spWBedShoreW);
                float waterCompM = mix(wFM, wSM, spWBedShoreW);
                hostRough = mix(hostRough, waterCompR, spWTotalW);
                hostMet   = mix(hostMet, waterCompM, spWTotalW);
              } else {
                hostRough = mix(hostRough, effWetRough, spWTotalW);
                hostMet   = mix(hostMet, wSM, spWTotalW);
              }
            }

            if (uTracedMeta.x > 0.5) {
              if (uTracedSurfIds.y > 0.5) {
                applyTracedLayerRough(dTracedSp.g, uTracedSurfIds.y, uTracedFringeIds.y, uTracedCollarW.y, uTracedShowCollar.y, vRawTerrainUV, hostRough, hostMet);
              }
              if (uTracedSurfIds.w > 0.5) {
                applyTracedLayerRough(dTracedSp.a, uTracedSurfIds.w, uTracedFringeIds.w, uTracedCollarW.w, uTracedShowCollar.w, vRawTerrainUV, hostRough, hostMet);
              }
            }

            // Layer 3: Analytical Bunker roughness & metallic
            float spBestSandWeight;
            float spBestBunkerWeight;
            float spBestSandLid;
            float spBestLipLid;
            float spBestShowCollar;
            evaluateBunkerSDF(vRawTerrainUV, uBunkerMeta, spBestSandWeight, spBestBunkerWeight, spBestSandLid, spBestLipLid, spBestShowCollar);

            float finalRough = hostRough;
            float finalMet = hostMet;

            if (spBestSandLid > 0.5 && spBestBunkerWeight > 0.001) {
              float sandRoughVal; float sandMetVal;
              evalSingleLayer(spBestSandLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, sandRoughVal, sandMetVal, unusedBase);

              if (spBestShowCollar > 0.5) {
                float lipRoughVal; float lipMetVal;
                evalSingleLayer(spBestLipLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, lipRoughVal, lipMetVal, unusedBase);

                float hazardRough = mix(lipRoughVal, sandRoughVal, spBestSandWeight);
                float hazardMet   = mix(lipMetVal, sandMetVal, spBestSandWeight);

                finalRough = mix(hostRough, hazardRough, spBestBunkerWeight);
                finalMet   = mix(hostMet, hazardMet, spBestBunkerWeight);
              } else {
                finalRough = mix(hostRough, sandRoughVal, spBestBunkerWeight);
                finalMet   = mix(hostMet, sandMetVal, spBestBunkerWeight);
              }
            }

            if (uTracedMeta.x > 0.5 && uTracedSurfIds.z > 0.5) {
              applyTracedLayerRough(dTracedSp.b, uTracedSurfIds.z, uTracedFringeIds.z, uTracedCollarW.z, uTracedShowCollar.z, vRawTerrainUV, finalRough, finalMet);
            }

            metallicRoughness.g = clamp(finalRough, 0.04, 1.0);
            #ifdef METALLICWORKFLOW
              metallicRoughness.r = clamp(finalMet, 0.0, 1.0);
            #endif
          #endif
        `,
        // StandardMaterial fallback for specular
        '!vec3 diffuseBase=vec3\\(0\\.,0\\.,0\\.\\);lightingInfo info;': `
          #if defined(BUNKER_MASK) && defined(SPECULARTERM) && !defined(ALBEDO)
            float gRoughSample = (uGroundRoughParams.y > 0.5) ? texture2D(groundRoughSampler, vGroundColorUV).r : 0.78;
            float gEffRough = (uGroundRoughParams.y > 0.5) ? clamp(gRoughSample * uGroundRoughParams.x, 0.0, 1.0) : 0.14;

            float spRes = 1024.0;
            vec2 spTc = vRawTerrainUV * spRes - 0.5;
            vec2 spF = fract(spTc);
            vec2 spBase = (floor(spTc) + 0.5) / spRes;
            float spStep = 1.0 / spRes;

            vec4 sp00 = texture2D(surfaceMaskSampler, spBase);
            vec4 sp10 = texture2D(surfaceMaskSampler, spBase + vec2(spStep, 0.0));
            vec4 sp01 = texture2D(surfaceMaskSampler, spBase + vec2(0.0, spStep));
            vec4 sp11 = texture2D(surfaceMaskSampler, spBase + vec2(spStep, spStep));

            float spId00 = floor(sp00.b * 255.0 + 0.5);
            float spId10 = floor(sp10.b * 255.0 + 0.5);
            float spId01 = floor(sp01.b * 255.0 + 0.5);
            float spId11 = floor(sp11.b * 255.0 + 0.5);

            vec3 unusedC; float unusedM; vec3 unusedN; vec3 unusedBase;
            float layerRough;
            float layerMetallic;
            evalSingleLayer(spId00, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, layerRough, layerMetallic, unusedBase);

            if (abs(spId00 - spId10) + abs(spId00 - spId01) + abs(spId00 - spId11) > 0.5) {
              float w00 = (1.0 - spF.x) * (1.0 - spF.y);
              float w10 = spF.x * (1.0 - spF.y);
              float w01 = (1.0 - spF.x) * spF.y;
              float w11 = spF.x * spF.y;
              float wA = w00
                + (abs(spId10 - spId00) < 0.5 ? w10 : 0.0)
                + (abs(spId01 - spId00) < 0.5 ? w01 : 0.0)
                + (abs(spId11 - spId00) < 0.5 ? w11 : 0.0);
              float spIdB = abs(spId10 - spId00) > 0.5 ? spId10 : (abs(spId01 - spId00) > 0.5 ? spId01 : spId11);
              float layerRoughB;
              float layerMetB;
              evalSingleLayer(spIdB, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, layerRoughB, layerMetB, unusedBase);
              layerRough = mix(layerRoughB, layerRough, wA);
            }

            #if defined(ALBEDO)
              float spFeatBlend = clamp((texture2D(albedoSampler, vAlbedoUV).a - 0.52) / 0.48, 0.0, 1.0);
            #elif defined(DIFFUSE)
              float spFeatBlend = clamp((texture2D(diffuseSampler, vDiffuseUV).a - 0.52) / 0.48, 0.0, 1.0);
            #else
              float spFeatBlend = 0.0;
            #endif
            float hostRough = mix(gEffRough, layerRough, spFeatBlend);

            float spTTotalW; float spTWeight;
            float spTSurfLid; float spTFringeLid; float spTShowCollar;
            float spTLocalX; float spTLocalZ; float spTHalfW; vec3 spTStripe;
            evaluateTeeSDF(
              vRawTerrainUV, uTeeMeta,
              spTTotalW, spTWeight,
              spTSurfLid, spTFringeLid, spTShowCollar,
              spTLocalX, spTLocalZ, spTHalfW, spTStripe
            );

            if (spTSurfLid > 0.5 && spTTotalW > 0.001) {
              float tSR; float tSM;
              evalSingleLayer(spTSurfLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, tSR, tSM, unusedBase);
              if (spTShowCollar > 0.5 && spTFringeLid > 0.5) {
                float tFR; float tFM;
                evalSingleLayer(spTFringeLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, tFR, tFM, unusedBase);
                float teeCompR = mix(tFR, tSR, spTWeight);
                hostRough = mix(hostRough, teeCompR, spTTotalW);
              } else {
                hostRough = mix(hostRough, tSR, spTTotalW);
              }
            }

            float spGTotalW; float spGWeight; float spGFringeMask;
            float spGSurfLid; float spGFringeLid; float spGFirstCutLid; float spGShowCollar;
            float spGLocalZ; float spGHalfL; vec3 spGStripe;
            evaluateGreenSDF(
              vRawTerrainUV, uBunkerMeta,
              spGTotalW, spGWeight, spGFringeMask,
              spGSurfLid, spGFringeLid, spGFirstCutLid, spGShowCollar,
              spGLocalZ, spGHalfL, spGStripe
            );

            if (spGSurfLid > 0.5 && spGTotalW > 0.001) {
              float gSR; float gSM;
              evalSingleLayer(spGSurfLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, gSR, gSM, unusedBase);
              if (spGShowCollar > 0.5) {
                float gFR; float gFM;
                evalSingleLayer(spGFringeLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, gFR, gFM, unusedBase);
                float gFcR; float gFcM;
                evalSingleLayer(spGFirstCutLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, gFcR, gFcM, unusedBase);
                float greenCompR = mix(mix(gFcR, gFR, spGFringeMask), gSR, spGWeight);
                hostRough = mix(hostRough, greenCompR, spGTotalW);
              } else {
                hostRough = mix(hostRough, gSR, spGTotalW);
              }
            }

            float spWTotalW; float spWBedShoreW; float spWDepthFactor;
            float spWSurfLid; float spWFringeLid; float spWShowCollar;
            evaluateWaterSDF(
              vRawTerrainUV, uWaterMeta,
              spWTotalW, spWBedShoreW, spWDepthFactor,
              spWSurfLid, spWFringeLid, spWShowCollar
            );

            if (spWSurfLid > 0.5 && spWTotalW > 0.001) {
              float wSR; float wSM;
              evalSingleLayer(spWSurfLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, wSR, wSM, unusedBase);
              float effWetRough = wSR * mix(0.74, 1.0, 1.0 - spWBedShoreW);
              if (spWShowCollar > 0.5 && spWFringeLid > 0.5) {
                float wFR; float wFM;
                evalSingleLayer(spWFringeLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, wFR, wFM, unusedBase);
                float waterCompR = mix(wFR, effWetRough, spWBedShoreW);
                hostRough = mix(hostRough, waterCompR, spWTotalW);
              } else {
                hostRough = mix(hostRough, effWetRough, spWTotalW);
              }
            }

            float spBestSandWeight;
            float spBestBunkerWeight;
            float spBestSandLid;
            float spBestLipLid;
            float spBestShowCollar;
            evaluateBunkerSDF(vRawTerrainUV, uBunkerMeta, spBestSandWeight, spBestBunkerWeight, spBestSandLid, spBestLipLid, spBestShowCollar);

            float finalRough = hostRough;
            if (spBestSandLid > 0.5 && spBestBunkerWeight > 0.001) {
              float sandRoughVal; float sandMetVal;
              evalSingleLayer(spBestSandLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, sandRoughVal, sandMetVal, unusedBase);
              if (spBestShowCollar > 0.5) {
                float lipRoughVal; float lipMetVal;
                evalSingleLayer(spBestLipLid, vRawTerrainUV, mat3(1.0), vec3(0.0, 1.0, 0.0), 1.0, unusedC, unusedM, unusedN, lipRoughVal, lipMetVal, unusedBase);
                float hazardRough = mix(lipRoughVal, sandRoughVal, spBestSandWeight);
                finalRough = mix(hostRough, hazardRough, spBestBunkerWeight);
              } else {
                finalRough = mix(hostRough, sandRoughVal, spBestBunkerWeight);
              }
            }
            float finalSmooth = clamp(1.0 - finalRough, 0.0, 1.0);
            specularColor = vec3(pow(finalSmooth, 1.45) * 0.68);
            glossiness = mix(3.0, 92.0, finalSmooth * finalSmooth);
          #endif
          vec3 diffuseBase=vec3(0.,0.,0.);lightingInfo info;
        `
      };
    }
    return null;
  }
}

export interface DoglegWaypoint {
  x: number;
  z: number;
  width: number;
}

export interface FeatureTextureUrls {
  color?: string;
  roughness?: string;
  normal?: string;
  colorName?: string;
  roughnessName?: string;
  normalName?: string;
}

export interface FeatureMaterialSettings {
  baseColor?: string;        // Hex color, e.g. '#28c860'
  colorTexLevel?: number;    // 0.0 = pure baseColor, 0.5 = 50/50 blend, 1.0 = pure color texture
  roughnessLevel?: number;   // 0.0 = 0 roughness (glossy), 1.0 = full roughness from map
  metallicLevel?: number;    // 0.0 to 1.0 (default 0.0)
  uScale?: number;           // Texture pattern UV repeat scale (0.0 to 600.0, default 1.0)
  vScale?: number;           // Texture pattern UV repeat scale (0.0 to 600.0, default 1.0)
  uOffset?: number;          // Texture UV offset (0.0 to 1.0, default 0.0)
  vOffset?: number;          // Texture UV offset (0.0 to 1.0, default 0.0)
  normalLevel?: number;      // 0.0 to 2.5
  enableBaseColorTex?: boolean; // Default true: use pattern/photo; false: solid baseColor
  enableRoughnessTex?: boolean; // Default true
  enableNormalTex?: boolean;    // Default true
  // Lawn mowing stripes & collar rings
  showMowingStripes?: boolean;   // Default true
  mowingStripeWidth?: number;    // 0.0m to 5.0m
  mowingStripeContrast?: number; // 0.0 to 1.0
  showCollarRings?: boolean;     // Default true
  collarWidth?: number;          // 0.0m to 6.0m
  // Per-sub-material custom texture overrides
  customTile?: HTMLCanvasElement;
  customTextureUrls?: FeatureTextureUrls;
  customColorTex?: Texture | null;
  customNormalTex?: Texture | null;
  customRoughTex?: Texture | null;
}

export interface StampedFeatureRecord {
  materialSettings?: FeatureMaterialSettings;
  subMaterials?: Partial<Record<FeatureSubMaterialId, FeatureMaterialSettings>>;
  customTile?: HTMLCanvasElement;
  customTextureUrls?: FeatureTextureUrls;
  id?: string;
  name?: string;
  centerX: number;
  centerZ: number;
  width: number;
  length: number;
  rotationRad: number;
  surfaceType: SurfaceType;
  depthProfile: number;
  lipHeight: number;
  baseElevation?: number;
  isKidney?: boolean;
  bunkerShapeIndex?: number;
  doglegPoints?: DoglegWaypoint[];
  contour?: PolygonPoint[];
  conformDemBlend?: number;
}

export class TerrainGrid {
  public static readonly MASK_RESOLUTION = 1024;

  public width: number;
  public length: number;
  public cols: number; // gridX + 1
  public rows: number; // gridZ + 1
  public blockCols: number;
  public blockRows: number;

  public baseHeights: Float32Array;
  public heights: Float32Array;
  public surfaceTypes: Uint8Array;
  public subdividedCells: Uint8Array;
  public coarseBlocks: Uint8Array;
  public isDraftMode = false;
  private pristineNaturalHeights: Float32Array | null = null;

  public terrainMesh: Mesh | null = null;
  public splatTexture: DynamicTexture | null = null;
  public stampedFeatures: StampedFeatureRecord[] = [];
  private scene: Scene;

  private positions: Float32Array;
  private normals: Float32Array;
  private uvs: Float32Array;
  private colors: Float32Array;
  private indices: Uint32Array;

  private roughPhotoTile: HTMLCanvasElement | null = null;
  private defaultRoughPhotoTile: HTMLCanvasElement | null = null;
  private photoPatternsPromise: Promise<void> | null = null;

  // Ultra-smooth delta feature drag cache (avoids full-course re-stamps & mesh buffer reallocations during live drag)
  private dragStaticBaseHeights: Float32Array | null = null;
  private dragStaticFeatureIdx: number = -1;
  private lastDraftSplatTime: number = 0;
  private draftSplatTimer: number | null = null;

  // Grass007 4K PBR ground texture references & real-time editable material/UV settings
  public groundUvScaleU: number = 110;
  public groundUvScaleV: number = 230;
  public groundUvOffsetU: number = 0.0;
  public groundUvOffsetV: number = 0.0;
  public groundNormalLevel: number = 0.45;
  public groundDetailBlendLevel: number = 0.50;
  public groundBaseColor: string = '#4c7426';
  public groundColorTexLevel: number = 1.0;
  public groundRoughnessLevel: number = 0.78;
  public groundEnableBaseColorTex: boolean = true;
  public groundEnableRoughnessTex: boolean = true;
  public groundEnableNormalTex: boolean = true;
  public groundCustomTextureUrls: {
    color?: string;
    roughness?: string;
    normal?: string;
    colorName?: string;
    roughnessName?: string;
    normalName?: string;
  } = {};
  private groundSplatRaf: number | null = null;

  public pbrGrassColorTex: Texture | null = null;
  public pbrGrassNormalTex: Texture | null = null;
  public pbrGrassRoughTex: Texture | null = null;
  public defaultTurfColorTex: Texture | null = null;
  public defaultSandColorTex: Texture | null = null;
  public sandNormalTex: DynamicTexture | null = null;
  public sandRoughTex: DynamicTexture | null = null;
  public surfaceMaskTex: RawTexture | null = null;
  public surfaceMaskData: Uint8Array | null = null;
  private layerPropsTex: RawTexture | null = null;
  private layerPropsData: Float32Array = new Float32Array(256 * 3 * 4);
  private layerIdMap: Map<string, number> = new Map();
  private layerList: { featIdx: number; subId: FeatureSubMaterialId }[] = [];
  private activeCustomUploadKey: string | null = null;
  public defaultWaterBedColorTex: Texture | null = null;
  public defaultWaterBedNormalTex: Texture | null = null;
  public defaultWaterBedRoughTex: Texture | null = null;
  private lastEditedSandFeatureIdx: number = -1;
  private lastEditedWaterFeatureIdx: number = -1;
  public activeSelectedFeatureIdx: number = -1;
  public activeSelectedSubMatId: FeatureSubMaterialId = 'surface';
  private preferredGrassMatTemplate: Partial<FeatureMaterialSettings> | null = null;
  public groundMetallicLevel: number = 0.0;
  public terrainMaterial: PBRMaterial | StandardMaterial | null = null;
  private groundShaderPlugin: BunkerGrassExclusionPlugin | null = null;
  private cachedBaseCourseHeights: Float32Array | null = null;
  private cachedBaseCourseSurfaceTypes: Uint8Array | null = null;
  public isBaseCourseDirty: boolean = true;
  private cachedRoughAvgColor: { r: number; g: number; b: number } | null = null;

  public satelliteOverlayTex: Texture | null = null;
  public satellitePreviewDataUrl: string | null = null;
  public satelliteOpacity: number = 0.0;
  public satelliteEnabled: boolean = false;
  public overlayOverFeatures: number = 0.0;
  public tracedSdfTex: RawTexture | null = null;
  private tracedSdfData: Uint8Array | null = null;
  private hasAnyTracedSdf: boolean = false;
  public courseBoundaryMask: Uint8Array | null = null;
  public cellSize: number = 1;
  public gridX: number = 220;
  public gridZ: number = 460;
  public playCorridorBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
  private rawImportedBaseHeights: Float32Array | null = null;
  private rawImportedMinElev: number = 0;
  public heightmapStrength: number = 1.0;

  /**
   * Rewrites legacy/pre-Stage-1 2K/missing texture paths to the current 1K/512 PBR assets
   * so imported or saved courses never display broken image map icons in Developer Zone.
   */
  public static sanitizeTextureUrl(
    url: string | undefined,
    slot: 'color' | 'roughness' | 'normal'
  ): string | undefined {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    const lower = url.toLowerCase();
    if (
      lower.includes('grass_pbr_diff.jpg') ||
      lower.includes('grass_pbr_diff_2k') ||
      lower.includes('grass_pbr_diff_4k')
    ) {
      return '/textures/pbr_grass/grass_pbr_diff_1k.jpg';
    }
    if (
      lower.includes('grass_pbr_nor.jpg') ||
      lower.includes('grass_pbr_nor_disp') ||
      lower.includes('grass_pbr_nor_2k')
    ) {
      return '/textures/pbr_grass/grass_pbr_nor_1k.jpg';
    }
    if (
      lower.includes('grass_pbr_rough.jpg') ||
      lower.includes('grass_pbr_rough_2k') ||
      lower.includes('grass_pbr_rough_1k')
    ) {
      return '/textures/pbr_grass/grass_pbr_rough_512.jpg';
    }
    if (lower.includes('brown_mud_leaves_diff')) {
      return '/textures/pbr_rough/brown_mud_leaves_diff_512.jpg';
    }
    if (lower.includes('brown_mud_leaves_rough')) {
      return '/textures/pbr_rough/brown_mud_leaves_rough_512.jpg';
    }
    if (lower.includes('brown_mud_leaves_nor')) {
      return '/textures/pbr_rough/brown_mud_leaves_nor_512.jpg';
    }
    if (!lower.startsWith('/textures/') && !lower.startsWith('http')) {
      return slot === 'color'
        ? '/textures/pbr_grass/grass_pbr_diff_1k.jpg'
        : slot === 'roughness'
        ? '/textures/pbr_grass/grass_pbr_rough_512.jpg'
        : '/textures/pbr_grass/grass_pbr_nor_1k.jpg';
    }
    return url;
  }

  /**
   * Monotonic specular curve: 0 = 0% (pure matte black specular),
   * sliding right 0 -> 128 smoothly increases specular intensity & glossiness.
   */
  public static computeMonotonicSpecular(
    hexColor: string,
    sliderVal: number
  ): { color: Color3; power: number; scale: number } {
    const v = Math.max(0, Math.min(128, Number(sliderVal) || 0));
    if (v <= 0.001) {
      return { color: Color3.Black(), power: 1, scale: 0 };
    }
    const t = v / 128.0;
    const base = Color3.FromHexString(hexColor || '#ffffff');
    return {
      color: base.scale(t),
      power: 6 + t * 58,
      scale: t
    };
  }

  constructor(scene: Scene, width = GOLF_CONSTANTS.DEFAULT_MAP_WIDTH, length = GOLF_CONSTANTS.DEFAULT_MAP_LENGTH) {
    this.scene = scene;
    this.cellSize = 1;
    this.gridX = Math.max(2, Math.floor(width));
    this.gridZ = Math.max(2, Math.floor(length));
    this.width = this.gridX * this.cellSize;
    this.length = this.gridZ * this.cellSize;
    this.cols = this.gridX + 1;
    this.rows = this.gridZ + 1;
    this.blockCols = Math.floor(this.gridX / 2);
    this.blockRows = Math.floor(this.gridZ / 2);

    const totalVerts = this.cols * this.rows;
    this.baseHeights = new Float32Array(totalVerts);
    this.heights = new Float32Array(totalVerts);
    this.surfaceTypes = new Uint8Array(totalVerts);
    this.subdividedCells = new Uint8Array(this.width * this.length);
    this.coarseBlocks = new Uint8Array(this.blockCols * this.blockRows);

    this.positions = new Float32Array(totalVerts * 3);
    this.normals = new Float32Array(totalVerts * 3);
    this.uvs = new Float32Array(totalVerts * 2);
    this.colors = new Float32Array(totalVerts * 4);
    this.indices = new Uint32Array(this.width * this.length * 6);

    this.generateInitialNaturalTerrain();
  }

  /**
   * Lazily caches a tiny 32x32 rough grass average-color swatch once on boot (< 1ms CPU).
   * Full-res PBR turf, sand, and water bed textures are sampled directly on the GPU.
   */
  public initHighResPhotoPatterns(): Promise<void> {
    if (this.photoPatternsPromise) return this.photoPatternsPromise;
    this.photoPatternsPromise = new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth > 0) {
          const canvas = document.createElement('canvas');
          canvas.width = 32;
          canvas.height = 32;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, 32, 32);
            this.defaultRoughPhotoTile = canvas;
            if (!this.groundCustomTextureUrls.color) {
              this.roughPhotoTile = canvas;
              this.cachedRoughAvgColor = null;
            }
          }
        }
        resolve();
      };
      img.onerror = () => resolve();
      img.src = '/textures/pbr_grass/grass_pbr_diff_1k.jpg';
    });
    return this.photoPatternsPromise;
  }

  /**
   * Produces varied, organic PGA Tour 2K-style bunker silhouettes matching real championship course architecture:
   * 0: Coastal Links Multi-Lobe Hazard with deep finger indentations and organic bays
   * 1: Tri-lobed greenside bunker with deep finger bays wrapping around green collars (user favorite)
   * 2: Scalloped multi-bay fairway pinch bunker with asymmetric fingers and flared tongue
   * 3: Organic amoeba hazard with undulating bays and natural inlets
   * 4: Quad-lobed clover apron hazard with deep scalloped bays
   */
  public static getBunkerRadiusFactor(theta: number, shapeIndex: number = 0): number {
    const s = ((shapeIndex % 5) + 5) % 5;
    switch (s) {
      case 1:
        // Tri-lobed greenside bunker (distinctive organic lobes hugging green contours)
        return 0.96 - 0.20 * Math.sin(theta) + 0.22 * Math.cos(3.0 * theta) - 0.10 * Math.sin(2.0 * theta) + 0.08 * Math.cos(4.0 * theta);
      case 2:
        // Scalloped multi-bay fairway bunker with asymmetric fingers
        return 0.98 - 0.20 * Math.cos(theta) + 0.22 * Math.sin(3.0 * theta) + 0.12 * Math.cos(4.0 * theta) - 0.09 * Math.sin(2.0 * theta);
      case 3:
        // Organic amoeba hazard with undulating bays and natural inlets
        return 0.96 + 0.20 * Math.sin(3.0 * theta) * (0.85 + 0.25 * Math.cos(theta)) + 0.16 * Math.cos(4.0 * theta) - 0.10 * Math.sin(5.0 * theta);
      case 4:
        // Quad-lobed clover apron hazard with deep scalloped bays
        return 0.95 - 0.14 * Math.cos(theta) + 0.18 * Math.sin(2.0 * theta) + 0.15 * Math.cos(4.0 * theta) - 0.08 * Math.sin(3.0 * theta) + 0.06 * Math.cos(5.0 * theta);
      case 0:
      default:
        // Coastal links multi-lobe hazard with deep finger bays (no kidney/heart shape!)
        return 0.96 + 0.22 * Math.cos(3.0 * theta) - 0.14 * Math.sin(2.0 * theta) + 0.11 * Math.cos(5.0 * theta) - 0.08 * Math.sin(4.0 * theta);
    }
  }

  public static kidneyRadiusFactor(theta: number): number {
    return TerrainGrid.getBunkerRadiusFactor(theta, 0);
  }

  /**
   * Computes normalized bunker distance for a local point (localX, localZ) relative to (halfW, halfL)
   * supporting varied organic shape harmonics.
   */
  public static computeKidneyDist(
    localX: number,
    localZ: number,
    halfW: number,
    halfL: number,
    shapeIndex: number = 0
  ): { dist: number; theta: number } {
    const nx = localX / Math.max(1, halfW);
    const nz = localZ / Math.max(1, halfL);
    const rEll = Math.sqrt(nx * nx + nz * nz);
    const theta = Math.atan2(nz, nx);
    const k = TerrainGrid.getBunkerRadiusFactor(theta, shapeIndex);
    return { dist: rEll / Math.max(0.35, k), theta };
  }

  /**
   * Generates the natural topography for Hole 1 (Dogleg-Right Valley Hole):
   * - Elevated Tee Bluff around (X=95, Z=42) (~6.8m bluff + 1.3m tee pad = ~8.1m)
   * - Sweeping descent from the tee down into a small valley corridor (~2.0m-2.2m) bending right
   * - Green pocket at (X=148, Z=360) sitting slightly lower (~1.25m) than the approach fairway (~2.2m)
   */
  public generateInitialNaturalTerrain() {
    for (let z = 0; z < this.rows; z++) {
      const wz = z * this.cellSize;
      for (let x = 0; x < this.cols; x++) {
        const idx = z * this.cols + x;
        const wx = x * this.cellSize;

        let doglegCenterX = 95;
        if (wz > 60 && wz <= 210) {
          const t = (wz - 60) / 150;
          doglegCenterX = 95 + t * t * 14;
        } else if (wz > 210) {
          const t = Math.min(1.0, (wz - 210) / 160);
          doglegCenterX = 109 + (3 * t * t - 2 * t * t * t) * 41;
        }

        const distFromCorridor = Math.abs(wx - doglegCenterX);

        // 1. Elevated Tee Bluff around (95, 42)
        const dxTee = (wx - 95) / 42;
        const dzTee = (wz - 38) / 40;
        const teeBluff = 4.6 * Math.exp(-(dxTee * dxTee + dzTee * dzTee));

        // 2. Valley floor profile along Z
        const valleyDip = -0.65 * Math.exp(-Math.pow((wz - 195) / 85, 2));

        // 3. Lower Putting Green pocket around (148, 360)
        const dxGreen = (wx - 148) / 28;
        const dzGreen = (wz - 360) / 30;
        const greenPocket = -0.95 * Math.exp(-(dxGreen * dxGreen + dzGreen * dzGreen));

        // 4. Gentle framing valley hills outside the playable dogleg corridor
        const corridorMargin = Math.max(0, distFromCorridor - 26);
        const valleyWalls =
          Math.pow(corridorMargin / 46, 1.8) * 3.8 +
          Math.sin(wx * 0.04) * Math.cos(wz * 0.03) * 0.35 * Math.min(1.0, corridorMargin / 20);

        const microRoll = Math.sin(wx * 0.025 + 0.5) * Math.cos(wz * 0.022) * 0.14;

        let h = 2.2 + teeBluff + valleyDip + greenPocket + valleyWalls + microRoll;

        const edgeDistX = Math.min(wx, this.width - wx);
        const edgeDistZ = Math.min(wz, this.length - wz);
        const edgeDist = Math.min(edgeDistX, edgeDistZ);
        if (edgeDist < 18) {
          const t = edgeDist / 18;
          const smoothT = t * t * (3 - 2 * t);
          h = 2.2 * (1 - smoothT) + h * smoothT;
        }

        this.baseHeights[idx] = h;
        this.heights[idx] = h;
        this.surfaceTypes[idx] = SurfaceType.ROUGH;
      }
    }
    this.pristineNaturalHeights = new Float32Array(this.baseHeights);
  }

  /**
   * Instantly restores natural topography in < 0.1ms via cached typed array copy,
   * avoiding redundant noise/exponential evaluations when transforming course features.
   */
  public restoreNaturalTerrain() {
    if (this.pristineNaturalHeights) {
      this.baseHeights.set(this.pristineNaturalHeights);
      this.heights.set(this.pristineNaturalHeights);
    } else {
      this.generateInitialNaturalTerrain();
    }
    this.surfaceTypes.fill(SurfaceType.ROUGH);
  }

  public getPristineNaturalHeights(): Float32Array | null {
    return this.pristineNaturalHeights;
  }

  public setPristineNaturalHeights(heights: Float32Array) {
    if (!this.pristineNaturalHeights || this.pristineNaturalHeights.length !== heights.length) {
      this.pristineNaturalHeights = new Float32Array(heights);
    } else {
      this.pristineNaturalHeights.set(heights);
    }
    this.isBaseCourseDirty = true;
  }

  /**
   * Bilinear interpolation of the underlying base terrain height (excluding analytical Tee/Bunker features).
   */
  public getBaseElevation(worldX: number, worldZ: number): number {
    const clampedX = Math.max(0, Math.min(this.width - 0.0001, worldX));
    const clampedZ = Math.max(0, Math.min(this.length - 0.0001, worldZ));
    const gx = clampedX / this.cellSize;
    const gz = clampedZ / this.cellSize;

    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(this.cols - 1, x0 + 1);
    const z1 = Math.min(this.rows - 1, z0 + 1);

    const fx = gx - x0;
    const fz = gz - z0;

    const h00 = this.baseHeights[z0 * this.cols + x0];
    const h10 = this.baseHeights[z0 * this.cols + x1];
    const h01 = this.baseHeights[z1 * this.cols + x0];
    const h11 = this.baseHeights[z1 * this.cols + x1];

    return (
      (1.0 - fx) * (1.0 - fz) * h00 +
      fx * (1.0 - fz) * h10 +
      (1.0 - fx) * fz * h01 +
      fx * fz * h11
    );
  }

  /**
   * Evaluates the continuous analytical elevation at (worldX, worldZ) including smooth
   * 3D Kidney Bunker bowls/lips and Elevated Tee Box plateaus/banks.
   */
  public evaluateAnalyticalElevation(worldX: number, worldZ: number): number {
    let h = this.getBaseElevation(worldX, worldZ);

    for (const feat of this.stampedFeatures) {
      if (feat.contour && feat.contour.length >= 3) {
        const halfW = Math.max(2.0, feat.width * 0.5);
        const halfL = Math.max(2.0, feat.length * 0.5);
        const pad = 5.5;
        if (
          Math.abs(worldX - feat.centerX) > halfW + pad ||
          Math.abs(worldZ - feat.centerZ) > halfL + pad
        ) {
          continue;
        }
        const d = signedDistanceToPolygon(worldX, worldZ, feat.contour);

        if (feat.surfaceType === SurfaceType.TEE) {
          if (d < 3.2) {
            const liftHeight = Math.max(0.85, Math.min(2.2, feat.depthProfile || 1.25));
            const topY = (feat.baseElevation ?? h) + liftHeight;
            if (d <= 0.15) {
              h = topY;
            } else {
              const t = (d - 0.15) / 3.05;
              const smoothBank = 0.5 * (1.0 + Math.cos(t * Math.PI));
              h = h * (1.0 - smoothBank) + topY * smoothBank;
            }
          }
        } else if (feat.surfaceType === SurfaceType.BUNKER) {
          const fringeMat = feat.subMaterials?.['fringe'] || feat.materialSettings;
          const showCollar = fringeMat?.showCollarRings !== false && feat.materialSettings?.showCollarRings !== false;
          const lipWidth = showCollar ? Math.max(0.20, fringeMat?.collarWidth ?? feat.materialSettings?.collarWidth ?? 1.20) : 0.0;
          const blendWidth = 1.40;
          const maxReach = lipWidth + blendWidth;
          if (d < maxReach) {
            const depth = Math.max(0.45, Math.min(0.85, Math.abs(feat.depthProfile || 0.60)));
            const localGroundY = h;
            const baseElev = feat.baseElevation ?? this.getBaseElevation(feat.centerX, feat.centerZ);
            const swT = Math.max(0, Math.min(1, (d + 3.0) / (maxReach + 3.0)));
            const slopeWeight = 0.70 * (swT * swT * (3.0 - 2.0 * swT));
            const effectiveBaseY = baseElev * (1.0 - slopeWeight) + localGroundY * slopeWeight;
            const sandFloorY = effectiveBaseY - depth;
            const sandEdgeY = effectiveBaseY - depth * 0.18;

            if (d <= 0.0) {
              const depthFrac = Math.min(1.0, -d / 2.2);
              const sFloor = 0.5 * (1.0 - Math.cos(depthFrac * Math.PI));
              h = sandEdgeY * (1.0 - sFloor) + sandFloorY * sFloor;
            } else if (showCollar && lipWidth > 0.05) {
              const lipRise = Math.max(0.08, Math.min(0.14, (feat.lipHeight ?? 0.60) * 0.14));
              const lipCrestY = localGroundY + lipRise;
              if (d <= lipWidth) {
                const tLip = d / lipWidth;
                const sLip = 0.5 * (1.0 - Math.cos(tLip * Math.PI));
                h = sandEdgeY * (1.0 - sLip) + lipCrestY * sLip;
              } else {
                const tBlend = (d - lipWidth) / blendWidth;
                const sBlend = 0.5 * (1.0 + Math.cos(tBlend * Math.PI));
                h = localGroundY * (1.0 - sBlend) + lipCrestY * sBlend;
              }
            } else {
              const tBlend = d / blendWidth;
              const sBlend = 0.5 * (1.0 - Math.cos(tBlend * Math.PI));
              h = sandEdgeY * (1.0 - sBlend) + localGroundY * sBlend;
            }
          }
        } else if (feat.surfaceType === SurfaceType.WATER) {
          if (d < 2.8) {
            const rimY = (feat.baseElevation ?? h) + 0.06;
            const waterSurfaceY = (feat.baseElevation ?? h) - 0.20;
            const effDepth = Math.min(-1.6, feat.depthProfile || -2.2);
            if (d <= 0.0) {
              const basinFrac = Math.min(1.0, -d / 5.5);
              h = waterSurfaceY + effDepth * Math.sin(basinFrac * Math.PI * 0.5);
            } else if (d <= 0.75) {
              const t = d / 0.75;
              const sCurve = 0.5 * (1.0 - Math.cos(t * Math.PI));
              h = waterSurfaceY * (1.0 - sCurve) + rimY * sCurve;
            } else {
              const t = (d - 0.75) / 2.05;
              const bankBlend = 0.5 * (1.0 + Math.cos(t * Math.PI));
              h = h * (1.0 - bankBlend) + rimY * bankBlend;
            }
          }
        } else if (feat.surfaceType === SurfaceType.GREEN) {
          const conform = feat.conformDemBlend ?? 1.0;
          if (conform < 0.999 && d < 2.0) {
            const flatW = (1.0 - conform) * (d <= 0 ? 1.0 : Math.max(0, 1.0 - d / 2.0));
            const targetY = feat.baseElevation ?? h;
            h = h * (1.0 - flatW) + targetY * flatW;
          }
        }
        continue;
      }

      if (feat.surfaceType === SurfaceType.TEE) {
        const halfW = feat.width * 0.5;
        const halfL = feat.length * 0.5;
        const dx = worldX - feat.centerX;
        const dz = worldZ - feat.centerZ;
        if (Math.abs(dx) > feat.width && Math.abs(dz) > feat.length) continue;

        const cosR = Math.cos(-feat.rotationRad);
        const sinR = Math.sin(-feat.rotationRad);
        const localX = dx * cosR - dz * sinR;
        const localZ = dx * sinR + dz * cosR;
        const normDist = Math.sqrt((localX / (halfW * 0.90)) * (localX / (halfW * 0.90)) + (localZ / (halfL * 0.90)) * (localZ / (halfL * 0.90)));

        if (normDist < 1.38) {
          const liftHeight = Math.max(0.85, Math.min(2.2, feat.depthProfile || 1.25));
          const topY = (feat.baseElevation ?? h) + liftHeight;
          if (normDist <= 0.96) {
            h = topY;
          } else {
            const t = (normDist - 0.96) / 0.42;
            const smoothBank = 0.5 * (1.0 + Math.cos(t * Math.PI));
            h = h * (1.0 - smoothBank) + topY * smoothBank;
          }
        }
      } else if (feat.surfaceType === SurfaceType.BUNKER) {
        const halfW = feat.width * 0.5;
        const halfL = feat.length * 0.5;
        const dx = worldX - feat.centerX;
        const dz = worldZ - feat.centerZ;
        const fringeMat = feat.subMaterials?.['fringe'] || feat.materialSettings;
        const showCollar = fringeMat?.showCollarRings !== false && feat.materialSettings?.showCollarRings !== false;
        const lipWidth = showCollar ? Math.max(0.20, fringeMat?.collarWidth ?? feat.materialSettings?.collarWidth ?? 1.20) : 0.0;
        const maxR = Math.max(halfW, halfL) * 1.65 + lipWidth + 3.5;
        if (Math.abs(dx) > maxR || Math.abs(dz) > maxR) continue;

        const cosR = Math.cos(-feat.rotationRad);
        const sinR = Math.sin(-feat.rotationRad);
        const localX = dx * cosR - dz * sinR;
        const localZ = dx * sinR + dz * cosR;
        const shapeIdx = feat.bunkerShapeIndex ?? 0;

        // Exact metric radius and organic contour harmonic
        const theta = Math.atan2(localZ / Math.max(1, halfL), localX / Math.max(1, halfW));
        const k = TerrainGrid.getBunkerRadiusFactor(theta, shapeIdx);
        const baseRad = Math.hypot(halfW * Math.cos(theta), halfL * Math.sin(theta)) * k;
        const rMeters = Math.hypot(localX, localZ);

        // Defined revetted sod lip & blend section that blends onto the host surface
        const rSand = baseRad * 0.78;
        const rLip = rSand + lipWidth;
        const blendWidth = 1.40;
        const rBlend = rLip + blendWidth;

        if (rMeters < rBlend) {
          const depth = Math.max(0.45, Math.min(0.85, Math.abs(feat.depthProfile || 0.60)));
          const localGroundY = h;
          const baseElev = feat.baseElevation ?? this.getBaseElevation(feat.centerX, feat.centerZ);

          // Organically adapt dished sand floor to local slope using C1 cubic smoothstep (eliminates derivative kinks)
          const swT = Math.max(0, Math.min(1, rMeters / Math.max(0.001, rBlend)));
          const slopeWeight = 0.70 * (swT * swT * (3.0 - 2.0 * swT));
          const effectiveBaseY = baseElev * (1.0 - slopeWeight) + localGroundY * slopeWeight;
          const sandFloorY = effectiveBaseY - depth;
          const sandEdgeY = effectiveBaseY - depth * 0.18;

          if (rMeters <= rSand) {
            const normR = rMeters / Math.max(0.001, rSand);
            if (normR <= 0.60) {
              h = sandFloorY;
            } else {
              const tFloor = (normR - 0.60) / 0.40;
              const sFloor = 0.5 * (1.0 - Math.cos(tFloor * Math.PI));
              h = sandFloorY * (1.0 - sFloor) + sandEdgeY * sFloor;
            }
          } else if (showCollar && lipWidth > 0.05) {
            // Crisp revetted sod lip crest (8cm to 14cm) following the local ground surface
            const lipRise = Math.max(0.08, Math.min(0.14, (feat.lipHeight ?? 0.60) * 0.14));
            const lipCrestY = localGroundY + lipRise;

            if (rMeters <= rLip) {
              // Revetted lip bank rising smoothly from sand edge to lip crest
              const tLip = (rMeters - rSand) / lipWidth;
              const sLip = 0.5 * (1.0 - Math.cos(tLip * Math.PI));
              h = sandEdgeY * (1.0 - sLip) + lipCrestY * sLip;
            } else {
              // Section that smoothly blends the lip crest onto the surface it is on
              const tBlend = (rMeters - rLip) / blendWidth;
              const sBlend = 0.5 * (1.0 + Math.cos(tBlend * Math.PI));
              h = localGroundY * (1.0 - sBlend) + lipCrestY * sBlend;
            }
          } else {
            // When Collar Rings are unchecked: smooth direct bowl blend directly onto host ground surface
            // (zero artificial lip rise, zero knife-edge ridges, zero mesh triangle jaggedness)
            const tBlend = (rMeters - rSand) / blendWidth;
            const sBlend = 0.5 * (1.0 - Math.cos(tBlend * Math.PI));
            h = sandEdgeY * (1.0 - sBlend) + localGroundY * sBlend;
          }
        }
      } else if (feat.surfaceType === SurfaceType.WATER) {
        const halfW = feat.width * 0.5;
        const halfL = feat.length * 0.5;
        const dx = worldX - feat.centerX;
        const dz = worldZ - feat.centerZ;
        const maxR = Math.max(halfW, halfL) * 1.6;
        if (Math.abs(dx) > maxR || Math.abs(dz) > maxR) continue;

        const cosR = Math.cos(-feat.rotationRad);
        const sinR = Math.sin(-feat.rotationRad);
        const localX = dx * cosR - dz * sinR;
        const localZ = dx * sinR + dz * cosR;
        const normDist = Math.sqrt((localX / halfW) * (localX / halfW) + (localZ / halfL) * (localZ / halfL));

        if (normDist < 1.32) {
          const rimY = (feat.baseElevation ?? h) + 0.06;
          const waterSurfaceY = (feat.baseElevation ?? h) - 0.20;
          const effDepth = Math.min(-1.6, feat.depthProfile || -2.2);

          if (normDist <= 0.95) {
            const normR = normDist / 0.95;
            const basin = Math.cos(normR * Math.PI * 0.5);
            h = waterSurfaceY + effDepth * basin;
          } else if (normDist <= 1.03) {
            const t = (normDist - 0.95) / 0.08;
            const sCurve = 0.5 * (1.0 - Math.cos(t * Math.PI));
            h = waterSurfaceY * (1.0 - sCurve) + rimY * sCurve;
          } else {
            const t = (normDist - 1.03) / 0.29;
            const bankBlend = 0.5 * (1.0 + Math.cos(t * Math.PI));
            h = h * (1.0 - bankBlend) + rimY * bankBlend;
          }
        }
      }
    }

    return h;
  }

  /**
   * Computes vertex height for a 0.50m (2x2) subdivided cell (cx, cz) at sub-indices (iu, iv) in [0..2],
   * snapping outer boundary edges to exact linear interpolation whenever the neighbor cell is un-subdivided
   * so the entire single-mesh terrain is 100% watertight with zero T-junction holes.
   */
  private getSubCellVertexHeight(cx: number, cz: number, iu: number, iv: number): number {
    const u = iu * 0.5;
    const v = iv * 0.5;
    const wx = (cx + u) * this.cellSize;
    const wz = (cz + v) * this.cellSize;

    if (iu === 0 && (cx === 0 || this.subdividedCells[cz * this.gridX + (cx - 1)] === 0)) {
      return (1.0 - v) * this.heights[cz * this.cols + cx] + v * this.heights[(cz + 1) * this.cols + cx];
    }
    if (iu === 2 && (cx === this.gridX - 1 || this.subdividedCells[cz * this.gridX + (cx + 1)] === 0)) {
      return (1.0 - v) * this.heights[cz * this.cols + (cx + 1)] + v * this.heights[(cz + 1) * this.cols + (cx + 1)];
    }
    if (iv === 0 && (cz === 0 || this.subdividedCells[(cz - 1) * this.gridX + cx] === 0)) {
      return (1.0 - u) * this.heights[cz * this.cols + cx] + u * this.heights[cz * this.cols + (cx + 1)];
    }
    if (iv === 2 && (cz === this.gridZ - 1 || this.subdividedCells[(cz + 1) * this.gridX + cx] === 0)) {
      return (1.0 - u) * this.heights[(cz + 1) * this.cols + cx] + u * this.heights[(cz + 1) * this.cols + (cx + 1)];
    }

    return this.evaluateAnalyticalElevation(wx, wz);
  }

  /**
   * Returns the exact mathematical Y coordinate of the rendered GolfTerrain triangle at (worldX, worldZ),
   * matching 2m outer rough blocks, 1m fairway/corridor quads, and 0.50m subdivided feature slope rings 1:1.
   */
  public getElevation(worldX: number, worldZ: number): number {
    const clampedX = Math.max(0, Math.min(this.width - 0.0001, worldX));
    const clampedZ = Math.max(0, Math.min(this.length - 0.0001, worldZ));
    const gx = clampedX / this.cellSize;
    const gz = clampedZ / this.cellSize;

    const cx = Math.floor(gx);
    const cz = Math.floor(gz);

    if (this.subdividedCells[cz * this.gridX + cx] === 1) {
      const subX = (gx - cx) * 2.0;
      const subZ = (gz - cz) * 2.0;
      const iu = Math.min(1, Math.floor(subX));
      const iv = Math.min(1, Math.floor(subZ));
      const fx = subX - iu;
      const fz = subZ - iv;

      const h00 = this.getSubCellVertexHeight(cx, cz, iu, iv);
      const h10 = this.getSubCellVertexHeight(cx, cz, iu + 1, iv);
      const h01 = this.getSubCellVertexHeight(cx, cz, iu, iv + 1);
      const h11 = this.getSubCellVertexHeight(cx, cz, iu + 1, iv + 1);

      if (Math.abs(h00 - h11) < Math.abs(h10 - h01)) {
        if (fx >= fz) {
          return h00 + fx * (h10 - h00) + fz * (h11 - h10);
        } else {
          return h00 + fx * (h11 - h01) + fz * (h01 - h00);
        }
      } else {
        if (fx + fz <= 1.0) {
          return h00 + fx * (h10 - h00) + fz * (h01 - h00);
        } else {
          return h11 + (1.0 - fx) * (h01 - h11) + (1.0 - fz) * (h10 - h11);
        }
      }
    }

    const bx = cx >> 1;
    const bz = cz >> 1;
    if (bx < this.blockCols && bz < this.blockRows && this.coarseBlocks[bz * this.blockCols + bx] === 1) {
      const x0 = bx * 2;
      const z0 = bz * 2;
      const h00 = this.heights[z0 * this.cols + x0];
      const h20 = this.heights[z0 * this.cols + (x0 + 2)];
      const h02 = this.heights[(z0 + 2) * this.cols + x0];
      const h22 = this.heights[(z0 + 2) * this.cols + (x0 + 2)];

      const cW = bx > 0 && this.coarseBlocks[bz * this.blockCols + (bx - 1)] === 1;
      const cE = bx < this.blockCols - 1 && this.coarseBlocks[bz * this.blockCols + (bx + 1)] === 1;
      const cS = bz > 0 && this.coarseBlocks[(bz - 1) * this.blockCols + bx] === 1;
      const cN = bz < this.blockRows - 1 && this.coarseBlocks[(bz + 1) * this.blockCols + bx] === 1;

      if (cW && cE && cS && cN) {
        const fx = (gx - x0) * 0.5;
        const fz = (gz - z0) * 0.5;
        if (Math.abs(h00 - h22) < Math.abs(h20 - h02)) {
          return fx >= fz
            ? h00 + fx * (h20 - h00) + fz * (h22 - h20)
            : h00 + fx * (h22 - h02) + fz * (h02 - h00);
        } else {
          return fx + fz <= 1.0
            ? h00 + fx * (h20 - h00) + fz * (h02 - h00)
            : h22 + (1.0 - fx) * (h02 - h22) + (1.0 - fz) * (h20 - h22);
        }
      }

      const hCtr = this.heights[(z0 + 1) * this.cols + (x0 + 1)];
      const dx = gx - (x0 + 1);
      const dz = gz - (z0 + 1);
      const adx = Math.abs(dx);
      const adz = Math.abs(dz);
      const u = Math.max(adx, adz);
      if (u < 1e-6) return hCtr;

      let hEdge = hCtr;
      if (dx <= -adz) {
        const t = (dz / u + 1.0) * 0.5;
        if (cW) hEdge = h00 * (1.0 - t) + h02 * t;
        else {
          const hMid = this.heights[(z0 + 1) * this.cols + x0];
          hEdge = t <= 0.5 ? h00 + (t * 2.0) * (hMid - h00) : hMid + ((t - 0.5) * 2.0) * (h02 - hMid);
        }
      } else if (dx >= adz) {
        const t = (dz / u + 1.0) * 0.5;
        if (cE) hEdge = h20 * (1.0 - t) + h22 * t;
        else {
          const hMid = this.heights[(z0 + 1) * this.cols + (x0 + 2)];
          hEdge = t <= 0.5 ? h20 + (t * 2.0) * (hMid - h20) : hMid + ((t - 0.5) * 2.0) * (h22 - hMid);
        }
      } else if (dz <= -adx) {
        const t = (dx / u + 1.0) * 0.5;
        if (cS) hEdge = h00 * (1.0 - t) + h20 * t;
        else {
          const hMid = this.heights[z0 * this.cols + (x0 + 1)];
          hEdge = t <= 0.5 ? h00 + (t * 2.0) * (hMid - h00) : hMid + ((t - 0.5) * 2.0) * (h20 - hMid);
        }
      } else {
        const t = (dx / u + 1.0) * 0.5;
        if (cN) hEdge = h02 * (1.0 - t) + h22 * t;
        else {
          const hMid = this.heights[(z0 + 2) * this.cols + (x0 + 1)];
          hEdge = t <= 0.5 ? h02 + (t * 2.0) * (hMid - h02) : hMid + ((t - 0.5) * 2.0) * (h22 - hMid);
        }
      }
      return hCtr + u * (hEdge - hCtr);
    }

    const x0 = cx;
    const z0 = cz;
    const x1 = Math.min(this.cols - 1, x0 + 1);
    const z1 = Math.min(this.rows - 1, z0 + 1);

    const fx = gx - x0;
    const fz = gz - z0;

    const h00 = this.heights[z0 * this.cols + x0];
    const h10 = this.heights[z0 * this.cols + x1];
    const h01 = this.heights[z1 * this.cols + x0];
    const h11 = this.heights[z1 * this.cols + x1];

    if (fx + fz <= 1.0) {
      return h00 + fx * (h10 - h00) + fz * (h01 - h00);
    } else {
      return h11 + (1.0 - fx) * (h01 - h11) + (1.0 - fz) * (h10 - h11);
    }
  }

  public getSurfaceAt(worldX: number, worldZ: number): SurfaceType {
    // Check traced MapNG polygon features first in composite golf priority order
    const priorityOrder: SurfaceType[] = [
      SurfaceType.BUNKER,
      SurfaceType.WATER,
      SurfaceType.GREEN,
      SurfaceType.TEE,
      SurfaceType.FAIRWAY
    ];
    for (const targetType of priorityOrder) {
      for (let i = this.stampedFeatures.length - 1; i >= 0; i--) {
        const feat = this.stampedFeatures[i];
        if (feat.surfaceType !== targetType || !feat.contour || feat.contour.length < 3) continue;
        if (
          Math.abs(worldX - feat.centerX) <= feat.width * 0.5 + 1.0 &&
          Math.abs(worldZ - feat.centerZ) <= feat.length * 0.5 + 1.0 &&
          pointInPolygon(worldX, worldZ, feat.contour)
        ) {
          return targetType;
        }
      }
    }

    const cx = Math.max(0, Math.min(this.cols - 1, Math.round(worldX / this.cellSize)));
    const cz = Math.max(0, Math.min(this.rows - 1, Math.round(worldZ / this.cellSize)));
    return this.surfaceTypes[cz * this.cols + cx] as SurfaceType;
  }

  public getNormal(worldX: number, worldZ: number): Vector3D {
    const eps = 0.22;
    const hL = this.getElevation(worldX - eps, worldZ);
    const hR = this.getElevation(worldX + eps, worldZ);
    const hD = this.getElevation(worldX, worldZ - eps);
    const hU = this.getElevation(worldX, worldZ + eps);

    const nx = (hL - hR) / (2 * eps);
    const ny = 1.0;
    const nz = (hD - hU) / (2 * eps);

    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  public applySculptBrush(
    centerX: number,
    centerZ: number,
    radius: number,
    strength: number,
    mode: 'raise' | 'lower' | 'flatten' | 'smooth' | 'paint',
    targetSurface: SurfaceType = SurfaceType.FAIRWAY,
    targetFlattenHeight?: number
  ) {
    if (radius <= 0.01 || strength <= 0.001) return;
    const minX = Math.max(0, Math.floor((centerX - radius) / this.cellSize));
    const maxX = Math.min(this.cols - 1, Math.ceil((centerX + radius) / this.cellSize));
    const minZ = Math.max(0, Math.floor((centerZ - radius) / this.cellSize));
    const maxZ = Math.min(this.rows - 1, Math.ceil((centerZ + radius) / this.cellSize));

    const flattenHeight = targetFlattenHeight ?? this.getBaseElevation(centerX, centerZ);

    for (let z = minZ; z <= maxZ; z++) {
      const wz = z * this.cellSize;
      for (let x = minX; x <= maxX; x++) {
        const wx = x * this.cellSize;
        const dx = wx - centerX;
        const dz = wz - centerZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > radius) continue;

        const falloff = 0.5 * (1.0 + Math.cos((dist / radius) * Math.PI));
        const idx = z * this.cols + x;

        switch (mode) {
          case 'raise':
            this.baseHeights[idx] += strength * falloff;
            break;
          case 'lower':
            this.baseHeights[idx] = Math.max(-4.5, this.baseHeights[idx] - strength * falloff);
            break;
          case 'flatten':
            this.baseHeights[idx] = this.baseHeights[idx] * (1 - falloff * strength) + flattenHeight * (falloff * strength);
            break;
          case 'smooth': {
            const nL = x > 0 ? this.baseHeights[idx - 1] : this.baseHeights[idx];
            const nR = x < this.cols - 1 ? this.baseHeights[idx + 1] : this.baseHeights[idx];
            const nD = z > 0 ? this.baseHeights[idx - this.cols] : this.baseHeights[idx];
            const nU = z < this.rows - 1 ? this.baseHeights[idx + this.cols] : this.baseHeights[idx];
            const avg = (nL + nR + nD + nU) * 0.25;
            this.baseHeights[idx] = this.baseHeights[idx] * (1 - falloff * strength) + avg * (falloff * strength);
            break;
          }
          case 'paint':
            if (falloff > 0.25) {
              this.surfaceTypes[idx] = targetSurface;
            }
            break;
        }

        // Persist sculpting into pristine base topography so undo/redo and feature re-stamping never wipes manual sculpts!
        if (this.pristineNaturalHeights && mode !== 'paint') {
          this.pristineNaturalHeights[idx] = this.baseHeights[idx];
        }
      }
    }

    this.isBaseCourseDirty = true;
    this.dragStaticFeatureIdx = -1;

    // Next-Gen Fast Sculpting: patch ONLY the affected brush vertices & normals in-place on GPU (<1ms, 60fps!)
    // Falls back to full rebuildMesh() only for surface painting or when sculpting directly over 0.5m subdivided lips.
    const baseVerts = this.rows * this.cols;
    let canPatchInPlace =
      mode !== 'paint' &&
      this.terrainMesh !== null &&
      this.positions.length >= baseVerts * 3 &&
      this.normals.length >= baseVerts * 3;

    if (canPatchInPlace) {
      const cMinX = Math.max(0, minX - 1);
      const cMaxX = Math.min(this.gridX - 1, maxX);
      const cMinZ = Math.max(0, minZ - 1);
      const cMaxZ = Math.min(this.gridZ - 1, maxZ);
      outerSubCheck: for (let cz = cMinZ; cz <= cMaxZ; cz++) {
        const rowOff = cz * this.gridX;
        for (let cx = cMinX; cx <= cMaxX; cx++) {
          if (this.subdividedCells[rowOff + cx] === 1) {
            canPatchInPlace = false;
            break outerSubCheck;
          }
        }
      }
    }

    if (canPatchInPlace && this.terrainMesh) {
      const cols = this.cols;
      const rows = this.rows;
      const hasFeatures = this.stampedFeatures.length > 0;

      // 1. Update heights & Y positions ONLY inside the brush bounding box
      for (let z = minZ; z <= maxZ; z++) {
        const wz = z * this.cellSize;
        const rowOff = z * cols;
        for (let x = minX; x <= maxX; x++) {
          const idx = rowOff + x;
          const h = hasFeatures
            ? this.evaluateAnalyticalElevation(x * this.cellSize, wz)
            : this.baseHeights[idx];
          this.heights[idx] = h;
          this.positions[idx * 3 + 1] = h;
        }
      }

      // 2. Recompute smooth vertex normals ONLY for the brush box + 1-ring border
      const nMinX = Math.max(0, minX - 1);
      const nMaxX = Math.min(cols - 1, maxX + 1);
      const nMinZ = Math.max(0, minZ - 1);
      const nMaxZ = Math.min(rows - 1, maxZ + 1);
      const baseInvSpan = 1 / (2 * this.cellSize);

      for (let z = nMinZ; z <= nMaxZ; z++) {
        const rowOff = z * cols;
        for (let x = nMinX; x <= nMaxX; x++) {
          const vIdx = rowOff + x;
          const pIdx = vIdx * 3;
          const hC = this.heights[vIdx];
          const hL = x > 0 ? this.heights[vIdx - 1] : hC;
          const hR = x < cols - 1 ? this.heights[vIdx + 1] : hC;
          const hD = z > 0 ? this.heights[vIdx - cols] : hC;
          const hU = z < rows - 1 ? this.heights[vIdx + cols] : hC;

          const nx = (hL - hR) * baseInvSpan;
          const ny = 1.0;
          const nz = (hD - hU) * baseInvSpan;
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;

          this.normals[pIdx] = nx / len;
          this.normals[pIdx + 1] = ny / len;
          this.normals[pIdx + 2] = nz / len;
        }
      }

      // 3. Stream updated positions & normals straight to the existing GPU buffers (zero allocations!)
      this.terrainMesh.updateVerticesData(VertexBuffer.PositionKind, this.positions, false, false);
      this.terrainMesh.updateVerticesData(VertexBuffer.NormalKind, this.normals, false, false);
      return;
    }

    this.rebuildMesh();
  }

  /**
   * Evaluates a smooth 4-point cubic Bezier spine with organic AAA fairway width modulation
   * and smooth parabolic rounded ends (zero circular stamp cutouts).
   */
  private evaluateSpline(points: DoglegWaypoint[], t: number): {
    x: number;
    z: number;
    leftW: number;
    rightW: number;
    tx: number;
    tz: number;
  } {
    const p0 = points[0];
    const p1 = points[1];
    const p2 = points[2];
    const p3 = points[3];

    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;

    const x = b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x;
    const z = b0 * p0.z + b1 * p1.z + b2 * p2.z + b3 * p3.z;
    const baseWidth = b0 * p0.width + b1 * p1.width + b2 * p2.width + b3 * p3.width;

    // Authentic AAA PGA-style organic fairway contour (drive landing swell, dogleg pinch, approach bay)
    // Full width maintained at ends so 180-deg rounded caps produce 100% uniform fringe collars without pinching
    const driveSwell = 0.16 * Math.exp(-Math.pow((t - 0.34) / 0.16, 2));
    const doglegPinchRight = -0.18 * Math.exp(-Math.pow((t - 0.46) / 0.11, 2));
    const outerElbowSwellLeft = 0.14 * Math.exp(-Math.pow((t - 0.58) / 0.15, 2));
    const waterPinchRight = -0.16 * Math.exp(-Math.pow((t - 0.76) / 0.12, 2));
    const approachLobe = 0.10 * Math.exp(-Math.pow((t - 0.84) / 0.10, 2));

    const leftMod = 1.0 + driveSwell + outerElbowSwellLeft + 0.04 * Math.sin(t * Math.PI * 3.0);
    const rightMod = 1.0 + driveSwell + doglegPinchRight + waterPinchRight + approachLobe;

    const leftW = baseWidth * 0.5 * leftMod;
    const rightW = baseWidth * 0.5 * rightMod;

    const d0 = -3 * u * u;
    const d1 = 3 * u * u - 6 * u * t;
    const d2 = 6 * u * t - 3 * t * t;
    const d3 = 3 * t * t;
    let tx = d0 * p0.x + d1 * p1.x + d2 * p2.x + d3 * p3.x;
    let tz = d0 * p0.z + d1 * p1.z + d2 * p2.z + d3 * p3.z;
    const len = Math.sqrt(tx * tx + tz * tz) || 1;
    tx /= len;
    tz /= len;

    return { x, z, leftW, rightW, tx, tz };
  }

  /**
   * Stamps a continuous, organic AAA Dogleg Fairway shape along a 4-point cubic Bezier spline.
   */
  public stampDoglegFairway(
    points: DoglegWaypoint[],
    autoRebuild: boolean = true,
    featureId: string = 'fairway_main',
    featureName: string = 'Championship Dogleg Fairway'
  ) {
    if (points.length < 4) return;

    const samples = 90;
    const spine = [];
    for (let i = 0; i <= samples; i++) {
      spine.push(this.evaluateSpline(points, i / samples));
    }

    // Bounded search window: only rasterize cells within fairway bounding box + safety margin (38m)
    const minX = Math.max(0, Math.floor((Math.min(...points.map(p => p.x)) - 38) / this.cellSize));
    const maxX = Math.min(this.cols - 1, Math.ceil((Math.max(...points.map(p => p.x)) + 38) / this.cellSize));
    const minZ = Math.max(0, Math.floor((Math.min(...points.map(p => p.z)) - 38) / this.cellSize));
    const maxZ = Math.min(this.rows - 1, Math.ceil((Math.max(...points.map(p => p.z)) + 38) / this.cellSize));

    for (let z = minZ; z <= maxZ; z++) {
      const wz = z * this.cellSize;
      for (let x = minX; x <= maxX; x++) {
        const wx = x * this.cellSize;
        let minNormDist = 999;

        for (let i = 2; i < samples - 1; i++) {
          const sp = spine[i];
          const dx = wx - sp.x;
          const dz = wz - sp.z;
          const lat = dx * (-sp.tz) + dz * sp.tx;
          const lon = dx * sp.tx + dz * sp.tz;
          const halfW = Math.max(1.5, lat >= 0 ? sp.leftW : sp.rightW);
          const d = Math.sqrt((lat / halfW) * (lat / halfW) + (lon / (halfW * 1.2)) * (lon / (halfW * 1.2)));
          if (d < minNormDist) minNormDist = d;
        }

        const idx = z * this.cols + x;
        if (minNormDist <= 1.0) {
          if (this.surfaceTypes[idx] !== SurfaceType.BUNKER && this.surfaceTypes[idx] !== SurfaceType.WATER) {
            this.surfaceTypes[idx] = SurfaceType.FAIRWAY;
          }
        } else if (minNormDist <= 1.18 && this.surfaceTypes[idx] === SurfaceType.ROUGH) {
          this.surfaceTypes[idx] = SurfaceType.FIRST_CUT;
        }
      }
    }

    const midX = points.reduce((acc, p) => acc + p.x, 0) / points.length;
    const midZ = points.reduce((acc, p) => acc + p.z, 0) / points.length;

    this.stampedFeatures.push({
      id: featureId,
      name: featureName,
      centerX: midX,
      centerZ: midZ,
      width: points[1].width,
      length: Math.abs(points[points.length - 1].z - points[0].z),
      rotationRad: 0,
      surfaceType: SurfaceType.FAIRWAY,
      depthProfile: 0,
      lipHeight: 0,
      doglegPoints: points
    });

    if (autoRebuild) {
      this.redrawSplatTexture();
      this.rebuildMesh();
    }
  }

  public stampFeature(
    centerX: number,
    centerZ: number,
    width: number,
    length: number,
    rotationRad: number,
    surfaceType: SurfaceType,
    depthProfile: number = 0,
    lipHeight: number = 0,
    baseElevation?: number,
    bunkerShapeIndex?: number,
    autoRebuild: boolean = true,
    presetId?: string
  ) {
    if (surfaceType === SurfaceType.FAIRWAY) {
      const halfL = length * 0.5;
      const cosR = Math.cos(rotationRad);
      const sinR = Math.sin(rotationRad);
      const makePt = (zOff: number, xCurve: number, wScale: number): DoglegWaypoint => ({
        x: centerX + xCurve * cosR + zOff * sinR,
        z: centerZ - xCurve * sinR + zOff * cosR,
        width: width * wScale
      });

      let waypoints: DoglegWaypoint[];
      let fName = 'Dogleg-Right Fairway';
      if (presetId === 'fairway_dogleg_left') {
        waypoints = [
          makePt(-halfL, 0, 0.78),
          makePt(-halfL * 0.3, -width * 0.16, 1.05),
          makePt(halfL * 0.35, -width * 0.26, 0.96),
          makePt(halfL, -width * 0.22, 0.82)
        ];
        fName = 'Dogleg-Left Fairway';
      } else if (presetId === 'fairway_landing_straight') {
        waypoints = [
          makePt(-halfL, 0, 0.78),
          makePt(-halfL * 0.3, 0, 1.05),
          makePt(halfL * 0.35, 0, 1.02),
          makePt(halfL, 0, 0.82)
        ];
        fName = 'Championship Straight Fairway';
      } else {
        waypoints = [
          makePt(-halfL, 0, 0.78),
          makePt(-halfL * 0.3, width * 0.16, 1.05),
          makePt(halfL * 0.35, width * 0.26, 0.96),
          makePt(halfL, width * 0.22, 0.82)
        ];
      }

      this.stampDoglegFairway(waypoints, autoRebuild, presetId || 'fairway_dogleg_right', fName);
      return;
    }

    const effWidth = surfaceType === SurfaceType.BUNKER ? Math.max(12, width) : width;
    const effLength = surfaceType === SurfaceType.BUNKER ? Math.max(16, length) : length;
    const effBunkerShape = bunkerShapeIndex !== undefined ? bunkerShapeIndex : 0;

    const halfW = effWidth * 0.5;
    const halfL = effLength * 0.5;
    const maxDim = Math.max(effWidth, effLength) * 1.1;

    const minX = Math.max(0, Math.floor((centerX - maxDim) / this.cellSize));
    const maxX = Math.min(this.cols - 1, Math.ceil((centerX + maxDim) / this.cellSize));
    const minZ = Math.max(0, Math.floor((centerZ - maxDim) / this.cellSize));
    const maxZ = Math.min(this.rows - 1, Math.ceil((centerZ + maxDim) / this.cellSize));

    const cosR = Math.cos(-rotationRad);
    const sinR = Math.sin(-rotationRad);

    const effBaseElevation = baseElevation ?? this.getBaseElevation(centerX, centerZ);

    for (let z = minZ; z <= maxZ; z++) {
      const wz = z * this.cellSize;
      for (let x = minX; x <= maxX; x++) {
        const wx = x * this.cellSize;
        const dx = wx - centerX;
        const dz = wz - centerZ;

        const localX = dx * cosR - dz * sinR;
        const localZ = dx * sinR + dz * cosR;

        const idx = z * this.cols + x;

        if (surfaceType === SurfaceType.BUNKER) {
          const theta = Math.atan2(localZ / Math.max(1, halfL), localX / Math.max(1, halfW));
          const k = TerrainGrid.getBunkerRadiusFactor(theta, effBunkerShape);
          const baseRad = Math.hypot(halfW * Math.cos(theta), halfL * Math.sin(theta)) * k;
          const rMeters = Math.hypot(localX, localZ);
          const rSand = baseRad * 0.78;
          const lipWidth = 1.20;

          if (rMeters <= rSand) {
            this.surfaceTypes[idx] = SurfaceType.BUNKER;
          } else if (rMeters <= rSand + lipWidth && this.surfaceTypes[idx] !== SurfaceType.BUNKER && this.surfaceTypes[idx] !== SurfaceType.WATER && this.surfaceTypes[idx] !== SurfaceType.GREEN && this.surfaceTypes[idx] !== SurfaceType.FAIRWAY) {
            this.surfaceTypes[idx] = SurfaceType.FRINGE;
          }
          continue;
        }

        const normDist = Math.sqrt(Math.pow(localX / halfW, 2) + Math.pow(localZ / halfL, 2));
        // Approximate perpendicular distance in meters from the (halfW, halfL) boundary
        const ang = Math.atan2(localZ / halfL, localX / halfW);
        const radAtAng = Math.sqrt(Math.pow(halfW * Math.cos(ang), 2) + Math.pow(halfL * Math.sin(ang), 2));
        const distFromEdgeMeters = (normDist - 1.0) * radAtAng;

        if (distFromEdgeMeters <= 4.8) {
          if (surfaceType === SurfaceType.GREEN) {
            if (normDist <= 1.0) {
              const blend = Math.cos(normDist * Math.PI * 0.5);
              const readableSlope = (localX / halfW) * 0.26 + (localZ / halfL) * 0.22;
              const targetGreenY = effBaseElevation + readableSlope;
              this.baseHeights[idx] = this.baseHeights[idx] * (1 - blend) + targetGreenY * blend;
              this.surfaceTypes[idx] = SurfaceType.GREEN;
            } else if (distFromEdgeMeters <= 2.2 && this.surfaceTypes[idx] !== SurfaceType.BUNKER && this.surfaceTypes[idx] !== SurfaceType.WATER && this.surfaceTypes[idx] !== SurfaceType.FAIRWAY) {
              this.surfaceTypes[idx] = SurfaceType.FRINGE;
            } else if (distFromEdgeMeters <= 4.2 && this.surfaceTypes[idx] === SurfaceType.ROUGH) {
              this.surfaceTypes[idx] = SurfaceType.FIRST_CUT;
            }
          } else if (surfaceType === SurfaceType.FRINGE) {
            if (normDist <= 1.0 && this.surfaceTypes[idx] !== SurfaceType.BUNKER) {
              this.surfaceTypes[idx] = SurfaceType.FRINGE;
            }
          } else if (surfaceType === SurfaceType.FIRST_CUT) {
            if (normDist <= 1.0 && this.surfaceTypes[idx] !== SurfaceType.BUNKER) {
              this.surfaceTypes[idx] = SurfaceType.FIRST_CUT;
            }
          } else if (surfaceType === SurfaceType.TEE) {
            const teeEdgeMeters = (normDist - 0.90) * radAtAng;
            if (normDist <= 0.90) {
              this.surfaceTypes[idx] = SurfaceType.TEE;
            } else if (teeEdgeMeters <= 0.55 && this.surfaceTypes[idx] === SurfaceType.ROUGH) {
              this.surfaceTypes[idx] = SurfaceType.FRINGE;
            }
          } else if (surfaceType === SurfaceType.WATER) {
            const waterEdgeMeters = (normDist - 0.95) * radAtAng;
            if (normDist <= 0.95) {
              this.surfaceTypes[idx] = SurfaceType.WATER;
            } else if (waterEdgeMeters <= 2.20 && this.surfaceTypes[idx] === SurfaceType.ROUGH) {
              this.surfaceTypes[idx] = SurfaceType.FRINGE;
            }
          } else {
            if (normDist <= 1.0) {
              this.surfaceTypes[idx] = surfaceType;
            }
          }
        }
      }
    }

    const featureCount = this.stampedFeatures.filter(f => f.surfaceType === surfaceType).length + 1;
    const defaultName = surfaceType === SurfaceType.GREEN ? 'Championship Green' :
                        surfaceType === SurfaceType.TEE ? 'Championship Tee Box' :
                        surfaceType === SurfaceType.BUNKER ? `Bunker #${featureCount} (Shape ${effBunkerShape})` :
                        surfaceType === SurfaceType.WATER ? `Water Hazard Pond #${featureCount}` : `${surfaceType} #${featureCount}`;

    this.stampedFeatures.push({
      id: `feat_${String(surfaceType)}_${Math.round(centerX)}_${Math.round(centerZ)}`,
      name: defaultName,
      centerX,
      centerZ,
      width: effWidth,
      length: effLength,
      rotationRad,
      surfaceType,
      depthProfile,
      lipHeight,
      baseElevation: effBaseElevation,
      isKidney: surfaceType === SurfaceType.BUNKER,
      bunkerShapeIndex: surfaceType === SurfaceType.BUNKER ? effBunkerShape : undefined
    });

    if (autoRebuild) {
      this.redrawSplatTexture();
      this.rebuildMesh();
    }
  }

  /**
   * Toggles lightweight draft subdivision mode during real-time feature sliding/rotating.
   * Keeps TerrainMaterial bumpTexture intact so shader defines and sand normal shading stay 100% identical before, during, and after moves.
   */
  public setDraftTransformMode(draft: boolean) {
    this.isDraftMode = draft;
  }

  /**
   * Synchronizes active course bunkers, putting greens, and water hazards to the GPU fragment shader uniform arrays.
   * Enables continuous analytical Signed Distance Field (SDF) evaluation with infinite
   * mathematical resolution and instantaneous transformations.
   */
  public syncAnalyticalFeatureUniforms() {
    if (!this.groundShaderPlugin) return;
    if (this.layerIdMap.size === 0 && this.stampedFeatures.length > 0) {
      this.rebuildLayerRegistry();
      this.syncLayerPropsLut();
    }

    const plugin = this.groundShaderPlugin;
    plugin.terrainWidth = this.width;
    plugin.terrainLength = this.length;

    // 1. Pack up to 16 Bunkers
    const bData = plugin.bunkersArray;
    const bRot = plugin.bunkerRotShapeArray;
    const bPar = plugin.bunkerParamsArray;
    bData.fill(0);
    bRot.fill(0);
    bPar.fill(0);

    let bunkerCount = 0;
    let greenCount = 0;
    let waterCount = 0;
    let teeCount = 0;

    // 2. Pack up to 4 Putting Greens
    const gData = plugin.greensArray;
    const gRotCollar = plugin.greenRotCollarArray;
    const gIds = plugin.greenIdsArray;
    const gStripes = plugin.greenStripesArray;
    gData.fill(0);
    gRotCollar.fill(0);
    gIds.fill(0);
    gStripes.fill(0);

    // 3. Pack up to 4 Water Hazards
    const wData = plugin.watersArray;
    const wRotCollar = plugin.waterRotCollarArray;
    const wIds = plugin.waterIdsArray;
    wData.fill(0);
    wRotCollar.fill(0);
    wIds.fill(0);

    // 4. Pack up to 4 Tee Boxes
    const tData = plugin.teesArray;
    const tRotCollar = plugin.teeRotCollarArray;
    const tIds = plugin.teeIdsArray;
    const tStripes = plugin.teeStripesArray;
    tData.fill(0);
    tRotCollar.fill(0);
    tIds.fill(0);
    tStripes.fill(0);

    for (let featIdx = 0; featIdx < this.stampedFeatures.length; featIdx++) {
      const feat = this.stampedFeatures[featIdx];
      if (feat.contour && feat.contour.length >= 3) {
        // Traced arbitrary polygon features render via GPU SDF atlas / polygon layer instead of parametric ellipses
        continue;
      }
      if (feat.surfaceType === SurfaceType.BUNKER && bunkerCount < 16) {
        const halfW = feat.width * 0.5;
        const halfL = feat.length * 0.5;
        const surfMat = this.getFeatureSubMaterialSettings(featIdx, 'surface');
        const fringeMat = this.getFeatureSubMaterialSettings(featIdx, 'fringe');
        const surfId = this.getOrRegisterLayerId(featIdx, 'surface');
        const fringeId = this.getOrRegisterLayerId(featIdx, 'fringe');
        const showCollar = fringeMat.showCollarRings !== false && surfMat.showCollarRings !== false;
        const collarWidth = fringeMat.collarWidth ?? surfMat.collarWidth ?? 1.20;
        const sandFeatherHalf = showCollar ? 0.24 : 0.38;

        const i4 = bunkerCount * 4;
        bData[i4 + 0] = feat.centerX;
        bData[i4 + 1] = feat.centerZ;
        bData[i4 + 2] = halfW;
        bData[i4 + 3] = halfL;

        bRot[i4 + 0] = Math.cos(-feat.rotationRad);
        bRot[i4 + 1] = Math.sin(-feat.rotationRad);
        bRot[i4 + 2] = feat.bunkerShapeIndex ?? 0;
        bRot[i4 + 3] = showCollar ? 1.0 : 0.0;

        bPar[i4 + 0] = collarWidth;
        bPar[i4 + 1] = sandFeatherHalf;
        bPar[i4 + 2] = surfId;
        bPar[i4 + 3] = fringeId;
        bunkerCount++;
      } else if (feat.surfaceType === SurfaceType.GREEN && greenCount < 4) {
        const halfW = feat.width * 0.5;
        const halfL = feat.length * 0.5;
        const surfMat = this.getFeatureSubMaterialSettings(featIdx, 'surface');
        const fringeMat = this.getFeatureSubMaterialSettings(featIdx, 'fringe');
        const surfId = this.getOrRegisterLayerId(featIdx, 'surface');
        const fringeId = this.getOrRegisterLayerId(featIdx, 'fringe');
        const firstCutId = this.getOrRegisterLayerId(featIdx, 'first_cut');
        const showCollar = fringeMat.showCollarRings !== false && surfMat.showCollarRings !== false;
        const fringeWidth = fringeMat.collarWidth ?? surfMat.collarWidth ?? 2.2;

        const g4 = greenCount * 4;
        gData[g4 + 0] = feat.centerX;
        gData[g4 + 1] = feat.centerZ;
        gData[g4 + 2] = halfW;
        gData[g4 + 3] = halfL;

        gRotCollar[g4 + 0] = Math.cos(-feat.rotationRad);
        gRotCollar[g4 + 1] = Math.sin(-feat.rotationRad);
        gRotCollar[g4 + 2] = showCollar ? 1.0 : 0.0;
        gRotCollar[g4 + 3] = fringeWidth;

        gIds[g4 + 0] = surfId;
        gIds[g4 + 1] = fringeId;
        gIds[g4 + 2] = firstCutId;
        gIds[g4 + 3] = 0.0;

        gStripes[g4 + 0] = surfMat.showMowingStripes !== false ? 1.0 : 0.0;
        gStripes[g4 + 1] = surfMat.mowingStripeWidth ?? 1.8;
        gStripes[g4 + 2] = surfMat.mowingStripeContrast !== undefined ? surfMat.mowingStripeContrast : 0.5;
        gStripes[g4 + 3] = 0.0;
        greenCount++;
      } else if (feat.surfaceType === SurfaceType.WATER && waterCount < 4) {
        const halfW = feat.width * 0.5;
        const halfL = feat.length * 0.5;
        const surfMat = this.getFeatureSubMaterialSettings(featIdx, 'surface');
        const fringeMat = this.getFeatureSubMaterialSettings(featIdx, 'fringe');
        const surfId = this.getOrRegisterLayerId(featIdx, 'surface');
        const fringeId = this.getOrRegisterLayerId(featIdx, 'fringe');
        const showCollar = surfMat.showCollarRings !== false && fringeMat.showCollarRings !== false;
        const collarWidth = surfMat.collarWidth ?? fringeMat.collarWidth ?? 2.15;

        const w4 = waterCount * 4;
        wData[w4 + 0] = feat.centerX;
        wData[w4 + 1] = feat.centerZ;
        wData[w4 + 2] = halfW * 0.95;
        wData[w4 + 3] = halfL * 0.95;

        wRotCollar[w4 + 0] = Math.cos(-feat.rotationRad);
        wRotCollar[w4 + 1] = Math.sin(-feat.rotationRad);
        wRotCollar[w4 + 2] = showCollar ? 1.0 : 0.0;
        wRotCollar[w4 + 3] = collarWidth;

        wIds[w4 + 0] = surfId;
        wIds[w4 + 1] = fringeId;
        wIds[w4 + 2] = 0.0;
        wIds[w4 + 3] = 0.0;
        waterCount++;
      } else if (feat.surfaceType === SurfaceType.TEE && teeCount < 4) {
        const halfW = feat.width * 0.5;
        const halfL = feat.length * 0.5;
        const surfMat = this.getFeatureSubMaterialSettings(featIdx, 'surface');
        const fringeMat = this.getFeatureSubMaterialSettings(featIdx, 'fringe');
        const surfId = this.getOrRegisterLayerId(featIdx, 'surface');
        const fringeId = this.getOrRegisterLayerId(featIdx, 'fringe');
        const showCollar = fringeMat.showCollarRings !== false && surfMat.showCollarRings !== false;
        const collarWidth = fringeMat.collarWidth ?? surfMat.collarWidth ?? 0.50;

        const t4 = teeCount * 4;
        tData[t4 + 0] = feat.centerX;
        tData[t4 + 1] = feat.centerZ;
        tData[t4 + 2] = halfW * 0.90;
        tData[t4 + 3] = halfL * 0.90;

        tRotCollar[t4 + 0] = Math.cos(-feat.rotationRad);
        tRotCollar[t4 + 1] = Math.sin(-feat.rotationRad);
        tRotCollar[t4 + 2] = showCollar ? 1.0 : 0.0;
        tRotCollar[t4 + 3] = collarWidth;

        tIds[t4 + 0] = surfId;
        tIds[t4 + 1] = fringeId;
        tIds[t4 + 2] = 0.0;
        tIds[t4 + 3] = 0.0;

        tStripes[t4 + 0] = surfMat.showMowingStripes !== false ? 1.0 : 0.0;
        tStripes[t4 + 1] = surfMat.mowingStripeWidth ?? 1.6;
        tStripes[t4 + 2] = surfMat.mowingStripeContrast !== undefined ? surfMat.mowingStripeContrast : 0.5;
        tStripes[t4 + 3] = 0.0;
        teeCount++;
      }
    }

    plugin.bunkerCount = bunkerCount;
    plugin.greenCount = greenCount;
    plugin.waterCount = waterCount;
    plugin.teeCount = teeCount;
    this.rebuildTracedSdfAtlas(plugin);
  }

  /**
   * Builds/updates the universal RGBA8 linear-filtered GPU SDF Atlas (512x1024, [-16m..+16m])
   * for any arbitrary traced MapNG Fairway, Green, Bunker, or Water contours.
   */
  private rebuildTracedSdfAtlas(plugin: BunkerGrassExclusionPlugin) {
    const TW = 512;
    const TH = 1024;
    const data = this.tracedSdfData;
    if (!data) {
      plugin.tracedCount = 0;
      return;
    }

    const channelForType = (st: SurfaceType): number => {
      switch (st) {
        case SurfaceType.FAIRWAY: return 0;
        case SurfaceType.GREEN: return 1;
        case SurfaceType.BUNKER: return 2;
        case SurfaceType.WATER: return 3;
        default: return -1;
      }
    };

    const tracedItems: {
      featIdx: number;
      ch: number;
      contour: PolygonPoint[];
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
    }[] = [];

    plugin.tracedSurfIds = [0, 0, 0, 0];
    plugin.tracedFringeIds = [0, 0, 0, 0];
    plugin.tracedCollarW = [1.8, 1.65, 1.2, 2.15];
    plugin.tracedShowCollar = [1, 1, 1, 1];
    plugin.tracedTeeIds = [0, 0, 0.5, 0];

    // Zero-sampler analytical 20-vertex GPU polygon SDF for spline-traced Tee Boxes (infinite precision, 0 extra texture units!)
    for (let featIdx = 0; featIdx < this.stampedFeatures.length; featIdx++) {
      const feat = this.stampedFeatures[featIdx];
      if (!feat.contour || feat.contour.length < 3 || feat.surfaceType !== SurfaceType.TEE) continue;
      const surfMat = this.getFeatureSubMaterialSettings(featIdx, 'surface');
      const fringeMat = this.getFeatureSubMaterialSettings(featIdx, 'fringe');
      const surfId = this.getOrRegisterLayerId(featIdx, 'surface');
      const fringeId = this.getOrRegisterLayerId(featIdx, 'fringe');
      const showCollar = fringeMat.showCollarRings !== false && surfMat.showCollarRings !== false;
      const collarW = fringeMat.collarWidth ?? surfMat.collarWidth ?? 0.50;
      plugin.tracedTeeIds = [surfId, fringeId, collarW, showCollar ? 1 : 0];
      plugin.tracedTeeStripes = [
        surfMat.showMowingStripes !== false ? 1.0 : 0.0,
        surfMat.mowingStripeWidth ?? 1.6,
        surfMat.mowingStripeContrast !== undefined ? surfMat.mowingStripeContrast : 0.48,
        feat.rotationRad || 0
      ];
      const b = computePolygonBounds(feat.contour);
      const pad = Math.max(3.0, collarW + 2.5);
      plugin.tracedTeeBounds = [b.minX - pad, b.minZ - pad, b.maxX + pad, b.maxZ + pad];

      // Uniformly resample the spline contour to 20 smooth vertices packed into 10 vec4 uniforms
      const pts = feat.contour;
      const n = pts.length;
      const arr = plugin.tracedTeePolyArray;
      for (let k = 0; k < 20; k++) {
        const fIdx = (k / 20) * n;
        const i0 = Math.floor(fIdx) % n;
        const i1 = (i0 + 1) % n;
        const frac = fIdx - Math.floor(fIdx);
        arr[k * 2] = pts[i0].x * (1 - frac) + pts[i1].x * frac;
        arr[k * 2 + 1] = pts[i0].z * (1 - frac) + pts[i1].z * frac;
      }
      plugin.tracedTeePolyCount = 20;
      break;
    }

    for (let featIdx = 0; featIdx < this.stampedFeatures.length; featIdx++) {
      const feat = this.stampedFeatures[featIdx];
      if (!feat.contour || feat.contour.length < 3) continue;
      const ch = channelForType(feat.surfaceType);
      if (ch < 0) continue;

      const surfMat = this.getFeatureSubMaterialSettings(featIdx, 'surface');
      const fringeMat = this.getFeatureSubMaterialSettings(featIdx, 'fringe');
      const surfId = this.getOrRegisterLayerId(featIdx, 'surface');
      const fringeId = this.getOrRegisterLayerId(featIdx, 'fringe');
      const showCollar = fringeMat.showCollarRings !== false && surfMat.showCollarRings !== false;
      const defCollar =
        feat.surfaceType === SurfaceType.BUNKER ? 1.2 :
        feat.surfaceType === SurfaceType.WATER ? 2.15 :
        feat.surfaceType === SurfaceType.GREEN ? 1.65 : 1.8;
      const collarW = fringeMat.collarWidth ?? surfMat.collarWidth ?? defCollar;

      plugin.tracedSurfIds[ch] = surfId;
      plugin.tracedFringeIds[ch] = fringeId;
      plugin.tracedCollarW[ch] = collarW;
      plugin.tracedShowCollar[ch] = showCollar ? 1 : 0;

      if (feat.surfaceType === SurfaceType.FAIRWAY) {
        plugin.tracedFairwayStripes = [
          surfMat.showMowingStripes !== false ? 1.0 : 0.0,
          surfMat.mowingStripeWidth ?? 4.6,
          surfMat.mowingStripeContrast !== undefined ? surfMat.mowingStripeContrast : 0.5,
          feat.rotationRad || 0
        ];
      } else if (feat.surfaceType === SurfaceType.GREEN) {
        plugin.tracedGreenStripes = [
          surfMat.showMowingStripes !== false ? 1.0 : 0.0,
          surfMat.mowingStripeWidth ?? 1.8,
          surfMat.mowingStripeContrast !== undefined ? surfMat.mowingStripeContrast : 0.45,
          feat.rotationRad || 0
        ];
      }

      const b = computePolygonBounds(feat.contour);
      tracedItems.push({
        featIdx,
        ch,
        contour: feat.contour,
        minX: b.minX - 15.5,
        maxX: b.maxX + 15.5,
        minZ: b.minZ - 15.5,
        maxZ: b.maxZ + 15.5
      });
    }

    if (tracedItems.length === 0) {
      plugin.tracedCount = 0;
      if (this.hasAnyTracedSdf) {
        data.fill(255);
        this.tracedSdfTex?.update(data);
        this.hasAnyTracedSdf = false;
      }
      return;
    }

    data.fill(255);
    for (const item of tracedItems) {
      const px0 = Math.max(0, Math.floor((item.minX / this.width) * TW));
      const px1 = Math.min(TW - 1, Math.ceil((item.maxX / this.width) * TW));
      const py0 = Math.max(0, Math.floor((item.minZ / this.length) * TH));
      const py1 = Math.min(TH - 1, Math.ceil((item.maxZ / this.length) * TH));

      for (let py = py0; py <= py1; py++) {
        const wz = ((py + 0.5) / TH) * this.length;
        const rowOff = py * TW;
        for (let px = px0; px <= px1; px++) {
          const wx = ((px + 0.5) / TW) * this.width;
          const d = signedDistanceToPolygon(wx, wz, item.contour);
          const enc = Math.max(0, Math.min(255, Math.round(((d + 16.0) / 32.0) * 255.0)));
          const pIdx = (rowOff + px) * 4 + item.ch;
          if (enc < data[pIdx]) {
            data[pIdx] = enc;
          }
        }
      }
    }

    plugin.tracedCount = tracedItems.length;
    this.hasAnyTracedSdf = true;
    this.tracedSdfTex?.update(data);
  }

  public setSatelliteOverlayTexture(dataUrl: string | null, opacity = 0.72) {
    if (this.satelliteOverlayTex) {
      this.satelliteOverlayTex.dispose();
      this.satelliteOverlayTex = null;
    }
    this.satellitePreviewDataUrl = dataUrl;
    this.satelliteOpacity = Math.max(0, Math.min(1, opacity));
    this.satelliteEnabled = Boolean(dataUrl) && this.satelliteOpacity > 0.005;

    if (dataUrl) {
      const tex = new Texture(
        dataUrl,
        this.scene,
        false,
        true,
        Texture.TRILINEAR_SAMPLINGMODE
      );
      tex.wrapU = Texture.CLAMP_ADDRESSMODE;
      tex.wrapV = Texture.CLAMP_ADDRESSMODE;
      tex.anisotropicFilteringLevel = Math.min(4, getDeviceProfile().maxAnisotropy);
      tex.onLoadObservable.addOnce(() => {
        this.terrainMaterial?.markAsDirty(Material.TextureDirtyFlag);
        this.terrainMaterial?.resetDrawCache();
      });
      this.satelliteOverlayTex = tex;
    }

    if (this.groundShaderPlugin) {
      this.groundShaderPlugin.satelliteOverlayTex = this.satelliteOverlayTex;
      this.groundShaderPlugin.satelliteOpacity = this.satelliteOpacity;
      this.groundShaderPlugin.satelliteEnabled = this.satelliteEnabled;
    }
    this.terrainMaterial?.markAsDirty(Material.MiscDirtyFlag);
  }

  public setSatelliteOpacity(opacity: number, enabled?: boolean) {
    this.satelliteOpacity = Math.max(0, Math.min(1, opacity));
    if (enabled !== undefined) {
      this.satelliteEnabled = enabled && Boolean(this.satelliteOverlayTex);
    }
    if (this.groundShaderPlugin) {
      this.groundShaderPlugin.satelliteOpacity = this.satelliteOpacity;
      this.groundShaderPlugin.satelliteEnabled = this.satelliteEnabled;
    }
  }

  public setSatelliteOverlayOverFeatures(amount: number) {
    this.overlayOverFeatures = Math.max(0, Math.min(0.85, amount));
    if (this.groundShaderPlugin) {
      this.groundShaderPlugin.overlayOverFeatures = this.overlayOverFeatures;
    }
  }

  public resizeGrid(
    newWidth: number,
    newLength: number,
    newCellSize: number = 1,
    rebuild: boolean = true
  ) {
    this.cellSize = Math.max(0.5, newCellSize);
    this.gridX = Math.max(2, Math.round(newWidth / this.cellSize));
    this.gridZ = Math.max(2, Math.round(newLength / this.cellSize));
    this.width = this.gridX * this.cellSize;
    this.length = this.gridZ * this.cellSize;
    this.cols = this.gridX + 1;
    this.rows = this.gridZ + 1;
    this.blockCols = Math.floor(this.gridX / 2);
    this.blockRows = Math.floor(this.gridZ / 2);

    const totalVerts = this.cols * this.rows;
    this.baseHeights = new Float32Array(totalVerts);
    this.heights = new Float32Array(totalVerts);
    this.surfaceTypes = new Uint8Array(totalVerts);
    this.subdividedCells = new Uint8Array(this.gridX * this.gridZ);
    this.coarseBlocks = new Uint8Array(this.blockCols * this.blockRows);

    this.positions = new Float32Array(totalVerts * 3);
    this.normals = new Float32Array(totalVerts * 3);
    this.uvs = new Float32Array(totalVerts * 2);
    this.colors = new Float32Array(totalVerts * 4);
    this.indices = new Uint32Array(this.gridX * this.gridZ * 6);

    this.pristineNaturalHeights = null;
    this.cachedBaseCourseHeights = null;
    this.cachedBaseCourseSurfaceTypes = null;
    this.courseBoundaryMask = null;
    this.playCorridorBounds = null;
    this.dragStaticBaseHeights = null;
    this.dragStaticFeatureIdx = -1;
    this.isBaseCourseDirty = true;

    if (this.groundShaderPlugin) {
      this.groundShaderPlugin.terrainWidth = this.width;
      this.groundShaderPlugin.terrainLength = this.length;
    }

    this.groundUvScaleU = Math.max(10, Math.round(this.width * 0.5));
    this.groundUvScaleV = Math.max(10, Math.round(this.length * 0.5));
    const applyUv = (tex: BaseTexture | null) => {
      if (tex instanceof Texture) {
        tex.uScale = Math.max(0.02, this.groundUvScaleU);
        tex.vScale = Math.max(0.02, this.groundUvScaleV);
      }
    };
    applyUv(this.pbrGrassColorTex);
    applyUv(this.pbrGrassNormalTex);
    applyUv(this.pbrGrassRoughTex);
    this.terrainMaterial?.markAsDirty(Material.TextureDirtyFlag | Material.MiscDirtyFlag);

    if (rebuild) {
      this.redrawSplatTexture();
      this.rebuildMesh(false);
    }
  }

  public setPlayCorridorBounds(
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null
  ) {
    this.playCorridorBounds = bounds ? { ...bounds } : null;
    this.rebuildMesh(false);
  }

  public setHeightmapStrength(scale: number): boolean {
    const clamped = Math.max(0.1, Math.min(3.0, scale));
    this.heightmapStrength = clamped;
    if (!this.rawImportedBaseHeights || this.rawImportedBaseHeights.length !== this.baseHeights.length) {
      return false;
    }
    const baseMin = this.rawImportedMinElev;
    for (let i = 0; i < this.baseHeights.length; i++) {
      this.baseHeights[i] = baseMin + (this.rawImportedBaseHeights[i] - baseMin) * clamped;
    }
    this.setPristineNaturalHeights(this.baseHeights);
    this.heights.set(this.baseHeights);
    this.isBaseCourseDirty = true;
    for (const f of this.stampedFeatures) {
      f.baseElevation = this.getBaseElevation(f.centerX, f.centerZ);
    }
    this.rebuildMesh(false);
    return true;
  }

  public createFlatTerrain(
    elevation = 2.0,
    clearFeatures = true,
    clearSatellite = true,
    targetWidth = GOLF_CONSTANTS.DEFAULT_MAP_WIDTH,
    targetLength = GOLF_CONSTANTS.DEFAULT_MAP_LENGTH,
    targetCellSize = 1
  ) {
    if (
      Math.abs(this.width - targetWidth) > 0.01 ||
      Math.abs(this.length - targetLength) > 0.01 ||
      Math.abs(this.cellSize - targetCellSize) > 0.01
    ) {
      this.resizeGrid(targetWidth, targetLength, targetCellSize, false);
    }
    this.courseBoundaryMask = null;
    this.playCorridorBounds = null;
    this.baseHeights.fill(elevation);
    this.setPristineNaturalHeights(this.baseHeights);
    this.heights.fill(elevation);
    this.surfaceTypes.fill(SurfaceType.ROUGH);
    this.isBaseCourseDirty = true;
    this.dragStaticFeatureIdx = -1;

    if (clearFeatures) {
      this.stampedFeatures = [];
      this.hasAnyTracedSdf = false;
      if (this.tracedSdfData) {
        this.tracedSdfData.fill(255);
        this.tracedSdfTex?.update(this.tracedSdfData);
      }
      if (this.groundShaderPlugin) {
        this.groundShaderPlugin.tracedCount = 0;
      }
    }
    if (clearSatellite) {
      this.setSatelliteOverlayTexture(null, 0.0);
    }

    this.syncPluginLayerState();
    this.syncAnalyticalFeatureUniforms();
    this.redrawSplatTexture();
    this.rebuildMesh(false);
  }

  public loadMapNGHeightfield(
    newBaseHeights: Float32Array,
    satelliteDataUrl?: string | null,
    satelliteOpacity = 0.72,
    clearFeatures = false,
    courseBoundaryMask?: Uint8Array | null
  ) {
    if (newBaseHeights.length !== this.baseHeights.length) {
      throw new Error(
        `Heightmap grid mismatch: got ${newBaseHeights.length}, expected ${this.baseHeights.length}`
      );
    }
    this.playCorridorBounds = null;
    this.baseHeights.set(newBaseHeights);
    this.setPristineNaturalHeights(newBaseHeights);
    this.heights.set(newBaseHeights);
    this.surfaceTypes.fill(SurfaceType.ROUGH);
    this.courseBoundaryMask =
      courseBoundaryMask && courseBoundaryMask.length === this.gridX * this.gridZ
        ? new Uint8Array(courseBoundaryMask)
        : null;
    this.isBaseCourseDirty = true;

    if (clearFeatures) {
      this.stampedFeatures = [];
      this.hasAnyTracedSdf = false;
      if (this.tracedSdfData) {
        this.tracedSdfData.fill(255);
        this.tracedSdfTex?.update(this.tracedSdfData);
      }
      if (this.groundShaderPlugin) {
        this.groundShaderPlugin.tracedCount = 0;
      }
    } else {
      for (const f of this.stampedFeatures) {
        f.baseElevation = this.getBaseElevation(f.centerX, f.centerZ);
      }
    }

    if (satelliteDataUrl !== undefined) {
      this.setSatelliteOverlayTexture(satelliteDataUrl, satelliteOpacity);
    }
    this.syncPluginLayerState();
    this.syncAnalyticalFeatureUniforms();
    this.redrawSplatTexture();
    this.rebuildMesh(false);
  }

  public loadUnifiedMapNGCourse(
    course: UnifiedMapNGCourse,
    satelliteOpacity = 0.85,
    clearFeatures = true
  ) {
    this.resizeGrid(course.worldWidth, course.worldLength, course.cellSize, false);
    this.baseHeights.set(course.baseHeights);
    this.rawImportedBaseHeights = new Float32Array(course.baseHeights);
    let minH = Infinity;
    for (let i = 0; i < course.baseHeights.length; i++) {
      if (course.baseHeights[i] < minH) minH = course.baseHeights[i];
    }
    this.rawImportedMinElev = Number.isFinite(minH) ? minH : 0;
    this.heightmapStrength = 1.0;
    this.setPristineNaturalHeights(course.baseHeights);
    this.heights.set(course.baseHeights);
    this.surfaceTypes.fill(SurfaceType.ROUGH);
    this.courseBoundaryMask =
      course.courseBoundaryMask && course.courseBoundaryMask.length === this.gridX * this.gridZ
        ? new Uint8Array(course.courseBoundaryMask)
        : null;
    this.playCorridorBounds = null;
    this.isBaseCourseDirty = true;

    if (clearFeatures) {
      this.stampedFeatures = [];
      this.hasAnyTracedSdf = false;
      if (this.tracedSdfData) {
        this.tracedSdfData.fill(255);
        this.tracedSdfTex?.update(this.tracedSdfData);
      }
      if (this.groundShaderPlugin) {
        this.groundShaderPlugin.tracedCount = 0;
      }
    } else {
      for (const f of this.stampedFeatures) {
        f.baseElevation = this.getBaseElevation(f.centerX, f.centerZ);
      }
    }

    this.setSatelliteOverlayTexture(course.satelliteDataUrl, satelliteOpacity);
    this.syncPluginLayerState();
    this.syncAnalyticalFeatureUniforms();
    this.redrawSplatTexture();
    this.rebuildMesh(false);
  }

  public addTracedFeature(
    surfaceType: SurfaceType,
    contourWorldPts: PolygonPoint[],
    customName?: string
  ): number {
    const contour = contourWorldPts.map((p) => ({ ...p }));
    const bounds = computePolygonBounds(contour);
    const count = this.stampedFeatures.filter((f) => f.surfaceType === surfaceType).length + 1;
    const labelMap: Partial<Record<SurfaceType, string>> = {
      [SurfaceType.FAIRWAY]: `Traced Fairway #${count}`,
      [SurfaceType.GREEN]: `Traced Green #${count}`,
      [SurfaceType.BUNKER]: `Traced Bunker #${count}`,
      [SurfaceType.TEE]: `Traced Tee Box #${count}`,
      [SurfaceType.WATER]: `Traced Water #${count}`
    };

    const depthProfile =
      surfaceType === SurfaceType.BUNKER ? -0.60 :
      surfaceType === SurfaceType.WATER ? -2.2 :
      surfaceType === SurfaceType.TEE ? 1.25 : 0.0;

    const record: StampedFeatureRecord = {
      id: `feat_traced_${String(surfaceType)}_${Date.now().toString(36)}`,
      name: customName || labelMap[surfaceType] || `Traced ${surfaceType} #${count}`,
      centerX: bounds.centerX,
      centerZ: bounds.centerZ,
      width: bounds.width,
      length: bounds.length,
      rotationRad: 0,
      surfaceType,
      depthProfile,
      lipHeight: surfaceType === SurfaceType.BUNKER ? 0.60 : 0,
      baseElevation: this.getBaseElevation(bounds.centerX, bounds.centerZ),
      contour,
      conformDemBlend: surfaceType === SurfaceType.GREEN ? 1.0 : undefined
    };

    this.stampedFeatures.push(record);
    const newIdx = this.stampedFeatures.length - 1;
    this.syncPluginLayerState();
    this.syncAnalyticalFeatureUniforms();
    this.redrawSplatTexture();
    this.rebuildMesh(false);
    return newIdx;
  }

  public updateTracedFeatureContour(
    featureIndex: number,
    contourWorldPts: PolygonPoint[],
    isDraft: boolean = false
  ) {
    if (featureIndex < 0 || featureIndex >= this.stampedFeatures.length) return;
    const feat = this.stampedFeatures[featureIndex];
    feat.contour = contourWorldPts.map((p) => ({ ...p }));
    const bounds = computePolygonBounds(feat.contour);
    feat.centerX = bounds.centerX;
    feat.centerZ = bounds.centerZ;
    feat.width = bounds.width;
    feat.length = bounds.length;
    feat.baseElevation = this.getBaseElevation(bounds.centerX, bounds.centerZ);

    this.syncAnalyticalFeatureUniforms();
    if (!isDraft || feat.surfaceType === SurfaceType.TEE) {
      this.redrawSplatTexture();
    }
    this.rebuildMesh(isDraft);
  }

  public syncBunkerShaderUniforms() {
    this.syncAnalyticalFeatureUniforms();
  }

  private getFeatureAffectedBounds(feat: StampedFeatureRecord): { minX: number; maxX: number; minZ: number; maxZ: number } {
    if (feat.contour && feat.contour.length >= 3) {
      const b = computePolygonBounds(feat.contour);
      const pad = 8.0;
      return { minX: b.minX - pad, maxX: b.maxX + pad, minZ: b.minZ - pad, maxZ: b.maxZ + pad };
    }

    if (feat.doglegPoints && feat.doglegPoints.length >= 4) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      let maxW = feat.width;
      for (const p of feat.doglegPoints) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
        if (p.width > maxW) maxW = p.width;
      }
      const pad = maxW + 42;
      return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
    }
    const collarW = feat.subMaterials?.fringe?.collarWidth ?? feat.materialSettings?.collarWidth ?? 2.2;
    const pad = Math.max(feat.width, feat.length) * 0.90 + collarW + 6.0;
    return {
      minX: feat.centerX - pad,
      maxX: feat.centerX + pad,
      minZ: feat.centerZ - pad,
      maxZ: feat.centerZ + pad
    };
  }

  private getHeightFromArray(arr: Float32Array, worldX: number, worldZ: number): number {
    const clampedX = Math.max(0, Math.min(this.width - 0.0001, worldX));
    const clampedZ = Math.max(0, Math.min(this.length - 0.0001, worldZ));
    const gx = clampedX / this.cellSize;
    const gz = clampedZ / this.cellSize;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(this.cols - 1, x0 + 1);
    const z1 = Math.min(this.rows - 1, z0 + 1);
    const fx = gx - x0;
    const fz = gz - z0;
    const h00 = arr[z0 * this.cols + x0];
    const h10 = arr[z0 * this.cols + x1];
    const h01 = arr[z1 * this.cols + x0];
    const h11 = arr[z1 * this.cols + x1];
    return (1 - fx) * (1 - fz) * h00 + fx * (1 - fz) * h10 + (1 - fx) * fz * h01 + fx * fz * h11;
  }

  private stampGreenBaseHeightsLocal(feat: StampedFeatureRecord, effBaseElevation: number) {
    const halfW = feat.width * 0.5;
    const halfL = feat.length * 0.5;
    const maxDim = Math.max(feat.width, feat.length) * 1.1;
    const minX = Math.max(0, Math.floor((feat.centerX - maxDim) / this.cellSize));
    const maxX = Math.min(this.cols - 1, Math.ceil((feat.centerX + maxDim) / this.cellSize));
    const minZ = Math.max(0, Math.floor((feat.centerZ - maxDim) / this.cellSize));
    const maxZ = Math.min(this.rows - 1, Math.ceil((feat.centerZ + maxDim) / this.cellSize));
    const cosR = Math.cos(-feat.rotationRad);
    const sinR = Math.sin(-feat.rotationRad);

    for (let z = minZ; z <= maxZ; z++) {
      const wz = z * this.cellSize;
      for (let x = minX; x <= maxX; x++) {
        const wx = x * this.cellSize;
        const dx = wx - feat.centerX;
        const dz = wz - feat.centerZ;
        const localX = dx * cosR - dz * sinR;
        const localZ = dx * sinR + dz * cosR;
        const normDist = Math.hypot(localX / halfW, localZ / halfL);
        if (normDist <= 1.0) {
          const idx = z * this.cols + x;
          const blend = Math.cos(normDist * Math.PI * 0.5);
          const readableSlope = (localX / halfW) * 0.26 + (localZ / halfL) * 0.22;
          const targetGreenY = effBaseElevation + readableSlope;
          this.baseHeights[idx] = this.baseHeights[idx] * (1 - blend) + targetGreenY * blend;
        }
      }
    }
  }

  private ensureDragStaticSnapshot(activeIdx: number) {
    if (this.dragStaticFeatureIdx === activeIdx && this.dragStaticBaseHeights?.length === this.baseHeights.length) {
      return;
    }
    if (!this.dragStaticBaseHeights || this.dragStaticBaseHeights.length !== this.baseHeights.length) {
      this.dragStaticBaseHeights = new Float32Array(this.baseHeights.length);
    }
    const activeFeat = this.stampedFeatures[activeIdx];
    if (activeFeat && activeFeat.surfaceType === SurfaceType.GREEN) {
      if (this.pristineNaturalHeights) {
        this.baseHeights.set(this.pristineNaturalHeights);
      }
      for (let i = 0; i < this.stampedFeatures.length; i++) {
        if (i === activeIdx) continue;
        const other = this.stampedFeatures[i];
        if (other.surfaceType === SurfaceType.GREEN) {
          const elev = this.getBaseElevation(other.centerX, other.centerZ);
          this.stampGreenBaseHeightsLocal(other, elev);
        }
      }
    }
    this.dragStaticBaseHeights.set(this.baseHeights);
    this.dragStaticFeatureIdx = activeIdx;
  }

  /**
   * Incrementally updates 3D terrain heights & vertex normals within a local meter box during
   * live draft dragging (~0.2ms), keeping all overlapping features draping seamlessly in real time.
   */
  private updateDraftRegionHeights(minX: number, maxX: number, minZ: number, maxZ: number) {
    if (!this.terrainMesh || !this.isDraftMode || this.positions.length !== this.cols * this.rows * 3) return;
    const x0 = Math.max(0, Math.floor(minX / this.cellSize) - 2);
    const x1 = Math.min(this.gridX, Math.ceil(maxX / this.cellSize) + 2);
    const z0 = Math.max(0, Math.floor(minZ / this.cellSize) - 2);
    const z1 = Math.min(this.gridZ, Math.ceil(maxZ / this.cellSize) + 2);

    for (let z = z0; z <= z1; z++) {
      const wz = z * this.cellSize;
      for (let x = x0; x <= x1; x++) {
        const wx = x * this.cellSize;
        const vIdx = z * this.cols + x;
        const h = this.evaluateAnalyticalElevation(wx, wz);
        this.heights[vIdx] = h;
        this.positions[vIdx * 3 + 1] = h;
      }
    }

    const nx0 = Math.max(0, x0 - 1);
    const nx1 = Math.min(this.gridX, x1 + 1);
    const nz0 = Math.max(0, z0 - 1);
    const nz1 = Math.min(this.gridZ, z1 + 1);
    const spanInv = 1 / (2 * this.cellSize);
    for (let z = nz0; z <= nz1; z++) {
      for (let x = nx0; x <= nx1; x++) {
        const vIdx = z * this.cols + x;
        const hC = this.heights[vIdx];
        const hL = x > 0 ? this.heights[vIdx - 1] : hC;
        const hR = x < this.cols - 1 ? this.heights[vIdx + 1] : hC;
        const hD = z > 0 ? this.heights[vIdx - this.cols] : hC;
        const hU = z < this.rows - 1 ? this.heights[vIdx + this.cols] : hC;

        const nx = (hL - hR) * spanInv;
        const ny = 1.0;
        const nz = (hD - hU) * spanInv;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;

        const pIdx = vIdx * 3;
        this.normals[pIdx] = nx / len;
        this.normals[pIdx + 1] = ny / len;
        this.normals[pIdx + 2] = nz / len;
      }
    }

    this.terrainMesh.updateVerticesData(VertexBuffer.PositionKind, this.positions);
    this.terrainMesh.updateVerticesData(VertexBuffer.NormalKind, this.normals);
  }

  private applyFastDraftFeatureMove(
    featureIndex: number,
    oldBounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    feat: StampedFeatureRecord
  ) {
    this.ensureDragStaticSnapshot(featureIndex);
    const newBounds = this.getFeatureAffectedBounds(feat);
    let dMinX = Math.min(oldBounds.minX, newBounds.minX);
    let dMaxX = Math.max(oldBounds.maxX, newBounds.maxX);
    let dMinZ = Math.min(oldBounds.minZ, newBounds.minZ);
    let dMaxZ = Math.max(oldBounds.maxZ, newBounds.maxZ);

    if (feat.surfaceType === SurfaceType.GREEN && this.dragStaticBaseHeights) {
      const rx0 = Math.max(0, Math.floor(dMinX / this.cellSize) - 2);
      const rx1 = Math.min(this.cols - 1, Math.ceil(dMaxX / this.cellSize) + 2);
      const rz0 = Math.max(0, Math.floor(dMinZ / this.cellSize) - 2);
      const rz1 = Math.min(this.rows - 1, Math.ceil(dMaxZ / this.cellSize) + 2);
      for (let z = rz0; z <= rz1; z++) {
        const rowOff = z * this.cols;
        for (let x = rx0; x <= rx1; x++) {
          this.baseHeights[rowOff + x] = this.dragStaticBaseHeights[rowOff + x];
        }
      }
      feat.baseElevation = this.getHeightFromArray(this.dragStaticBaseHeights, feat.centerX, feat.centerZ);
      this.stampGreenBaseHeightsLocal(feat, feat.baseElevation);

      // Re-drape any overlapping analytical features (Bunkers, Water, Tee) over the moving Green instantaneously
      for (let i = 0; i < this.stampedFeatures.length; i++) {
        if (i === featureIndex) continue;
        const other = this.stampedFeatures[i];
        if (other.surfaceType === SurfaceType.BUNKER || other.surfaceType === SurfaceType.WATER || other.surfaceType === SurfaceType.TEE) {
          const ob = this.getFeatureAffectedBounds(other);
          if (ob.maxX >= dMinX && ob.minX <= dMaxX && ob.maxZ >= dMinZ && ob.minZ <= dMaxZ) {
            other.baseElevation = this.getBaseElevation(other.centerX, other.centerZ);
            dMinX = Math.min(dMinX, ob.minX);
            dMaxX = Math.max(dMaxX, ob.maxX);
            dMinZ = Math.min(dMinZ, ob.minZ);
            dMaxZ = Math.max(dMaxZ, ob.maxZ);
          }
        }
      }
    } else {
      feat.baseElevation = this.getBaseElevation(feat.centerX, feat.centerZ);
    }

    this.syncAnalyticalFeatureUniforms();

    if (!this.isDraftMode || this.positions.length !== this.cols * this.rows * 3) {
      this.setDraftTransformMode(true);
      this.rebuildMesh(true);
    } else {
      this.updateDraftRegionHeights(dMinX, dMaxX, dMinZ, dMaxZ);
    }

    const isAnalyticalOnly =
      feat.surfaceType === SurfaceType.BUNKER ||
      feat.surfaceType === SurfaceType.GREEN ||
      feat.surfaceType === SurfaceType.WATER ||
      feat.surfaceType === SurfaceType.TEE;

    if (!isAnalyticalOnly) {
      const now = performance.now();
      if (now - this.lastDraftSplatTime >= 90) {
        this.lastDraftSplatTime = now;
        if (this.draftSplatTimer !== null) {
          clearTimeout(this.draftSplatTimer);
          this.draftSplatTimer = null;
        }
        this.redrawSplatTexture();
      } else if (this.draftSplatTimer === null) {
        this.draftSplatTimer = window.setTimeout(() => {
          this.draftSplatTimer = null;
          this.lastDraftSplatTime = performance.now();
          if (this.isDraftMode) {
            this.redrawSplatTexture();
          }
        }, 95);
      }
    }
  }

  /**
   * Re-rasterizes all stamped course features (Fairway, Green, Bunkers, Tee Box, Water Hazard)
   * after sliding, rotating, adding, or deleting any feature in Designer Mode.
   */
  public rebuildAllStampedFeatures(isDraft: boolean = false, skipSplatRedraw: boolean = false) {
    if (!isDraft) {
      this.dragStaticFeatureIdx = -1;
      if (this.draftSplatTimer !== null) {
        clearTimeout(this.draftSplatTimer);
        this.draftSplatTimer = null;
      }
    }
    this.setDraftTransformMode(isDraft);
    const feats = [...this.stampedFeatures];
    this.stampedFeatures = [];

    // Cache the base terrain shaping features (Fairway, Green, Tee, Water) so bunker edits don't re-run expensive splines
    if (this.isBaseCourseDirty || !this.cachedBaseCourseHeights || !this.cachedBaseCourseSurfaceTypes) {
      this.restoreNaturalTerrain();
      // Pass 1: Base terrain shaping features (Fairway, Green, Tee, Water)
      for (const f of feats) {
        if (f.surfaceType === SurfaceType.BUNKER) continue;
        const effElev = this.getBaseElevation(f.centerX, f.centerZ);
        if (f.doglegPoints && f.doglegPoints.length >= 4) {
          this.stampDoglegFairway(f.doglegPoints, false, f.id, f.name);
        } else {
          this.stampFeature(
            f.centerX,
            f.centerZ,
            f.width,
            f.length,
            f.rotationRad,
            f.surfaceType,
            f.depthProfile,
            f.lipHeight,
            effElev,
            f.bunkerShapeIndex,
            false,
            f.id
          );
        }
      }

      if (!this.cachedBaseCourseHeights || this.cachedBaseCourseHeights.length !== this.baseHeights.length) {
        this.cachedBaseCourseHeights = new Float32Array(this.baseHeights.length);
        this.cachedBaseCourseSurfaceTypes = new Uint8Array(this.surfaceTypes.length);
      }
      this.cachedBaseCourseHeights.set(this.baseHeights);
      this.cachedBaseCourseSurfaceTypes.set(this.surfaceTypes);
      this.isBaseCourseDirty = false;
    } else {
      // Blazing fast cache restoration (< 0.2ms)
      this.baseHeights.set(this.cachedBaseCourseHeights);
      this.heights.set(this.cachedBaseCourseHeights);
      this.surfaceTypes.set(this.cachedBaseCourseSurfaceTypes);
    }

    // Pass 2: Bunkers (now guaranteed to read the sculpted green/fairway base elevation)
    for (const f of feats) {
      if (f.surfaceType !== SurfaceType.BUNKER) continue;
      const effElev = this.getBaseElevation(f.centerX, f.centerZ);
      this.stampFeature(
        f.centerX,
        f.centerZ,
        f.width,
        f.length,
        f.rotationRad,
        f.surfaceType,
        f.depthProfile,
        f.lipHeight,
        effElev,
        f.bunkerShapeIndex,
        false,
        f.id
      );
    }

    // Restore this.stampedFeatures preserving original IDs and array indices
    this.stampedFeatures = feats;

    if (!skipSplatRedraw) {
      this.redrawSplatTexture();
    } else {
      this.syncAnalyticalFeatureUniforms();
    }
    this.rebuildMesh(isDraft);
  }

  /**
   * Restores full 0.25m high-resolution subdivision and Havok physics accuracy on drag release.
   */
  public finalizeFeatureTransform(featureIndex: number) {
    this.dragStaticFeatureIdx = -1;
    if (this.draftSplatTimer !== null) {
      clearTimeout(this.draftSplatTimer);
      this.draftSplatTimer = null;
    }
    if (featureIndex < 0 || featureIndex >= this.stampedFeatures.length) return;
    const feat = this.stampedFeatures[featureIndex];
    const isAnalyticalOnly =
      feat.surfaceType === SurfaceType.BUNKER ||
      feat.surfaceType === SurfaceType.GREEN ||
      feat.surfaceType === SurfaceType.WATER ||
      feat.surfaceType === SurfaceType.TEE;
    this.rebuildAllStampedFeatures(false, isAnalyticalOnly);
  }

  /**
   * Deletes a stamped course feature, restores underlying natural terrain, and rebuilds all remaining features.
   */
  public removeFeature(featureIndex: number): boolean {
    if (featureIndex < 0 || featureIndex >= this.stampedFeatures.length) return false;
    this.dragStaticFeatureIdx = -1;
    const feat = this.stampedFeatures[featureIndex];
    if (feat && feat.surfaceType !== SurfaceType.BUNKER) {
      this.isBaseCourseDirty = true;
    }
    this.stampedFeatures.splice(featureIndex, 1);
    this.rebuildAllStampedFeatures(false);
    return true;
  }

  /**
   * Updates an existing fairway's shape profile (Straight, Dogleg Left, or Dogleg Right)
   * and rebuilds terrain seamlessly.
   */
  public setFairwayShape(featureIndex: number, shape: 'straight' | 'dogleg_left' | 'dogleg_right') {
    if (featureIndex < 0 || featureIndex >= this.stampedFeatures.length) return;
    const feat = this.stampedFeatures[featureIndex];
    if (feat.surfaceType !== SurfaceType.FAIRWAY) return;

    const halfL = feat.length * 0.5;
    const cosR = Math.cos(feat.rotationRad);
    const sinR = Math.sin(feat.rotationRad);
    const makePt = (zOff: number, xCurve: number, wScale: number): DoglegWaypoint => ({
      x: feat.centerX + xCurve * cosR + zOff * sinR,
      z: feat.centerZ - xCurve * sinR + zOff * cosR,
      width: feat.width * wScale
    });

    if (shape === 'dogleg_left') {
      feat.doglegPoints = [
        makePt(-halfL, 0, 0.78),
        makePt(-halfL * 0.3, -feat.width * 0.16, 1.05),
        makePt(halfL * 0.35, -feat.width * 0.26, 0.96),
        makePt(halfL, -feat.width * 0.22, 0.82)
      ];
      feat.id = 'fairway_dogleg_left';
      feat.name = 'Dogleg-Left Fairway';
    } else if (shape === 'straight') {
      feat.doglegPoints = [
        makePt(-halfL, 0, 0.78),
        makePt(-halfL * 0.3, 0, 1.05),
        makePt(halfL * 0.35, 0, 1.02),
        makePt(halfL, 0, 0.82)
      ];
      feat.id = 'fairway_landing_straight';
      feat.name = 'Championship Straight Fairway';
    } else {
      feat.doglegPoints = [
        makePt(-halfL, 0, 0.78),
        makePt(-halfL * 0.3, feat.width * 0.16, 1.05),
        makePt(halfL * 0.35, feat.width * 0.26, 0.96),
        makePt(halfL, feat.width * 0.22, 0.82)
      ];
      feat.id = 'fairway_dogleg_right';
      feat.name = 'Dogleg-Right Fairway';
    }

    this.isBaseCourseDirty = true;
    this.rebuildAllStampedFeatures(false);
  }

  /**
   * Updates an existing bunker's shape contour index (0..4) and rebuilds terrain seamlessly.
   */
  public setBunkerShape(featureIndex: number, shapeIndex: number) {
    if (featureIndex < 0 || featureIndex >= this.stampedFeatures.length) return;
    const feat = this.stampedFeatures[featureIndex];
    if (feat.surfaceType !== SurfaceType.BUNKER) return;
    feat.bunkerShapeIndex = shapeIndex;
    this.rebuildAllStampedFeatures(false, true);
  }

  /**
   * Slides a stamped course feature to new (newCenterX, newCenterZ) on the terrain.
   * Dynamically adapts its base elevation and all geometry to drape over local slopes.
   */
  public moveFeature(featureIndex: number, newCenterX: number, newCenterZ: number, isDraft: boolean = false) {
    if (featureIndex < 0 || featureIndex >= this.stampedFeatures.length) return;
    const feat = this.stampedFeatures[featureIndex];
    const oldBounds = this.getFeatureAffectedBounds(feat);
    const oldX = feat.centerX;
    const oldZ = feat.centerZ;
    if (feat.surfaceType !== SurfaceType.BUNKER) {
      this.isBaseCourseDirty = true;
    }
    const dx = newCenterX - oldX;
    const dz = newCenterZ - oldZ;
    feat.centerX = newCenterX;
    feat.centerZ = newCenterZ;
    feat.baseElevation = this.getBaseElevation(newCenterX, newCenterZ);

    if (feat.doglegPoints) {
      for (const pt of feat.doglegPoints) {
        pt.x += dx;
        pt.z += dz;
      }
    }
    if (feat.contour) {
      for (const pt of feat.contour) {
        pt.x += dx;
        pt.z += dz;
      }
    }
    if (isDraft) {
      this.applyFastDraftFeatureMove(featureIndex, oldBounds, feat);
      return;
    }
    this.dragStaticFeatureIdx = -1;
    const skipSplat =
      !feat.contour &&
      (feat.surfaceType === SurfaceType.BUNKER ||
        feat.surfaceType === SurfaceType.GREEN ||
        feat.surfaceType === SurfaceType.TEE ||
        feat.surfaceType === SurfaceType.WATER);
    this.rebuildAllStampedFeatures(false, skipSplat);
  }

  /**
   * Rotates a stamped course feature around Blender Z axis (yaw in Babylon: vertical Y axis).
   * Adapts base elevation so feature drapes naturally.
   */
  public rotateFeature(featureIndex: number, newRotationRad: number, isDraft: boolean = false) {
    if (featureIndex < 0 || featureIndex >= this.stampedFeatures.length) return;
    const feat = this.stampedFeatures[featureIndex];
    const oldBounds = this.getFeatureAffectedBounds(feat);
    if (feat.surfaceType !== SurfaceType.BUNKER) {
      this.isBaseCourseDirty = true;
    }
    const dTheta = newRotationRad - feat.rotationRad;
    feat.rotationRad = newRotationRad;
    feat.baseElevation = this.getBaseElevation(feat.centerX, feat.centerZ);

    if (feat.doglegPoints) {
      const cosA = Math.cos(dTheta);
      const sinA = Math.sin(dTheta);
      for (const pt of feat.doglegPoints) {
        const rx = pt.x - feat.centerX;
        const rz = pt.z - feat.centerZ;
        pt.x = feat.centerX + rx * cosA - rz * sinA;
        pt.z = feat.centerZ + rx * sinA + rz * cosA;
      }
    }
    if (feat.contour) {
      const cosA = Math.cos(dTheta);
      const sinA = Math.sin(dTheta);
      for (const pt of feat.contour) {
        const rx = pt.x - feat.centerX;
        const rz = pt.z - feat.centerZ;
        pt.x = feat.centerX + rx * cosA + rz * sinA;
        pt.z = feat.centerZ - rx * sinA + rz * cosA;
      }
      const b = computePolygonBounds(feat.contour);
      feat.width = Math.max(2, b.width);
      feat.length = Math.max(2, b.length);
    }
    if (isDraft) {
      this.applyFastDraftFeatureMove(featureIndex, oldBounds, feat);
      return;
    }
    this.dragStaticFeatureIdx = -1;
    const skipSplat =
      !feat.contour &&
      (feat.surfaceType === SurfaceType.BUNKER ||
        feat.surfaceType === SurfaceType.GREEN ||
        feat.surfaceType === SurfaceType.TEE ||
        feat.surfaceType === SurfaceType.WATER);
    this.rebuildAllStampedFeatures(false, skipSplat);
  }

  /**
   * Simultaneously moves and rotates a feature in a single pass to eliminate double-rebuilding.
   */
  public resizeFeature(
    featureIndex: number,
    newWidth: number,
    newLength: number,
    isDraft: boolean = false
  ) {
    if (featureIndex < 0 || featureIndex >= this.stampedFeatures.length) return;
    const feat = this.stampedFeatures[featureIndex];
    const oldBounds = this.getFeatureAffectedBounds(feat);
    const oldW = Math.max(1.0, feat.width);
    const oldL = Math.max(1.0, feat.length);
    const clampedW = Math.max(2.0, Math.min(260.0, newWidth));
    const clampedL = Math.max(2.0, Math.min(380.0, newLength));
    const scaleX = clampedW / oldW;
    const scaleZ = clampedL / oldL;

    if (feat.surfaceType !== SurfaceType.BUNKER) {
      this.isBaseCourseDirty = true;
    }

    feat.width = clampedW;
    feat.length = clampedL;

    if (feat.contour && feat.contour.length >= 3) {
      const cosR = Math.cos(-feat.rotationRad);
      const sinR = Math.sin(-feat.rotationRad);
      const invCos = Math.cos(feat.rotationRad);
      const invSin = Math.sin(feat.rotationRad);
      for (const pt of feat.contour) {
        const dx = pt.x - feat.centerX;
        const dz = pt.z - feat.centerZ;
        const lx = (dx * cosR - dz * sinR) * scaleX;
        const lz = (dx * sinR + dz * cosR) * scaleZ;
        pt.x = feat.centerX + (lx * invCos - lz * invSin);
        pt.z = feat.centerZ + (lx * invSin + lz * invCos);
      }
    }
    if (feat.doglegPoints && feat.doglegPoints.length >= 2) {
      for (const pt of feat.doglegPoints) {
        pt.width = Math.max(4, pt.width * scaleX);
        pt.x = feat.centerX + (pt.x - feat.centerX) * scaleX;
        pt.z = feat.centerZ + (pt.z - feat.centerZ) * scaleZ;
      }
    }

    if (isDraft) {
      this.applyFastDraftFeatureMove(featureIndex, oldBounds, feat);
      return;
    }
    this.dragStaticFeatureIdx = -1;
    const skipSplat =
      !feat.contour &&
      (feat.surfaceType === SurfaceType.BUNKER ||
        feat.surfaceType === SurfaceType.GREEN ||
        feat.surfaceType === SurfaceType.WATER ||
        feat.surfaceType === SurfaceType.TEE);
    this.rebuildAllStampedFeatures(false, skipSplat);
  }

  public moveAndRotateFeature(
    featureIndex: number,
    newCenterX: number,
    newCenterZ: number,
    newRotationRad: number,
    isDraft: boolean = false
  ) {
    if (featureIndex < 0 || featureIndex >= this.stampedFeatures.length) return;
    const feat = this.stampedFeatures[featureIndex];
    const oldBounds = this.getFeatureAffectedBounds(feat);
    const oldX = feat.centerX;
    const oldZ = feat.centerZ;
    if (feat.surfaceType !== SurfaceType.BUNKER) {
      this.isBaseCourseDirty = true;
    }
    const dx = newCenterX - oldX;
    const dz = newCenterZ - oldZ;
    const dTheta = newRotationRad - feat.rotationRad;

    feat.centerX = newCenterX;
    feat.centerZ = newCenterZ;
    feat.rotationRad = newRotationRad;
    feat.baseElevation = this.getBaseElevation(newCenterX, newCenterZ);

    if (feat.doglegPoints) {
      const cosA = Math.cos(dTheta);
      const sinA = Math.sin(dTheta);
      for (const pt of feat.doglegPoints) {
        pt.x += dx;
        pt.z += dz;
        const rx = pt.x - feat.centerX;
        const rz = pt.z - feat.centerZ;
        pt.x = feat.centerX + rx * cosA - rz * sinA;
        pt.z = feat.centerZ + rx * sinA + rz * cosA;
      }
    }
    if (feat.contour) {
      const cosA = Math.cos(dTheta);
      const sinA = Math.sin(dTheta);
      for (const pt of feat.contour) {
        pt.x += dx;
        pt.z += dz;
        const rx = pt.x - feat.centerX;
        const rz = pt.z - feat.centerZ;
        pt.x = feat.centerX + rx * cosA + rz * sinA;
        pt.z = feat.centerZ - rx * sinA + rz * cosA;
      }
      const b = computePolygonBounds(feat.contour);
      feat.width = Math.max(2, b.width);
      feat.length = Math.max(2, b.length);
    }
    if (isDraft) {
      this.applyFastDraftFeatureMove(featureIndex, oldBounds, feat);
      return;
    }
    this.dragStaticFeatureIdx = -1;
    const skipSplat =
      !feat.contour &&
      (feat.surfaceType === SurfaceType.BUNKER ||
        feat.surfaceType === SurfaceType.GREEN ||
        feat.surfaceType === SurfaceType.TEE ||
        feat.surfaceType === SurfaceType.WATER);
    this.rebuildAllStampedFeatures(false, skipSplat);
  }

  /**
   * Lists every exposed sub-material for any course feature so each material layer
   * (e.g. Bunker Sand vs Sod Lip / Collar; Green vs Fringe vs First Cut;
   * Water Surface (3D) vs Shoreline & Bank) can be edited independently.
   */
  public getFeatureSubMaterialOptions(feat: StampedFeatureRecord): FeatureSubMaterialOption[] {
    switch (feat.surfaceType) {
      case SurfaceType.BUNKER:
        return [
          { id: 'surface', label: 'Bunker Sand' },
          { id: 'fringe', label: 'Sod Lip / Collar' }
        ];
      case SurfaceType.GREEN:
        return [
          { id: 'surface', label: 'Putting Green' },
          { id: 'fringe', label: 'Green Fringe' },
          { id: 'first_cut', label: 'First Cut' }
        ];
      case SurfaceType.FAIRWAY:
        return [
          { id: 'surface', label: 'Fairway Turf' },
          { id: 'fringe', label: 'Fairway Fringe' },
          { id: 'first_cut', label: 'First Cut' }
        ];
      case SurfaceType.TEE:
        return [
          { id: 'surface', label: 'Tee Box Turf' },
          { id: 'fringe', label: 'Tee Collar / Fringe' }
        ];
      case SurfaceType.WATER:
        return [
          { id: 'water_surface', label: 'Water Surface (3D)' },
          { id: 'surface', label: 'Shoreline & Bank' }
        ];
      case SurfaceType.FRINGE:
        return [{ id: 'surface', label: 'Fringe Turf' }];
      case SurfaceType.FIRST_CUT:
        return [{ id: 'surface', label: 'First-Cut Turf' }];
      default:
        return [{ id: 'surface', label: 'Surface Turf' }];
    }
  }

  /**
   * Returns default settings & valid built-in Color/Roughness/Normal map preview metadata
   * for any sub-material of any course feature.
   */
  public getDefaultSubMaterial(surface: SurfaceType, subId: FeatureSubMaterialId): FeatureMaterialSettings {
    const sandNorUrl = (this.sandNormalTex as any)?._previewDataUrl || '/textures/pbr_grass/grass_pbr_nor_1k.jpg';
    const sandRoughUrl = (this.sandRoughTex as any)?._previewDataUrl || '/textures/pbr_grass/grass_pbr_rough_512.jpg';

    if (subId === 'fringe') {
      return {
        baseColor: surface === SurfaceType.BUNKER ? '#3d8b37' : '#35a043',
        colorTexLevel: 0.78,
        roughnessLevel: 0.74,
        metallicLevel: 0.0,
        uScale: 1.0,
        vScale: 1.0,
        uOffset: 0.0,
        vOffset: 0.0,
        normalLevel: 0.40,
        enableBaseColorTex: true,
        enableRoughnessTex: true,
        enableNormalTex: true,
        showMowingStripes: false,
        mowingStripeWidth: 1.6,
        mowingStripeContrast: 0.0,
        showCollarRings: true,
        collarWidth:
          surface === SurfaceType.TEE ? 0.5 :
          surface === SurfaceType.GREEN ? 2.2 :
          surface === SurfaceType.FAIRWAY ? 2.0 :
          surface === SurfaceType.BUNKER ? 1.2 : 2.15,
        customTextureUrls: {
          color: '/textures/short_grass_01.jpg',
          colorName: 'fringe_turf_diff.jpg',
          roughness: '/textures/pbr_grass/grass_pbr_rough_512.jpg',
          roughnessName: 'grass_pbr_rough_512.jpg',
          normal: '/textures/pbr_grass/grass_pbr_nor_1k.jpg',
          normalName: 'grass_pbr_nor_1k.jpg'
        }
      };
    }

    const applyPreferredGrass = (base: FeatureMaterialSettings): FeatureMaterialSettings => {
      const tpl = this.preferredGrassMatTemplate;
      if (!tpl) return base;
      return {
        ...base,
        colorTexLevel: tpl.colorTexLevel ?? base.colorTexLevel,
        roughnessLevel: tpl.roughnessLevel ?? base.roughnessLevel,
        metallicLevel: tpl.metallicLevel ?? base.metallicLevel,
        normalLevel: tpl.normalLevel ?? base.normalLevel,
        uScale: tpl.uScale ?? base.uScale,
        vScale: tpl.vScale ?? base.vScale,
        enableBaseColorTex: tpl.enableBaseColorTex ?? base.enableBaseColorTex,
        enableRoughnessTex: tpl.enableRoughnessTex ?? base.enableRoughnessTex,
        enableNormalTex: tpl.enableNormalTex ?? base.enableNormalTex,
        customTextureUrls: tpl.customTextureUrls
          ? { ...(base.customTextureUrls || {}), ...tpl.customTextureUrls }
          : base.customTextureUrls
      };
    };

    if (subId === 'first_cut') {
      return applyPreferredGrass({
        baseColor: '#488a32',
        colorTexLevel: 0.72,
        roughnessLevel: 0.65,
        metallicLevel: 0.0,
        uScale: 1.0,
        vScale: 1.0,
        uOffset: 0.0,
        vOffset: 0.0,
        normalLevel: 0.35,
        enableBaseColorTex: true,
        enableRoughnessTex: true,
        enableNormalTex: true,
        showMowingStripes: false,
        mowingStripeWidth: 1.6,
        mowingStripeContrast: 0.0,
        showCollarRings: true,
        collarWidth: 1.2,
        customTextureUrls: {
          color: '/textures/short_grass_01.jpg',
          colorName: 'short_grass_01.jpg',
          roughness: '/textures/pbr_grass/grass_pbr_rough_512.jpg',
          roughnessName: 'grass_pbr_rough_512.jpg',
          normal: '/textures/pbr_grass/grass_pbr_nor_1k.jpg',
          normalName: 'grass_pbr_nor_1k.jpg'
        }
      });
    }

    if (subId === 'shore') {
      return {
        baseColor: '#4e5444',
        colorTexLevel: 0.45,
        roughnessLevel: 0.68,
        metallicLevel: 0.0,
        uScale: 1.0,
        vScale: 1.0,
        uOffset: 0.0,
        vOffset: 0.0,
        normalLevel: 0.65,
        enableBaseColorTex: true,
        enableRoughnessTex: true,
        enableNormalTex: true,
        showMowingStripes: false,
        showCollarRings: true,
        collarWidth: 0.72,
        customTextureUrls: {
          color: '/textures/pbr_rough/brown_mud_leaves_diff_512.jpg',
          colorName: 'brown_mud_leaves_diff_512.jpg',
          roughness: '/textures/pbr_rough/brown_mud_leaves_rough_512.jpg',
          roughnessName: 'brown_mud_leaves_rough_512.jpg',
          normal: '/textures/pbr_rough/brown_mud_leaves_nor_512.jpg',
          normalName: 'brown_mud_leaves_nor_512.jpg'
        }
      };
    }

    switch (surface) {
      case SurfaceType.GREEN:
        return applyPreferredGrass({
          baseColor: '#28a745',
          colorTexLevel: 0.72,
          roughnessLevel: 0.65,
          metallicLevel: 0.0,
          uScale: 1.0,
          vScale: 1.0,
          uOffset: 0.0,
          vOffset: 0.0,
          normalLevel: 0.35,
          enableBaseColorTex: true,
          enableRoughnessTex: true,
          enableNormalTex: true,
          showMowingStripes: true,
          mowingStripeWidth: 1.8,
          mowingStripeContrast: 0.5,
          showCollarRings: true,
          collarWidth: 2.2,
          customTextureUrls: {
            color: '/textures/short_grass_01.jpg',
            colorName: 'short_grass_01.jpg',
            roughness: '/textures/pbr_grass/grass_pbr_rough_512.jpg',
            roughnessName: 'grass_pbr_rough_512.jpg',
            normal: '/textures/pbr_grass/grass_pbr_nor_1k.jpg',
            normalName: 'grass_pbr_nor_1k.jpg'
          }
        });
      case SurfaceType.BUNKER:
        return {
          baseColor: '#d8c28a',
          colorTexLevel: 1.0,
          roughnessLevel: 0.86,
          metallicLevel: 0.0,
          uScale: 1.0,
          vScale: 1.0,
          uOffset: 0.0,
          vOffset: 0.0,
          normalLevel: 0.36,
          enableBaseColorTex: true,
          enableRoughnessTex: true,
          enableNormalTex: true,
          showMowingStripes: false,
          mowingStripeWidth: 1.6,
          mowingStripeContrast: 0.0,
          showCollarRings: true,
          collarWidth: 1.2,
          customTextureUrls: {
            color: '/textures/bunker_sand_01.jpg',
            colorName: 'bunker_sand_01.jpg',
            roughness: sandRoughUrl,
            roughnessName: 'sand_grain_rough.png',
            normal: sandNorUrl,
            normalName: 'sand_grain_nor.png'
          }
        };
      case SurfaceType.FAIRWAY:
        return applyPreferredGrass({
          baseColor: '#38b000',
          colorTexLevel: 0.72,
          roughnessLevel: 0.65,
          metallicLevel: 0.0,
          uScale: 1.0,
          vScale: 1.0,
          uOffset: 0.0,
          vOffset: 0.0,
          normalLevel: 0.35,
          enableBaseColorTex: true,
          enableRoughnessTex: true,
          enableNormalTex: true,
          showMowingStripes: true,
          mowingStripeWidth: 4.6,
          mowingStripeContrast: 0.5,
          showCollarRings: true,
          collarWidth: 2.0,
          customTextureUrls: {
            color: '/textures/short_grass_01.jpg',
            colorName: 'short_grass_01.jpg',
            roughness: '/textures/pbr_grass/grass_pbr_rough_512.jpg',
            roughnessName: 'grass_pbr_rough_512.jpg',
            normal: '/textures/pbr_grass/grass_pbr_nor_1k.jpg',
            normalName: 'grass_pbr_nor_1k.jpg'
          }
        });
      case SurfaceType.TEE:
        return applyPreferredGrass({
          baseColor: '#43a047',
          colorTexLevel: 0.72,
          roughnessLevel: 0.65,
          metallicLevel: 0.0,
          uScale: 1.0,
          vScale: 1.0,
          uOffset: 0.0,
          vOffset: 0.0,
          normalLevel: 0.35,
          enableBaseColorTex: true,
          enableRoughnessTex: true,
          enableNormalTex: true,
          showMowingStripes: true,
          mowingStripeWidth: 1.6,
          mowingStripeContrast: 0.5,
          showCollarRings: true,
          collarWidth: 0.5,
          customTextureUrls: {
            color: '/textures/short_grass_01.jpg',
            colorName: 'short_grass_01.jpg',
            roughness: '/textures/pbr_grass/grass_pbr_rough_512.jpg',
            roughnessName: 'grass_pbr_rough_512.jpg',
            normal: '/textures/pbr_grass/grass_pbr_nor_1k.jpg',
            normalName: 'grass_pbr_nor_1k.jpg'
          }
        });
      case SurfaceType.WATER:
        return {
          baseColor: '#2d5a58',
          colorTexLevel: 0.68,
          roughnessLevel: 0.55,
          metallicLevel: 0.05,
          uScale: 1.0,
          vScale: 1.0,
          uOffset: 0.0,
          vOffset: 0.0,
          normalLevel: 0.55,
          enableBaseColorTex: true,
          enableRoughnessTex: true,
          enableNormalTex: true,
          showCollarRings: true,
          collarWidth: 2.15,
          customTextureUrls: {
            color: '/textures/pbr_rough/brown_mud_leaves_diff_512.jpg',
            colorName: 'brown_mud_leaves_diff_512.jpg',
            roughness: '/textures/pbr_rough/brown_mud_leaves_rough_512.jpg',
            roughnessName: 'brown_mud_leaves_rough_512.jpg',
            normal: '/textures/pbr_rough/brown_mud_leaves_nor_512.jpg',
            normalName: 'brown_mud_leaves_nor_512.jpg'
          }
        };
      default:
        return {
          baseColor: '#558b2f',
          colorTexLevel: 0.78,
          roughnessLevel: 0.76,
          metallicLevel: 0.0,
          uScale: 1.0,
          vScale: 1.0,
          uOffset: 0.0,
          vOffset: 0.0,
          normalLevel: 0.45,
          enableBaseColorTex: true,
          enableRoughnessTex: true,
          enableNormalTex: true,
          showCollarRings: true,
          collarWidth: 1.0,
          customTextureUrls: {
            color: '/textures/pbr_grass/grass_pbr_diff_1k.jpg',
            colorName: 'grass_pbr_diff_1k.jpg',
            roughness: '/textures/pbr_grass/grass_pbr_rough_512.jpg',
            roughnessName: 'grass_pbr_rough_512.jpg',
            normal: '/textures/pbr_grass/grass_pbr_nor_1k.jpg',
            normalName: 'grass_pbr_nor_1k.jpg'
          }
        };
    }
  }

  /**
   * Returns default material settings calibrated for each surface type.
   */
  public getDefaultFeatureMaterial(surface: SurfaceType): FeatureMaterialSettings {
    return this.getDefaultSubMaterial(surface, 'surface');
  }

  public getFeatureSubMaterialSettings(
    index: number,
    subId: FeatureSubMaterialId
  ): FeatureMaterialSettings {
    const feat = this.stampedFeatures[index];
    if (!feat) return this.getDefaultSubMaterial(SurfaceType.FAIRWAY, subId);
    if (!feat.subMaterials) feat.subMaterials = {};

    if (subId === 'surface') {
      if (!feat.materialSettings) {
        feat.materialSettings = this.getDefaultSubMaterial(feat.surfaceType, 'surface');
      }
      if (feat.customTile && !feat.materialSettings.customTile) {
        feat.materialSettings.customTile = feat.customTile;
      }
      if (feat.customTextureUrls && !feat.materialSettings.customTextureUrls) {
        feat.materialSettings.customTextureUrls = { ...feat.customTextureUrls };
      }
      if (feat.materialSettings.customTextureUrls) {
        feat.materialSettings.customTextureUrls.color = TerrainGrid.sanitizeTextureUrl(feat.materialSettings.customTextureUrls.color, 'color');
        feat.materialSettings.customTextureUrls.roughness = TerrainGrid.sanitizeTextureUrl(feat.materialSettings.customTextureUrls.roughness, 'roughness');
        feat.materialSettings.customTextureUrls.normal = TerrainGrid.sanitizeTextureUrl(feat.materialSettings.customTextureUrls.normal, 'normal');
      }
      feat.subMaterials.surface = feat.materialSettings;
      return feat.materialSettings;
    }

    if (!feat.subMaterials[subId]) {
      const def = this.getDefaultSubMaterial(feat.surfaceType, subId);
      // Mirror collar toggle/width if primary surface was previously customized
      if (subId === 'fringe' && feat.materialSettings) {
        if (feat.materialSettings.showCollarRings !== undefined) {
          def.showCollarRings = feat.materialSettings.showCollarRings;
        }
        if (feat.materialSettings.collarWidth !== undefined) {
          def.collarWidth = feat.materialSettings.collarWidth;
        }
      }
      feat.subMaterials[subId] = def;
    }
    return feat.subMaterials[subId]!;
  }

  public setActiveFeatureSelection(index: number, subId: FeatureSubMaterialId = 'surface') {
    this.activeSelectedFeatureIdx = index;
    this.activeSelectedSubMatId = subId;
    this.syncPluginLayerState();
  }

  private getOrRegisterLayerId(featIdx: number, subId: FeatureSubMaterialId): number {
    const key = `${featIdx}:${subId}`;
    const existing = this.layerIdMap.get(key);
    if (existing !== undefined) return existing;
    const nextId = Math.min(255, this.layerList.length + 1);
    this.layerIdMap.set(key, nextId);
    this.layerList.push({ featIdx, subId });
    return nextId;
  }

  private rebuildLayerRegistry() {
    this.layerIdMap.clear();
    this.layerList = [];
    for (let i = 0; i < this.stampedFeatures.length; i++) {
      const f = this.stampedFeatures[i];
      if (f.surfaceType === SurfaceType.WATER || f.surfaceType === SurfaceType.TEE) {
        this.getOrRegisterLayerId(i, 'surface');
        this.getOrRegisterLayerId(i, 'fringe');
      } else if (f.surfaceType === SurfaceType.FRINGE || f.surfaceType === SurfaceType.FIRST_CUT || f.surfaceType === SurfaceType.ROUGH) {
        this.getOrRegisterLayerId(i, 'surface');
      } else {
        this.getOrRegisterLayerId(i, 'surface');
        this.getOrRegisterLayerId(i, 'fringe');
        this.getOrRegisterLayerId(i, 'first_cut');
      }
    }
  }

  /**
   * Uploads every feature sub-layer's independent UV Scale/Offset, Color Texture level,
   * Roughness, Normal Relief, and Texture Kind into the 256x2 RGBA32F GPU parameter LUT in <0.05ms.
   */
  private syncLayerPropsLut() {
    const data = this.layerPropsData;
    // Row 0 slot 0: fallback default turf
    data[0] = 110.0;
    data[1] = 230.0;
    data[2] = 0.0;
    data[3] = 0.0;
    // Row 1 slot 0
    data[256 * 4 + 0] = 0.72;
    data[256 * 4 + 1] = 0.72;
    data[256 * 4 + 2] = 0.40;
    data[256 * 4 + 3] = 0.0;
    // Row 2 slot 0 (metallic + baseColor RGB)
    const fallbackBase = Color3.FromHexString('#35a043');
    data[256 * 2 * 4 + 0] = 0.0;
    data[256 * 2 * 4 + 1] = fallbackBase.r;
    data[256 * 2 * 4 + 2] = fallbackBase.g;
    data[256 * 2 * 4 + 3] = fallbackBase.b;

    for (let idx = 0; idx < this.layerList.length; idx++) {
      const lid = idx + 1;
      if (lid > 255) break;
      const entry = this.layerList[idx];
      const feat = this.stampedFeatures[entry.featIdx];
      if (!feat) continue;
      const mat = this.getFeatureSubMaterialSettings(entry.featIdx, entry.subId);
      const isSand = feat.surfaceType === SurfaceType.BUNKER && entry.subId === 'surface';
      const isBunkerLip = feat.surfaceType === SurfaceType.BUNKER && entry.subId === 'fringe';
      const isWaterBed = feat.surfaceType === SurfaceType.WATER && (entry.subId === 'surface' || entry.subId === 'shore');
      const isFirstCut = entry.subId === 'first_cut' || feat.surfaceType === SurfaceType.FIRST_CUT;
      const key = `${entry.featIdx}:${entry.subId}`;
      const hasCustom = Boolean(
        (mat.customColorTex && mat.customColorTex.isReady()) ||
        (mat.customNormalTex && mat.customNormalTex.isReady()) ||
        (mat.customRoughTex && mat.customRoughTex.isReady())
      );

      let matKind = 0.0; // short grass turf
      if (hasCustom && key === this.activeCustomUploadKey) {
        matKind = 4.0;
      } else if (isSand) {
        matKind = 2.0;
      } else if (isWaterBed) {
        matKind = 3.0;
      } else if (isFirstCut) {
        matKind = 1.0;
      }

      const defaultColMix = isSand ? 1.0 : isBunkerLip ? 0.78 : isWaterBed ? 0.65 : isFirstCut ? 0.80 : 0.72;
      const colMix = mat.enableBaseColorTex === false
        ? 0.0
        : Math.max(0.0, Math.min(1.0, mat.colorTexLevel ?? defaultColMix));
      const roughVal = mat.enableRoughnessTex === false
        ? -1.0
        : Math.max(0.0, Math.min(1.0, mat.roughnessLevel ?? (isSand ? 0.86 : 0.72)));
      const normLvl = mat.enableNormalTex === false
        ? 0.0
        : Math.max(0.0, Math.min(2.5, mat.normalLevel ?? (isSand ? 0.36 : 0.40)));

      const r0 = lid * 4;
      data[r0 + 0] = Math.max(0.01, mat.uScale ?? 1.0) * 110.0;
      data[r0 + 1] = Math.max(0.01, mat.vScale ?? 1.0) * 230.0;
      data[r0 + 2] = mat.uOffset ?? 0.0;
      data[r0 + 3] = mat.vOffset ?? 0.0;

      const r1 = (256 + lid) * 4;
      data[r1 + 0] = colMix;
      data[r1 + 1] = roughVal;
      data[r1 + 2] = normLvl;
      data[r1 + 3] = matKind;

      const r2 = (256 * 2 + lid) * 4;
      const metallicVal = mat.metallicLevel !== undefined
        ? Math.max(0.0, Math.min(1.0, mat.metallicLevel))
        : (isWaterBed ? 0.05 : 0.0);
      const fallbackHex = isSand
        ? '#d8c28a'
        : isBunkerLip
        ? '#3d8b37'
        : isWaterBed
        ? '#2d5a58'
        : isFirstCut
        ? '#488a32'
        : feat.surfaceType === SurfaceType.GREEN
        ? '#28a745'
        : '#35a043';
      const hexStr = (mat.baseColor && /^#[0-9a-fA-F]{6}$/.test(mat.baseColor)) ? mat.baseColor : fallbackHex;
      const baseC = Color3.FromHexString(hexStr);
      data[r2 + 0] = metallicVal;
      data[r2 + 1] = baseC.r;
      data[r2 + 2] = baseC.g;
      data[r2 + 3] = baseC.b;
    }

    if (this.layerPropsTex) {
      this.layerPropsTex.update(this.layerPropsData);
    }
  }

  private syncPluginLayerState() {
    if (!this.groundShaderPlugin) return;
    const plugin = this.groundShaderPlugin;

    // Keep persistent Sand & Water Bed default/edited textures bound independently of active tab
    const trackedBunkerIdx =
      this.lastEditedSandFeatureIdx >= 0 &&
      this.stampedFeatures[this.lastEditedSandFeatureIdx]?.surfaceType === SurfaceType.BUNKER
        ? this.lastEditedSandFeatureIdx
        : this.stampedFeatures.findIndex(f => f.surfaceType === SurfaceType.BUNKER);
    const refSand = trackedBunkerIdx >= 0
      ? this.getFeatureSubMaterialSettings(trackedBunkerIdx, 'surface')
      : this.getDefaultSubMaterial(SurfaceType.BUNKER, 'surface');

    plugin.sandColorTex = (refSand.customColorTex && refSand.customColorTex.isReady())
      ? refSand.customColorTex
      : this.defaultSandColorTex;

    const trackedWaterIdx =
      this.lastEditedWaterFeatureIdx >= 0 &&
      this.stampedFeatures[this.lastEditedWaterFeatureIdx]?.surfaceType === SurfaceType.WATER
        ? this.lastEditedWaterFeatureIdx
        : this.stampedFeatures.findIndex(f => f.surfaceType === SurfaceType.WATER);
    const refWater = trackedWaterIdx >= 0
      ? this.getFeatureSubMaterialSettings(trackedWaterIdx, 'surface')
      : this.getDefaultSubMaterial(SurfaceType.WATER, 'surface');

    plugin.waterBedColorTex = (refWater.customColorTex && refWater.customColorTex.isReady())
      ? refWater.customColorTex
      : this.defaultWaterBedColorTex;

    // Bind custom uploaded texture slot cleanly without switching/clearing on unrelated pill clicks
    let customFeatIdx = -1;
    let customSubId: FeatureSubMaterialId = 'surface';
    if (this.activeCustomUploadKey) {
      const [fi, sid] = this.activeCustomUploadKey.split(':');
      customFeatIdx = parseInt(fi, 10);
      customSubId = sid as FeatureSubMaterialId;
    }
    if (customFeatIdx >= 0 && customFeatIdx < this.stampedFeatures.length) {
      const cFeat = this.stampedFeatures[customFeatIdx];
      const cMat = this.getFeatureSubMaterialSettings(customFeatIdx, customSubId);
      const isCWater = cFeat.surfaceType === SurfaceType.WATER && (customSubId === 'surface' || customSubId === 'shore');
      const isCSand = cFeat.surfaceType === SurfaceType.BUNKER && customSubId === 'surface';
      const defCol = isCSand
        ? this.defaultSandColorTex
        : isCWater
        ? this.defaultWaterBedColorTex
        : customSubId === 'first_cut'
        ? this.pbrGrassColorTex
        : this.defaultTurfColorTex;
      const defNorm = isCSand
        ? this.sandNormalTex
        : isCWater
        ? (this.defaultWaterBedNormalTex || this.pbrGrassNormalTex)
        : this.pbrGrassNormalTex;
      const defRough = isCSand
        ? this.sandRoughTex
        : isCWater
        ? (this.defaultWaterBedRoughTex || this.pbrGrassRoughTex)
        : this.pbrGrassRoughTex;

      plugin.featColorTex = (cMat.customColorTex && cMat.customColorTex.isReady()) ? cMat.customColorTex : defCol;
      plugin.featNormalTex = (cMat.customNormalTex && cMat.customNormalTex.isReady()) ? cMat.customNormalTex : defNorm;
      plugin.featRoughTex = (cMat.customRoughTex && cMat.customRoughTex.isReady()) ? cMat.customRoughTex : defRough;
    } else {
      plugin.featColorTex = this.defaultTurfColorTex;
      plugin.featNormalTex = (refSand.customNormalTex && refSand.customNormalTex.isReady()) ? refSand.customNormalTex : this.sandNormalTex;
      plugin.featRoughTex = (refSand.customRoughTex && refSand.customRoughTex.isReady()) ? refSand.customRoughTex : this.sandRoughTex;
    }

    this.syncLayerPropsLut();
    this.terrainMaterial?.markAsDirty(Material.TextureDirtyFlag);
    this.terrainMaterial?.resetDrawCache();
  }

  public updateFeatureSubMaterial(
    index: number,
    subId: FeatureSubMaterialId,
    settings: Partial<FeatureMaterialSettings>
  ) {
    if (index < 0 || index >= this.stampedFeatures.length) return;
    if (subId === 'water_surface') return; // Handled on the 3D Water Mesh in MainScene
    const feat = this.stampedFeatures[index];
    const targetMat = this.getFeatureSubMaterialSettings(index, subId);
    Object.assign(targetMat, settings);

    if (subId === 'surface') {
      feat.materialSettings = targetMat;
      // Preserve Championship Tee Box grass edits as the default template for all new feature grass materials
      if (feat.surfaceType === SurfaceType.TEE) {
        this.preferredGrassMatTemplate = {
          colorTexLevel: targetMat.colorTexLevel,
          roughnessLevel: targetMat.roughnessLevel,
          metallicLevel: targetMat.metallicLevel,
          normalLevel: targetMat.normalLevel,
          uScale: targetMat.uScale,
          vScale: targetMat.vScale,
          enableBaseColorTex: targetMat.enableBaseColorTex,
          enableRoughnessTex: targetMat.enableRoughnessTex,
          enableNormalTex: targetMat.enableNormalTex,
          customTextureUrls: targetMat.customTextureUrls ? { ...targetMat.customTextureUrls } : undefined
        };
      }
    } else if (subId === 'fringe' && (settings.showCollarRings !== undefined || settings.collarWidth !== undefined)) {
      if (!feat.materialSettings) feat.materialSettings = this.getDefaultFeatureMaterial(feat.surfaceType);
      if (settings.showCollarRings !== undefined) feat.materialSettings.showCollarRings = settings.showCollarRings;
      if (settings.collarWidth !== undefined) feat.materialSettings.collarWidth = settings.collarWidth;
    }

    if (settings.showCollarRings !== undefined || settings.collarWidth !== undefined) {
      const fringeMat = this.getFeatureSubMaterialSettings(index, 'fringe');
      if (settings.showCollarRings !== undefined) fringeMat.showCollarRings = settings.showCollarRings;
      if (settings.collarWidth !== undefined) fringeMat.collarWidth = settings.collarWidth;
    }

    if (feat.surfaceType === SurfaceType.BUNKER && subId === 'surface') {
      this.lastEditedSandFeatureIdx = index;
    } else if (feat.surfaceType === SurfaceType.WATER && (subId === 'surface' || subId === 'shore')) {
      this.lastEditedWaterFeatureIdx = index;
    }

    this.activeSelectedFeatureIdx = index;
    this.activeSelectedSubMatId = subId;
    this.syncLayerPropsLut();

    // Base color, mowing stripes, and collar ring widths update analytical uniforms or splat texture;
    // UV Scale/Offset, Color Texture mix, Roughness, Normal Relief, and map toggles update GPU LUT instantaneously with zero stall!
    const needsCanvasUpdate =
      settings.baseColor !== undefined ||
      settings.showMowingStripes !== undefined ||
      settings.mowingStripeWidth !== undefined ||
      settings.mowingStripeContrast !== undefined ||
      settings.showCollarRings !== undefined ||
      settings.collarWidth !== undefined;
    if (needsCanvasUpdate) {
      if (
        feat.surfaceType === SurfaceType.BUNKER ||
        feat.surfaceType === SurfaceType.GREEN ||
        feat.surfaceType === SurfaceType.WATER ||
        feat.surfaceType === SurfaceType.TEE
      ) {
        this.syncAnalyticalFeatureUniforms();
        if (feat.contour && feat.contour.length >= 3) {
          this.redrawSplatTexture();
        }
        if (
          (feat.surfaceType === SurfaceType.BUNKER || feat.surfaceType === SurfaceType.WATER || feat.surfaceType === SurfaceType.TEE) &&
          (settings.showCollarRings !== undefined || settings.collarWidth !== undefined)
        ) {
          this.rebuildMesh(false);
        }
      } else {
        if (feat.contour && feat.contour.length >= 3 && this.groundShaderPlugin) {
          const sMat = this.getFeatureSubMaterialSettings(index, 'surface');
          if (feat.surfaceType === SurfaceType.FAIRWAY) {
            this.groundShaderPlugin.tracedFairwayStripes = [
              sMat.showMowingStripes !== false ? 1.0 : 0.0,
              sMat.mowingStripeWidth ?? 4.6,
              sMat.mowingStripeContrast !== undefined ? sMat.mowingStripeContrast : 0.5,
              feat.rotationRad || 0
            ];
          }
        }
        this.redrawSplatTexture();
      }
      if (feat.contour && feat.contour.length >= 3 && feat.surfaceType === SurfaceType.GREEN && this.groundShaderPlugin) {
        const sMat = this.getFeatureSubMaterialSettings(index, 'surface');
        this.groundShaderPlugin.tracedGreenStripes = [
          sMat.showMowingStripes !== false ? 1.0 : 0.0,
          sMat.mowingStripeWidth ?? 1.8,
          sMat.mowingStripeContrast !== undefined ? sMat.mowingStripeContrast : 0.45,
          feat.rotationRad || 0
        ];
      }
      if (feat.contour && feat.contour.length >= 3 && feat.surfaceType === SurfaceType.TEE && this.groundShaderPlugin) {
        const sMat = this.getFeatureSubMaterialSettings(index, 'surface');
        const fMat = this.getFeatureSubMaterialSettings(index, 'fringe');
        const showCollar = fMat.showCollarRings !== false && sMat.showCollarRings !== false;
        const collarW = fMat.collarWidth ?? sMat.collarWidth ?? 0.50;
        this.groundShaderPlugin.tracedTeeIds[2] = collarW;
        this.groundShaderPlugin.tracedTeeIds[3] = showCollar ? 1 : 0;
        this.groundShaderPlugin.tracedTeeStripes = [
          sMat.showMowingStripes !== false ? 1.0 : 0.0,
          sMat.mowingStripeWidth ?? 1.6,
          sMat.mowingStripeContrast !== undefined ? sMat.mowingStripeContrast : 0.48,
          feat.rotationRad || 0
        ];
      }
    }
  }

  public resetFeatureSubMaterial(index: number, subId: FeatureSubMaterialId) {
    if (index < 0 || index >= this.stampedFeatures.length) return;
    if (subId === 'water_surface') return;
    const feat = this.stampedFeatures[index];
    const oldMat = feat.subMaterials?.[subId];
    if (oldMat?.customColorTex && oldMat.customColorTex !== this.defaultTurfColorTex && oldMat.customColorTex !== this.defaultSandColorTex && oldMat.customColorTex !== this.defaultWaterBedColorTex && oldMat.customColorTex !== this.pbrGrassColorTex) {
      oldMat.customColorTex.dispose();
    }
    if (oldMat?.customNormalTex && oldMat.customNormalTex !== this.pbrGrassNormalTex && oldMat.customNormalTex !== this.sandNormalTex && oldMat.customNormalTex !== this.defaultWaterBedNormalTex) {
      oldMat.customNormalTex.dispose();
    }
    if (oldMat?.customRoughTex && oldMat.customRoughTex !== this.pbrGrassRoughTex && oldMat.customRoughTex !== this.sandRoughTex && oldMat.customRoughTex !== this.defaultWaterBedRoughTex) {
      oldMat.customRoughTex.dispose();
    }
    const fresh = this.getDefaultSubMaterial(feat.surfaceType, subId);
    if (!feat.subMaterials) feat.subMaterials = {};
    feat.subMaterials[subId] = fresh;
    if (subId === 'surface') {
      feat.materialSettings = fresh;
      feat.customTile = undefined;
      feat.customTextureUrls = undefined;
    }
    if (this.activeCustomUploadKey === `${index}:${subId}`) {
      this.activeCustomUploadKey = null;
    }
    if (feat.surfaceType === SurfaceType.BUNKER && subId === 'surface') {
      this.lastEditedSandFeatureIdx = index;
    } else if (feat.surfaceType === SurfaceType.WATER && (subId === 'surface' || subId === 'shore')) {
      this.lastEditedWaterFeatureIdx = index;
    }

    this.activeSelectedFeatureIdx = index;
    this.activeSelectedSubMatId = subId;
    this.syncPluginLayerState();
    if (
      feat.surfaceType === SurfaceType.BUNKER ||
      feat.surfaceType === SurfaceType.GREEN ||
      feat.surfaceType === SurfaceType.WATER ||
      feat.surfaceType === SurfaceType.TEE
    ) {
      this.syncAnalyticalFeatureUniforms();
      if (feat.contour && feat.contour.length >= 3) {
        this.redrawSplatTexture();
      }
      if (feat.surfaceType === SurfaceType.BUNKER || feat.surfaceType === SurfaceType.WATER || feat.surfaceType === SurfaceType.TEE) {
        this.rebuildMesh(false);
      }
    } else {
      this.redrawSplatTexture();
    }
  }

  public async setFeatureSubMaterialTexture(
    index: number,
    subId: FeatureSubMaterialId,
    slot: 'color' | 'roughness' | 'normal',
    dataUrl: string,
    fileName: string
  ) {
    if (index < 0 || index >= this.stampedFeatures.length) return;
    if (subId === 'water_surface') return;
    const feat = this.stampedFeatures[index];
    const targetMat = this.getFeatureSubMaterialSettings(index, subId);
    if (!targetMat.customTextureUrls) {
      targetMat.customTextureUrls = { ...(this.getDefaultSubMaterial(feat.surfaceType, subId).customTextureUrls || {}) };
    }
    targetMat.customTextureUrls[slot] = dataUrl;
    if (slot === 'color') targetMat.customTextureUrls.colorName = fileName;
    else if (slot === 'roughness') targetMat.customTextureUrls.roughnessName = fileName;
    else if (slot === 'normal') targetMat.customTextureUrls.normalName = fileName;

    if (subId === 'surface') {
      feat.customTextureUrls = targetMat.customTextureUrls;
    }

    const tex = new Texture(dataUrl, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.name = fileName;
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;

    if (slot === 'color') {
      targetMat.customColorTex = tex;
      targetMat.enableBaseColorTex = true;
      if ((targetMat.colorTexLevel ?? 1.0) < 0.05) {
        targetMat.colorTexLevel = 1.0;
      }
    } else if (slot === 'normal') {
      targetMat.customNormalTex = tex;
      targetMat.enableNormalTex = true;
    } else if (slot === 'roughness') {
      targetMat.customRoughTex = tex;
      targetMat.enableRoughnessTex = true;
    }

    this.activeCustomUploadKey = `${index}:${subId}`;
    tex.onLoadObservable.addOnce(() => {
      this.syncPluginLayerState();
    });
    if (feat.surfaceType === SurfaceType.BUNKER && subId === 'surface') {
      this.lastEditedSandFeatureIdx = index;
    } else if (feat.surfaceType === SurfaceType.WATER && (subId === 'surface' || subId === 'shore')) {
      this.lastEditedWaterFeatureIdx = index;
    }

    this.activeSelectedFeatureIdx = index;
    this.activeSelectedSubMatId = subId;
    this.syncPluginLayerState();
  }

  /**
   * Real-time update of material and UV settings for a specific course feature (defaults to primary surface).
   */
  public updateFeatureMaterial(index: number, settings: Partial<FeatureMaterialSettings>) {
    this.updateFeatureSubMaterial(index, 'surface', settings);
  }

  /**
   * Resets material and UV settings for a specific course feature to default.
   */
  public resetFeatureMaterial(index: number) {
    if (index < 0 || index >= this.stampedFeatures.length) return;
    const feat = this.stampedFeatures[index];
    feat.subMaterials = {};
    this.resetFeatureSubMaterial(index, 'surface');
  }

  /**
   * Sets custom uploaded texture map on a specific course feature primary surface.
   */
  public async setFeatureTexture(
    index: number,
    slot: 'color' | 'roughness' | 'normal',
    dataUrl: string,
    fileName: string
  ) {
    return this.setFeatureSubMaterialTexture(index, 'surface', slot, dataUrl, fileName);
  }

  /**
   * Sets custom uploaded texture map on the main ground PBR material & rough terrain splat layer.
   */
  public async setGroundTexture(
    slot: 'color' | 'roughness' | 'normal',
    dataUrl: string,
    fileName: string
  ) {
    this.groundCustomTextureUrls[slot] = dataUrl;
    if (slot === 'color') this.groundCustomTextureUrls.colorName = fileName;
    else if (slot === 'roughness') this.groundCustomTextureUrls.roughnessName = fileName;
    else if (slot === 'normal') this.groundCustomTextureUrls.normalName = fileName;

    if (slot === 'color') {
      const img = new Image();
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = dataUrl;
      });
      // Keep a compact 256x256 proxy tile for fast edge-average color extraction without duplicating 4K/8K pixels on CPU
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(256, img.naturalWidth || img.width || 256);
      canvas.height = Math.min(256, img.naturalHeight || img.height || 256);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      this.roughPhotoTile = canvas;
      this.groundEnableBaseColorTex = true;

      const prevColorTex = this.pbrGrassColorTex;
      const tex = new Texture(dataUrl, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      tex.name = fileName;
      tex.uScale = this.groundUvScaleU;
      tex.vScale = this.groundUvScaleV;
      tex.uOffset = this.groundUvOffsetU;
      tex.vOffset = this.groundUvOffsetV;
      tex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;
      this.pbrGrassColorTex = tex;

      if (this.groundShaderPlugin) {
        this.groundShaderPlugin.groundColorTex = tex;
        this.groundShaderPlugin.enableGroundColorTex = true;
      }
      tex.onLoadObservable.addOnce(() => {
        this.terrainMaterial?.markAsDirty(Material.TextureDirtyFlag);
        this.terrainMaterial?.resetDrawCache();
      });
      if (prevColorTex && prevColorTex !== tex) {
        prevColorTex.dispose();
      }
      this.redrawSplatTexture();
      this.terrainMaterial?.markAsDirty(Material.TextureDirtyFlag);
      this.terrainMaterial?.resetDrawCache();
    } else if (slot === 'normal') {
      const prevNormalTex = this.pbrGrassNormalTex;
      const tex = new Texture(dataUrl, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      tex.name = fileName;
      tex.uScale = this.groundUvScaleU;
      tex.vScale = this.groundUvScaleV;
      tex.uOffset = this.groundUvOffsetU;
      tex.vOffset = this.groundUvOffsetV;
      tex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;
      tex.level = Math.max(0.0001, this.groundNormalLevel);
      this.pbrGrassNormalTex = tex;
      this.groundEnableNormalTex = true;
      if (this.terrainMaterial) {
        (this.terrainMaterial as any)._origGroundBumpTex = tex;
        this.terrainMaterial.bumpTexture = tex;
        this.terrainMaterial.markAsDirty(Material.TextureDirtyFlag);
        this.terrainMaterial.resetDrawCache();
      }
      if (prevNormalTex && prevNormalTex !== tex) {
        prevNormalTex.dispose();
      }
      this.syncPluginLayerState();
    } else if (slot === 'roughness') {
      const prevRoughTex = this.pbrGrassRoughTex;
      const tex = new Texture(dataUrl, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      tex.name = fileName;
      tex.uScale = Math.max(0.02, this.groundUvScaleU);
      tex.vScale = Math.max(0.02, this.groundUvScaleV);
      tex.uOffset = this.groundUvOffsetU;
      tex.vOffset = this.groundUvOffsetV;
      tex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;
      this.pbrGrassRoughTex = tex;
      this.groundEnableRoughnessTex = true;
      if (this.terrainMaterial) {
        if (this.terrainMaterial instanceof StandardMaterial) {
          this.terrainMaterial.specularTexture = tex;
        } else if (this.terrainMaterial instanceof PBRMaterial) {
          this.terrainMaterial.metallicTexture = null;
        }
        this.applyTerrainRoughnessAndColorState();
        this.terrainMaterial.markAsDirty(Material.TextureDirtyFlag);
        this.terrainMaterial.resetDrawCache();
      }
      if (prevRoughTex && prevRoughTex !== tex) {
        prevRoughTex.dispose();
      }
      this.syncPluginLayerState();
    }
  }

  /**
   * Helper to create a transformed CanvasPattern for a specific feature using DOMMatrix.
   * Scales and offsets smoothly around the feature's center, matching 3D UV tiling standards.
   */
  private getTransformedFeaturePattern(
    ctx: CanvasRenderingContext2D,
    tile: HTMLCanvasElement,
    baseScale: number,
    mat: FeatureMaterialSettings,
    centerX: number = 0,
    centerZ: number = 0
  ): CanvasPattern {
    const pat = ctx.createPattern(tile, 'repeat')!;
    if (typeof DOMMatrix !== 'undefined' && pat.setTransform) {
      // In 3D UV mapping, higher uScale = higher tiling frequency (smaller tile elements).
      // On Canvas2D, scale(s) stretches pixels larger, so we divide baseScale by uScale.
      const uScaleFactor = Math.max(0.05, mat.uScale ?? 1.0);
      const vScaleFactor = Math.max(0.05, mat.vScale ?? 1.0);
      const uS = Math.max(0.02, baseScale / uScaleFactor);
      const vS = Math.max(0.02, baseScale / vScaleFactor);

      const tileW = tile.width || 512;
      const tileH = tile.height || 512;
      const uO = (mat.uOffset ?? 0.0) * tileW * uS;
      const vO = (mat.vOffset ?? 0.0) * tileH * vS;

      pat.setTransform(
        new DOMMatrix()
          .translate(centerX + uO, centerZ + vO)
          .scale(uS, vS)
          .translate(-centerX, -centerZ)
      );
    }
    return pat;
  }

  public getFeaturePerimeterPoints(feat: StampedFeatureRecord): { x: number; z: number }[] {
    if (feat.contour && feat.contour.length >= 3) {
      return feat.contour;
    }

    const pts: { x: number; z: number }[] = [];
    const halfW = feat.width * 0.5;
    const halfL = feat.length * 0.5;

    if (feat.doglegPoints && feat.doglegPoints.length >= 4) {
      const splineSamples = 32;
      const leftSide: { x: number; z: number }[] = [];
      const rightSide: { x: number; z: number }[] = [];
      for (let i = 0; i <= splineSamples; i++) {
        const sp = this.evaluateSpline(feat.doglegPoints, i / splineSamples);
        leftSide.push({
          x: sp.x - sp.leftW * (-sp.tz),
          z: sp.z - sp.leftW * sp.tx
        });
        rightSide.push({
          x: sp.x + sp.rightW * (-sp.tz),
          z: sp.z + sp.rightW * sp.tx
        });
      }
      return [...leftSide, ...rightSide.reverse()];
    }

    const cosR = Math.cos(feat.rotationRad);
    const sinR = Math.sin(feat.rotationRad);
    const count = 128;

    if (feat.surfaceType === SurfaceType.BUNKER) {
      const shapeIdx = feat.bunkerShapeIndex ?? 0;
      for (let i = 0; i < count; i++) {
        const theta = (i / count) * Math.PI * 2;
        const k = TerrainGrid.getBunkerRadiusFactor(theta, shapeIdx);
        const lx = halfW * Math.cos(theta) * k * 0.96;
        const lz = halfL * Math.sin(theta) * k * 0.96;
        const wx = feat.centerX + lx * cosR - lz * sinR;
        const wz = feat.centerZ + lx * sinR + lz * cosR;
        pts.push({ x: wx, z: wz });
      }
      return pts;
    }

    if (feat.surfaceType === SurfaceType.TEE) {
      for (let i = 0; i < count; i++) {
        const theta = (i / count) * Math.PI * 2;
        const lx = halfW * 0.90 * Math.cos(theta);
        const lz = halfL * 0.90 * Math.sin(theta);
        const wx = feat.centerX + lx * cosR - lz * sinR;
        const wz = feat.centerZ + lx * sinR + lz * cosR;
        pts.push({ x: wx, z: wz });
      }
      return pts;
    }

    for (let i = 0; i < count; i++) {
      const theta = (i / count) * Math.PI * 2;
      const lx = halfW * Math.cos(theta);
      const lz = halfL * Math.sin(theta);
      const wx = feat.centerX + lx * cosR - lz * sinR;
      const wz = feat.centerZ + lx * sinR + lz * cosR;
      pts.push({ x: wx, z: wz });
    }
    return pts;
  }

  /**
   * Queries which stamped feature (if any) is located at world coordinate (worldX, worldZ).
   * Checks features in reverse order (top layer down: Bunkers -> Green -> Tee -> Water -> Fairway).
   */
  public findFeatureAt(worldX: number, worldZ: number): { feature: StampedFeatureRecord; index: number } | null {
    // 0. Check arbitrary traced contours first in tournament priority order
    const tracedPriority: SurfaceType[] = [
      SurfaceType.BUNKER,
      SurfaceType.WATER,
      SurfaceType.GREEN,
      SurfaceType.TEE,
      SurfaceType.FAIRWAY
    ];
    for (const targetType of tracedPriority) {
      for (let i = this.stampedFeatures.length - 1; i >= 0; i--) {
        const f = this.stampedFeatures[i];
        if (f.surfaceType !== targetType || !f.contour || f.contour.length < 3) continue;
        if (signedDistanceToPolygon(worldX, worldZ, f.contour) <= 3.0) {
          return { feature: f, index: i };
        }
      }
    }

    // 1. Direct query of surface type from terrain grid
    const surf = this.getSurfaceAt(worldX, worldZ);
    if (surf === SurfaceType.BUNKER) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < this.stampedFeatures.length; i++) {
        const f = this.stampedFeatures[i];
        if (f.surfaceType === SurfaceType.BUNKER) {
          const d = Math.hypot(f.centerX - worldX, f.centerZ - worldZ);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }
      }
      if (bestIdx >= 0) return { feature: this.stampedFeatures[bestIdx], index: bestIdx };
    } else if (surf === SurfaceType.WATER) {
      const idx = this.stampedFeatures.findIndex(f => f.surfaceType === SurfaceType.WATER);
      if (idx >= 0) return { feature: this.stampedFeatures[idx], index: idx };
    } else if (surf === SurfaceType.GREEN || surf === SurfaceType.FRINGE) {
      const idx = this.stampedFeatures.findIndex(f => f.surfaceType === SurfaceType.GREEN);
      if (idx >= 0) {
        const f = this.stampedFeatures[idx];
        const d = Math.hypot(f.centerX - worldX, f.centerZ - worldZ);
        if (d < Math.max(f.width, f.length) * 0.95) {
          return { feature: f, index: idx };
        }
      }
    } else if (surf === SurfaceType.TEE) {
      const idx = this.stampedFeatures.findIndex(f => f.surfaceType === SurfaceType.TEE);
      if (idx >= 0) return { feature: this.stampedFeatures[idx], index: idx };
    } else if (surf === SurfaceType.FAIRWAY || surf === SurfaceType.FIRST_CUT) {
      const idx = this.stampedFeatures.findIndex(f => f.surfaceType === SurfaceType.FAIRWAY);
      if (idx >= 0) return { feature: this.stampedFeatures[idx], index: idx };
    }

    // 2. Comprehensive Proximity Scan: check distance to each feature's boundary
    // Priority order: Bunkers > Water > Green > Tee > Fairway
    let bestBunkerIdx = -1;
    let bestBunkerDist = Infinity;
    for (let i = 0; i < this.stampedFeatures.length; i++) {
      const f = this.stampedFeatures[i];
      if (f.surfaceType === SurfaceType.BUNKER) {
        const cosR = Math.cos(-f.rotationRad);
        const sinR = Math.sin(-f.rotationRad);
        const dx = worldX - f.centerX;
        const dz = worldZ - f.centerZ;
        const localX = dx * cosR - dz * sinR;
        const localZ = dx * sinR + dz * cosR;
        const halfW = f.width * 0.5;
        const halfL = f.length * 0.5;
        const normDist = Math.hypot(localX / Math.max(1, halfW), localZ / Math.max(1, halfL));
        if (normDist <= 1.35 && normDist < bestBunkerDist) {
          bestBunkerDist = normDist;
          bestBunkerIdx = i;
        }
      }
    }
    if (bestBunkerIdx >= 0) {
      return { feature: this.stampedFeatures[bestBunkerIdx], index: bestBunkerIdx };
    }

    // Check Water, Green, Tee
    for (let i = 0; i < this.stampedFeatures.length; i++) {
      const f = this.stampedFeatures[i];
      if (f.surfaceType === SurfaceType.WATER || f.surfaceType === SurfaceType.GREEN || f.surfaceType === SurfaceType.TEE) {
        const cosR = Math.cos(-f.rotationRad);
        const sinR = Math.sin(-f.rotationRad);
        const dx = worldX - f.centerX;
        const dz = worldZ - f.centerZ;
        const localX = dx * cosR - dz * sinR;
        const localZ = dx * sinR + dz * cosR;
        const halfW = f.width * 0.5;
        const halfL = f.length * 0.5;
        const normDist = Math.hypot(localX / Math.max(1, halfW), localZ / Math.max(1, halfL));
        if (normDist <= 1.35) {
          return { feature: f, index: i };
        }
      }
    }

    // Check Fairway (spline)
    for (let i = 0; i < this.stampedFeatures.length; i++) {
      const f = this.stampedFeatures[i];
      if (f.doglegPoints && f.doglegPoints.length >= 4) {
        const samples = 36;
        for (let s = 0; s <= samples; s++) {
          const sp = this.evaluateSpline(f.doglegPoints, s / samples);
          const d = Math.hypot(worldX - sp.x, worldZ - sp.z);
          const maxAllowed = Math.max(sp.leftW, sp.rightW) + 4.5;
          if (d <= maxAllowed) {
            return { feature: f, index: i };
          }
        }
      }
    }

    return null;
  }

  private static distanceToSegment(px: number, pz: number, x1: number, z1: number, x2: number, z2: number): number {
    const l2 = (x2 - x1) * (x2 - x1) + (z2 - z1) * (z2 - z1);
    if (l2 === 0) return Math.hypot(px - x1, pz - z1);
    let t = ((px - x1) * (x2 - x1) + (pz - z1) * (z2 - z1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * (x2 - x1)), pz - (z1 + t * (z2 - z1)));
  }

  public buildMesh(skipInitialRebuild: boolean = false): Mesh {
    if (this.terrainMesh) {
      this.terrainMesh.dispose();
    }

    const mesh = new Mesh('GolfTerrain', this.scene);
    this.terrainMesh = mesh;

    const maskRes = TerrainGrid.MASK_RESOLUTION;
    this.splatTexture = new DynamicTexture(
      'terrainSplatTexture',
      { width: maskRes, height: maskRes },
      this.scene,
      true,
      Texture.TRILINEAR_SAMPLINGMODE
    );
    this.splatTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.splatTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.splatTexture.anisotropicFilteringLevel = Math.min(4, getDeviceProfile().maxAnisotropy);

    // 1. Packed Normal + Displacement map (RGB = NormalGL 4K, A = Displacement Height 4K)
    this.pbrGrassNormalTex = new Texture('/textures/pbr_grass/grass_pbr_nor_1k.jpg', this.scene);
    this.pbrGrassNormalTex.uScale = Math.max(0.02, this.groundUvScaleU);
    this.pbrGrassNormalTex.vScale = Math.max(0.02, this.groundUvScaleV);
    this.pbrGrassNormalTex.uOffset = this.groundUvOffsetU;
    this.pbrGrassNormalTex.vOffset = this.groundUvOffsetV;
    this.pbrGrassNormalTex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;
    this.pbrGrassNormalTex.level = this.groundNormalLevel;

    // 2. Color / Albedo map (Full-res GPU Color 2K)
    this.pbrGrassColorTex = new Texture('/textures/pbr_grass/grass_pbr_diff_1k.jpg', this.scene);
    this.pbrGrassColorTex.uScale = Math.max(0.02, this.groundUvScaleU);
    this.pbrGrassColorTex.vScale = Math.max(0.02, this.groundUvScaleV);
    this.pbrGrassColorTex.uOffset = this.groundUvOffsetU;
    this.pbrGrassColorTex.vOffset = this.groundUvOffsetV;
    this.pbrGrassColorTex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;

    // 3. Roughness map (Roughness 2K)
    this.pbrGrassRoughTex = new Texture('/textures/pbr_grass/grass_pbr_rough_512.jpg', this.scene);
    this.pbrGrassRoughTex.uScale = Math.max(0.02, this.groundUvScaleU);
    this.pbrGrassRoughTex.vScale = Math.max(0.02, this.groundUvScaleV);
    this.pbrGrassRoughTex.uOffset = this.groundUvOffsetU;
    this.pbrGrassRoughTex.vOffset = this.groundUvOffsetV;
    this.pbrGrassRoughTex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;

    // 4. Dedicated Full-Res GPU Feature Color Textures + Sand PBR + Water Bed Maps + 2048x2048 Bilinear Masks
    this.defaultTurfColorTex = new Texture('/textures/short_grass_01.jpg', this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    this.defaultTurfColorTex.wrapU = Texture.WRAP_ADDRESSMODE;
    this.defaultTurfColorTex.wrapV = Texture.WRAP_ADDRESSMODE;
    this.defaultTurfColorTex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;

    this.defaultSandColorTex = new Texture('/textures/bunker_sand_01.jpg', this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    this.defaultSandColorTex.wrapU = Texture.WRAP_ADDRESSMODE;
    this.defaultSandColorTex.wrapV = Texture.WRAP_ADDRESSMODE;
    this.defaultSandColorTex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;

    const sandPbr = RealisticTextures.createSeamlessSandTextures(this.scene);
    this.sandNormalTex = sandPbr.normal;
    this.sandRoughTex = sandPbr.roughness;

    this.defaultWaterBedColorTex = new Texture('/textures/pbr_rough/brown_mud_leaves_diff_512.jpg', this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    this.defaultWaterBedColorTex.wrapU = Texture.WRAP_ADDRESSMODE;
    this.defaultWaterBedColorTex.wrapV = Texture.WRAP_ADDRESSMODE;
    this.defaultWaterBedColorTex.anisotropicFilteringLevel = 8;

    this.defaultWaterBedNormalTex = new Texture('/textures/pbr_rough/brown_mud_leaves_nor_512.jpg', this.scene);
    this.defaultWaterBedNormalTex.wrapU = Texture.WRAP_ADDRESSMODE;
    this.defaultWaterBedNormalTex.wrapV = Texture.WRAP_ADDRESSMODE;
    this.defaultWaterBedNormalTex.anisotropicFilteringLevel = 8;
    this.defaultWaterBedRoughTex = new Texture('/textures/pbr_rough/brown_mud_leaves_rough_512.jpg', this.scene);
    this.defaultWaterBedRoughTex.wrapU = Texture.WRAP_ADDRESSMODE;
    this.defaultWaterBedRoughTex.wrapV = Texture.WRAP_ADDRESSMODE;
    this.defaultWaterBedRoughTex.anisotropicFilteringLevel = 8;

    this.surfaceMaskData = new Uint8Array(maskRes * maskRes * 4);
    this.surfaceMaskTex = RawTexture.CreateRGBATexture(
      this.surfaceMaskData,
      maskRes,
      maskRes,
      this.scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE
    );
    this.surfaceMaskTex.name = 'terrainSurfaceMask';
    this.surfaceMaskTex.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.surfaceMaskTex.wrapV = Texture.CLAMP_ADDRESSMODE;

    this.syncLayerPropsLut();
    this.layerPropsTex = RawTexture.CreateRGBATexture(
      this.layerPropsData,
      256,
      3,
      this.scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
      Constants.TEXTURETYPE_FLOAT
    );
    this.layerPropsTex.name = 'terrainLayerPropsLUT';
    this.layerPropsTex.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.layerPropsTex.wrapV = Texture.CLAMP_ADDRESSMODE;

    this.tracedSdfData = new Uint8Array(512 * 1024 * 4);
    this.tracedSdfData.fill(255);
    this.tracedSdfTex = RawTexture.CreateRGBATexture(
      this.tracedSdfData,
      512,
      1024,
      this.scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE
    );
    this.tracedSdfTex.name = 'terrainTracedSdfAtlas';
    this.tracedSdfTex.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.tracedSdfTex.wrapV = Texture.CLAMP_ADDRESSMODE;

    const mat = new PBRMaterial('terrainMat', this.scene);
    const plugin = new BunkerGrassExclusionPlugin(mat);
    plugin.groundColorTex = this.pbrGrassColorTex;
    plugin.groundRoughTex = this.pbrGrassRoughTex;
    plugin.fallbackSplatTex = this.splatTexture;
    plugin.surfaceMaskTex = this.surfaceMaskTex;
    plugin.layerPropsTex = this.layerPropsTex;
    plugin.tracedSdfTex = this.tracedSdfTex;
    plugin.satelliteOverlayTex = this.satelliteOverlayTex;
    plugin.satelliteOpacity = this.satelliteOpacity;
    plugin.satelliteEnabled = this.satelliteEnabled;
    plugin.overlayOverFeatures = this.overlayOverFeatures;
    plugin.sandColorTex = this.defaultSandColorTex;
    plugin.waterBedColorTex = this.defaultWaterBedColorTex;
    plugin.featColorTex = this.defaultTurfColorTex;
    plugin.featNormalTex = this.sandNormalTex || this.pbrGrassNormalTex;
    plugin.featRoughTex = this.sandRoughTex || this.pbrGrassRoughTex;
    plugin.groundBaseColor = Color3.FromHexString(this.groundBaseColor);
    plugin.groundColorTexLevel = this.groundColorTexLevel;
    plugin.groundRoughnessLevel = this.groundRoughnessLevel;
    plugin.groundMetallicLevel = this.groundMetallicLevel;
    plugin.enableGroundColorTex = this.groundEnableBaseColorTex;
    plugin.enableGroundRoughTex = this.groundEnableRoughnessTex;
    plugin.enableGroundNormalTex = this.groundEnableNormalTex;
    plugin.groundNormalLevel = this.groundNormalLevel;
    this.groundShaderPlugin = plugin;

    this.pbrGrassColorTex.onLoadObservable.addOnce(() => {
      this.terrainMaterial?.markAsDirty(Material.TextureDirtyFlag);
      this.terrainMaterial?.resetDrawCache();
    });
    this.defaultTurfColorTex.onLoadObservable.addOnce(() => {
      this.terrainMaterial?.markAsDirty(Material.TextureDirtyFlag);
      this.terrainMaterial?.resetDrawCache();
    });
    this.defaultSandColorTex.onLoadObservable.addOnce(() => {
      this.terrainMaterial?.markAsDirty(Material.TextureDirtyFlag);
      this.terrainMaterial?.resetDrawCache();
    });
    this.defaultWaterBedColorTex.onLoadObservable.addOnce(() => {
      this.terrainMaterial?.markAsDirty(Material.TextureDirtyFlag);
      this.terrainMaterial?.resetDrawCache();
    });

    mat.albedoTexture = this.splatTexture;
    // Keep bumpTexture attached so #ifdef BUMP stays compiled for ALL feature sub-layers
    mat.bumpTexture = this.pbrGrassNormalTex;
    mat.metallic = this.groundMetallicLevel;
    mat.roughness = this.groundRoughnessLevel;
    mat.albedoColor = Color3.White();
    (mat as any)._origGroundBumpTex = this.pbrGrassNormalTex;
    if (mat.detailMap) {
      // Legacy detailMap disabled: all course features sample full 2K/4K GPU Color/Normal/Roughness directly
      mat.detailMap.texture = null;
      mat.detailMap.isEnabled = false;
      mat.detailMap.diffuseBlendLevel = 0.0;
      mat.detailMap.roughnessBlendLevel = 0.0;
      mat.detailMap.bumpLevel = 0.0;
    }

    mat.backFaceCulling = false;
    mesh.material = mat;
    mesh.receiveShadows = true;
    this.terrainMaterial = mat;
    this.applyTerrainRoughnessAndColorState();
    this.syncPluginLayerState();
    this.syncBunkerShaderUniforms();

    if (!skipInitialRebuild) {
      this.redrawSplatTexture();
      this.rebuildMesh();
    }

    return mesh;
  }

  /**
   * Applies specular/roughness state cleanly via BunkerGrassExclusionPlugin so Ground
   * never overwrites independent Bunker Sand, Green, Fairway, or Water Bed specularity.
   */
  private applyTerrainRoughnessAndColorState() {
    if (!this.terrainMaterial) return;
    if (this.terrainMaterial instanceof PBRMaterial) {
      this.terrainMaterial.metallic = this.groundMetallicLevel;
      this.terrainMaterial.roughness = this.groundRoughnessLevel;
    } else {
      (this.terrainMaterial as StandardMaterial).specularTexture = this.pbrGrassRoughTex;
      (this.terrainMaterial as StandardMaterial).specularColor = new Color3(0.08, 0.08, 0.08);
      (this.terrainMaterial as StandardMaterial).specularPower = 32;
    }

    if (this.groundShaderPlugin) {
      this.groundShaderPlugin.groundColorTex = this.pbrGrassColorTex;
      this.groundShaderPlugin.groundRoughTex = this.pbrGrassRoughTex;
      this.groundShaderPlugin.groundBaseColor = Color3.FromHexString(this.groundBaseColor);
      this.groundShaderPlugin.groundColorTexLevel = this.groundColorTexLevel;
      this.groundShaderPlugin.groundRoughnessLevel = this.groundRoughnessLevel;
      this.groundShaderPlugin.groundMetallicLevel = this.groundMetallicLevel;
      this.groundShaderPlugin.enableGroundColorTex = this.groundEnableBaseColorTex;
      this.groundShaderPlugin.enableGroundRoughTex = this.groundEnableRoughnessTex;
      this.groundShaderPlugin.enableGroundNormalTex = this.groundEnableNormalTex;
      this.groundShaderPlugin.groundNormalLevel = this.groundNormalLevel;
    }
  }

  private scheduleGroundSplatRedraw() {
    if (this.groundSplatRaf !== null) return;
    this.groundSplatRaf = requestAnimationFrame(() => {
      this.groundSplatRaf = null;
      this.redrawSplatTexture();
    });
  }

  public setGroundUvSettings(settings: {
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
  }) {
    if (settings.baseColor !== undefined) {
      this.groundBaseColor = settings.baseColor;
    }
    if (settings.colorTexLevel !== undefined) {
      this.groundColorTexLevel = Math.max(0, Math.min(1, settings.colorTexLevel));
    }
    if (settings.enableBaseColorTex !== undefined) {
      this.groundEnableBaseColorTex = !!settings.enableBaseColorTex;
    }
    if (settings.uScale !== undefined) {
      this.groundUvScaleU = settings.uScale;
    }
    if (settings.vScale !== undefined) {
      this.groundUvScaleV = settings.vScale;
    }
    if (settings.uOffset !== undefined) {
      this.groundUvOffsetU = settings.uOffset;
    }
    if (settings.vOffset !== undefined) {
      this.groundUvOffsetV = settings.vOffset;
    }
    if (settings.roughnessLevel !== undefined) {
      this.groundRoughnessLevel = Math.max(0, Math.min(1, settings.roughnessLevel));
    }
    if (settings.metallicLevel !== undefined) {
      this.groundMetallicLevel = Math.max(0, Math.min(1, settings.metallicLevel));
    }
    if (settings.normalLevel !== undefined) this.groundNormalLevel = settings.normalLevel;
    if (settings.detailBlendLevel !== undefined) this.groundDetailBlendLevel = settings.detailBlendLevel;
    if (settings.enableRoughnessTex !== undefined) this.groundEnableRoughnessTex = !!settings.enableRoughnessTex;
    if (settings.enableNormalTex !== undefined) this.groundEnableNormalTex = !!settings.enableNormalTex;

    const applyUv = (t: Texture | null) => {
      if (!t) return;
      t.uScale = Math.max(0.02, this.groundUvScaleU);
      t.vScale = Math.max(0.02, this.groundUvScaleV);
      t.uOffset = this.groundUvOffsetU;
      t.vOffset = this.groundUvOffsetV;
    };

    applyUv(this.pbrGrassNormalTex);
    applyUv(this.pbrGrassColorTex);
    applyUv(this.pbrGrassRoughTex);

    this.applyTerrainRoughnessAndColorState();

    const effectiveGroundNormal = this.groundEnableNormalTex ? Math.max(0.0001, this.groundNormalLevel) : 0.0001;
    if (this.pbrGrassNormalTex) {
      this.pbrGrassNormalTex.level = effectiveGroundNormal;
    }
    if (this.terrainMaterial) {
      if (this.pbrGrassNormalTex) {
        applyUv(this.pbrGrassNormalTex);
        this.pbrGrassNormalTex.level = effectiveGroundNormal;
        this.terrainMaterial.bumpTexture = this.pbrGrassNormalTex;
      }

      if (this.terrainMaterial instanceof PBRMaterial) {
        this.terrainMaterial.metallic = this.groundMetallicLevel;
        this.terrainMaterial.roughness = this.groundRoughnessLevel;
      } else if (this.terrainMaterial.specularTexture) {
        applyUv(this.terrainMaterial.specularTexture as Texture);
      }

      if (this.terrainMaterial.detailMap) {
        this.terrainMaterial.detailMap.isEnabled = false;
        this.terrainMaterial.detailMap.diffuseBlendLevel = 0.0;
        this.terrainMaterial.detailMap.roughnessBlendLevel = 0.0;
        this.terrainMaterial.detailMap.bumpLevel = 0.0;
      }
      this.terrainMaterial.markAsDirty(Material.TextureDirtyFlag);
      this.terrainMaterial.resetDrawCache();
    }
  }

  public getGroundUvSettings() {
    return {
      baseColor: this.groundBaseColor,
      colorTexLevel: this.groundColorTexLevel,
      roughnessLevel: this.groundRoughnessLevel,
      metallicLevel: this.groundMetallicLevel,
      uScale: this.groundUvScaleU,
      vScale: this.groundUvScaleV,
      uOffset: this.groundUvOffsetU,
      vOffset: this.groundUvOffsetV,
      normalLevel: this.groundNormalLevel,
      detailBlendLevel: this.groundDetailBlendLevel,
      enableBaseColorTex: this.groundEnableBaseColorTex,
      enableRoughnessTex: this.groundEnableRoughnessTex,
      enableNormalTex: this.groundEnableNormalTex,
      colorMapUrl: TerrainGrid.sanitizeTextureUrl(this.groundCustomTextureUrls.color, 'color') || '/textures/pbr_grass/grass_pbr_diff_1k.jpg',
      colorMapName: this.groundCustomTextureUrls.colorName || 'grass_pbr_diff_1k.jpg',
      roughnessMapUrl: TerrainGrid.sanitizeTextureUrl(this.groundCustomTextureUrls.roughness, 'roughness') || '/textures/pbr_grass/grass_pbr_rough_512.jpg',
      roughnessMapName: this.groundCustomTextureUrls.roughnessName || 'grass_pbr_rough_512.jpg',
      normalMapUrl: TerrainGrid.sanitizeTextureUrl(this.groundCustomTextureUrls.normal, 'normal') || '/textures/pbr_grass/grass_pbr_nor_1k.jpg',
      normalMapName: this.groundCustomTextureUrls.normalName || 'grass_pbr_nor_1k.jpg',
      satelliteMapUrl: this.satellitePreviewDataUrl || undefined,
      satelliteOpacity: this.satelliteOpacity,
      satelliteEnabled: this.satelliteEnabled
    };
  }

  public exportTerrainState() {
    const compactHeights = new Array(this.heights.length);
    const compactBaseHeights = new Array(this.baseHeights.length);
    for (let i = 0; i < this.heights.length; i++) {
      compactHeights[i] = Math.round(this.heights[i] * 1000) / 1000;
      compactBaseHeights[i] = Math.round(this.baseHeights[i] * 1000) / 1000;
    }

    // RLE-compress courseBoundaryMask so full 18-hole MapNG projects save cleanly & compactly
    let courseBoundaryMaskRle: number[] | null = null;
    if (this.courseBoundaryMask && this.courseBoundaryMask.length === this.gridX * this.gridZ) {
      courseBoundaryMaskRle = [];
      let curVal = this.courseBoundaryMask[0];
      let runLen = 1;
      for (let i = 1; i < this.courseBoundaryMask.length; i++) {
        const v = this.courseBoundaryMask[i];
        if (v === curVal) {
          runLen++;
        } else {
          courseBoundaryMaskRle.push(curVal, runLen);
          curVal = v;
          runLen = 1;
        }
      }
      courseBoundaryMaskRle.push(curVal, runLen);
    }

    return {
      gridWidth: this.width,
      gridLength: this.length,
      cellSize: this.cellSize,
      baseHeights: compactBaseHeights,
      heights: compactHeights,
      surfaceTypes: Array.from(this.surfaceTypes),
      courseBoundaryMaskRle,
      satelliteDataUrl: this.satellitePreviewDataUrl || null,
      satelliteOpacity: this.satelliteOpacity,
      stampedFeatures: this.stampedFeatures.map(f => {
        const clean: Record<string, any> = {};
        for (const [k, v] of Object.entries(f)) {
          if (k === 'customTile' || k.startsWith('_')) continue;
          clean[k] = v;
        }
        return clean;
      }),
      groundSettings: this.getGroundUvSettings(),
      lastEditedSandFeatureIdx: this.lastEditedSandFeatureIdx,
      lastEditedWaterFeatureIdx: this.lastEditedWaterFeatureIdx,
      activeCustomUploadKey: this.activeCustomUploadKey
    };
  }

  public importTerrainState(state: any): boolean {
    if (!state) return false;
    try {
      const targetW =
        typeof state.gridWidth === 'number' && state.gridWidth > 0
          ? state.gridWidth
          : GOLF_CONSTANTS.DEFAULT_MAP_WIDTH;
      const targetL =
        typeof state.gridLength === 'number' && state.gridLength > 0
          ? state.gridLength
          : GOLF_CONSTANTS.DEFAULT_MAP_LENGTH;
      const targetCell =
        typeof state.cellSize === 'number' && state.cellSize > 0
          ? state.cellSize
          : 1;
      if (
        Math.abs(targetW - this.width) > 0.01 ||
        Math.abs(targetL - this.length) > 0.01 ||
        Math.abs(targetCell - this.cellSize) > 0.01
      ) {
        this.resizeGrid(targetW, targetL, targetCell, false);
      }
      this.playCorridorBounds = null;
      if (state.baseHeights && state.baseHeights.length === this.baseHeights.length) {
        this.baseHeights.set(state.baseHeights);
        this.pristineNaturalHeights = new Float32Array(this.baseHeights);
      }
      if (state.heights && state.heights.length === this.heights.length) {
        this.heights.set(state.heights);
      }
      if (state.surfaceTypes && state.surfaceTypes.length === this.surfaceTypes.length) {
        this.surfaceTypes.set(state.surfaceTypes);
      }
      if (Array.isArray(state.courseBoundaryMaskRle) && state.courseBoundaryMaskRle.length >= 2) {
        const decoded = new Uint8Array(this.gridX * this.gridZ);
        let ptr = 0;
        for (let i = 0; i + 1 < state.courseBoundaryMaskRle.length && ptr < decoded.length; i += 2) {
          const val = state.courseBoundaryMaskRle[i] ? 1 : 0;
          const cnt = Math.min(state.courseBoundaryMaskRle[i + 1] | 0, decoded.length - ptr);
          decoded.fill(val, ptr, ptr + cnt);
          ptr += cnt;
        }
        this.courseBoundaryMask = decoded;
      } else {
        this.courseBoundaryMask = null;
      }
      if (typeof state.satelliteDataUrl === 'string' && state.satelliteDataUrl.length > 0) {
        this.setSatelliteOverlayTexture(
          state.satelliteDataUrl,
          typeof state.satelliteOpacity === 'number' ? state.satelliteOpacity : 0.85
        );
      }
      if (Array.isArray(state.stampedFeatures)) {
        const sanitizeUrlObj = (u?: FeatureTextureUrls) => {
          if (!u) return u;
          return {
            ...u,
            color: TerrainGrid.sanitizeTextureUrl(u.color, 'color'),
            roughness: TerrainGrid.sanitizeTextureUrl(u.roughness, 'roughness'),
            normal: TerrainGrid.sanitizeTextureUrl(u.normal, 'normal')
          };
        };
        this.stampedFeatures = state.stampedFeatures.map((f: any) => {
          const copy = { ...f };
          if (copy.customTextureUrls) copy.customTextureUrls = sanitizeUrlObj(copy.customTextureUrls);
          if (copy.materialSettings?.customTextureUrls) {
            copy.materialSettings = {
              ...copy.materialSettings,
              customTextureUrls: sanitizeUrlObj(copy.materialSettings.customTextureUrls)
            };
          }
          if (copy.subMaterials) {
            const subCopy: any = { ...copy.subMaterials };
            for (const key of Object.keys(subCopy)) {
              if (subCopy[key]?.customTextureUrls) {
                subCopy[key] = {
                  ...subCopy[key],
                  customTextureUrls: sanitizeUrlObj(subCopy[key].customTextureUrls)
                };
              }
            }
            copy.subMaterials = subCopy;
          }
          return copy;
        });
      }
      if (state.groundSettings) {
        const gs = state.groundSettings;
        if (gs.colorMapUrl) this.groundCustomTextureUrls.color = TerrainGrid.sanitizeTextureUrl(gs.colorMapUrl, 'color');
        if (gs.colorMapName) this.groundCustomTextureUrls.colorName = gs.colorMapName;
        if (gs.roughnessMapUrl) this.groundCustomTextureUrls.roughness = TerrainGrid.sanitizeTextureUrl(gs.roughnessMapUrl, 'roughness');
        if (gs.roughnessMapName) this.groundCustomTextureUrls.roughnessName = gs.roughnessMapName;
        if (gs.normalMapUrl) this.groundCustomTextureUrls.normal = TerrainGrid.sanitizeTextureUrl(gs.normalMapUrl, 'normal');
        if (gs.normalMapName) this.groundCustomTextureUrls.normalName = gs.normalMapName;
        if (gs.satelliteMapUrl) {
          this.setSatelliteOverlayTexture(gs.satelliteMapUrl, gs.satelliteOpacity ?? 0.72);
        }
        this.setGroundUvSettings(gs);
      }
      if (typeof state.lastEditedSandFeatureIdx === 'number') {
        this.lastEditedSandFeatureIdx = state.lastEditedSandFeatureIdx;
      }
      if (typeof state.lastEditedWaterFeatureIdx === 'number') {
        this.lastEditedWaterFeatureIdx = state.lastEditedWaterFeatureIdx;
      }
      if (typeof state.activeCustomUploadKey === 'string') {
        this.activeCustomUploadKey = state.activeCustomUploadKey;
      }
      this.isBaseCourseDirty = true;
      this.dragStaticFeatureIdx = -1;
      this.courseBoundaryMask = null;
      this.syncPluginLayerState();
      this.redrawSplatTexture();
      this.rebuildMesh();
      return true;
    } catch (e) {
      console.error('Failed to import terrain state:', e);
      return false;
    }
  }

  public resetGroundMaterial() {
    this.groundUvScaleU = 110;
    this.groundUvScaleV = 230;
    this.groundUvOffsetU = 0.0;
    this.groundUvOffsetV = 0.0;
    this.groundNormalLevel = 0.45;
    this.groundDetailBlendLevel = 0.50;
    this.groundBaseColor = '#4c7426';
    this.groundColorTexLevel = 1.0;
    this.groundRoughnessLevel = 0.78;
    this.groundMetallicLevel = 0.0;
    this.groundEnableBaseColorTex = true;
    this.groundEnableRoughnessTex = true;
    this.groundEnableNormalTex = true;
    this.groundCustomTextureUrls = {};

    if (this.defaultRoughPhotoTile) {
      this.roughPhotoTile = this.defaultRoughPhotoTile;
    }

    const prevNormal = this.pbrGrassNormalTex;
    const prevColor = this.pbrGrassColorTex;
    const prevRough = this.pbrGrassRoughTex;

    this.pbrGrassNormalTex = new Texture('/textures/pbr_grass/grass_pbr_nor_1k.jpg', this.scene);
    this.pbrGrassNormalTex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;
    this.pbrGrassColorTex = new Texture('/textures/pbr_grass/grass_pbr_diff_1k.jpg', this.scene);
    this.pbrGrassColorTex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;
    this.pbrGrassRoughTex = new Texture('/textures/pbr_grass/grass_pbr_rough_512.jpg', this.scene);
    this.pbrGrassRoughTex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;

    this.applyTerrainRoughnessAndColorState();
    this.pbrGrassColorTex.onLoadObservable.addOnce(() => {
      this.terrainMaterial?.markAsDirty(Material.TextureDirtyFlag);
      this.terrainMaterial?.resetDrawCache();
    });

    if (this.terrainMaterial) {
      (this.terrainMaterial as any)._origGroundBumpTex = this.pbrGrassNormalTex;
      this.terrainMaterial.bumpTexture = this.pbrGrassNormalTex;
      if (this.terrainMaterial instanceof StandardMaterial) {
        this.terrainMaterial.specularTexture = this.pbrGrassRoughTex;
      } else if (this.terrainMaterial instanceof PBRMaterial) {
        this.terrainMaterial.metallicTexture = null;
      }
      if (this.terrainMaterial.detailMap) {
        this.terrainMaterial.detailMap.isEnabled = false;
        this.terrainMaterial.detailMap.roughnessBlendLevel = 0.0;
      }
      this.setGroundUvSettings({});
    }

    if (prevNormal && prevNormal !== this.pbrGrassNormalTex) prevNormal.dispose();
    if (prevColor && prevColor !== this.pbrGrassColorTex) prevColor.dispose();
    if (prevRough && prevRough !== this.pbrGrassRoughTex) prevRough.dispose();
    this.redrawSplatTexture();
  }

  public redrawSplatTexture() {
    if (!this.splatTexture) return;
    const tiles: Record<string, HTMLCanvasElement> = {};

    const ctx = this.splatTexture.getContext() as CanvasRenderingContext2D;
    const canvasW = TerrainGrid.MASK_RESOLUTION;
    const canvasH = TerrainGrid.MASK_RESOLUTION;
    const sX = canvasW / this.width;
    const sZ = canvasH / this.length;

    const roughSource = this.roughPhotoTile || null;
    let avgR = 76;
    let avgG = 116;
    let avgB = 48;
    const tint = Color3.FromHexString(this.groundBaseColor);
    if (!this.groundEnableBaseColorTex) {
      const hex = this.groundBaseColor.toLowerCase() !== '#ffffff' ? this.groundBaseColor : '#4c7430';
      const solid = Color3.FromHexString(hex);
      avgR = Math.round(solid.r * 255);
      avgG = Math.round(solid.g * 255);
      avgB = Math.round(solid.b * 255);
    } else if (this.cachedRoughAvgColor) {
      avgR = this.cachedRoughAvgColor.r;
      avgG = this.cachedRoughAvgColor.g;
      avgB = this.cachedRoughAvgColor.b;
    } else if (roughSource && roughSource.width > 0 && roughSource.height > 0) {
      try {
        const tiny = document.createElement('canvas');
        tiny.width = 8;
        tiny.height = 8;
        const tCtx = tiny.getContext('2d');
        if (tCtx) {
          tCtx.drawImage(roughSource, 0, 0, 8, 8);
          const data = tCtx.getImageData(0, 0, 8, 8).data;
          let rSum = 0, gSum = 0, bSum = 0;
          const n = 64;
          for (let i = 0; i < n * 4; i += 4) {
            rSum += data[i];
            gSum += data[i + 1];
            bSum += data[i + 2];
          }
          avgR = Math.max(0, Math.min(255, Math.round((rSum / n) * tint.r)));
          avgG = Math.max(0, Math.min(255, Math.round((gSum / n) * tint.g)));
          avgB = Math.max(0, Math.min(255, Math.round((bSum / n) * tint.b)));
          this.cachedRoughAvgColor = { r: avgR, g: avgG, b: avgB };
        }
      } catch {
        // Ignore tainted-canvas fallback cleanly
      }
    }

    // Main Ground uses alpha = 0.502 (featureBlend = 0.0 in BunkerGrassExclusionPlugin -> pure GPU 4K texture);
    // stamped course features draw at alpha = 1.0 (featureBlend = 1.0), preserving seamless feathered collars.
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.fillStyle = `rgba(${avgR}, ${avgG}, ${avgB}, 0.502)`;
    ctx.fillRect(0, 0, canvasW, canvasH);

    this.rebuildLayerRegistry();
    this.syncLayerPropsLut();
    this.syncAnalyticalFeatureUniforms();

    if (this.surfaceMaskData) {
      new Uint32Array(
        this.surfaceMaskData.buffer,
        this.surfaceMaskData.byteOffset,
        this.surfaceMaskData.byteLength >> 2
      ).fill(0);
    }

    const layerPriority = (st: SurfaceType): number => {
      switch (st) {
        case SurfaceType.ROUGH: return 0;
        case SurfaceType.FIRST_CUT: return 1;
        case SurfaceType.FAIRWAY: return 2;
        case SurfaceType.FRINGE: return 3;
        case SurfaceType.GREEN: return 4;
        case SurfaceType.TEE: return 5;
        case SurfaceType.WATER: return 6;
        case SurfaceType.BUNKER: return 7;
        default: return 2;
      }
    };

    const indexedFeatures = this.stampedFeatures
      .map((feat, origIndex) => ({ feat, origIndex }))
      .sort((a, b) => layerPriority(a.feat.surfaceType) - layerPriority(b.feat.surfaceType));

    for (const { feat, origIndex } of indexedFeatures) {
      this.drawFeatureOnCanvas(ctx, feat, origIndex, sX, sZ, null, sX, sZ, tiles);
    }

    this.splatTexture.update(false);
    if (this.surfaceMaskTex && this.surfaceMaskData) {
      this.surfaceMaskTex.update(this.surfaceMaskData);
    }
  }

  /**
   * Computes a closed polygon offset outward by a constant `offsetMeters` along the true unit outward normal
   * at every vertex in meter space. Guarantees 100% uniform ring width all the way around any shape
   * (Ellipse, Kidney Bunker, Dogleg Fairway, Tee Box, or Water Hazard) without ever getting wider or thinner!
   */
  private computeUniformOffsetPolygon(
    closedPts: { x: number; z: number }[],
    offsetMeters: number
  ): { x: number; z: number }[] {
    const n = closedPts.length;
    if (n < 3 || Math.abs(offsetMeters) < 1e-5) return closedPts;

    // Determine signed area to ensure outward normal always points away from interior
    let signedArea2 = 0;
    for (let i = 0; i < n; i++) {
      const p0 = closedPts[i];
      const p1 = closedPts[(i + 1) % n];
      signedArea2 += p0.x * p1.z - p1.x * p0.z;
    }
    const orient = signedArea2 >= 0 ? 1.0 : -1.0;

    const result: { x: number; z: number }[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const prev = closedPts[(i - 1 + n) % n];
      const curr = closedPts[i];
      const next = closedPts[(i + 1) % n];

      let dx1 = curr.x - prev.x;
      let dz1 = curr.z - prev.z;
      const len1 = Math.hypot(dx1, dz1) || 1;
      dx1 /= len1;
      dz1 /= len1;

      let dx2 = next.x - curr.x;
      let dz2 = next.z - curr.z;
      const len2 = Math.hypot(dx2, dz2) || 1;
      dx2 /= len2;
      dz2 /= len2;

      const n1x = orient * dz1;
      const n1z = -orient * dx1;
      const n2x = orient * dz2;
      const n2z = -orient * dx2;

      let nx = n1x + n2x;
      let nz = n1z + n2z;
      const nLen = Math.hypot(nx, nz);
      if (nLen > 1e-5) {
        nx /= nLen;
        nz /= nLen;
      } else {
        nx = n1x;
        nz = n1z;
      }

      result[i] = {
        x: curr.x + nx * offsetMeters,
        z: curr.z + nz * offsetMeters
      };
    }

    return result;
  }

  /**
   * Traces a closed polygon specified in local feature meters `(lx, lz)` onto the splat canvas
   * by transforming into true world meters `(wx, wz)` first and then scaling by `(sX, sZ)`.
   * Eliminates all non-square canvas rotation skew so textures align 1:1 with 3D geometry!
   */
  private traceLocalMeterPolygon(
    ctx: CanvasRenderingContext2D,
    localPts: { x: number; z: number }[],
    centerX: number,
    centerZ: number,
    rotationRad: number,
    sX: number,
    sZ: number
  ) {
    const cosR = Math.cos(rotationRad);
    const sinR = Math.sin(rotationRad);
    ctx.beginPath();
    for (let i = 0; i < localPts.length; i++) {
      const lx = localPts[i].x;
      const lz = localPts[i].z;
      const wx = centerX + lx * cosR - lz * sinR;
      const wz = centerZ + lx * sinR + lz * cosR;
      const px = wx * sX;
      const pz = wz * sZ;
      if (i === 0) ctx.moveTo(px, pz);
      else ctx.lineTo(px, pz);
    }
    ctx.closePath();
  }

  private generateEllipseMeterPoints(halfW: number, halfL: number, segs = 160): { x: number; z: number }[] {
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < segs; i++) {
      const theta = (i / segs) * Math.PI * 2;
      pts.push({
        x: Math.cos(theta) * halfW,
        z: Math.sin(theta) * halfL
      });
    }
    return pts;
  }

  private generateBunkerContourPoints(
    halfW: number,
    halfL: number,
    scale: number,
    offsetMeters: number,
    shapeIndex: number,
    segs = 256
  ): { x: number; z: number }[] {
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < segs; i++) {
      const theta = (i / segs) * Math.PI * 2;
      const k = TerrainGrid.getBunkerRadiusFactor(theta, shapeIndex);
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const baseRad = Math.hypot(halfW * cosT, halfL * sinT) * k;
      const rSand = baseRad * scale;
      const rTotal = rSand + offsetMeters;
      const ratio = rTotal / Math.max(0.001, rSand);
      pts.push({
        x: cosT * halfW * k * scale * ratio,
        z: sinT * halfL * k * scale * ratio
      });
    }
    return pts;
  }

  private generateKidneyMeterPoints(
    halfW: number,
    halfL: number,
    scale = 0.88,
    shapeIndex = 0,
    segs = 192
  ): { x: number; z: number }[] {
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < segs; i++) {
      const theta = (i / segs) * Math.PI * 2;
      const r = scale * TerrainGrid.getBunkerRadiusFactor(theta, shapeIndex);
      pts.push({
        x: Math.cos(theta) * halfW * r,
        z: Math.sin(theta) * halfL * r
      });
    }
    return pts;
  }

  /**
   * Detects what underlying golf feature (Green, Fairway, or Rough) a bunker is placed on
   * so its lip bank and blend section adapt seamlessly to the host surface.
   */
  public detectBunkerHostSurface(
    centerX: number,
    centerZ: number,
    halfW: number,
    halfL: number
  ): SurfaceType {
    const rCheck = Math.max(halfW, halfL) + 2.8;

    // 1. Proximity check against all Green features
    for (const feat of this.stampedFeatures) {
      if (feat.surfaceType === SurfaceType.GREEN) {
        const dx = centerX - feat.centerX;
        const dz = centerZ - feat.centerZ;
        const greenR = Math.max(feat.width, feat.length) * 0.5 + 3.5;
        if (Math.hypot(dx, dz) <= greenR + rCheck) {
          return SurfaceType.GREEN;
        }
      }
    }

    // 2. Proximity check against Fairway splines
    for (const feat of this.stampedFeatures) {
      if (feat.surfaceType === SurfaceType.FAIRWAY && feat.doglegPoints && feat.doglegPoints.length >= 4) {
        const samples = 28;
        for (let s = 0; s <= samples; s++) {
          const sp = this.evaluateSpline(feat.doglegPoints, s / samples);
          const d = Math.hypot(centerX - sp.x, centerZ - sp.z);
          if (d <= Math.max(sp.leftW, sp.rightW) + rCheck) {
            return SurfaceType.FAIRWAY;
          }
        }
      }
    }

    return SurfaceType.ROUGH;
  }

  /**
   * Evaluates vertex alpha mask (0.0 = pure sand bed, 1.0 = grass).
   * Used by BunkerGrassExclusionPlugin to completely exclude grass blades, straw,
   * grass normal bumps, and grass displacement from the sand material of all bunkers.
   */
  public getGrassMaskAt(wx: number, wz: number): number {
    let minGrass = 1.0;
    for (const feat of this.stampedFeatures) {
      if (feat.surfaceType !== SurfaceType.BUNKER) continue;
      const halfW = feat.width * 0.5;
      const halfL = feat.length * 0.5;
      const dx = wx - feat.centerX;
      const dz = wz - feat.centerZ;
      const maxR = Math.max(halfW, halfL) * 1.6;
      if (Math.abs(dx) > maxR || Math.abs(dz) > maxR) continue;

      const cosR = Math.cos(-feat.rotationRad);
      const sinR = Math.sin(-feat.rotationRad);
      const lx = dx * cosR - dz * sinR;
      const lz = dx * sinR + dz * cosR;
      const shapeIdx = feat.bunkerShapeIndex ?? 0;
      const theta = Math.atan2(lz / Math.max(1, halfL), lx / Math.max(1, halfW));
      const k = TerrainGrid.getBunkerRadiusFactor(theta, shapeIdx);
      const baseRad = Math.hypot(halfW * Math.cos(theta), halfL * Math.sin(theta)) * k;
      const rMeters = Math.hypot(lx, lz);
      const rSand = baseRad * 0.78;
      const lipWidth = 1.20;

      if (rMeters <= rSand) {
        return 0.0;
      } else if (rMeters <= rSand + lipWidth) {
        const t = (rMeters - rSand) / lipWidth;
        const ramp = 0.5 * (1.0 - Math.cos(t * Math.PI));
        minGrass = Math.min(minGrass, ramp);
      }
    }
    return minGrass;
  }

  /**
   * Scanline-rasterizes exact integer layer IDs and feathered mask channels into 2048x2048 `surfaceMaskData`
   * without Canvas2D edge-blending corruption across adjacent numeric IDs.
   */
  private rasterizeMaskPolygon(
    pts: { x: number; z: number }[],
    centerX: number,
    centerZ: number,
    rotRad: number,
    writeR: number | null,
    writeG: number | null,
    writeB: number | null,
    writeA: number | null
  ) {
    const data = this.surfaceMaskData;
    const n = pts.length;
    if (!data || n < 3) return;

    const W = TerrainGrid.MASK_RESOLUTION;
    const H = TerrainGrid.MASK_RESOLUTION;
    const mX = W / this.width;
    const mZ = H / this.length;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);

    const pxArr = new Float32Array(n);
    const pyArr = new Float32Array(n);
    let minY = H;
    let maxY = -1;

    for (let i = 0; i < n; i++) {
      const lx = pts[i].x;
      const lz = pts[i].z;
      const wx = centerX + lx * cosR - lz * sinR;
      const wz = centerZ + lx * sinR + lz * cosR;
      const px = wx * mX;
      const py = wz * mZ;
      pxArr[i] = px;
      pyArr[i] = py;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }

    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(H - 1, Math.ceil(maxY));
    const ints: number[] = [];

    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5;
      ints.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = pyArr[i];
        const yj = pyArr[j];
        if ((yi > sy) !== (yj > sy)) {
          ints.push(pxArr[i] + ((sy - yi) / (yj - yi)) * (pxArr[j] - pxArr[i]));
        }
      }
      if (ints.length < 2) continue;
      ints.sort((a, b) => a - b);

      const rowOff = y * W;
      for (let k = 0; k + 1 < ints.length; k += 2) {
        const xStart = Math.max(0, Math.ceil(ints[k] - 0.5));
        const xEnd = Math.min(W - 1, Math.floor(ints[k + 1] - 0.5));
        for (let x = xStart; x <= xEnd; x++) {
          const p = (rowOff + x) * 4;
          if (writeR !== null) data[p] = writeR;
          if (writeG !== null) data[p + 1] = writeG;
          if (writeB !== null) data[p + 2] = writeB;
          if (writeA !== null) data[p + 3] = writeA;
        }
      }
    }
  }

  /**
   * Continuous analytical Signed Distance Field (SDF) rasterizer for tournament bunker sand beds and revetted sod lips.
   * Completely eliminates discrete pixel stair-stepping, concentric banding, and polygon blockiness across the entire
   * hazard by evaluating true sub-pixel continuous distance across sand bed (-0.35m), sod lip bank (1.20m), and outer
   * blend slope (2.60m) matching evaluateAnalyticalElevation 1:1.
   */
  private rasterizeBunkerContinuousFeather(
    centerX: number,
    centerZ: number,
    halfW: number,
    halfL: number,
    rotRad: number,
    shapeIndex: number,
    surfId: number,
    fringeId: number,
    showCollar: boolean = true,
    collarWidth: number = 1.20
  ) {
    const data = this.surfaceMaskData;
    if (!data) return;
    const W = TerrainGrid.MASK_RESOLUTION;
    const H = TerrainGrid.MASK_RESOLUTION;
    const mX = W / this.width;
    const mZ = H / this.length;
    const invCosR = Math.cos(-rotRad);
    const invSinR = Math.sin(-rotRad);

    const sandFeatherHalf = showCollar ? 0.35 : 0.55; // 1.10m continuous smooth transition window when collar is off
    const lipWidth = showCollar ? Math.max(0.15, collarWidth) : 0.0; // revetted sod lip collar ring width
    const blendWidth = 1.40; // outer blend slope onto host ground (matches evaluateAnalyticalElevation 1:1)
    const rBlendOffset = showCollar ? (lipWidth + blendWidth) : sandFeatherHalf; // total outer extent

    const maxDim = Math.max(halfW, halfL) * 1.5 + rBlendOffset + 2.0;
    const minPx = Math.max(0, Math.floor((centerX - maxDim) * mX));
    const maxPx = Math.min(W - 1, Math.ceil((centerX + maxDim) * mX));
    const minPz = Math.max(0, Math.floor((centerZ - maxDim) * mZ));
    const maxPz = Math.min(H - 1, Math.ceil((centerZ + maxDim) * mZ));

    const invMx = this.width / W;
    const invMz = this.length / H;

    for (let pz = minPz; pz <= maxPz; pz++) {
      const wz = (pz + 0.5) * invMz;
      const rowOff = pz * W;
      for (let px = minPx; px <= maxPx; px++) {
        const wx = (px + 0.5) * invMx;
        const dx = wx - centerX;
        const dz = wz - centerZ;

        // Transform into local unrotated bunker coordinates
        const lx = dx * invCosR - dz * invSinR;
        const lz = dx * invSinR + dz * invCosR;

        // True normalized ellipse parameter angle (matches generateBunkerContourPoints & evaluateAnalyticalElevation 100%)
        const normX = lx / Math.max(0.1, halfW);
        const normZ = lz / Math.max(0.1, halfL);
        const theta = Math.atan2(normZ, normX);
        const k = TerrainGrid.getBunkerRadiusFactor(theta, shapeIndex);
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const sandBoundaryX = cosT * halfW * k * 0.78;
        const sandBoundaryZ = sinT * halfL * k * 0.78;
        const rSand = Math.hypot(sandBoundaryX, sandBoundaryZ);

        const rDist = Math.hypot(lx, lz);
        const d = rDist - rSand; // < 0 inside sand, > 0 outside grass

        if (d > rBlendOffset) {
          // Completely outside bunker influence
          continue;
        }

        const p = (rowOff + px) * 4;

        // Owning sand ID for this bunker so shader links sand & lip layers cleanly
        data[p + 3] = surfId;

        // 1. Continuous Analytical Sand Weight (Channel R: 0..255)
        if (d <= -sandFeatherHalf) {
          data[p] = 255;
        } else if (d < sandFeatherHalf) {
          const t = (sandFeatherHalf - d) / (sandFeatherHalf * 2);
          const clampedT = Math.max(0, Math.min(1, t));
          const w = clampedT * clampedT * (3 - 2 * clampedT);
          data[p] = Math.max(data[p], Math.round(w * 255));
        }

        // 2. Continuous Analytical Sod Lip Collar Turf Weight (Channel G: 0..255)
        if (showCollar) {
          if (d <= -sandFeatherHalf) {
            // Deep in sand bed: no lip turf
          } else if (d < sandFeatherHalf) {
            // Sand-to-lip feather transition
            const t = (d + sandFeatherHalf) / (sandFeatherHalf * 2);
            const clampedT = Math.max(0, Math.min(1, t));
            const w = clampedT * clampedT * (3 - 2 * clampedT);
            data[p + 1] = Math.max(data[p + 1], Math.round(w * 255));
          } else if (d <= lipWidth) {
            // Full revetted sod lip collar ring
            data[p + 1] = 255;
          } else {
            // Outer blend slope from lip crest to host ground
            const t = (rBlendOffset - d) / blendWidth;
            const clampedT = Math.max(0, Math.min(1, t));
            const w = clampedT * clampedT * (3 - 2 * clampedT);
            data[p + 1] = Math.max(data[p + 1], Math.round(w * 255));
          }
        }

        // 3. Layer ID in Channel B:
        if (d <= -sandFeatherHalf) {
          data[p + 2] = surfId;
        } else if (d <= lipWidth) {
          data[p + 2] = showCollar ? fringeId : surfId;
        } else if (showCollar) {
          // On outer blend slope, if collar is active, smoothly blend lip turf into surrounding terrain
          data[p + 2] = fringeId;
        }
      }
    }
  }

  private fillSubLayerPolygon(
    ctx: CanvasRenderingContext2D,
    pts: { x: number; z: number }[],
    centerX: number,
    centerZ: number,
    rotRad: number,
    sX: number,
    sZ: number,
    fallbackColor: string,
    mat: FeatureMaterialSettings,
    layerId: number,
    maskR: number | null,
    maskG: number | null,
    writeLayerId: boolean = true,
    sandOwnerId: number = 0,
    splatAlpha: number = 1.0
  ) {
    // 1. Paint smooth Base Color onto splatCanvas (full-resolution GPU textures mix on top in BunkerGrassExclusionPlugin)
    this.traceLocalMeterPolygon(ctx, pts, centerX, centerZ, rotRad, sX, sZ);
    ctx.fillStyle = mat.baseColor || fallbackColor;
    if (splatAlpha < 0.999) {
      ctx.save();
      ctx.globalAlpha = splatAlpha;
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fill();
    }

    // 2. Rasterize crisp independent integer Layer ID + feathered Sand/Water weights into 2048x2048 surfaceMaskData
    this.rasterizeMaskPolygon(
      pts,
      centerX,
      centerZ,
      rotRad,
      maskR,
      maskG,
      writeLayerId ? layerId : null,
      sandOwnerId
    );
  }

  /**
   * Renders calibrated alternating mowing stripes clipped to a local or world-space contour polygon.
   * Balances contrast so stripes read naturally beneath full-res GPU grass textures without muddying turf color.
   */
  private drawClippedMowingStripes(
    ctx: CanvasRenderingContext2D,
    polyPts: { x: number; z: number }[],
    centerX: number,
    centerZ: number,
    rotRad: number,
    sX: number,
    sZ: number,
    axis: 'x' | 'z',
    startPx: number,
    bandStepPx: number,
    bandCount: number,
    crossStartPx: number,
    crossSpanPx: number,
    contrast: number
  ) {
    ctx.save();
    this.traceLocalMeterPolygon(ctx, polyPts, centerX, centerZ, rotRad, sX, sZ);
    ctx.clip();
    const opLight = (0.02 + 0.22 * contrast).toFixed(3);
    const opDark = (0.02 + 0.20 * contrast).toFixed(3);
    const lightFill = `rgba(225, 255, 185, ${opLight})`;
    const darkFill = `rgba(10, 38, 10, ${opDark})`;
    for (let i = 0; i <= bandCount; i++) {
      ctx.fillStyle = i % 2 === 0 ? lightFill : darkFill;
      if (axis === 'z') {
        ctx.fillRect(crossStartPx, startPx + i * bandStepPx, crossSpanPx, bandStepPx);
      } else {
        ctx.fillRect(startPx + i * bandStepPx, crossStartPx, bandStepPx, crossSpanPx);
      }
    }
    ctx.restore();
  }

  /**
   * Draws a continuous, organic AAA Dogleg Fairway shape on the course splat canvas
   * with independent Fairway Turf, Fringe Collar, and First-Cut sub-materials.
   */
  private drawDoglegFairwayOnCanvas(
    ctx: CanvasRenderingContext2D,
    points: DoglegWaypoint[],
    featIdx: number,
    sX: number,
    sZ: number,
    maskCtx: CanvasRenderingContext2D | null,
    mX: number,
    mZ: number,
    tiles: Record<string, HTMLCanvasElement>
  ) {
    const samples = 260;
    const leftPtsMeters: { x: number; z: number }[] = [];
    const rightPtsMeters: { x: number; z: number }[] = [];

    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const sp = this.evaluateSpline(points, t);

      const nx = -sp.tz;
      const nz = sp.tx;

      leftPtsMeters.push({ x: sp.x + nx * sp.leftW, z: sp.z + nz * sp.leftW });
      rightPtsMeters.push({ x: sp.x - nx * sp.rightW, z: sp.z - nz * sp.rightW });
    }

    const fairwayLoopMeters: { x: number; z: number }[] = [];
    for (let i = 0; i <= samples; i++) {
      fairwayLoopMeters.push(leftPtsMeters[i]);
    }

    // Smooth 180-deg rounded end-cap at the green end (t = 1) across full fairway width
    const spEnd = this.evaluateSpline(points, 1.0);
    const nEndX = -spEnd.tz;
    const nEndZ = spEnd.tx;
    const rEnd = (spEnd.leftW + spEnd.rightW) * 0.5;
    const dEnd = rEnd * 0.70;
    const capSegs = 36;
    for (let k = 1; k < capSegs; k++) {
      const phi = (k / capSegs) * Math.PI;
      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);
      const curW = spEnd.leftW * (1 - k / capSegs) + spEnd.rightW * (k / capSegs);
      fairwayLoopMeters.push({
        x: spEnd.x + nEndX * (cosP * curW) + spEnd.tx * (sinP * dEnd),
        z: spEnd.z + nEndZ * (cosP * curW) + spEnd.tz * (sinP * dEnd)
      });
    }

    for (let i = samples; i >= 0; i--) {
      fairwayLoopMeters.push(rightPtsMeters[i]);
    }

    // Smooth 180-deg rounded end-cap at the tee end (t = 0) across full fairway width
    const spStart = this.evaluateSpline(points, 0.0);
    const nStartX = -spStart.tz;
    const nStartZ = spStart.tx;
    const rStart = (spStart.leftW + spStart.rightW) * 0.5;
    const dStart = rStart * 0.70;
    for (let k = 1; k < capSegs; k++) {
      const phi = (k / capSegs) * Math.PI;
      const cosP = Math.cos(phi);
      const sinP = Math.sin(phi);
      const curW = spStart.rightW * (1 - k / capSegs) + spStart.leftW * (k / capSegs);
      fairwayLoopMeters.push({
        x: spStart.x - nStartX * (cosP * curW) - spStart.tx * (sinP * dStart),
        z: spStart.z - nStartZ * (cosP * curW) - spStart.tz * (sinP * dStart)
      });
    }

    const fairwayMat = this.getFeatureSubMaterialSettings(featIdx, 'surface');
    const fringeMat = this.getFeatureSubMaterialSettings(featIdx, 'fringe');
    const firstCutMat = this.getFeatureSubMaterialSettings(featIdx, 'first_cut');
    const surfId = this.getOrRegisterLayerId(featIdx, 'surface');
    const fringeId = this.getOrRegisterLayerId(featIdx, 'fringe');
    const firstCutId = this.getOrRegisterLayerId(featIdx, 'first_cut');

    const showCollar = fringeMat.showCollarRings !== false && fairwayMat.showCollarRings !== false;
    const fringeWidth = fringeMat.collarWidth ?? fairwayMat.collarWidth ?? 2.0;

    if (showCollar && fringeWidth > 0.02) {
      const firstCutWidth = fringeWidth * 2.1;

      // 1. Continuous Uniform First-Cut Ring (independent FirstCut layerId)
      const fairwayFirstCutRing = this.computeUniformOffsetPolygon(fairwayLoopMeters, firstCutWidth);
      this.fillSubLayerPolygon(
        ctx, fairwayFirstCutRing, 0, 0, 0, sX, sZ,
        '#488a32', firstCutMat, firstCutId, 0, 0
      );

      // 1b. Continuous Uniform Fringe Ring (independent Fringe layerId)
      const fairwayFringeRing = this.computeUniformOffsetPolygon(fairwayLoopMeters, fringeWidth);
      this.fillSubLayerPolygon(
        ctx, fairwayFringeRing, 0, 0, 0, sX, sZ,
        '#35a043', fringeMat, fringeId, 0, 0
      );
    }

    // 2. Continuous AAA Dogleg Fairway Body (independent Fairway layerId)
    this.fillSubLayerPolygon(
      ctx, fairwayLoopMeters, 0, 0, 0, sX, sZ,
      '#38b000', fairwayMat, surfId, 0, 0
    );

    // 3. Championship Mowing Stripes clipped cleanly inside the organic fairway contour (using actual bounds)
    const stripeMeters = fairwayMat.mowingStripeWidth ?? 4.6;
    const contrast = fairwayMat.mowingStripeContrast !== undefined ? fairwayMat.mowingStripeContrast : 0.5;
    if (fairwayMat.showMowingStripes !== false && stripeMeters > 0.05 && contrast > 0.001) {
      let minFx = Infinity, maxFx = -Infinity, minFz = Infinity, maxFz = -Infinity;
      for (const p of fairwayLoopMeters) {
        if (p.x < minFx) minFx = p.x;
        if (p.x > maxFx) maxFx = p.x;
        if (p.z < minFz) minFz = p.z;
        if (p.z > maxFz) maxFz = p.z;
      }
      const spanZ = Math.max(10, (maxFz - minFz) + 8);
      const spanX = Math.max(10, (maxFx - minFx) + 8);
      const stripeStepMeters = Math.max(0.25, stripeMeters);
      const stripeStep = stripeStepMeters * sZ;
      const bandCount = Math.ceil(spanZ / stripeStepMeters) + 2;
      this.drawClippedMowingStripes(
        ctx, fairwayLoopMeters, 0, 0, 0, sX, sZ,
        'z', (minFz - 4) * sZ, stripeStep, bandCount, (minFx - 4) * sX, spanX * sX, contrast
      );
    }
  }

  private drawFeatureOnCanvas(
    ctx: CanvasRenderingContext2D,
    feat: StampedFeatureRecord,
    featIdx: number,
    sX: number,
    sZ: number,
    _maskCtx: CanvasRenderingContext2D | null,
    _mX: number,
    _mZ: number,
    _tiles: Record<string, HTMLCanvasElement>
  ) {
    if (feat.contour && feat.contour.length >= 3) {
      // All traced features (Fairway, Green, Bunker, Water, and High-Res 256x256 GPU SDF Tee Boxes)
      // render analytically on the GPU with zero low-res splat stair-stepping!
      return;
    }

    if (feat.doglegPoints && feat.doglegPoints.length >= 4) {
      this.drawDoglegFairwayOnCanvas(
        ctx,
        feat.doglegPoints,
        featIdx,
        sX,
        sZ,
        _maskCtx,
        _mX,
        _mZ,
        _tiles
      );
      return;
    }

    const halfW = feat.width * 0.5;
    const halfL = feat.length * 0.5;
    const surfMat = this.getFeatureSubMaterialSettings(featIdx, 'surface');
    const fringeMat = this.getFeatureSubMaterialSettings(featIdx, 'fringe');
    const firstCutMat = this.getFeatureSubMaterialSettings(featIdx, 'first_cut');
    const surfId = this.getOrRegisterLayerId(featIdx, 'surface');
    const fringeId = this.getOrRegisterLayerId(featIdx, 'fringe');
    const firstCutId = this.getOrRegisterLayerId(featIdx, 'first_cut');

    if (feat.surfaceType === SurfaceType.FIRST_CUT) {
      const pts = this.generateEllipseMeterPoints(halfW, halfL, 128);
      this.fillSubLayerPolygon(
        ctx, pts, feat.centerX, feat.centerZ, feat.rotationRad, sX, sZ,
        '#488a32', surfMat, surfId, 0, 0
      );

    } else if (feat.surfaceType === SurfaceType.FRINGE) {
      const pts = this.generateEllipseMeterPoints(halfW, halfL, 128);
      this.fillSubLayerPolygon(
        ctx, pts, feat.centerX, feat.centerZ, feat.rotationRad, sX, sZ,
        '#35a043', surfMat, surfId, 0, 0
      );

    } else if (feat.surfaceType === SurfaceType.FAIRWAY) {
      const baseFwPts = this.generateEllipseMeterPoints(halfW, halfL, 160);
      const showCollar = fringeMat.showCollarRings !== false && surfMat.showCollarRings !== false;
      const fringeWidth = fringeMat.collarWidth ?? surfMat.collarWidth ?? 2.0;

      if (showCollar && fringeWidth > 0.02) {
        const firstCutWidth = fringeWidth * 2.1;
        const firstCutRingPts = this.computeUniformOffsetPolygon(baseFwPts, firstCutWidth);
        const fringeRingPts = this.computeUniformOffsetPolygon(baseFwPts, fringeWidth);
        this.fillSubLayerPolygon(
          ctx, firstCutRingPts, feat.centerX, feat.centerZ, feat.rotationRad, sX, sZ,
          '#488a32', firstCutMat, firstCutId, 0, 0
        );
        this.fillSubLayerPolygon(
          ctx, fringeRingPts, feat.centerX, feat.centerZ, feat.rotationRad, sX, sZ,
          '#35a043', fringeMat, fringeId, 0, 0
        );
      }

      this.fillSubLayerPolygon(
        ctx, baseFwPts, feat.centerX, feat.centerZ, feat.rotationRad, sX, sZ,
        '#38b000', surfMat, surfId, 0, 0
      );

      const stripeW = surfMat.mowingStripeWidth ?? 4.6;
      const contrast = surfMat.mowingStripeContrast !== undefined ? surfMat.mowingStripeContrast : 0.5;
      if (surfMat.showMowingStripes !== false && stripeW > 0.05 && contrast > 0.001) {
        const stepMeters = Math.max(0.25, stripeW);
        const stepZ = stepMeters * sZ;
        const count = Math.ceil((halfL * 2.4) / stepMeters) * 2;
        this.drawClippedMowingStripes(
          ctx, baseFwPts, feat.centerX, feat.centerZ, feat.rotationRad, sX, sZ,
          'z', (feat.centerZ - halfL * 1.3) * sZ, stepZ, count, (feat.centerX - halfW * 1.3) * sX, halfW * 2.6 * sX, contrast
        );
      }

    } else if (feat.surfaceType === SurfaceType.GREEN) {
      // Triple-AAA Next Gen: Putting Greens, Fringe, First Cut collars & mowing stripes are rendered
      // 100% analytically in the GPU fragment shader (gradient-normalized SDF with zero pixel stair-stepping).
      return;

    } else if (feat.surfaceType === SurfaceType.BUNKER) {
      // Triple-AAA Next Gen: Bunkers are rendered 100% analytically in the GPU fragment shader.
      // Bypasses 2D canvas polygon rasterization and CPU pixel loops completely.
      // Eliminates all discrete 20cm pixel stair-stepping, jagged edges, dark rough halos, and 33MB PCIe texture uploads!
      return;

    } else if (feat.surfaceType === SurfaceType.TEE) {
      // Triple-AAA Next Gen: Tee Boxes (Deck + Turf Collar & mowing stripes) are rendered
      // 100% analytically in the GPU fragment shader (gradient-normalized SDF with zero pixel stair-stepping).
      return;

    } else if (feat.surfaceType === SurfaceType.WATER) {
      // Triple-AAA Next Gen: Water Hazards (Shoreline & Bank + optional Bank Collar) are rendered
      // 100% analytically in the GPU fragment shader (gradient-normalized SDF with zero pixel stair-stepping).
      return;
    }
  }

  /**
   * Rebuilds the single watertight GolfTerrain mesh using triple-tier LOD:
   *  - 2.0m x 2.0m macro quads across pure outer Rough (with watertight center-fan transitions)
   *  - 1.0m x 1.0m standard quads across Fairways, Greens, Tee plateaus, and internal Bunker/Water floors
   *  - 0.50m (2x2) high-density slope rings around Bunker lips, Tee skirts, and Water banks
   */
  public rebuildMesh(isDraft: boolean = false) {
    if (!this.terrainMesh) return;

    const cols = this.cols;
    const rows = this.rows;

    // Optional course footprint trim mask + Play-Mode corridor culling
    let effectiveMask: Uint8Array | null = null;
    if (this.courseBoundaryMask && this.courseBoundaryMask.length === this.gridX * this.gridZ) {
      effectiveMask = new Uint8Array(this.courseBoundaryMask);
    } else if (this.playCorridorBounds) {
      effectiveMask = new Uint8Array(this.gridX * this.gridZ);
      effectiveMask.fill(1);
    }

    if (effectiveMask && !this.playCorridorBounds) {
      for (const feat of this.stampedFeatures) {
        const minX = Math.max(0, Math.floor((feat.centerX - feat.width * 0.5 - 6) / this.cellSize));
        const maxX = Math.min(this.gridX - 1, Math.ceil((feat.centerX + feat.width * 0.5 + 6) / this.cellSize));
        const minZ = Math.max(0, Math.floor((feat.centerZ - feat.length * 0.5 - 6) / this.cellSize));
        const maxZ = Math.min(this.gridZ - 1, Math.ceil((feat.centerZ + feat.length * 0.5 + 6) / this.cellSize));
        for (let z = minZ; z <= maxZ; z++) {
          const rowOff = z * this.gridX;
          for (let x = minX; x <= maxX; x++) {
            effectiveMask[rowOff + x] = 1;
          }
        }
      }
    }

    if (effectiveMask && this.playCorridorBounds) {
      const cb = this.playCorridorBounds;
      let activeInsideCorridor = 0;
      for (let cz = 0; cz < this.gridZ; cz++) {
        const wz = (cz + 0.5) * this.cellSize;
        const rowOff = cz * this.gridX;
        const outZ = wz < cb.minZ || wz > cb.maxZ;
        for (let cx = 0; cx < this.gridX; cx++) {
          if (outZ) {
            effectiveMask[rowOff + cx] = 0;
            continue;
          }
          const wx = (cx + 0.5) * this.cellSize;
          if (wx < cb.minX || wx > cb.maxX) {
            effectiveMask[rowOff + cx] = 0;
          } else if (effectiveMask[rowOff + cx] === 1) {
            activeInsideCorridor++;
          }
        }
      }

      // Always unmask every stamped feature inside the Play corridor (e.g. Tee Box, Green, Fairway)
      // so user-placed features on imported MapNG terrain are never culled in Play Mode.
      for (const feat of this.stampedFeatures) {
        const pad = 18;
        const fx0 = feat.centerX - feat.width * 0.5 - pad;
        const fx1 = feat.centerX + feat.width * 0.5 + pad;
        const fz0 = feat.centerZ - feat.length * 0.5 - pad;
        const fz1 = feat.centerZ + feat.length * 0.5 + pad;
        if (fx1 < cb.minX || fx0 > cb.maxX || fz1 < cb.minZ || fz0 > cb.maxZ) continue;

        const minX = Math.max(0, Math.floor(Math.max(cb.minX, fx0) / this.cellSize));
        const maxX = Math.min(this.gridX - 1, Math.ceil(Math.min(cb.maxX, fx1) / this.cellSize));
        const minZ = Math.max(0, Math.floor(Math.max(cb.minZ, fz0) / this.cellSize));
        const maxZ = Math.min(this.gridZ - 1, Math.ceil(Math.min(cb.maxZ, fz1) / this.cellSize));
        for (let z = minZ; z <= maxZ; z++) {
          const rowOff = z * this.gridX;
          for (let x = minX; x <= maxX; x++) {
            if (effectiveMask[rowOff + x] === 0) {
              effectiveMask[rowOff + x] = 1;
              activeInsideCorridor++;
            }
          }
        }
      }

      // Safety fallback: if the Play corridor had very few unmasked cells, unmask the full corridor
      // so Play Mode never renders empty sky without terrain under the ball.
      if (activeInsideCorridor < 64) {
        const minX = Math.max(0, Math.floor(cb.minX / this.cellSize));
        const maxX = Math.min(this.gridX - 1, Math.ceil(cb.maxX / this.cellSize));
        const minZ = Math.max(0, Math.floor(cb.minZ / this.cellSize));
        const maxZ = Math.min(this.gridZ - 1, Math.ceil(cb.maxZ / this.cellSize));
        for (let z = minZ; z <= maxZ; z++) {
          const rowOff = z * this.gridX;
          for (let x = minX; x <= maxX; x++) {
            effectiveMask[rowOff + x] = 1;
          }
        }
      }
    }

    // 1. Update integer grid heights from continuous analytical elevation
    // Next-Gen Fast Terraforming: copy baseHeights in one bulk TypedArray blit, then evaluate
    // analytical feature shaping ONLY inside the union bounding box of stamped features (4x-8x faster on MapNG).
    this.heights.set(this.baseHeights);
    let featMinX = Infinity;
    let featMaxX = -Infinity;
    let featMinZ = Infinity;
    let featMaxZ = -Infinity;

    if (this.stampedFeatures.length > 0) {
      for (const f of this.stampedFeatures) {
        const reach = Math.max(f.width, f.length) * 0.75 + 24;
        if (f.centerX - reach < featMinX) featMinX = f.centerX - reach;
        if (f.centerX + reach > featMaxX) featMaxX = f.centerX + reach;
        if (f.centerZ - reach < featMinZ) featMinZ = f.centerZ - reach;
        if (f.centerZ + reach > featMaxZ) featMaxZ = f.centerZ + reach;
        if (f.contour) {
          for (const pt of f.contour) {
            if (pt.x - 16 < featMinX) featMinX = pt.x - 16;
            if (pt.x + 16 > featMaxX) featMaxX = pt.x + 16;
            if (pt.z - 16 < featMinZ) featMinZ = pt.z - 16;
            if (pt.z + 16 > featMaxZ) featMaxZ = pt.z + 16;
          }
        }
        if (f.doglegPoints) {
          for (const wp of f.doglegPoints) {
            const wPad = Math.max(20, (wp.width || 30) * 0.65) + 20;
            if (wp.x - wPad < featMinX) featMinX = wp.x - wPad;
            if (wp.x + wPad > featMaxX) featMaxX = wp.x + wPad;
            if (wp.z - wPad < featMinZ) featMinZ = wp.z - wPad;
            if (wp.z + wPad > featMaxZ) featMaxZ = wp.z + wPad;
          }
        }
      }

      const vMinX = Math.max(0, Math.floor(featMinX / this.cellSize));
      const vMaxX = Math.min(cols - 1, Math.ceil(featMaxX / this.cellSize));
      const vMinZ = Math.max(0, Math.floor(featMinZ / this.cellSize));
      const vMaxZ = Math.min(rows - 1, Math.ceil(featMaxZ / this.cellSize));

      for (let z = vMinZ; z <= vMaxZ; z++) {
        const wz = z * this.cellSize;
        const rowOff = z * cols;
        for (let x = vMinX; x <= vMaxX; x++) {
          const wx = x * this.cellSize;
          this.heights[rowOff + x] = this.evaluateAnalyticalElevation(wx, wz);
        }
      }
    }

    // 2. Mark perimeter slope-ring cells around Bunker, Tee Box, and Water features for 0.50m (2x2) subdivision
    this.subdividedCells.fill(0);
    let subCellCount = 0;

    if (!isDraft && this.stampedFeatures.length > 0 && Number.isFinite(featMinX)) {
      const cMinX = Math.max(0, Math.floor(featMinX / this.cellSize));
      const cMaxX = Math.min(this.gridX - 1, Math.ceil(featMaxX / this.cellSize));
      const cMinZ = Math.max(0, Math.floor(featMinZ / this.cellSize));
      const cMaxZ = Math.min(this.gridZ - 1, Math.ceil(featMaxZ / this.cellSize));

      for (let cz = cMinZ; cz <= cMaxZ; cz++) {
        const midZ = (cz + 0.5) * this.cellSize;
        for (let cx = cMinX; cx <= cMaxX; cx++) {
          if (effectiveMask && effectiveMask[cz * this.gridX + cx] === 0) continue;
          const midX = (cx + 0.5) * this.cellSize;
          let isSub = false;

          for (const feat of this.stampedFeatures) {
            if (feat.contour && feat.contour.length >= 3) {
              if (
                feat.surfaceType === SurfaceType.BUNKER ||
                feat.surfaceType === SurfaceType.TEE ||
                feat.surfaceType === SurfaceType.WATER
              ) {
                const halfW = feat.width * 0.5;
                const halfL = feat.length * 0.5;
                if (
                  Math.abs(midX - feat.centerX) <= halfW + 4.5 &&
                  Math.abs(midZ - feat.centerZ) <= halfL + 4.5
                ) {
                  if (Math.abs(signedDistanceToPolygon(midX, midZ, feat.contour)) <= 3.5) {
                    isSub = true;
                    break;
                  }
                }
              }
              continue;
            }
            if (feat.surfaceType === SurfaceType.BUNKER) {
              const halfW = feat.width * 0.5;
              const halfL = feat.length * 0.5;
              const dx = midX - feat.centerX;
              const dz = midZ - feat.centerZ;
              const fringeMat = feat.subMaterials?.['fringe'] || feat.materialSettings;
              const showCollar = fringeMat?.showCollarRings !== false && feat.materialSettings?.showCollarRings !== false;
              const lipWidth = showCollar ? Math.max(0.20, fringeMat?.collarWidth ?? feat.materialSettings?.collarWidth ?? 1.20) : 0.0;
              const maxR = Math.max(halfW, halfL) * 1.65 + lipWidth + 3.5;
              if (Math.abs(dx) <= maxR && Math.abs(dz) <= maxR) {
                const cosR = Math.cos(-feat.rotationRad);
                const sinR = Math.sin(-feat.rotationRad);
                const lx = dx * cosR - dz * sinR;
                const lz = dx * sinR + dz * cosR;
                const shapeIdx = feat.bunkerShapeIndex ?? 0;
                const theta = Math.atan2(lz / Math.max(1, halfL), lx / Math.max(1, halfW));
                const k = TerrainGrid.getBunkerRadiusFactor(theta, shapeIdx);
                const baseRad = Math.hypot(halfW * Math.cos(theta), halfL * Math.sin(theta)) * k;
                const rMeters = Math.hypot(lx, lz);
                const rSand = baseRad * 0.78;
                const rBlend = rSand + lipWidth + 1.40;
                if (rMeters >= Math.max(0, rSand * 0.56 - 1.2) && rMeters <= rBlend + 1.5) {
                  isSub = true;
                  break;
                }
              }
            } else if (feat.surfaceType === SurfaceType.TEE) {
              const halfW = feat.width * 0.45;
              const halfL = feat.length * 0.45;
              const dx = midX - feat.centerX;
              const dz = midZ - feat.centerZ;
              const maxR = Math.max(feat.width, feat.length);
              if (Math.abs(dx) <= maxR && Math.abs(dz) <= maxR) {
                const cosR = Math.cos(-feat.rotationRad);
                const sinR = Math.sin(-feat.rotationRad);
                const lx = dx * cosR - dz * sinR;
                const lz = dx * sinR + dz * cosR;
                const normDist = Math.hypot(lx / Math.max(0.5, halfW), lz / Math.max(0.5, halfL));
                if (normDist >= 0.72 && normDist <= 1.55) {
                  isSub = true;
                  break;
                }
              }
            } else if (feat.surfaceType === SurfaceType.WATER) {
              const halfW = feat.width * 0.5;
              const halfL = feat.length * 0.5;
              const fringeMat = feat.subMaterials?.fringe || feat.materialSettings;
              const showCollar = fringeMat?.showCollarRings !== false && feat.materialSettings?.showCollarRings !== false;
              const collarW = showCollar ? Math.max(0.5, fringeMat?.collarWidth ?? feat.materialSettings?.collarWidth ?? 2.15) : 0.6;
              const pad = collarW + 2.5;
              const dx = midX - feat.centerX;
              const dz = midZ - feat.centerZ;
              const maxR = Math.max(halfW, halfL) * 1.55 + pad;
              if (Math.abs(dx) <= maxR && Math.abs(dz) <= maxR) {
                const cosR = Math.cos(-feat.rotationRad);
                const sinR = Math.sin(-feat.rotationRad);
                const lx = dx * cosR - dz * sinR;
                const lz = dx * sinR + dz * cosR;
                const normDist = Math.hypot(lx / Math.max(0.5, halfW), lz / Math.max(0.5, halfL));
                const paddedDist = Math.hypot(lx / (halfW + pad), lz / (halfL + pad));
                if (normDist >= 0.58 && (normDist <= 1.48 || paddedDist <= 1.05)) {
                  isSub = true;
                  break;
                }
              }
            }
          }

          if (isSub) {
            this.subdividedCells[cz * this.gridX + cx] = 1;
            subCellCount++;
          }
        }
      }
    }

    // 2b. Identify 2m x 2m coarse Rough macro-blocks (1m base terrain only; unified MapNG stays uniform density)
    this.coarseBlocks.fill(0);
    if (this.cellSize <= 1.01) {
    for (let bz = 0; bz < this.blockRows; bz++) {
      const z0 = bz * 2;
      for (let bx = 0; bx < this.blockCols; bx++) {
        const x0 = bx * 2;
        if (
          effectiveMask &&
          (effectiveMask[z0 * this.gridX + x0] === 0 ||
            effectiveMask[z0 * this.gridX + (x0 + 1)] === 0 ||
            effectiveMask[(z0 + 1) * this.gridX + x0] === 0 ||
            effectiveMask[(z0 + 1) * this.gridX + (x0 + 1)] === 0)
        ) {
          continue;
        }
        if (
          this.subdividedCells[z0 * this.gridX + x0] === 1 ||
          this.subdividedCells[z0 * this.gridX + (x0 + 1)] === 1 ||
          this.subdividedCells[(z0 + 1) * this.gridX + x0] === 1 ||
          this.subdividedCells[(z0 + 1) * this.gridX + (x0 + 1)] === 1
        ) {
          continue;
        }
        let allRough = true;
        for (let dz = 0; dz <= 2 && allRough; dz++) {
          const rowOff = (z0 + dz) * cols;
          for (let dx = 0; dx <= 2; dx++) {
            if (this.surfaceTypes[rowOff + x0 + dx] !== SurfaceType.ROUGH) {
              allRough = false;
              break;
            }
          }
        }
        if (allRough) {
          this.coarseBlocks[bz * this.blockCols + bx] = 1;
        }
      }
    }
    }

    // Precompute exact triangle index count for single-allocation build
    let totalIndices = 0;
    for (let bz = 0; bz < this.blockRows; bz++) {
      for (let bx = 0; bx < this.blockCols; bx++) {
        if (this.coarseBlocks[bz * this.blockCols + bx] !== 1) continue;
        const cW = bx > 0 && this.coarseBlocks[bz * this.blockCols + (bx - 1)] === 1;
        const cE = bx < this.blockCols - 1 && this.coarseBlocks[bz * this.blockCols + (bx + 1)] === 1;
        const cS = bz > 0 && this.coarseBlocks[(bz - 1) * this.blockCols + bx] === 1;
        const cN = bz < this.blockRows - 1 && this.coarseBlocks[(bz + 1) * this.blockCols + bx] === 1;
        if (cW && cE && cS && cN) {
          totalIndices += 6;
        } else {
          totalIndices += ((cW ? 1 : 2) + (cN ? 1 : 2) + (cE ? 1 : 2) + (cS ? 1 : 2)) * 3;
        }
      }
    }
    for (let cz = 0; cz < this.gridZ; cz++) {
      const bz = cz >> 1;
      for (let cx = 0; cx < this.gridX; cx++) {
        if (effectiveMask && effectiveMask[cz * this.gridX + cx] === 0) continue;
        const bx = cx >> 1;
        if (bx < this.blockCols && bz < this.blockRows && this.coarseBlocks[bz * this.blockCols + bx] === 1) {
          continue;
        }
        totalIndices += this.subdividedCells[cz * this.gridX + cx] === 1 ? 24 : 6;
      }
    }

    const baseVerts = cols * rows;
    const totalVerts = baseVerts + subCellCount * 9;

    this.positions = new Float32Array(totalVerts * 3);
    this.normals = new Float32Array(totalVerts * 3);
    this.uvs = new Float32Array(totalVerts * 2);
    this.colors = new Float32Array(totalVerts * 4);
    this.indices = new Uint32Array(totalIndices);

    // 3. Populate base integer grid vertices [0 .. baseVerts - 1]
    for (let z = 0; z < rows; z++) {
      for (let x = 0; x < cols; x++) {
        const vIdx = z * cols + x;
        const pIdx = vIdx * 3;
        const uIdx = vIdx * 2;
        const cIdx = vIdx * 4;

        const wx = x * this.cellSize;
        const wz = z * this.cellSize;
        const hC = this.heights[vIdx];
        this.positions[pIdx] = wx;
        this.positions[pIdx + 1] = hC;
        this.positions[pIdx + 2] = wz;

        this.uvs[uIdx] = wx / this.width;
        this.uvs[uIdx + 1] = wz / this.length;

        const hL = x > 0 ? this.heights[vIdx - 1] : hC;
        const hR = x < cols - 1 ? this.heights[vIdx + 1] : hC;
        const hD = z > 0 ? this.heights[vIdx - cols] : hC;
        const hU = z < rows - 1 ? this.heights[vIdx + cols] : hC;

        const baseInvSpan = 1 / (2 * this.cellSize);
        let nx = (hL - hR) * baseInvSpan;
        let ny = Math.max(0.72, 1.0);
        let nz = (hD - hU) * baseInvSpan;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;

        this.normals[pIdx] = nx / len;
        this.normals[pIdx + 1] = ny / len;
        this.normals[pIdx + 2] = nz / len;

        let cavityAO = 1.0;
        if (!isDraft && this.surfaceTypes[vIdx] === SurfaceType.ROUGH) {
          const nearSub =
            (z > 0 && x > 0 && this.subdividedCells[(z - 1) * this.gridX + (x - 1)] === 1) ||
            (z > 0 && x < this.gridX && this.subdividedCells[(z - 1) * this.gridX + x] === 1) ||
            (z < this.gridZ && x > 0 && this.subdividedCells[z * this.gridX + (x - 1)] === 1) ||
            (z < this.gridZ && x < this.gridX && this.subdividedCells[z * this.gridX + x] === 1);
          if (!nearSub) {
            const laplacian = ((hL + hR + hD + hU) * 0.25) - hC;
            cavityAO = Math.max(0.95, Math.min(1.02, 1.0 - laplacian * 0.05));
          }
        }
        this.colors[cIdx] = cavityAO;
        this.colors[cIdx + 1] = cavityAO;
        this.colors[cIdx + 2] = cavityAO;
        this.colors[cIdx + 3] = this.getGrassMaskAt(wx, wz);
      }
    }

    // 4. Emit 2m Rough macro-blocks (with watertight center-fans), 1m cells, and 0.50m (2x2) slope-ring cells
    let nextV = baseVerts;
    let iIdx = 0;

    for (let bz = 0; bz < this.blockRows; bz++) {
      const z0 = bz * 2;
      for (let bx = 0; bx < this.blockCols; bx++) {
        if (this.coarseBlocks[bz * this.blockCols + bx] !== 1) continue;
        const x0 = bx * 2;

        const cW = bx > 0 && this.coarseBlocks[bz * this.blockCols + (bx - 1)] === 1;
        const cE = bx < this.blockCols - 1 && this.coarseBlocks[bz * this.blockCols + (bx + 1)] === 1;
        const cS = bz > 0 && this.coarseBlocks[(bz - 1) * this.blockCols + bx] === 1;
        const cN = bz < this.blockRows - 1 && this.coarseBlocks[(bz + 1) * this.blockCols + bx] === 1;

        const i00 = z0 * cols + x0;
        const i20 = z0 * cols + (x0 + 2);
        const i02 = (z0 + 2) * cols + x0;
        const i22 = (z0 + 2) * cols + (x0 + 2);

        if (cW && cE && cS && cN) {
          iIdx = this.emitAdaptiveQuad(i00, i20, i02, i22, iIdx);
        } else {
          const i10 = z0 * cols + (x0 + 1);
          const i01 = (z0 + 1) * cols + x0;
          const iC = (z0 + 1) * cols + (x0 + 1);
          const i21 = (z0 + 1) * cols + (x0 + 2);
          const i12 = (z0 + 2) * cols + (x0 + 1);

          if (cW) {
            this.indices[iIdx++] = iC; this.indices[iIdx++] = i00; this.indices[iIdx++] = i02;
          } else {
            this.indices[iIdx++] = iC; this.indices[iIdx++] = i00; this.indices[iIdx++] = i01;
            this.indices[iIdx++] = iC; this.indices[iIdx++] = i01; this.indices[iIdx++] = i02;
          }

          if (cN) {
            this.indices[iIdx++] = iC; this.indices[iIdx++] = i02; this.indices[iIdx++] = i22;
          } else {
            this.indices[iIdx++] = iC; this.indices[iIdx++] = i02; this.indices[iIdx++] = i12;
            this.indices[iIdx++] = iC; this.indices[iIdx++] = i12; this.indices[iIdx++] = i22;
          }

          if (cE) {
            this.indices[iIdx++] = iC; this.indices[iIdx++] = i22; this.indices[iIdx++] = i20;
          } else {
            this.indices[iIdx++] = iC; this.indices[iIdx++] = i22; this.indices[iIdx++] = i21;
            this.indices[iIdx++] = iC; this.indices[iIdx++] = i21; this.indices[iIdx++] = i20;
          }

          if (cS) {
            this.indices[iIdx++] = iC; this.indices[iIdx++] = i20; this.indices[iIdx++] = i00;
          } else {
            this.indices[iIdx++] = iC; this.indices[iIdx++] = i20; this.indices[iIdx++] = i10;
            this.indices[iIdx++] = iC; this.indices[iIdx++] = i10; this.indices[iIdx++] = i00;
          }
        }
      }
    }

    const eps = Math.max(0.25, this.cellSize * 0.35);
    for (let cz = 0; cz < this.gridZ; cz++) {
      const bz = cz >> 1;
      for (let cx = 0; cx < this.gridX; cx++) {
        if (effectiveMask && effectiveMask[cz * this.gridX + cx] === 0) continue;
        const bx = cx >> 1;
        if (bx < this.blockCols && bz < this.blockRows && this.coarseBlocks[bz * this.blockCols + bx] === 1) {
          continue;
        }

        if (this.subdividedCells[cz * this.gridX + cx] === 0) {
          const idx00 = cz * cols + cx;
          const idx10 = cz * cols + (cx + 1);
          const idx01 = (cz + 1) * cols + cx;
          const idx11 = (cz + 1) * cols + (cx + 1);

          iIdx = this.emitAdaptiveQuad(idx00, idx10, idx01, idx11, iIdx);
        } else {
          const cellStartV = nextV;

          for (let iv = 0; iv <= 2; iv++) {
            const wz = (cz + iv * 0.5) * this.cellSize;
            for (let iu = 0; iu <= 2; iu++) {
              const wx = (cx + iu * 0.5) * this.cellSize;
              const wy = this.getSubCellVertexHeight(cx, cz, iu, iv);

              const pIdx = nextV * 3;
              const uIdx = nextV * 2;
              const cIdx = nextV * 4;

              this.positions[pIdx] = wx;
              this.positions[pIdx + 1] = wy;
              this.positions[pIdx + 2] = wz;

              this.uvs[uIdx] = wx / this.width;
              this.uvs[uIdx + 1] = wz / this.length;

              const hL = this.evaluateAnalyticalElevation(wx - eps, wz);
              const hR = this.evaluateAnalyticalElevation(wx + eps, wz);
              const hD = this.evaluateAnalyticalElevation(wx, wz - eps);
              const hU = this.evaluateAnalyticalElevation(wx, wz + eps);

              let nx = (hL - hR) / (2 * eps);
              let ny = Math.max(0.65, 1.0);
              let nz = (hD - hU) / (2 * eps);
              const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;

              this.normals[pIdx] = nx / len;
              this.normals[pIdx + 1] = ny / len;
              this.normals[pIdx + 2] = nz / len;

              this.colors[cIdx] = 1.0;
              this.colors[cIdx + 1] = 1.0;
              this.colors[cIdx + 2] = 1.0;
              this.colors[cIdx + 3] = this.getGrassMaskAt(wx, wz);

              nextV++;
            }
          }

          for (let iv = 0; iv < 2; iv++) {
            for (let iu = 0; iu < 2; iu++) {
              const i00 = cellStartV + iv * 3 + iu;
              const i10 = i00 + 1;
              const i01 = i00 + 3;
              const i11 = i01 + 1;

              iIdx = this.emitAdaptiveQuad(i00, i10, i01, i11, iIdx);
            }
          }
        }
      }
    }

    const vertexData = new VertexData();
    vertexData.positions = this.positions;
    vertexData.normals = this.normals;
    vertexData.uvs = this.uvs;
    vertexData.colors = this.colors;
    vertexData.indices = this.indices;
    vertexData.applyToMesh(this.terrainMesh, true);
    this.terrainMesh.receiveShadows = true;
    this.terrainMesh.alwaysSelectAsActiveMesh = true;
    this.terrainMesh.refreshBoundingInfo({});
  }

  /**
   * Adaptive diagonal triangulation matching TerrainGrid.getElevation() so triangles follow
   * curved bunker lips and terrain contours instead of creating fixed-diagonal sawtooth notches.
   */
  private emitAdaptiveQuad(i00: number, i10: number, i01: number, i11: number, iIdx: number): number {
    const h00 = this.positions[i00 * 3 + 1];
    const h10 = this.positions[i10 * 3 + 1];
    const h01 = this.positions[i01 * 3 + 1];
    const h11 = this.positions[i11 * 3 + 1];

    if (Math.abs(h00 - h11) < Math.abs(h10 - h01)) {
      this.indices[iIdx++] = i00;
      this.indices[iIdx++] = i01;
      this.indices[iIdx++] = i11;
      this.indices[iIdx++] = i00;
      this.indices[iIdx++] = i11;
      this.indices[iIdx++] = i10;
    } else {
      this.indices[iIdx++] = i00;
      this.indices[iIdx++] = i01;
      this.indices[iIdx++] = i10;
      this.indices[iIdx++] = i10;
      this.indices[iIdx++] = i01;
      this.indices[iIdx++] = i11;
    }
    return iIdx;
  }
}
