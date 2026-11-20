import {
  Scene,
  DynamicTexture,
  Texture,
  Color3,
  Matrix,
  StandardMaterial,
  PBRMaterial,
  Material,
  MaterialPluginBase,
  MaterialDefines,
  UniformBuffer,
  BaseTexture
} from '@babylonjs/core';
import { getDeviceProfile } from '../core/DeviceProfile';

/**
 * Unified PBR Blend Plugin for 3D Object Materials (ducks, trees, rocks, cliffs, water, pin, flag, cup, ball, uploaded GLBs):
 * - Blends Base Color -> Color Texture linearly via `colorTexLevel` (0 = pure Base Color, 0.5 = 50/50, 1 = pure Color Texture)
 * - Evaluates true PBR Metallic-Roughness via `roughnessLevel` + `metallicLevel` + texture maps
 */
export class ObjectMaterialBlendPlugin extends MaterialPluginBase {
  public baseColorHex: string = '#ffffff';
  public colorTexLevel: number = 1.0;
  public enableColorTex: boolean = true;
  public roughnessLevel: number = 0.65;
  public metallicLevel: number = 0.0;
  public enableRoughTex: boolean = true;
  public enableMetallicTex: boolean = true;
  public maxSpecScale: number = 1.0;
  public roughnessTex: BaseTexture | null = null;
  private fallbackRoughTex: DynamicTexture;
  private targetMat: Material;

  constructor(material: Material) {
    super(material, 'ObjectMaterialBlend', 110, { OBJ_PBR_BLEND: true });
    this.targetMat = material;
    const scene = material.getScene();
    this.fallbackRoughTex = new DynamicTexture('objFallbackRough', { width: 2, height: 2 }, scene, false, Texture.BILINEAR_SAMPLINGMODE);
    const ctx = this.fallbackRoughTex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = 'rgb(166, 166, 166)';
    ctx.fillRect(0, 0, 2, 2);
    this.fallbackRoughTex.update(false);
    this._enable(true);
  }

  public getClassName(): string {
    return 'ObjectMaterialBlendPlugin';
  }

  public prepareDefines(defines: MaterialDefines) {
    defines['OBJ_PBR_BLEND'] = RealisticTextures.syncDefinesForSceneTextures(defines, this.targetMat.getScene());
  }

  public getUniforms() {
    return {
      ubo: [
        { name: 'uObjBaseColor', size: 4, type: 'vec4' },
        { name: 'uObjParams', size: 4, type: 'vec4' },
        { name: 'uObjFlags', size: 4, type: 'vec4' },
        { name: 'uObjRoughMatrix', size: 16, type: 'mat4' }
      ],
      vertex: `
        uniform vec4 uObjBaseColor;
        uniform vec4 uObjParams;
        uniform vec4 uObjFlags;
        uniform mat4 uObjRoughMatrix;
      `,
      fragment: `
        uniform vec4 uObjBaseColor;
        uniform vec4 uObjParams;
        uniform vec4 uObjFlags;
      `
    };
  }

  public getSamplers(samplers: string[]) {
    samplers.push('objRoughSampler');
  }

  public getActiveTextures(activeTextures: BaseTexture[]) {
    if (this.roughnessTex) activeTextures.push(this.roughnessTex);
  }

  public hasTexture(texture: BaseTexture): boolean {
    return this.roughnessTex === texture;
  }

  public isReadyForSubMesh(): boolean {
    return !this.roughnessTex || this.roughnessTex.isReady();
  }

  public bindForSubMesh(uniformBuffer: UniformBuffer) {
    const col = Color3.FromHexString(this.baseColorHex || '#ffffff');
    uniformBuffer.updateFloat4('uObjBaseColor', col.r, col.g, col.b, 1.0);

    const hasDiff = Boolean((this.targetMat as any).albedoTexture || (this.targetMat as any).diffuseTexture);
    const colorMix = (this.enableColorTex && hasDiff) ? Math.max(0, Math.min(1, this.colorTexLevel)) : 0.0;
    const roughLvl = Math.max(0, Math.min(1, this.roughnessLevel));
    const metallicLvl = Math.max(0, Math.min(1, this.metallicLevel));
    const hasRough = Boolean(this.roughnessTex);
    const roughOn = (this.enableRoughTex && hasRough) ? 1.0 : 0.0;

    uniformBuffer.updateFloat4('uObjParams', colorMix, roughLvl, roughOn, this.maxSpecScale);
    uniformBuffer.updateFloat4('uObjFlags', hasDiff ? 1.0 : 0.0, hasRough ? 1.0 : 0.0, metallicLvl, this.enableMetallicTex ? 1.0 : 0.0);

    const rTex = (this.roughnessTex && this.roughnessTex.isReady()) ? this.roughnessTex : this.fallbackRoughTex;
    uniformBuffer.setTexture('objRoughSampler', rTex);

    const matRef = this.roughnessTex || (this.targetMat as any).albedoTexture || (this.targetMat as any).diffuseTexture || (this.targetMat as any).bumpTexture;
    uniformBuffer.updateMatrix('uObjRoughMatrix', matRef ? matRef.getTextureMatrix() : Matrix.Identity());
  }

  public getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `varying vec2 vObjRoughUV;`,
        CUSTOM_VERTEX_MAIN_END: `
          #if defined(OBJ_PBR_BLEND) && defined(UV1)
            vObjRoughUV = (uObjRoughMatrix * vec4(uvUpdated, 1.0, 0.0)).xy;
          #else
            vObjRoughUV = vec2(0.0);
          #endif
        `
      };
    }
    if (shaderType === 'fragment') {
      const isPbr = this.targetMat instanceof PBRMaterial;
      if (isPbr) {
        return {
          CUSTOM_FRAGMENT_DEFINITIONS: `
            uniform sampler2D objRoughSampler;
            varying vec2 vObjRoughUV;
          `,
          // PBRMaterial Albedo hook
          CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
            #ifdef OBJ_PBR_BLEND
              #ifdef ALBEDO
                vec3 objTexRgb = texture2D(albedoSampler, vAlbedoUV).rgb;
                #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                  objTexRgb *= vColor.rgb;
                #endif
                vec3 objSolidRgb = uObjBaseColor.rgb;
                #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                  objSolidRgb *= vColor.rgb;
                #endif
                surfaceAlbedo = toLinearSpace(mix(objSolidRgb, objTexRgb, clamp(uObjParams.x, 0.0, 1.0)));
              #else
                vec3 objSolidRgb = uObjBaseColor.rgb;
                #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                  objSolidRgb *= vColor.rgb;
                #endif
                surfaceAlbedo = toLinearSpace(objSolidRgb);
              #endif
            #endif
          `,
          // PBRMaterial native Metallic-Roughness hook
          CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: `
            #ifdef OBJ_PBR_BLEND
              #ifdef METALLICWORKFLOW
                float objRSample = (uObjFlags.y > 0.5) ? texture2D(objRoughSampler, vObjRoughUV).r : 1.0;
                metallicRoughness.g = (uObjParams.z > 0.5) ? clamp(objRSample * uObjParams.y, 0.04, 1.0) : clamp(uObjParams.y, 0.04, 1.0);
                metallicRoughness.r = clamp(uObjFlags.z, 0.0, 1.0);
              #endif
            #endif
          `
        };
      }

      // StandardMaterial fallback hooks
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `
          uniform sampler2D objRoughSampler;
          varying vec2 vObjRoughUV;
        `,
        '!vec3\\s+baseAmbientColor=vec3\\(1\\.,1\\.,1\\.\\);': `
          #ifdef OBJ_PBR_BLEND
            #ifdef DIFFUSE
              vec3 objTexRgb = texture2D(diffuseSampler, vDiffuseUV).rgb;
              #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                objTexRgb *= vColor.rgb;
              #endif
              vec3 objSolidRgb = uObjBaseColor.rgb;
              #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                objSolidRgb *= vColor.rgb;
              #endif
              baseColor.rgb = mix(objSolidRgb, objTexRgb, clamp(uObjParams.x, 0.0, 1.0));
            #else
              vec3 objSolidRgb = uObjBaseColor.rgb;
              #if defined(VERTEXCOLOR) || defined(VERTEXALPHA)
                objSolidRgb *= vColor.rgb;
              #endif
              baseColor.rgb = objSolidRgb;
            #endif
            diffuseColor = vec3(1.0);
          #endif
          vec3 baseAmbientColor=vec3(1.,1.,1.);
        `,
        '!vec3\\s+diffuseBase=vec3\\(0\\.,0\\.,0\\.\\);': `
          #ifdef OBJ_PBR_BLEND
            float objRSample = (uObjFlags.y > 0.5) ? texture2D(objRoughSampler, vObjRoughUV).r : 0.65;
            float objEffRough = (uObjParams.z > 0.5) ? clamp(objRSample * uObjParams.y, 0.0, 1.0) : 0.14;
            float objSm = clamp(1.0 - objEffRough, 0.0, 1.0);
            specularColor = vec3(pow(objSm, 1.45) * 0.72 * uObjParams.w);
            glossiness = mix(3.0, 96.0, objSm * objSm);
          #endif
          vec3 diffuseBase=vec3(0.,0.,0.);
        `
      };
    }
    return null;
  }
}

/**
 * Generates high-resolution, mathematically seamless (toroidally tileable)
 * procedural PBR/Standard textures and 3D normal maps for grass, sand, water,
 * bark, foliage, rock, and golf ball dimples.
 */
export class RealisticTextures {
  private static wrapCoord(v: number, size: number): number {
    return ((v % size) + size) % size;
  }

  /**
   * Seamless deterministic 2D value noise on a toroidal grid [0..period)
   */
  private static seamlessNoise(x: number, y: number, period: number, seed: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;

    const u = xf * xf * (3.0 - 2.0 * xf);
    const v = yf * yf * (3.0 - 2.0 * yf);

    const x0 = ((xi % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const y0 = ((yi % period) + period) % period;
    const y1 = (y0 + 1) % period;

    const hash = (px: number, py: number) => {
      const h = Math.sin(px * 127.1 + py * 311.7 + seed * 74.7) * 43758.5453123;
      return h - Math.floor(h);
    };

    const n00 = hash(x0, y0);
    const n10 = hash(x1, y0);
    const n01 = hash(x0, y1);
    const n11 = hash(x1, y1);

    const nx0 = n00 * (1 - u) + n10 * u;
    const nx1 = n01 * (1 - u) + n11 * u;
    return nx0 * (1 - v) + nx1 * v;
  }

  private static seamlessFBM(u: number, v: number, basePeriod: number, octaves: number, seed: number): number {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;

    for (let i = 0; i < octaves; i++) {
      const p = basePeriod * freq;
      sum += this.seamlessNoise(u * p, v * p, p, seed + i * 19.3) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  /**
   * Creates a seamless 256x256 HTMLCanvasElement pattern tile for a specific golf turf or sand surface.
   * Used with ctx.createPattern(canvas, 'repeat') on the high-resolution course splat map.
   */
  public static createSeamlessSurfacePattern(
    type: 'rough' | 'first_cut' | 'fairway' | 'fringe' | 'green' | 'sand' | 'water_bed'
  ): HTMLCanvasElement {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const idx = (y * size + x) * 4;

        const nMacro = this.seamlessFBM(u, v, 6, 3, 1.1);
        const nMid = this.seamlessFBM(u, v, 24, 3, 2.7);
        const nMicro = this.seamlessFBM(u, v, 64, 2, 5.3);

        let r = 0, g = 0, b = 0;

        if (type === 'rough') {
          // Natural championship fescue & rough with earthy golden-brown thatch and muted olive grass
          const blade = (nMacro * 0.35 + nMid * 0.40 + nMicro * 0.25);
          const brownFescue = this.seamlessFBM(u, v, 14, 3, 3.8); // Organic golden-brown thatch patches
          r = 58 + blade * 36 + brownFescue * 30;
          g = 68 + blade * 32 - brownFescue * 10;
          b = 28 + blade * 18 + brownFescue * 12;
        } else if (type === 'first_cut') {
          // Dense intermediate cut bordering fairway
          const blade = (nMacro * 0.30 + nMid * 0.42 + nMicro * 0.28);
          r = 42 + blade * 36;
          g = 92 + blade * 52;
          b = 30 + blade * 25;
        } else if (type === 'fairway') {
          // Crisp tightly-mowed championship fairway turf
          const blade = (nMacro * 0.25 + nMid * 0.38 + nMicro * 0.37);
          r = 56 + blade * 38;
          g = 122 + blade * 50;
          b = 38 + blade * 26;
        } else if (type === 'fringe') {
          // Manicured collar grass around putting green
          const blade = (nMacro * 0.22 + nMid * 0.38 + nMicro * 0.40);
          r = 48 + blade * 34;
          g = 132 + blade * 46;
          b = 46 + blade * 26;
        } else if (type === 'green') {
          // Ultra-fine championship bentgrass putting surface
          const blade = (nMacro * 0.18 + nMid * 0.32 + nMicro * 0.50);
          r = 46 + blade * 30;
          g = 146 + blade * 42;
          b = 58 + blade * 24;
        } else if (type === 'sand') {
          // Realistic raked Augusta quartz bunker sand with micro rake lines & crystalline grain
          const rakeWave = Math.sin((u * 14 + v * 14 + nMacro * 0.35) * Math.PI * 2) * 0.5 + 0.5;
          const grain = nMicro * 0.55 + nMid * 0.30 + rakeWave * 0.15;
          r = 208 + grain * 42;
          g = 188 + grain * 40;
          b = 140 + grain * 36;
        } else {
          // Deep organic pond bed silt & aquatic stone
          const silt = nMacro * 0.45 + nMid * 0.35 + nMicro * 0.20;
          r = 14 + silt * 22;
          g = 38 + silt * 32;
          b = 46 + silt * 36;
        }

        data[idx] = Math.max(0, Math.min(255, Math.round(r)));
        data[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
        data[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    // Add crisp seamless overlapping grass blades for turf types
    // Putting greens feature heavily reduced micro blade detail for a smooth, velvety, tournament-rolled bentgrass surface
    if (type !== 'sand' && type !== 'water_bed') {
      const bladeCount = type === 'rough' ? 1800 : type === 'green' ? 120 : 2000;
      const bladeLen = type === 'rough' ? 7 : type === 'first_cut' ? 5 : type === 'green' ? 1.2 : 4;
      ctx.lineWidth = type === 'green' ? 0.5 : 1.1;

      for (let i = 0; i < bladeCount; i++) {
        const bx = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * size;
        const by = ((Math.sin(i * 78.233) * 43758.5453) % 1 + 1) % 1 * size;
        const angle = ((Math.sin(i * 45.164) * 43758.5453) % 1) * Math.PI * 2;
        const dx = Math.cos(angle) * bladeLen;
        const dy = Math.sin(angle) * bladeLen;

        const isLight = i % 2 === 0;
        if (type === 'rough') {
          ctx.strokeStyle = isLight ? 'rgba(195, 168, 105, 0.22)' : 'rgba(46, 36, 18, 0.20)'; // warm fescue & brown thatch blades
        } else if (type === 'green') {
          // Ultra-fine, subtle, velvety bentgrass mowing grain with minimal blade noise
          ctx.strokeStyle = isLight ? 'rgba(185, 235, 110, 0.05)' : 'rgba(20, 50, 15, 0.04)';
        } else {
          ctx.strokeStyle = isLight ? 'rgba(185, 235, 110, 0.16)' : 'rgba(15, 42, 12, 0.16)';
        }

        // Draw wrapped across all 9 toroidal offsets if near edge to guarantee 100% seamless tiling
        for (let ox = -size; ox <= size; ox += size) {
          for (let oy = -size; oy <= size; oy += size) {
            const sx = bx + ox;
            const sy = by + oy;
            if (sx >= -bladeLen && sx <= size + bladeLen && sy >= -bladeLen && sy <= size + bladeLen) {
              ctx.beginPath();
              ctx.moveTo(sx, sy);
              ctx.lineTo(sx + dx, sy + dy);
              ctx.stroke();
            }
          }
        }
      }
    }

    return canvas;
  }

  /**
   * Generates a 512x512 high-frequency seamless micro-detail texture (grass blades & crystalline grains)
   * Tiled at 110x230 across the terrain via ambientTexture so every 2m x 2m patch has 512x512 resolution (4mm/pixel)!
   */
  public static createSeamlessMicroDetailTexture(scene: Scene): DynamicTexture {
    const size = 512;
    const tex = new DynamicTexture('seamlessMicroDetail', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;

    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const n1 = this.seamlessFBM(u, v, 16, 2, 13.7);
        const n2 = this.seamlessFBM(u, v, 64, 2, 29.3);
        // Subtle organic variation around 0.88..1.0
        const val = Math.round((0.84 + n1 * 0.08 + n2 * 0.08) * 255);
        const idx = (y * size + x) * 4;
        data[idx] = val;
        data[idx + 1] = val;
        data[idx + 2] = val;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);

    // Draw 9,000 crisp micro grass blades / sand speckles wrapped toroidally for 100% seamless tiling
    ctx.lineWidth = 1.0;
    for (let i = 0; i < 9000; i++) {
      const bx = (((Math.sin(i * 12.9898) * 43758.5453) % 1) + 1) % 1 * size;
      const by = (((Math.sin(i * 78.233) * 43758.5453) % 1) + 1) % 1 * size;
      const angle = ((Math.sin(i * 45.164) * 43758.5453) % 1) * Math.PI * 2;
      const bladeLen = 2.5 + (i % 3) * 1.2;
      const dx = Math.cos(angle) * bladeLen;
      const dy = Math.sin(angle) * bladeLen;

      ctx.strokeStyle = i % 2 === 0 ? 'rgba(255, 255, 255, 0.22)' : 'rgba(30, 35, 25, 0.20)';

      for (let ox = -size; ox <= size; ox += size) {
        for (let oy = -size; oy <= size; oy += size) {
          const sx = bx + ox;
          const sy = by + oy;
          if (sx >= -5 && sx <= size + 5 && sy >= -5 && sy <= size + 5) {
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + dx, sy + dy);
            ctx.stroke();
          }
        }
      }
    }

    tex.update(true);
    return tex;
  }

  /**
   * Generates a 512x512 seamless 3D normal map for high-frequency turf blades & sand grains.
   * Tiled at high UV scale across the terrain so close-up views have razor-sharp 3D surface detail.
   */
  public static createSeamlessTurfNormalTexture(scene: Scene): DynamicTexture {
    const size = 256;
    const tex = new DynamicTexture('seamlessTurfNormal', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;

    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    // Precompute heightfield for finite-difference normal derivation
    const hMap = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const h =
          this.seamlessFBM(u, v, 16, 2, 10.4) * 0.35 +
          this.seamlessFBM(u, v, 48, 2, 22.8) * 0.65;
        hMap[y * size + x] = h;
      }
    }

    const strength = 3.2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const xL = this.wrapCoord(x - 1, size);
        const xR = this.wrapCoord(x + 1, size);
        const yD = this.wrapCoord(y - 1, size);
        const yU = this.wrapCoord(y + 1, size);

        const dX = (hMap[y * size + xL] - hMap[y * size + xR]) * strength;
        const dY = (hMap[yD * size + x] - hMap[yU * size + x]) * strength;
        const dZ = 1.0;
        const len = Math.sqrt(dX * dX + dY * dY + dZ * dZ) || 1;

        const nx = (dX / len) * 0.5 + 0.5;
        const ny = (dY / len) * 0.5 + 0.5;
        const nz = (dZ / len) * 0.5 + 0.5;

        const idx = (y * size + x) * 4;
        data[idx] = Math.round(nx * 255);
        data[idx + 1] = Math.round(ny * 255);
        data[idx + 2] = Math.round(nz * 255);
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    tex.update(true);
    this.attachPreviewDataUrl(tex);
    return tex;
  }

  /**
   * Attaches a compact preview data URL onto DynamicTexture instances so Developer Zone cards
   * always display the true procedural/generated texture instead of a generic placeholder.
   */
  public static attachPreviewDataUrl(tex: DynamicTexture): DynamicTexture {
    try {
      const src = tex.getContext()?.canvas;
      if (src) {
        const thumb = document.createElement('canvas');
        thumb.width = 96;
        thumb.height = 96;
        const tCtx = thumb.getContext('2d');
        if (tCtx) {
          tCtx.drawImage(src as unknown as CanvasImageSource, 0, 0, 96, 96);
          (tex as any)._previewDataUrl = thumb.toDataURL('image/png');
        }
      }
    } catch {
      // ignore if headless offscreen fails
    }
    return tex;
  }

  /**
   * Generates seamless 256x256 Sand Normal & Roughness maps so bunker sand never falls back to grass relief.
   */
  public static createSeamlessSandTextures(scene: Scene): { normal: DynamicTexture; roughness: DynamicTexture } {
    const size = 256;
    const normal = new DynamicTexture('seamlessSandNormal', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    const roughness = new DynamicTexture('seamlessSandRoughness', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    normal.wrapU = normal.wrapV = Texture.WRAP_ADDRESSMODE;
    roughness.wrapU = roughness.wrapV = Texture.WRAP_ADDRESSMODE;
    normal.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;
    roughness.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;

    const nCtx = normal.getContext() as CanvasRenderingContext2D;
    const rCtx = roughness.getContext() as CanvasRenderingContext2D;
    const nImg = nCtx.createImageData(size, size);
    const rImg = rCtx.createImageData(size, size);
    const hMap = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        // Soft natural wind-blown ripples + balanced sand grain (avoids harsh dark striping on steep walls)
        const ripple =
          Math.sin(u * Math.PI * 6 + this.seamlessFBM(u, v, 6, 2, 11.4) * 2.2) * 0.08 +
          Math.cos(v * Math.PI * 4 + this.seamlessFBM(u, v, 5, 2, 27.1) * 1.6) * 0.04;
        const grain = this.seamlessFBM(u, v, 36, 2, 31.9) * 0.34 + this.seamlessFBM(u, v, 72, 2, 71.3) * 0.22;
        const h = Math.max(0, Math.min(1, 0.5 + ripple + (grain - 0.28) * 0.55));
        hMap[y * size + x] = h;

        const idx = (y * size + x) * 4;
        // True PBR roughness: dry matte sand (~225-248), tiny quartz crystal micro-glints (~135-170)
        const spec = grain > 0.50 ? Math.round(135 + (1.0 - grain) * 120) : Math.round(218 + h * 34);
        rImg.data[idx] = spec;
        rImg.data[idx + 1] = spec;
        rImg.data[idx + 2] = spec;
        rImg.data[idx + 3] = 255;
      }
    }

    const strength = 1.15;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const xL = this.wrapCoord(x - 1, size);
        const xR = this.wrapCoord(x + 1, size);
        const yD = this.wrapCoord(y - 1, size);
        const yU = this.wrapCoord(y + 1, size);
        const dX = (hMap[y * size + xL] - hMap[y * size + xR]) * strength;
        const dY = (hMap[yD * size + x] - hMap[yU * size + x]) * strength;
        const len = Math.sqrt(dX * dX + dY * dY + 1) || 1;
        const idx = (y * size + x) * 4;
        nImg.data[idx] = Math.round(((dX / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 1] = Math.round(((dY / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 3] = 255;
      }
    }

    nCtx.putImageData(nImg, 0, 0);
    rCtx.putImageData(rImg, 0, 0);
    normal.update(true);
    roughness.update(true);
    this.attachPreviewDataUrl(normal);
    this.attachPreviewDataUrl(roughness);
    return { normal, roughness };
  }

  /**
   * Generates a seamless 256x256 animated water wave 3D normal map
   */
  public static createSeamlessWaterNormalTexture(scene: Scene): DynamicTexture {
    const size = 256;
    const tex = new DynamicTexture('seamlessWaterNormal', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = 8;

    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    const hMap = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        // Pure organic multi-scale FBM wind ripples (zero regular diagonal sine grid lines)
        const swell = this.seamlessFBM(u, v, 6, 3, 19.4) * 0.42;
        const breeze = this.seamlessFBM(u + 0.37, v + 0.61, 14, 3, 41.2) * 0.36;
        const micro = this.seamlessFBM(u + 0.73, v + 0.19, 28, 2, 63.8) * 0.22;
        hMap[y * size + x] = swell + breeze + micro;
      }
    }

    const strength = 2.1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const xL = this.wrapCoord(x - 1, size);
        const xR = this.wrapCoord(x + 1, size);
        const yD = this.wrapCoord(y - 1, size);
        const yU = this.wrapCoord(y + 1, size);

        const dX = (hMap[y * size + xL] - hMap[y * size + xR]) * strength;
        const dY = (hMap[yD * size + x] - hMap[yU * size + x]) * strength;
        const dZ = 1.0;
        const len = Math.sqrt(dX * dX + dY * dY + dZ * dZ) || 1;

        const idx = (y * size + x) * 4;
        data[idx] = Math.round(((dX / len) * 0.5 + 0.5) * 255);
        data[idx + 1] = Math.round(((dY / len) * 0.5 + 0.5) * 255);
        data[idx + 2] = Math.round(((dZ / len) * 0.5 + 0.5) * 255);
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    tex.update(true);
    this.attachPreviewDataUrl(tex);
    return tex;
  }

  /**
   * Generates a seamless 256x256 water surface diffuse texture with subtle light caustics
   */
  public static createSeamlessWaterDiffuseTexture(scene: Scene): DynamicTexture {
    const size = 256;
    const tex = new DynamicTexture('seamlessWaterDiffuse', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;

    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const n1 = this.seamlessFBM(u, v, 8, 3, 77.1);
        const n2 = this.seamlessFBM(u + 0.3, v + 0.2, 16, 2, 88.4);
        const caustic = Math.pow(Math.max(0, 1.0 - Math.abs(n1 - n2) * 3.2), 2) * 0.25;

        const idx = (y * size + x) * 4;
        data[idx] = Math.min(255, Math.round((0.10 + n1 * 0.06 + caustic) * 255));
        data[idx + 1] = Math.min(255, Math.round((0.36 + n1 * 0.12 + caustic) * 255));
        data[idx + 2] = Math.min(255, Math.round((0.52 + n1 * 0.14 + caustic) * 255));
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    tex.update(true);
    this.attachPreviewDataUrl(tex);
    return tex;
  }

  /**
   * Generates a seamless 256x256 water wave roughness/specular map
   */
  public static createSeamlessWaterRoughnessTexture(scene: Scene): DynamicTexture {
    const size = 256;
    const tex = new DynamicTexture('seamlessWaterRoughness', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = 8;

    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const n1 = this.seamlessFBM(u, v, 8, 3, 21.3);
        const n2 = this.seamlessFBM(u + 0.4, v + 0.3, 20, 2, 57.6);
        // True PBR roughness: glossy smooth water ripples (~12-65, lower = smoother)
        const sheen = Math.min(80, Math.max(12, Math.round(38 + (n1 - n2) * 45)));
        const idx = (y * size + x) * 4;
        data[idx] = sheen;
        data[idx + 1] = sheen;
        data[idx + 2] = sheen;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    tex.update(true);
    this.attachPreviewDataUrl(tex);
    return tex;
  }

  /**
   * Seamless Tree Bark Texture & Normal Map
   */
  public static createSeamlessBarkTextures(scene: Scene): { diffuse: DynamicTexture; normal: DynamicTexture } {
    const size = 128;
    const diffuse = new DynamicTexture('barkDiffuse', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    const normal = new DynamicTexture('barkNormal', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    diffuse.wrapU = diffuse.wrapV = Texture.WRAP_ADDRESSMODE;
    normal.wrapU = normal.wrapV = Texture.WRAP_ADDRESSMODE;

    const dCtx = diffuse.getContext() as CanvasRenderingContext2D;
    const nCtx = normal.getContext() as CanvasRenderingContext2D;
    const dImg = dCtx.createImageData(size, size);
    const nImg = nCtx.createImageData(size, size);
    const hMap = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        // Vertical bark ridges
        const ridge = this.seamlessFBM(u, v * 0.25, 16, 3, 31.4);
        const fine = this.seamlessFBM(u, v, 32, 2, 14.9);
        const h = ridge * 0.75 + fine * 0.25;
        hMap[y * size + x] = h;

        const idx = (y * size + x) * 4;
        dImg.data[idx] = Math.round(58 + h * 52);
        dImg.data[idx + 1] = Math.round(40 + h * 36);
        dImg.data[idx + 2] = Math.round(26 + h * 24);
        dImg.data[idx + 3] = 255;
      }
    }

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const xL = this.wrapCoord(x - 1, size);
        const xR = this.wrapCoord(x + 1, size);
        const yD = this.wrapCoord(y - 1, size);
        const yU = this.wrapCoord(y + 1, size);
        const dX = (hMap[y * size + xL] - hMap[y * size + xR]) * 3.5;
        const dY = (hMap[yD * size + x] - hMap[yU * size + x]) * 2.0;
        const len = Math.sqrt(dX * dX + dY * dY + 1) || 1;
        const idx = (y * size + x) * 4;
        nImg.data[idx] = Math.round(((dX / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 1] = Math.round(((dY / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 3] = 255;
      }
    }

    dCtx.putImageData(dImg, 0, 0);
    nCtx.putImageData(nImg, 0, 0);
    diffuse.update(true);
    normal.update(true);
    return { diffuse, normal };
  }

  /**
   * Seamless Foliage Texture & Normal Map for Pine Needles and Oak Canopies
   */
  public static createSeamlessFoliageTextures(
    scene: Scene,
    variant: 'pine' | 'oak'
  ): { diffuse: DynamicTexture; normal: DynamicTexture } {
    const size = 128;
    const diffuse = new DynamicTexture(`${variant}FoliageDiffuse`, size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    const normal = new DynamicTexture(`${variant}FoliageNormal`, size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    diffuse.wrapU = diffuse.wrapV = Texture.WRAP_ADDRESSMODE;
    normal.wrapU = normal.wrapV = Texture.WRAP_ADDRESSMODE;

    const dCtx = diffuse.getContext() as CanvasRenderingContext2D;
    const nCtx = normal.getContext() as CanvasRenderingContext2D;
    const dImg = dCtx.createImageData(size, size);
    const nImg = nCtx.createImageData(size, size);
    const hMap = new Float32Array(size * size);

    const seed = variant === 'pine' ? 51.2 : 93.7;
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const cluster = this.seamlessFBM(u, v, 12, 3, seed);
        const leaf = this.seamlessFBM(u, v, 36, 2, seed + 7.1);
        const h = cluster * 0.55 + leaf * 0.45;
        hMap[y * size + x] = h;

        const idx = (y * size + x) * 4;
        if (variant === 'pine') {
          // Deep Augusta pine green needles
          dImg.data[idx] = Math.round(18 + h * 36);
          dImg.data[idx + 1] = Math.round(52 + h * 58);
          dImg.data[idx + 2] = Math.round(24 + h * 30);
        } else {
          // Rich sunlit deciduous oak canopy leaves
          dImg.data[idx] = Math.round(32 + h * 54);
          dImg.data[idx + 1] = Math.round(78 + h * 72);
          dImg.data[idx + 2] = Math.round(24 + h * 34);
        }
        dImg.data[idx + 3] = 255;
      }
    }

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const xL = this.wrapCoord(x - 1, size);
        const xR = this.wrapCoord(x + 1, size);
        const yD = this.wrapCoord(y - 1, size);
        const yU = this.wrapCoord(y + 1, size);
        const dX = (hMap[y * size + xL] - hMap[y * size + xR]) * 3.8;
        const dY = (hMap[yD * size + x] - hMap[yU * size + x]) * 3.8;
        const len = Math.sqrt(dX * dX + dY * dY + 1) || 1;
        const idx = (y * size + x) * 4;
        nImg.data[idx] = Math.round(((dX / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 1] = Math.round(((dY / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 3] = 255;
      }
    }

    dCtx.putImageData(dImg, 0, 0);
    nCtx.putImageData(nImg, 0, 0);
    diffuse.update(true);
    normal.update(true);
    return { diffuse, normal };
  }

  /**
   * Seamless Granite Rock Color, Roughness & Normal Maps
   */
  public static createSeamlessRockTextures(scene: Scene): {
    diffuse: DynamicTexture;
    normal: DynamicTexture;
    roughness: DynamicTexture;
  } {
    const size = 128;
    const diffuse = new DynamicTexture('rockDiffuse', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    const normal = new DynamicTexture('rockNormal', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    const roughness = new DynamicTexture('rockRoughness', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    diffuse.wrapU = diffuse.wrapV = Texture.WRAP_ADDRESSMODE;
    normal.wrapU = normal.wrapV = Texture.WRAP_ADDRESSMODE;
    roughness.wrapU = roughness.wrapV = Texture.WRAP_ADDRESSMODE;

    const dCtx = diffuse.getContext() as CanvasRenderingContext2D;
    const nCtx = normal.getContext() as CanvasRenderingContext2D;
    const rCtx = roughness.getContext() as CanvasRenderingContext2D;
    const dImg = dCtx.createImageData(size, size);
    const nImg = nCtx.createImageData(size, size);
    const rImg = rCtx.createImageData(size, size);
    const hMap = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const crag = this.seamlessFBM(u, v, 8, 3, 64.2);
        const grain = this.seamlessFBM(u, v, 32, 2, 19.8);
        const h = crag * 0.7 + grain * 0.3;
        hMap[y * size + x] = h;

        const idx = (y * size + x) * 4;
        const base = 92 + h * 78;
        dImg.data[idx] = Math.round(base * 0.98);
        dImg.data[idx + 1] = Math.round(base * 0.99);
        dImg.data[idx + 2] = Math.round(base * 1.02);
        dImg.data[idx + 3] = 255;

        // True PBR roughness: matte rock crevices (~225), smoother mica ridges (~135)
        const spec = Math.max(125, Math.min(248, Math.round(230 - h * 95)));
        rImg.data[idx] = spec;
        rImg.data[idx + 1] = spec;
        rImg.data[idx + 2] = spec;
        rImg.data[idx + 3] = 255;
      }
    }

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const xL = this.wrapCoord(x - 1, size);
        const xR = this.wrapCoord(x + 1, size);
        const yD = this.wrapCoord(y - 1, size);
        const yU = this.wrapCoord(y + 1, size);
        const dX = (hMap[y * size + xL] - hMap[y * size + xR]) * 4.2;
        const dY = (hMap[yD * size + x] - hMap[yU * size + x]) * 4.2;
        const len = Math.sqrt(dX * dX + dY * dY + 1) || 1;
        const idx = (y * size + x) * 4;
        nImg.data[idx] = Math.round(((dX / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 1] = Math.round(((dY / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 3] = 255;
      }
    }

    dCtx.putImageData(dImg, 0, 0);
    nCtx.putImageData(nImg, 0, 0);
    rCtx.putImageData(rImg, 0, 0);
    diffuse.update(true);
    normal.update(true);
    roughness.update(true);
    this.attachPreviewDataUrl(diffuse);
    this.attachPreviewDataUrl(normal);
    this.attachPreviewDataUrl(roughness);
    return { diffuse, normal, roughness };
  }

  /**
   * Generates a 128x128 Golf Ball Dimple Normal Map for realistic close-up ball rendering
   */
  public static createGolfBallDimpleNormalTexture(scene: Scene): DynamicTexture {
    const size = 128;
    const normal = new DynamicTexture('golfBallDimpleNormal', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    normal.wrapU = normal.wrapV = Texture.WRAP_ADDRESSMODE;

    const ctx = normal.getContext() as CanvasRenderingContext2D;
    const img = ctx.createImageData(size, size);
    const cols = 16;
    const rows = 8;

    for (let y = 0; y < size; y++) {
      const v = (y / size) * rows;
      const row = Math.floor(v);
      const fy = (v - row) * 2 - 1;

      for (let x = 0; x < size; x++) {
        const u = (x / size) * cols + (row % 2) * 0.5;
        const col = Math.floor(u);
        const fx = (u - col) * 2 - 1;

        const r2 = fx * fx + fy * fy;
        let nx = 0, ny = 0, nz = 1;
        if (r2 < 0.58) {
          // Concave spherical dimple
          nx = -fx * 0.65;
          ny = -fy * 0.65;
          nz = Math.sqrt(Math.max(0.2, 1.0 - nx * nx - ny * ny));
        }

        const idx = (y * size + x) * 4;
        img.data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
        img.data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        img.data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        img.data[idx + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);
    normal.update(true);
    this.attachPreviewDataUrl(normal);
    return normal;
  }

  /**
   * Generates a 128x128 Golf Ball Roughness Map (slightly smoother land bridges, softer matte dimple bowls)
   */
  public static createGolfBallRoughnessTexture(scene: Scene): DynamicTexture {
    const size = 128;
    const rough = new DynamicTexture('golfBallDimpleRough', size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    rough.wrapU = rough.wrapV = Texture.WRAP_ADDRESSMODE;
    const ctx = rough.getContext() as CanvasRenderingContext2D;
    const img = ctx.createImageData(size, size);
    const cols = 16;
    const rows = 8;

    for (let y = 0; y < size; y++) {
      const v = (y / size) * rows;
      const row = Math.floor(v);
      const fy = (v - row) * 2 - 1;
      for (let x = 0; x < size; x++) {
        const u = (x / size) * cols + (row % 2) * 0.5;
        const col = Math.floor(u);
        const fx = (u - col) * 2 - 1;
        const r2 = fx * fx + fy * fy;
        const val = r2 < 0.58 ? 148 : 72;
        const idx = (y * size + x) * 4;
        img.data[idx] = val;
        img.data[idx + 1] = val;
        img.data[idx + 2] = val;
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    rough.update(true);
    this.attachPreviewDataUrl(rough);
    return rough;
  }

  /**
   * Generates seamless Color, Roughness & Normal textures for woven cloth/flag materials
   */
  public static createFabricTextures(
    scene: Scene,
    name: string,
    rgb: [number, number, number] = [235, 235, 235]
  ): { diffuse: DynamicTexture; roughness: DynamicTexture; normal: DynamicTexture } {
    const size = 128;
    const diffuse = new DynamicTexture(`${name}_diff`, size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    const roughness = new DynamicTexture(`${name}_rough`, size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    const normal = new DynamicTexture(`${name}_nor`, size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    diffuse.wrapU = diffuse.wrapV = Texture.WRAP_ADDRESSMODE;
    roughness.wrapU = roughness.wrapV = Texture.WRAP_ADDRESSMODE;
    normal.wrapU = normal.wrapV = Texture.WRAP_ADDRESSMODE;

    const dCtx = diffuse.getContext() as CanvasRenderingContext2D;
    const rCtx = roughness.getContext() as CanvasRenderingContext2D;
    const nCtx = normal.getContext() as CanvasRenderingContext2D;
    const dImg = dCtx.createImageData(size, size);
    const rImg = rCtx.createImageData(size, size);
    const nImg = nCtx.createImageData(size, size);
    const hMap = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const warp = Math.sin(x * Math.PI * 0.5) * 0.5 + 0.5;
        const weft = Math.sin(y * Math.PI * 0.5) * 0.5 + 0.5;
        const n = this.seamlessFBM(x / size, y / size, 12, 2, 17.5);
        const h = ((x + y) % 2 === 0 ? warp : weft) * 0.65 + n * 0.35;
        hMap[y * size + x] = h;
        const shade = 0.88 + h * 0.18;
        const idx = (y * size + x) * 4;
        dImg.data[idx] = Math.min(255, Math.round(rgb[0] * shade));
        dImg.data[idx + 1] = Math.min(255, Math.round(rgb[1] * shade));
        dImg.data[idx + 2] = Math.min(255, Math.round(rgb[2] * shade));
        dImg.data[idx + 3] = 255;
        const spec = Math.round(175 + (1 - h) * 58);
        rImg.data[idx] = spec;
        rImg.data[idx + 1] = spec;
        rImg.data[idx + 2] = spec;
        rImg.data[idx + 3] = 255;
      }
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dX = (hMap[y * size + this.wrapCoord(x - 1, size)] - hMap[y * size + this.wrapCoord(x + 1, size)]) * 2.4;
        const dY = (hMap[this.wrapCoord(y - 1, size) * size + x] - hMap[this.wrapCoord(y + 1, size) * size + x]) * 2.4;
        const len = Math.sqrt(dX * dX + dY * dY + 1) || 1;
        const idx = (y * size + x) * 4;
        nImg.data[idx] = Math.round(((dX / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 1] = Math.round(((dY / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 3] = 255;
      }
    }
    dCtx.putImageData(dImg, 0, 0);
    rCtx.putImageData(rImg, 0, 0);
    nCtx.putImageData(nImg, 0, 0);
    diffuse.update(true);
    roughness.update(true);
    normal.update(true);
    this.attachPreviewDataUrl(diffuse);
    this.attachPreviewDataUrl(roughness);
    this.attachPreviewDataUrl(normal);
    return { diffuse, roughness, normal };
  }

  /**
   * Generates seamless brushed metallic/fiberglass Color, Roughness & Normal textures (poles, cups, gold trim)
   */
  public static createBrushedMetalTextures(
    scene: Scene,
    name: string,
    rgb: [number, number, number] = [240, 240, 245]
  ): { diffuse: DynamicTexture; roughness: DynamicTexture; normal: DynamicTexture } {
    const size = 128;
    const diffuse = new DynamicTexture(`${name}_diff`, size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    const roughness = new DynamicTexture(`${name}_rough`, size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    const normal = new DynamicTexture(`${name}_nor`, size, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    diffuse.wrapU = diffuse.wrapV = Texture.WRAP_ADDRESSMODE;
    roughness.wrapU = roughness.wrapV = Texture.WRAP_ADDRESSMODE;
    normal.wrapU = normal.wrapV = Texture.WRAP_ADDRESSMODE;

    const dCtx = diffuse.getContext() as CanvasRenderingContext2D;
    const rCtx = roughness.getContext() as CanvasRenderingContext2D;
    const nCtx = normal.getContext() as CanvasRenderingContext2D;
    const dImg = dCtx.createImageData(size, size);
    const rImg = rCtx.createImageData(size, size);
    const nImg = nCtx.createImageData(size, size);
    const hMap = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
      const v = y / size;
      const streak = this.seamlessNoise(0.2, v * 32, 32, 41.2);
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const fine = this.seamlessFBM(u, v, 16, 2, 7.4);
        const h = streak * 0.72 + fine * 0.28;
        hMap[y * size + x] = h;
        const shade = 0.88 + h * 0.16;
        const idx = (y * size + x) * 4;
        dImg.data[idx] = Math.min(255, Math.round(rgb[0] * shade));
        dImg.data[idx + 1] = Math.min(255, Math.round(rgb[1] * shade));
        dImg.data[idx + 2] = Math.min(255, Math.round(rgb[2] * shade));
        dImg.data[idx + 3] = 255;
        const spec = Math.max(36, Math.min(138, Math.round(115 - h * 68)));
        rImg.data[idx] = spec;
        rImg.data[idx + 1] = spec;
        rImg.data[idx + 2] = spec;
        rImg.data[idx + 3] = 255;
      }
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dX = (hMap[y * size + this.wrapCoord(x - 1, size)] - hMap[y * size + this.wrapCoord(x + 1, size)]) * 1.4;
        const dY = (hMap[this.wrapCoord(y - 1, size) * size + x] - hMap[this.wrapCoord(y + 1, size) * size + x]) * 1.4;
        const len = Math.sqrt(dX * dX + dY * dY + 1) || 1;
        const idx = (y * size + x) * 4;
        nImg.data[idx] = Math.round(((dX / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 1] = Math.round(((dY / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 3] = 255;
      }
    }
    dCtx.putImageData(dImg, 0, 0);
    rCtx.putImageData(rImg, 0, 0);
    nCtx.putImageData(nImg, 0, 0);
    diffuse.update(true);
    roughness.update(true);
    normal.update(true);
    this.attachPreviewDataUrl(diffuse);
    this.attachPreviewDataUrl(roughness);
    this.attachPreviewDataUrl(normal);
    return { diffuse, roughness, normal };
  }

  /**
   * Generates seamless Roughness + Tangent-Space Normal maps from any GLB color texture Blob
   * (used for GLBs like hero_tree_01_01.glb that only ship baseColor maps).
   */
  public static async createNormalAndRoughnessFromBlob(
    scene: Scene,
    prefix: string,
    blob: Blob,
    normalStrength = 2.6,
    glossBase = 0.28
  ): Promise<{ normal: DynamicTexture; roughness: DynamicTexture }> {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
    });
    URL.revokeObjectURL(url);

    const w = Math.min(512, img.naturalWidth || 256);
    const h = Math.min(512, img.naturalHeight || 256);
    const work = document.createElement('canvas');
    work.width = w;
    work.height = h;
    const wCtx = work.getContext('2d')!;
    wCtx.drawImage(img, 0, 0, w, h);
    const src = wCtx.getImageData(0, 0, w, h).data;

    const normal = new DynamicTexture(`${prefix}_genNor`, { width: w, height: h }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    const roughness = new DynamicTexture(`${prefix}_genRough`, { width: w, height: h }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    normal.wrapU = normal.wrapV = Texture.WRAP_ADDRESSMODE;
    roughness.wrapU = roughness.wrapV = Texture.WRAP_ADDRESSMODE;
    normal.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;
    roughness.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;

    const lum = new Float32Array(w * h);
    const rCtx = roughness.getContext() as CanvasRenderingContext2D;
    const rImg = rCtx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      const l = (src[idx] * 0.299 + src[idx + 1] * 0.587 + src[idx + 2] * 0.114) / 255;
      lum[i] = l;
      // True PBR roughness: shadowed bark/leaves matte (~220), sunny highlights slightly smoother
      const spec = Math.max(70, Math.min(242, Math.round((1.0 - l * 0.42 - glossBase * 0.35) * 255)));
      rImg.data[idx] = spec;
      rImg.data[idx + 1] = spec;
      rImg.data[idx + 2] = spec;
      rImg.data[idx + 3] = 255;
    }

    const nCtx = normal.getContext() as CanvasRenderingContext2D;
    const nImg = nCtx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const yU = Math.max(0, y - 1);
      const yD = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const xL = Math.max(0, x - 1);
        const xR = Math.min(w - 1, x + 1);
        const dX = (lum[y * w + xL] - lum[y * w + xR]) * normalStrength;
        const dY = (lum[yU * w + x] - lum[yD * w + x]) * normalStrength;
        const len = Math.sqrt(dX * dX + dY * dY + 1) || 1;
        const idx = (y * w + x) * 4;
        nImg.data[idx] = Math.round(((dX / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 1] = Math.round(((dY / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        nImg.data[idx + 3] = 255;
      }
    }

    rCtx.putImageData(rImg, 0, 0);
    nCtx.putImageData(nImg, 0, 0);
    roughness.update(true);
    normal.update(true);
    this.attachPreviewDataUrl(roughness);
    this.attachPreviewDataUrl(normal);
    return { normal, roughness };
  }

  /**
   * Extracts true PBR roughness (Green channel, 0=smooth/glossy, 255=matte/rough) from any glTF
   * metallicRoughness texture Blob (using invertY=false semantics via update(false)).
   */
  public static async createRoughnessFromMetallicRoughnessBlob(
    scene: Scene,
    name: string,
    blob: Blob
  ): Promise<DynamicTexture> {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
    });
    URL.revokeObjectURL(url);

    const w = Math.min(512, img.naturalWidth || 256);
    const h = Math.min(512, img.naturalHeight || 256);
    const tex = new DynamicTexture(name, { width: w, height: h }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = getDeviceProfile().maxAnisotropy;

    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const rByte = data[i + 1];
      data[i] = rByte;
      data[i + 1] = rByte;
      data[i + 2] = rByte;
      data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    // preserve glTF top-left UV origin without vertical flip
    tex.update(false);
    this.attachPreviewDataUrl(tex);
    return tex;
  }

  public static createSpecularFromMetallicRoughnessBlob(
    scene: Scene,
    name: string,
    blob: Blob
  ): Promise<DynamicTexture> {
    return this.createRoughnessFromMetallicRoughnessBlob(scene, name, blob);
  }

  public static createFlatRoughnessTexture(scene: Scene, name: string, rough01 = 0.65): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 16, height: 16 }, scene, false, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
    const val = Math.max(0, Math.min(255, Math.round(rough01 * 255)));
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = `rgb(${val}, ${val}, ${val})`;
    ctx.fillRect(0, 0, 16, 16);
    tex.update(false);
    this.attachPreviewDataUrl(tex);
    return tex;
  }

  public static createFlatNormalTexture(scene: Scene, name: string): DynamicTexture {
    const tex = new DynamicTexture(name, { width: 16, height: 16 }, scene, false, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = 'rgb(128, 128, 255)';
    ctx.fillRect(0, 0, 16, 16);
    tex.update(false);
    this.attachPreviewDataUrl(tex);
    return tex;
  }

  public static toSafeHex(col: Color3 | null | undefined, fallback = '#ffffff'): string {
    if (!col) return fallback;
    const clamped = new Color3(
      Math.max(0, Math.min(1, col.r)),
      Math.max(0, Math.min(1, col.g)),
      Math.max(0, Math.min(1, col.b))
    );
    return clamped.toHexString();
  }

  public static ensureObjectMaterialPlugin(mat: Material): ObjectMaterialBlendPlugin {
    const anyMat = mat as any;
    let plugin: ObjectMaterialBlendPlugin | undefined = anyMat._objBlendPlugin;
    if (!plugin) {
      if (anyMat._userBaseColor === undefined) {
        if (mat instanceof PBRMaterial && mat.albedoColor) {
          anyMat._userBaseColor = this.toSafeHex(mat.albedoColor, '#ffffff');
        } else if ((mat as any).diffuseColor) {
          anyMat._userBaseColor = this.toSafeHex((mat as any).diffuseColor, '#ffffff');
        } else {
          anyMat._userBaseColor = '#ffffff';
        }
      }
      if (anyMat._userColorTexLevel === undefined) {
        anyMat._userColorTexLevel = 1.0;
      }
      if (anyMat._userRoughnessLevel === undefined) {
        anyMat._userRoughnessLevel = (mat instanceof PBRMaterial && typeof mat.roughness === 'number') ? mat.roughness : 0.65;
      }
      if (anyMat._userMetallicLevel === undefined) {
        anyMat._userMetallicLevel = (mat instanceof PBRMaterial && typeof mat.metallic === 'number') ? mat.metallic : 0.0;
      }
      if (anyMat._enableColorTex === undefined) {
        anyMat._enableColorTex = true;
      }
      if (anyMat._enableRoughTex === undefined) {
        anyMat._enableRoughTex = true;
      }
      if (anyMat._enableNormalTex === undefined) {
        anyMat._enableNormalTex = true;
      }
      if (mat instanceof PBRMaterial) {
        mat.albedoColor = Color3.White();
        mat.metallic = anyMat._userMetallicLevel ?? 0.0;
        mat.roughness = anyMat._userRoughnessLevel ?? 0.65;
        mat.useRoughnessFromMetallicTextureAlpha = false;
        mat.useRoughnessFromMetallicTextureGreen = true;
        mat.useMetallnessFromMetallicTextureBlue = true;
      } else if (mat instanceof StandardMaterial) {
        // Keep diffuseColor pure white so vertex color & shader mix handle BaseColor vs ColorTex cleanly
        mat.diffuseColor = Color3.White();
        // Keep non-black specularColor so Babylon ALWAYS defines SPECULARTERM in shader
        if (!mat.specularColor || (mat.specularColor.r === 0 && mat.specularColor.g === 0 && mat.specularColor.b === 0)) {
          mat.specularColor = new Color3(0.08, 0.08, 0.08);
        }
        if (!mat.specularPower || mat.specularPower <= 0) {
          mat.specularPower = 32;
        }
      }
      plugin = new ObjectMaterialBlendPlugin(mat);
      anyMat._objBlendPlugin = plugin;
    }
    this.syncObjectMaterialPlugin(mat);
    return plugin;
  }

  public static syncObjectMaterialPlugin(mat: Material): void {
    const anyMat = mat as any;
    const plugin: ObjectMaterialBlendPlugin | undefined = anyMat._objBlendPlugin;
    if (!plugin) return;
    plugin.baseColorHex = anyMat._userBaseColor || '#ffffff';
    plugin.colorTexLevel = anyMat._userColorTexLevel ?? 1.0;
    plugin.enableColorTex = anyMat._enableColorTex !== false;
    plugin.roughnessLevel = anyMat._userRoughnessLevel ?? 0.65;
    plugin.metallicLevel = anyMat._userMetallicLevel ?? 0.0;
    plugin.enableRoughTex = anyMat._enableRoughTex !== false;
    plugin.roughnessTex = anyMat._roughnessTexture || anyMat._cachedSpecTex || (mat as any).metallicTexture || (mat as any).specularTexture || null;
    plugin.maxSpecScale = anyMat._maxSpecScale ?? 1.0;
    if (mat instanceof PBRMaterial) {
      mat.metallic = plugin.metallicLevel;
      mat.roughness = plugin.roughnessLevel;
    }
  }

  /**
   * Clears stale PBR texture defines left behind by Babylon's PBRBaseMaterial when
   * `scene.texturesEnabled === false` (Babylon zeroes MAINUV1..6 without clearing ALBEDO/BUMP/etc.).
   */
  public static syncDefinesForSceneTextures(defines: MaterialDefines, scene: Scene | null | undefined): boolean {
    const texOn = Boolean(scene?.texturesEnabled && defines['UV1']);
    if (!scene?.texturesEnabled) {
      defines['ALBEDO'] = false;
      defines['BUMP'] = false;
      defines['AMBIENT'] = false;
      defines['OPACITY'] = false;
      defines['EMISSIVE'] = false;
      defines['REFLECTIVITY'] = false;
      defines['BASE_WEIGHT'] = false;
      defines['BASE_DIFFUSE_ROUGHNESS'] = false;
      defines['METALLIC_REFLECTANCE'] = false;
      defines['REFLECTANCE'] = false;
      defines['MICROSURFACEMAP'] = false;
      defines['BENTNORMAL'] = false;
      defines['LIGHTMAP'] = false;
      defines['ENVIRONMENTBRDF'] = false;
      defines['ALPHAFROMALBEDO'] = false;
    }
    return texOn;
  }
}
