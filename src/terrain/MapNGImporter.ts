import {
  Scene,
  Mesh,
  VertexData,
  StandardMaterial,
  PBRMaterial,
  Texture,
  Color3
} from '@babylonjs/core';
import { MapNGCourseMeta } from '../core/Types';
import { getDeviceProfile } from '../core/DeviceProfile';
import { pointInPolygon } from './PolygonMath';
import { KYALAMI_COURSE_BOUNDARY_METERS } from '../data/KyalamiCourseData';

export interface Decoded16BitHeightmap {
  width: number;
  height: number;
  bitDepth: number;
  pixels: Uint16Array;
}

export interface CourseFootprintMask {
  polygonMeters?: { x: number; z: number }[];
  gridRes?: number;
  gridMask?: Uint8Array;
  sourceLabel: string;
  coveragePct: number;
}

export interface LoadedMapNGSource {
  meta: MapNGCourseMeta;
  heightmap: Decoded16BitHeightmap;
  satelliteImg: HTMLImageElement | null;
  satelliteUrl: string | null;
  courseFootprint?: CourseFootprintMask;
}

export interface MapNGCropOptions {
  cropCenterX: number; // meters from West edge of MapNG source
  cropCenterZ: number; // meters from North edge of MapNG source
  rotationDeg: number; // hole azimuth clockwise from North
  elevationScale: number; // vertical multiplier (default 1.0)
  gridWidth: number; // active hole width in meters (220)
  gridLength: number; // active hole length in meters (460)
  isolateCourseOnly?: boolean; // true = discard non-golf suburban terrain outside course footprint
  courseFootprint?: CourseFootprintMask | null;
}

export interface ExtractedMapNGHole {
  baseHeights: Float32Array;
  minHoleElev: number;
  maxHoleElev: number;
  satelliteDataUrl: string | null;
  macroSatelliteDataUrl: string | null;
  holeCourseMask: Uint8Array | null;
  courseCenterWorld: { x: number; z: number };
  courseSpanMeters: number;
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
 * Identifies the golf course holes footprint on the MapNG satellite / geospatial dataset
 * so surrounding residential streets and buildings are excluded from 3D terrain geometry.
 */
export function detectGolfCourseFootprint(source: LoadedMapNGSource): CourseFootprintMask {
  const lat = source.meta.centerLat;
  const lon = source.meta.centerLon;
  const levelName = (source.meta.levelName || '').toLowerCase();
  const isKyalamiLocation =
    (lat !== undefined && lon !== undefined && Math.abs(lat - -25.9754) < 0.03 && Math.abs(lon - 28.059) < 0.03) ||
    levelName.includes('kyalami') ||
    levelName.includes('lipizzaner');

  if (isKyalamiLocation) {
    return {
      polygonMeters: KYALAMI_COURSE_BOUNDARY_METERS,
      sourceLabel: 'Kyalami CC 18-Hole Footprint',
      coveragePct: 26
    };
  }

  const res = 128;
  const gridMask = new Uint8Array(res * res);
  if (!source.satelliteImg || source.satelliteImg.width <= 0 || source.satelliteImg.height <= 0) {
    gridMask.fill(1);
    return { gridRes: res, gridMask, sourceLabel: 'Full DEM Tile (No Satellite)', coveragePct: 100 };
  }

  const c = document.createElement('canvas');
  c.width = res;
  c.height = res;
  const ctx = c.getContext('2d');
  if (!ctx) {
    gridMask.fill(1);
    return { gridRes: res, gridMask, sourceLabel: 'Full DEM Tile', coveragePct: 100 };
  }
  ctx.drawImage(source.satelliteImg, 0, 0, res, res);
  const px = ctx.getImageData(0, 0, res, res).data;

  let turfSeed = new Uint8Array(res * res);
  for (let i = 0; i < res * res; i++) {
    const r = px[i * 4];
    const g = px[i * 4 + 1];
    const b = px[i * 4 + 2];
    // Manicured golf fairways & greens show strong emerald green chromaticity
    const isFairwayGreen = g > 92 && g - r > 12 && g - b > 22;
    const isGolfPond = g > 55 && g < 115 && r < 92 && b < 85 && g > b + 8;
    if (isFairwayGreen || isGolfPond) turfSeed[i] = 1;
  }

  const dilate = (src: Uint8Array, radius: number): Uint8Array => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        if (!src[y * res + x]) continue;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= res) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < res) out[yy * res + xx] = 1;
          }
        }
      }
    }
    return out;
  };

  const erode = (src: Uint8Array, minNeighbors: number): Uint8Array => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        if (!src[y * res + x]) continue;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= res) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < res && src[yy * res + xx]) cnt++;
          }
        }
        if (cnt >= minNeighbors) out[y * res + x] = 1;
      }
    }
    return out;
  };

  // Bridge gaps between adjacent holes/rough while pruning isolated backyard lawns
  const closed = erode(dilate(erode(dilate(turfSeed, 2), 4), 2), 3);

  // Connected-component labeling: retain largest golf-course cluster (+ components >= 15% of largest)
  const labels = new Int32Array(res * res);
  const compSizes: number[] = [0];
  const queue = new Int32Array(res * res);
  let nextLabel = 1;
  let maxCompSize = 0;

  for (let i = 0; i < res * res; i++) {
    if (!closed[i] || labels[i] !== 0) continue;
    let qHead = 0;
    let qTail = 0;
    queue[qTail++] = i;
    labels[i] = nextLabel;
    while (qHead < qTail) {
      const cur = queue[qHead++];
      const cx = cur % res;
      const cy = (cur - cx) / res;
      const nbs = [
        cx > 0 ? cur - 1 : -1,
        cx + 1 < res ? cur + 1 : -1,
        cy > 0 ? cur - res : -1,
        cy + 1 < res ? cur + res : -1
      ];
      for (const nb of nbs) {
        if (nb >= 0 && closed[nb] && labels[nb] === 0) {
          labels[nb] = nextLabel;
          queue[qTail++] = nb;
        }
      }
    }
    compSizes[nextLabel] = qTail;
    if (qTail > maxCompSize) maxCompSize = qTail;
    nextLabel++;
  }

  let keptCount = 0;
  for (let i = 0; i < res * res; i++) {
    const lbl = labels[i];
    if (lbl > 0 && compSizes[lbl] >= Math.max(12, maxCompSize * 0.15)) {
      gridMask[i] = 1;
      keptCount++;
    }
  }

  if (keptCount < res * res * 0.03) {
    gridMask.fill(1);
    keptCount = res * res;
  }

  return {
    gridRes: res,
    gridMask,
    sourceLabel: 'Auto-Detected Golf Course Turf',
    coveragePct: Math.round((keptCount / (res * res)) * 100)
  };
}

export function isPointInCourseFootprint(
  footprint: CourseFootprintMask | null | undefined,
  eastM: number,
  southM: number,
  spanW: number,
  spanL: number
): boolean {
  if (!footprint) return true;
  if (footprint.polygonMeters && footprint.polygonMeters.length >= 3) {
    return pointInPolygon(eastM, southM, footprint.polygonMeters);
  }
  if (footprint.gridMask && footprint.gridRes) {
    const res = footprint.gridRes;
    const gx = Math.max(0, Math.min(res - 1, Math.floor((eastM / Math.max(1, spanW)) * res)));
    const gz = Math.max(0, Math.min(res - 1, Math.floor((southM / Math.max(1, spanL)) * res)));
    return footprint.gridMask[gz * res + gx] === 1;
  }
  return true;
}

/**
 * Generates active-hole and full-course macro satellite DataURLs from a MapNG satellite image
 * and active crop window parameters without re-decoding the 16-bit heightmap.
 */
export function extractSatelliteDataUrls(
  satelliteImg: HTMLImageElement | null,
  sourceWidthPx: number,
  sourceHeightPx: number,
  mpp: number,
  options: MapNGCropOptions
): { satelliteDataUrl: string | null; macroSatelliteDataUrl: string | null } {
  if (!satelliteImg || satelliteImg.width <= 0 || satelliteImg.height <= 0) {
    return { satelliteDataUrl: null, macroSatelliteDataUrl: null };
  }

  const profile = getDeviceProfile();
  const rotRad = (options.rotationDeg * Math.PI) / 180.0;
  const targetH = Math.min(2048, profile.maxSatelliteTextureSize);
  const targetW = Math.max(256, Math.round(targetH * (options.gridWidth / options.gridLength)));

  let satelliteDataUrl: string | null = null;
  let macroSatelliteDataUrl: string | null = null;

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const imgScaleX = satelliteImg.width / Math.max(1, sourceWidthPx);
    const imgScaleY = satelliteImg.height / Math.max(1, sourceHeightPx);
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
    satelliteDataUrl = canvas.toDataURL('image/jpeg', 0.90);
  }

  const macroCanvas = document.createElement('canvas');
  const macroDim = Math.min(2048, profile.maxSatelliteTextureSize);
  macroCanvas.width = macroDim;
  macroCanvas.height = macroDim;
  const mCtx = macroCanvas.getContext('2d');
  if (mCtx) {
    const spanW = sourceWidthPx * mpp;
    const spanL = sourceHeightPx * mpp;
    const fp = options.isolateCourseOnly !== false ? options.courseFootprint : null;

    if (fp?.polygonMeters && fp.polygonMeters.length >= 3) {
      // Mask out non-course surroundings so perimeter triangles never sample roof/road colors via bilinear filtering
      mCtx.fillStyle = '#1e3518';
      mCtx.fillRect(0, 0, macroDim, macroDim);
      mCtx.save();
      mCtx.beginPath();
      fp.polygonMeters.forEach((p, idx) => {
        const px = (p.x / Math.max(1, spanW)) * macroDim;
        const py = (p.z / Math.max(1, spanL)) * macroDim;
        if (idx === 0) mCtx.moveTo(px, py);
        else mCtx.lineTo(px, py);
      });
      mCtx.closePath();
      mCtx.clip();
      mCtx.drawImage(satelliteImg, 0, 0, macroDim, macroDim);
      mCtx.restore();
    } else if (fp?.gridMask && fp.gridRes) {
      mCtx.drawImage(satelliteImg, 0, 0, macroDim, macroDim);
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = fp.gridRes;
      maskCanvas.height = fp.gridRes;
      const maskCtx = maskCanvas.getContext('2d');
      if (maskCtx) {
        const imgData = maskCtx.createImageData(fp.gridRes, fp.gridRes);
        for (let i = 0; i < fp.gridMask.length; i++) {
          imgData.data[i * 4 + 3] = fp.gridMask[i] ? 255 : 0;
        }
        maskCtx.putImageData(imgData, 0, 0);
        mCtx.save();
        mCtx.globalCompositeOperation = 'destination-in';
        mCtx.drawImage(maskCanvas, 0, 0, macroDim, macroDim);
        mCtx.globalCompositeOperation = 'destination-over';
        mCtx.fillStyle = '#1e3518';
        mCtx.fillRect(0, 0, macroDim, macroDim);
        mCtx.restore();
      }
    } else {
      mCtx.drawImage(satelliteImg, 0, 0, macroDim, macroDim);
    }
    macroSatelliteDataUrl = macroCanvas.toDataURL('image/jpeg', 0.86);
  }

  return { satelliteDataUrl, macroSatelliteDataUrl };
}

/**
 * Extracts a rotated 220m x 460m active golf hole DEM heightfield + co-registered satellite textures
 * and optional golf-course footprint mask directly from a 2048m x 2048m MapNG course export.
 */
export function extractHoleCrop(
  source: LoadedMapNGSource,
  options: MapNGCropOptions
): ExtractedMapNGHole {
  const { meta, heightmap, satelliteImg } = source;
  const mpp = meta.metersPerPixel || 1.0;
  const spanW = heightmap.width * mpp;
  const spanL = heightmap.height * mpp;
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

  const footprint = options.isolateCourseOnly !== false ? (options.courseFootprint || source.courseFootprint) : null;
  let holeCourseMask: Uint8Array | null = null;
  if (footprint) {
    const mask = new Uint8Array(options.gridWidth * options.gridLength);
    let insideCount = 0;
    for (let cz = 0; cz < options.gridLength; cz++) {
      const dz = cz + 0.5 - halfL;
      for (let cx = 0; cx < options.gridWidth; cx++) {
        const dx = cx + 0.5 - halfW;
        const eastM = options.cropCenterX + dx * cosR + dz * sinR;
        const northDelta = -dx * sinR + dz * cosR;
        const southM = options.cropCenterZ - northDelta;
        if (isPointInCourseFootprint(footprint, eastM, southM, spanW, spanL)) {
          mask[cz * options.gridWidth + cx] = 1;
          insideCount++;
        }
      }
    }
    // Safety guard: never collapse GolfTerrain if user centered outside course perimeter
    if (insideCount > options.gridWidth * options.gridLength * 0.02) {
      holeCourseMask = mask;
    }
  }

  // Compute tight 3D bounding center & span of isolated golf course holes for overview camera
  let courseCenterWorld = { x: halfW, z: halfL };
  let courseSpanMeters = Math.max(spanW, spanL);
  if (footprint) {
    let minWx = Infinity;
    let maxWx = -Infinity;
    let minWz = Infinity;
    let maxWz = -Infinity;
    const stepM = 32;
    for (let sm = 0; sm <= spanL; sm += stepM) {
      const dn = options.cropCenterZ - sm;
      for (let em = 0; em <= spanW; em += stepM) {
        if (!isPointInCourseFootprint(footprint, em, sm, spanW, spanL)) continue;
        const de = em - options.cropCenterX;
        const wx = halfW + (de * cosR - dn * sinR);
        const wz = halfL + (de * sinR + dn * cosR);
        if (wx < minWx) minWx = wx;
        if (wx > maxWx) maxWx = wx;
        if (wz < minWz) minWz = wz;
        if (wz > maxWz) maxWz = wz;
      }
    }
    if (maxWx > minWx && maxWz > minWz) {
      courseCenterWorld = { x: (minWx + maxWx) * 0.5, z: (minWz + maxWz) * 0.5 };
      courseSpanMeters = Math.max(maxWx - minWx, maxWz - minWz, 480);
    }
  }

  const { satelliteDataUrl, macroSatelliteDataUrl } = extractSatelliteDataUrls(
    satelliteImg,
    heightmap.width,
    heightmap.height,
    mpp,
    { ...options, courseFootprint: footprint }
  );

  return {
    baseHeights,
    minHoleElev,
    maxHoleElev,
    satelliteDataUrl,
    macroSatelliteDataUrl,
    holeCourseMask,
    courseCenterWorld,
    courseSpanMeters,
    meta: {
      ...meta,
      cropOriginX: options.cropCenterX,
      cropOriginZ: options.cropCenterZ,
      cropRotationRad: rotRad,
      cropWidthMeters: options.gridWidth,
      cropLengthMeters: options.gridLength,
      sourceSpanW: spanW,
      sourceSpanH: spanL
    }
  };
}

/**
 * Approach B: Builds a compacted 1:1 macro surround mesh covering ONLY the identified golf course holes
 * footprint around the active hole (completely discarding surrounding neighborhood streets & buildings).
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

  const profile = getDeviceProfile();
  const segs = profile.tier === 'high' ? 192 : 128;
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
  const footprint = options.isolateCourseOnly !== false ? (options.courseFootprint || source.courseFootprint) : null;

  const rawPositions = new Float32Array(cols * rows * 3);
  const rawUvs = new Float32Array(cols * rows * 2);

  for (let r = 0; r < rows; r++) {
    const vFrac = r / segs;
    const southM = (1.0 - vFrac) * spanL;
    const dn = options.cropCenterZ - southM;

    for (let c = 0; c < cols; c++) {
      const uFrac = c / segs;
      const eastM = uFrac * spanW;
      const de = eastM - options.cropCenterX;

      const dx = de * cosR - dn * sinR;
      const dz = de * sinR + dn * cosR;
      const wx = halfW + dx;
      const wz = halfL + dz;

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

      if (wx > 3 && wx < options.gridWidth - 3 && wz > 3 && wz < options.gridLength - 3) {
        wy -= 3.5;
      }

      const idx = r * cols + c;
      rawPositions[idx * 3] = wx;
      rawPositions[idx * 3 + 1] = wy;
      rawPositions[idx * 3 + 2] = wz;
      rawUvs[idx * 2] = uFrac;
      rawUvs[idx * 2 + 1] = vFrac;
    }
  }

  // Filter quads to ONLY golf course property footprint and compact vertex arrays
  const rawIndices: number[] = [];
  const oldToNew = new Int32Array(cols * rows).fill(-1);
  let keptVertCount = 0;

  const ensureVertex = (origIdx: number): number => {
    let mapped = oldToNew[origIdx];
    if (mapped === -1) {
      mapped = keptVertCount++;
      oldToNew[origIdx] = mapped;
    }
    return mapped;
  };

  for (let r = 0; r < segs; r++) {
    const vMid = (r + 0.5) / segs;
    const southMid = (1.0 - vMid) * spanL;
    for (let c = 0; c < segs; c++) {
      const uMid = (c + 0.5) / segs;
      const eastMid = uMid * spanW;
      if (footprint && !isPointInCourseFootprint(footprint, eastMid, southMid, spanW, spanL)) {
        continue;
      }

      const i00 = ensureVertex(r * cols + c);
      const i10 = ensureVertex(r * cols + c + 1);
      const i01 = ensureVertex((r + 1) * cols + c);
      const i11 = ensureVertex((r + 1) * cols + c + 1);

      rawIndices.push(i00, i11, i01, i00, i10, i11);
    }
  }

  // Safety fallback if mask was empty
  if (rawIndices.length === 0) {
    oldToNew.fill(-1);
    keptVertCount = 0;
    for (let r = 0; r < segs; r++) {
      for (let c = 0; c < segs; c++) {
        const i00 = ensureVertex(r * cols + c);
        const i10 = ensureVertex(r * cols + c + 1);
        const i01 = ensureVertex((r + 1) * cols + c);
        const i11 = ensureVertex((r + 1) * cols + c + 1);
        rawIndices.push(i00, i11, i01, i00, i10, i11);
      }
    }
  }

  const positions = new Float32Array(keptVertCount * 3);
  const normals = new Float32Array(keptVertCount * 3);
  const uvs = new Float32Array(keptVertCount * 2);

  for (let origIdx = 0; origIdx < oldToNew.length; origIdx++) {
    const mapped = oldToNew[origIdx];
    if (mapped === -1) continue;
    positions[mapped * 3] = rawPositions[origIdx * 3];
    positions[mapped * 3 + 1] = rawPositions[origIdx * 3 + 1];
    positions[mapped * 3 + 2] = rawPositions[origIdx * 3 + 2];
    uvs[mapped * 2] = rawUvs[origIdx * 2];
    uvs[mapped * 2 + 1] = rawUvs[origIdx * 2 + 1];
  }

  const indices = new Uint32Array(rawIndices);
  VertexData.ComputeNormals(positions, indices, normals);
  if (normals.length > 1 && normals[1] < 0) {
    for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
  }

  const mesh = new Mesh('MapNGMacroSurround', scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.indices = indices;
  vd.applyToMesh(mesh, false);

  const mat = new PBRMaterial('mapngSurroundMat', scene);
  mat.metallic = 0.0;
  mat.roughness = 0.85;
  mat.backFaceCulling = false;
  if (macroSatelliteDataUrl) {
    mat.albedoColor = Color3.White();
    const tex = new Texture(macroSatelliteDataUrl, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = Math.min(4, profile.maxAnisotropy);
    mat.albedoTexture = tex;
    (mat as any)._satTex = tex;
  } else {
    mat.albedoColor = new Color3(0.28, 0.44, 0.16);
  }

  mesh.material = mat;
  mesh.receiveShadows = true;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
  return mesh;
}

/**
 * Syncs the Ground <-> Satellite mix or updated satellite texture on the 2km MapNG macro surround mesh.
 */
export function updateMacroSurroundMix(
  mesh: Mesh | null,
  satelliteMix: number,
  groundBaseColorHex: string,
  macroSatelliteDataUrl?: string | null
) {
  if (!mesh || mesh.isDisposed()) return;
  const mat = mesh.material as PBRMaterial | null;
  if (!mat) return;
  const mix = Math.max(0, Math.min(1, satelliteMix));

  if (macroSatelliteDataUrl !== undefined) {
    const prevSat = (mat as any)._satTex as Texture | null | undefined;
    if (prevSat) {
      prevSat.dispose();
      (mat as any)._satTex = null;
    }
    if (macroSatelliteDataUrl) {
      const tex = new Texture(macroSatelliteDataUrl, mesh.getScene(), false, true, Texture.TRILINEAR_SAMPLINGMODE);
      tex.wrapU = Texture.CLAMP_ADDRESSMODE;
      tex.wrapV = Texture.CLAMP_ADDRESSMODE;
      tex.anisotropicFilteringLevel = Math.min(4, getDeviceProfile().maxAnisotropy);
      (mat as any)._satTex = tex;
    }
  }

  const satTex = ((mat as any)._satTex as Texture | null | undefined) ?? null;
  const baseTint = Color3.FromHexString(groundBaseColorHex || '#4c7426');
  if (satTex && mix > 0.01) {
    satTex.level = 1.0;
    mat.albedoTexture = satTex;
    mat.albedoColor = Color3.Lerp(baseTint, Color3.White(), mix);
  } else {
    mat.albedoTexture = null;
    mat.albedoColor = baseTint;
  }
}
