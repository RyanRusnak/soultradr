/**
 * Procedural geometry for the CONDUIT sneaker.
 *
 * Everything is generated from a handful of analytic profile functions, so
 * there is no model file to download and the silhouette stays razor sharp at
 * any resolution. Coordinate frame: +X = toe, -X = heel, +Y = up, Z = lateral.
 */

export type V3 = [number, number, number]

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  indices: Uint32Array
}

/** Which shader material a mesh uses. Mirrored as `uPart` in the shader. */
export const Part = {
  Upper: 0,
  SoleWall: 1,
  Insole: 2,
  Outsole: 3,
  Laces: 4,
  Collar: 5,
  Tongue: 6,
  Glow: 7,
  Pod: 8,
  Shell: 9,
} as const
export type PartId = (typeof Part)[keyof typeof Part]

export interface ShoePart {
  part: PartId
  mesh: MeshData
}

/* ------------------------------------------------------------------ *
 * small math helpers
 * ------------------------------------------------------------------ */
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const ss = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** Cubic Hermite through (t, value) control points with Catmull-Rom tangents. */
function curve(pts: [number, number][], t: number) {
  if (t <= pts[0][0]) return pts[0][1]
  const n = pts.length
  if (t >= pts[n - 1][0]) return pts[n - 1][1]
  let i = 0
  while (t > pts[i + 1][0]) i++
  const [t0, p0] = pts[i]
  const [t1, p1] = pts[i + 1]
  const tan = (k: number) => {
    const a = pts[Math.max(0, k - 1)]
    const b = pts[Math.min(n - 1, k + 1)]
    return (b[1] - a[1]) / (b[0] - a[0])
  }
  const h = t1 - t0
  const s = (t - t0) / h
  const s2 = s * s
  const s3 = s2 * s
  return (
    (2 * s3 - 3 * s2 + 1) * p0 +
    (s3 - 2 * s2 + s) * h * tan(i) +
    (-2 * s3 + 3 * s2) * p1 +
    (s3 - s2) * h * tan(i + 1)
  )
}

/** Uniform Catmull-Rom through a 2D polyline, v in [0,1]. */
function catmull2(pts: [number, number][], v: number): [number, number] {
  const n = pts.length - 1
  const f = clamp(v, 0, 1) * n
  const i = Math.min(n - 1, Math.floor(f))
  const s = f - i
  const p0 = pts[Math.max(0, i - 1)]
  const p1 = pts[i]
  const p2 = pts[i + 1]
  const p3 = pts[Math.min(n, i + 2)]
  const cr = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * s + (2 * a - 5 * b + 4 * c - d) * s * s + (-a + 3 * b - 3 * c + d) * s * s * s)
  return [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]
}

/* ------------------------------------------------------------------ *
 * shoe profile functions — t is 0 at the heel, 1 at the toe
 * ------------------------------------------------------------------ */
export const SHOE_LENGTH = 2.8
const X = (t: number) => -SHOE_LENGTH / 2 + SHOE_LENGTH * t

/** Footprint half-width (top view). */
export function soleHalfWidth(t: number) {
  const core = 0.285 + 0.135 * ss(0.05, 0.68, t) - 0.035 * Math.exp(-(((t - 0.45) / 0.12) ** 2))
  const heel = t < 0.1 ? Math.sqrt(Math.max(0, 1 - ((0.1 - t) / 0.1) ** 2)) : 1
  const toe = t > 0.78 ? Math.sqrt(Math.max(0, 1 - ((t - 0.78) / 0.22) ** 2)) : 1
  return core * heel * toe
}

/** Height of the midsole top surface (heel-to-toe drop). */
export function soleTop(t: number) {
  return 0.43 - 0.15 * ss(0.2, 0.8, t)
}
/** Underside of the midsole; the outsole pods hang below this. */
export const MID_BOTTOM = 0.07
/** Open-arch cut-out between the heel pod and the forefoot. */
export function archLift(t: number) {
  return 0.08 * ss(0.25, 0.36, t) * (1 - ss(0.47, 0.6, t))
}
/** Rim of the carbon cage — sweeps up the heel like a cupped exoskeleton. */
export function cageTop(t: number) {
  return soleTop(t) + 0.015 + 0.2 * (1 - ss(0.05, 0.36, t))
}

/** Toe spring + heel bevel, applied to every vertex. */
function bend(p: V3): V3 {
  const t = clamp((p[0] + SHOE_LENGTH / 2) / SHOE_LENGTH, 0, 1)
  const k = ss(0.55, 1.0, t)
  const heel = 1 - ss(0, 0.1, t)
  return [p[0], p[1] + 0.24 * k * k + 0.05 * heel * heel, p[2]]
}

/* ---- upper ---- */
const E_Z = 0.55 // superellipse exponent across (squarer sidewalls)
const E_Y = 0.75 // superellipse exponent vertically
const TOP_LINE: [number, number][] = [
  [0.0, 1.22],
  [0.025, 1.27],
  [0.09, 1.12],
  [0.22, 1.02],
  [0.42, 0.99],
  [0.55, 0.85],
  [0.68, 0.7],
  [0.8, 0.6],
  [1.0, 0.5],
]
const upperBase = (t: number) => soleTop(t) - 0.02
const upperW = (t: number) => soleHalfWidth(t) * 0.955
function upperH(t: number) {
  let h = curve(TOP_LINE, t) - upperBase(t)
  if (t > 0.74) h *= Math.sqrt(Math.max(0, 1 - ((t - 0.74) / 0.26) ** 2))
  return h
}
const taper = (t: number) => 0.36 - 0.16 * ss(0.3, 0.8, t)

export function upperPoint(t: number, phi: number): V3 {
  const c = Math.cos(phi)
  const s = Math.sin(phi)
  const sy = Math.pow(Math.abs(s), E_Y)
  const zf = Math.sign(c) * Math.pow(Math.abs(c), E_Z)
  const w = upperW(t) * (1 - taper(t) * sy * sy)
  // heel counter leans forward as it rises (convex, sculpted heel)
  const lean = 0.13 * sy * sy * (1 - ss(0.0, 0.32, t))
  return bend([X(t) + lean, upperBase(t) + upperH(t) * sy, w * zf])
}

const ph0 = (phi: number) => clamp(phi, 3e-4, Math.PI - 3e-4)
function upperNormal(tIn: number, phi: number): V3 {
  const d = 1e-4
  // step in from the collapsed toe tip / heel line so the derivative is defined
  const t = clamp(tIn, 0.0005, 0.9975)
  const t0 = clamp(t - d, 0, 1)
  const t1 = clamp(t + d, 0, 1)
  const pt = sub(upperPoint(t1, ph0(phi)), upperPoint(t0, ph0(phi)))
  // |sin φ| is symmetric about 0 and π, so a central difference there cancels out
  const ph = clamp(phi, 3 * d, Math.PI - 3 * d)
  const pp = sub(upperPoint(t, ph + d), upperPoint(t, ph - d))
  return norm(cross(pt, pp))
}

/* ankle opening — an ellipse in (t, lateral-fraction) space */
const OPEN_TC = 0.22
const OPEN_HT = 0.22
const OPEN_R = 0.84
function openingPhi(t: number): number | null {
  const d = (t - OPEN_TC) / OPEN_HT
  if (Math.abs(d) >= 1) return null
  const r = OPEN_R * Math.sqrt(1 - d * d)
  return Math.acos(Math.pow(r, 1 / E_Z))
}

/* ------------------------------------------------------------------ *
 * mesh builders
 * ------------------------------------------------------------------ */
class Builder {
  p: number[] = []
  n: number[] = []
  uv: number[] = []
  idx: number[] = []
  vert(p: V3, n: V3, u: number, v: number) {
    this.p.push(p[0], p[1], p[2])
    this.n.push(n[0], n[1], n[2])
    this.uv.push(u, v)
    return this.p.length / 3 - 1
  }
  /** rows × cols grid of vertices starting at `base` */
  grid(base: number, rows: number, cols: number, wrapCols = false, wrapRows = false) {
    const rEnd = wrapRows ? rows : rows - 1
    const cEnd = wrapCols ? cols : cols - 1
    for (let i = 0; i < rEnd; i++) {
      for (let j = 0; j < cEnd; j++) {
        const i1 = (i + 1) % rows
        const j1 = (j + 1) % cols
        const a = base + i * cols + j
        const b = base + i1 * cols + j
        const c = base + i1 * cols + j1
        const d = base + i * cols + j1
        this.idx.push(a, b, c, a, c, d)
      }
    }
  }
  build(): MeshData {
    return {
      positions: new Float32Array(this.p),
      normals: new Float32Array(this.n),
      uvs: new Float32Array(this.uv),
      indices: new Uint32Array(this.idx),
    }
  }
}

/** Parametric surface with finite-difference normals: n = cross(dP/du, dP/dv). */
function surface(
  b: Builder,
  fn: (u: number, v: number) => V3,
  us: number[],
  vs: number[],
  uvOf: (u: number, v: number, p: V3) => [number, number],
  wrapU = false,
) {
  const base = b.p.length / 3
  const d = 1e-4
  for (const u of us) {
    for (const v of vs) {
      const p = fn(u, v)
      const du = sub(fn(u + d, v), fn(u - d, v))
      const dv = sub(fn(u, v + d), fn(u, v - d))
      const n = norm(cross(du, dv))
      const [a, c] = uvOf(u, v, p)
      b.vert(p, n, a, c)
    }
  }
  b.grid(base, us.length, vs.length, false, wrapU)
}

/** Tube with elliptical cross-section along a path, oriented by reference normals. */
function tube(
  b: Builder,
  path: V3[],
  refN: V3[],
  ra: number,
  rb: number,
  seg = 10,
  closed = false,
) {
  const base = b.p.length / 3
  const n = path.length
  for (let k = 0; k < n; k++) {
    const prev = path[closed ? (k - 1 + n) % n : Math.max(0, k - 1)]
    const next = path[closed ? (k + 1) % n : Math.min(n - 1, k + 1)]
    const T = norm(sub(next, prev))
    const N0 = refN[k]
    const N = norm(sub(N0, scale(T, dot(N0, T))))
    const B = cross(T, N)
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2
      const c = Math.cos(th)
      const s = Math.sin(th)
      const p = add(path[k], add(scale(N, ra * c), scale(B, rb * s)))
      const nn = norm(add(scale(N, c / ra), scale(B, s / rb)))
      b.vert(p, nn, k / (n - 1), j / seg)
    }
  }
  // rows = path samples, cols = ring segments (always wrapped)
  const rows = n
  const cols = seg
  const rEnd = closed ? rows : rows - 1
  for (let i = 0; i < rEnd; i++) {
    for (let j = 0; j < cols; j++) {
      const i1 = (i + 1) % rows
      const j1 = (j + 1) % cols
      const a = base + i * cols + j
      const bb = base + i1 * cols + j
      const c = base + i1 * cols + j1
      const d = base + i * cols + j1
      b.idx.push(a, bb, c, a, c, d)
    }
  }
}

const range = (n: number, f: (i: number) => number) => Array.from({ length: n + 1 }, (_, i) => f(i / n))

const spow = (x: number, e: number) => Math.sign(x) * Math.pow(Math.abs(x), e)
/**
 * Superellipsoid "pill" (rounded box). `r` = half extents, `e` < 1 = boxier.
 * `yaw` rotates it about Y so pods can follow the footprint curve.
 */
function blob(b: Builder, c: V3, r: V3, e = 0.35, yaw = 0, nu = 18, nv = 28, roll = 0) {
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cr = Math.cos(roll)
  const sr = Math.sin(roll)
  const fn = (u: number, v: number): V3 => {
    const th = clamp(u, -Math.PI / 2, Math.PI / 2)
    const ct = Math.cos(th)
    const x0 = r[0] * spow(ct, e) * spow(Math.cos(v), e)
    const y0 = r[1] * spow(Math.sin(th), e)
    const z = r[2] * spow(ct, e) * spow(Math.sin(v), e)
    const x = x0 * cr - y0 * sr
    const y = x0 * sr + y0 * cr
    return [c[0] + x * cy + z * sy, c[1] + y, c[2] - x * sy + z * cy]
  }
  surface(
    b,
    fn,
    range(nu, (f) => (-Math.PI / 2 + f * Math.PI) * 0.998),
    Array.from({ length: nv }, (_, i) => (i / nv) * Math.PI * 2),
    (u, v) => [u / Math.PI + 0.5, v / (Math.PI * 2)],
  )
  // close the seam in v
  const base = b.p.length / 3 - (nu + 1) * nv
  for (let i = 0; i < nu; i++) {
    const a0 = base + i * nv + (nv - 1)
    const a1 = base + (i + 1) * nv + (nv - 1)
    const b0 = base + i * nv
    const b1 = base + (i + 1) * nv
    b.idx.push(a0, a1, b1, a0, b1, b0)
  }
}

/* ---- the upper (two halves so the ankle opening can split them) ---- */
function buildUpper(): MeshData {
  const b = new Builder()
  const ts = range(280, (s) => 0.5 - 0.5 * Math.cos(Math.PI * s))
  const nV = 44
  for (const side of [0, 1]) {
    const base = b.p.length / 3
    for (const t of ts) {
      const phiMax = openingPhi(t) ?? Math.PI / 2
      for (let j = 0; j <= nV; j++) {
        const f = j / nV
        const phi = side === 0 ? phiMax * f : Math.PI - phiMax * f
        b.vert(upperPoint(t, phi), upperNormal(t, phi), t, phi / Math.PI)
      }
    }
    b.grid(base, ts.length, nV + 1)
  }
  return b.build()
}

/* ---- sole ---- */
function outline(s: number) {
  const ww = ((s % 1) + 1) % 1
  const t = 0.5 - 0.5 * Math.cos(2 * Math.PI * ww)
  const side = ww < 0.5 ? 1 : -1
  return { x: X(t), z: side * soleHalfWidth(t), t }
}
function outlineNormal(s: number): [number, number] {
  const d = 1e-4
  const a = outline(s - d)
  const c = outline(s + d)
  const dx = c.x - a.x
  const dz = c.z - a.z
  const l = Math.hypot(dx, dz) || 1
  return [-dz / l, dx / l]
}
function soleProfile(t: number): [number, number][] {
  const hs = soleTop(t)
  const ct = cageTop(t)
  const bot = MID_BOTTOM + archLift(t)
  return [
    [-0.035, ct],
    [0.0, ct - 0.004],
    [0.024, ct - 0.028],
    [0.036, (ct + hs) / 2 - 0.02],
    [0.046, hs - 0.04],
    [0.05, bot + (hs - bot) * 0.45],
    [0.044, bot + 0.03],
    [0.03, bot + 0.005],
    [0.0, bot],
    [-0.03, bot],
  ]
}
/** Angular sculpt grooves carved into the foam below the carbon cage (depth into the wall). */
function foamGroove(t: number, y: number) {
  const hs = soleTop(t)
  const cageLow = hs - 0.07
  const bot = MID_BOTTOM + archLift(t)
  const win = ss(bot + 0.02, bot + 0.045, y) * (1 - ss(cageLow - 0.035, cageLow - 0.015, y))
  const ph = Math.abs(((t * 14 - y * 6) % 1 + 1) % 1 - 0.5)
  const g = 1 - ss(0.02, 0.1, ph)
  return 0.012 * g * win
}
function solePoint(s: number, v: number): V3 {
  const o = outline(s)
  const [nx, nz] = outlineNormal(s)
  const [off0, y] = catmull2(soleProfile(o.t), v)
  const off = off0 - foamGroove(o.t, y)
  return bend([o.x + nx * off, y, o.z + nz * off])
}

function buildSoleWall(): MeshData {
  const b = new Builder()
  const ss_ = Array.from({ length: 720 }, (_, i) => i / 720)
  const vs = range(90, (v) => v)
  const base = b.p.length / 3
  const d = 1e-4
  for (const s of ss_) {
    for (const v of vs) {
      const p = solePoint(s, v)
      const ps = sub(solePoint(s + d, v), solePoint(s - d, v))
      const pv = sub(solePoint(s, Math.min(1, v + d)), solePoint(s, Math.max(0, v - d)))
      const n = norm(cross(pv, ps))
      // uv: (t along length, height above ground before bend)
      b.vert(p, n, outline(s).t, catmull2(soleProfile(outline(s).t), v)[1])
    }
  }
  b.grid(base, ss_.length, vs.length, false, true)
  return b.build()
}

/** Flat radial cap filling the sole outline at profile end `v` (0 top, 1 bottom). */
function buildSoleCap(v: number, up: boolean): MeshData {
  const b = new Builder()
  const N = 180
  const R = 14
  const c: V3 = [0.05, 0, 0]
  const base = b.p.length / 3
  for (let i = 0; i < N; i++) {
    const s = i / N
    const ring = solePoint(s, v)
    for (let r = 0; r <= R; r++) {
      const f = r / R
      const flat: V3 = [lerp(c[0], ring[0], f), 0, lerp(c[2], ring[2], f)]
      const t = clamp((flat[0] + SHOE_LENGTH / 2) / SHOE_LENGTH, 0, 1)
      const y = v === 0 ? soleTop(t) : MID_BOTTOM + archLift(t)
      const p = bend([flat[0], y, flat[2]])
      b.vert(p, up ? [0, 1, 0] : [0, -1, 0], flat[0], flat[2])
    }
  }
  b.grid(base, N, R + 1, false, true)
  return b.build()
}

/* ---- tongue ---- */
function tonguePoint(a: number, bb: number): V3 {
  const t = lerp(0.5, 0.3, a)
  const top = upperPoint(t, Math.PI / 2)
  let hw = 0.15 * (1 - 0.12 * a)
  if (a > 0.86) hw *= Math.sqrt(Math.max(0.0001, 1 - ((a - 0.86) / 0.14) ** 2))
  const lift = 0.27 * ss(0.3, 1.0, a)
  return [top[0] - 0.04 * a * a, top[1] + 0.012 + lift - 0.07 * bb * bb, bb * hw]
}
const TONGUE_THICK = 0.045
function buildTongue(): MeshData {
  const b = new Builder()
  // padded tongue: top skin plus an underside skin, joined by the rim tube
  for (const off of [0, -TONGUE_THICK]) {
    surface(
      b,
      (a, bb) => {
        const p = tonguePoint(clamp(a, 0, 1), clamp(bb, -1, 1))
        return [p[0], p[1] + off * ss(0.25, 0.45, a), p[2]]
      },
      range(60, (x) => x),
      range(24, (x) => x * 2 - 1),
      (a, bb) => [a, bb],
    )
  }
  return b.build()
}

/* ---- collar (padded rim around the ankle opening) ---- */
function collarLoop(): { pts: V3[]; nrm: V3[] } {
  const pts: V3[] = []
  const nrm: V3[] = []
  const M = 220
  for (let i = 0; i < M; i++) {
    const al = (i / M) * Math.PI * 2
    const t = clamp(OPEN_TC - OPEN_HT * Math.cos(al), 0.0005, 1)
    const r = OPEN_R * Math.abs(Math.sin(al))
    const pc = Math.acos(Math.pow(r, 1 / E_Z))
    const phi = Math.sin(al) >= 0 ? pc : Math.PI - pc
    const n = upperNormal(t, phi)
    pts.push(add(upperPoint(t, phi), scale(n, 0.008)))
    nrm.push(n)
  }
  return { pts, nrm }
}
function buildCollar(): MeshData {
  const b = new Builder()
  const { pts, nrm } = collarLoop()
  tube(b, pts, nrm, 0.036, 0.034, 14, true)
  return b.build()
}

/* ---- laces + glowing eyelets + pull tab ---- */
const EYE_PHI = Math.acos(Math.pow(0.4, 1 / E_Z))
const LACE_T = [0.5, 0.542, 0.584, 0.626, 0.668, 0.71]
const LACE_DT = 0.028

function buildLaces(): MeshData {
  const b = new Builder()
  LACE_T.forEach((t0, i) => {
    for (const strand of [0, 1]) {
      const pts: V3[] = []
      const nrm: V3[] = []
      const K = 28
      for (let k = 0; k <= K; k++) {
        const f = k / K
        const phi = lerp(EYE_PHI, Math.PI - EYE_PHI, f)
        const t = strand === 0 ? lerp(t0, t0 + LACE_DT, f) : lerp(t0 + LACE_DT, t0, f)
        const n = upperNormal(t, phi)
        const lift = 0.016 + 0.014 * Math.sin(Math.PI * f) + (strand === (i % 2) ? 0.009 : 0)
        pts.push(add(upperPoint(t, phi), scale(n, lift)))
        nrm.push(n)
      }
      tube(b, pts, nrm, 0.0075, 0.012, 8)
    }
  })
  return b.build()
}

function buildGlowTrim(): MeshData {
  const b = new Builder()
  // eyelet rings
  for (const t0 of LACE_T) {
    for (const t of [t0, t0 + LACE_DT]) {
      for (const phi of [EYE_PHI, Math.PI - EYE_PHI]) {
        const c = upperPoint(t, phi)
        const n = upperNormal(t, phi)
        const tu = norm(sub(upperPoint(t + 1e-3, phi), upperPoint(t - 1e-3, phi)))
        // small glowing clip riding on the eyestay, oriented along it
        const pos = add(c, scale(n, 0.012))
        const yaw = Math.atan2(-tu[2], tu[0])
        blob(b, pos, [0.02, 0.011, 0.012], 0.4, yaw, 8, 12)
      }
    }
  }
  return b.build()
}

/* ---- translucent green outsole pods ---- */
function buildPods(): MeshData {
  const b = new Builder()
  const place = (t: number, zf: number, len: number) => {
    const w = soleHalfWidth(t)
    const bot = MID_BOTTOM + archLift(t)
    // follow the footprint: yaw the pod along the outline tangent
    const dz = (soleHalfWidth(t + 0.01) - soleHalfWidth(t - 0.01)) * zf
    const yaw = -Math.atan2(dz, 0.02 * SHOE_LENGTH)
    const c = bend([X(t), bot * 0.55, zf * w * 0.5])
    blob(b, c, [len, bot * 0.55 + 0.012, w * 0.52], 0.6, yaw)
  }
  for (const t of [0.6, 0.7, 0.8]) for (const zf of [-1, 1]) place(t, zf, 0.13)
  buildToePod(b)
  for (const t of [0.07, 0.19]) for (const zf of [-1, 1]) place(t, zf, 0.15)
  return b.build()
}
function buildToePod(b: Builder) {
  const t = 0.9
  const w = soleHalfWidth(t)
  const c = bend([X(t), MID_BOTTOM * 0.55, 0])
  blob(b, c, [0.1, MID_BOTTOM * 0.55 + 0.012, w * 0.95], 0.6)
}

/* ---- glossy TPU shell parts: heel bumper + lateral heel clips ---- */
function buildShell(): MeshData {
  const b = new Builder()
  // chunky rounded heel bumper protruding from the back of the heel pod
  blob(b, bend([X(0) + 0.04, 0.18, 0]), [0.15, 0.12, 0.27], 0.7, 0, 20, 32)
  // glossy heel fin capping the collar peak
  const heelTop = upperPoint(0.003, Math.PI / 2)
  const tab: V3[] = []
  const tabN: V3[] = []
  for (let k = 0; k <= 10; k++) {
    const f = k / 10
    tab.push([heelTop[0] - 0.012 + 0.02 * f, heelTop[1] - 0.22 + 0.25 * f, 0])
    tabN.push([-1, 0.1, 0])
  }
  tube(b, tab, tabN, 0.016, 0.045, 12)
  // raked stabiliser clips moulded into both sides of the heel cage
  for (const zf of [-1, 1]) {
    const t = 0.13
    const w = soleHalfWidth(t)
    blob(b, bend([X(t), 0.3, zf * (w + 0.03)]), [0.3, 0.07, 0.04], 0.5, 0, 16, 24, -0.28)
  }
  return b.build()
}

/* ---- padded rim around the tongue edge ---- */
function buildTongueRim(): MeshData {
  const b = new Builder()
  const pts: V3[] = []
  const nrm: V3[] = []
  const a0 = 0.32
  const N = 40
  for (let k = 0; k <= N; k++) {
    const a = lerp(a0, 1, k / N)
    pts.push(add(tonguePoint(a, -1), [0, -TONGUE_THICK * 0.5 * ss(0.25, 0.45, a), 0]))
    nrm.push([0, 1, 0])
  }
  for (let k = 0; k <= N; k++) {
    const a = lerp(1, a0, k / N)
    pts.push(add(tonguePoint(a, 1), [0, -TONGUE_THICK * 0.5 * ss(0.25, 0.45, a), 0]))
    nrm.push([0, 1, 0])
  }
  tube(b, pts, nrm, 0.026, 0.024, 12)
  return b.build()
}

/* ------------------------------------------------------------------ */
export function buildShoe(): ShoePart[] {
  return [
    { part: Part.Upper, mesh: buildUpper() },
    { part: Part.SoleWall, mesh: buildSoleWall() },
    { part: Part.Insole, mesh: buildSoleCap(0, true) },
    { part: Part.Outsole, mesh: buildSoleCap(1, false) },
    { part: Part.Tongue, mesh: buildTongue() },
    { part: Part.Collar, mesh: buildCollar() },
    { part: Part.Collar, mesh: buildTongueRim() },
    { part: Part.Pod, mesh: buildPods() },
    { part: Part.Shell, mesh: buildShell() },
    { part: Part.Laces, mesh: buildLaces() },
    { part: Part.Glow, mesh: buildGlowTrim() },
  ]
}
