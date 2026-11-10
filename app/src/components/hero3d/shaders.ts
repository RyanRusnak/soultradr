/* GLSL ES 3.00 shaders for the CONDUIT hero. */

/* ------------------------------------------------------------------ *
 * shared GLSL fragments
 * ------------------------------------------------------------------ */
const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + 1.0), f.x), f.y);
}
float fbm(vec2 p) {
  return vnoise(p) * 0.5 + vnoise(p * 2.03 + 7.1) * 0.25 + vnoise(p * 4.11 + 3.7) * 0.125;
}
float worley(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d = 1.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = vec2(hash12(i + g), hash12(i + g + 19.7));
      d = min(d, length(g + o - f));
    }
  return d;
}
`

const SHADOW = /* glsl */ `
uniform mat4 uLightVP;
uniform sampler2DShadow uShadow;
uniform sampler2D uShadowRaw;
uniform float uShadowTexel;
// Percentage-closer soft shadows: blocker search sets the penumbra width, so
// contact points stay crisp while shadows from the collar / tongue go soft.
float shadowLookup(vec3 wp, vec3 n, float minR, float maxR, float half_) {
  vec4 sp = uLightVP * vec4(wp + n * 0.012, 1.0);
  vec3 p = sp.xyz / sp.w * 0.5 + 0.5;
  if (p.z >= 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;
  vec2 taps[12];
  taps[0] = vec2(-0.326, -0.406); taps[1] = vec2(-0.840, -0.074); taps[2] = vec2(-0.696, 0.457);
  taps[3] = vec2(-0.203, 0.621);  taps[4] = vec2(0.962, -0.195);  taps[5] = vec2(0.473, -0.480);
  taps[6] = vec2(0.519, 0.767);   taps[7] = vec2(0.185, -0.893);  taps[8] = vec2(0.507, 0.064);
  taps[9] = vec2(0.896, 0.412);   taps[10] = vec2(-0.322, -0.933); taps[11] = vec2(-0.792, -0.598);
  float searchR = uShadowTexel * 16.0;
  float blockers = 0.0, sum = 0.0;
  for (int i = 0; i < 12; i++) {
    float d = texture(uShadowRaw, p.xy + taps[i] * searchR).r;
    if (d < p.z - 0.0015) { sum += d; blockers += 1.0; }
  }
  if (blockers < 0.5) return 1.0;
  float pen = (p.z - sum / blockers) * 520.0; // texels of penumbra
  float r = clamp(pen, minR, maxR);
  float step_ = uShadowTexel * r / half_;
  float s = 0.0, w = 0.0;
  for (int y = -3; y <= 3; y++)
    for (int x = -3; x <= 3; x++) {
      if (abs(float(x)) > half_ || abs(float(y)) > half_) continue;
      s += texture(uShadow, vec3(p.xy + vec2(float(x), float(y)) * step_, p.z - 0.0012));
      w += 1.0;
    }
  return s / w;
}
`

/* ------------------------------------------------------------------ *
 * view-space normal + depth prepass (feeds SSAO)
 * ------------------------------------------------------------------ */
export const ND_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uViewProj;
uniform mat3 uNrmMat;
out vec3 vVP;
out vec3 vVN;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vVP = (uView * w).xyz;
  vVN = mat3(uView) * (uNrmMat * aNrm);
  gl_Position = uViewProj * w;
}
`
export const ND_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vVP;
in vec3 vVN;
out vec4 outColor;
void main() {
  vec3 N = normalize(vVN);
  vec3 ng = normalize(cross(dFdx(vVP), dFdy(vVP)));
  if (dot(ng, -vVP) < 0.0) ng = -ng;
  if (dot(N, ng) < 0.0) N = -N;
  outColor = vec4(N, vVP.z);
}
`

/* ------------------------------------------------------------------ *
 * SSAO (half res) + depth-aware blur
 * ------------------------------------------------------------------ */
export const SSAO_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uND;
uniform mat4 uProj;
uniform vec2 uProjScale;
uniform float uRadius;
out vec4 outColor;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec4 nd = texture(uND, vUv);
  if (nd.w >= 0.0) { outColor = vec4(1.0); return; }
  vec3 P = vec3((vUv * 2.0 - 1.0) * uProjScale * -nd.w, nd.w);
  vec3 N = normalize(nd.xyz);
  float ang = hash12(gl_FragCoord.xy) * 6.2831853;
  vec3 rv = vec3(cos(ang), sin(ang), 0.37);
  vec3 T = normalize(rv - N * dot(rv, N));
  vec3 B = cross(N, T);
  float occ = 0.0;
  const int K = 16;
  for (int i = 0; i < K; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(K));
    float a = fi * 2.399963;
    vec3 s = vec3(cos(a) * r, sin(a) * r, sqrt(max(0.0, 1.0 - r * r)) * 0.8 + 0.2);
    float sc = fi / float(K);
    s = normalize(s) * mix(0.12, 1.0, sc * sc);
    vec3 sp = P + (T * s.x + B * s.y + N * s.z) * uRadius;
    vec4 cp = uProj * vec4(sp, 1.0);
    vec2 suv = cp.xy / cp.w * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
    float sz = texture(uND, suv).w;
    if (sz >= 0.0) continue;
    float range = smoothstep(0.0, 1.0, uRadius / abs(P.z - sz));
    occ += (sz >= sp.z + 0.003 ? 1.0 : 0.0) * range;
  }
  outColor = vec4(vec3(1.0 - occ / float(K)), 1.0);
}
`
export const AO_BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uAO;
uniform sampler2D uND;
uniform vec2 uTexel;
out vec4 outColor;
void main() {
  float zc = texture(uND, vUv).w;
  if (zc >= 0.0) { outColor = vec4(1.0); return; }
  float s = 0.0, w = 0.0;
  for (int y = -2; y <= 2; y++)
    for (int x = -2; x <= 2; x++) {
      vec2 uv = vUv + vec2(float(x), float(y)) * uTexel;
      float z = texture(uND, uv).w;
      float wt = z < 0.0 && abs(z - zc) < 0.06 ? 1.0 : 0.0;
      s += texture(uAO, uv).r * wt;
      w += wt;
    }
  outColor = vec4(vec3(w > 0.0 ? s / w : 1.0), 1.0);
}
`

/* ------------------------------------------------------------------ *
 * shadow-map depth pass
 * ------------------------------------------------------------------ */
export const SHADOW_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
uniform mat4 uModel;
uniform mat4 uLightVP;
void main() { gl_Position = uLightVP * uModel * vec4(aPos, 1.0); }
`
export const SHADOW_FS = /* glsl */ `#version 300 es
precision mediump float;
void main() {}
`

/* ------------------------------------------------------------------ *
 * the shoe
 * ------------------------------------------------------------------ */
export const SHOE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
layout(location = 2) in vec2 aUv;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat3 uNrmMat;
out vec3 vWorld;
out vec3 vN;
out vec2 vUv;
out vec3 vLocal;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vN = uNrmMat * aNrm;
  vUv = aUv;
  vLocal = aPos;
  gl_Position = uViewProj * w;
}
`

export const SHOE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec3 vWorld;
in vec3 vN;
in vec2 vUv;
in vec3 vLocal;
uniform int uPart;
uniform vec3 uCam;
uniform float uTime;
uniform float uScan;
uniform float uMirror;
uniform float uPre;
uniform sampler2D uAO;
uniform vec2 uRes;
uniform float uAOOn;
out vec4 outColor;

const float PI = 3.14159265;
const vec3 EMERALD = vec3(0.063, 0.725, 0.506);
const vec3 EMERALD_HOT = vec3(0.35, 1.0, 0.72);
const vec3 CYAN = vec3(0.0, 0.94, 1.0);

${NOISE}
${SHADOW}

float aaLine(float d, float w) {
  float fw = max(fwidth(d), 1e-5);
  return 1.0 - smoothstep(w - fw, w + fw, abs(d));
}
float band(float x, float a, float b) {
  float fw = max(fwidth(x), 1e-5);
  return smoothstep(a - fw, a + fw, x) * (1.0 - smoothstep(b - fw, b + fw, x));
}
float sstep(float a, float b, float x) { return smoothstep(a, b, x); }
vec2 P(float t, float h) { return vec2(t * 2.8, h * 0.9); }

// signed distance to a quad (Inigo Quilez polygon SDF)
float sdQuad(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  vec2 v[4];
  v[0] = a; v[1] = b; v[2] = c; v[3] = d;
  float dist = dot(p - v[0], p - v[0]);
  float sgn = 1.0;
  for (int i = 0; i < 4; i++) {
    int j = (i + 3) % 4;
    vec2 e = v[j] - v[i];
    vec2 w = p - v[i];
    vec2 bb = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    dist = min(dist, dot(bb, bb));
    bool c1 = p.y >= v[i].y;
    bool c2 = p.y < v[j].y;
    bool c3 = e.x * w.y > e.y * w.x;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) sgn = -sgn;
  }
  return sgn * sqrt(dist);
}

// distance from a hex-cell edge (0 on the edge, ~0.5 at the centre)
float hexEdge(vec2 p) {
  vec2 r = vec2(1.0, 1.7320508);
  vec2 hh = r * 0.5;
  vec2 a = mod(p, r) - hh;
  vec2 b = mod(p - hh, r) - hh;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  vec2 q = abs(g);
  return 0.5 - max(q.x * 0.5 + q.y * 0.8660254, q.x);
}

// 2x2 twill weave, returns 0..1 fibre brightness
float carbon(vec2 p) {
  vec2 c = floor(p);
  vec2 f = fract(p);
  float chk = mod(c.x + c.y, 2.0);
  float fib = chk > 0.5 ? sin(f.x * PI) : sin(f.y * PI);
  return mix(0.35, 1.0, fib) * (chk > 0.5 ? 1.0 : 0.7);
}

/* ---------- upper panel layout (shared by colour + height) ---------- */
struct Upper {
  vec2 q;
  float h;
  float panel;   // signed distance to nearest glossy overlay (negative inside)
  float winH;    // heel window
  float midI;    // mid window
  float toeB;
};
Upper upperLayout(vec2 uv) {
  Upper u;
  float t = uv.x;
  float v = uv.y;
  u.h = 1.0 - abs(1.0 - 2.0 * v);
  u.q = vec2(t * 2.8, u.h * 0.9);
  vec2 q = u.q;
  float h = u.h;
  float dHeel = sdQuad(q, P(0.0, -0.1), P(0.345, -0.1), P(0.15, 0.9), P(-0.1, 1.05));
  u.winH = sdQuad(q, P(0.03, 0.58), P(0.19, 0.53), P(0.14, 0.3), P(0.06, 0.25));
  float dMidO = sdQuad(q, P(0.35, 0.7), P(0.55, 0.7), P(0.51, 0.34), P(0.39, 0.38));
  u.midI = dMidO + 0.04;
  u.toeB = 0.1 + 0.9 * abs(t - 0.82);
  float dToe = (abs(h - u.toeB - 0.06) - 0.05) * 0.9 * step(0.6, t) + (1.0 - step(0.6, t)) * 1.0;
  float dMud = (h - 0.11) * 0.9;
  float dEye = max(abs(h - 0.8) * 0.9 - 0.055, max(0.44 - t, t - 0.745) * 2.8);
  float panel = min(min(dHeel, dToe), min(dMud, dEye));
  panel = min(panel, max(dMidO, -u.midI));
  panel = max(panel, -u.winH);
  u.panel = panel;
  return u;
}

/* ---------- procedural height fields (drive the bump normals) ---------- */
float upperHeight(vec2 uv) {
  Upper u = upperLayout(uv);
  float onPanel = 1.0 - smoothstep(-0.003, 0.003, u.panel);
  float inWin = clamp((1.0 - smoothstep(-0.003, 0.003, u.winH)) + (1.0 - smoothstep(-0.003, 0.003, u.midI)), 0.0, 1.0);
  // engineered knit: each hex cell is a soft yarn bump
  float knit = smoothstep(0.0, 0.3, hexEdge(u.q * 62.0));
  float fuzz = vnoise(u.q * 420.0);
  float hgt = (0.32 * knit + 0.07 * fuzz) * (1.0 - onPanel);
  // glossy TPU overlays: raised, with a fine leather-like grain
  hgt += 1.0 * onPanel + 0.09 * fbm(u.q * 160.0) * onPanel;
  // recessed mesh windows
  hgt -= 0.6 * inWin;
  // raised welt / stitch line running just outside every panel edge
  float sd = u.panel - 0.012;
  float stitch = (1.0 - smoothstep(0.0, 0.0035, abs(sd))) * (0.55 + 0.45 * sin((u.q.x + u.q.y) * 2.0 * PI * 70.0));
  hgt += 0.35 * stitch;
  return hgt;
}
float soleHeight(vec2 uv) {
  float t = uv.x, y = uv.y;
  float hsT = 0.43 - 0.15 * sstep(0.2, 0.8, t);
  float cageLow = hsT - 0.07;
  float cage = smoothstep(cageLow - 0.004, cageLow + 0.004, y);
  float cw = carbon(vec2(t * 2.8, y) * 75.0);
  // foam: closed-cell texture + angular sculpt grooves
  float cells = 1.0 - worley(vec2(t * 2.8, y) * 48.0);
  float foam = 0.18 * cells * cells + 0.03 * vnoise(vec2(t * 2.8, y) * 300.0);
  return mix(foam, 0.12 * (cw - 0.5) + 0.35, cage);
}
float outsoleHeight(vec2 uv) {
  // hexagonal lugs on the bottom, with a bit of rubber grit
  float lug = smoothstep(0.06, 0.16, hexEdge(uv * 9.0));
  return lug + 0.08 * vnoise(uv * 180.0);
}
float laceHeight(vec2 uv) {
  float w = sin(uv.x * 160.0) * sin(uv.y * 2.0 * PI * 2.0);
  return 0.5 + 0.5 * w;
}
float fabricHeight(vec2 uv, float s) {
  return 0.6 * vnoise(uv * s) + 0.3 * vnoise(uv * s * 2.7 + 3.1);
}
float tongueHeight(vec2 uv) {
  // quilted padding + fine textile
  float quilt = 1.0 - smoothstep(0.0, 0.08, abs(fract(uv.x * 9.0) - 0.5));
  return 0.35 * fabricHeight(uv * vec2(1.0, 0.6), 120.0) - 0.5 * quilt;
}
float height(vec2 uv) {
  if (uPart == 0) return upperHeight(uv);
  if (uPart == 1) return soleHeight(uv);
  if (uPart == 3) return outsoleHeight(uv);
  if (uPart == 4) return laceHeight(uv);
  if (uPart == 5) return fabricHeight(uv * vec2(6.0, 1.0), 90.0);
  if (uPart == 6) return tongueHeight(uv);
  if (uPart == 8) return 0.3 * vnoise(uv * 60.0);
  return 0.0;
}

// Mikkelsen-style surface-gradient bump mapping: no tangents required.
vec3 bumpNormal(vec3 N, vec3 Pw, vec2 uv, float scale) {
  vec2 dUVdx = dFdx(uv), dUVdy = dFdy(uv);
  vec2 e = max(max(abs(dUVdx), abs(dUVdy)) * 0.9, vec2(2e-5));
  float h0 = height(uv);
  float hx = height(uv + vec2(e.x, 0.0));
  float hy = height(uv + vec2(0.0, e.y));
  vec2 dh = vec2((hx - h0) / e.x, (hy - h0) / e.y);
  float dhdx = dot(dh, dUVdx);
  float dhdy = dot(dh, dUVdy);
  vec3 dpdx = dFdx(Pw), dpdy = dFdy(Pw);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * N - scale * grad);
}

/* ---------- studio environment ---------- */
// Specular environment: overhead softbox, two strips, dark floor with emerald bounce.
vec3 env(vec3 d, float r) {
  float up = d.y;
  vec3 c = mix(vec3(0.004, 0.0045, 0.005), vec3(0.028, 0.03, 0.034), sstep(-0.3, 0.8, up));
  float soft = 0.05 + r * 0.4;
  float peak = mix(1.0, 0.16, r);
  float az = atan(d.x, d.z);
  // 1.2m softbox above-front-left (matches key light)
  float box = sstep(0.62 - soft, 0.74 + soft * 0.3, up) * (1.0 - sstep(0.5 + soft, 1.0 + soft, abs(az + 0.5)));
  c += vec3(1.0, 0.97, 0.93) * 3.2 * peak * box;
  float stripW = 0.12 + r * 0.5;
  float vert = sstep(-0.2, 0.15, up) * (1.0 - sstep(0.65, 0.95, up));
  c += vec3(0.9, 0.95, 1.0) * 1.1 * peak * vert * (1.0 - sstep(stripW * 0.5, stripW, abs(az - 2.0)));
  c += mix(EMERALD, vec3(1.0), 0.35) * 1.2 * peak * vert * (1.0 - sstep(stripW * 0.5, stripW, abs(az + 2.25)));
  c += EMERALD * 0.05 * exp(-up * up * 14.0) * sstep(-1.0, -0.1, up) * (1.0 - sstep(-0.1, 0.3, up));
  c += EMERALD * 0.035 * (1.0 - sstep(-0.9, -0.2, up));
  return c;
}
// Diffuse irradiance from the surrounding studio (lights are added explicitly).
vec3 irradiance(vec3 n) {
  float up = n.y * 0.5 + 0.5;
  vec3 c = mix(vec3(0.014, 0.024, 0.02), vec3(0.12, 0.12, 0.13), up * up);
  return c;
}

/* ---------- GGX ---------- */
float D_GGX(float NdH, float a) {
  float a2 = a * a;
  float d = NdH * NdH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-6);
}
float V_Smith(float NdV, float NdL, float a) {
  float a2 = a * a;
  float gv = NdL * sqrt(NdV * NdV * (1.0 - a2) + a2);
  float gl = NdV * sqrt(NdL * NdL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
vec3 F_Schlick(vec3 f0, float VdH) { return f0 + (1.0 - f0) * pow(1.0 - VdH, 5.0); }
vec2 envBRDF(float NdV, float r) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 rr = r * c0 + c1;
  float a004 = min(rr.x * rr.x, exp2(-9.28 * NdV)) * rr.x + rr.y;
  return vec2(-1.04, 1.04) * a004 + rr.zw;
}

float D_GGXaniso(float TdH, float BdH, float NdH, float at, float ab) {
  float a2 = at * ab;
  vec3 v = vec3(ab * TdH, at * BdH, a2 * NdH);
  float v2 = dot(v, v);
  float w2 = a2 / max(v2, 1e-7);
  return a2 * w2 * w2 / PI;
}
float V_SmithAniso(float at, float ab, float TdV, float BdV, float TdL, float BdL, float NdV, float NdL) {
  float lv = NdL * length(vec3(at * TdV, ab * BdV, NdV));
  float ll = NdV * length(vec3(at * TdL, ab * BdL, NdL));
  return 0.5 / max(lv + ll, 1e-5);
}
// direction of increasing u on the surface, from screen-space derivatives
vec3 tangentU(vec3 N, vec3 P, vec2 uv) {
  vec3 dp1 = dFdx(P), dp2 = dFdy(P);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 T = cross(dp2, N) * duv1.x + cross(N, dp1) * duv2.x;
  T = T - N * dot(N, T);
  float l = length(T);
  return l > 1e-6 ? T / l : normalize(cross(N, vec3(0.0, 1.0, 0.0)));
}

struct Mat {
  vec3 albedo;
  float rough;
  float f0;
  float sheen;
  float coat;
  float ao;
  float bump;
  float aniso;   // 0 = isotropic; >0 stretches highlights along the fibre
  float fibre;   // 0 = along u, 1 = along v (twill alternates)
  float trans;   // thin-surface translucency (pods)
  vec3 emit;
};

void main() {
  vec3 V = normalize(uCam - vWorld);
  vec3 N = normalize(vN);
  vec3 ng = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  bool back = dot(ng, V) * dot(ng, N) < 0.0;
  if (back) N = -N;
  vec3 Ns = N; // smooth, un-bumped normal (shadow offset / rim)

  Mat m;
  m.albedo = vec3(0.04); m.rough = 0.6; m.f0 = 0.04; m.sheen = 0.0; m.coat = 0.0; m.ao = 1.0; m.bump = 0.0; m.aniso = 0.0; m.fibre = 0.0; m.trans = 0.0; m.emit = vec3(0.0);
  float t = vUv.x;

  if (uPart == 0) {
    // ---------- upper: engineered knit + glossy TPU overlays ----------
    Upper u = upperLayout(vUv);
    vec2 q = u.q;
    float h = u.h;
    float hx = hexEdge(q * 62.0);
    float meshAA = 1.0 - smoothstep(0.25, 0.7, fwidth(q.x * 62.0));
    float cell = mix(0.5, smoothstep(0.02, 0.12, hx), meshAA);
    float fuzz = vnoise(q * 420.0);
    m.albedo = vec3(0.03, 0.032, 0.034) * (0.6 + 0.5 * cell) * (0.85 + 0.3 * fuzz);
    m.rough = 0.82;
    m.sheen = 0.45;
    m.bump = 0.004;

    float fwq = max(fwidth(q.x), 1e-5);
    float onPanel = 1.0 - smoothstep(-fwq, fwq, u.panel);
    float inWin = clamp((1.0 - smoothstep(-fwq, fwq, u.winH)) + (1.0 - smoothstep(-fwq, fwq, u.midI)), 0.0, 1.0);
    // glossy black TPU with a faint grain and smudgy roughness variation
    float grain = fbm(q * 160.0);
    float smudge = fbm(q * 3.5 + 11.0);
    m.albedo = mix(m.albedo, vec3(0.012, 0.013, 0.014) * (0.9 + 0.3 * grain), onPanel);
    m.rough = mix(m.rough, 0.22 + 0.18 * smudge, onPanel);
    m.f0 = mix(m.f0, 0.05, onPanel);
    m.sheen = mix(m.sheen, 0.0, onPanel);
    m.coat = onPanel;
    // recessed windows: deeper mesh, darker, occluded
    m.albedo = mix(m.albedo, vec3(0.008, 0.01, 0.01) * (0.5 + 1.0 * cell), inWin);
    m.rough = mix(m.rough, 0.9, inWin);
    m.coat *= 1.0 - inWin;
    m.ao *= 1.0 - 0.45 * inWin;
    // occlusion in the crease where the overlay meets the knit, and where the upper meets the midsole
    m.ao *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.03, u.panel)) * step(0.0, u.panel);
    m.ao *= 0.55 + 0.45 * smoothstep(0.0, 0.14, h);
    // throat under the laces
    float throat = band(t, 0.49, 0.74) * sstep(0.84, 0.88, h);
    m.albedo = mix(m.albedo, vec3(0.03, 0.032, 0.034), throat);
    m.ao *= 1.0 - 0.5 * throat;
    // stitches catch a little light
    float sd = u.panel - 0.012;
    float stitch = (1.0 - smoothstep(0.0, 0.0035, abs(sd))) * (0.55 + 0.45 * sin((q.x + q.y) * 2.0 * PI * 70.0));
    m.albedo = mix(m.albedo, vec3(0.05, 0.052, 0.054), stitch * 0.7);
    m.rough = mix(m.rough, 0.7, stitch);
    // emissive telemetry: thin light-pipe along the heel counter, faint leak around the windows
    float winGlow = aaLine(u.winH + 0.006, 0.0018) + aaLine(u.midI + 0.006, 0.0018);
    m.emit += EMERALD * winGlow * 1.4;
    float dHeel = sdQuad(q, P(0.0, -0.1), P(0.345, -0.1), P(0.15, 0.9), P(-0.1, 1.05));
    float diag = aaLine(dHeel, 0.0032) * band(h, 0.1, 0.93);
    m.emit += EMERALD_HOT * diag * 2.6;
    if (back) { m.albedo = vec3(0.02, 0.028, 0.025); m.rough = 0.95; m.f0 = 0.03; m.coat = 0.0; m.sheen = 0.3; m.emit = vec3(0.0); m.ao *= 0.5; m.bump = 0.0; }
  } else if (uPart == 1) {
    // ---------- sole wall: carbon cage over sculpted foam ----------
    float y = vUv.y;
    float hsT = 0.43 - 0.15 * sstep(0.2, 0.8, t);
    float ct = hsT + 0.015 + 0.2 * (1.0 - sstep(0.05, 0.36, t));
    float bot = 0.07 + 0.08 * sstep(0.25, 0.36, t) * (1.0 - sstep(0.47, 0.6, t));
    float cageLow = hsT - 0.07;
    float fwy = max(fwidth(y), 1e-5);
    float cage = smoothstep(cageLow - fwy, cageLow + fwy, y);
    float cw = carbon(vec2(t * 2.8, y) * 75.0);
    float cAA = 1.0 - smoothstep(0.3, 0.8, fwidth(t * 2.8 * 75.0));
    vec3 carbonCol = vec3(0.018, 0.02, 0.023) * (1.0 + (cw - 0.5) * 0.9 * cAA);
    float cells = 1.0 - worley(vec2(t * 2.8, y) * 48.0);
    vec3 foam = vec3(0.034, 0.036, 0.04) * (0.8 + 0.35 * cells);
    m.albedo = mix(foam, carbonCol, cage);
    m.rough = mix(0.68, 0.3 + 0.1 * cw * cAA, cage);
    m.f0 = mix(0.035, 0.05, cage);
    m.coat = cage * 0.6;
    m.bump = mix(0.012, 0.004, cage);
    m.aniso = 0.65 * cage * cAA;
    vec2 cc = floor(vec2(t * 2.8, y) * 75.0);
    m.fibre = mod(cc.x + cc.y, 2.0);
    // sculpted grooves are real geometry now; just darken their floor a touch
    float gph = abs(fract(t * 14.0 - y * 6.0) - 0.5);
    float gwin = sstep(bot + 0.02, bot + 0.045, y) * (1.0 - sstep(cageLow - 0.035, cageLow - 0.015, y));
    m.ao *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.09, gph)) * gwin;
    // overhang occlusion where the cage lip meets the foam
    m.ao *= 1.0 - 0.55 * band(y, cageLow - 0.02, cageLow);
    m.ao *= 0.7 + 0.3 * smoothstep(bot, bot + 0.05, y);
    // telemetry light-pipe tracing the cage rim
    float rimLine = aaLine(y - (ct - 0.032), 0.0032) * band(t, 0.015, 0.985);
    m.emit += EMERALD_HOT * rimLine * 2.6;
    m.emit += EMERALD * aaLine(y - (bot + 0.032), 0.0024) * sstep(0.55, 0.65, t) * band(t, 0.0, 0.97) * 1.4;
  } else if (uPart == 8) {
    // translucent emerald outsole pods
    m.albedo = vec3(0.01, 0.14, 0.085);
    m.rough = 0.24;
    m.f0 = 0.045;
    m.coat = 1.0;
    m.bump = 0.001;
    m.trans = 1.0;
    float NdVp = clamp(dot(N, V), 0.0, 1.0);
    // internal LED: brighter toward the thin edges, flickers very slightly
    m.emit += EMERALD * (0.12 + 0.5 * pow(1.0 - NdVp, 2.5)) * (0.5 + 0.5 * vUv.x) * (0.96 + 0.04 * sin(uTime * 17.0 + vUv.y * 9.0));
  } else if (uPart == 9) {
    // glossy black TPU shell (heel bumper + clips)
    m.albedo = vec3(0.012, 0.013, 0.014);
    m.rough = 0.16 + 0.08 * fbm(vUv * 6.0);
    m.f0 = 0.05;
    m.coat = 1.0;
  } else if (uPart == 2) {
    m.albedo = vec3(0.02, 0.028, 0.025);
    m.rough = 0.92;
    m.ao = 0.45;
  } else if (uPart == 3) {
    // rubber outsole with lugs
    float lug = smoothstep(0.06, 0.16, hexEdge(vUv * 9.0));
    m.albedo = mix(vec3(0.018, 0.02, 0.022), vec3(0.03, 0.033, 0.036), lug);
    m.rough = 0.62;
    m.f0 = 0.04;
    m.bump = 0.02;
    m.ao = 0.8;
  } else if (uPart == 4) {
    // flat woven laces
    float w = 0.5 + 0.5 * sin(vUv.x * 160.0) * sin(vUv.y * 2.0 * PI * 2.0);
    m.albedo = vec3(0.05, 0.053, 0.056) * (0.8 + 0.35 * w);
    m.rough = 0.72;
    m.sheen = 0.5;
    m.bump = 0.003;
  } else if (uPart == 5) {
    // padded collar: soft neoprene
    m.albedo = vec3(0.022, 0.024, 0.026) * (0.85 + 0.3 * vnoise(vUv * vec2(6.0, 1.0) * 90.0));
    m.rough = 0.88;
    m.sheen = 0.55;
    m.bump = 0.004;
  } else if (uPart == 6) {
    // tongue: quilted textile with a lit badge
    m.albedo = vec3(0.034, 0.036, 0.04) * (0.85 + 0.3 * vnoise(vUv * 150.0));
    m.rough = 0.85;
    m.sheen = 0.5;
    m.bump = 0.008;
    float tag = band(vUv.x, 0.8, 0.93) * band(vUv.y, -0.38, 0.38);
    m.albedo = mix(m.albedo, vec3(0.01), tag);
    m.rough = mix(m.rough, 0.25, tag);
    m.sheen *= 1.0 - tag;
    m.emit += EMERALD * tag * 2.2 * (0.8 + 0.2 * sin(uTime * 3.0));
    if (back) { m.albedo = vec3(0.018, 0.03, 0.026); m.emit = vec3(0.0); m.ao = 0.5; }
  } else {
    // eyelet clips: light pipes
    m.albedo = vec3(0.0);
    m.emit = EMERALD_HOT * 1.1;
    m.rough = 0.3;
  }

  if (m.bump > 0.0) N = bumpNormal(N, vWorld, vUv, m.bump);
  if (dot(N, V) < 0.0) N = normalize(N + V * (-dot(N, V) + 0.02));

  // screen-space ambient occlusion (not valid for the mirrored draw)
  float ssao = uAOOn > 0.5 ? texture(uAO, gl_FragCoord.xy / uRes).r : 1.0;
  ssao = mix(1.0, ssao, 0.9);
  m.ao *= ssao;

  vec3 Tu = tangentU(N, vWorld, vUv);
  vec3 Tf = m.fibre > 0.5 ? cross(N, Tu) : Tu;
  vec3 Bf = cross(N, Tf);

  /* ---------- lighting ---------- */
  float NdV = clamp(dot(N, V), 1e-3, 1.0);
  vec3 f0 = vec3(m.f0);
  vec3 diffuse = m.albedo / PI;
  float a = max(m.rough * m.rough, 0.002);
  float ac = 0.03;

  vec3 Ls[4];
  vec3 Cs[4];
  float Ss[4];
  Ls[0] = normalize(vec3(-0.45, 0.85, 0.6));  Cs[0] = vec3(1.0, 0.96, 0.9) * 3.6;   Ss[0] = 0.14;
  Ls[1] = normalize(vec3(0.7, 0.25, 0.8));    Cs[1] = vec3(0.7, 0.75, 0.85) * 0.42; Ss[1] = 0.3;
  Ls[2] = normalize(vec3(-0.9, 0.3, -0.7));   Cs[2] = mix(EMERALD, vec3(1.0), 0.3) * 1.5; Ss[2] = 0.08;
  Ls[3] = normalize(vec3(0.95, 0.35, -0.6));  Cs[3] = mix(CYAN, vec3(1.0), 0.4) * 0.8;    Ss[3] = 0.08;

  // mirrored draw: look the shadow up with the un-mirrored position/normal
  vec3 swp = uMirror > 0.5 ? vec3(vWorld.x, -vWorld.y, vWorld.z) : vWorld;
  vec3 snr = uMirror > 0.5 ? vec3(Ns.x, -Ns.y, Ns.z) : Ns;
  float keyShadow = shadowLookup(swp, snr, 1.0, 14.0, 2.0);
  keyShadow = mix(keyShadow, 1.0, 0.0);

  vec3 col = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec3 L = Ls[i];
    float NdL = dot(N, L);
    // wrap a little so knit/foam don't go pitch black at the terminator
    float wrap = clamp((NdL + 0.15) / 1.15, 0.0, 1.0);
    NdL = max(NdL, 0.0);
    vec3 H = normalize(L + V);
    float NdH = max(dot(N, H), 0.0);
    float VdH = max(dot(V, H), 0.0);
    // area-light approximation: widen the lobe by the light's size (Karis)
    float ap = clamp(a + Ss[i] * 0.5, 0.0, 1.0);
    float norm_ = (a / ap) * (a / ap);
    vec3 F = F_Schlick(f0, VdH);
    vec3 spec;
    if (m.aniso > 0.001) {
      float at = max(ap * (1.0 + m.aniso), 0.004), ab = max(ap * (1.0 - m.aniso), 0.004);
      float TdH = dot(Tf, H), BdH = dot(Bf, H);
      spec = D_GGXaniso(TdH, BdH, NdH, at, ab)
           * V_SmithAniso(at, ab, dot(Tf, V), dot(Bf, V), dot(Tf, L), dot(Bf, L), NdV, NdL) * F * norm_;
    } else {
      spec = D_GGX(NdH, ap) * V_Smith(NdV, NdL, ap) * F * norm_;
    }
    // clear coat
    float Fc = 0.04 + 0.96 * pow(1.0 - VdH, 5.0);
    float apc = clamp(ac + Ss[i] * 0.25, 0.0, 1.0);
    float coat = D_GGX(NdH, apc) * V_Smith(NdV, NdL, apc) * Fc * (ac / apc) * (ac / apc) * m.coat;
    // fabric sheen (grazing-angle fuzz)
    float sheen = m.sheen * pow(1.0 - NdH, 3.0) * 0.35;
    float sh = i == 0 ? keyShadow : 1.0;
    // direct light is only lightly occluded by SSAO; ambient takes the full term
    sh *= mix(1.0, ssao, 0.35);
    vec3 base = (diffuse * wrap * (1.0 - F) + (spec + sheen) * NdL) * (1.0 - Fc * m.coat * 0.5);
    // light scattering through a thin translucent shell
    float tr = m.trans * (pow(clamp(dot(V, -normalize(L + N * 0.35)), 0.0, 1.0), 2.5) * 0.7 + 0.12 * wrap);
    col += (base + coat * NdL) * Cs[i] * sh + m.albedo * 2.2 * tr * Cs[i] * mix(sh, 1.0, 0.5);
  }

  // image-based ambient
  vec3 R = reflect(-V, N);
  vec2 ab = envBRDF(NdV, m.rough);
  vec3 specEnv = env(R, m.rough) * (f0 * ab.x + ab.y);
  float Fcv = 0.04 + 0.96 * pow(1.0 - NdV, 5.0);
  vec3 coatEnv = env(reflect(-V, Ns * 0.3 + N * 0.7), 0.06) * Fcv * m.coat;
  float specOcc = mix(m.ao, 1.0, 0.3);
  col += (specEnv * (1.0 - Fcv * m.coat * 0.5) + coatEnv) * specOcc;
  col += irradiance(N) * m.albedo * m.ao;
  col += m.sheen * irradiance(N) * pow(1.0 - NdV, 3.0) * 0.5 * m.ao;
  col += m.emit * (uMirror > 0.5 ? 0.12 : 1.0);

  // telemetry scan sweep (model space, so it rides the shoe)
  if (uScan > -1.0) {
    float d = vLocal.y - uScan;
    float line = aaLine(d, 0.004);
    float trail = exp(-max(-d, 0.0) * 14.0) * step(d, 0.0) * 0.18;
    col += CYAN * (line * 2.2 + trail * 0.8);
  }

  float alpha = 1.0;
  if (uMirror > 0.5) {
    alpha = 0.12 * (1.0 - smoothstep(0.0, 0.45, -vWorld.y));
  }
  outColor = vec4(col * uPre * alpha, alpha);
}
`

/* ------------------------------------------------------------------ *
 * floor: cast shadow, contact occlusion, HUD rings
 * ------------------------------------------------------------------ */
export const FLOOR_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aXZ;
uniform mat4 uViewProj;
out vec2 vP;
void main() {
  vP = aXZ;
  gl_Position = uViewProj * vec4(aXZ.x, 0.0, aXZ.y, 1.0);
}
`

export const FLOOR_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec2 vP;
uniform float uYaw;
uniform float uTime;
uniform float uLift;
uniform float uPre;
out vec4 outColor;
const vec3 EMERALD = vec3(0.063, 0.725, 0.506);
const vec3 CYAN = vec3(0.0, 0.94, 1.0);
${SHADOW}
float aaLine(float d, float w) {
  float fw = max(fwidth(d), 1e-5);
  return 1.0 - smoothstep(w - fw, w + fw, abs(d));
}
void main() {
  float r = length(vP);
  float ang = atan(vP.y, vP.x);
  // real cast shadow from the key softbox
  float sh = shadowLookup(vec3(vP.x, 0.0, vP.y), vec3(0.0, 1.0, 0.0), 2.0, 26.0, 3.0);
  float castSh = 0.8 * (1.0 - sh);
  // soft contact occlusion under the shoe, following its heading
  float c = cos(uYaw), s = sin(uYaw);
  vec2 q = vec2(c * vP.x - s * vP.y, s * vP.x + c * vP.y);
  float spread = 1.0 + uLift * 1.8;
  float d = length(q / vec2(1.5 * spread, 0.5 * spread));
  float contact = 0.55 * exp(-d * d * 2.2) / spread;
  float shadow = 1.0 - (1.0 - castSh) * (1.0 - contact);

  float fade = 1.0 - smoothstep(1.4, 2.9, r);
  // HUD rings
  float ring1 = aaLine(r - 1.95, 0.004);
  float dash = step(0.45, fract(ang * 36.0 / 6.2832 + uTime * 0.12));
  float ring2 = aaLine(r - 2.12, 0.0025) * dash;
  float ticks = aaLine(r - 2.28, 0.025) * aaLine(fract(ang * 72.0 / 6.2832 - uTime * 0.05) - 0.5, 0.04);
  float sweep = pow(max(0.0, cos(ang - uTime * 0.9)), 24.0) * (1.0 - smoothstep(0.0, 1.95, r)) * 0.14;
  vec3 col = EMERALD * (ring1 * 0.6 + ring2 * 0.4 + ticks * 0.3) + CYAN * ring2 * 0.08;
  col += EMERALD * sweep;
  col += EMERALD * 0.04 * exp(-r * r * 0.9);
  col *= fade * (1.0 - castSh * 0.8);
  // the lit pods throw a soft green pool onto the floor beneath the shoe
  col += EMERALD * 0.09 * exp(-d * d * 3.2) / spread * fade;
  outColor = vec4(col * uPre, shadow);
}
`

/* ------------------------------------------------------------------ *
 * post-processing: bloom + tone map + grain, premultiplied output
 * ------------------------------------------------------------------ */
export const POST_VS = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

export const BRIGHT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uInvPre;
uniform float uThreshold;
out vec4 outColor;
void main() {
  // 13-tap downsample (Jimenez) for a stable, flicker-free bloom seed
  vec3 a = texture(uTex, vUv + uTexel * vec2(-2.0, -2.0)).rgb;
  vec3 b = texture(uTex, vUv + uTexel * vec2( 0.0, -2.0)).rgb;
  vec3 c = texture(uTex, vUv + uTexel * vec2( 2.0, -2.0)).rgb;
  vec3 d = texture(uTex, vUv + uTexel * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture(uTex, vUv).rgb;
  vec3 f = texture(uTex, vUv + uTexel * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture(uTex, vUv + uTexel * vec2(-2.0,  2.0)).rgb;
  vec3 h = texture(uTex, vUv + uTexel * vec2( 0.0,  2.0)).rgb;
  vec3 i = texture(uTex, vUv + uTexel * vec2( 2.0,  2.0)).rgb;
  vec3 j = texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 k = texture(uTex, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 l = texture(uTex, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 m = texture(uTex, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  vec3 s = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  // s stays in pre-exposed units so an 8-bit fallback target cannot clip it
  float lum = dot(s * uInvPre, vec3(0.299, 0.587, 0.114));
  float w = smoothstep(uThreshold, uThreshold + 1.0, lum);
  outColor = vec4(s * w, 1.0);
}
`

export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.2270270270;
  c += texture(uTex, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(uTex, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(uTex, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture(uTex, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  outColor = vec4(c, 1.0);
}
`

export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uBloomWide;
uniform float uInvPre;
uniform float uTime;
uniform vec2 uRes;
out vec4 outColor;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec4 s = texture(uScene, vUv);
  // lateral chromatic aberration, growing toward the frame edge
  vec2 ca = (vUv - 0.5) * 0.0022;
  vec3 hdr = vec3(texture(uScene, vUv + ca).r, s.g, texture(uScene, vUv - ca).b) * uInvPre;
  vec3 bloom = (texture(uBloom, vUv).rgb * 0.32 + texture(uBloomWide, vUv).rgb * 0.26) * uInvPre;
  hdr += bloom;
  // subtle optical vignette on the whole frame (darkens the page behind too)
  vec2 vc = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0) * 1.05;
  float vig = 1.0 - 0.42 * smoothstep(0.35, 1.5, dot(vc, vc));
  vec3 col = aces(hdr * 0.95);
  col = pow(col, vec3(1.0 / 2.2));
  // fine film grain, mostly on the rendered object
  float g = (hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 100.0) - 0.5) * 0.028;
  col += g * (0.25 + 0.75 * s.a);
  col = max(col, 0.0);
  float alpha = 1.0 - (1.0 - clamp(s.a, 0.0, 1.0)) * vig;
  col *= vig;
  // keep the premultiplied output valid where bloom spills over transparent page
  alpha = max(alpha, max(col.r, max(col.g, col.b)));
  outColor = vec4(col, alpha);
}
`
