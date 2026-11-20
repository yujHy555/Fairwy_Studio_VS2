export interface PolygonPoint {
  x: number;
  z: number;
  corner?: boolean;
}

export interface PolygonBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  centerX: number;
  centerZ: number;
  width: number;
  length: number;
}

export function computePolygonBounds(pts: readonly { x: number; z: number }[]): PolygonBounds {
  if (!pts.length) {
    return { minX: 0, maxX: 0, minZ: 0, maxZ: 0, centerX: 0, centerZ: 0, width: 1, length: 1 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const width = Math.max(1.0, maxX - minX);
  const length = Math.max(1.0, maxZ - minZ);
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    centerX: (minX + maxX) * 0.5,
    centerZ: (minZ + maxZ) * 0.5,
    width,
    length
  };
}

export function signedArea2D(pts: readonly { x: number; z: number }[]): number {
  let area2 = 0;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area2 += (pts[j].x * pts[i].z - pts[i].x * pts[j].z);
  }
  return area2 * 0.5;
}

export function ensureCCW<T extends { x: number; z: number }>(pts: readonly T[]): T[] {
  const copy = pts.map((p) => ({ ...p }));
  if (signedArea2D(copy) < 0) {
    copy.reverse();
  }
  return copy;
}

export function pointInPolygon(x: number, z: number, pts: readonly { x: number; z: number }[]): boolean {
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i].x;
    const zi = pts[i].z;
    const xj = pts[j].x;
    const zj = pts[j].z;
    const intersect = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / ((zj - zi) || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Signed Euclidean distance in meters from `(x, z)` to a closed polygon contour.
 * Negative values are inside the polygon; positive values are outside.
 */
export function signedDistanceToPolygon(
  x: number,
  z: number,
  pts: readonly { x: number; z: number }[]
): number {
  const n = pts.length;
  if (n < 3) return 1e6;

  let minDistSq = Infinity;
  let inside = false;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = pts[j].x;
    const az = pts[j].z;
    const bx = pts[i].x;
    const bz = pts[i].z;

    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / ((bz - az) || 1e-12) + ax) {
      inside = !inside;
    }

    const abx = bx - ax;
    const abz = bz - az;
    const lenSq = abx * abx + abz * abz;
    let t = 0;
    if (lenSq > 1e-10) {
      t = ((x - ax) * abx + (z - az) * abz) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const px = ax + abx * t;
    const pz = az + abz * t;
    const dx = x - px;
    const dz = z - pz;
    const dSq = dx * dx + dz * dz;
    if (dSq < minDistSq) {
      minDistSq = dSq;
    }
  }

  const d = Math.sqrt(minDistSq);
  return inside ? -d : d;
}

function perpDistToSegmentSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): number {
  const vx = bx - ax;
  const vz = bz - az;
  const lenSq = vx * vx + vz * vz;
  if (lenSq <= 1e-10) {
    const dx = px - ax;
    const dz = pz - az;
    return dx * dx + dz * dz;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / lenSq));
  const projX = ax + vx * t;
  const projZ = az + vz * t;
  const dx = px - projX;
  const dz = pz - projZ;
  return dx * dx + dz * dz;
}

function rdpOpenRecursive(
  pts: readonly PolygonPoint[],
  startIdx: number,
  endIdx: number,
  epsSq: number,
  keep: Uint8Array
) {
  if (endIdx <= startIdx + 1) return;
  let maxDSq = 0;
  let maxIdx = -1;
  const a = pts[startIdx];
  const b = pts[endIdx];
  for (let i = startIdx + 1; i < endIdx; i++) {
    const dSq = perpDistToSegmentSq(pts[i].x, pts[i].z, a.x, a.z, b.x, b.z);
    if (dSq > maxDSq) {
      maxDSq = dSq;
      maxIdx = i;
    }
  }
  if (maxIdx !== -1 && maxDSq > epsSq) {
    keep[maxIdx] = 1;
    rdpOpenRecursive(pts, startIdx, maxIdx, epsSq, keep);
    rdpOpenRecursive(pts, maxIdx, endIdx, epsSq, keep);
  }
}

/**
 * Ramer-Douglas-Peucker simplification tuned for closed freehand lasso contours.
 */
export function rdpSimplify(pts: readonly PolygonPoint[], epsilonMeters: number = 1.35): PolygonPoint[] {
  if (pts.length <= 4) return pts.map((p) => ({ x: p.x, z: p.z, corner: p.corner }));

  // Find point farthest from pts[0] to split closed loop cleanly into two open arcs
  let splitIdx = Math.floor(pts.length / 2);
  let bestDistSq = -1;
  const p0 = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - p0.x;
    const dz = pts[i].z - p0.z;
    const dSq = dx * dx + dz * dz;
    if (dSq > bestDistSq) {
      bestDistSq = dSq;
      splitIdx = i;
    }
  }

  const epsSq = epsilonMeters * epsilonMeters;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[splitIdx] = 1;
  rdpOpenRecursive(pts, 0, splitIdx, epsSq, keep);

  const tailArc: PolygonPoint[] = [];
  for (let i = splitIdx; i < pts.length; i++) tailArc.push(pts[i]);
  tailArc.push(pts[0]);
  const keepTail = new Uint8Array(tailArc.length);
  keepTail[0] = 1;
  keepTail[tailArc.length - 1] = 1;
  rdpOpenRecursive(tailArc, 0, tailArc.length - 1, epsSq, keepTail);
  for (let i = 1; i < tailArc.length - 1; i++) {
    if (keepTail[i]) {
      keep[splitIdx + i] = 1;
    }
  }

  const out: PolygonPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) out.push({ x: pts[i].x, z: pts[i].z, corner: pts[i].corner });
  }
  return out.length >= 3 ? out : pts.slice(0, 3).map((p) => ({ ...p }));
}

/**
 * Smooth closed Catmull-Rom spline sampler that respects `corner` vertices.
 */
export function catmullRomClosed(
  controlPts: readonly PolygonPoint[],
  samplesPerSegment: number = 5
): PolygonPoint[] {
  const n = controlPts.length;
  if (n < 3) return controlPts.map((p) => ({ ...p }));

  const out: PolygonPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = controlPts[(i - 1 + n) % n];
    const p1 = controlPts[i];
    const p2 = controlPts[(i + 1) % n];
    const p3 = controlPts[(i + 2) % n];

    out.push({ x: p1.x, z: p1.z, corner: p1.corner });

    if (p1.corner && p2.corner) {
      continue;
    }

    for (let s = 1; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const z =
        0.5 *
        (2 * p1.z +
          (-p0.z + p2.z) * t +
          (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
          (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
      out.push({ x, z });
    }
  }
  return out;
}

function pointInTriangle2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number
): boolean {
  const c1 = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
  const c2 = (cx - bx) * (pz - bz) - (cz - bz) * (px - bx);
  const c3 = (ax - cx) * (pz - cz) - (az - cz) * (px - cx);
  return c1 >= -1e-7 && c2 >= -1e-7 && c3 >= -1e-7;
}

/**
 * Pure 2D ear-clipping triangulator returning flat index triples (CCW in XZ plane).
 * Indices reference the deduplicated returned `vertices` array.
 */
export function earclipTriangulate2D(
  rawPts: readonly { x: number; z: number }[]
): { vertices: { x: number; z: number }[]; indices: number[] } {
  const clean: { x: number; z: number }[] = [];
  for (let i = 0; i < rawPts.length; i++) {
    const p = rawPts[i];
    if (
      clean.length === 0 ||
      Math.hypot(p.x - clean[clean.length - 1].x, p.z - clean[clean.length - 1].z) > 0.05
    ) {
      clean.push({ x: p.x, z: p.z });
    }
  }
  if (
    clean.length > 2 &&
    Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].z - clean[clean.length - 1].z) <= 0.05
  ) {
    clean.pop();
  }

  const vertices = ensureCCW(clean);
  const n = vertices.length;
  if (n < 3) return { vertices, indices: [] };
  if (n === 3) return { vertices, indices: [0, 1, 2] };

  const active: number[] = [];
  for (let i = 0; i < n; i++) active.push(i);
  const indices: number[] = [];

  let guard = 0;
  const maxIter = n * n * 2;
  let i = 0;

  while (active.length > 3 && guard++ < maxIter) {
    const m = active.length;
    const prev = active[(i - 1 + m) % m];
    const curr = active[i % m];
    const next = active[(i + 1) % m];

    const a = vertices[prev];
    const b = vertices[curr];
    const c = vertices[next];

    const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    if (cross > 1e-6) {
      let hasPointInside = false;
      for (let k = 0; k < m; k++) {
        const testIdx = active[k];
        if (testIdx === prev || testIdx === curr || testIdx === next) continue;
        const tp = vertices[testIdx];
        if (pointInTriangle2D(tp.x, tp.z, a.x, a.z, b.x, b.z, c.x, c.z)) {
          hasPointInside = true;
          break;
        }
      }
      if (!hasPointInside) {
        indices.push(prev, curr, next);
        active.splice(i % m, 1);
        i = i % active.length;
        continue;
      }
    }
    i = (i + 1) % m;
  }

  if (active.length === 3) {
    indices.push(active[0], active[1], active[2]);
  } else if (indices.length === 0) {
    // Degenerate self-intersecting fallback: fan from centroid index 0
    for (let k = 1; k < n - 1; k++) {
      indices.push(0, k, k + 1);
    }
  }

  return { vertices, indices };
}
