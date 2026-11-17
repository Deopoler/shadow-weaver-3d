/*
 * Chiaroscuro: Shadow Weaver — GLSL sources.
 * All custom materials render linear HDR into the composer; the OutputPass tone-maps afterwards.
 */
(function (root) {
  'use strict';
  var SW = root.SW = root.SW || {};
  var S = {};

  var HASH = [
    'float hash21(vec2 p){',
    '  p = fract(p * vec2(123.34, 456.21));',
    '  p += dot(p, p + 45.32);',
    '  return fract(p.x * p.y);',
    '}'
  ].join('\n');

  /* ---------------- volumetric light cone ---------------- */
  // Geometry: unit cone, apex at the origin, axis along -Y, base radius 1 at y = -1.
  S.coneVert = [
    'varying vec3 vLocal;',
    'varying vec3 vNormalV;',
    'varying vec3 vViewV;',
    'void main(){',
    '  vLocal = position;',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vNormalV = normalize(normalMatrix * normal);',
    '  vViewV = -mv.xyz;',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  S.coneFrag = [
    'uniform vec3 uColor;',
    'uniform float uIntensity;',
    'uniform float uFalloff;',
    'uniform float uDecay;',
    'uniform float uEdge;',
    'uniform float uTime;',
    'varying vec3 vLocal;',
    'varying vec3 vNormalV;',
    'varying vec3 vViewV;',
    'void main(){',
    '  float d = clamp(-vLocal.y, 0.0, 1.0);',                       // 0 at the lamp, 1 at the far end
    '  float atten = pow(max(0.0, 1.0 - d), uFalloff) / (1.0 + uDecay * d * d);', // distance attenuation
    '  float facing = clamp(abs(dot(normalize(vNormalV), normalize(vViewV))), 0.0, 1.0);',
    '  float soft = pow(max(0.0, facing), uEdge);',                             // dissolve the silhouette
    '  float ang = atan(vLocal.z, vLocal.x);',
    '  float streak = 0.78 + 0.22 * sin(ang * 13.0 + uTime * 0.6 + d * 5.0) * sin(ang * 5.0 - uTime * 0.35);',
    '  float nearFade = smoothstep(0.0, 0.035, d);',
    '  float a = atten * soft * streak * nearFade * uIntensity;',
    '  gl_FragColor = vec4(uColor * a, a);',
    '}'
  ].join('\n');

  /* ---------------- shadow bridge ---------------- */
  S.bridgeVert = [
    'attribute float aEdge;',
    'attribute float aPerim;',
    'varying float vEdge;',
    'varying float vPerim;',
    'varying vec2 vWorld;',
    'void main(){',
    '  vEdge = aEdge;',
    '  vPerim = aPerim;',
    '  vec4 w = modelMatrix * vec4(position, 1.0);',
    '  vWorld = w.xz;',
    '  gl_Position = projectionMatrix * viewMatrix * w;',
    '}'
  ].join('\n');

  S.bridgeFrag = [
    'uniform float uTime;',
    'uniform float uTint;',     // 0 = primary light shadow, 1 = mirror-light shadow
    'uniform float uOpacity;',
    'varying float vEdge;',
    'varying float vPerim;',
    'varying vec2 vWorld;',
    'void main(){',
    '  float rim = smoothstep(0.80, 0.975, vEdge);',
    '  float core = smoothstep(0.93, 1.0, vEdge);',
    '  float flow = 0.5 + 0.5 * sin(vPerim * 2.6 - uTime * 3.6);',
    '  float dash = smoothstep(0.55, 1.0, sin(vPerim * 0.9 - uTime * 1.7) * 0.5 + 0.5);',
    '  vec3 violet = mix(vec3(0.50, 0.18, 1.0), vec3(0.15, 0.55, 1.0), uTint);',
    '  vec3 teal = mix(vec3(0.08, 0.95, 0.85), vec3(0.55, 1.0, 0.95), uTint);',
    '  vec3 neon = mix(violet, teal, flow);',
    // interior: deep indigo glass with a faint drifting lattice so it reads as solid over the void
    '  vec2 g = vWorld * 1.6 + vec2(uTime * 0.05, 0.0);',
    '  vec2 cell = abs(fract(g) - 0.5);',
    '  float lattice = smoothstep(0.46, 0.5, max(cell.x, cell.y));',
    '  float wave = 0.5 + 0.5 * sin(vWorld.x * 0.9 + vWorld.y * 1.3 - uTime * 0.8);',
    '  vec3 inner = vec3(0.035, 0.025, 0.09) + neon * (0.05 + 0.10 * lattice * wave);',
    '  vec3 col = mix(inner, neon * (1.3 + 1.6 * core + 0.9 * dash * core), rim);',
    '  float alpha = mix(0.74, 1.0, rim) * uOpacity;',
    '  gl_FragColor = vec4(col, alpha);',
    '}'
  ].join('\n');

  /* ---------------- ripple on the bridge ---------------- */
  S.rippleVert = [
    'varying vec2 vUv;',
    'void main(){',
    '  vUv = uv;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  S.rippleFrag = [
    'uniform float uProgress;',
    'uniform vec3 uColor;',
    'varying vec2 vUv;',
    'void main(){',
    '  float r = length(vUv - 0.5) * 2.0;',
    '  float radius = mix(0.08, 0.92, uProgress);',
    '  float w = mix(0.10, 0.03, uProgress);',
    '  float ring = 1.0 - smoothstep(0.0, w, abs(r - radius));',
    '  float ring2 = 1.0 - smoothstep(0.0, w * 0.7, abs(r - radius * 0.62));',
    '  float fade = (1.0 - uProgress);',
    '  float a = (ring + ring2 * 0.45) * fade * fade;',
    '  gl_FragColor = vec4(uColor * a * 1.8, a);',
    '}'
  ].join('\n');

  /* ---------------- trail particles ---------------- */
  S.trailVert = [
    'attribute float aLife;',
    'attribute float aSize;',
    'uniform float uScale;',
    'varying float vLife;',
    'void main(){',
    '  vLife = aLife;',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  gl_PointSize = aSize * (0.35 + 0.65 * aLife) * uScale / max(0.1, -mv.z);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  S.trailFrag = [
    'varying float vLife;',
    'void main(){',
    '  float d = length(gl_PointCoord - 0.5);',
    '  float a = (1.0 - smoothstep(0.0, 0.5, d)) * vLife;',
    '  vec3 col = mix(vec3(0.55, 0.25, 1.0), vec3(0.35, 1.0, 1.0), vLife) * 1.5;',
    '  gl_FragColor = vec4(col * a, a);',
    '}'
  ].join('\n');

  /* ---------------- ambient dust ---------------- */
  S.dustVert = [
    'attribute float aSeed;',
    'uniform float uTime;',
    'uniform float uScale;',
    'varying float vTw;',
    'void main(){',
    '  vec3 p = position;',
    '  p.y += sin(uTime * 0.21 + aSeed * 6.283) * 0.9;',
    '  p.x += sin(uTime * 0.13 + aSeed * 12.1) * 0.7;',
    '  p.z += cos(uTime * 0.17 + aSeed * 9.7) * 0.7;',
    '  vTw = 0.55 + 0.45 * sin(uTime * 1.3 + aSeed * 40.0);',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  gl_PointSize = (0.05 + aSeed * 0.07) * uScale / max(0.1, -mv.z);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  S.dustFrag = [
    'varying float vTw;',
    'void main(){',
    '  float d = length(gl_PointCoord - 0.5);',
    '  float a = (1.0 - smoothstep(0.05, 0.5, d)) * 0.5 * vTw;',
    '  gl_FragColor = vec4(vec3(0.62, 0.72, 0.95) * a, a);',
    '}'
  ].join('\n');

  /* ---------------- portal ---------------- */
  S.portalVert = S.rippleVert;

  S.portalFrag = [
    'uniform float uTime;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec2 p = (vUv - 0.5) * 2.0;',
    '  float r = length(p);',
    '  float a = atan(p.y, p.x);',
    '  float swirl = sin(a * 3.0 + r * 9.0 - uTime * 2.4) * 0.5 + 0.5;',
    '  float swirl2 = sin(a * 5.0 - r * 14.0 + uTime * 1.6) * 0.5 + 0.5;',
    '  float disc = 1.0 - smoothstep(0.82, 1.0, r);',
    '  float glow = pow(max(0.0, 1.0 - clamp(r, 0.0, 1.0)), 1.4);',
    '  vec3 col = mix(vec3(0.42, 0.2, 1.0), vec3(0.2, 0.95, 1.0), swirl);',
    '  col += vec3(1.0, 0.92, 0.8) * (glow * glow * glow) * 1.6;',
    '  float alpha = disc * (0.22 + 0.5 * swirl * swirl2 + 0.6 * glow);',
    '  gl_FragColor = vec4(col * alpha * 1.6, alpha);',
    '}'
  ].join('\n');

  /* ---------------- mirror prism surface ---------------- */
  S.mirrorVert = [
    'varying vec2 vUv;',
    'varying vec3 vNormalV;',
    'varying vec3 vViewV;',
    'void main(){',
    '  vUv = uv;',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vNormalV = normalize(normalMatrix * normal);',
    '  vViewV = -mv.xyz;',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  S.mirrorFrag = [
    'uniform float uTime;',
    'uniform float uActive;',
    'varying vec2 vUv;',
    'varying vec3 vNormalV;',
    'varying vec3 vViewV;',
    'void main(){',
    '  float ndv = clamp(abs(dot(normalize(vNormalV), normalize(vViewV))), 0.0, 1.0);',
    '  float oneMinus = max(0.0, 1.0 - ndv);',
    '  float fres = oneMinus * oneMinus;',
    '  vec3 base = mix(vec3(0.02, 0.035, 0.06), vec3(0.09, 0.19, 0.27), vUv.y);',
    '  float band = 1.0 - smoothstep(0.0, 0.07, abs(fract((vUv.x * 0.6 + vUv.y) * 1.4 - uTime * 0.06) - 0.5));',
    '  float band2 = 1.0 - smoothstep(0.0, 0.02, abs(fract((vUv.x * 0.6 + vUv.y) * 1.4 - uTime * 0.06 + 0.13) - 0.5));',
    '  vec3 col = base + (band * 0.22 + band2 * 0.35) * vec3(0.5, 0.8, 1.0) * (0.35 + uActive);',
    '  col += fres * vec3(0.25, 0.5, 0.7) * 0.6;',
    '  float pulse = 0.75 + 0.25 * sin(uTime * 3.0);',
    '  col += uActive * vec3(0.3, 0.95, 1.0) * 0.55 * pulse;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* ---------------- final screen pass: glitch, chromatic aberration, vignette, grain, fade ---------------- */
  S.finalPass = {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uGlitch: { value: 0 },
      uAlert: { value: 0 },
      uFade: { value: 1 }
    },
    vertexShader: [
      'varying vec2 vUv;',
      'void main(){',
      '  vUv = uv;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D tDiffuse;',
      'uniform float uTime;',
      'uniform float uGlitch;',
      'uniform float uAlert;',
      'uniform float uFade;',
      'varying vec2 vUv;',
      HASH,
      'void main(){',
      '  vec2 uv = vUv;',
      '  float g = uGlitch;',
      // horizontal tearing in thin scanline bands
      '  float band = floor(uv.y * 46.0 + uTime * 31.0);',
      '  float n1 = hash21(vec2(band, floor(uTime * 24.0)));',
      '  uv.x += (n1 - 0.5) * 0.16 * g * step(0.55, n1);',
      // coarse block displacement
      '  float n2 = hash21(vec2(floor(uv.y * 7.0), floor(uTime * 13.0) + 3.0));',
      '  uv.x += (n2 - 0.5) * 0.07 * g;',
      '  uv.y += (hash21(vec2(floor(uTime * 17.0), 9.0)) - 0.5) * 0.03 * g;',
      '  vec2 dir = uv - 0.5;',
      '  float ca = 0.0012 + 0.03 * g + 0.004 * uAlert;',
      '  vec3 col;',
      '  col.r = texture2D(tDiffuse, uv + dir * ca).r;',
      '  col.g = texture2D(tDiffuse, uv).g;',
      '  col.b = texture2D(tDiffuse, uv - dir * ca).b;',
      '  float noise = hash21(vUv * vec2(913.0, 677.0) + fract(uTime) * 71.0);',
      '  col += (noise - 0.5) * 0.35 * g;',
      '  col = mix(col, vec3(dot(col, vec3(0.3, 0.5, 0.2))) * vec3(1.9, 0.25, 0.3), g * 0.45);',
      '  col *= 1.0 - 0.25 * g * step(0.5, fract(vUv.y * 180.0));',
      // vignette
      '  float v = 1.0 - smoothstep(0.28, 1.05, length((vUv - 0.5) * vec2(1.15, 1.0)));',
      '  col *= mix(0.42, 1.0, v);',
      // pulsing red edge while the sentinel gauge fills
      '  col += vec3(0.75, 0.02, 0.04) * uAlert * (1.0 - v) * (0.65 + 0.35 * sin(uTime * 11.0));',
      '  col += (noise - 0.5) * 0.018;',
      '  gl_FragColor = vec4(max(col, 0.0) * uFade, 1.0);',
      '}'
    ].join('\n')
  };

  SW.Shaders = S;
})(typeof globalThis !== 'undefined' ? globalThis : this);
