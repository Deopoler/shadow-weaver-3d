/*
 * Chiaroscuro: Shadow Weaver — geometry & world simulation core.
 * Pure math, no rendering. Shared by the game (browser) and the solvability tests (Node).
 *
 * Conventions: world is Y-up. The walkable floor is the plane y = 0.
 * 2D points are [x, z]. 3D points are [x, y, z].
 */
(function (root) {
  'use strict';
  var SW = root.SW = root.SW || {};
  var DEG = Math.PI / 180;
  var TAU = Math.PI * 2;

  /* ------------------------------------------------------------------ */
  /* 2D primitives                                                       */
  /* ------------------------------------------------------------------ */

  function cross2(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }

  /** Andrew's monotone chain convex hull. Returns hull vertices in order, collinear points removed. */
  function convexHull(points) {
    var n = points.length;
    if (n < 3) return points.slice();
    var pts = points.slice().sort(function (a, b) {
      return a[0] === b[0] ? a[1] - b[1] : a[0] - b[0];
    });
    var lower = [];
    var i, p;
    for (i = 0; i < n; i++) {
      p = pts[i];
      while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop();
      lower.push(p);
    }
    var upper = [];
    for (i = n - 1; i >= 0; i--) {
      p = pts[i];
      while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  /** Even-odd ray casting point-in-polygon test. */
  function pointInPolygon(x, z, poly) {
    var inside = false;
    var n = poly.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = poly[i][0], zi = poly[i][1];
      var xj = poly[j][0], zj = poly[j][1];
      if ((zi > z) !== (zj > z)) {
        var xCross = xi + (z - zi) * (xj - xi) / (zj - zi);
        if (x < xCross) inside = !inside;
      }
    }
    return inside;
  }

  function polygonArea(poly) {
    var n = poly ? poly.length : 0;
    if (n < 3) return 0;
    var a = 0;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    }
    return Math.abs(a) * 0.5;
  }

  function polygonCentroid(poly) {
    var n = poly.length;
    var a = 0, cx = 0, cz = 0;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
      a += f;
      cx += (poly[j][0] + poly[i][0]) * f;
      cz += (poly[j][1] + poly[i][1]) * f;
    }
    if (Math.abs(a) < 1e-9) {
      var sx = 0, sz = 0;
      for (var k = 0; k < n; k++) { sx += poly[k][0]; sz += poly[k][1]; }
      return [sx / Math.max(1, n), sz / Math.max(1, n)];
    }
    return [cx / (3 * a), cz / (3 * a)];
  }

  /**
   * Sutherland-Hodgman convex polygon clipping: intersects `subject` with `clip` (both convex).
   * Handles either winding of `clip` and returns hull-ordered vertices (or [] if degenerate).
   */
  function clipConvexPolygon(subject, clip) {
    if (!subject || !clip || subject.length < 3 || clip.length < 3) return [];
    var cn = clip.length;
    var signed = 0;
    var i, j;
    for (i = 0, j = cn - 1; i < cn; j = i++) {
      signed += clip[j][0] * clip[i][1] - clip[i][0] * clip[j][1];
    }
    if (Math.abs(signed) < 1e-12) return [];
    var ccw = signed > 0;
    var out = subject.slice();
    for (i = 0; i < cn; i++) {
      var a = ccw ? clip[i] : clip[(i + 1) % cn];
      var b = ccw ? clip[(i + 1) % cn] : clip[i];
      var input = out;
      var inLen = input.length;
      if (inLen === 0) return [];
      out = [];
      var s = input[inLen - 1];
      var sVal = cross2(a, b, s);
      for (j = 0; j < inLen; j++) {
        var e = input[j];
        var eVal = cross2(a, b, e);
        if (eVal >= -1e-9) {
          if (sVal < -1e-9) {
            var t = sVal / (sVal - eVal);
            out.push([s[0] + (e[0] - s[0]) * t, s[1] + (e[1] - s[1]) * t]);
          }
          out.push(e);
        } else if (sVal >= -1e-9) {
          var t2 = sVal / (sVal - eVal);
          out.push([s[0] + (e[0] - s[0]) * t2, s[1] + (e[1] - s[1]) * t2]);
        }
        s = e;
        sVal = eVal;
      }
    }
    if (out.length < 3) return [];
    var hull = convexHull(out);
    return hull.length >= 3 && polygonArea(hull) > 1e-7 ? hull : [];
  }

  /**
   * Smoothly bevels razor-thin acute vertices (interior angle < ~45 deg, cos > 0.7) produced when
   * a mirror boundary clips diagonally across a shadow edge at a shallow grazing angle.
   * Why: grazing clip lines otherwise form long sub-player-width needles (width -> 0 at the tip,
   * narrower than 2 * PLAYER_R = 0.64) that are not fair walkable bridges and can create point-grid
   * jump shortcuts. Ramps smoothly with angle and caps at 35% of adjacent edge length so polygon
   * area varies continuously without jumps and loses only a tiny sliver.
   * Applied ONLY to mirror-clipped shadow polygons, never to primary shadows.
   */
  function trimSpikes(poly, minW) {
    var n = poly ? poly.length : 0;
    if (n < 3) return [];
    var out = [];
    for (var i = 0; i < n; i++) {
      var prev = poly[(i + n - 1) % n];
      var p = poly[i];
      var next = poly[(i + 1) % n];
      var ux = prev[0] - p[0], uz = prev[1] - p[1];
      var vx = next[0] - p[0], vz = next[1] - p[1];
      var ul = Math.sqrt(ux * ux + uz * uz);
      var vl = Math.sqrt(vx * vx + vz * vz);
      if (ul < 1e-6 || vl < 1e-6) continue;
      var dot = (ux * vx + uz * vz) / (ul * vl);
      if (dot > 0.7) {
        var sinHalf = Math.sqrt(Math.max(0, (1 - dot) * 0.5));
        if (sinHalf > 1e-4) {
          var k = Math.min(1, (dot - 0.7) / 0.2);
          var minEdge = ul < vl ? ul : vl;
          var dWant = (minW * 0.5) / sinHalf;
          var dCap = minEdge * 0.35;
          var d = k * (dWant < dCap ? dWant : dCap);
          out.push([p[0] + (ux / ul) * d, p[1] + (uz / ul) * d]);
          out.push([p[0] + (vx / vl) * d, p[1] + (vz / vl) * d]);
          continue;
        }
      }
      out.push(p);
    }
    return out.length >= 3 ? convexHull(out) : [];
  }

  function inRect(x, z, r) {
    return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
  }

  /** Push a circle (x, z, radius) out of an axis-aligned rectangle. Returns [x, z, hit]. */
  function pushOutOfRect(x, z, radius, x0, x1, z0, z1) {
    var nx = Math.max(x0, Math.min(x, x1));
    var nz = Math.max(z0, Math.min(z, z1));
    var dx = x - nx, dz = z - nz;
    var d2 = dx * dx + dz * dz;
    if (d2 >= radius * radius) return [x, z, false];
    if (d2 > 1e-10) {
      var d = Math.sqrt(d2);
      var k = (radius - d) / d;
      return [x + dx * k, z + dz * k, true];
    }
    // centre is inside the rectangle: exit through the nearest side
    var l = x - x0, r = x1 - x, t = z - z0, b = z1 - z;
    var m = Math.min(l, r, t, b);
    if (m === l) return [x0 - radius, z, true];
    if (m === r) return [x1 + radius, z, true];
    if (m === t) return [x, z0 - radius, true];
    return [x, z1 + radius, true];
  }

  /* ------------------------------------------------------------------ */
  /* Hexahedron occluders (box / tapered obelisk)                        */
  /* ------------------------------------------------------------------ */

  /** 8 local-space vertices: 0-3 bottom ring, 4-7 top ring (top ring scaled by taper). */
  function hexaLocal(spec) {
    var hx = spec.size[0] / 2, hy = spec.size[1] / 2, hz = spec.size[2] / 2;
    var t = spec.taper === undefined ? 1 : spec.taper;
    return [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz],
      [-hx * t, hy, -hz * t], [hx * t, hy, -hz * t], [hx * t, hy, hz * t], [-hx * t, hy, hz * t]
    ];
  }

  /** World-space vertices. Rotation about Y matches three.js Object3D.rotation.y. */
  function hexaWorld(spec, centerY) {
    var local = hexaLocal(spec);
    var phi = (spec.rotY || 0) * DEG;
    var c = Math.cos(phi), s = Math.sin(phi);
    var out = new Array(8);
    for (var i = 0; i < 8; i++) {
      var v = local[i];
      out[i] = [
        spec.pos[0] + v[0] * c + v[2] * s,
        centerY + v[1],
        spec.pos[2] - v[0] * s + v[2] * c
      ];
    }
    return out;
  }

  var HEXA_FACES = [
    [0, 1, 2, 3], [4, 7, 6, 5],
    [1, 0, 4, 5], [2, 1, 5, 6], [3, 2, 6, 7], [0, 3, 7, 4]
  ];

  /** Outward-facing planes {n:[x,y,z], d} with n·p = d for a convex hexahedron. */
  function hexaPlanes(verts) {
    var cx = 0, cy = 0, cz = 0, i;
    for (i = 0; i < 8; i++) { cx += verts[i][0]; cy += verts[i][1]; cz += verts[i][2]; }
    cx /= 8; cy /= 8; cz /= 8;
    var planes = [];
    for (i = 0; i < HEXA_FACES.length; i++) {
      var f = HEXA_FACES[i];
      var a = verts[f[0]], b = verts[f[1]], c = verts[f[2]];
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      var vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= len; ny /= len; nz /= len;
      var d = nx * a[0] + ny * a[1] + nz * a[2];
      if (nx * cx + ny * cy + nz * cz - d > 0) { nx = -nx; ny = -ny; nz = -nz; d = -d; }
      planes.push({ n: [nx, ny, nz], d: d });
    }
    return planes;
  }

  /** Cyrus–Beck: does the segment p0→p1 pass through the convex solid described by planes? */
  function segmentHitsConvex(p0, p1, planes) {
    var tEnter = 0, tExit = 1;
    var dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    for (var i = 0; i < planes.length; i++) {
      var n = planes[i].n;
      var denom = n[0] * dx + n[1] * dy + n[2] * dz;
      var dist = n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2] - planes[i].d;
      if (Math.abs(denom) < 1e-12) {
        if (dist > 0) return false;
        continue;
      }
      var t = -dist / denom;
      if (denom < 0) { if (t > tEnter) tEnter = t; }
      else { if (t < tExit) tExit = t; }
      if (tEnter > tExit) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Projective shadow                                                   */
  /* ------------------------------------------------------------------ */

  var MAX_RAY_T = 60;

  /**
   * Cast rays from the light L through every vertex and intersect them with the floor plane y = 0.
   * Ray: P(t) = L + (V - L) t, hits y = 0 at t = L.y / (L.y - V.y).
   * The convex hull of the hits is the shadow polygon.
   */
  function projectShadow(L, verts) {
    var hits = [];
    for (var i = 0; i < verts.length; i++) {
      var v = verts[i];
      var denom = L[1] - v[1];
      var t = denom > 0.05 ? L[1] / denom : MAX_RAY_T;
      if (t > MAX_RAY_T) t = MAX_RAY_T;
      hits.push([L[0] + (v[0] - L[0]) * t, L[2] + (v[2] - L[2]) * t]);
    }
    return convexHull(hits);
  }

  /* ------------------------------------------------------------------ */
  /* Mirror                                                              */
  /* ------------------------------------------------------------------ */

  /** Signed distance of p in front (+) of the mirror plane (vertical plane, horizontal normal). */
  function mirrorDist(p, m) {
    return (p[0] - m.center[0]) * m.normal[0] + (p[2] - m.center[2]) * m.normal[1];
  }

  /** Mirror image of p across the mirror plane. */
  function reflectPoint(p, m) {
    var d = mirrorDist(p, m);
    return { p: [p[0] - 2 * d * m.normal[0], p[1], p[2] - 2 * d * m.normal[1]], d: d };
  }

  /**
   * Where does the segment from the virtual light (behind the mirror) to a target (in front)
   * cross the mirror plane? Returns the crossing point if it lies on the mirror's surface, else null.
   */
  function mirrorHit(from, to, m) {
    var da = mirrorDist(from, m), db = mirrorDist(to, m);
    if (da >= 0 || db <= 0) return null;
    var t = da / (da - db);
    var px = from[0] + (to[0] - from[0]) * t;
    var py = from[1] + (to[1] - from[1]) * t;
    var pz = from[2] + (to[2] - from[2]) * t;
    var lateral = (px - m.center[0]) * (-m.normal[1]) + (pz - m.center[2]) * m.normal[0];
    if (Math.abs(lateral) > m.width / 2) return null;
    if (py < m.center[1] - m.height / 2 || py > m.center[1] + m.height / 2) return null;
    return [px, py, pz];
  }

  /**
   * Ground polygon (on y = 0) illuminated through the mirror rectangle from virtual light `Lp`.
   * Clips the mirror rectangle vertically to [max(0, yBottom), min(yTop, Lp.y - 0.05)] so upward
   * rays never project to the ground and no point ever lands on the far side of the mirror plane.
   */
  function mirrorGroundRegion(Lp, m) {
    if (mirrorDist(Lp, m) >= -1e-6 || Lp[1] <= 0.05) return [];
    var y0 = Math.max(0, m.center[1] - m.height / 2);
    var y1 = Math.min(m.center[1] + m.height / 2, Lp[1] - 0.05);
    if (y1 <= y0 + 1e-6) return [];
    var tx = -m.normal[1], tz = m.normal[0];
    var hw = m.width / 2;
    var x0 = m.center[0] - hw * tx, z0 = m.center[2] - hw * tz;
    var x1 = m.center[0] + hw * tx, z1 = m.center[2] + hw * tz;
    var t0 = Lp[1] / (Lp[1] - y0);
    var t1 = Lp[1] / (Lp[1] - y1);
    return convexHull([
      [Lp[0] + (x0 - Lp[0]) * t0, Lp[2] + (z0 - Lp[2]) * t0],
      [Lp[0] + (x1 - Lp[0]) * t0, Lp[2] + (z1 - Lp[2]) * t0],
      [Lp[0] + (x1 - Lp[0]) * t1, Lp[2] + (z1 - Lp[2]) * t1],
      [Lp[0] + (x0 - Lp[0]) * t1, Lp[2] + (z0 - Lp[2]) * t1]
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* World simulation                                                    */
  /* ------------------------------------------------------------------ */

  var World = {};
  var sampleBuf = new Array(10);
  var c3Buf = [0, 0, 0];

  World.lightPos = function (light, theta, height) {
    return [
      light.pivot[0] + light.radius * Math.cos(theta),
      height,
      light.pivot[1] + light.radius * Math.sin(theta)
    ];
  };

  World.occluderY = function (occ, time) {
    if (!occ.bob) return occ.pos[1];
    return occ.pos[1] + occ.bob.amp * Math.sin(TAU * (time / occ.bob.period + (occ.bob.phase || 0)));
  };

  /**
   * Full deterministic world state for (theta, height, time):
   * light position, occluder solids, every solid shadow polygon (primary + mirror-reflected).
   */
  World.compute = function (stage, s) {
    var L = World.lightPos(stage.light, s.theta, s.height);
    var occ = [];
    var i;
    for (i = 0; i < stage.occluders.length; i++) {
      var spec = stage.occluders[i];
      var y = World.occluderY(spec, s.time);
      var verts = hexaWorld(spec, y);
      occ.push({ spec: spec, y: y, verts: verts, planes: hexaPlanes(verts), center: [spec.pos[0], y, spec.pos[2]] });
    }
    var polys = [];
    for (i = 0; i < occ.length; i++) {
      var pts = projectShadow(L, occ[i].verts);
      if (pts.length >= 3) polys.push({ pts: pts, src: 0, occ: i });
    }
    var mirror = null;
    if (stage.mirror) {
      var m = stage.mirror;
      var r = reflectPoint(L, m);
      mirror = { active: false, Lp: r.p, hit: null, target: null };
      if (r.d > 0.2) {
        var mPoly = mirrorGroundRegion(r.p, m);
        if (mPoly.length >= 3) {
          for (i = 0; i < occ.length; i++) {
            var oc = occ[i];
            if (mirrorDist(oc.center, m) <= 0.2) continue;
            var raw = projectShadow(r.p, oc.verts);
            var clipped = clipConvexPolygon(raw, mPoly);
            if (clipped.length < 3) continue;
            var mp = trimSpikes(clipped, 0.5);
            if (mp.length < 3 || polygonArea(mp) < 0.02) continue;

            var c2 = polygonCentroid(mp);
            var sY = r.p[1] > 0.05 ? Math.max(0, Math.min(1, (r.p[1] - oc.center[1]) / r.p[1])) : 0.5;
            c3Buf[0] = r.p[0] + (c2[0] - r.p[0]) * sY;
            c3Buf[1] = oc.center[1];
            c3Buf[2] = r.p[2] + (c2[1] - r.p[2]) * sY;
            sampleBuf[0] = oc.center;
            sampleBuf[1] = c3Buf;
            for (var vIdx = 0; vIdx < 8; vIdx++) sampleBuf[2 + vIdx] = oc.verts[vIdx];

            // The occluder counts as lit through the mirror if ANY sample ray is clear, and then its
            // whole clipped reflected shadow is kept, even where some rays are blocked by another
            // occluder. That is deliberate, not an approximation error: a ground point whose mirror
            // path is blocked by occluder k is dark in the mirror light anyway (k's reflected shadow),
            // so it is shadow either way. Rejecting only when every sample is blocked models
            // "the mirror light does not reach this occluder at all".
            var chosenHit = null;
            for (var sIdx = 0; sIdx < 10; sIdx++) {
              var tgt = sampleBuf[sIdx];
              if (mirrorDist(tgt, m) <= 0.05) continue;
              var hit = mirrorHit(r.p, tgt, m);
              if (!hit) continue;
              var blocked = false;
              for (var k = 0; k < occ.length; k++) {
                if (segmentHitsConvex(L, hit, occ[k].planes)) { blocked = true; break; }
                if (k !== i && segmentHitsConvex(hit, tgt, occ[k].planes)) { blocked = true; break; }
              }
              if (!blocked) {
                chosenHit = hit;
                break;
              }
            }
            if (!chosenHit) continue;

            polys.push({ pts: mp, src: 1, occ: i });
            if (!mirror.active) {
              mirror.active = true;
              mirror.hit = chosenHit;
              mirror.target = oc.center;
            }
          }
        }
      }
    }
    return { L: L, occ: occ, polys: polys, mirror: mirror };
  };

  World.platformAt = function (stage, x, z) {
    for (var i = 0; i < stage.platforms.length; i++) {
      if (inRect(x, z, stage.platforms[i])) return i;
    }
    return -1;
  };

  World.shadowAt = function (polys, x, z) {
    for (var i = 0; i < polys.length; i++) {
      if (pointInPolygon(x, z, polys[i].pts)) return true;
    }
    return false;
  };

  /** What holds the player up at (x, z)? */
  World.supportAt = function (stage, polys, x, z) {
    var p = World.platformAt(stage, x, z);
    return { platform: p, shadow: p >= 0 ? false : World.shadowAt(polys, x, z) };
  };

  /** Point on the floor the sentinel is currently aiming at. */
  World.sentinelAim = function (s, time) {
    var ph = TAU * (time / s.period + (s.phase || 0));
    if (s.mode === 'orbit') {
      return [s.center[0] + s.radius * Math.cos(ph), 0, s.center[1] + s.radius * Math.sin(ph)];
    }
    var k = 0.5 - 0.5 * Math.cos(ph);
    return [s.a[0] + (s.b[0] - s.a[0]) * k, 0, s.a[1] + (s.b[1] - s.a[1]) * k];
  };

  /** Is point P inside the sentinel's cone with a clear line of sight (not hidden behind an occluder)? */
  World.sentinelSees = function (s, aim, P, occ) {
    var S = s.pos;
    var ax = aim[0] - S[0], ay = aim[1] - S[1], az = aim[2] - S[2];
    var al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    var vx = P[0] - S[0], vy = P[1] - S[1], vz = P[2] - S[2];
    var vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    var cosA = (ax * vx + ay * vy + az * vz) / (al * vl);
    if (cosA < Math.cos(s.cone * DEG)) return false;
    for (var i = 0; i < occ.length; i++) {
      if (segmentHitsConvex(S, P, occ[i].planes)) return false;
    }
    return true;
  };

  SW.Geo = {
    DEG: DEG,
    TAU: TAU,
    convexHull: convexHull,
    pointInPolygon: pointInPolygon,
    polygonArea: polygonArea,
    polygonCentroid: polygonCentroid,
    clipConvexPolygon: clipConvexPolygon,
    trimSpikes: trimSpikes,
    inRect: inRect,
    pushOutOfRect: pushOutOfRect,
    hexaLocal: hexaLocal,
    hexaWorld: hexaWorld,
    hexaPlanes: hexaPlanes,
    HEXA_FACES: HEXA_FACES,
    segmentHitsConvex: segmentHitsConvex,
    projectShadow: projectShadow,
    mirrorDist: mirrorDist,
    reflectPoint: reflectPoint,
    mirrorHit: mirrorHit,
    mirrorGroundRegion: mirrorGroundRegion
  };
  SW.World = World;

  if (typeof module !== 'undefined' && module.exports) module.exports = SW;
})(typeof globalThis !== 'undefined' ? globalThis : this);
