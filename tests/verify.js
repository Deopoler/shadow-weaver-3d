/*
 * Solvability / shortcut verification for all six stages.
 * Uses exactly the same geometry + world code as the game.
 *   node tests/verify.js
 */
'use strict';
require('../js/geometry.js');
require('../js/stages.js');
const SW = globalThis.SW;
const { Geo, World, STAGES } = SW;
const DEG = Math.PI / 180;

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!ok) failures++;
}

/* ---------- unit tests for the math core ---------- */
console.log('Math core');
{
  const hull = Geo.convexHull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1], [1, 0], [0.5, 1.5]]);
  check('convex hull drops interior + collinear points', hull.length === 4);
  check('point in polygon (inside)', Geo.pointInPolygon(1, 1, hull) === true);
  check('point in polygon (outside)', Geo.pointInPolygon(3, 1, hull) === false);
  const c = Geo.polygonCentroid(hull);
  check('centroid', Math.abs(c[0] - 1) < 1e-9 && Math.abs(c[1] - 1) < 1e-9);

  // light straight above a 2x2 slab at half the light height => shadow doubles in size
  const spec = { pos: [0, 5, 0], size: [2, 0.0001, 2] };
  const verts = Geo.hexaWorld(spec, 5);
  const sh = Geo.projectShadow([0, 10, 0], verts);
  const xs = sh.map(p => p[0]), zs = sh.map(p => p[1]);
  check('ray-plane projection scale', Math.abs(Math.max(...xs) - 2) < 1e-3 && Math.abs(Math.min(...zs) + 2) < 1e-3);

  const box = Geo.hexaPlanes(Geo.hexaWorld({ pos: [0, 2, 0], size: [2, 2, 2], rotY: 30 }, 2));
  check('segment through box', Geo.segmentHitsConvex([-5, 2, 0], [5, 2, 0], box) === true);
  check('segment missing box', Geo.segmentHitsConvex([-5, 4, 0], [5, 4, 0], box) === false);
  check('segment stopping short of box', Geo.segmentHitsConvex([-5, 2, 0], [-2, 2, 0], box) === false);

  const m = { center: [10, 5, 0], normal: [-1, 0], width: 4, height: 10 };
  const r = Geo.reflectPoint([6, 8, 1], m);
  check('mirror reflection', Math.abs(r.p[0] - 14) < 1e-9 && r.p[2] === 1 && r.d === 4);
  check('mirror aperture hit', !!Geo.mirrorHit(r.p, [4, 2, 0], m));
  check('mirror aperture miss', Geo.mirrorHit(r.p, [4, 2, -30], m) === null);
  const pushed = Geo.pushOutOfRect(0.9, 0.5, 0.3, 1, 2, 0, 1);
  check('circle pushed out of rect', Math.abs(pushed[0] - 0.7) < 1e-9 && pushed[2] === true);
}

/* ---------- grid reachability ---------- */
const RES = 0.4;
const WALK_HOP = 0.6;   // contiguous walking (grid tolerance)
const EASY_JUMP = 1.5;  // a comfortable jump
const MAX_JUMP = 2.4;   // above the physical maximum (speed 4.0 * airtime 0.545 = 2.18)

function makeGrid(stage) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of stage.platforms) {
    x0 = Math.min(x0, p.x0); x1 = Math.max(x1, p.x1);
    z0 = Math.min(z0, p.z0); z1 = Math.max(z1, p.z1);
  }
  x0 -= 6; x1 += 6; z0 -= 6; z1 += 6;
  const nx = Math.ceil((x1 - x0) / RES), nz = Math.ceil((z1 - z0) / RES);
  const plat = new Int8Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    plat[iz * nx + ix] = World.platformAt(stage, x0 + (ix + 0.5) * RES, z0 + (iz + 0.5) * RES);
  }
  return { x0, z0, nx, nz, plat };
}

function walkable(grid, polys) {
  const { x0, z0, nx, nz, plat } = grid;
  const w = new Uint8Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const i = iz * nx + ix;
    if (plat[i] >= 0) { w[i] = 1; continue; }
    if (World.shadowAt(polys, x0 + (ix + 0.5) * RES, z0 + (iz + 0.5) * RES)) w[i] = 1;
  }
  return w;
}

/** Which platforms can be reached from platform `from` when hops up to `jump` are allowed? */
function reachPlatforms(grid, w, from, jump) {
  const { nx, nz, plat } = grid;
  const R = Math.ceil(jump / RES);
  const seen = new Uint8Array(nx * nz);
  const queue = [];
  for (let i = 0; i < plat.length; i++) if (plat[i] === from) { seen[i] = 1; queue.push(i); }
  const found = new Set([from]);
  while (queue.length) {
    const i = queue.pop();
    const ix = i % nx, iz = (i - ix) / nx;
    for (let dz = -R; dz <= R; dz++) {
      const jz = iz + dz;
      if (jz < 0 || jz >= nz) continue;
      for (let dx = -R; dx <= R; dx++) {
        const jx = ix + dx;
        if (jx < 0 || jx >= nx) continue;
        if ((dx * dx + dz * dz) * RES * RES > jump * jump) continue;
        const j = jz * nx + jx;
        if (seen[j] || !w[j]) continue;
        seen[j] = 1;
        if (plat[j] >= 0) found.add(plat[j]);
        queue.push(j);
      }
    }
  }
  return found;
}

function ranges(list) {
  if (!list.length) return '(none)';
  const out = [];
  let a = list[0], b = list[0];
  for (let i = 1; i < list.length; i++) {
    if (list[i] - b <= 2) b = list[i];
    else { out.push(a + '°~' + b + '°'); a = b = list[i]; }
  }
  out.push(a + '°~' + b + '°');
  return out.join(', ');
}

function stateAt(stage, thetaDeg, time) {
  return { theta: thetaDeg * DEG, height: stage.light.height, time: time || 0 };
}

function stateAtH(stage, thetaDeg, height, time) {
  return { theta: thetaDeg * DEG, height: height, time: time || 0 };
}

/* ---------- Stage 1 ---------- */
console.log('\nStage 1');
{
  const st = STAGES[0], grid = makeGrid(st);
  const solved = [], hard = [];
  for (let th = 0; th < 360; th += 2) {
    const w = walkable(grid, World.compute(st, stateAt(st, th)).polys);
    if (reachPlatforms(grid, w, 0, WALK_HOP).has(1)) solved.push(th);
    if (reachPlatforms(grid, w, 0, MAX_JUMP).has(1)) hard.push(th);
  }
  check('a walkable shadow bridge exists', solved.length >= 3, 'theta: ' + ranges(solved));
  check('initial light angle is not already a solution', !hard.includes(Math.round(st.light.theta0 / 2) * 2));
  check('solution window is a minority of the circle', hard.length < 90, 'with max jump: ' + ranges(hard));
}

/* ---------- Stage 2 ---------- */
console.log('\nStage 2');
{
  const st = STAGES[1], grid = makeGrid(st);
  const t1 = [], t2 = [], t1h = [], t2h = [], direct = [];
  for (let th = 0; th < 360; th += 2) {
    const w = walkable(grid, World.compute(st, stateAt(st, th)).polys);
    const fromA = reachPlatforms(grid, w, 0, EASY_JUMP);
    const fromM = reachPlatforms(grid, w, 1, EASY_JUMP);
    if (fromA.has(1)) t1.push(th);
    if (fromM.has(2)) t2.push(th);
    const fromAh = reachPlatforms(grid, w, 0, MAX_JUMP);
    const fromMh = reachPlatforms(grid, w, 1, MAX_JUMP);
    if (fromAh.has(1)) t1h.push(th);
    if (fromMh.has(2)) t2h.push(th);
    if (fromAh.has(2)) direct.push(th);
  }
  check('stepping-stone bridge A -> island exists', t1.length >= 3, 'theta: ' + ranges(t1));
  check('stepping-stone bridge island -> goal exists', t2.length >= 3, 'theta: ' + ranges(t2));
  check('no single angle solves the whole stage (re-aim required)', direct.length === 0,
    'A->M max: ' + ranges(t1h) + ' | M->C max: ' + ranges(t2h));
  check('initial light angle solves neither bridge',
    !t1h.includes(Math.round(st.light.theta0 / 2) * 2) && !t2h.includes(Math.round(st.light.theta0 / 2) * 2));
}

/* ---------- Stage 3 (time dependent) ---------- */
console.log('\nStage 3');
{
  const st = STAGES[2], grid = makeGrid(st);
  const period = st.occluders[1].bob.period;
  const DT = 0.1;
  const { nx, nz, plat } = grid;

  /** Walking-only reachability through time: the player may wait, or move one cell per step. */
  function timedReach(th, from, to, t0, duration) {
    let cur = new Uint8Array(nx * nz);
    for (let i = 0; i < plat.length; i++) if (plat[i] === from) cur[i] = 1;
    for (let t = t0; t < t0 + duration; t += DT) {
      const w = walkable(grid, World.compute(st, stateAt(st, th, t)).polys);
      const next = new Uint8Array(nx * nz);
      let hit = false;
      for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        if (!w[i]) continue;
        let ok = false;
        for (let dz = -1; dz <= 1 && !ok; dz++) for (let dx = -1; dx <= 1 && !ok; dx++) {
          const jx = ix + dx, jz = iz + dz;
          if (jx < 0 || jx >= nx || jz < 0 || jz >= nz) continue;
          if (cur[jz * nx + jx]) ok = true;
        }
        if (ok) { next[i] = 1; if (plat[i] === to) hit = true; }
      }
      if (hit) return true;
      cur = next;
    }
    return false;
  }

  const t1 = [], shortcut = [];
  for (let th = 0; th < 360; th += 2) {
    const w = walkable(grid, World.compute(st, stateAt(st, th, 0)).polys);
    if (reachPlatforms(grid, w, 0, WALK_HOP).has(1)) t1.push(th);
    for (let k = 0; k < 6; k++) {
      const wk = walkable(grid, World.compute(st, stateAt(st, th, period * k / 6)).polys);
      if (reachPlatforms(grid, wk, 0, MAX_JUMP).has(2)) { shortcut.push(th); break; }
    }
  }
  check('primary shadow bridge A -> mirror terrace exists', t1.length >= 3, 'theta: ' + ranges(t1));

  const t2 = [];
  let mirrorOn = 0;
  for (let th = 0; th < 360; th += 2) {
    if (World.compute(st, stateAt(st, th, 0)).mirror.active) mirrorOn++;
    if (timedReach(th, 1, 2, 0, period * 2)) t2.push(th);
  }
  check('timed mirror-shadow crossing terrace -> goal exists (walking only)', t2.length >= 3, 'theta: ' + ranges(t2));
  check('mirror is lit only for part of the orbit', mirrorOn > 0 && mirrorOn < 180, mirrorOn * 2 + '° of 360°');

  // the crossing must really depend on timing: at the best angle the static bridge is not always there
  const best = t2[Math.floor(t2.length / 2)];
  let open = 0;
  const N = 28;
  for (let k = 0; k < N; k++) {
    const w = walkable(grid, World.compute(st, stateAt(st, best, period * k / N)).polys);
    if (reachPlatforms(grid, w, 1, WALK_HOP).has(2)) open++;
  }
  check('bridge 2 is never fully static (timing matters)', open < N, 'fully connected in ' + open + '/' + N + ' phases at ' + best + '°');
  check('no angle lets the player skip the terrace', shortcut.length === 0, ranges(shortcut));
  const overlap = t1.filter(a => t2.includes(a));
  check('bridge 1 and bridge 2 need different light angles', overlap.length === 0, ranges(overlap));

  // the drifting block must never be reachable by the player's head
  const lowest = st.occluders[1].pos[1] - st.occluders[1].bob.amp - st.occluders[1].size[1] / 2;
  check('drifting block stays above jump height', lowest > 2.2, 'lowest underside y=' + lowest.toFixed(2));
}

/* ---------- Stage 4 (elevation dependent) ---------- */
console.log('\nStage 4');
{
  const st = STAGES[3], grid = makeGrid(st);
  const t1High = [], t2Low = [];
  const t1Low = [], t2High = [];
  const direct = [];

  for (let th = 0; th < 360; th += 2) {
    // High lamp (H = 16)
    const wHigh = walkable(grid, World.compute(st, stateAtH(st, th, 16)).polys);
    if (reachPlatforms(grid, wHigh, 0, WALK_HOP).has(1)) t1High.push(th);
    if (reachPlatforms(grid, wHigh, 1, WALK_HOP).has(2)) t2High.push(th);

    // Low lamp (H = 10.5)
    const wLow = walkable(grid, World.compute(st, stateAtH(st, th, 10.5)).polys);
    if (reachPlatforms(grid, wLow, 0, WALK_HOP).has(1)) t1Low.push(th);
    if (reachPlatforms(grid, wLow, 1, WALK_HOP).has(2)) t2Low.push(th);

    // Check direct shortcuts across all heights
    for (let h = st.light.minH; h <= st.light.maxH; h += 1.0) {
      const wh = walkable(grid, World.compute(st, stateAtH(st, th, h)).polys);
      if (reachPlatforms(grid, wh, 0, MAX_JUMP).has(2)) direct.push({ th, h });
    }
  }

  check('high lamp connects start -> island 1', t1High.length >= 3, 'theta: ' + ranges(t1High));
  check('low lamp connects island 1 -> goal', t2Low.length >= 3, 'theta: ' + ranges(t2Low));
  check('elevation adjustment is mandatory (low lamp fails bridge 1, high lamp fails bridge 2)',
    t1Low.length === 0 && t2High.length === 0);
  check('no lamp setting bridges start directly to goal', direct.length === 0);

  const initW = walkable(grid, World.compute(st, stateAt(st, st.light.theta0)).polys);
  check('initial lamp setting solves neither bridge',
    !reachPlatforms(grid, initW, 0, MAX_JUMP).has(1) && !reachPlatforms(grid, initW, 1, MAX_JUMP).has(2));

  const lowest = st.occluders[0].pos[1] - st.occluders[0].size[1] / 2;
  check('obelisk stays above jump height', lowest > 2.2, 'lowest underside y=' + lowest.toFixed(2));
}

/* ---------- Stage 5 (dual bobbing cycle) ---------- */
console.log('\nStage 5');
{
  const st = STAGES[4], grid = makeGrid(st);
  const period = 18; // LCM of 6 and 9
  const DT = 0.15;
  const { nx, nz, plat } = grid;

  function timedReach(th, from, to, t0, duration) {
    let cur = new Uint8Array(nx * nz);
    for (let i = 0; i < plat.length; i++) if (plat[i] === from) cur[i] = 1;
    for (let t = t0; t < t0 + duration; t += DT) {
      const w = walkable(grid, World.compute(st, stateAt(st, th, t)).polys);
      const next = new Uint8Array(nx * nz);
      let hit = false;
      for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        if (!w[i]) continue;
        let ok = false;
        for (let dz = -1; dz <= 1 && !ok; dz++) for (let dx = -1; dx <= 1 && !ok; dx++) {
          const jx = ix + dx, jz = iz + dz;
          if (jx < 0 || jx >= nx || jz < 0 || jz >= nz) continue;
          if (cur[jz * nx + jx]) ok = true;
        }
        if (ok) { next[i] = 1; if (plat[i] === to) hit = true; }
      }
      if (hit) return true;
      cur = next;
    }
    return false;
  }

  const solved = [];
  for (let th = 130; th <= 165; th += 2) {
    if (timedReach(th, 0, 1, 0, period * 1.5)) solved.push(th);
  }
  check('timed crossing across dual bobbing slabs exists', solved.length >= 3, 'theta: ' + ranges(solved));

  const bestTh = 146;
  const N = 180;
  const openArray = [];
  for (let k = 0; k < N; k++) {
    const wk = walkable(grid, World.compute(st, stateAt(st, bestTh, period * k / N)).polys);
    openArray.push(reachPlatforms(grid, wk, 0, WALK_HOP).has(1));
  }
  const openPhases = openArray.filter(Boolean).length;
  const openFrac = openPhases / N;

  // Continuous open windows (handling circular wrap-around over period)
  let firstFalse = -1;
  for (let k = 0; k < N; k++) { if (!openArray[k]) { firstFalse = k; break; } }
  const windows = [];
  if (firstFalse === -1) {
    windows.push(period);
  } else {
    let inWindow = false, startK = 0;
    for (let step = 0; step < N; step++) {
      const k = (firstFalse + step) % N;
      if (openArray[k] && !inWindow) {
        inWindow = true; startK = k;
      } else if (!openArray[k] && inWindow) {
        inWindow = false;
        const len = (k - startK + N) % N;
        windows.push(len * (period / N));
      }
    }
    if (inWindow) {
      const len = (firstFalse - startK + N) % N;
      windows.push(len * (period / N));
    }
  }
  const longestWindow = windows.length ? Math.max(...windows) : 0;
  const shortestWindow = windows.length ? Math.min(...windows) : 0;

  check('open fraction is within target band (25% ~ 50%)',
    openFrac >= 0.25 && openFrac <= 0.50,
    'open ' + openPhases + '/' + N + ' phases (' + Math.round(100 * openFrac) + '%) at ' + bestTh + '° | longest: ' + longestWindow.toFixed(2) + 's, shortest: ' + shortestWindow.toFixed(2) + 's');

  // Simulate walking along the route over time
  const walkRoute = [
    [st.platforms[0].x1 - 0.2, 3.2],
    [-2.0, 1.6],
    [0.2, -0.2],
    [2.6, -1.8],
    [st.platforms[1].x0 + 0.2, -3.5]
  ];
  let walkDist = 0;
  for (let i = 1; i < walkRoute.length; i++) {
    walkDist += Math.hypot(walkRoute[i][0] - walkRoute[i - 1][0], walkRoute[i][1] - walkRoute[i - 1][1]);
  }
  const SPEED = 4.0;
  const walkTime = walkDist / SPEED;

  function simulateWalkAcross(t0) {
    let curX = walkRoute[0][0], curZ = walkRoute[0][1], t = t0;
    const dt = 0.05;
    for (let i = 1; i < walkRoute.length; i++) {
      const tx = walkRoute[i][0], tz = walkRoute[i][1];
      while (Math.hypot(tx - curX, tz - curZ) > 0.01) {
        const dx = tx - curX, dz = tz - curZ, l = Math.hypot(dx, dz);
        const step = Math.min(l, SPEED * dt);
        curX += (dx / l) * step; curZ += (dz / l) * step; t += dt;
        const w = World.compute(st, stateAt(st, bestTh, t));
        const sup = World.supportAt(st, w.polys, curX, curZ);
        if (sup.platform < 0 && !sup.shadow) return false;
      }
    }
    return true;
  }

  let walkSucceeded = false;
  for (let k = 0; k < N; k++) {
    if (simulateWalkAcross(period * k / N)) { walkSucceeded = true; break; }
  }
  check('bridge stays open continuously long enough to walk across (>= 1.5x walk time)',
    walkSucceeded && longestWindow >= walkTime * 1.5,
    'walk dist: ' + walkDist.toFixed(2) + ' units (' + walkTime.toFixed(2) + 's at speed ' + SPEED.toFixed(1) + '), longest window: ' + longestWindow.toFixed(2) + 's (margin: ' + (longestWindow / walkTime).toFixed(2) + 'x)');

  const stSlab0Only = Object.assign({}, st, { occluders: [st.occluders[0]] });
  const stSlab1Only = Object.assign({}, st, { occluders: [st.occluders[1]] });
  let slab0Can = false, slab1Can = false;
  for (let k = 0; k < 12; k++) {
    const t = period * k / 12;
    const w0 = walkable(grid, World.compute(stSlab0Only, stateAt(st, bestTh, t)).polys);
    const w1 = walkable(grid, World.compute(stSlab1Only, stateAt(st, bestTh, t)).polys);
    if (reachPlatforms(grid, w0, 0, MAX_JUMP).has(1)) slab0Can = true;
    if (reachPlatforms(grid, w1, 0, MAX_JUMP).has(1)) slab1Can = true;
  }
  check('both bobbing slabs are required (neither alone can bridge the abyss)', !slab0Can && !slab1Can);

  const initW = walkable(grid, World.compute(st, stateAt(st, st.light.theta0, 0)).polys);
  check('initial light angle does not connect', !reachPlatforms(grid, initW, 0, MAX_JUMP).has(1));

  const lowest0 = st.occluders[0].pos[1] - st.occluders[0].bob.amp - st.occluders[0].size[1] / 2;
  const lowest1 = st.occluders[1].pos[1] - st.occluders[1].bob.amp - st.occluders[1].size[1] / 2;
  check('both bobbing slabs stay above jump height', lowest0 > 2.2 && lowest1 > 2.2,
    'undersides y=' + lowest0.toFixed(2) + ', y=' + lowest1.toFixed(2));
}

/* ---------- Stage 6 (mirror-shadow fusion & multi-reaim) ---------- */
console.log('\nStage 6');
{
  const st = STAGES[5], grid = makeGrid(st);
  const t01 = [], t12 = [], t23 = [];
  const t01m = [], t12m = [], t23m = [];
  const sc02 = [], sc13 = [], sc03 = [];

  for (let th = 0; th < 360; th += 2) {
    const polys = World.compute(st, stateAt(st, th)).polys;
    const w = walkable(grid, polys);
    if (reachPlatforms(grid, w, 0, WALK_HOP).has(1)) t01.push(th);
    if (reachPlatforms(grid, w, 1, WALK_HOP).has(2)) t12.push(th);
    if (reachPlatforms(grid, w, 2, WALK_HOP).has(3)) t23.push(th);

    const r0m = reachPlatforms(grid, w, 0, MAX_JUMP);
    const r1m = reachPlatforms(grid, w, 1, MAX_JUMP);
    const r2m = reachPlatforms(grid, w, 2, MAX_JUMP);
    if (r0m.has(1)) t01m.push(th);
    if (r1m.has(2)) t12m.push(th);
    if (r2m.has(3)) t23m.push(th);

    if (r0m.has(2)) sc02.push(th);
    if (r1m.has(3)) sc13.push(th);
    if (r0m.has(3)) sc03.push(th);
  }

  check('bridge 1 (start -> center island) exists', t01.length >= 3, 'theta: ' + ranges(t01));
  check('bridge 2 (mirror-shadow fusion across wide abyss) exists', t12.length >= 3, 'theta: ' + ranges(t12));
  check('bridge 3 (west terrace -> goal) exists', t23.length >= 3, 'theta: ' + ranges(t23));

  const stNoMirror = Object.assign({}, st, { mirror: null });
  let noMirrorPossible = false;
  for (let th = 0; th < 360; th += 2) {
    const w = walkable(grid, World.compute(stNoMirror, stateAt(stNoMirror, th)).polys);
    if (reachPlatforms(grid, w, 1, MAX_JUMP).has(2)) noMirrorPossible = true;
  }
  check('mirror is strictly required for bridge 2 (primary shadow alone cannot reach)', !noMirrorPossible);

  check('no shortcut skips center island (0 -> 2 impossible without re-aim)', sc02.length === 0, ranges(sc02));
  check('no shortcut skips west terrace (1 -> 3 impossible without re-aim)', sc13.length === 0, ranges(sc13));
  check('no single angle solves the entire stage (0 -> 3 impossible)', sc03.length === 0);

  const initW = walkable(grid, World.compute(st, stateAt(st, st.light.theta0)).polys);
  check('initial light angle solves none of the bridges',
    !reachPlatforms(grid, initW, 0, MAX_JUMP).has(1) &&
    !reachPlatforms(grid, initW, 1, MAX_JUMP).has(2) &&
    !reachPlatforms(grid, initW, 2, MAX_JUMP).has(3));
}

/* ---------- global sanity ---------- */
console.log('\nGlobal');
for (const st of STAGES) {
  let top = 0;
  for (const o of st.occluders) top = Math.max(top, o.pos[1] + (o.bob ? o.bob.amp : 0) + o.size[1] / 2);
  check('stage ' + st.id + ': lamp is always above every occluder', st.light.minH > top + 0.5);
  check('stage ' + st.id + ': start and portal stand on platforms',
    World.platformAt(st, st.start[0], st.start[1]) >= 0 && World.platformAt(st, st.portal[0], st.portal[1]) >= 0);
  // sentinels: the start point must be safe at all times
  let safe = true;
  for (let t = 0; t < 30; t += 0.1) {
    const w = World.compute(st, stateAt(st, st.light.theta0, t));
    for (const s of st.sentinels) {
      if (World.sentinelSees(s, World.sentinelAim(s, t), [st.start[0], 0.6, st.start[1]], w.occ)) safe = false;
    }
  }
  check('stage ' + st.id + ': spawn point is never watched', safe);
  // every platform's arrival/respawn point (and a small area around it) must be a safe place to rest and re-aim
  let restSafe = true, portalOpen = 0;
  const T = 400;
  for (let k = 0; k < T; k++) {
    const t = k * 0.09;
    const w = World.compute(st, stateAt(st, st.light.theta0, t));
    let portalSeen = false;
    for (const s of st.sentinels) {
      const aim = World.sentinelAim(s, t);
      for (const pl of st.platforms) {
        for (const [ox, oz] of [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) {
          if (World.sentinelSees(s, aim, [pl.spawn[0] + ox, 0.6, pl.spawn[1] + oz], [])) restSafe = false;
        }
      }
      if (World.sentinelSees(s, aim, [st.portal[0], 0.6, st.portal[1]], w.occ)) portalSeen = true;
    }
    if (!portalSeen) portalOpen++;
  }
  check('stage ' + st.id + ': every arrival point is a safe zone', restSafe);
  check('stage ' + st.id + ': the portal is reachable unseen for a fair share of the cycle', portalOpen / T > 0.35, Math.round(100 * portalOpen / T) + '% of the time');
}

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
