import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'public', 'textures', 'hdri_thumbs');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PRESETS = [
  { id: 'limpopo_golf_course', file: 'public/hdris/limpopo_golf_course_2k.hdr', rotationDeg: 0 },
  { id: 'hausdorf_clear_sky', file: 'public/hdris/hausdorf_clear_sky_2k.hdr', rotationDeg: 45 },
  { id: 'pretoria_gardens', file: 'public/hdris/pretoria_gardens_2k.hdr', rotationDeg: 90 },
  { id: 'meadow', file: 'public/hdris/meadow_2k.hdr', rotationDeg: 180 },
  { id: 'meadow_2', file: 'public/hdris/meadow_2_2k.hdr', rotationDeg: 270 },
  { id: 'noon_grass', file: 'public/hdris/noon_grass_2k.hdr', rotationDeg: 0 },
  { id: 'approaching_storm', file: 'public/approaching_storm_4k.hdr', rotationDeg: 0 },
  { id: 'misty_pines', file: 'public/misty_pines_4k.hdr', rotationDeg: 60 }
];

function decodeHdr(filePath) {
  const buf = fs.readFileSync(filePath);
  let pos = 0;

  // Read header until empty line
  while (pos < buf.length) {
    const lineEnd = buf.indexOf(0x0a, pos);
    if (lineEnd === -1) throw new Error('Invalid HDR header in ' + filePath);
    const line = buf.subarray(pos, lineEnd).toString('ascii').replace(/\r$/, '');
    pos = lineEnd + 1;
    if (line.length === 0) break;
  }

  const resEnd = buf.indexOf(0x0a, pos);
  if (resEnd === -1) throw new Error('Missing HDR resolution line in ' + filePath);
  const resLine = buf.subarray(pos, resEnd).toString('ascii').replace(/\r$/, '');
  pos = resEnd + 1;

  const match = resLine.match(/^([+-]Y)\s+(\d+)\s+([+-]X)\s+(\d+)/);
  if (!match) throw new Error(`Unsupported HDR resolution "${resLine}" in ${filePath}`);
  const height = parseInt(match[2], 10);
  const width = parseInt(match[4], 10);

  const floatData = new Float32Array(width * height * 3);
  const scanline = new Uint8Array(width * 4);

  for (let y = 0; y < height; y++) {
    const b0 = buf[pos];
    const b1 = buf[pos + 1];
    const b2 = buf[pos + 2];
    const b3 = buf[pos + 3];

    if (width >= 8 && width <= 0x7fff && b0 === 2 && b1 === 2 && (((b2 << 8) | b3) === width)) {
      pos += 4;
      for (let ch = 0; ch < 4; ch++) {
        let x = 0;
        const chOff = ch * width;
        while (x < width) {
          const code = buf[pos++];
          if (code > 128) {
            const count = code - 128;
            const val = buf[pos++];
            for (let k = 0; k < count && x < width; k++) {
              scanline[chOff + x++] = val;
            }
          } else {
            const count = code;
            for (let k = 0; k < count && x < width; k++) {
              scanline[chOff + x++] = buf[pos++];
            }
          }
        }
      }
      const rowStart = y * width * 3;
      for (let x = 0; x < width; x++) {
        const r = scanline[x];
        const g = scanline[width + x];
        const b = scanline[2 * width + x];
        const e = scanline[3 * width + x];
        if (e > 0) {
          const f = Math.pow(2.0, e - 136);
          floatData[rowStart + x * 3] = r * f;
          floatData[rowStart + x * 3 + 1] = g * f;
          floatData[rowStart + x * 3 + 2] = b * f;
        }
      }
    } else {
      // Uncompressed RGBE fallback
      const rowStart = y * width * 3;
      for (let x = 0; x < width; x++) {
        const r = buf[pos++];
        const g = buf[pos++];
        const b = buf[pos++];
        const e = buf[pos++];
        if (e > 0) {
          const f = Math.pow(2.0, e - 136);
          floatData[rowStart + x * 3] = r * f;
          floatData[rowStart + x * 3 + 1] = g * f;
          floatData[rowStart + x * 3 + 2] = b * f;
        }
      }
    }
  }

  return { width, height, data: floatData };
}

function sampleEquirectBilinear(hdr, u, v) {
  const { width, height, data } = hdr;
  const uu = ((u % 1) + 1) % 1;
  const vv = Math.max(0, Math.min(1, v));
  const fx = uu * (width - 1);
  const fy = vv * (height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = (x0 + 1) % width;
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const i00 = (y0 * width + x0) * 3;
  const i10 = (y0 * width + x1) * 3;
  const i01 = (y1 * width + x0) * 3;
  const i11 = (y1 * width + x1) * 3;

  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  return [
    data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11,
    data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11,
    data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11
  ];
}

function acesToneMap(x) {
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  return Math.max(0, Math.min(1, (x * (a * x + b)) / (x * (c * x + d) + e)));
}

// Standard PNG CRC32 & encoder
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePngRgba(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1);
    raw[rowOff] = 0; // filter None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowOff + 1);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

function renderSphereThumbnail(hdr, rotationDeg, size = 128) {
  // Estimate well-exposed middle-luminance factor so Photoshop / PolyHaven HDRIs all look balanced
  let logSum = 0;
  let count = 0;
  const stepY = Math.max(1, Math.floor(hdr.height / 48));
  const stepX = Math.max(1, Math.floor(hdr.width / 64));
  for (let y = 0; y < hdr.height; y += stepY) {
    for (let x = 0; x < hdr.width; x += stepX) {
      const i = (y * hdr.width + x) * 3;
      const lum = 0.2126 * hdr.data[i] + 0.7152 * hdr.data[i + 1] + 0.0722 * hdr.data[i + 2];
      logSum += Math.log(Math.max(1e-4, Math.min(20.0, lum)));
      count++;
    }
  }
  const avgLum = Math.exp(logSum / Math.max(1, count));
  const exposure = Math.max(0.35, Math.min(3.5, 0.36 / Math.max(0.05, avgLum)));

  const rgba = new Uint8Array(size * size * 4);
  const rotRad = (rotationDeg * Math.PI) / 180;
  const cosY = Math.cos(rotRad);
  const sinY = Math.sin(rotRad);
  const half = size * 0.5;
  const radiusScale = 0.96; // leave slight outer antialias headroom

  for (let y = 0; y < size; y++) {
    const ny = (half - (y + 0.5)) / (half * radiusScale);
    for (let x = 0; x < size; x++) {
      const nx = ((x + 0.5) - half) / (half * radiusScale);
      const r = Math.hypot(nx, ny);
      const idx = (y * size + x) * 4;
      if (r >= 1.0) {
        rgba[idx + 3] = 0;
        continue;
      }

      const alpha = r > 0.965 ? Math.max(0, Math.min(1, (1.0 - r) / 0.035)) : 1.0;
      const nz = Math.sqrt(Math.max(0, 1.0 - r * r));

      // Mirror-ball reflection direction (camera looks along -Z toward +Z hemisphere)
      const rx = 2.0 * nx * nz;
      const ry = 2.0 * ny * nz;
      const rz = 2.0 * nz * nz - 1.0;

      // Apply preset Y-axis yaw
      const rotX = rx * cosY + rz * sinY;
      const rotZ = -rx * sinY + rz * cosY;

      const u = (Math.atan2(rotZ, rotX) + Math.PI) / (2.0 * Math.PI);
      const v = Math.acos(Math.max(-1.0, Math.min(1.0, ry))) / Math.PI;

      const [hr, hg, hb] = sampleEquirectBilinear(hdr, u, v);

      // Subtle glossy rim Fresnel + soft bottom studio sphere shading for crisp 3D depth
      const fresnel = Math.pow(1.0 - nz, 3.2) * 0.22;
      const shade = 0.86 + 0.14 * (0.5 + 0.5 * ny);

      const mr = acesToneMap(hr * exposure * shade + fresnel);
      const mg = acesToneMap(hg * exposure * shade + fresnel * 1.03);
      const mb = acesToneMap(hb * exposure * shade + fresnel * 1.08);

      rgba[idx] = Math.round(Math.pow(mr, 1 / 2.2) * 255);
      rgba[idx + 1] = Math.round(Math.pow(mg, 1 / 2.2) * 255);
      rgba[idx + 2] = Math.round(Math.pow(mb, 1 / 2.2) * 255);
      rgba[idx + 3] = Math.round(alpha * 255);
    }
  }

  return rgba;
}

for (const preset of PRESETS) {
  const fullPath = path.join(ROOT, preset.file);
  const hdr = decodeHdr(fullPath);
  const rgba = renderSphereThumbnail(hdr, preset.rotationDeg, 128);
  const png = encodePngRgba(128, 128, rgba);
  const outFile = path.join(OUT_DIR, `${preset.id}.png`);
  fs.writeFileSync(outFile, png);
  console.log(`Generated ${outFile} (${hdr.width}x${hdr.height} -> 128x128 sphere, ${png.length}B)`);
}
