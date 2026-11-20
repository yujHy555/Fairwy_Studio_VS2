import {
  Scene,
  Mesh,
  InstancedMesh,
  AbstractMesh,
  MeshBuilder,
  StandardMaterial,
  PBRMaterial,
  DynamicTexture,
  Material,
  MaterialPluginBase,
  MaterialDefines,
  UniformBuffer,
  Texture,
  Color3,
  Matrix,
  Vector3,
  Quaternion,
  VertexBuffer,
  VertexData,
  FresnelParameters
} from '@babylonjs/core';
import { GOLF_CONSTANTS } from '../core/Constants';
import { getDeviceProfile } from '../core/DeviceProfile';
import { earclipTriangulate2D, signedDistanceToPolygon } from './PolygonMath';
import { RealisticTextures } from './RealisticTextures';

/**
 * Triple-AAA GPU Cloth Wind Shader Plugin for pin flags.
 * Renders traveling silk waves, cross-ripples, calm-breeze gravity drape, and dynamic wave lighting normals
 * directly on the GPU using a lightweight 28-triangle flag mesh with zero CPU vertex allocations.
 */
class FlagClothWindPlugin extends MaterialPluginBase {
  public windTime = 0.0;
  public windStrength = 0.85;
  public flutterFreq = 3.2;
  public droopAmt = 0.085;

  constructor(material: Material) {
    super(material, 'FlagClothWind', 120, { FLAG_WIND: true });
    this._enable(true);
  }

  public getClassName(): string {
    return 'FlagClothWindPlugin';
  }

  public prepareDefines(defines: MaterialDefines) {
    defines['FLAG_WIND'] = true;
  }

  public getUniforms() {
    return {
      ubo: [{ name: 'uFlagWind', size: 4, type: 'vec4' }],
      vertex: `uniform vec4 uFlagWind;`
    };
  }

  public bindForSubMesh(uniformBuffer: UniformBuffer) {
    uniformBuffer.updateFloat4('uFlagWind', this.windTime, this.windStrength, this.flutterFreq, this.droopAmt);
  }

  public getCustomCode(shaderType: string) {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_UPDATE_POSITION: `
          #ifdef FLAG_WIND
            float fU = clamp((positionUpdated.x + 0.32) / 0.64, 0.0, 1.0);
            float fV = clamp((positionUpdated.z + 0.21) / 0.42, 0.0, 1.0);
            float fEnv = fU * fU * (1.25 - 0.25 * fU);
            float fStr = clamp(uFlagWind.y, 0.15, 2.0);
            float fP1 = fU * 6.4 - uFlagWind.x * uFlagWind.z;
            float fP2 = fU * 11.2 + fV * 2.6 - uFlagWind.x * (uFlagWind.z * 1.48);
            float fWave = (sin(fP1) * 0.052 + sin(fP2) * 0.017) * fEnv * fStr;
            float fCalm = 1.0 - min(0.85, fStr * 0.48);
            float fDroop = uFlagWind.w * fU * fU * fCalm;
            positionUpdated.y += fWave;
            positionUpdated.z -= fDroop;
            positionUpdated.x -= 0.022 * fEnv * fStr * (0.5 + 0.5 * cos(fP1));
          #endif
        `,
        CUSTOM_VERTEX_UPDATE_NORMAL: `
          #if defined(FLAG_WIND) && defined(NORMAL)
            float fnU = clamp((position.x + 0.32) / 0.64, 0.0, 1.0);
            float fnV = clamp((position.z + 0.21) / 0.42, 0.0, 1.0);
            float fnEnv = fnU * fnU * (1.25 - 0.25 * fnU);
            float fnStr = clamp(uFlagWind.y, 0.15, 2.0);
            float fnP1 = fnU * 6.4 - uFlagWind.x * uFlagWind.z;
            float fnP2 = fnU * 11.2 + fnV * 2.6 - uFlagWind.x * (uFlagWind.z * 1.48);
            float dWdX = ((cos(fnP1) * (6.4 / 0.64) * 0.052 + cos(fnP2) * (11.2 / 0.64) * 0.017) * fnEnv) * fnStr;
            float dWdZ = (cos(fnP2) * (2.6 / 0.42) * 0.017 * fnEnv) * fnStr;
            normalUpdated = normalize(vec3(-dWdX, 1.0, -dWdZ));
          #endif
        `
      };
    }
    return null;
  }
}

export interface TreeCollider {
  x: number;
  y: number;
  z: number;
  trunkRadius: number;
  trunkHeight: number;
  canopyRadius: number;
  canopyBottomY: number;
  canopyTopY: number;
  isHero: boolean;
  mesh?: AbstractMesh;
}

export class SceneryFactory {
  private scene: Scene;
  public treeColliders: TreeCollider[] = [];

  public syncColliders() {
    this.treeColliders = this.treeColliders.filter(c => c.mesh && !c.mesh.isDisposed());
    for (const c of this.treeColliders) {
      if (c.mesh && !c.mesh.isDisposed()) {
        const dy = c.mesh.position.y - c.y;
        c.x = c.mesh.position.x;
        c.y = c.mesh.position.y;
        c.z = c.mesh.position.z;
        c.canopyBottomY += dy;
        c.canopyTopY += dy;
      }
    }
  }

  // Shared realistic materials
  private matGlbPineTree: PBRMaterial;
  private matHeroBranches: PBRMaterial;
  private matHeroLeaves: PBRMaterial;
  private matHeroTrunk: PBRMaterial;
  private matWoodlandBark: PBRMaterial;
  private matWoodlandLeaves: PBRMaterial;
  private matRock: PBRMaterial;
  private matDam: PBRMaterial;
  private matWater: PBRMaterial;
  private matPinPole: PBRMaterial;
  private matPinFlag: PBRMaterial;
  private matCup: PBRMaterial;
  private matCupLiner: PBRMaterial;
  private matGoldTrim: PBRMaterial;

  // Master geometry & master meshes for Hardware Instancing (1 draw call per scenery type!)
  private pineTreeVertexData: VertexData | null = null;
  private masterPineMesh: Mesh | null = null;
  public activeTreeMeshes: (Mesh | InstancedMesh)[] = [];

  // Master geometry parsed directly from /models/hero_tree_01_01.glb (3 primitives: branches, leaves, trunk)
  private heroBranchesVertexData: VertexData | null = null;
  private heroLeavesVertexData: VertexData | null = null;
  private heroTrunkVertexData: VertexData | null = null;
  private masterHeroBranchesMesh: Mesh | null = null;
  private masterHeroLeavesMesh: Mesh | null = null;
  private masterHeroTrunkMesh: Mesh | null = null;
  private activeHeroTrees: { branches: Mesh | InstancedMesh; leaves: Mesh | InstancedMesh; trunk: Mesh | InstancedMesh }[] = [];

  // Master geometry parsed directly from /models/Tree_woodland_01.glb (2 primitives: bark trunk, leaves canopy)
  private woodlandBarkVertexData: VertexData | null = null;
  private woodlandLeavesVertexData: VertexData | null = null;
  private masterWoodlandBarkMesh: Mesh | null = null;
  private masterWoodlandLeavesMesh: Mesh | null = null;
  private activeWoodlandTrees: { bark: Mesh | InstancedMesh; leaves: Mesh | InstancedMesh }[] = [];

  // Master geometry parsed directly from /models/bush_01.glb (2 primitives: twigs, leaves)
  private bushBranchesVertexData: VertexData | null = null;
  private bushLeavesVertexData: VertexData | null = null;
  private matBushBranches: PBRMaterial;
  private matBushLeaves: PBRMaterial;
  private masterBushBranchesMesh: Mesh | null = null;
  private masterBushLeavesMesh: Mesh | null = null;
  private activeBushes: { branches: Mesh | InstancedMesh; leaves: Mesh | InstancedMesh }[] = [];

  // Master geometry parsed directly from /models/Rock_01.glb (1 primitive: rock)
  private rockGlbVertexData: VertexData | null = null;
  private matGlbRock: PBRMaterial;
  private masterRockMesh: Mesh | null = null;
  private activeRocks: (Mesh | InstancedMesh)[] = [];

  // Master geometry parsed directly from /models/Cliff_01.glb (1 primitive: coastal cliff)
  private cliffVertexData: VertexData | null = null;
  private cliffLoadPromise: Promise<void> | null = null;
  private matCliff: PBRMaterial;
  private masterCliffMesh: Mesh | null = null;
  private activeCliffs: (Mesh | InstancedMesh)[] = [];

  // Master geometry parsed directly from /models/rubber_duck_01_01.glb (1 primitive: rubber duck tee marker)
  private duckVertexData: VertexData | null = null;
  private matDuck: PBRMaterial | null = null;
  private masterDuckMesh: Mesh | null = null;
  private activeDucks: (Mesh | InstancedMesh)[] = [];

  private activeFlags: Mesh[] = [];
  private windTime = 0;
  private windStrength = 0.85;
  private windHeadingRad = Math.PI * 0.25;
  private flagWindPlugin: FlagClothWindPlugin | null = null;

  public setWindState(windSpeedMps: number, windHeadingDeg: number) {
    this.windStrength = Math.max(0.28, Math.min(1.85, (windSpeedMps || 3.5) / 5.5));
    this.windHeadingRad = ((windHeadingDeg || 0) * Math.PI) / 180.0;
    if (this.flagWindPlugin) {
      this.flagWindPlugin.windStrength = this.windStrength;
      this.flagWindPlugin.flutterFreq = 2.2 + this.windStrength * 1.9;
    }
  }

  constructor(scene: Scene) {
    this.scene = scene;

    // 1. Realistic GLB Pine Tree Material (pine_tree_medium_01_01.glb)
    // Naturally reacts to directional sun and HDRI environment light with clean needle alpha testing
    this.matGlbPineTree = new PBRMaterial('matGlbPineTree', scene);
    this.matGlbPineTree.albedoColor = Color3.White();
    this.matGlbPineTree.emissiveColor = Color3.Black();
    this.matGlbPineTree.metallic = 0.0;
    this.matGlbPineTree.roughness = 0.82;
    this.matGlbPineTree.backFaceCulling = false;
    this.matGlbPineTree.twoSidedLighting = false; // Prevents back-face normals from being inverted into shadow
    this.matGlbPineTree.transparencyMode = Material.MATERIAL_ALPHATEST;
    this.matGlbPineTree.alphaCutOff = 0.35;
    this.matGlbPineTree.useAlphaFromAlbedoTexture = true;

    // 1b. Hero Specimen Tree Materials (hero_tree_01_01.glb)
    this.matHeroBranches = new PBRMaterial('matHeroBranches', scene);
    this.matHeroBranches.albedoColor = Color3.White();
    this.matHeroBranches.emissiveColor = Color3.Black();
    this.matHeroBranches.metallic = 0.0;
    this.matHeroBranches.roughness = 0.85;
    this.matHeroBranches.backFaceCulling = false;

    this.matHeroLeaves = new PBRMaterial('matHeroLeaves', scene);
    this.matHeroLeaves.albedoColor = Color3.White();
    this.matHeroLeaves.emissiveColor = Color3.Black();
    this.matHeroLeaves.metallic = 0.0;
    this.matHeroLeaves.roughness = 0.78;
    this.matHeroLeaves.backFaceCulling = false;
    this.matHeroLeaves.twoSidedLighting = false;
    this.matHeroLeaves.transparencyMode = Material.MATERIAL_ALPHATEST;
    this.matHeroLeaves.alphaCutOff = 0.32;

    this.matHeroTrunk = new PBRMaterial('matHeroTrunk', scene);
    this.matHeroTrunk.albedoColor = Color3.White();
    this.matHeroTrunk.emissiveColor = Color3.Black();
    this.matHeroTrunk.metallic = 0.0;
    this.matHeroTrunk.roughness = 0.88;
    this.matHeroTrunk.backFaceCulling = false;

    // 1b-2. Woodland Tree Materials (Tree_woodland_01.glb)
    this.matWoodlandBark = new PBRMaterial('matWoodlandBark', scene);
    this.matWoodlandBark.albedoColor = Color3.White();
    this.matWoodlandBark.emissiveColor = Color3.Black();
    this.matWoodlandBark.metallic = 0.0;
    this.matWoodlandBark.roughness = 0.88;
    this.matWoodlandBark.backFaceCulling = false;

    this.matWoodlandLeaves = new PBRMaterial('matWoodlandLeaves', scene);
    this.matWoodlandLeaves.albedoColor = Color3.White();
    this.matWoodlandLeaves.emissiveColor = Color3.Black();
    this.matWoodlandLeaves.metallic = 0.0;
    this.matWoodlandLeaves.roughness = 0.78;
    this.matWoodlandLeaves.backFaceCulling = false;
    this.matWoodlandLeaves.twoSidedLighting = false;
    this.matWoodlandLeaves.transparencyMode = Material.MATERIAL_ALPHATEST;
    this.matWoodlandLeaves.alphaCutOff = 0.36;

    // 1c. Bush Materials (bush_01.glb)
    this.matBushBranches = new PBRMaterial('matBushBranches', scene);
    this.matBushBranches.albedoColor = Color3.White();
    this.matBushBranches.emissiveColor = Color3.Black();
    this.matBushBranches.metallic = 0.0;
    this.matBushBranches.roughness = 0.85;
    this.matBushBranches.backFaceCulling = false;

    this.matBushLeaves = new PBRMaterial('matBushLeaves', scene);
    this.matBushLeaves.albedoColor = Color3.White();
    this.matBushLeaves.emissiveColor = Color3.Black();
    this.matBushLeaves.metallic = 0.0;
    this.matBushLeaves.roughness = 0.78;
    this.matBushLeaves.backFaceCulling = false;
    this.matBushLeaves.twoSidedLighting = false;
    this.matBushLeaves.transparencyMode = Material.MATERIAL_ALPHATEST;
    this.matBushLeaves.alphaCutOff = 0.32;

    // 1d. High-Realism Rock Material (Rock_01.glb)
    this.matGlbRock = new PBRMaterial('matGlbRock', scene);
    this.matGlbRock.albedoColor = Color3.White();
    this.matGlbRock.emissiveColor = Color3.Black();
    this.matGlbRock.metallic = 0.0;
    this.matGlbRock.roughness = 0.82;
    this.matGlbRock.backFaceCulling = false;

    // 1e. Coastal Cliff Wall Material (Cliff_01.glb)
    this.matCliff = new PBRMaterial('matCliff', scene);
    this.matCliff.albedoColor = Color3.White();
    this.matCliff.emissiveColor = Color3.Black();
    this.matCliff.metallic = 0.0;
    this.matCliff.roughness = 0.85;
    this.matCliff.backFaceCulling = false;

    // 2. Seamless Granite Boulder Material
    const rockTex = RealisticTextures.createSeamlessRockTextures(scene);
    rockTex.diffuse.uScale = 3;
    rockTex.diffuse.vScale = 3;
    rockTex.normal.uScale = 3;
    rockTex.normal.vScale = 3;

    this.matRock = new PBRMaterial('matRock', scene);
    this.matRock.albedoTexture = rockTex.diffuse;
    this.matRock.bumpTexture = rockTex.normal;
    this.matRock.metallic = 0.0;
    this.matRock.roughness = 0.82;
    this.matRock.emissiveColor = Color3.Black();

    // 3. Stone Retaining / Dam Wall Material
    this.matDam = new PBRMaterial('matDam', scene);
    this.matDam.albedoTexture = rockTex.diffuse;
    this.matDam.bumpTexture = rockTex.normal;
    this.matDam.albedoColor = new Color3(0.82, 0.84, 0.86);
    this.matDam.metallic = 0.0;
    this.matDam.roughness = 0.82;
    this.matDam.emissiveColor = Color3.Black();

    // 4. Realistic Animated Water Material with HDRI Sky Fresnel Reflections & Organic Wind Normal Map
    const waterDiffuse = RealisticTextures.createSeamlessWaterDiffuseTexture(scene);
    waterDiffuse.uScale = 2.5;
    waterDiffuse.vScale = 2.5;

    const waterNormal = RealisticTextures.createSeamlessWaterNormalTexture(scene);
    waterNormal.uScale = 3.2;
    waterNormal.vScale = 3.2;
    waterNormal.level = 0.58;

    this.matWater = new PBRMaterial('matWater', scene);
    this.matWater.albedoTexture = waterDiffuse;
    this.matWater.bumpTexture = waterNormal;
    this.matWater.albedoColor = new Color3(0.08, 0.28, 0.38);
    this.matWater.emissiveColor = new Color3(0.01, 0.05, 0.08);
    this.matWater.metallic = 0.05;
    this.matWater.roughness = 0.12;
    this.matWater.alpha = 0.88;
    this.matWater.transparencyMode = Material.MATERIAL_ALPHABLEND;
    this.matWater.backFaceCulling = false;
    // Note: leave matWater.reflectionTexture unset so PBRMaterial dynamically samples scene.environmentTexture across HDRI swaps & rotations!

    // Animate water ripples & GPU flag cloth wind uniforms (zero CPU mesh rebuilds)
    this.scene.onBeforeRenderObservable.add(() => {
      const dt = Math.min(0.05, this.scene.getEngine().getDeltaTime() / 1000);
      waterNormal.uOffset = (waterNormal.uOffset + dt * 0.024) % 1.0;
      waterNormal.vOffset = (waterNormal.vOffset + dt * 0.016) % 1.0;
      waterDiffuse.uOffset = (waterDiffuse.uOffset - dt * 0.010) % 1.0;
      waterDiffuse.vOffset = (waterDiffuse.vOffset + dt * 0.008) % 1.0;

      this.windTime += dt * (2.4 + this.windStrength * 1.4);
      if (this.flagWindPlugin) {
        this.flagWindPlugin.windTime = this.windTime;
        this.flagWindPlugin.windStrength = this.windStrength;
      }
      if (this.activeFlags.length > 0) {
        for (let i = this.activeFlags.length - 1; i >= 0; i--) {
          const flag = this.activeFlags[i];
          if (flag.isDisposed()) {
            this.activeFlags.splice(i, 1);
            continue;
          }
          const gustYaw = this.windHeadingRad + Math.sin(this.windTime * 0.55) * 0.06;
          flag.rotation.y = gustYaw;
          flag.position.set(Math.cos(gustYaw) * 0.32, 2.16, -Math.sin(gustYaw) * 0.32);
        }
      }
    });

    // 5. Pin, Cup & Trim Materials
    this.matPinPole = new PBRMaterial('matPinPole', scene);
    this.matPinPole.albedoColor = new Color3(0.95, 0.95, 0.92);
    this.matPinPole.metallic = 0.85;
    this.matPinPole.roughness = 0.35;

    this.matPinFlag = new PBRMaterial('matPinFlag', scene);
    this.matPinFlag.albedoColor = new Color3(1.0, 0.82, 0.05); // PGA Tournament Yellow Flag
    this.matPinFlag.metallic = 0.0;
    this.matPinFlag.roughness = 0.85;
    this.matPinFlag.backFaceCulling = false;

    this.matCup = new PBRMaterial('matCup', scene);
    this.matCup.albedoColor = new Color3(0.08, 0.09, 0.10);
    this.matCup.metallic = 0.50;
    this.matCup.roughness = 0.40;

    this.matCupLiner = new PBRMaterial('matCupLiner', scene);
    this.matCupLiner.albedoColor = new Color3(0.92, 0.94, 0.96);
    this.matCupLiner.metallic = 0.75;
    this.matCupLiner.roughness = 0.32;

    this.matGoldTrim = new PBRMaterial('matGoldTrim', scene);
    this.matGoldTrim.albedoColor = new Color3(0.85, 0.68, 0.24);
    this.matGoldTrim.metallic = 0.92;
    this.matGoldTrim.roughness = 0.25;
  }

  /**
   * Processes an embedded PNG foliage image by bleeding/dilating RGB colors into transparent border pixels
   * and boosting needle/leaf vibrancy so trilinear mipmaps stay razor-sharp with zero dark alpha haloing.
   */
  private createCrispFoliageTextureFromBlob(blob: Blob, name: string, colorBoost = 1.0): Promise<DynamicTexture> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const profile = getDeviceProfile();
        const maxDim = Math.max(img.width, img.height, 1);
        const scale = maxDim > profile.maxGlbTextureSize ? profile.maxGlbTextureSize / maxDim : 1;
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        // invertY = false to match glTF 2.0 top-left UV origin
        const dynTex = new DynamicTexture(name, { width: w, height: h }, this.scene, true, Texture.TRILINEAR_SAMPLINGMODE);
        dynTex.hasAlpha = true;
        dynTex.anisotropicFilteringLevel = profile.maxAnisotropy;

        const ctx = dynTex.getContext() as CanvasRenderingContext2D;
        ctx.drawImage(img, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h);
        const px = imgData.data;

        // 1. Natural foliage edge filtering without glowing outlines
        for (let i = 0; i < px.length; i += 4) {
          const a = px[i + 3];
          if (a > 15) {
            px[i] = Math.min(255, Math.round(px[i] * colorBoost));
            px[i + 1] = Math.min(255, Math.round(px[i + 1] * colorBoost));
            px[i + 2] = Math.min(255, Math.round(px[i + 2] * colorBoost));
          } else {
            // Fill fully transparent background with dark pine tone (24, 38, 20)
            // so hardware mipmaps never blend white or light halo fringes
            px[i] = 24;
            px[i + 1] = 38;
            px[i + 2] = 20;
          }
        }

        ctx.putImageData(imgData, 0, 0);
        // update(false) preserves glTF top-left UV orientation
        dynTex.update(false);
        RealisticTextures.attachPreviewDataUrl(dynTex);
        resolve(dynTex);
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  private getGlbImageBlob(
    gltf: any,
    arrayBuf: ArrayBuffer,
    binChunkStart: number,
    imgIdx: number,
    fallbackMime = 'image/png'
  ): Blob | null {
    const imgDef = gltf.images?.[imgIdx];
    if (!imgDef || imgDef.bufferView === undefined) return null;
    const bv = gltf.bufferViews[imgDef.bufferView];
    const bytes = new Uint8Array(arrayBuf, binChunkStart + (bv.byteOffset || 0), bv.byteLength);
    return new Blob([bytes], { type: imgDef.mimeType || fallbackMime });
  }

  private async createTextureFromBlob(blob: Blob, name: string, invertY = false): Promise<Texture> {
    const profile = getDeviceProfile();
    const maxAllowed = profile.maxGlbTextureSize;
    const origUrl = URL.createObjectURL(blob);

    let finalUrl = origUrl;
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = origUrl;
      });
      const maxDim = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
      if (maxDim > maxAllowed) {
        const scale = maxAllowed / maxDim;
        const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
        const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h);
          const mime = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
          const resizedBlob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, 0.85));
          if (resizedBlob) {
            URL.revokeObjectURL(origUrl);
            finalUrl = URL.createObjectURL(resizedBlob);
          }
        }
      }
    } catch {
      // Fall back to original blob URL if decode fails
    }

    const tex = new Texture(finalUrl, this.scene, false, invertY, Texture.TRILINEAR_SAMPLINGMODE);
    tex.name = name;
    tex.anisotropicFilteringLevel = profile.maxAnisotropy;
    (tex as any)._previewDataUrl = finalUrl;
    return tex;
  }

  /**
   * Ensures every procedural scenery, water, pin, cup & trim material has full
   * Color + Roughness + Normal map textures wired cleanly.
   */
  private ensureProceduralMaterialsPbr(): void {
    const rockTex = RealisticTextures.createSeamlessRockTextures(this.scene);
    this.matRock.albedoTexture = rockTex.diffuse;
    this.matRock.bumpTexture = rockTex.normal;
    (this.matRock as any)._roughnessTexture = rockTex.roughness;
    (this.matRock as any)._userBaseColor = '#8c8a86';
    (this.matRock as any)._userRoughnessLevel = 0.82;
    (this.matRock as any)._userMetallicLevel = 0.0;
    RealisticTextures.ensureObjectMaterialPlugin(this.matRock);

    this.matDam.albedoTexture = rockTex.diffuse;
    this.matDam.bumpTexture = rockTex.normal;
    (this.matDam as any)._roughnessTexture = rockTex.roughness;
    (this.matDam as any)._userBaseColor = '#9da0a3';
    (this.matDam as any)._userRoughnessLevel = 0.82;
    (this.matDam as any)._userMetallicLevel = 0.0;
    RealisticTextures.ensureObjectMaterialPlugin(this.matDam);

    if (!(this.matWater as any)._roughnessTexture) {
      (this.matWater as any)._roughnessTexture = RealisticTextures.createSeamlessWaterRoughnessTexture(this.scene);
    }
    (this.matWater as any)._userBaseColor = '#144761';
    (this.matWater as any)._userColorTexLevel = 0.65;
    (this.matWater as any)._userRoughnessLevel = 0.12;
    (this.matWater as any)._userMetallicLevel = 0.05;
    (this.matWater as any)._maxSpecScale = 1.45;
    RealisticTextures.ensureObjectMaterialPlugin(this.matWater);

    const poleTex = RealisticTextures.createBrushedMetalTextures(this.scene, 'pinPole', [244, 244, 248]);
    this.matPinPole.albedoTexture = poleTex.diffuse;
    (this.matPinPole as any)._roughnessTexture = poleTex.roughness;
    this.matPinPole.bumpTexture = poleTex.normal;
    this.matPinPole.bumpTexture.level = 0.25;
    (this.matPinPole as any)._userBaseColor = '#f2f2ed';
    (this.matPinPole as any)._userRoughnessLevel = 0.35;
    (this.matPinPole as any)._userMetallicLevel = 0.85;
    RealisticTextures.ensureObjectMaterialPlugin(this.matPinPole);

    const flagTex = RealisticTextures.createFabricTextures(this.scene, 'pinFlag', [232, 34, 34]);
    this.matPinFlag.albedoTexture = flagTex.diffuse;
    (this.matPinFlag as any)._roughnessTexture = flagTex.roughness;
    this.matPinFlag.bumpTexture = flagTex.normal;
    this.matPinFlag.bumpTexture.level = 0.45;
    (this.matPinFlag as any)._userBaseColor = '#e82222';
    (this.matPinFlag as any)._userRoughnessLevel = 0.85;
    (this.matPinFlag as any)._userMetallicLevel = 0.0;
    RealisticTextures.ensureObjectMaterialPlugin(this.matPinFlag);
    if (!this.flagWindPlugin) {
      this.flagWindPlugin = new FlagClothWindPlugin(this.matPinFlag);
    }

    const cupTex = RealisticTextures.createBrushedMetalTextures(this.scene, 'pinCup', [242, 242, 245]);
    this.matCup.albedoTexture = cupTex.diffuse;
    (this.matCup as any)._roughnessTexture = cupTex.roughness;
    this.matCup.bumpTexture = cupTex.normal;
    this.matCup.bumpTexture.level = 0.20;
    (this.matCup as any)._userBaseColor = '#15171a';
    (this.matCup as any)._userRoughnessLevel = 0.40;
    (this.matCup as any)._userMetallicLevel = 0.50;
    RealisticTextures.ensureObjectMaterialPlugin(this.matCup);

    const linerTex = RealisticTextures.createBrushedMetalTextures(this.scene, 'pinCupLiner', [65, 70, 76]);
    this.matCupLiner.albedoTexture = linerTex.diffuse;
    (this.matCupLiner as any)._roughnessTexture = linerTex.roughness;
    this.matCupLiner.bumpTexture = linerTex.normal;
    this.matCupLiner.bumpTexture.level = 0.25;
    (this.matCupLiner as any)._userBaseColor = '#ebeff2';
    (this.matCupLiner as any)._userRoughnessLevel = 0.32;
    (this.matCupLiner as any)._userMetallicLevel = 0.75;
    RealisticTextures.ensureObjectMaterialPlugin(this.matCupLiner);

    const goldTex = RealisticTextures.createBrushedMetalTextures(this.scene, 'pinGoldTrim', [228, 180, 56]);
    this.matGoldTrim.albedoTexture = goldTex.diffuse;
    (this.matGoldTrim as any)._roughnessTexture = goldTex.roughness;
    this.matGoldTrim.bumpTexture = goldTex.normal;
    this.matGoldTrim.bumpTexture.level = 0.25;
    (this.matGoldTrim as any)._userBaseColor = '#d9ad3d';
    (this.matGoldTrim as any)._userRoughnessLevel = 0.25;
    (this.matGoldTrim as any)._userMetallicLevel = 0.92;
    (this.matGoldTrim as any)._maxSpecScale = 1.35;
    RealisticTextures.ensureObjectMaterialPlugin(this.matGoldTrim);
  }

  /**
   * Loads both `/models/pine_tree_medium_01_01.glb` and `/models/hero_tree_01_01.glb`
   * directly from their glTF 2.0 binary containers.
   */
  public async loadTreeModels(deferUnusedCliffs: boolean = false): Promise<void> {
    this.ensureProceduralMaterialsPbr();
    const tasks: Promise<void>[] = [
      this.loadMediumPineTreeGlb(),
      this.loadHeroTreeGlb(),
      this.loadWoodlandTreeGlb(),
      this.loadBushGlb(),
      this.loadRockGlb(),
      this.loadDuckGlb()
    ];
    if (!deferUnusedCliffs) {
      tasks.push(this.ensureCliffGlbLoaded());
    }
    await Promise.all(tasks);
  }

  public ensureCliffGlbLoaded(): Promise<void> {
    if (this.cliffVertexData) return Promise.resolve();
    if (!this.cliffLoadPromise) {
      this.cliffLoadPromise = this.loadCliffGlb();
    }
    return this.cliffLoadPromise;
  }

  private async loadMediumPineTreeGlb(): Promise<void> {
    try {
      const response = await fetch('/models/pine_tree_medium_01_01.glb');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} loading pine_tree_medium_01_01.glb`);
      }
      const arrayBuf = await response.arrayBuffer();
      const view = new DataView(arrayBuf);

      const magic = view.getUint32(0, true);
      if (magic !== 0x46546C67) {
        throw new Error('Invalid GLB magic header');
      }

      const jsonChunkLen = view.getUint32(12, true);
      const jsonBytes = new Uint8Array(arrayBuf, 20, jsonChunkLen);
      const gltf = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));

      const binChunkStart = 20 + jsonChunkLen + 8;

      const nodeTranslation: [number, number, number] = gltf.nodes?.[0]?.translation || [0, 8.0455818, 0];
      const prim = gltf.meshes[0].primitives[0];

      const posAccessor = gltf.accessors[prim.attributes.POSITION];
      const posBV = gltf.bufferViews[posAccessor.bufferView];
      const rawPos = new Float32Array(arrayBuf, binChunkStart + (posBV.byteOffset || 0), posAccessor.count * 3);

      const normAccessor = gltf.accessors[prim.attributes.NORMAL];
      const normBV = normAccessor ? gltf.bufferViews[normAccessor.bufferView] : null;
      const rawNormals = normBV ? new Float32Array(arrayBuf, binChunkStart + (normBV.byteOffset || 0), normAccessor.count * 3) : null;

      const uvAccessor = gltf.accessors[prim.attributes.TEXCOORD_0];
      const uvBV = gltf.bufferViews[uvAccessor.bufferView];
      const rawUvs = new Float32Array(arrayBuf, binChunkStart + (uvBV.byteOffset || 0), uvAccessor.count * 2);

      const idxAccessor = gltf.accessors[prim.indices];
      const idxBV = gltf.bufferViews[idxAccessor.bufferView];
      const rawIndices = new Uint16Array(arrayBuf, binChunkStart + (idxBV.byteOffset || 0), idxAccessor.count);

      const positions = new Float32Array(posAccessor.count * 3);
      const normals = new Float32Array(posAccessor.count * 3);
      const uvs = new Float32Array(uvAccessor.count * 2);
      const indices = new Uint32Array(idxAccessor.count);

      for (let i = 0; i < posAccessor.count; i++) {
        const px = rawPos[i * 3] + nodeTranslation[0];
        const py = rawPos[i * 3 + 1] + nodeTranslation[1];
        const pz = rawPos[i * 3 + 2] + nodeTranslation[2];

        positions[i * 3] = px;
        positions[i * 3 + 1] = py;
        positions[i * 3 + 2] = pz;

        // Authentic glTF authored normals: preserve rich natural branch depth, shadows and highlights
        let nx = rawNormals ? rawNormals[i * 3] : 0;
        let ny = rawNormals ? rawNormals[i * 3 + 1] : 1;
        let nz = rawNormals ? rawNormals[i * 3 + 2] : 0;
        const nNorm = Math.hypot(nx, ny, nz) || 1.0;
        normals[i * 3] = nx / nNorm;
        normals[i * 3 + 1] = ny / nNorm;
        normals[i * 3 + 2] = nz / nNorm;

        uvs[i * 2] = rawUvs[i * 2];
        uvs[i * 2 + 1] = rawUvs[i * 2 + 1];
      }

      for (let i = 0; i < idxAccessor.count; i++) {
        indices[i] = rawIndices[i];
      }

      const vd = new VertexData();
      vd.positions = positions;
      vd.normals = normals;
      vd.uvs = uvs;
      vd.indices = indices;
      this.pineTreeVertexData = vd;

      const master = this.ensureMasterPineMesh();
      this.pineTreeVertexData.applyToMesh(master, false);
      master.material = this.matGlbPineTree;

      for (const treeMesh of this.activeTreeMeshes) {
        if (!treeMesh.isDisposed()) {
          if (treeMesh instanceof Mesh) {
            this.pineTreeVertexData.applyToMesh(treeMesh, false);
            treeMesh.material = this.matGlbPineTree;
          }
        }
      }

      const matDef = gltf.materials?.[0];
      const baseColorTexIdx = matDef?.pbrMetallicRoughness?.baseColorTexture?.index;
      if (baseColorTexIdx !== undefined) {
        const imgIdx = gltf.textures?.[baseColorTexIdx]?.source;
        const blob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, imgIdx);
        if (blob) {
          const treeTex = await this.createCrispFoliageTextureFromBlob(blob, 'pineTreeGlbCrispAlbedo', 1.0);
          this.matGlbPineTree.albedoTexture = treeTex;
          this.matGlbPineTree.opacityTexture = treeTex;
          this.matGlbPineTree.useAlphaFromAlbedoTexture = true;
          this.matGlbPineTree.transparencyMode = Material.MATERIAL_ALPHATEST;
          this.matGlbPineTree.alphaCutOff = 0.35;
          this.matGlbPineTree.backFaceCulling = false;
        }
      }
      const normTexIdx = matDef?.normalTexture?.index;
      if (normTexIdx !== undefined) {
        const imgIdx = gltf.textures?.[normTexIdx]?.source;
        const blob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, imgIdx);
        if (blob) {
          this.matGlbPineTree.bumpTexture = await this.createTextureFromBlob(blob, 'pineTreeGlbNor', false);
          this.matGlbPineTree.bumpTexture.level = 0.65;
        }
      }
      const mrTexIdx = matDef?.pbrMetallicRoughness?.metallicRoughnessTexture?.index;
      if (mrTexIdx !== undefined) {
        const imgIdx = gltf.textures?.[mrTexIdx]?.source;
        const blob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, imgIdx);
        if (blob) {
          (this.matGlbPineTree as any)._roughnessTexture = await RealisticTextures.createRoughnessFromMetallicRoughnessBlob(
            this.scene,
            'pineTreeGlbRough',
            blob
          );
        }
      }
      (this.matGlbPineTree as any)._userBaseColor = '#3f5f32';
      (this.matGlbPineTree as any)._userRoughnessLevel = 0.82;
      (this.matGlbPineTree as any)._userMetallicLevel = 0.0;
      RealisticTextures.ensureObjectMaterialPlugin(this.matGlbPineTree);
      this.matGlbPineTree.markAsDirty(Material.AllDirtyFlag);
    } catch (err) {
      console.error('Failed to load pine_tree_medium_01_01.glb:', err);
    }
  }

  private async loadHeroTreeGlb(): Promise<void> {
    try {
      const response = await fetch('/models/hero_tree_01_01.glb');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} loading hero_tree_01_01.glb`);
      }
      const arrayBuf = await response.arrayBuffer();
      const view = new DataView(arrayBuf);
      if (view.getUint32(0, true) !== 0x46546C67) {
        throw new Error('Invalid GLB header in hero_tree_01_01.glb');
      }

      const jsonChunkLen = view.getUint32(12, true);
      const gltf = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(arrayBuf, 20, jsonChunkLen)));
      const binChunkStart = 20 + jsonChunkLen + 8;

      const buildPrimitiveVertexData = (primIdx: number): VertexData => {
        const prim = gltf.meshes[0].primitives[primIdx];
        const posAcc = gltf.accessors[prim.attributes.POSITION];
        const normAcc = gltf.accessors[prim.attributes.NORMAL];
        const uvAcc = gltf.accessors[prim.attributes.TEXCOORD_0];
        const idxAcc = gltf.accessors[prim.indices];

        const posBV = gltf.bufferViews[posAcc.bufferView];
        const normBV = gltf.bufferViews[normAcc.bufferView];
        const uvBV = gltf.bufferViews[uvAcc.bufferView];
        const idxBV = gltf.bufferViews[idxAcc.bufferView];

        const positions = new Float32Array(arrayBuf, binChunkStart + (posBV.byteOffset || 0), posAcc.count * 3);
        const normals = new Float32Array(arrayBuf, binChunkStart + (normBV.byteOffset || 0), normAcc.count * 3);
        const uvs = new Float32Array(arrayBuf, binChunkStart + (uvBV.byteOffset || 0), uvAcc.count * 2);

        let indices: Uint32Array | Uint16Array;
        if (idxAcc.componentType === 5125) {
          indices = new Uint32Array(arrayBuf, binChunkStart + (idxBV.byteOffset || 0), idxAcc.count);
        } else {
          indices = new Uint16Array(arrayBuf, binChunkStart + (idxBV.byteOffset || 0), idxAcc.count);
        }

        const vd = new VertexData();
        vd.positions = positions;
        vd.normals = normals;
        vd.uvs = uvs;
        vd.indices = indices;
        return vd;
      };

      this.heroBranchesVertexData = buildPrimitiveVertexData(0);
      this.heroLeavesVertexData = buildPrimitiveVertexData(1);
      this.heroTrunkVertexData = buildPrimitiveVertexData(2);

      const mBranches = this.ensureMasterHeroBranchesMesh();
      const mLeaves = this.ensureMasterHeroLeavesMesh();
      const mTrunk = this.ensureMasterHeroTrunkMesh();
      this.heroBranchesVertexData.applyToMesh(mBranches, false);
      this.heroLeavesVertexData.applyToMesh(mLeaves, false);
      this.heroTrunkVertexData.applyToMesh(mTrunk, false);

      for (const h of this.activeHeroTrees) {
        if (h.branches instanceof Mesh && !h.branches.isDisposed()) this.heroBranchesVertexData.applyToMesh(h.branches, false);
        if (h.leaves instanceof Mesh && !h.leaves.isDisposed()) this.heroLeavesVertexData.applyToMesh(h.leaves, false);
        if (h.trunk instanceof Mesh && !h.trunk.isDisposed()) this.heroTrunkVertexData.applyToMesh(h.trunk, false);
      }

      const branchBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 0);
      if (branchBlob) {
        this.matHeroBranches.albedoTexture = await this.createTextureFromBlob(branchBlob, 'heroBranchDiff');
        const brPbr = await RealisticTextures.createNormalAndRoughnessFromBlob(this.scene, 'heroBranch', branchBlob, 2.8, 0.25);
        this.matHeroBranches.bumpTexture = brPbr.normal;
        this.matHeroBranches.bumpTexture.level = 0.75;
        (this.matHeroBranches as any)._roughnessTexture = brPbr.roughness;
      }
      (this.matHeroBranches as any)._userBaseColor = '#5b4a38';
      (this.matHeroBranches as any)._userRoughnessLevel = 0.80;
      (this.matHeroBranches as any)._userMetallicLevel = 0.0;
      RealisticTextures.ensureObjectMaterialPlugin(this.matHeroBranches);
      this.matHeroBranches.markAsDirty(Material.AllDirtyFlag);

      const trunkBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 2, 'image/jpeg');
      if (trunkBlob) {
        this.matHeroTrunk.albedoTexture = await this.createTextureFromBlob(trunkBlob, 'heroTrunkDiff');
        const trPbr = await RealisticTextures.createNormalAndRoughnessFromBlob(this.scene, 'heroTrunk', trunkBlob, 3.2, 0.20);
        this.matHeroTrunk.bumpTexture = trPbr.normal;
        this.matHeroTrunk.bumpTexture.level = 0.85;
        (this.matHeroTrunk as any)._roughnessTexture = trPbr.roughness;
      }
      (this.matHeroTrunk as any)._userBaseColor = '#5a4636';
      (this.matHeroTrunk as any)._userRoughnessLevel = 0.85;
      (this.matHeroTrunk as any)._userMetallicLevel = 0.0;
      RealisticTextures.ensureObjectMaterialPlugin(this.matHeroTrunk);
      this.matHeroTrunk.markAsDirty(Material.AllDirtyFlag);

      const leafBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 1);
      if (leafBlob) {
        const crispLeafTex = await this.createCrispFoliageTextureFromBlob(leafBlob, 'heroLeavesCrispDiff', 1.0);
        this.matHeroLeaves.albedoTexture = crispLeafTex;
        this.matHeroLeaves.opacityTexture = crispLeafTex;
        this.matHeroLeaves.useAlphaFromAlbedoTexture = true;
        const lfPbr = await RealisticTextures.createNormalAndRoughnessFromBlob(this.scene, 'heroLeaves', leafBlob, 2.2, 0.30);
        this.matHeroLeaves.bumpTexture = lfPbr.normal;
        this.matHeroLeaves.bumpTexture.level = 0.60;
        (this.matHeroLeaves as any)._roughnessTexture = lfPbr.roughness;
      }
      (this.matHeroLeaves as any)._userBaseColor = '#4a6e34';
      (this.matHeroLeaves as any)._userRoughnessLevel = 0.78;
      (this.matHeroLeaves as any)._userMetallicLevel = 0.0;
      RealisticTextures.ensureObjectMaterialPlugin(this.matHeroLeaves);
      this.matHeroLeaves.markAsDirty(Material.AllDirtyFlag);
    } catch (err) {
      console.error('Failed to load hero_tree_01_01.glb:', err);
    }
  }

  private async loadWoodlandTreeGlb(): Promise<void> {
    try {
      const response = await fetch('/models/Tree_woodland_01.glb');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} loading Tree_woodland_01.glb`);
      }
      const arrayBuf = await response.arrayBuffer();
      const view = new DataView(arrayBuf);
      if (view.getUint32(0, true) !== 0x46546C67) {
        throw new Error('Invalid GLB header in Tree_woodland_01.glb');
      }

      const jsonChunkLen = view.getUint32(12, true);
      const gltf = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(arrayBuf, 20, jsonChunkLen)));
      const binChunkStart = 20 + jsonChunkLen + 8;
      const nodeScale: number[] = gltf.nodes?.[0]?.scale || [0.01, 0.01, 0.01];
      const sx = nodeScale[0] ?? 0.01;
      const sy = nodeScale[1] ?? 0.01;
      const sz = nodeScale[2] ?? 0.01;

      const buildWoodlandPrim = (primIdx: number, isFoliage: boolean): VertexData => {
        const prim = gltf.meshes[0].primitives[primIdx];
        const posAcc = gltf.accessors[prim.attributes.POSITION];
        const normAcc = gltf.accessors[prim.attributes.NORMAL];
        const uvAcc = gltf.accessors[prim.attributes.TEXCOORD_0];
        const idxAcc = gltf.accessors[prim.indices];

        const posBV = gltf.bufferViews[posAcc.bufferView];
        const normBV = gltf.bufferViews[normAcc.bufferView];
        const uvBV = gltf.bufferViews[uvAcc.bufferView];
        const idxBV = gltf.bufferViews[idxAcc.bufferView];

        const rawPos = new Float32Array(arrayBuf, binChunkStart + (posBV.byteOffset || 0) + (posAcc.byteOffset || 0), posAcc.count * 3);
        const rawNorm = new Float32Array(arrayBuf, binChunkStart + (normBV.byteOffset || 0) + (normAcc.byteOffset || 0), normAcc.count * 3);
        const rawUv = new Float32Array(arrayBuf, binChunkStart + (uvBV.byteOffset || 0) + (uvAcc.byteOffset || 0), uvAcc.count * 2);

        const positions = new Float32Array(posAcc.count * 3);
        const normals = new Float32Array(normAcc.count * 3);
        const uvs = new Float32Array(rawUv);

        for (let i = 0; i < posAcc.count; i++) {
          positions[i * 3] = rawPos[i * 3] * sx;
          positions[i * 3 + 1] = rawPos[i * 3 + 1] * sy;
          positions[i * 3 + 2] = rawPos[i * 3 + 2] * sz;

          let nx = rawNorm[i * 3];
          let ny = rawNorm[i * 3 + 1];
          let nz = rawNorm[i * 3 + 2];
          const len = Math.hypot(nx, ny, nz) || 1.0;
          normals[i * 3] = nx / len;
          normals[i * 3 + 1] = ny / len;
          normals[i * 3 + 2] = nz / len;
        }

        let indices: Uint32Array;
        const rawIdxOff = binChunkStart + (idxBV.byteOffset || 0) + (idxAcc.byteOffset || 0);
        if (idxAcc.componentType === 5125) {
          indices = new Uint32Array(new Uint32Array(arrayBuf, rawIdxOff, idxAcc.count));
        } else {
          const u16 = new Uint16Array(arrayBuf, rawIdxOff, idxAcc.count);
          indices = new Uint32Array(u16.length);
          for (let i = 0; i < u16.length; i++) indices[i] = u16[i];
        }

        const vd = new VertexData();
        vd.positions = positions;
        vd.normals = normals;
        vd.uvs = uvs;
        vd.indices = indices;
        return vd;
      };

      this.woodlandBarkVertexData = buildWoodlandPrim(0, false);
      this.woodlandLeavesVertexData = buildWoodlandPrim(1, true);

      const mBark = this.ensureMasterWoodlandBarkMesh();
      const mLeaves = this.ensureMasterWoodlandLeavesMesh();
      this.woodlandBarkVertexData.applyToMesh(mBark, false);
      this.woodlandLeavesVertexData.applyToMesh(mLeaves, false);

      for (const w of this.activeWoodlandTrees) {
        if (w.bark instanceof Mesh && !w.bark.isDisposed()) this.woodlandBarkVertexData.applyToMesh(w.bark, false);
        if (w.leaves instanceof Mesh && !w.leaves.isDisposed()) this.woodlandLeavesVertexData.applyToMesh(w.leaves, false);
      }

      // Material 0: Trank_bark1 -> baseColor image 0
      const barkBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 0);
      if (barkBlob) {
        this.matWoodlandBark.albedoTexture = await this.createTextureFromBlob(barkBlob, 'woodlandBarkDiff', false);
        const brPbr = await RealisticTextures.createNormalAndRoughnessFromBlob(this.scene, 'woodlandBark', barkBlob, 2.6, 0.20);
        this.matWoodlandBark.bumpTexture = brPbr.normal;
        this.matWoodlandBark.bumpTexture.level = 0.80;
        (this.matWoodlandBark as any)._roughnessTexture = brPbr.roughness;
      }
      (this.matWoodlandBark as any)._userBaseColor = '#5a4636';
      (this.matWoodlandBark as any)._userRoughnessLevel = 0.85;
      (this.matWoodlandBark as any)._userMetallicLevel = 0.0;
      RealisticTextures.ensureObjectMaterialPlugin(this.matWoodlandBark);
      this.matWoodlandBark.markAsDirty(Material.AllDirtyFlag);

      // Material 1: DB2X2_L02 -> baseColor image 3, normal image 2, metallicRoughness image 4
      const leafDiffBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 3);
      if (leafDiffBlob) {
        const crispLeafTex = await this.createCrispFoliageTextureFromBlob(leafDiffBlob, 'woodlandLeavesCrispDiff', 1.0);
        this.matWoodlandLeaves.albedoTexture = crispLeafTex;
        this.matWoodlandLeaves.opacityTexture = crispLeafTex;
        this.matWoodlandLeaves.useAlphaFromAlbedoTexture = true;
      }
      const leafNormBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 2);
      if (leafNormBlob) {
        const lNorm = await this.createTextureFromBlob(leafNormBlob, 'woodlandLeavesNor', false);
        lNorm.level = 0.65;
        this.matWoodlandLeaves.bumpTexture = lNorm;
      }
      const leafMrBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 4);
      if (leafMrBlob) {
        (this.matWoodlandLeaves as any)._roughnessTexture =
          await RealisticTextures.createRoughnessFromMetallicRoughnessBlob(this.scene, 'woodlandLeavesRough', leafMrBlob);
      }
      (this.matWoodlandLeaves as any)._userBaseColor = '#4a6e34';
      (this.matWoodlandLeaves as any)._userRoughnessLevel = 0.78;
      (this.matWoodlandLeaves as any)._userMetallicLevel = 0.0;
      RealisticTextures.ensureObjectMaterialPlugin(this.matWoodlandLeaves);
      this.matWoodlandLeaves.markAsDirty(Material.AllDirtyFlag);
    } catch (err) {
      console.error('Failed to load Tree_woodland_01.glb:', err);
    }
  }

  private async loadBushGlb(): Promise<void> {
    try {
      const response = await fetch('/models/bush_01.glb');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} loading bush_01.glb`);
      }
      const arrayBuf = await response.arrayBuffer();
      const view = new DataView(arrayBuf);
      if (view.getUint32(0, true) !== 0x46546C67) {
        throw new Error('Invalid GLB header in bush_01.glb');
      }

      const jsonChunkLen = view.getUint32(12, true);
      const gltf = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(arrayBuf, 20, jsonChunkLen)));
      const binChunkStart = 20 + jsonChunkLen + 8;

      const buildPrimitiveVertexData = (primIdx: number): VertexData => {
        const prim = gltf.meshes[0].primitives[primIdx];
        const posAcc = gltf.accessors[prim.attributes.POSITION];
        const normAcc = gltf.accessors[prim.attributes.NORMAL];
        const uvAcc = gltf.accessors[prim.attributes.TEXCOORD_0];
        const idxAcc = gltf.accessors[prim.indices];

        const posBV = gltf.bufferViews[posAcc.bufferView];
        const normBV = gltf.bufferViews[normAcc.bufferView];
        const uvBV = gltf.bufferViews[uvAcc.bufferView];
        const idxBV = gltf.bufferViews[idxAcc.bufferView];

        const positions = new Float32Array(arrayBuf, binChunkStart + (posBV.byteOffset || 0), posAcc.count * 3);
        const normals = new Float32Array(arrayBuf, binChunkStart + (normBV.byteOffset || 0), normAcc.count * 3);
        const uvs = new Float32Array(arrayBuf, binChunkStart + (uvBV.byteOffset || 0), uvAcc.count * 2);

        let indices: Uint32Array | Uint16Array;
        if (idxAcc.componentType === 5125) {
          indices = new Uint32Array(arrayBuf, binChunkStart + (idxBV.byteOffset || 0), idxAcc.count);
        } else {
          indices = new Uint16Array(arrayBuf, binChunkStart + (idxBV.byteOffset || 0), idxAcc.count);
        }

        const vd = new VertexData();
        vd.positions = positions;
        vd.normals = normals;
        vd.uvs = uvs;
        vd.indices = indices;
        return vd;
      };

      this.bushBranchesVertexData = buildPrimitiveVertexData(0);
      this.bushLeavesVertexData = buildPrimitiveVertexData(1);

      const mBranches = this.ensureMasterBushBranchesMesh();
      const mLeaves = this.ensureMasterBushLeavesMesh();
      this.bushBranchesVertexData.applyToMesh(mBranches, false);
      this.bushLeavesVertexData.applyToMesh(mLeaves, false);

      for (const b of this.activeBushes) {
        if (b.branches instanceof Mesh && !b.branches.isDisposed()) this.bushBranchesVertexData.applyToMesh(b.branches, false);
        if (b.leaves instanceof Mesh && !b.leaves.isDisposed()) this.bushLeavesVertexData.applyToMesh(b.leaves, false);
      }

      const branchDiffBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 1, 'image/jpeg');
      if (branchDiffBlob) this.matBushBranches.albedoTexture = await this.createTextureFromBlob(branchDiffBlob, 'bushBranchDiff');

      const bushNorBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 0);
      if (bushNorBlob) {
        const norTex = await this.createTextureFromBlob(bushNorBlob, 'bushBranchNor');
        norTex.level = 0.75;
        this.matBushBranches.bumpTexture = norTex;
      }

      const bushRoughBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 2);
      const bushRoughTex = bushRoughBlob
        ? await RealisticTextures.createSpecularFromMetallicRoughnessBlob(this.scene, 'bushRough', bushRoughBlob)
        : null;
      if (bushRoughTex) {
        (this.matBushBranches as any)._roughnessTexture = bushRoughTex;
        (this.matBushLeaves as any)._roughnessTexture = bushRoughTex;
      }

      const leafBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 3);
      if (leafBlob) {
        const crispLeafTex = await this.createCrispFoliageTextureFromBlob(leafBlob, 'bushLeavesCrispDiff', 1.0);
        this.matBushLeaves.albedoTexture = crispLeafTex;
        this.matBushLeaves.opacityTexture = crispLeafTex;
        this.matBushLeaves.useAlphaFromAlbedoTexture = true;
      }
      if (bushNorBlob) {
        const leafNor = await this.createTextureFromBlob(bushNorBlob, 'bushLeavesNor');
        leafNor.level = 0.65;
        this.matBushLeaves.bumpTexture = leafNor;
      }
      (this.matBushBranches as any)._userBaseColor = '#5b4b38';
      (this.matBushBranches as any)._userRoughnessLevel = 0.85;
      (this.matBushBranches as any)._userMetallicLevel = 0.0;
      RealisticTextures.ensureObjectMaterialPlugin(this.matBushBranches);
      this.matBushBranches.markAsDirty(Material.AllDirtyFlag);
      (this.matBushLeaves as any)._userBaseColor = '#4c7036';
      (this.matBushLeaves as any)._userRoughnessLevel = 0.78;
      (this.matBushLeaves as any)._userMetallicLevel = 0.0;
      RealisticTextures.ensureObjectMaterialPlugin(this.matBushLeaves);
      this.matBushLeaves.markAsDirty(Material.AllDirtyFlag);
    } catch (err) {
      console.error('Failed to load bush_01.glb:', err);
    }
  }

  private async loadRockGlb(): Promise<void> {
    try {
      const response = await fetch('/models/Rock_01.glb');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} loading Rock_01.glb`);
      }
      const arrayBuf = await response.arrayBuffer();
      const view = new DataView(arrayBuf);
      if (view.getUint32(0, true) !== 0x46546C67) {
        throw new Error('Invalid GLB header in Rock_01.glb');
      }

      const jsonChunkLen = view.getUint32(12, true);
      const gltf = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(arrayBuf, 20, jsonChunkLen)));
      const binChunkStart = 20 + jsonChunkLen + 8;

      const prim = gltf.meshes[0].primitives[0];
      const posAcc = gltf.accessors[prim.attributes.POSITION];
      const normAcc = gltf.accessors[prim.attributes.NORMAL];
      const uvAcc = gltf.accessors[prim.attributes.TEXCOORD_0];
      const idxAcc = gltf.accessors[prim.indices];

      const posBV = gltf.bufferViews[posAcc.bufferView];
      const normBV = gltf.bufferViews[normAcc.bufferView];
      const uvBV = gltf.bufferViews[uvAcc.bufferView];
      const idxBV = gltf.bufferViews[idxAcc.bufferView];

      const positions = new Float32Array(arrayBuf, binChunkStart + (posBV.byteOffset || 0), posAcc.count * 3);
      const normals = new Float32Array(arrayBuf, binChunkStart + (normBV.byteOffset || 0), normAcc.count * 3);
      const uvs = new Float32Array(arrayBuf, binChunkStart + (uvBV.byteOffset || 0), uvAcc.count * 2);

      let indices: Uint32Array | Uint16Array;
      if (idxAcc.componentType === 5125) {
        indices = new Uint32Array(arrayBuf, binChunkStart + (idxBV.byteOffset || 0), idxAcc.count);
      } else {
        indices = new Uint16Array(arrayBuf, binChunkStart + (idxBV.byteOffset || 0), idxAcc.count);
      }

      const vd = new VertexData();
      vd.positions = positions;
      vd.normals = normals;
      vd.uvs = uvs;
      vd.indices = indices;
      this.rockGlbVertexData = vd;

      const mRock = this.ensureMasterRockMesh();
      this.rockGlbVertexData.applyToMesh(mRock, false);
      mRock.material = this.matGlbRock;

      for (const r of this.activeRocks) {
        if (r instanceof Mesh && !r.isDisposed()) this.rockGlbVertexData.applyToMesh(r, false);
      }

      const rockDiffBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 2);
      if (rockDiffBlob) this.matGlbRock.albedoTexture = await this.createTextureFromBlob(rockDiffBlob, 'rockGlbDiff');

      const rockNorBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 0);
      if (rockNorBlob) this.matGlbRock.bumpTexture = await this.createTextureFromBlob(rockNorBlob, 'rockGlbNor');

      const rockRoughBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 1);
      if (rockRoughBlob) {
        (this.matGlbRock as any)._roughnessTexture = await RealisticTextures.createRoughnessFromMetallicRoughnessBlob(
          this.scene,
          'rockGlbRough',
          rockRoughBlob
        );
      }
      (this.matGlbRock as any)._userBaseColor = '#847e77';
      (this.matGlbRock as any)._userRoughnessLevel = 0.82;
      (this.matGlbRock as any)._userMetallicLevel = 0.0;
      RealisticTextures.ensureObjectMaterialPlugin(this.matGlbRock);
      this.matGlbRock.markAsDirty(Material.AllDirtyFlag);
    } catch (err) {
      console.error('Failed to load Rock_01.glb:', err);
    }
  }

  private async loadCliffGlb(): Promise<void> {
    try {
      const response = await fetch('/models/Cliff_01.glb');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} loading Cliff_01.glb`);
      }
      const arrayBuf = await response.arrayBuffer();
      const view = new DataView(arrayBuf);
      if (view.getUint32(0, true) !== 0x46546C67) {
        throw new Error('Invalid GLB header in Cliff_01.glb');
      }

      const jsonChunkLen = view.getUint32(12, true);
      const gltf = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(arrayBuf, 20, jsonChunkLen)));
      const binChunkStart = 20 + jsonChunkLen + 8;

      const prim = gltf.meshes[0].primitives[0];
      const posAcc = gltf.accessors[prim.attributes.POSITION];
      const normAcc = gltf.accessors[prim.attributes.NORMAL];
      const uvAcc = gltf.accessors[prim.attributes.TEXCOORD_0];
      const idxAcc = gltf.accessors[prim.indices];

      const posBV = gltf.bufferViews[posAcc.bufferView];
      const normBV = gltf.bufferViews[normAcc.bufferView];
      const uvBV = gltf.bufferViews[uvAcc.bufferView];
      const idxBV = gltf.bufferViews[idxAcc.bufferView];

      const positions = new Float32Array(arrayBuf, binChunkStart + (posBV.byteOffset || 0), posAcc.count * 3);
      const normals = new Float32Array(arrayBuf, binChunkStart + (normBV.byteOffset || 0), normAcc.count * 3);
      const uvs = new Float32Array(arrayBuf, binChunkStart + (uvBV.byteOffset || 0), uvAcc.count * 2);

      let indices: Uint32Array | Uint16Array;
      if (idxAcc.componentType === 5125) {
        indices = new Uint32Array(arrayBuf, binChunkStart + (idxBV.byteOffset || 0), idxAcc.count);
      } else {
        indices = new Uint16Array(arrayBuf, binChunkStart + (idxBV.byteOffset || 0), idxAcc.count);
      }

      const vd = new VertexData();
      vd.positions = positions;
      vd.normals = normals;
      vd.uvs = uvs;
      vd.indices = indices;
      this.cliffVertexData = vd;

      const mCliff = this.ensureMasterCliffMesh();
      this.cliffVertexData.applyToMesh(mCliff, false);
      mCliff.material = this.matCliff;

      for (const c of this.activeCliffs) {
        if (c instanceof Mesh && !c.isDisposed()) this.cliffVertexData.applyToMesh(c, false);
      }

      const cliffDiffBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 1, 'image/jpeg');
      if (cliffDiffBlob) this.matCliff.albedoTexture = await this.createTextureFromBlob(cliffDiffBlob, 'cliffGlbDiff');

      const cliffNorBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 0);
      if (cliffNorBlob) this.matCliff.bumpTexture = await this.createTextureFromBlob(cliffNorBlob, 'cliffGlbNor');

      const cliffRoughBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 2);
      if (cliffRoughBlob) {
        (this.matCliff as any)._roughnessTexture = await RealisticTextures.createRoughnessFromMetallicRoughnessBlob(
          this.scene,
          'cliffGlbRough',
          cliffRoughBlob
        );
      }
      (this.matCliff as any)._userBaseColor = '#80705c';
      (this.matCliff as any)._userRoughnessLevel = 0.85;
      (this.matCliff as any)._userMetallicLevel = 0.0;
      RealisticTextures.ensureObjectMaterialPlugin(this.matCliff);
      this.matCliff.markAsDirty(Material.AllDirtyFlag);
    } catch (err) {
      console.error('Failed to load Cliff_01.glb:', err);
    }
  }

  private async loadDuckGlb(): Promise<void> {
    try {
      const response = await fetch('/models/rubber_duck_01_01.glb');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} loading rubber_duck_01_01.glb`);
      }
      const arrayBuf = await response.arrayBuffer();
      const view = new DataView(arrayBuf);
      if (view.getUint32(0, true) !== 0x46546C67) {
        throw new Error('Invalid GLB header in rubber_duck_01_01.glb');
      }

      const jsonChunkLen = view.getUint32(12, true);
      const gltf = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(arrayBuf, 20, jsonChunkLen)));
      const binChunkStart = 20 + jsonChunkLen + 8;

      const prim = gltf.meshes[0].primitives[0];
      const posAcc = gltf.accessors[prim.attributes.POSITION];
      const normAcc = gltf.accessors[prim.attributes.NORMAL];
      const uvAcc = gltf.accessors[prim.attributes.TEXCOORD_0];
      const idxAcc = gltf.accessors[prim.indices];

      const posBV = gltf.bufferViews[posAcc.bufferView];
      const normBV = gltf.bufferViews[normAcc.bufferView];
      const uvBV = gltf.bufferViews[uvAcc.bufferView];
      const idxBV = gltf.bufferViews[idxAcc.bufferView];

      const positions = new Float32Array(arrayBuf, binChunkStart + (posBV.byteOffset || 0), posAcc.count * 3);
      const normals = new Float32Array(arrayBuf, binChunkStart + (normBV.byteOffset || 0), normAcc.count * 3);
      const uvs = new Float32Array(arrayBuf, binChunkStart + (uvBV.byteOffset || 0), uvAcc.count * 2);

      let indices: Uint32Array | Uint16Array;
      if (idxAcc.componentType === 5125) {
        indices = new Uint32Array(arrayBuf, binChunkStart + (idxBV.byteOffset || 0), idxAcc.count);
      } else {
        indices = new Uint16Array(arrayBuf, binChunkStart + (idxBV.byteOffset || 0), idxAcc.count);
      }

      const vd = new VertexData();
      vd.positions = positions;
      vd.normals = normals;
      vd.uvs = uvs;
      vd.indices = indices;
      this.duckVertexData = vd;

      this.matDuck = new PBRMaterial('matDuckTeeMarker', this.scene);
      this.matDuck.albedoColor = Color3.White();
      this.matDuck.emissiveColor = Color3.Black();
      this.matDuck.metallic = 0.0;
      this.matDuck.roughness = 0.42;
      this.matDuck.backFaceCulling = false;

      const duckDiffBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 1, 'image/jpeg');
      if (duckDiffBlob) this.matDuck.albedoTexture = await this.createTextureFromBlob(duckDiffBlob, 'duckGlbDiff');

      const duckNorBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 0);
      if (duckNorBlob) this.matDuck.bumpTexture = await this.createTextureFromBlob(duckNorBlob, 'duckGlbNor');

      const duckRoughBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, 2);
      if (duckRoughBlob) {
        (this.matDuck as any)._roughnessTexture = await RealisticTextures.createRoughnessFromMetallicRoughnessBlob(
          this.scene,
          'duckGlbRough',
          duckRoughBlob
        );
      }
      (this.matDuck as any)._userBaseColor = '#f4c623';
      (this.matDuck as any)._userColorTexLevel = 1.0;
      (this.matDuck as any)._userRoughnessLevel = 0.42;
      (this.matDuck as any)._userMetallicLevel = 0.0;
      RealisticTextures.ensureObjectMaterialPlugin(this.matDuck);

      const mDuck = this.ensureMasterDuckMesh();
      this.duckVertexData.applyToMesh(mDuck, false);
      mDuck.material = this.matDuck;

      for (const d of this.activeDucks) {
        if (!d.isDisposed()) {
          if (d instanceof Mesh) {
            this.duckVertexData.applyToMesh(d, false);
            d.material = this.matDuck;
          }
        }
      }
    } catch (err) {
      console.error('Failed to load rubber_duck_01_01.glb:', err);
    }
  }

  // --- Master Mesh Getters / Initializers for GPU Hardware Instancing ---
  public ensureMasterPineMesh(): Mesh {
    if (!this.masterPineMesh) {
      this.masterPineMesh = new Mesh('master_pine_tree', this.scene);
      this.masterPineMesh.position.set(0, 0, 0);
      this.masterPineMesh.isVisible = false;
      this.masterPineMesh.material = this.matGlbPineTree;
      this.masterPineMesh.receiveShadows = false;
      this.masterPineMesh.isPickable = false;
      if (this.pineTreeVertexData) {
        this.pineTreeVertexData.applyToMesh(this.masterPineMesh, false);
      }
    }
    return this.masterPineMesh;
  }

  public ensureMasterHeroBranchesMesh(): Mesh {
    if (!this.masterHeroBranchesMesh) {
      this.masterHeroBranchesMesh = new Mesh('master_hero_branches', this.scene);
      this.masterHeroBranchesMesh.position.set(0, 0, 0);
      this.masterHeroBranchesMesh.isVisible = false;
      this.masterHeroBranchesMesh.material = this.matHeroBranches;
      this.masterHeroBranchesMesh.receiveShadows = false;
      this.masterHeroBranchesMesh.isPickable = false;
      if (this.heroBranchesVertexData) this.heroBranchesVertexData.applyToMesh(this.masterHeroBranchesMesh, false);
    }
    return this.masterHeroBranchesMesh;
  }

  public ensureMasterHeroLeavesMesh(): Mesh {
    if (!this.masterHeroLeavesMesh) {
      this.masterHeroLeavesMesh = new Mesh('master_hero_leaves', this.scene);
      this.masterHeroLeavesMesh.position.set(0, 0, 0);
      this.masterHeroLeavesMesh.isVisible = false;
      this.masterHeroLeavesMesh.material = this.matHeroLeaves;
      this.masterHeroLeavesMesh.receiveShadows = false;
      this.masterHeroLeavesMesh.isPickable = false;
      if (this.heroLeavesVertexData) this.heroLeavesVertexData.applyToMesh(this.masterHeroLeavesMesh, false);
    }
    return this.masterHeroLeavesMesh;
  }

  public ensureMasterHeroTrunkMesh(): Mesh {
    if (!this.masterHeroTrunkMesh) {
      this.masterHeroTrunkMesh = new Mesh('master_hero_trunk', this.scene);
      this.masterHeroTrunkMesh.position.set(0, 0, 0);
      this.masterHeroTrunkMesh.isVisible = false;
      this.masterHeroTrunkMesh.material = this.matHeroTrunk;
      this.masterHeroTrunkMesh.receiveShadows = true;
      this.masterHeroTrunkMesh.isPickable = false;
      if (this.heroTrunkVertexData) this.heroTrunkVertexData.applyToMesh(this.masterHeroTrunkMesh, false);
    }
    return this.masterHeroTrunkMesh;
  }

  public ensureMasterWoodlandBarkMesh(): Mesh {
    if (!this.masterWoodlandBarkMesh) {
      this.masterWoodlandBarkMesh = new Mesh('master_woodland_bark', this.scene);
      this.masterWoodlandBarkMesh.position.set(0, 0, 0);
      this.masterWoodlandBarkMesh.isVisible = false;
      this.masterWoodlandBarkMesh.material = this.matWoodlandBark;
      this.masterWoodlandBarkMesh.receiveShadows = true;
      this.masterWoodlandBarkMesh.isPickable = false;
      if (this.woodlandBarkVertexData) this.woodlandBarkVertexData.applyToMesh(this.masterWoodlandBarkMesh, false);
    }
    return this.masterWoodlandBarkMesh;
  }

  public ensureMasterWoodlandLeavesMesh(): Mesh {
    if (!this.masterWoodlandLeavesMesh) {
      this.masterWoodlandLeavesMesh = new Mesh('master_woodland_leaves', this.scene);
      this.masterWoodlandLeavesMesh.position.set(0, 0, 0);
      this.masterWoodlandLeavesMesh.isVisible = false;
      this.masterWoodlandLeavesMesh.material = this.matWoodlandLeaves;
      this.masterWoodlandLeavesMesh.receiveShadows = false;
      this.masterWoodlandLeavesMesh.isPickable = false;
      if (this.woodlandLeavesVertexData) this.woodlandLeavesVertexData.applyToMesh(this.masterWoodlandLeavesMesh, false);
    }
    return this.masterWoodlandLeavesMesh;
  }

  public ensureMasterBushBranchesMesh(): Mesh {
    if (!this.masterBushBranchesMesh) {
      this.masterBushBranchesMesh = new Mesh('master_bush_branches', this.scene);
      this.masterBushBranchesMesh.position.set(0, 0, 0);
      this.masterBushBranchesMesh.isVisible = false;
      this.masterBushBranchesMesh.material = this.matBushBranches;
      this.masterBushBranchesMesh.receiveShadows = false;
      this.masterBushBranchesMesh.isPickable = false;
      if (this.bushBranchesVertexData) this.bushBranchesVertexData.applyToMesh(this.masterBushBranchesMesh, false);
    }
    return this.masterBushBranchesMesh;
  }

  public ensureMasterBushLeavesMesh(): Mesh {
    if (!this.masterBushLeavesMesh) {
      this.masterBushLeavesMesh = new Mesh('master_bush_leaves', this.scene);
      this.masterBushLeavesMesh.position.set(0, 0, 0);
      this.masterBushLeavesMesh.isVisible = false;
      this.masterBushLeavesMesh.material = this.matBushLeaves;
      this.masterBushLeavesMesh.receiveShadows = false;
      this.masterBushLeavesMesh.isPickable = false;
      if (this.bushLeavesVertexData) this.bushLeavesVertexData.applyToMesh(this.masterBushLeavesMesh, false);
    }
    return this.masterBushLeavesMesh;
  }

  public ensureMasterRockMesh(): Mesh {
    if (!this.masterRockMesh) {
      this.masterRockMesh = new Mesh('master_rock_glb', this.scene);
      this.masterRockMesh.position.set(0, 0, 0);
      this.masterRockMesh.isVisible = false;
      this.masterRockMesh.material = this.matGlbRock;
      this.masterRockMesh.receiveShadows = true;
      this.masterRockMesh.isPickable = false;
      if (this.rockGlbVertexData) this.rockGlbVertexData.applyToMesh(this.masterRockMesh, false);
    }
    return this.masterRockMesh;
  }

  public ensureMasterCliffMesh(): Mesh {
    if (!this.masterCliffMesh) {
      this.masterCliffMesh = new Mesh('master_cliff_glb', this.scene);
      this.masterCliffMesh.position.set(0, 0, 0);
      this.masterCliffMesh.isVisible = false;
      this.masterCliffMesh.material = this.matCliff;
      this.masterCliffMesh.receiveShadows = true;
      this.masterCliffMesh.isPickable = false;
      if (this.cliffVertexData) this.cliffVertexData.applyToMesh(this.masterCliffMesh, false);
    }
    return this.masterCliffMesh;
  }

  public ensureMasterDuckMesh(): Mesh {
    if (!this.masterDuckMesh) {
      this.masterDuckMesh = new Mesh('master_duck_glb', this.scene);
      this.masterDuckMesh.position.set(0, 0, 0);
      this.masterDuckMesh.isVisible = false;
      if (this.matDuck) this.masterDuckMesh.material = this.matDuck;
      this.masterDuckMesh.receiveShadows = true;
      this.masterDuckMesh.isPickable = false;
      if (this.duckVertexData) this.duckVertexData.applyToMesh(this.masterDuckMesh, false);
    }
    return this.masterDuckMesh;
  }

  public getMasterMeshes(): Mesh[] {
    const list: Mesh[] = [];
    if (this.masterPineMesh) list.push(this.masterPineMesh);
    if (this.masterHeroBranchesMesh) list.push(this.masterHeroBranchesMesh);
    if (this.masterHeroLeavesMesh) list.push(this.masterHeroLeavesMesh);
    if (this.masterHeroTrunkMesh) list.push(this.masterHeroTrunkMesh);
    if (this.masterWoodlandBarkMesh) list.push(this.masterWoodlandBarkMesh);
    if (this.masterWoodlandLeavesMesh) list.push(this.masterWoodlandLeavesMesh);
    if (this.masterBushBranchesMesh) list.push(this.masterBushBranchesMesh);
    if (this.masterBushLeavesMesh) list.push(this.masterBushLeavesMesh);
    if (this.masterRockMesh) list.push(this.masterRockMesh);
    if (this.masterCliffMesh) list.push(this.masterCliffMesh);
    if (this.masterDuckMesh) list.push(this.masterDuckMesh);
    return list;
  }

  /**
   * Creates a GPU-instanced 3D Pine Tree (`pine_tree_medium_01_01.glb`).
   * Rendered in 1 single instanced draw call across all pine trees on the course.
   */
  public createPineTree(x: number, y: number, z: number, scale = 1.0, rotationY?: number): InstancedMesh {
    const master = this.ensureMasterPineMesh();
    const idx = this.activeTreeMeshes.length;
    const treeMesh = master.createInstance(`pine_glb_${Math.round(x)}_${Math.round(z)}_${idx}`);

    // Seat trunk slightly into the terrain so it never floats on hillside slopes
    treeMesh.position.set(x, y - 0.14, z);
    treeMesh.scaling.set(scale, scale, scale);
    treeMesh.rotation.y = rotationY !== undefined ? rotationY : ((x * 1.73 + z * 2.41) % (Math.PI * 2));
    treeMesh.receiveShadows = false;
    treeMesh.isPickable = true;
    treeMesh.computeWorldMatrix(true);
    treeMesh.refreshBoundingInfo();

    this.activeTreeMeshes.push(treeMesh);

    // Track tree collider for realistic physics deflections
    this.treeColliders.push({
      x,
      y,
      z,
      trunkRadius: 0.28 * scale,
      trunkHeight: 3.2 * scale,
      canopyRadius: 2.3 * scale,
      canopyBottomY: y + 1.8 * scale,
      canopyTopY: y + 12.0 * scale,
      isHero: false,
      mesh: treeMesh
    });

    return treeMesh;
  }

  /**
   * Creates an instance of the high-detail Hero Specimen Tree (`hero_tree_01_01.glb`)
   * Rendered in 3 instanced draw calls (branches, leaves, trunk).
   */
  public createHeroTree(x: number, y: number, z: number, scale = 1.0, rotationY?: number): Mesh {
    const idx = this.activeHeroTrees.length;
    const root = new Mesh(`hero_tree_root_${idx}`, this.scene);
    root.position.set(x, y - 0.08, z);
    // Native height in Blender is ~4.5m; 3.1x scale gives a majestic ~14m specimen tree
    const s = scale * 3.1;
    root.scaling.set(s, s, s);
    root.rotation.y = rotationY !== undefined ? rotationY : ((x * 1.37 + z * 2.19) % (Math.PI * 2));

    const branches = this.ensureMasterHeroBranchesMesh().createInstance(`hero_tree_branches_${idx}`);
    branches.position.set(0, 0, 0);
    branches.isPickable = true;
    branches.parent = root;

    const leaves = this.ensureMasterHeroLeavesMesh().createInstance(`hero_tree_leaves_${idx}`);
    leaves.position.set(0, 0, 0);
    leaves.receiveShadows = false;
    leaves.isPickable = true;
    leaves.parent = root;

    const trunk = this.ensureMasterHeroTrunkMesh().createInstance(`hero_tree_trunk_${idx}`);
    trunk.position.set(0, 0, 0);
    trunk.receiveShadows = true;
    trunk.isPickable = true;
    trunk.parent = root;

    root.computeWorldMatrix(true);
    branches.computeWorldMatrix(true);
    branches.refreshBoundingInfo();
    leaves.computeWorldMatrix(true);
    leaves.refreshBoundingInfo();
    trunk.computeWorldMatrix(true);
    trunk.refreshBoundingInfo();

    this.activeHeroTrees.push({ branches, leaves, trunk });

    // Track hero tree collider
    this.treeColliders.push({
      x,
      y,
      z,
      trunkRadius: 0.55 * scale,
      trunkHeight: 4.5 * scale,
      canopyRadius: 4.8 * scale,
      canopyBottomY: y + 2.8 * scale,
      canopyTopY: y + 14.5 * scale,
      isHero: true,
      mesh: root
    });

    return root;
  }

  /**
   * Creates an instance of the Woodland Tree (`/models/Tree_woodland_01.glb`)
   * Rendered in 2 instanced draw calls (bark trunk, leaves canopy).
   */
  public createWoodlandTree(x: number, y: number, z: number, scale = 1.0, rotationY?: number): Mesh {
    const idx = this.activeWoodlandTrees.length;
    const root = new Mesh(`woodland_tree_root_${idx}`, this.scene);
    root.position.set(x, y - 0.10, z);
    // Normalized node geometry is ~6.8m tall; 1.38x scale produces a balanced ~9.4m woodland specimen tree
    const s = scale * 1.38;
    root.scaling.set(s, s, s);
    root.rotation.y = rotationY !== undefined ? rotationY : ((x * 1.73 + z * 2.41) % (Math.PI * 2));

    const bark = this.ensureMasterWoodlandBarkMesh().createInstance(`woodland_tree_bark_${idx}`);
    bark.position.set(0, 0, 0);
    bark.receiveShadows = true;
    bark.isPickable = true;
    bark.parent = root;

    const leaves = this.ensureMasterWoodlandLeavesMesh().createInstance(`woodland_tree_leaves_${idx}`);
    leaves.position.set(0, 0, 0);
    leaves.receiveShadows = false;
    leaves.isPickable = true;
    leaves.parent = root;

    root.computeWorldMatrix(true);
    bark.computeWorldMatrix(true);
    bark.refreshBoundingInfo();
    leaves.computeWorldMatrix(true);
    leaves.refreshBoundingInfo();

    this.activeWoodlandTrees.push({ bark, leaves });

    this.treeColliders.push({
      x,
      y,
      z,
      trunkRadius: 0.42 * scale,
      trunkHeight: 3.6 * scale,
      canopyRadius: 3.8 * scale,
      canopyBottomY: y + 3.4 * scale,
      canopyTopY: y + 9.5 * scale,
      isHero: true,
      mesh: root
    });

    return root;
  }

  /**
   * Creates an instance of the realistic 3D Bush (`bush_01.glb`)
   * Rendered in 2 instanced draw calls (branches, leaves).
   */
  public createBush(x: number, y: number, z: number, scale = 1.0, rotationY?: number): Mesh {
    const idx = this.activeBushes.length;
    const root = new Mesh(`bush_root_${idx}`, this.scene);
    root.position.set(x, y - 0.24 * scale, z);
    const s = scale * 1.35;
    root.scaling.set(s, s, s);
    root.rotation.y = rotationY !== undefined ? rotationY : ((x * 1.73 + z * 2.41) % (Math.PI * 2));

    const branches = this.ensureMasterBushBranchesMesh().createInstance(`bush_branches_${idx}`);
    branches.position.set(0, 0, 0);
    branches.isPickable = true;
    branches.parent = root;

    const leaves = this.ensureMasterBushLeavesMesh().createInstance(`bush_leaves_${idx}`);
    leaves.position.set(0, 0, 0);
    leaves.receiveShadows = false;
    leaves.isPickable = true;
    leaves.parent = root;

    root.computeWorldMatrix(true);
    branches.computeWorldMatrix(true);
    branches.refreshBoundingInfo();
    leaves.computeWorldMatrix(true);
    leaves.refreshBoundingInfo();

    this.activeBushes.push({ branches, leaves });

    this.treeColliders.push({
      x,
      y,
      z,
      trunkRadius: 0,
      trunkHeight: 0,
      canopyRadius: 0.75 * s,
      canopyBottomY: y,
      canopyTopY: y + 1.15 * s,
      isHero: true,
      mesh: root
    });

    return root;
  }

  /**
   * Creates an instance of the realistic 3D Granite Boulder (`Rock_01.glb`)
   * Rendered in 1 instanced draw call across all boulders on the course.
   */
  public createRock(x: number, y: number, z: number, scale = 1.0, rotationY?: number): Mesh {
    const idx = this.activeRocks.length;
    const root = new Mesh(`rock_glb_root_${idx}`, this.scene);
    root.position.set(x, y + 0.05, z);
    const s = scale * 1.35;
    root.scaling.set(s, s, s);
    root.rotation.y = rotationY !== undefined ? rotationY : ((x * 2.11 + z * 1.49) % (Math.PI * 2));

    const rockInst = this.ensureMasterRockMesh().createInstance(`rock_glb_mesh_${idx}`);
    rockInst.position.set(0, 0, 0);
    rockInst.receiveShadows = true;
    rockInst.isPickable = true;
    rockInst.parent = root;
    rockInst.rotation.x = -Math.PI / 2;

    root.computeWorldMatrix(true);
    rockInst.computeWorldMatrix(true);
    rockInst.refreshBoundingInfo();

    this.activeRocks.push(rockInst);

    this.treeColliders.push({
      x,
      y,
      z,
      trunkRadius: 1.15 * s,
      trunkHeight: 1.55 * s,
      canopyRadius: 0,
      canopyBottomY: 0,
      canopyTopY: 0,
      isHero: false,
      mesh: root
    });

    return root;
  }

  /**
   * Alias for backward compatibility so all tree calls use the new realistic 3D pine tree model
   */
  public createOakTree(x: number, y: number, z: number, scale = 1.0, rotationY?: number): InstancedMesh | Mesh {
    return this.createPineTree(x, y, z, scale, rotationY);
  }

  /**
   * Creates an instance of the coastal cliff wall (Cliff_01.glb) along the hole boundary.
   * Rendered in 1 instanced draw call across all cliff sections.
   */
  public createCliff(x: number, y: number, z: number, scale = 1.0, rotationY = 0): Mesh {
    if (!this.cliffVertexData) {
      void this.ensureCliffGlbLoaded();
    }
    const idx = this.activeCliffs.length;
    const root = new Mesh(`cliff_glb_root_${idx}`, this.scene);
    root.position.set(x, y - 0.2, z);
    root.scaling.set(scale, scale, scale);
    root.rotation.y = rotationY;

    const cliffInst = this.ensureMasterCliffMesh().createInstance(`cliff_glb_mesh_${idx}`);
    cliffInst.position.set(0, 0, 0);
    cliffInst.receiveShadows = true;
    cliffInst.isPickable = true;
    cliffInst.parent = root;

    root.computeWorldMatrix(true);
    cliffInst.computeWorldMatrix(true);
    cliffInst.refreshBoundingInfo();

    this.activeCliffs.push(cliffInst);

    // Multi-point physical barrier collider along the ~80m cliff span
    const cosR = Math.cos(rotationY);
    const sinR = Math.sin(rotationY);
    const span = 36 * scale;
    for (let offset = -span; offset <= span; offset += 9 * scale) {
      this.treeColliders.push({
        x: x + offset * cosR,
        y: y,
        z: z - offset * sinR,
        trunkRadius: 4.8 * scale,
        trunkHeight: 12.0 * scale,
        canopyRadius: 0,
        canopyBottomY: 0,
        canopyTopY: 0,
        isHero: false,
        mesh: root
      });
    }

    return root;
  }

  /**
   * Sculpt a smooth mesh's vertices with organic 3D displacement and recompute smooth normals
   */
  private applyOrganicSmoothDisplacement(mesh: Mesh, amplitude: number, freq: number, seed: number) {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    if (!positions || !indices) return;

    for (let i = 0; i < positions.length; i += 3) {
      const px = positions[i];
      const py = positions[i + 1];
      const pz = positions[i + 2];

      const n =
        Math.sin(px * freq + seed) * Math.cos(py * freq * 0.9 + seed * 1.3) * Math.sin(pz * freq + seed * 0.7) +
        0.5 * Math.cos((px + pz) * freq * 1.8 + seed * 2.1);

      const scale = 1.0 + n * amplitude;
      positions[i] = px * scale;
      positions[i + 1] = py * (1.0 + n * amplitude * 0.65);
      positions[i + 2] = pz * scale;
    }

    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals);
    mesh.setVerticesData(VertexBuffer.PositionKind, positions, false);
    mesh.setVerticesData(VertexBuffer.NormalKind, normals, false);
  }

  /**
   * Realistic Smooth Granite Boulders (Subdivided displaced spheres with smooth normals)
   */
  public createRockCluster(x: number, y: number, z: number, scale = 1.0): Mesh {
    const root = new Mesh(`rocks_${x}_${z}`, this.scene);
    root.position.set(x, y, z);

    const rocks = [
      { x: 0, y: 0.42 * scale, z: 0, sx: 1.9 * scale, sy: 1.15 * scale, sz: 1.6 * scale, rot: 0.4 },
      { x: 1.15 * scale, y: 0.28 * scale, z: 0.55 * scale, sx: 1.15 * scale, sy: 0.82 * scale, sz: 1.2 * scale, rot: 1.2 },
      { x: -0.95 * scale, y: 0.32 * scale, z: -0.45 * scale, sx: 1.35 * scale, sy: 0.92 * scale, sz: 1.35 * scale, rot: -0.7 }
    ];

    for (let i = 0; i < rocks.length; i++) {
      const r = MeshBuilder.CreateSphere(`rock_${x}_${z}_${i}`, {
        diameter: 1.2,
        segments: 24
      }, this.scene);
      this.applyOrganicSmoothDisplacement(r, 0.16, 2.8, x + z + i * 5.7);
      r.position.set(rocks[i].x, rocks[i].y, rocks[i].z);
      r.scaling.set(rocks[i].sx, rocks[i].sy, rocks[i].sz);
      r.rotation.y = rocks[i].rot;
      r.material = this.matRock;
      r.receiveShadows = true;
      r.isPickable = true;
      r.parent = root;
    }

    return root;
  }

  public createDamWall(x: number, y: number, z: number, width = 30, height = 4): Mesh {
    const root = new Mesh(`dam_${x}_${z}`, this.scene);
    root.position.set(x, y, z);

    const wall = MeshBuilder.CreateBox(`dam_body_${x}_${z}`, {
      width: width,
      height: height,
      depth: 3.4
    }, this.scene);
    wall.position.y = height * 0.5;
    wall.material = this.matDam;
    wall.receiveShadows = true;
    wall.isPickable = true;
    wall.parent = root;

    const cap = MeshBuilder.CreateBox(`dam_cap_${x}_${z}`, {
      width: width + 0.4,
      height: 0.35,
      depth: 3.8
    }, this.scene);
    cap.position.y = height + 0.175;
    cap.material = this.matDam;
    cap.receiveShadows = true;
    cap.isPickable = true;
    cap.parent = root;

    return root;
  }

  /**
   * Creates an optimized, realistic multi-ring radial water surface mesh that aligns 1:1 with
   * the stamped water feature's dimensions (`width`, `length`) and orientation (`rotationRad`).
   * Features radial depth-tinted vertex colors and soft shoreline alpha feathering.
   */
  public createWaterPlane(
    x: number,
    rimElevation: number,
    z: number,
    width: number,
    length: number,
    rotationRad = 0
  ): Mesh {
    const water = new Mesh(`water_${Math.round(x)}_${Math.round(z)}`, this.scene);
    const halfW = width * 0.5 * 0.96;
    const halfL = length * 0.5 * 0.96;

    const segs = 44;
    const rings = [
      { r: 0.00, col: [0.06, 0.26, 0.38, 0.96] },
      { r: 0.62, col: [0.09, 0.34, 0.46, 0.93] },
      { r: 0.90, col: [0.20, 0.52, 0.59, 0.78] },
      { r: 1.00, col: [0.42, 0.66, 0.65, 0.08] }
    ];

    const numRings = rings.length;
    const totalVerts = 1 + (numRings - 1) * (segs + 1);
    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    const uvs = new Float32Array(totalVerts * 2);
    const colors = new Float32Array(totalVerts * 4);
    const indices: number[] = [];

    // Center vertex (index 0)
    positions[0] = 0;
    positions[1] = 0;
    positions[2] = 0;
    normals[0] = 0;
    normals[1] = 1;
    normals[2] = 0;
    uvs[0] = 0.5;
    uvs[1] = 0.5;
    colors[0] = rings[0].col[0];
    colors[1] = rings[0].col[1];
    colors[2] = rings[0].col[2];
    colors[3] = rings[0].col[3];

    let vIdx = 1;
    for (let rIdx = 1; rIdx < numRings; rIdx++) {
      const rFrac = rings[rIdx].r;
      const c = rings[rIdx].col;
      for (let s = 0; s <= segs; s++) {
        const theta = (s / segs) * Math.PI * 2;
        const lx = Math.cos(theta) * halfW * rFrac;
        const lz = Math.sin(theta) * halfL * rFrac;

        positions[vIdx * 3] = lx;
        positions[vIdx * 3 + 1] = 0;
        positions[vIdx * 3 + 2] = lz;

        normals[vIdx * 3] = 0;
        normals[vIdx * 3 + 1] = 1;
        normals[vIdx * 3 + 2] = 0;

        // World-proportional UV coordinates so water ripples are never stretched on elongated ponds
        uvs[vIdx * 2] = 0.5 + lx / 28.0;
        uvs[vIdx * 2 + 1] = 0.5 + lz / 28.0;

        colors[vIdx * 4] = c[0];
        colors[vIdx * 4 + 1] = c[1];
        colors[vIdx * 4 + 2] = c[2];
        colors[vIdx * 4 + 3] = c[3];

        vIdx++;
      }
    }

    // Inner fan (center 0 to ring 1)
    const ring1Start = 1;
    for (let s = 0; s < segs; s++) {
      indices.push(0, ring1Start + s + 1, ring1Start + s);
    }

    // Outer quad strips between rings
    for (let rIdx = 1; rIdx < numRings - 1; rIdx++) {
      const innerStart = 1 + (rIdx - 1) * (segs + 1);
      const outerStart = 1 + rIdx * (segs + 1);
      for (let s = 0; s < segs; s++) {
        const i0 = innerStart + s;
        const i1 = innerStart + s + 1;
        const o0 = outerStart + s;
        const o1 = outerStart + s + 1;
        indices.push(i0, o1, o0);
        indices.push(i0, i1, o1);
      }
    }

    const vd = new VertexData();
    vd.positions = positions;
    vd.normals = normals;
    vd.uvs = uvs;
    vd.colors = colors;
    vd.indices = indices;
    vd.applyToMesh(water, false);

    water.hasVertexAlpha = true;
    water.position.set(x, rimElevation - 0.19, z);
    // Match the exact rotation angle of the terrain's stamped feature (note: TerrainGrid uses localX = dx*cos(-rot) - dz*sin(-rot))
    water.rotation.y = -rotationRad;
    water.material = this.matWater;
    water.receiveShadows = true;
    water.isPickable = true;
    return water;
  }

  /**
   * Creates a triangulated 3D water surface mesh matching any arbitrary traced MapNG pond/lake contour
   * using pure 2D ear-clipping triangulation and inward shoreline vertex alpha feathering.
   */
  public createPolygonWaterPlane(
    contourWorldPts: readonly { x: number; z: number }[],
    rimElevation: number,
    centerX: number,
    centerZ: number
  ): Mesh {
    const water = new Mesh(`water_poly_${Math.round(centerX)}_${Math.round(centerZ)}`, this.scene);
    const tri = earclipTriangulate2D(contourWorldPts);
    const verts = tri.vertices;
    if (verts.length < 3 || tri.indices.length < 3) {
      return this.createWaterPlane(centerX, rimElevation, centerZ, 16, 16, 0);
    }

    // Add an interior centroid vertex if useful or compute smooth vertex depth color via edge distance
    const count = verts.length;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const colors = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
      const lx = verts[i].x - centerX;
      const lz = verts[i].z - centerZ;
      positions[i * 3] = lx;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = lz;

      normals[i * 3] = 0;
      normals[i * 3 + 1] = 1;
      normals[i * 3 + 2] = 0;

      uvs[i * 2] = 0.5 + lx / 28.0;
      uvs[i * 2 + 1] = 0.5 + lz / 28.0;

      // Perimeter vertices fade softly toward bank shoreline; interior gets deep teal tint
      const sd = signedDistanceToPolygon(verts[i].x, verts[i].z, verts);
      const t = Math.min(1, Math.max(0, -sd / 3.0));
      colors[i * 4] = 0.28 * (1 - t) + 0.08 * t;
      colors[i * 4 + 1] = 0.56 * (1 - t) + 0.30 * t;
      colors[i * 4 + 2] = 0.60 * (1 - t) + 0.42 * t;
      colors[i * 4 + 3] = 0.42 * (1 - t) + 0.94 * t;
    }

    // Note: triangle winding from earclipTriangulate2D is CCW in XZ -> swap 2nd & 3rd index per tri for +Y up in Babylon LH
    const babylonIndices = new Uint32Array(tri.indices.length);
    for (let k = 0; k + 2 < tri.indices.length; k += 3) {
      babylonIndices[k] = tri.indices[k];
      babylonIndices[k + 1] = tri.indices[k + 2];
      babylonIndices[k + 2] = tri.indices[k + 1];
    }

    const vd = new VertexData();
    vd.positions = positions;
    vd.normals = normals;
    vd.uvs = uvs;
    vd.colors = colors;
    vd.indices = babylonIndices;
    vd.applyToMesh(water, false);

    water.hasVertexAlpha = true;
    water.position.set(centerX, rimElevation - 0.19, centerZ);
    water.material = this.matWater;
    water.receiveShadows = true;
    water.isPickable = true;
    return water;
  }

  /**
   * Regulation USGA Golf Hole Cup + Metal Liner + Tapered Flagstick + Waving Cloth Flag
   */
  public createPinAndCup(x: number, groundY: number, z: number, holeNumber = 1): Mesh {
    const pinRoot = new Mesh(`pin_hole_${holeNumber}`, this.scene);
    pinRoot.position.set(x, groundY, z);

    const cup = MeshBuilder.CreateCylinder(`cup_${holeNumber}`, {
      height: GOLF_CONSTANTS.CUP_DEPTH,
      diameter: GOLF_CONSTANTS.CUP_RADIUS * 2,
      tessellation: 20
    }, this.scene);
    cup.position.y = -GOLF_CONSTANTS.CUP_DEPTH * 0.5 + 0.002;
    cup.material = this.matCup;
    cup.isPickable = true;
    cup.parent = pinRoot;

    const liner = MeshBuilder.CreateTorus(`cup_liner_${holeNumber}`, {
      diameter: GOLF_CONSTANTS.CUP_RADIUS * 2,
      thickness: 0.008,
      tessellation: 20
    }, this.scene);
    liner.position.y = 0.002;
    liner.material = this.matCupLiner;
    liner.isPickable = true;
    liner.parent = pinRoot;

    const pole = MeshBuilder.CreateCylinder(`pole_${holeNumber}`, {
      height: 2.4,
      diameterTop: 0.024,
      diameterBottom: 0.032,
      tessellation: 12
    }, this.scene);
    pole.position.y = 1.2;
    pole.material = this.matPinPole;
    pole.receiveShadows = true;
    pole.isPickable = true;
    pole.parent = pinRoot;

    const finial = MeshBuilder.CreateSphere(`pole_finial_${holeNumber}`, {
      diameter: 0.048,
      segments: 8
    }, this.scene);
    finial.position.y = 2.41;
    finial.material = this.matGoldTrim;
    finial.isPickable = true;
    finial.parent = pinRoot;

    const flag = MeshBuilder.CreateGround(`flag_${holeNumber}`, {
      width: 0.64,
      height: 0.42,
      subdivisionsX: 7,
      subdivisionsY: 2,
      updatable: false
    }, this.scene);
    flag.rotation.x = -Math.PI * 0.5;
    flag.rotation.y = this.windHeadingRad;
    flag.position.set(Math.cos(this.windHeadingRad) * 0.32, 2.16, -Math.sin(this.windHeadingRad) * 0.32);
    flag.material = this.matPinFlag;
    flag.receiveShadows = true;
    flag.isPickable = true;
    flag.parent = pinRoot;

    this.activeFlags = this.activeFlags.filter(f => !f.isDisposed());
    this.activeFlags.push(flag);

    return pinRoot;
  }

  /**
   * Realistic Championship Tee Markers: Red cubes with rounded corners,
   * compact PGA size (~13cm), and spaced further apart (~4.8m).
   */
  public createTeeMarkers(x: number, groundY: number, z: number, greenX = 130, greenZ = 360): Mesh {
    const root = new Mesh(`tee_markers_${x}_${z}`, this.scene);
    root.position.set(x, groundY, z);

    // Rubber Duck Championship Tee Markers (rubber_duck_01_01.glb)
    // Scale 0.85 gives ~0.24m (9.5 inches) charming tournament tee markers
    const duckScale = 0.85;

    // Orient ducks facing straight down the fairway directly towards the green
    const angleToGreen = Math.atan2(greenX - x, greenZ - z);

    [-2.4, 2.4].forEach((offset, i) => {
      const master = this.ensureMasterDuckMesh();
      const duckInst = master.createInstance(`tee_duck_${i}_${Math.round(x)}_${Math.round(z)}`);
      duckInst.position.set(offset, 0.005, 0);
      duckInst.scaling.set(duckScale, duckScale, duckScale);
      duckInst.rotation.y = angleToGreen;
      duckInst.receiveShadows = true;
      duckInst.isPickable = true;
      duckInst.parent = root;

      this.activeDucks.push(duckInst);
    });

    root.computeWorldMatrix(true);
    for (const child of root.getChildMeshes()) {
      child.computeWorldMatrix(true);
      child.refreshBoundingInfo({});
    }

    return root;
  }

  /**
   * Parses an arbitrary uploaded glTF 2.0 binary (.glb) buffer and replaces a selected 3D model's
   * geometry and PBR materials (preserving position, rotation, and scale) with full sub-material
   * Color / Roughness / Normal exposure in Developer Zone.
   */
  public async parseAndApplyReplacementGlb(
    rootMesh: Mesh,
    arrayBuf: ArrayBuffer,
    labelPrefix = 'customModel'
  ): Promise<{ partCount: number; materialNames: string[] }> {
    const view = new DataView(arrayBuf);
    if (arrayBuf.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) {
      throw new Error('Invalid GLB file header (expected glTF 2.0 binary .glb).');
    }

    let offset = 12;
    let jsonText = '';
    let binChunkStart = -1;
    while (offset + 8 <= arrayBuf.byteLength) {
      const chunkLen = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      if (chunkType === 0x4e4f534a) {
        jsonText = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuf, offset + 8, chunkLen));
      } else if (chunkType === 0x004e4942) {
        binChunkStart = offset + 8;
      }
      offset += 8 + chunkLen;
    }

    if (!jsonText || binChunkStart < 0) {
      throw new Error('GLB is missing required JSON or BIN chunk.');
    }

    const gltf = JSON.parse(jsonText);
    const readAccessor = (accIdx: number, expectedComponents: number): Float32Array => {
      const acc = gltf.accessors?.[accIdx];
      if (!acc) return new Float32Array(0);
      const bv = gltf.bufferViews?.[acc.bufferView];
      if (!bv) return new Float32Array(acc.count * expectedComponents);

      const byteOffset = binChunkStart + (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const compSize =
        acc.componentType === 5126 ? 4 :
        acc.componentType === 5125 ? 4 :
        acc.componentType === 5123 || acc.componentType === 5122 ? 2 : 1;
      const numComps =
        acc.type === 'VEC4' ? 4 :
        acc.type === 'VEC3' ? 3 :
        acc.type === 'VEC2' ? 2 : 1;
      const stride = bv.byteStride && bv.byteStride > 0 ? bv.byteStride : compSize * numComps;
      const out = new Float32Array(acc.count * expectedComponents);
      const norm = Boolean(acc.normalized);

      for (let i = 0; i < acc.count; i++) {
        const base = byteOffset + i * stride;
        for (let c = 0; c < Math.min(numComps, expectedComponents); c++) {
          const p = base + c * compSize;
          let val = 0;
          if (acc.componentType === 5126) val = view.getFloat32(p, true);
          else if (acc.componentType === 5123) val = view.getUint16(p, true) / (norm ? 65535 : 1);
          else if (acc.componentType === 5122) val = view.getInt16(p, true) / (norm ? 32767 : 1);
          else if (acc.componentType === 5121) val = view.getUint8(p) / (norm ? 255 : 1);
          else if (acc.componentType === 5120) val = view.getInt8(p) / (norm ? 127 : 1);
          else if (acc.componentType === 5125) val = view.getUint32(p, true);
          out[i * expectedComponents + c] = val;
        }
      }
      return out;
    };

    const readIndices = (accIdx: number | undefined, vertexCount: number): Uint32Array => {
      if (accIdx === undefined || !gltf.accessors?.[accIdx]) {
        const seq = new Uint32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) seq[i] = i;
        return seq;
      }
      const acc = gltf.accessors[accIdx];
      const bv = gltf.bufferViews?.[acc.bufferView];
      const byteOffset = binChunkStart + (bv?.byteOffset || 0) + (acc.byteOffset || 0);
      const out = new Uint32Array(acc.count);
      const stride = bv?.byteStride || (acc.componentType === 5125 ? 4 : acc.componentType === 5123 ? 2 : 1);
      for (let i = 0; i < acc.count; i++) {
        const p = byteOffset + i * stride;
        if (acc.componentType === 5125) out[i] = view.getUint32(p, true);
        else if (acc.componentType === 5123) out[i] = view.getUint16(p, true);
        else out[i] = view.getUint8(p);
      }
      return out;
    };

    // Measure old bounding box height in local space so replacement fits naturally
    let oldMinY = Infinity;
    let oldMaxY = -Infinity;
    const oldParts = [rootMesh, ...rootMesh.getChildMeshes(false)];
    for (const m of oldParts) {
      const pts = m.getVerticesData?.(VertexBuffer.PositionKind);
      if (pts && pts.length >= 3) {
        const sy = m === rootMesh ? 1 : m.scaling.y;
        const oy = m === rootMesh ? 0 : m.position.y;
        for (let i = 1; i < pts.length; i += 3) {
          const yv = oy + pts[i] * sy;
          if (yv < oldMinY) oldMinY = yv;
          if (yv > oldMaxY) oldMaxY = yv;
        }
      }
    }
    const oldHeight = isFinite(oldMinY) && isFinite(oldMaxY) ? Math.max(0.05, oldMaxY - oldMinY) : 0;

    // 1. Decode all GLB materials into PBR-capable PBRMaterials (Metallic-Roughness)
    const gltfMats = Array.isArray(gltf.materials) && gltf.materials.length > 0 ? gltf.materials : [{}];
    const builtMaterials: PBRMaterial[] = [];
    const uid = Date.now().toString(36);
    for (let mi = 0; mi < gltfMats.length; mi++) {
      const mDef = gltfMats[mi] || {};
      const matName = `matCustom_${labelPrefix}_${mi}_${uid}`;
      const mat = new PBRMaterial(matName, this.scene);
      mat.backFaceCulling = !mDef.doubleSided;

      const pbr = mDef.pbrMetallicRoughness || {};
      const bcf: number[] = Array.isArray(pbr.baseColorFactor) ? pbr.baseColorFactor : [1, 1, 1, 1];
      const baseCol = new Color3(bcf[0] ?? 1, bcf[1] ?? 1, bcf[2] ?? 1);
      const baseHex = RealisticTextures.toSafeHex(baseCol, '#ffffff');
      mat.albedoColor = baseCol;
      (mat as any)._userBaseColor = baseHex;
      (mat as any)._userSubMatLabel = mDef.name || `Material ${mi + 1}`;

      const diffImgIdx =
        pbr.baseColorTexture?.index !== undefined ? gltf.textures?.[pbr.baseColorTexture.index]?.source : undefined;
      if (diffImgIdx !== undefined) {
        const diffBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, diffImgIdx);
        if (diffBlob) {
          const dTex = await this.createTextureFromBlob(diffBlob, `${matName}_diff`, false);
          if (mDef.alphaMode === 'MASK' || mDef.alphaMode === 'BLEND') {
            dTex.hasAlpha = true;
            mat.useAlphaFromAlbedoTexture = true;
            if (mDef.alphaMode === 'MASK') {
              mat.alphaCutOff = mDef.alphaCutoff ?? 0.5;
              mat.transparencyMode = Material.MATERIAL_ALPHATEST;
            } else {
              mat.transparencyMode = Material.MATERIAL_ALPHABLEND;
            }
          }
          mat.albedoTexture = dTex;
        }
      }
      if (!mat.albedoTexture) {
        const flatDiff = new DynamicTexture(`${matName}_flatDiff`, { width: 16, height: 16 }, this.scene, false, Texture.TRILINEAR_SAMPLINGMODE);
        const fCtx = flatDiff.getContext() as CanvasRenderingContext2D;
        fCtx.fillStyle = baseHex;
        fCtx.fillRect(0, 0, 16, 16);
        flatDiff.update(false);
        RealisticTextures.attachPreviewDataUrl(flatDiff);
        mat.albedoTexture = flatDiff;
        (mat as any)._userColorTexLevel = 0.0;
      } else {
        (mat as any)._userColorTexLevel = 1.0;
      }

      const normImgIdx =
        mDef.normalTexture?.index !== undefined ? gltf.textures?.[mDef.normalTexture.index]?.source : undefined;
      if (normImgIdx !== undefined) {
        const nBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, normImgIdx);
        if (nBlob) {
          const nTex = await this.createTextureFromBlob(nBlob, `${matName}_nor`, false);
          nTex.level = mDef.normalTexture?.scale ?? 1.0;
          mat.bumpTexture = nTex;
        }
      }
      if (!mat.bumpTexture) {
        mat.bumpTexture = RealisticTextures.createFlatNormalTexture(this.scene, `${matName}_flatNor`);
        mat.bumpTexture.level = 0.0;
      }

      const mrImgIdx =
        pbr.metallicRoughnessTexture?.index !== undefined
          ? gltf.textures?.[pbr.metallicRoughnessTexture.index]?.source
          : undefined;
      if (mrImgIdx !== undefined) {
        const rBlob = this.getGlbImageBlob(gltf, arrayBuf, binChunkStart, mrImgIdx);
        if (rBlob) {
          (mat as any)._roughnessTexture = await RealisticTextures.createRoughnessFromMetallicRoughnessBlob(
            this.scene,
            `${matName}_rough`,
            rBlob
          );
        }
      }
      const roughFactor = pbr.roughnessFactor !== undefined ? Number(pbr.roughnessFactor) : 0.65;
      const metallicFactor = pbr.metallicFactor !== undefined ? Number(pbr.metallicFactor) : 0.0;
      if (!(mat as any)._roughnessTexture) {
        (mat as any)._roughnessTexture = RealisticTextures.createFlatRoughnessTexture(
          this.scene,
          `${matName}_flatRough`,
          roughFactor
        );
      }
      mat.roughness = roughFactor;
      mat.metallic = metallicFactor;
      (mat as any)._userRoughnessLevel = roughFactor;
      (mat as any)._userMetallicLevel = metallicFactor;
      RealisticTextures.ensureObjectMaterialPlugin(mat);
      builtMaterials.push(mat);
    }

    // 2. Collect transformed primitives by traversing glTF scene nodes
    interface BuiltPart {
      positions: Float32Array;
      normals: Float32Array;
      uvs: Float32Array;
      indices: Uint32Array;
      matIdx: number;
    }
    const collectedParts: BuiltPart[] = [];

    const traverseNode = (nodeIdx: number, parentMat: Matrix) => {
      const node = gltf.nodes?.[nodeIdx];
      if (!node) return;
      let localMat = Matrix.Identity();
      if (Array.isArray(node.matrix) && node.matrix.length === 16) {
        localMat = Matrix.FromArray(node.matrix);
      } else {
        const t = node.translation ? Vector3.FromArray(node.translation) : Vector3.Zero();
        const r = node.rotation
          ? new Quaternion(node.rotation[0], node.rotation[1], node.rotation[2], node.rotation[3])
          : Quaternion.Identity();
        const s = node.scale ? Vector3.FromArray(node.scale) : Vector3.One();
        localMat = Matrix.Compose(s, r, t);
      }
      const worldMat = localMat.multiply(parentMat);

      if (node.mesh !== undefined && gltf.meshes?.[node.mesh]) {
        const meshDef = gltf.meshes[node.mesh];
        for (const prim of meshDef.primitives || []) {
          if (prim.attributes?.POSITION === undefined) continue;
          const rawPos = readAccessor(prim.attributes.POSITION, 3);
          const vCount = rawPos.length / 3;
          if (vCount === 0) continue;

          const rawNorm =
            prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL, 3) : null;
          const uvs =
            prim.attributes.TEXCOORD_0 !== undefined
              ? readAccessor(prim.attributes.TEXCOORD_0, 2)
              : new Float32Array(vCount * 2);
          const indices = readIndices(prim.indices, vCount);

          const posOut = new Float32Array(rawPos.length);
          const normOut = new Float32Array(rawPos.length);
          const rotMat = worldMat.getRotationMatrix();
          for (let i = 0; i < vCount; i++) {
            const p = Vector3.TransformCoordinates(
              new Vector3(rawPos[i * 3], rawPos[i * 3 + 1], rawPos[i * 3 + 2]),
              worldMat
            );
            // Flip X/Z handedness adjustment not needed for standard glTF right-handed -> left-handed preview match,
            // keep consistent with existing glTF loaders in Scenery.ts
            posOut[i * 3] = p.x;
            posOut[i * 3 + 1] = p.y;
            posOut[i * 3 + 2] = p.z;
            if (rawNorm && rawNorm.length === rawPos.length) {
              const n = Vector3.TransformNormal(
                new Vector3(rawNorm[i * 3], rawNorm[i * 3 + 1], rawNorm[i * 3 + 2]),
                rotMat
              ).normalize();
              normOut[i * 3] = n.x;
              normOut[i * 3 + 1] = n.y;
              normOut[i * 3 + 2] = n.z;
            }
          }
          if (!rawNorm || rawNorm.length !== rawPos.length) {
            VertexData.ComputeNormals(posOut, indices, normOut);
          }

          const matIdx =
            prim.material !== undefined && prim.material < builtMaterials.length ? prim.material : 0;
          collectedParts.push({ positions: posOut, normals: normOut, uvs, indices, matIdx });
        }
      }

      if (Array.isArray(node.children)) {
        for (const ch of node.children) traverseNode(ch, worldMat);
      }
    };

    const sceneDef = gltf.scenes?.[gltf.scene ?? 0];
    if (sceneDef?.nodes?.length) {
      for (const nIdx of sceneDef.nodes) traverseNode(nIdx, Matrix.Identity());
    } else if (Array.isArray(gltf.meshes)) {
      for (let mIdx = 0; mIdx < gltf.meshes.length; mIdx++) {
        for (const prim of gltf.meshes[mIdx].primitives || []) {
          if (prim.attributes?.POSITION === undefined) continue;
          const rawPos = readAccessor(prim.attributes.POSITION, 3);
          const vCount = rawPos.length / 3;
          if (vCount === 0) continue;
          const indices = readIndices(prim.indices, vCount);
          const rawNorm =
            prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL, 3) : null;
          const normOut = rawNorm && rawNorm.length === rawPos.length ? rawNorm : new Float32Array(rawPos.length);
          if (!rawNorm || rawNorm.length !== rawPos.length) {
            VertexData.ComputeNormals(rawPos, indices, normOut);
          }
          const uvs =
            prim.attributes.TEXCOORD_0 !== undefined
              ? readAccessor(prim.attributes.TEXCOORD_0, 2)
              : new Float32Array(vCount * 2);
          const matIdx =
            prim.material !== undefined && prim.material < builtMaterials.length ? prim.material : 0;
          collectedParts.push({ positions: rawPos, normals: normOut, uvs, indices, matIdx });
        }
      }
    }

    if (collectedParts.length === 0) {
      throw new Error('Uploaded .glb contains no renderable mesh primitives.');
    }

    // 3. Center X/Z to 0, ground minY = 0, and fit cleanly if tiny tee marker or off-unit export
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const part of collectedParts) {
      for (let i = 0; i < part.positions.length; i += 3) {
        const px = part.positions[i];
        const py = part.positions[i + 1];
        const pz = part.positions[i + 2];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        if (pz < minZ) minZ = pz;
        if (pz > maxZ) maxZ = pz;
      }
    }
    const cx = (minX + maxX) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const newHeight = Math.max(0.01, maxY - minY);

    let fitScale = 1.0;
    if (rootMesh.name.startsWith('tee_markers_') && oldHeight > 0.04) {
      fitScale = (oldHeight * 1.15) / newHeight;
    } else if (oldHeight > 0.05 && (newHeight > 24.0 || newHeight < 0.25)) {
      fitScale = Math.max(0.8, Math.min(10.0, oldHeight)) / newHeight;
    }

    const builtVertexDatas: { vd: VertexData; mat: PBRMaterial }[] = collectedParts.map((part) => {
      const scaledPos = new Float32Array(part.positions.length);
      for (let i = 0; i < part.positions.length; i += 3) {
        scaledPos[i] = (part.positions[i] - cx) * fitScale;
        scaledPos[i + 1] = (part.positions[i + 1] - minY) * fitScale;
        scaledPos[i + 2] = (part.positions[i + 2] - cz) * fitScale;
      }
      const vd = new VertexData();
      vd.positions = scaledPos;
      vd.normals = part.normals;
      vd.uvs = part.uvs;
      vd.indices = part.indices;
      return { vd, mat: builtMaterials[part.matIdx] || builtMaterials[0] };
    });

    // 4. Apply onto selected rootMesh (preserving position/rotation/scale; tee_markers updates both marker slots)
    if (rootMesh.name.startsWith('tee_markers_')) {
      const oldDucks = rootMesh.getChildMeshes(false).filter((m) => m.name.startsWith('tee_duck_'));
      const slotTransforms =
        oldDucks.length > 0
          ? oldDucks.map((d) => ({
              pos: d.position.clone(),
              rotY: d.rotation.y
            }))
          : [
              { pos: new Vector3(-2.4, 0.005, 0), rotY: 0 },
              { pos: new Vector3(2.4, 0.005, 0), rotY: 0 }
            ];
      for (const ch of rootMesh.getChildMeshes(false)) ch.dispose();

      slotTransforms.forEach((slot, sIdx) => {
        const slotParent = new Mesh(`tee_duck_${sIdx}_custom_${uid}`, this.scene);
        slotParent.position.copyFrom(slot.pos);
        slotParent.rotation.y = slot.rotY;
        slotParent.parent = rootMesh;
        builtVertexDatas.forEach((bp, pIdx) => {
          const partMesh = new Mesh(`tee_duck_${sIdx}_part_${pIdx}_${uid}`, this.scene);
          bp.vd.applyToMesh(partMesh, false);
          partMesh.material = bp.mat;
          partMesh.receiveShadows = true;
          partMesh.isPickable = true;
          partMesh.parent = slotParent;
        });
      });
    } else {
      for (const ch of rootMesh.getChildMeshes(false)) ch.dispose();
      const hadDirectGeo = rootMesh.getTotalVertices() > 0;
      if (hadDirectGeo && builtVertexDatas.length === 1) {
        builtVertexDatas[0].vd.applyToMesh(rootMesh, false);
        rootMesh.material = builtVertexDatas[0].mat;
        rootMesh.receiveShadows = true;
        rootMesh.isPickable = true;
      } else {
        if (hadDirectGeo) {
          const blank = new VertexData();
          blank.positions = [];
          blank.normals = [];
          blank.uvs = [];
          blank.indices = [];
          blank.applyToMesh(rootMesh, false);
        }
        builtVertexDatas.forEach((bp, pIdx) => {
          const partMesh = new Mesh(`${rootMesh.name}_customPart_${pIdx}_${uid}`, this.scene);
          bp.vd.applyToMesh(partMesh, false);
          partMesh.material = bp.mat;
          partMesh.receiveShadows = true;
          partMesh.isPickable = true;
          partMesh.parent = rootMesh;
        });
      }
    }

    return {
      partCount: builtVertexDatas.length,
      materialNames: builtMaterials.map((m) => (m as any)._userSubMatLabel || m.name)
    };
  }
}
