/**
 * Dependency-free WebGL2 renderer for the spinning CONDUIT hero sneaker.
 *
 * Frame pipeline:
 *   1. shadow-map depth pass from the key softbox (PCSS: blocker search + PCF)
 *   2. view-space normal/depth prepass → half-res SSAO → depth-aware blur
 *   3. HDR scene pass into an MSAA float target: reflection → floor → shoe
 *   4. resolve, half/quarter-res bloom, ACES tone map + grain, composite
 *
 * Usage: const stop = mountConduitHero(canvas, { onAzimuth }); …; stop()
 */
import { buildShoe, type MeshData, type PartId } from './geometry'
import {
  AO_BLUR_FS,
  BLUR_FS,
  BRIGHT_FS,
  COMPOSITE_FS,
  FLOOR_FS,
  FLOOR_VS,
  ND_FS,
  ND_VS,
  POST_VS,
  SHADOW_FS,
  SHADOW_VS,
  SHOE_FS,
  SHOE_VS,
  SSAO_FS,
} from './shaders'

type M4 = Float32Array

const m4 = {
  ident(): M4 {
    const m = new Float32Array(16)
    m[0] = m[5] = m[10] = m[15] = 1
    return m
  },
  mul(a: M4, b: M4): M4 {
    const o = new Float32Array(16)
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) {
        let s = 0
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
        o[c * 4 + r] = s
      }
    return o
  },
  persp(fovy: number, aspect: number, n: number, f: number): M4 {
    const t = 1 / Math.tan(fovy / 2)
    const m = new Float32Array(16)
    m[0] = t / aspect
    m[5] = t
    m[10] = (f + n) / (n - f)
    m[11] = -1
    m[14] = (2 * f * n) / (n - f)
    return m
  },
  ortho(l: number, r: number, b: number, t: number, n: number, f: number): M4 {
    const m = m4.ident()
    m[0] = 2 / (r - l)
    m[5] = 2 / (t - b)
    m[10] = -2 / (f - n)
    m[12] = -(r + l) / (r - l)
    m[13] = -(t + b) / (t - b)
    m[14] = -(f + n) / (f - n)
    return m
  },
  lookAt(e: number[], c: number[], up: number[]): M4 {
    const z = norm3([e[0] - c[0], e[1] - c[1], e[2] - c[2]])
    const x = norm3(cross3(up, z))
    const y = cross3(z, x)
    const m = m4.ident()
    m[0] = x[0]; m[4] = x[1]; m[8] = x[2]
    m[1] = y[0]; m[5] = y[1]; m[9] = y[2]
    m[2] = z[0]; m[6] = z[1]; m[10] = z[2]
    m[12] = -(x[0] * e[0] + x[1] * e[1] + x[2] * e[2])
    m[13] = -(y[0] * e[0] + y[1] * e[1] + y[2] * e[2])
    m[14] = -(z[0] * e[0] + z[1] * e[1] + z[2] * e[2])
    return m
  },
  rotY(a: number): M4 {
    const m = m4.ident()
    const c = Math.cos(a), s = Math.sin(a)
    m[0] = c; m[8] = s; m[2] = -s; m[10] = c
    return m
  },
  rotZ(a: number): M4 {
    const m = m4.ident()
    const c = Math.cos(a), s = Math.sin(a)
    m[0] = c; m[4] = -s; m[1] = s; m[5] = c
    return m
  },
  rotX(a: number): M4 {
    const m = m4.ident()
    const c = Math.cos(a), s = Math.sin(a)
    m[5] = c; m[9] = -s; m[6] = s; m[10] = c
    return m
  },
  trans(x: number, y: number, z: number): M4 {
    const m = m4.ident()
    m[12] = x; m[13] = y; m[14] = z
    return m
  },
  scale(x: number, y: number, z: number): M4 {
    const m = m4.ident()
    m[0] = x; m[5] = y; m[10] = z
    return m
  },
  normal3(m: M4): Float32Array {
    // model matrices here are rotation (+ uniform scale / mirror): upper 3×3, renormalised
    return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]])
  },
}
function cross3(a: number[], b: number[]) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function norm3(a: number[]) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s)
      gl.deleteShader(s)
      throw new Error('Shader compile failed: ' + log)
    }
    return s
  }
  const p = gl.createProgram()!
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs))
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link failed: ' + gl.getProgramInfoLog(p))
  const uniforms = new Map<string, WebGLUniformLocation | null>()
  const u = (name: string) => {
    if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(p, name))
    return uniforms.get(name)!
  }
  return { p, u }
}
type Program = ReturnType<typeof compile>

interface GpuMesh {
  vao: WebGLVertexArrayObject
  count: number
  part: PartId
}

function upload(gl: WebGL2RenderingContext, mesh: MeshData, part: PartId): GpuMesh {
  const vao = gl.createVertexArray()!
  gl.bindVertexArray(vao)
  const buf = (data: Float32Array, loc: number, size: number) => {
    const b = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, b)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0)
  }
  buf(mesh.positions, 0, 3)
  buf(mesh.normals, 1, 3)
  buf(mesh.uvs, 2, 2)
  const ib = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW)
  gl.bindVertexArray(null)
  return { vao, count: mesh.indices.length, part }
}

/* ---------- render targets ---------- */
interface Target {
  fb: WebGLFramebuffer
  tex: WebGLTexture
  w: number
  h: number
}

const SHADOW_SIZE = 2048
const KEY_DIR = norm3([-0.45, 0.85, 0.6]) // must match Ls[0] in SHOE_FS

export interface ConduitHeroOptions {
  /** called ~10×/s with the current heading in degrees (0–360) */
  onAzimuth?: (deg: number) => void
  /** called once the first frame has been drawn */
  onReady?: () => void
  /** called if WebGL2 is unavailable or the context is lost */
  onError?: (err: unknown) => void
  reducedMotion?: boolean
}

export function mountConduitHero(canvas: HTMLCanvasElement, opts: ConduitHeroOptions = {}): () => void {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true })
  if (!gl) {
    opts.onError?.(new Error('WebGL2 unavailable'))
    return () => {}
  }

  // HDR targets when the GPU can render to half-float; otherwise pre-expose into
  // sRGB-encoded 8-bit targets (the encoding keeps precision in the dark end).
  const hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))
  const PRE = hdr ? 1 : 0.5
  const colorFmt = hdr ? gl.RGBA16F : gl.SRGB8_ALPHA8
  const colorType = hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE
  const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number)

  let shoeProg: Program
  let floorProg: Program
  let shadowProg: Program
  let ndProg: Program
  let ssaoProg: Program
  let aoBlurProg: Program
  let brightProg: Program
  let blurProg: Program
  let compProg: Program
  let meshes: GpuMesh[]
  try {
    shoeProg = compile(gl, SHOE_VS, SHOE_FS)
    floorProg = compile(gl, FLOOR_VS, FLOOR_FS)
    shadowProg = compile(gl, SHADOW_VS, SHADOW_FS)
    ndProg = compile(gl, ND_VS, ND_FS)
    ssaoProg = compile(gl, POST_VS, SSAO_FS)
    aoBlurProg = compile(gl, POST_VS, AO_BLUR_FS)
    brightProg = compile(gl, POST_VS, BRIGHT_FS)
    blurProg = compile(gl, POST_VS, BLUR_FS)
    compProg = compile(gl, POST_VS, COMPOSITE_FS)
    meshes = buildShoe().map((s) => upload(gl, s.mesh, s.part))
  } catch (err) {
    opts.onError?.(err)
    return () => {}
  }

  // floor quad
  const floorVao = gl.createVertexArray()!
  gl.bindVertexArray(floorVao)
  const fb = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, fb)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-3, -3, 3, -3, 3, 3, -3, -3, 3, 3, -3, 3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
  // empty VAO for the full-screen triangle (vertices come from gl_VertexID)
  const postVao = gl.createVertexArray()!

  /* ---------- shadow map ---------- */
  const shadowTex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, shadowTex)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  // Two sampler objects over the same depth texture: one does the hardware
  // compare (PCF taps), the other returns raw depth (PCSS blocker search).
  const cmpSampler = gl.createSampler()!
  gl.samplerParameteri(cmpSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.samplerParameteri(cmpSampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.samplerParameteri(cmpSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.samplerParameteri(cmpSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.samplerParameteri(cmpSampler, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE)
  gl.samplerParameteri(cmpSampler, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL)
  const rawSampler = gl.createSampler()!
  gl.samplerParameteri(rawSampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.samplerParameteri(rawSampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.samplerParameteri(rawSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.samplerParameteri(rawSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const shadowFb = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTex, 0)
  gl.drawBuffers([gl.NONE])
  gl.readBuffer(gl.NONE)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.bindTexture(gl.TEXTURE_2D, null)

  const lightView = m4.lookAt([KEY_DIR[0] * 6, 0.5 + KEY_DIR[1] * 6, KEY_DIR[2] * 6], [0, 0.5, 0], [0, 1, 0])
  const lightVP = m4.mul(m4.ortho(-2.1, 2.1, -2.1, 2.1, 0.5, 12), lightView)

  /* ---------- scene + post targets (rebuilt on resize) ---------- */
  let msaaFb: WebGLFramebuffer | null = null
  let msaaColor: WebGLRenderbuffer | null = null
  let msaaDepth: WebGLRenderbuffer | null = null
  let scene: Target | null = null
  let bloomA: Target | null = null
  let bloomB: Target | null = null
  let wideA: Target | null = null
  let wideB: Target | null = null
  let nd: Target | null = null
  let ndDepth: WebGLRenderbuffer | null = null
  let aoA: Target | null = null
  let aoB: Target | null = null
  // SSAO needs a float normal/depth target; without it the AO term is skipped
  const aoOn = hdr

  const makeTarget = (w: number, h: number, fmt: number = colorFmt, type: number = colorType): Target => {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, type, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, null)
    return { fb, tex, w, h }
  }
  const freeTarget = (t: Target | null) => {
    if (!t) return
    gl.deleteFramebuffer(t.fb)
    gl.deleteTexture(t.tex)
  }
  const freeTargets = () => {
    if (msaaFb) gl.deleteFramebuffer(msaaFb)
    if (msaaColor) gl.deleteRenderbuffer(msaaColor)
    if (msaaDepth) gl.deleteRenderbuffer(msaaDepth)
    msaaFb = msaaColor = msaaDepth = null
    freeTarget(scene); freeTarget(bloomA); freeTarget(bloomB); freeTarget(wideA); freeTarget(wideB)
    freeTarget(nd); freeTarget(aoA); freeTarget(aoB)
    if (ndDepth) gl.deleteRenderbuffer(ndDepth)
    scene = bloomA = bloomB = wideA = wideB = nd = aoA = aoB = null
    ndDepth = null
  }
  const buildTargets = (w: number, h: number) => {
    freeTargets()
    msaaColor = gl.createRenderbuffer()!
    gl.bindRenderbuffer(gl.RENDERBUFFER, msaaColor)
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, colorFmt, w, h)
    msaaDepth = gl.createRenderbuffer()!
    gl.bindRenderbuffer(gl.RENDERBUFFER, msaaDepth)
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h)
    gl.bindRenderbuffer(gl.RENDERBUFFER, null)
    msaaFb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFb)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msaaColor)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, msaaDepth)
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (!ok) throw new Error('MSAA framebuffer incomplete')
    scene = makeTarget(w, h)
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1)
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2)
    bloomA = makeTarget(hw, hh)
    bloomB = makeTarget(hw, hh)
    wideA = makeTarget(qw, qh)
    wideB = makeTarget(qw, qh)
    if (aoOn) {
      nd = makeTarget(w, h, gl.RGBA16F, gl.HALF_FLOAT)
      gl.bindFramebuffer(gl.FRAMEBUFFER, nd.fb)
      ndDepth = gl.createRenderbuffer()!
      gl.bindRenderbuffer(gl.RENDERBUFFER, ndDepth)
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, ndDepth)
      gl.bindRenderbuffer(gl.RENDERBUFFER, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      aoA = makeTarget(hw, hh, gl.RGBA8, gl.UNSIGNED_BYTE)
      aoB = makeTarget(hw, hh, gl.RGBA8, gl.UNSIGNED_BYTE)
    }
  }

  const reduced = !!opts.reducedMotion
  const BASE_SPEED = reduced ? 0 : 0.42 // rad/s
  let yaw = reduced ? -0.55 : -2.2
  let vel = reduced ? 0 : 5.5 // intro whip-spin
  let dragging = false
  let lastX = 0
  let lastMoveT = 0
  let dragVel = 0
  let raf = 0
  let running = false
  let visible = true
  let disposed = false
  let lastT = performance.now()
  const t0 = lastT
  let lastAz = 0
  let ready = false

  /* ---------- sizing ---------- */
  let W = 1, H = 1
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const r = canvas.getBoundingClientRect()
    W = Math.max(1, Math.round(r.width * dpr))
    H = Math.max(1, Math.round(r.height * dpr))
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W
      canvas.height = H
    }
    if (!scene || scene.w !== W || scene.h !== H) {
      try {
        buildTargets(W, H)
      } catch (err) {
        opts.onError?.(err)
        return
      }
    }
    if (!running) draw(performance.now())
  }
  const ro = new ResizeObserver(resize)
  ro.observe(canvas)

  /* ---------- interaction ---------- */
  const onDown = (e: PointerEvent) => {
    dragging = true
    lastX = e.clientX
    lastMoveT = performance.now()
    dragVel = 0
    canvas.setPointerCapture(e.pointerId)
    canvas.style.cursor = 'grabbing'
  }
  const onMove = (e: PointerEvent) => {
    if (!dragging) return
    const now = performance.now()
    const dx = e.clientX - lastX
    const dt = Math.max(1, now - lastMoveT) / 1000
    const w = canvas.getBoundingClientRect().width || 1
    const dYaw = (dx / w) * Math.PI * 2.2
    yaw += dYaw
    dragVel = dragVel * 0.6 + (dYaw / dt) * 0.4
    lastX = e.clientX
    lastMoveT = now
    if (!running) draw(now)
  }
  const onUp = (e: PointerEvent) => {
    if (!dragging) return
    dragging = false
    vel = Math.max(-9, Math.min(9, dragVel))
    try { canvas.releasePointerCapture(e.pointerId) } catch { /* noop */ }
    canvas.style.cursor = 'grab'
    start()
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  canvas.style.cursor = 'grab'
  canvas.style.touchAction = 'pan-y'

  /* ---------- visibility ---------- */
  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible) start()
  })
  io.observe(canvas)
  const onVis = () => { if (!document.hidden) start() }
  document.addEventListener('visibilitychange', onVis)

  const onLost = (e: Event) => {
    e.preventDefault()
    stop()
    opts.onError?.(new Error('WebGL context lost'))
  }
  canvas.addEventListener('webglcontextlost', onLost)

  /* ---------- render ---------- */
  const blit = (prog: Program, dst: Target | null, w: number, h: number, bind: () => void) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null)
    gl.viewport(0, 0, w, h)
    gl.useProgram(prog.p)
    bind()
    gl.bindVertexArray(postVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  const bindTex = (unit: number, tex: WebGLTexture | null) => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
  }

  function draw(now: number) {
    if (!gl || disposed || !scene || !msaaFb) return
    const dt = Math.min(0.05, (now - lastT) / 1000)
    lastT = now
    const time = (now - t0) / 1000

    if (!dragging) {
      vel += (BASE_SPEED - vel) * (1 - Math.exp(-dt * 1.6))
      yaw += vel * dt
    }

    const aspect = W / H
    const fov = (30 * Math.PI) / 180
    const halfV = 1.2
    const dist = Math.max(halfV / Math.tan(fov / 2), 1.75 / (Math.tan(fov / 2) * aspect))
    const pitch = 0.2
    const target = [0, 0.52, 0]
    const eye = [0, target[1] + Math.sin(pitch) * dist, Math.cos(pitch) * dist]
    const view = m4.lookAt(eye, target, [0, 1, 0])
    const proj = m4.persp(fov, aspect, 0.1, 50)
    const vp = m4.mul(proj, view)

    const bob = reduced ? 0 : Math.sin(time * 1.15) * 0.045
    const lift = 0.24 + bob
    const intro = reduced ? 1 : 1 - Math.exp(-time * 2.2)
    const s = 0.9 + 0.1 * intro
    const model = m4.mul(
      m4.trans(0, lift, 0),
      m4.mul(
        m4.rotY(yaw),
        m4.mul(
          m4.rotZ(-0.05 + (reduced ? 0 : Math.sin(time * 0.7) * 0.03)),
          m4.mul(m4.rotX(reduced ? 0 : Math.sin(time * 0.9) * 0.02), m4.scale(s, s, s)),
        ),
      ),
    )
    const mirror = m4.mul(m4.scale(1, -1, 1), model)

    // scan sweep every 7s
    const phase = time % 7
    const scan = reduced ? -10 : phase < 2.4 ? -0.05 + (phase / 2.4) * 1.3 : -10

    gl.disable(gl.CULL_FACE)
    gl.disable(gl.SCISSOR_TEST)

    /* 1. shadow depth pass */
    bindTex(0, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFb)
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE)
    gl.enable(gl.DEPTH_TEST)
    gl.depthMask(true)
    gl.disable(gl.BLEND)
    gl.clear(gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.POLYGON_OFFSET_FILL)
    gl.polygonOffset(1.5, 2.0)
    gl.useProgram(shadowProg.p)
    gl.uniformMatrix4fv(shadowProg.u('uModel'), false, model)
    gl.uniformMatrix4fv(shadowProg.u('uLightVP'), false, lightVP)
    for (const mesh of meshes) {
      gl.bindVertexArray(mesh.vao)
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0)
    }
    gl.disable(gl.POLYGON_OFFSET_FILL)

    /* 2. normal/depth prepass → SSAO */
    if (aoOn && nd && aoA && aoB) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, nd.fb)
      gl.viewport(0, 0, W, H)
      gl.clearColor(0, 0, 0, 1) // +z = "no geometry"
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.useProgram(ndProg.p)
      gl.uniformMatrix4fv(ndProg.u('uModel'), false, model)
      gl.uniformMatrix4fv(ndProg.u('uView'), false, view)
      gl.uniformMatrix4fv(ndProg.u('uViewProj'), false, vp)
      gl.uniformMatrix3fv(ndProg.u('uNrmMat'), false, m4.normal3(model))
      for (const mesh of meshes) {
        gl.bindVertexArray(mesh.vao)
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0)
      }
      gl.disable(gl.DEPTH_TEST)
      const tanH = Math.tan(fov / 2)
      blit(ssaoProg, aoA, aoA.w, aoA.h, () => {
        bindTex(0, nd!.tex)
        gl.uniform1i(ssaoProg.u('uND'), 0)
        gl.uniformMatrix4fv(ssaoProg.u('uProj'), false, proj)
        gl.uniform2f(ssaoProg.u('uProjScale'), tanH * aspect, tanH)
        gl.uniform1f(ssaoProg.u('uRadius'), 0.16)
      })
      blit(aoBlurProg, aoB, aoB.w, aoB.h, () => {
        bindTex(0, aoA!.tex)
        bindTex(1, nd!.tex)
        gl.uniform1i(aoBlurProg.u('uAO'), 0)
        gl.uniform1i(aoBlurProg.u('uND'), 1)
        gl.uniform2f(aoBlurProg.u('uTexel'), 1 / aoB!.w, 1 / aoB!.h)
      })
      bindTex(1, null)
    }

    /* 3. HDR scene pass */
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaaFb)
    gl.viewport(0, 0, W, H)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    bindTex(0, shadowTex)
    gl.bindSampler(0, cmpSampler)
    bindTex(1, shadowTex)
    gl.bindSampler(1, rawSampler)
    bindTex(2, aoOn && aoB ? aoB.tex : null)

    const drawShoe = (m: M4, isMirror: boolean) => {
      gl.useProgram(shoeProg.p)
      gl.uniformMatrix4fv(shoeProg.u('uModel'), false, m)
      gl.uniformMatrix4fv(shoeProg.u('uViewProj'), false, vp)
      gl.uniformMatrix4fv(shoeProg.u('uLightVP'), false, lightVP)
      gl.uniformMatrix3fv(shoeProg.u('uNrmMat'), false, m4.normal3(m))
      gl.uniform3f(shoeProg.u('uCam'), eye[0], eye[1], eye[2])
      gl.uniform1f(shoeProg.u('uTime'), time)
      gl.uniform1f(shoeProg.u('uScan'), isMirror ? -10 : scan)
      gl.uniform1f(shoeProg.u('uMirror'), isMirror ? 1 : 0)
      gl.uniform1f(shoeProg.u('uPre'), PRE)
      gl.uniform1i(shoeProg.u('uShadow'), 0)
      gl.uniform1i(shoeProg.u('uShadowRaw'), 1)
      gl.uniform1i(shoeProg.u('uAO'), 2)
      gl.uniform2f(shoeProg.u('uRes'), W, H)
      gl.uniform1f(shoeProg.u('uAOOn'), aoOn && !isMirror ? 1 : 0)
      gl.uniform1f(shoeProg.u('uShadowTexel'), 1 / SHADOW_SIZE)
      for (const mesh of meshes) {
        gl.uniform1i(shoeProg.u('uPart'), mesh.part)
        gl.bindVertexArray(mesh.vao)
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0)
      }
    }

    // 3a. reflection
    gl.enable(gl.DEPTH_TEST)
    drawShoe(mirror, true)
    // 3b. floor: cast shadow, contact occlusion, HUD
    gl.disable(gl.DEPTH_TEST)
    gl.useProgram(floorProg.p)
    gl.uniformMatrix4fv(floorProg.u('uViewProj'), false, vp)
    gl.uniformMatrix4fv(floorProg.u('uLightVP'), false, lightVP)
    gl.uniform1f(floorProg.u('uYaw'), yaw)
    gl.uniform1f(floorProg.u('uTime'), time)
    gl.uniform1f(floorProg.u('uLift'), lift - 0.2)
    gl.uniform1f(floorProg.u('uPre'), PRE)
    gl.uniform1i(floorProg.u('uShadow'), 0)
    gl.uniform1i(floorProg.u('uShadowRaw'), 1)
    gl.uniform1f(floorProg.u('uShadowTexel'), 1 / SHADOW_SIZE)
    gl.bindVertexArray(floorVao)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    // 3c. the shoe
    gl.enable(gl.DEPTH_TEST)
    gl.clear(gl.DEPTH_BUFFER_BIT)
    drawShoe(model, false)
    gl.bindVertexArray(null)

    gl.bindSampler(0, null)
    gl.bindSampler(1, null)
    bindTex(2, null); bindTex(1, null)

    /* 4. resolve MSAA → scene texture */
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaaFb)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, scene.fb)
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST)

    /* 5. bloom */
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    const bA = bloomA!, bB = bloomB!, wA = wideA!, wB = wideB!
    blit(brightProg, bA, bA.w, bA.h, () => {
      bindTex(0, scene!.tex)
      gl.uniform1i(brightProg.u('uTex'), 0)
      gl.uniform2f(brightProg.u('uTexel'), 1 / W, 1 / H)
      gl.uniform1f(brightProg.u('uInvPre'), 1 / PRE)
      gl.uniform1f(brightProg.u('uThreshold'), 0.9)
    })
    const blur = (src: Target, dst: Target, dx: number, dy: number) =>
      blit(blurProg, dst, dst.w, dst.h, () => {
        bindTex(0, src.tex)
        gl.uniform1i(blurProg.u('uTex'), 0)
        gl.uniform2f(blurProg.u('uDir'), dx / src.w, dy / src.h)
      })
    blur(bA, bB, 1, 0)
    blur(bB, bA, 0, 1)
    // wide halo: quarter res, blurred twice more
    blur(bA, wA, 1, 0)
    blur(wA, wB, 0, 1)
    blur(wB, wA, 1.5, 0)
    blur(wA, wB, 0, 1.5)

    /* 6. composite to the canvas */
    blit(compProg, null, W, H, () => {
      bindTex(0, scene!.tex)
      bindTex(1, bA.tex)
      bindTex(2, wB.tex)
      gl.uniform1i(compProg.u('uScene'), 0)
      gl.uniform1i(compProg.u('uBloom'), 1)
      gl.uniform1i(compProg.u('uBloomWide'), 2)
      gl.uniform1f(compProg.u('uInvPre'), 1 / PRE)
      gl.uniform1f(compProg.u('uTime'), time)
      gl.uniform2f(compProg.u('uRes'), W, H)
    })
    gl.bindVertexArray(null)
    bindTex(2, null); bindTex(1, null); bindTex(0, null)

    if (now - lastAz > 100) {
      lastAz = now
      const deg = (((yaw * 180) / Math.PI) % 360 + 360) % 360
      opts.onAzimuth?.(deg)
    }
    if (!ready) {
      ready = true
      opts.onReady?.()
    }
  }

  function frame(now: number) {
    if (!running) return
    draw(now)
    const settled = reduced && Math.abs(vel) < 0.002 && !dragging
    if (!visible || document.hidden || settled) {
      running = false
      return
    }
    raf = requestAnimationFrame(frame)
  }
  function start() {
    if (running || disposed) return
    running = true
    lastT = performance.now()
    raf = requestAnimationFrame(frame)
  }
  function stop() {
    running = false
    cancelAnimationFrame(raf)
  }

  resize()
  start()

  return () => {
    disposed = true
    stop()
    ro.disconnect()
    io.disconnect()
    document.removeEventListener('visibilitychange', onVis)
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointercancel', onUp)
    canvas.removeEventListener('webglcontextlost', onLost)
    // Free GPU resources but keep the context alive: React StrictMode re-mounts
    // on the same <canvas>, and a lost context can't be re-acquired.
    for (const m of meshes) gl.deleteVertexArray(m.vao)
    gl.deleteVertexArray(floorVao)
    gl.deleteVertexArray(postVao)
    gl.deleteFramebuffer(shadowFb)
    gl.deleteTexture(shadowTex)
    gl.deleteSampler(cmpSampler)
    gl.deleteSampler(rawSampler)
    freeTargets()
    for (const p of [shoeProg, floorProg, shadowProg, ndProg, ssaoProg, aoBlurProg, brightProg, blurProg, compProg]) gl.deleteProgram(p.p)
  }
}
