/*
 * Unit tests for mirror-reflected shadow clipping, spike beveling, far-side rejection, and blocking.
 *   node tests/mirror.js
 */
'use strict';
require('../js/geometry.js');
require('../js/stages.js');
const SW = globalThis.SW;
const { Geo, World, STAGES } = SW;
const DEG = Geo.DEG;

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!ok) failures++;
}

/* ---------- 1. Mirror ground region projection ---------- */
console.log('1. Mirror ground region projection');
{
  // Mirror at x = 10 facing -X (normal = [-1, 0]), width = 4 (z in [-2, 2]), y in [0, 5]
  const m = { center: [10, 2.5, 0], normal: [-1, 0], width: 4, height: 5 };
  // Virtual light at Lp = [15, 10, 0] (5 units behind mirror, height 10)
  // Bottom edge y=0 => t0 = 10/10 = 1 => x=10, z in [-2, 2]
  // Top edge y=5 => t1 = 10/(10-5) = 2 => x = 15 + (10-15)*2 = 5, z in [-4, 4]
  // Expected trapezoid: x from 5 to 10, width 4 at x=10 and width 8 at x=5 => area = (4 + 8)/2 * 5 = 30
  const reg = Geo.mirrorGroundRegion([15, 10, 0], m);
  check('mirror below virtual light projects to 4-vertex convex trapezoid', reg.length === 4);
  const area = Geo.polygonArea(reg);
  check('projected trapezoid has exact expected area (30)', Math.abs(area - 30) < 1e-6, 'area=' + area.toFixed(4));
  check('projected region contains interior point (7.5, 0)', Geo.pointInPolygon(7.5, 0, reg) === true);
  check('projected region excludes point outside lateral frustum (7.5, 5)', Geo.pointInPolygon(7.5, 5, reg) === false);
  check('projected region excludes point on far side of mirror (11, 0)', Geo.pointInPolygon(11, 0, reg) === false);

  // Mirror extending above virtual light (y in [0, 12], Lp.y = 10)
  const mTall = { center: [10, 6, 0], normal: [-1, 0], width: 4, height: 12 };
  const regTall = Geo.mirrorGroundRegion([15, 10, 0], mTall);
  check('mirror taller than virtual light is clipped below Lp.y', regTall.length === 4 && Geo.polygonArea(regTall) > 30);
  const allFront = regTall.every(p => Geo.mirrorDist([p[0], 0, p[1]], mTall) >= -1e-6);
  check('clipped tall-mirror region stays strictly in front of mirror plane', allFront);

  // Mirror entirely above virtual light (y in [11, 15], Lp.y = 10)
  const mHigh = { center: [10, 13, 0], normal: [-1, 0], width: 4, height: 4 };
  check('mirror entirely above virtual light projects to empty region', Geo.mirrorGroundRegion([15, 10, 0], mHigh).length === 0);

  // Virtual light in front of mirror (invalid reflection state)
  check('virtual light in front of mirror returns empty region', Geo.mirrorGroundRegion([8, 10, 0], m).length === 0);
}

/* ---------- 2. Convex polygon clipping ---------- */
console.log('\n2. Convex polygon clipping');
{
  const sqA = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const sqB = [[2, 1], [6, 1], [6, 3], [2, 3]];
  const sqDisjoint = [[10, 10], [12, 10], [12, 12], [10, 12]];

  const inter = Geo.clipConvexPolygon(sqA, sqB);
  check('partial overlap produces 4-vertex rectangle [2..4]x[1..3]', inter.length === 4);
  check('partial overlap area is exact (4.0)', Math.abs(Geo.polygonArea(inter) - 4) < 1e-6);

  const interCW = Geo.clipConvexPolygon(sqA, sqB.slice().reverse());
  check('clipping is invariant to CW vs CCW clip polygon winding', Math.abs(Geo.polygonArea(interCW) - 4) < 1e-6);

  const contained = Geo.clipConvexPolygon([[1, 1], [3, 1], [3, 3], [1, 3]], sqA);
  check('fully contained polygon is preserved unchanged', Math.abs(Geo.polygonArea(contained) - 4) < 1e-6);

  const empty = Geo.clipConvexPolygon(sqA, sqDisjoint);
  check('disjoint polygons clip to empty []', empty.length === 0);
}

/* ---------- 3. Continuous shrinking & spike bevel ---------- */
console.log('\n3. Continuous shrinking across mirror edge & spike bevel');
{
  // Synthetic stage with a single slab in front of a mirror
  const synthStage = {
    platforms: [],
    light: { pivot: [0, 0], radius: 10, height: 10, minH: 9, maxH: 12, theta0: 0 },
    occluders: [
      { kind: 'slab', pos: [0, 4, 0], size: [4.5, 0.4, 2.0] }
    ],
    mirror: { center: [14, 5.25, 0], normal: [-1, 0], width: 8.0, height: 10.5 },
    sentinels: []
  };

  const areas = [];
  let maxJump = 0;
  let sawFull = false, sawPartial = false, sawZero = false;
  let maxUnclippedLossRatio = 0;
  let maxGrazingLossRatio = 0;
  let primaryUnchanged = true;

  const stepDeg = 0.25;
  for (let th = 295; th <= 360; th += stepDeg) {
    const s = { theta: th * DEG, height: 10, time: 0 };
    const w = World.compute(synthStage, s);
    const prim = w.polys.find(p => p.src === 0);
    const expectedPrim = Geo.projectShadow(w.L, w.occ[0].verts);
    if (!prim || Math.abs(Geo.polygonArea(prim.pts) - Geo.polygonArea(expectedPrim)) > 1e-9) {
      primaryUnchanged = false;
    }

    const refl = w.polys.find(p => p.src === 1);
    const a = refl ? Geo.polygonArea(refl.pts) : 0;
    const raw = Geo.projectShadow(w.mirror.Lp, w.occ[0].verts);
    const rawArea = Geo.polygonArea(raw);
    const mPoly = Geo.mirrorGroundRegion(w.mirror.Lp, synthStage.mirror);
    const exactClip = Geo.clipConvexPolygon(raw, mPoly);
    const exactClipArea = Geo.polygonArea(exactClip);

    // Check area loss of trimSpikes vs raw unclipped polygon
    const lossFromBevel = Math.max(0, exactClipArea - a);
    if ( Math.abs(exactClipArea - rawArea) < 1e-5 ) {
      // Outside the clipping/grazing zone: bevel loss must be 0
      maxUnclippedLossRatio = Math.max(maxUnclippedLossRatio, lossFromBevel / rawArea);
    } else if (exactClipArea > 0) {
      // Inside the grazing clip zone: bevel removes only a thin needle sliver (< 10% of unclipped polygon)
      maxGrazingLossRatio = Math.max(maxGrazingLossRatio, lossFromBevel / rawArea);
    }

    if (areas.length > 0) {
      const jump = Math.abs(a - areas[areas.length - 1]);
      if (jump > maxJump) maxJump = jump;
    }
    areas.push(a);
    if (a === 0) sawZero = true;
    else if (a > 0.1 && a < rawArea * 0.85) sawPartial = true;
    else if (a >= rawArea * 0.98) sawFull = true;
  }

  check('sweeping theta transitions through zero, partial, and full reflected shadow', sawZero && sawPartial && sawFull);
  check('reflected shadow shrinks continuously with no single-step area jump > 2.0', maxJump < 2.0, 'maxJump=' + maxJump.toFixed(4));
  check('spike bevel removes 0% area outside the grazing clip zone', maxUnclippedLossRatio < 1e-6, 'loss=' + (maxUnclippedLossRatio * 100).toFixed(4) + '%');
  check('spike bevel removes < 10% of unclipped shadow area during grazing clip', maxGrazingLossRatio < 0.10, 'maxLoss=' + (maxGrazingLossRatio * 100).toFixed(2) + '%');
  check('primary shadows (src=0) are never modified by mirror clipping or spike bevel', primaryUnchanged);

  // Also verify continuous area transitions on Stage 3 and Stage 6 mirrors
  for (const [stIdx, occIdx, label] of [[2, 1, 'Stage 3'], [5, 0, 'Stage 6']]) {
    const st = STAGES[stIdx];
    let prev = null, worst = 0;
    for (let th = 0; th <= 360; th += 0.25) {
      const w = World.compute(st, { theta: th * DEG, height: st.light.height, time: 0 });
      const mp = w.polys.find(p => p.src === 1 && p.occ === occIdx);
      const area = mp ? Geo.polygonArea(mp.pts) : 0;
      if (prev !== null) worst = Math.max(worst, Math.abs(area - prev));
      prev = area;
    }
    check(label + ' reflected shadow has no single-step area jump > 2.5 across full 360° sweep', worst < 2.5, 'maxJump=' + worst.toFixed(4));
  }
}

/* ---------- 4. Far-side rejection ---------- */
console.log('\n4. Far-side rejection');
{
  const farStage = {
    platforms: [],
    light: { pivot: [0, 0], radius: 8, height: 10, minH: 9, maxH: 12, theta0: 0 },
    occluders: [
      // Behind the mirror plane x = 10 (normal = [-1, 0], so x > 10 is far side)
      { kind: 'slab', pos: [12.5, 4, 0], size: [2, 1, 2] },
      // On the mirror plane (offset in z so it does not physically block the mirror center)
      { kind: 'slab', pos: [10.0, 4, 5], size: [2, 1, 2] },
      // Valid front-side occluder
      { kind: 'slab', pos: [4.0, 4, 0], size: [2, 1, 2] }
    ],
    // Mirror extends below y = 0 (center.y = 4, height = 10 => y in [-1, 9])
    mirror: { center: [10, 4, 0], normal: [-1, 0], width: 6, height: 10 },
    sentinels: []
  };

  const w = World.compute(farStage, { theta: 0, height: 10, time: 0 });
  const reflOccs = w.polys.filter(p => p.src === 1).map(p => p.occ);
  check('occluders on or behind the mirror plane cast no reflected shadow', !reflOccs.includes(0) && !reflOccs.includes(1));
  check('front-side occluder casts a reflected shadow', reflOccs.includes(2));

  let anyFarVertex = false;
  for (let th = 0; th < 360; th += 5) {
    const wt = World.compute(farStage, { theta: th * DEG, height: 10, time: 0 });
    for (const poly of wt.polys) {
      if (poly.src !== 1) continue;
      for (const pt of poly.pts) {
        if (Geo.mirrorDist([pt[0], 0, pt[1]], farStage.mirror) < -1e-6) anyFarVertex = true;
      }
    }
  }
  check('no reflected shadow vertex ever appears on the far side of the mirror plane', !anyFarVertex);
}

/* ---------- 5. Blocking (L -> mirror and mirror -> occluder) ---------- */
console.log('\n5. Blocking (incoming L -> mirror and reflected mirror -> occluder)');
{
  // Lamp at theta=0 is at [6, 10, 0]. Mirror at [12, 5, 0] facing -X (normal = [-1, 0]).
  // Virtual light Lp = [18, 10, 0].
  // Target occluder at [0, 4, 0] (ray Lp -> target crosses mirror at [12, 8, 0]).
  // Incoming segment L=[6,10,0] -> hit=[12,8,0] passes through [9, 9, 0].
  // Reflected segment hit=[12,8,0] -> target=[0,4,0] passes through [6, 6, 0].
  function makeBlockStage(blockerSpec) {
    const occluders = [{ kind: 'slab', pos: [0, 4, 0], size: [2, 0.8, 2] }];
    if (blockerSpec) occluders.push(blockerSpec);
    return {
      platforms: [],
      light: { pivot: [0, 0], radius: 6, height: 10, minH: 9, maxH: 12, theta0: 0 },
      occluders: occluders,
      mirror: { center: [12, 5, 0], normal: [-1, 0], width: 8, height: 10 },
      sentinels: []
    };
  }

  const s0 = { theta: 0, height: 10, time: 0 };
  const wClear = World.compute(makeBlockStage(null), s0);
  check('unblocked target occluder casts reflected shadow', wClear.polys.some(p => p.src === 1 && p.occ === 0));

  // Blocker on incoming segment L=[6,10,0] -> hit=[12,8,0] at [9, 9, 0]
  const wIncomingBlocked = World.compute(makeBlockStage({ kind: 'slab', pos: [9, 9, 0], size: [2, 2.5, 4] }), s0);
  check('blocker on incoming segment (L -> mirror) blocks target reflected shadow',
    !wIncomingBlocked.polys.some(p => p.src === 1 && p.occ === 0));

  // Blocker on reflected segment hit=[12,8,0] -> target=[0,4,0] at [6, 6, 0] (below L=[6,10,0] so L->hit is clear)
  const wReflectedBlocked = World.compute(makeBlockStage({ kind: 'slab', pos: [6, 6, 0], size: [2, 2.2, 4] }), s0);
  check('blocker on reflected segment (mirror -> occluder) blocks target reflected shadow',
    !wReflectedBlocked.polys.some(p => p.src === 1 && p.occ === 0));

  // Blocker moved off to the side z = 6
  const wAside = World.compute(makeBlockStage({ kind: 'slab', pos: [6, 6, 6], size: [2, 2.2, 2] }), s0);
  check('blocker moved off the ray path leaves target reflected shadow active',
    wAside.polys.some(p => p.src === 1 && p.occ === 0));

  // Blocker placed behind target occluder (between target [0,4,0] and floor [-6,2,0]) does not block mirror -> target
  const wBehindTarget = World.compute(makeBlockStage({ kind: 'slab', pos: [-5, 1.5, 0], size: [2, 1.5, 4] }), s0);
  check('occluder beyond target (between target and floor) does not block mirror -> target',
    wBehindTarget.polys.some(p => p.src === 1 && p.occ === 0));
}

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL MIRROR CHECKS PASSED');
process.exit(failures ? 1 : 0);
