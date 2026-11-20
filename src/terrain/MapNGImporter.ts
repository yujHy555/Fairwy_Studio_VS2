import {
  Scene,
  Mesh,
  VertexData,
  StandardMaterial,
  Texture,
  Color3
} from '@babylonjs/core';
import { MapNGCourseMeta } from '../core/Types';
import { getDeviceProfile } from '../core/DeviceProfile';

export interface Decoded16BitHeightmap {
  width: number;
  height: number;
  bitDepth: number;
  pixels: Uint16Array;
}

export interface LoadedMapNGSource {
  meta: MapNGCourseMeta;
  heightmap: Decoded16BitHeightmap;
  satelliteImg: HTMLImageElement | null;
  satelliteUrl: string | null;
}

export interface MapNGCropOptions {
  cropCenterX: number; // meters from West edge of MapNG source
  cropCenterZ: number; // meters from North edge of MapNG source
  rotationDeg: number; // hole azimuth clockwise from North
  elevationScale: number; // vertical multiplier (default 1.0)
  gridWidth: number; // active hole width in meters (220)
  gridLength: number; // active hole length in meters (460)
}

export interface ExtractedMapNGHole {
  baseHeights: Float32Array;
  minHoleElev: number;
  maxHoleElev: number;
  satelliteDataUrl: string | null;
  macroSatelliteDataUrl: string | null;
  meta: MapNGCourseMeta;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Pure TypeScript 16-bit grayscale / RGB(A) PNG decoder using native DecompressionStream('deflate').
 * Preserves full 16-bit (65,535 levels / ~1.2mm vertical precision) elevation samples with zero 8-bit loss.
 */
export async function decode16BitPng(buffer: ArrayBuffer): Promise<Decoded16BitHeightmap> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 33) {
    throw new Error('Heightmap file is too small to be a valid PNG.');
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) {
      throw new Error('Selected heightmap file is not a valid PNG image.');
    }
  }

  const view = new DataView(buffer);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Uint8Array[] = [];
  let totalIdatLen = 0;

  while (offset + 12 <= bytes.length) {
    const chunkLen = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLen;
    if (dataEnd > bytes.length) break;

    if (type === 'IHDR') {
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      const interlace = bytes[dataStart + 12];
      if (interlace !== 0) {
        throw new Error('Interlaced PNG heightmaps are not supported.');
      }
    } else if (type === 'IDAT') {
      const slice = bytes.subarray(dataStart, dataEnd);
      idatChunks.push(slice);
      totalIdatLen += slice.length;
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // skip 4-byte CRC
  }

  if (!width || !height || totalIdatLen === 0) {
    throw new Error('Missing IHDR or IDAT chunks in MapNG heightmap PNG.');
  }

  const channels =
    colorType === 0 ? 1 :
    colorType === 2 ? 3 :
    colorType === 4 ? 2 :
    colorType === 6 ? 4 : 1;

  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;

  const compressed = new Uint8Array(totalIdatLen);
  let writePos = 0;
  for (const c of idatChunks) {
    compressed.set(c, writePos);
    writePos += c.length;
  }

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Browser does not support DecompressionStream("deflate") for 16-bit PNG decoding.');
  }

  const ds = new DecompressionStream('deflate');
  const decompressedStream = new Blob([compressed]).stream().pipeThrough(ds);
  const rawBuffer = await new Response(decompressedStream).arrayBuffer();
  const raw = new Uint8Array(rawBuffer);

  const rowBytesWithFilter = 1 + stride;
  if (raw.length < height * rowBytesWithFilter) {
    throw new Error(`Unexpected PNG scanline length (${raw.length} < ${height * rowBytesWithFilter}).`);
  }

  const pixels = new Uint16Array(width * height);
  let prevRow = new Uint8Array(stride);
  let curRow = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytesWithFilter;
    const filterType = raw[rowStart];
    const srcOff = rowStart + 1;

    for (let x = 0; x < stride; x++) {
      const xByte = raw[srcOff + x];
      const left = x >= bpp ? curRow[x - bpp] : 0;
      const up = prevRow[x];
      const upLeft = x >= bpp ? prevRow[x - bpp] : 0;

      let recon = xByte;
      if (filterType === 1) {
        recon = (xByte + left) & 0xff;
      } else if (filterType === 2) {
        recon = (xByte + up) & 0xff;
      } else if (filterType === 3) {
        recon = (xByte + ((left + up) >> 1)) & 0xff;
      } else if (filterType === 4) {
        recon = (xByte + paethPredictor(left, up, upLeft)) & 0xff;
      }
      curRow[x] = recon;
    }

    const rowPixOffset = y * width;
    if (bitDepth === 16) {
      for (let x = 0; x < width; x++) {
        const idx = x * bpp;
        pixels[rowPixOffset + x] = (curRow[idx] << 8) | curRow[idx + 1];
      }
    } else {
      for (let x = 0; x < width; x++) {
        pixels[rowPixOffset + x] = curRow[x * bpp] * 257;
      }
    }

    const tmp = prevRow;
    prevRow = curRow;
    curRow = tmp;
  }

  return { width, height, bitDepth, pixels };
}

/**
 * Parses MapNG metadata from `export_report.json`, `mapng.json`, or `export_report.md`.
 */
export function parseMapNGMetadata(files: { name: string; text: string }[]): Partial<MapNGCourseMeta> {
  const result: Partial<MapNGCourseMeta> = {};

  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.json')) {
      try {
        const parsed = JSON.parse(f.text);
        if (parsed.format === 'mapng-export-report' || parsed.terrain) {
          if (parsed.terrain?.width) result.sourceWidthPx = Number(parsed.terrain.width);
          if (parsed.terrain?.height) result.sourceHeightPx = Number(parsed.terrain.height);
          if (parsed.terrain?.mpp) result.metersPerPixel = Number(parsed.terrain.mpp);
          if (typeof parsed.terrain?.minHeight === 'number') result.minHeightMeters = parsed.terrain.minHeight;
          if (typeof parsed.terrain?.maxHeight === 'number') result.maxHeightMeters = parsed.terrain.maxHeight;
        }
        if (parsed.options?.levelName) result.levelName = String(parsed.options.levelName);
        else if (parsed.levelName && !result.levelName) result.levelName = String(parsed.levelName);
        else if (parsed.level && !result.levelName) result.levelName = String(parsed.level);

        if (parsed.resolution && !result.sourceWidthPx) {
          result.sourceWidthPx = Number(parsed.resolution);
          result.sourceHeightPx = Number(parsed.resolution);
        }
        if (parsed.metersPerPixel && !result.metersPerPixel) {
          result.metersPerPixel = Number(parsed.metersPerPixel);
        }
        if (parsed.center) {
          if (typeof parsed.center.lat === 'number') result.centerLat = parsed.center.lat;
          if (typeof parsed.center.lng === 'number') result.centerLon = parsed.center.lng;
        }
      } catch {
        // Ignore malformed JSON files
      }
    } else if (lower.endsWith('.md') || lower.endsWith('.txt')) {
      const nameMatch = f.text.match(/Level display name:\s*(.+)/i);
      if (nameMatch && !result.levelName) result.levelName = nameMatch[1].trim();

      const sizeMatch = f.text.match(/Exported terrain size:\s*(\d+)\s*x\s*(\d+)/i);
      if (sizeMatch && !result.sourceWidthPx) {
        result.sourceWidthPx = Number(sizeMatch[1]);
        result.sourceHeightPx = Number(sizeMatch[2]);
      }

      const scaleMatch = f.text.match(/Scale:\s*([\d.]+)\s*m\/px/i);
      if (scaleMatch && !result.metersPerPixel) {
        result.metersPerPixel = Number(scaleMatch[1]);
      }

      const rangeMatch = f.text.match(/Height range min\/max:\s*([-\d.]+)\s*m\s*\/\s*([-\d.]+)\s*m/i);
      if (rangeMatch && result.minHeightMeters === undefined) {
        result.minHeightMeters = Number(rangeMatch[1]);
        result.maxHeightMeters = Number(rangeMatch[2]);
      }

      const centerMatch = f.text.match(/Center coordinates:\s*([-\d.]+),\s*([-\d.]+)/i);
      if (centerMatch && result.centerLat === undefined) {
        result.centerLat = Number(centerMatch[1]);
        result.centerLon = Number(centerMatch[2]);
      }
    }
  }

  return result;
}

function sampleHeightBilinearMeters(
  hm: Decoded16BitHeightmap,
  minH: number,
  maxH: number,
  mpp: number,
  eastMeters: number,
  southMeters: number
): number {
  const px = Math.max(0, Math.min(hm.width - 1.0001, eastMeters / mpp));
  const py = Math.max(0, Math.min(hm.height - 1.0001, southMeters / mpp));
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(hm.width - 1, x0 + 1);
  const y1 = Math.min(hm.height - 1, y0 + 1);
  const fx = px - x0;
  const fy = py - y0;

  const h00 = hm.pixels[y0 * hm.width + x0];
  const h10 = hm.pixels[y0 * hm.width + x1];
  const h01 = hm.pixels[y1 * hm.width + x0];
  const h11 = hm.pixels[y1 * hm.width + x1];

  const u16 =
    (1 - fx) * (1 - fy) * h00 +
    fx * (1 - fy) * h10 +
    (1 - fx) * fy * h01 +
    fx * fy * h11;

  return minH + (u16 / 65535.0) * (maxH - minH);
}

/**
 * Extracts a rotated 220m x 460m active golf hole DEM heightfield + co-registered satellite textures
 * directly from a 2048m x 2048m MapNG course export.
 */
export function extractHoleCrop(
  source: LoadedMapNGSource,
  options: MapNGCropOptions
): ExtractedMapNGHole {
  const { meta, heightmap, satelliteImg } = source;
  const mpp = meta.metersPerPixel || 1.0;
  const minH = meta.minHeightMeters;
  const maxH = meta.maxHeightMeters;
  const rotRad = (options.rotationDeg * Math.PI) / 180.0;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const scaleElev = options.elevationScale || 1.0;

  const cols = options.gridWidth + 1;
  const rows = options.gridLength + 1;
  const rawMeters = new Float32Array(cols * rows);
  let minHoleElev = Infinity;
  let maxHoleElev = -Infinity;

  const halfW = options.gridWidth * 0.5;
  const halfL = options.gridLength * 0.5;

  for (let z = 0; z < rows; z++) {
    const dz = z - halfL;
    for (let x = 0; x < cols; x++) {
      const dx = x - halfW;
      const eastM = options.cropCenterX + dx * cosR + dz * sinR;
      const northDelta = -dx * sinR + dz * cosR;
      const southM = options.cropCenterZ - northDelta;
      const elev = sampleHeightBilinearMeters(heightmap, minH, maxH, mpp, eastM, southM);
      rawMeters[z * cols + x] = elev;
      if (elev < minHoleElev) minHoleElev = elev;
      if (elev > maxHoleElev) maxHoleElev = elev;
    }
  }

  const baseHeights = new Float32Array(cols * rows);
  for (let i = 0; i < rawMeters.length; i++) {
    baseHeights[i] = 0.5 + (rawMeters[i] - minHoleElev) * scaleElev;
  }

  let satelliteDataUrl: string | null = null;
  let macroSatelliteDataUrl: string | null = null;

  if (satelliteImg && satelliteImg.width > 0 && satelliteImg.height > 0) {
    const profile = getDeviceProfile();
    const targetH = Math.min(2048, profile.maxSatelliteTextureSize);
    const targetW = Math.max(256, Math.round(targetH * (options.gridWidth / options.gridLength)));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const imgScaleX = satelliteImg.width / heightmap.width;
      const imgScaleY = satelliteImg.height / heightmap.height;
      const pxCenter = (options.cropCenterX / mpp) * imgScaleX;
      const pyCenter = (options.cropCenterZ / mpp) * imgScaleY;
      const holePixW = (options.gridWidth / mpp) * imgScaleX;
      const holePixH = (options.gridLength / mpp) * imgScaleY;

      ctx.save();
      ctx.translate(targetW * 0.5, targetH * 0.5);
      ctx.scale(targetW / holePixW, targetH / holePixH);
      ctx.rotate(-rotRad);
      ctx.drawImage(satelliteImg, -pxCenter, -pyCenter);
      ctx.restore();
      satelliteDataUrl = canvas.toDataURL('image/jpeg', 0.88);
    }

    const macroCanvas = document.createElement('canvas');
    const macroDim = Math.min(1024, profile.maxSatelliteTextureSize);
    macroCanvas.width = macroDim;
    macroCanvas.height = macroDim;
    const mCtx = macroCanvas.getContext('2d');
    if (mCtx) {
      mCtx.drawImage(satelliteImg, 0, 0, macroDim, macroDim);
      macroSatelliteDataUrl = macroCanvas.toDataURL('image/jpeg', 0.82);
    }
  }

  return {
    baseHeights,
    minHoleElev,
    maxHoleElev,
    satelliteDataUrl,
    macroSatelliteDataUrl,
    meta: {
      ...meta,
      cropOriginX: options.cropCenterX,
      cropOriginZ: options.cropCenterZ,
      cropRotationRad: rotRad
    }
  };
}

/**
 * Approach B: Builds a coarse 128x128 (2048m x 2048m) macro surround terrain mesh around the active hole
 * so imported MapNG hills and distant context continue seamlessly to the horizon without high vertex cost.
 */
export function buildMacroSurroundMesh(
  scene: Scene,
  source: LoadedMapNGSource,
  options: MapNGCropOptions,
  minHoleElev: number,
  macroSatelliteDataUrl: string | null
): Mesh {
  const existing = scene.getMeshByName('MapNGMacroSurround');
  if (existing) existing.dispose();

  const segs = 128;
  const cols = segs + 1;
  const rows = segs + 1;
  const mpp = source.meta.metersPerPixel || 1.0;
  const spanW = source.heightmap.width * mpp;
  const spanL = source.heightmap.height * mpp;

  const halfW = options.gridWidth * 0.5;
  const halfL = options.gridLength * 0.5;
  const rotRad = (options.rotationDeg * Math.PI) / 180.0;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const scaleElev = options.elevationScale || 1.0;

  const minDx = -spanW * 0.5;
  const minDz = -spanL * 0.5;

  const positions = new Float32Array(cols * rows * 3);
  const normals = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);

  for (let r = 0; r < rows; r++) {
    const vFrac = r / segs;
    const dz = minDz + vFrac * spanL;
    const wz = halfL + dz;

    for (let c = 0; c < cols; c++) {
      const uFrac = c / segs;
      const dx = minDx + uFrac * spanW;
      const wx = halfW + dx;

      const eastM = options.cropCenterX + dx * cosR + dz * sinR;
      const northDelta = -dx * sinR + dz * cosR;
      const southM = options.cropCenterZ - northDelta;

      let wy =
        0.5 +
        (sampleHeightBilinearMeters(
          source.heightmap,
          source.meta.minHeightMeters,
          source.meta.maxHeightMeters,
          mpp,
          eastM,
          southM
        ) -
          minHoleElev) *
          scaleElev;

      // Depress strictly inside active-hole footprint so Approach B never z-fights high-res GolfTerrain
      if (wx > 2 && wx < options.gridWidth - 2 && wz > 2 && wz < options.gridLength - 2) {
        wy -= 3.2;
      }

      const idx = r * cols + c;
      positions[idx * 3] = wx;
      positions[idx * 3 + 1] = wy;
      positions[idx * 3 + 2] = wz;

      // UVs map rotated world coords into north-up source image [0..1]
      uvs[idx * 2] = eastM / spanW;
      uvs[idx * 2 + 1] = 1.0 - southM / spanL;

      normals[idx * 3] = 0;
      normals[idx * 3 + 1] = 1;
      normals[idx * 3 + 2] = 0;
    }
  }

  const indices = new Uint32Array(segs * segs * 6);
  let iPtr = 0;
  for (let r = 0; r < segs; r++) {
    for (let c = 0; c < segs; c++) {
      const i00 = r * cols + c;
      const i10 = i00 + 1;
      const i01 = (r + 1) * cols + c;
      const i11 = i01 + 1;
      indices[iPtr++] = i00;
      indices[iPtr++] = i01;
      indices[iPtr++] = i11;
      indices[iPtr++] = i00;
      indices[iPtr++] = i11;
      indices[iPtr++] = i10;
    }
  }

  VertexData.ComputeNormals(positions, indices, normals);

  const mesh = new Mesh('MapNGMacroSurround', scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.indices = indices;
  vd.applyToMesh(mesh, false);

  const mat = new StandardMaterial('mapngSurroundMat', scene);
  mat.specularColor = new Color3(0.05, 0.05, 0.05);
  mat.diffuseColor = new Color3(0.85, 0.88, 0.80);
  if (macroSatelliteDataUrl) {
    const tex = new Texture(macroSatelliteDataUrl, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = Math.min(4, getDeviceProfile().maxAnisotropy);
    mat.diffuseTexture = tex;
  }

  mesh.material = mat;
  mesh.receiveShadows = true;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
  return mesh;
}
