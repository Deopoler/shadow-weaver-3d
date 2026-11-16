/*
 * Chiaroscuro: Shadow Weaver — rendering, input, game loop.
 * Booted from index.html once three.js and its post-processing addons are imported.
 */
(function (root) {
  'use strict';
  var SW = root.SW = root.SW || {};

  SW.boot = function (deps) {
    var THREE = deps.THREE;
    var Geo = SW.Geo, World = SW.World, Audio = SW.Audio, STAGES = SW.STAGES, SH = SW.Shaders;
    var DEG = Geo.DEG;
    var $ = function (id) { return document.getElementById(id); };

    /* ================================================================ */
    /* Tunables                                                          */
    /* ================================================================ */
    var SPEED = 4.0;          // run speed (units / s)
    var JUMP_V = 6.0;         // jump impulse
    var GRAVITY = 22.0;
    var PLAYER_R = 0.32;
    var FLOOR_Y = 0.015;      // height of the shadow-bridge mesh above the floor plane
    var DETECT_TIME = 1.25;   // seconds of exposure until caught
    var DETECT_DECAY = 0.55;  // gauge drain per second while hidden
    var MAXV = 16;            // max hull vertices per shadow polygon
    var BRIDGE_POOL = 10;

    /* ================================================================ */
    /* Renderer / scene / post-processing                                */
    /* ================================================================ */
    var canvas = $('game');
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: 'high-performance' });
    var pixelRatio = Math.min(root.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(root.innerWidth, root.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030409);
    scene.fog = new THREE.FogExp2(0x030409, 0.017);

    var camera = new THREE.PerspectiveCamera(42, root.innerWidth / root.innerHeight, 0.5, 240);

    var bufW = Math.floor(root.innerWidth * pixelRatio), bufH = Math.floor(root.innerHeight * pixelRatio);
    var composerTarget = new THREE.WebGLRenderTarget(bufW, bufH, { type: THREE.HalfFloatType, samples: 4 });
    var composer = new deps.EffectComposer(renderer, composerTarget);
    composer.addPass(new deps.RenderPass(scene, camera));
    var bloomPass = new deps.UnrealBloomPass(new THREE.Vector2(bufW, bufH), 0.85, 0.72, 1.0);
    composer.addPass(bloomPass);
    var finalPass = new deps.ShaderPass(SH.finalPass);
    composer.addPass(finalPass);
    composer.addPass(new deps.OutputPass());

    var uTime = { value: 0 };           // shared by every animated material
    var uPointScale = { value: bufH * 0.5 };

    /** Pre-multiplied additive blending for glow materials. */
    function additive(params) {
      params.transparent = true;
      params.depthWrite = false;
      params.blending = THREE.CustomBlending;
      params.blendEquation = THREE.AddEquation;
      params.blendSrc = THREE.OneFactor;
      params.blendDst = THREE.OneFactor;
      return params;
    }

    function hdr(r, g, b) { return new THREE.Color().setRGB(r, g, b); }

    /* ================================================================ */
    /* Persistent scene content                                          */
    /* ================================================================ */
    scene.add(new THREE.HemisphereLight(0x7f95c8, 0x0b0c14, 0.42));
    var moon = new THREE.DirectionalLight(0x8fa6dc, 0.32);
    moon.position.set(-14, 30, 18);
    scene.add(moon);

    var stageGroup = new THREE.Group();
    scene.add(stageGroup);

    /* ---------- volumetric cone factory ---------- */
    var coneGeo = new THREE.ConeGeometry(1, 1, 56, 10, true);
    coneGeo.translate(0, -0.5, 0); // apex at origin, opening towards -Y
    var DOWN = new THREE.Vector3(0, -1, 0);
    var tmpV = new THREE.Vector3();

    function makeCone(color, intensity, falloff, decay, edge) {
      var mat = new THREE.ShaderMaterial(additive({
        uniforms: {
          uColor: { value: color },
          uIntensity: { value: intensity },
          uFalloff: { value: falloff },
          uDecay: { value: decay },
          uEdge: { value: edge },
          uTime: uTime
        },
        vertexShader: SH.coneVert,
        fragmentShader: SH.coneFrag,
        side: THREE.DoubleSide
      }));
      var mesh = new THREE.Mesh(coneGeo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      return mesh;
    }

    /** Place a cone with its apex at `apex`, pointing at `target`, `length` long with end radius `radius`. */
    function aimCone(mesh, apex, target, length, radius) {
      tmpV.copy(target).sub(apex);
      if (tmpV.lengthSq() < 1e-8) tmpV.set(0, -1, 0);
      tmpV.normalize();
      mesh.position.copy(apex);
      mesh.quaternion.setFromUnitVectors(DOWN, tmpV);
      mesh.scale.set(radius, length, radius);
    }

    /* ---------- shadow bridge pool ---------- */
    var bridges = [];
    (function buildBridgePool() {
      var index = [];
      for (var i = 0; i < MAXV; i++) index.push(0, i + 1, i + 2);
      for (var b = 0; b < BRIDGE_POOL; b++) {
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((MAXV + 2) * 3), 3));
        geo.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(MAXV + 2), 1));
        geo.setAttribute('aPerim', new THREE.BufferAttribute(new Float32Array(MAXV + 2), 1));
        geo.setIndex(index);
        var mat = new THREE.ShaderMaterial({
          uniforms: { uTime: uTime, uTint: { value: 0 }, uOpacity: { value: 1 } },
          vertexShader: SH.bridgeVert,
          fragmentShader: SH.bridgeFrag,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2
        });
        var mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 2;
        mesh.visible = false;
        scene.add(mesh);

        var lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((MAXV + 1) * 3), 3));
        var lineMat = new THREE.LineBasicMaterial({ color: hdr(0.35, 1.7, 1.75), transparent: true, depthWrite: false });
        var line = new THREE.Line(lineGeo, lineMat);
        line.frustumCulled = false;
        line.renderOrder = 3;
        line.visible = false;
        scene.add(line);
        bridges.push({ mesh: mesh, line: line });
      }
    })();

    var COLOR_PRIMARY_LINE = hdr(0.45, 1.55, 1.8);
    var COLOR_MIRROR_LINE = hdr(0.9, 1.9, 1.9);

    function syncBridges(polys) {
      for (var b = 0; b < bridges.length; b++) {
        var slot = bridges[b];
        if (b >= polys.length) { slot.mesh.visible = false; slot.line.visible = false; continue; }
        var poly = polys[b], pts = poly.pts;
        var n = Math.min(pts.length, MAXV);
        var geo = slot.mesh.geometry;
        var pos = geo.attributes.position.array;
        var edge = geo.attributes.aEdge.array;
        var perim = geo.attributes.aPerim.array;
        var lpos = slot.line.geometry.attributes.position.array;
        var c = Geo.polygonCentroid(pts);
        var total = 0, k;
        for (k = 0; k < n; k++) {
          var a = pts[k], nb = pts[(k + 1) % n];
          total += Math.hypot(nb[0] - a[0], nb[1] - a[1]);
        }
        pos[0] = c[0]; pos[1] = FLOOR_Y; pos[2] = c[1];
        edge[0] = 0; perim[0] = total * 0.5;
        var acc = 0;
        for (k = 0; k <= n; k++) {
          var p = pts[k % n];
          var o = (k + 1) * 3;
          pos[o] = p[0]; pos[o + 1] = FLOOR_Y; pos[o + 2] = p[1];
          edge[k + 1] = 1;
          perim[k + 1] = acc;
          lpos[k * 3] = p[0]; lpos[k * 3 + 1] = FLOOR_Y + 0.012; lpos[k * 3 + 2] = p[1];
          var q = pts[(k + 1) % n];
          acc += Math.hypot(q[0] - p[0], q[1] - p[1]);
        }
        geo.attributes.position.needsUpdate = true;
        geo.attributes.aEdge.needsUpdate = true;
        geo.attributes.aPerim.needsUpdate = true;
        geo.setDrawRange(0, n * 3);
        // shadows of grounded cover pillars are solid too, but drawn quieter than the floating weavers
        var quiet = !!stage.occluders[poly.occ].solid;
        slot.mesh.material.uniforms.uTint.value = poly.src;
        slot.mesh.material.uniforms.uOpacity.value = quiet ? 0.55 : 1;
        slot.line.material.opacity = quiet ? 0.3 : 1;
        slot.mesh.visible = true;
        slot.line.geometry.attributes.position.needsUpdate = true;
        slot.line.geometry.setDrawRange(0, n + 1);
        slot.line.material.color.copy(poly.src ? COLOR_MIRROR_LINE : COLOR_PRIMARY_LINE);
        slot.line.visible = true;
      }
    }

    /* ---------- player ---------- */
    var player = {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      grounded: true, sunk: false, coyote: 0, jumpBuf: 0,
      onBridge: false, facing: 0, stepDist: 0, wasAir: false,
      mesh: new THREE.Group()
    };
    (function buildPlayer() {
      var cloth = new THREE.MeshStandardMaterial({ color: 0x0b0c13, roughness: 0.55, metalness: 0.15 });
      var body = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.3, 0.82, 20, 1), cloth);
      body.position.y = 0.41;
      body.castShadow = true;
      var head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 14), cloth);
      head.position.y = 0.98;
      head.castShadow = true;
      var core = new THREE.Mesh(new THREE.SphereGeometry(0.095, 16, 12), new THREE.MeshBasicMaterial({ color: hdr(0.9, 2.6, 2.9) }));
      core.position.set(0, 0.62, 0.17);
      var halo = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.012, 8, 48), new THREE.MeshBasicMaterial({ color: hdr(0.5, 1.9, 2.2) }));
      halo.position.y = 0.6;
      halo.rotation.x = Math.PI / 2;
      var halo2 = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.008, 8, 40), new THREE.MeshBasicMaterial({ color: hdr(1.3, 0.7, 2.4) }));
      halo2.position.y = 0.6;
      var glow = new THREE.PointLight(0x7fe9ff, 1.3, 7, 2);
      glow.position.set(0, 0.8, 0);
      player.mesh.add(body, head, core, halo, halo2, glow);
      player.halo = halo;
      player.halo2 = halo2;
      player.core = core;
      scene.add(player.mesh);
    })();

    /* ---------- trail particles ---------- */
    var TRAIL_N = 240;
    var trail = { pos: new Float32Array(TRAIL_N * 3), life: new Float32Array(TRAIL_N), size: new Float32Array(TRAIL_N), vel: new Float32Array(TRAIL_N * 3), next: 0, acc: 0 };
    (function buildTrail() {
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(trail.pos, 3));
      geo.setAttribute('aLife', new THREE.BufferAttribute(trail.life, 1));
      geo.setAttribute('aSize', new THREE.BufferAttribute(trail.size, 1));
      var mat = new THREE.ShaderMaterial(additive({
        uniforms: { uScale: uPointScale },
        vertexShader: SH.trailVert,
        fragmentShader: SH.trailFrag
      }));
      trail.points = new THREE.Points(geo, mat);
      trail.points.frustumCulled = false;
      trail.points.renderOrder = 7;
      scene.add(trail.points);
    })();

    function spawnTrail(x, y, z, spread, up) {
      var i = trail.next;
      trail.next = (trail.next + 1) % TRAIL_N;
      trail.pos[i * 3] = x + (Math.random() - 0.5) * spread;
      trail.pos[i * 3 + 1] = y + Math.random() * 0.7;
      trail.pos[i * 3 + 2] = z + (Math.random() - 0.5) * spread;
      trail.vel[i * 3] = (Math.random() - 0.5) * 0.5;
      trail.vel[i * 3 + 1] = up + Math.random() * 0.6;
      trail.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
      trail.life[i] = 1;
      trail.size[i] = 0.22 + Math.random() * 0.26;
    }

    function updateTrail(dt) {
      for (var i = 0; i < TRAIL_N; i++) {
        if (trail.life[i] <= 0) continue;
        trail.life[i] = Math.max(0, trail.life[i] - dt * 1.35);
        trail.pos[i * 3] += trail.vel[i * 3] * dt;
        trail.pos[i * 3 + 1] += trail.vel[i * 3 + 1] * dt;
        trail.pos[i * 3 + 2] += trail.vel[i * 3 + 2] * dt;
      }
      var g = trail.points.geometry;
      g.attributes.position.needsUpdate = true;
      g.attributes.aLife.needsUpdate = true;
      g.attributes.aSize.needsUpdate = true;
    }

    /* ---------- ripples ---------- */
    var ripples = [];
    (function buildRipples() {
      var geo = new THREE.PlaneGeometry(1, 1);
      geo.rotateX(-Math.PI / 2);
      for (var i = 0; i < 16; i++) {
        var mat = new THREE.ShaderMaterial(additive({
          uniforms: { uProgress: { value: 1 }, uColor: { value: hdr(0.3, 1.0, 1.0) } },
          vertexShader: SH.rippleVert,
          fragmentShader: SH.rippleFrag,
          side: THREE.DoubleSide
        }));
        var mesh = new THREE.Mesh(geo, mat);
        mesh.visible = false;
        mesh.renderOrder = 4;
        scene.add(mesh);
        ripples.push({ mesh: mesh, t: 1, dur: 1 });
      }
    })();
    var rippleNext = 0;

    function spawnRipple(x, z, size, dur, r, g, b) {
      var rp = ripples[rippleNext];
      rippleNext = (rippleNext + 1) % ripples.length;
      rp.t = 0;
      rp.dur = dur;
      rp.mesh.position.set(x, FLOOR_Y + 0.02, z);
      rp.mesh.scale.set(size, 1, size);
      rp.mesh.material.uniforms.uColor.value.setRGB(r, g, b);
      rp.mesh.material.uniforms.uProgress.value = 0;
      rp.mesh.visible = true;
    }

    function updateRipples(dt) {
      for (var i = 0; i < ripples.length; i++) {
        var rp = ripples[i];
        if (!rp.mesh.visible) continue;
        rp.t += dt / rp.dur;
        if (rp.t >= 1) { rp.mesh.visible = false; continue; }
        rp.mesh.material.uniforms.uProgress.value = rp.t;
      }
    }

    /* ---------- ambient dust ---------- */
    (function buildDust() {
      var N = 320;
      var pos = new Float32Array(N * 3), seed = new Float32Array(N);
      for (var i = 0; i < N; i++) {
        pos[i * 3] = (Math.random() - 0.5) * 90;
        pos[i * 3 + 1] = -6 + Math.random() * 22;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 80;
        seed[i] = Math.random();
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      var pts = new THREE.Points(geo, new THREE.ShaderMaterial(additive({
        uniforms: { uTime: uTime, uScale: uPointScale },
        vertexShader: SH.dustVert,
        fragmentShader: SH.dustFrag
      })));
      pts.frustumCulled = false;
      pts.renderOrder = 5;
      scene.add(pts);
    })();

    /* ================================================================ */
    /* Stage construction                                                */
    /* ================================================================ */
    var stage = null;
    var stageIndex = 0;
    var sim = { theta: 0, height: 10, time: 0, thetaVel: 0, heightVel: 0 };
    var world = null;
    var view = null; // per-stage render objects

    var MAT_STONE = new THREE.MeshStandardMaterial({ color: 0xd6d1c6, roughness: 0.86, metalness: 0.0, vertexColors: true });
    var MAT_FAR = new THREE.MeshStandardMaterial({ color: 0x343848, roughness: 0.95, metalness: 0.0, vertexColors: true });
    var MAT_OBSIDIAN = new THREE.MeshStandardMaterial({ color: 0x15171f, roughness: 0.42, metalness: 0.35, flatShading: true });
    var MAT_PILLAR = new THREE.MeshStandardMaterial({ color: 0xbdb8ae, roughness: 0.8, metalness: 0.0, flatShading: true });
    var SHARED_MATERIALS = [MAT_STONE, MAT_FAR, MAT_OBSIDIAN, MAT_PILLAR];

    function disposeGroup(group) {
      group.traverse(function (obj) {
        if (obj.isLight && obj.shadow && obj.shadow.map) obj.shadow.map.dispose();
        if (obj.geometry && obj.geometry !== coneGeo) obj.geometry.dispose();
        if (obj.material && SHARED_MATERIALS.indexOf(obj.material) < 0) obj.material.dispose();
      });
      while (group.children.length) group.remove(group.children[0]);
    }

    /** Box whose vertex colours fade to black towards the bottom, so towers dissolve into the abyss. */
    function towerGeometry(w, h, d, fadePower) {
      var geo = new THREE.BoxGeometry(w, h, d);
      var pos = geo.attributes.position;
      var col = new Float32Array(pos.count * 3);
      for (var i = 0; i < pos.count; i++) {
        // clamp: float32 rounding can push t slightly below 0, and pow(negative) is NaN (which poisons bloom)
        var t = Math.max(0, Math.min(1, (pos.getY(i) + h / 2) / h));
        var c = Math.pow(t, fadePower);
        col[i * 3] = c; col[i * 3 + 1] = c; col[i * 3 + 2] = c;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return geo;
    }

    function hexaGeometry(spec) {
      var v = Geo.hexaLocal(spec);
      var arr = [];
      for (var f = 0; f < Geo.HEXA_FACES.length; f++) {
        var q = Geo.HEXA_FACES[f];
        var tri = [q[0], q[1], q[2], q[0], q[2], q[3]];
        for (var k = 0; k < 6; k++) arr.push(v[tri[k]][0], v[tri[k]][1], v[tri[k]][2]);
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
      geo.computeVertexNormals();
      return geo;
    }

    function mulberry(seed) {
      var a = seed >>> 0;
      return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        var t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function configureShadow(light, mapSize, far) {
      light.castShadow = true;
      light.shadow.mapSize.set(mapSize, mapSize);
      light.shadow.camera.near = 0.8;
      light.shadow.camera.far = far;
      light.shadow.bias = -0.0006;
      light.shadow.normalBias = 0.03;
    }

    function buildStage(st) {
      disposeGroup(stageGroup);
      var v = { occ: [], sentinels: [], mirror: null };
      var i;

      // bounds
      var bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
      for (i = 0; i < st.platforms.length; i++) {
        var pl = st.platforms[i];
        bx0 = Math.min(bx0, pl.x0); bx1 = Math.max(bx1, pl.x1);
        bz0 = Math.min(bz0, pl.z0); bz1 = Math.max(bz1, pl.z1);
      }
      var cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
      v.center = [cx, cz];

      // platforms: monolithic towers rising out of the abyss
      for (i = 0; i < st.platforms.length; i++) {
        var p = st.platforms[i];
        var w = p.x1 - p.x0, d = p.z1 - p.z0, H = 46;
        var tower = new THREE.Mesh(towerGeometry(w, H, d, 2.4), MAT_STONE);
        tower.position.set((p.x0 + p.x1) / 2, -H / 2, (p.z0 + p.z1) / 2);
        tower.receiveShadow = true;
        stageGroup.add(tower);
        // thin inset trim line around the top edge
        var trim = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(p.x0 + 0.25, 0.012, p.z0 + 0.25), new THREE.Vector3(p.x1 - 0.25, 0.012, p.z0 + 0.25),
            new THREE.Vector3(p.x1 - 0.25, 0.012, p.z1 - 0.25), new THREE.Vector3(p.x0 + 0.25, 0.012, p.z1 - 0.25)
          ]),
          new THREE.LineBasicMaterial({ color: 0x4b5068, transparent: true, opacity: 0.8 })
        );
        stageGroup.add(trim);
        // a recessed plinth band below the lip for architectural relief
        var band = new THREE.Mesh(towerGeometry(w + 0.5, 0.5, d + 0.5, 0.01), MAT_STONE);
        band.position.set(tower.position.x, -1.6, tower.position.z);
        band.receiveShadow = true;
        stageGroup.add(band);
      }

      // distant monoliths
      var rnd = mulberry(st.id * 7919 + 13);
      for (i = 0; i < 30; i++) {
        var ang = rnd() * Math.PI * 2;
        var dist = 38 + rnd() * 60;
        var mw = 3 + rnd() * 7, md = 3 + rnd() * 7, mh = 40 + rnd() * 70;
        var mono = new THREE.Mesh(towerGeometry(mw, mh, md, 1.6), MAT_FAR);
        mono.position.set(cx + Math.cos(ang) * dist, -mh / 2 + (rnd() * 26 - 8), cz + Math.sin(ang) * dist * 0.85 - 10);
        stageGroup.add(mono);
      }

      // occluders
      for (i = 0; i < st.occluders.length; i++) {
        var oc = st.occluders[i];
        var mesh = new THREE.Mesh(hexaGeometry(oc), oc.solid ? MAT_PILLAR : MAT_OBSIDIAN);
        mesh.castShadow = true;
        mesh.receiveShadow = !!oc.solid;
        mesh.position.set(oc.pos[0], oc.pos[1], oc.pos[2]);
        mesh.rotation.y = (oc.rotY || 0) * DEG;
        stageGroup.add(mesh);
        if (!oc.solid) {
          var edgeColor = oc.bob ? hdr(0.5, 1.5, 1.5) : hdr(0.75, 0.55, 1.6);
          var edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 20), new THREE.LineBasicMaterial({ color: edgeColor }));
          mesh.add(edges);
        }
        v.occ.push(mesh);
      }

      // the lamp
      var lamp = new THREE.Group();
      var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 14), new THREE.MeshBasicMaterial({ color: hdr(4.2, 3.6, 2.6) }));
      var ringA = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.03, 8, 40), new THREE.MeshBasicMaterial({ color: hdr(1.5, 1.25, 0.85) }));
      var ringB = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.014, 8, 48), new THREE.MeshBasicMaterial({ color: hdr(0.5, 0.9, 1.2) }));
      ringB.rotation.x = Math.PI / 2;
      lamp.add(bulb, ringA, ringB);
      stageGroup.add(lamp);
      v.lamp = lamp; v.lampRingA = ringA; v.lampRingB = ringB;

      var railPts = [];
      for (i = 0; i <= 96; i++) {
        var ra = i / 96 * Math.PI * 2;
        railPts.push(new THREE.Vector3(st.light.pivot[0] + Math.cos(ra) * st.light.radius, 0, st.light.pivot[1] + Math.sin(ra) * st.light.radius));
      }
      v.rail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(railPts), new THREE.LineBasicMaterial({ color: 0x5a6a92, transparent: true, opacity: 0.55 }));
      stageGroup.add(v.rail);

      var spot = new THREE.SpotLight(0xfff0d8, 30, 0, 0.68, 0.55, 1);
      configureShadow(spot, 2048, 70);
      stageGroup.add(spot, spot.target);
      v.spot = spot;
      v.aim = new THREE.Vector3(st.light.pivot[0], 0, st.light.pivot[1]);
      v.lampCone = makeCone(hdr(1.0, 0.86, 0.62), 0.085, 1.25, 1.6, 1.6);
      stageGroup.add(v.lampCone);

      // mirror prism + reflected light
      if (st.mirror) {
        var m = st.mirror;
        var mirrorMat = new THREE.ShaderMaterial({
          uniforms: { uTime: uTime, uActive: { value: 0 } },
          vertexShader: SH.mirrorVert,
          fragmentShader: SH.mirrorFrag
        });
        var slab = new THREE.Mesh(new THREE.BoxGeometry(m.width, m.height, 0.35), mirrorMat);
        slab.position.set(m.center[0] - m.normal[0] * 0.18, m.center[1], m.center[2] - m.normal[1] * 0.18);
        slab.rotation.y = Math.atan2(m.normal[0], m.normal[1]);
        var frameMat = new THREE.LineBasicMaterial({ color: hdr(0.5, 1.2, 1.4) });
        slab.add(new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), frameMat));
        stageGroup.add(slab);
        var mspot = new THREE.SpotLight(0xa8f4ff, 0, 0, 0.45, 0.5, 1);
        configureShadow(mspot, 1024, 80);
        stageGroup.add(mspot, mspot.target);
        var mcone = makeCone(hdr(0.45, 0.95, 1.0), 0.16, 1.1, 1.2, 1.5);
        mcone.visible = false;
        stageGroup.add(mcone);
        // beam from the lamp to the mirror
        var beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.05, 0.05, 1, 10, 1, true),
          new THREE.MeshBasicMaterial(additive({ color: hdr(0.9, 0.85, 0.6) }))
        );
        beam.visible = false;
        beam.frustumCulled = false;
        stageGroup.add(beam);
        var spark = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), new THREE.MeshBasicMaterial({ color: hdr(2.2, 3.4, 3.6) }));
        spark.visible = false;
        stageGroup.add(spark);
        v.mirror = { slab: slab, mat: mirrorMat, spot: mspot, cone: mcone, beam: beam, spark: spark, level: 0, target: new THREE.Vector3() };
      }

      // sentinels
      for (i = 0; i < st.sentinels.length; i++) {
        var s = st.sentinels[i];
        var eye = new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 0), new THREE.MeshBasicMaterial({ color: hdr(3.6, 0.3, 0.25) }));
        eye.position.set(s.pos[0], s.pos[1], s.pos[2]);
        var cage = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.75, 0)), new THREE.LineBasicMaterial({ color: hdr(1.3, 0.2, 0.2) }));
        eye.add(cage);
        stageGroup.add(eye);
        var sl = new THREE.SpotLight(0xff2a22, 46, 0, s.cone * DEG, 0.25, 1);
        sl.position.copy(eye.position);
        configureShadow(sl, 1024, 60);
        stageGroup.add(sl, sl.target);
        var cone = makeCone(hdr(1.0, 0.1, 0.08), 0.5, 0.9, 0.8, 1.3);
        stageGroup.add(cone);
        v.sentinels.push({ eye: eye, cage: cage, light: sl, cone: cone, apex: eye.position.clone(), target: new THREE.Vector3(), heat: 0 });
      }

      // portal
      var portal = new THREE.Group();
      portal.position.set(st.portal[0], 0, st.portal[1]);
      var torus = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.05, 10, 72), new THREE.MeshBasicMaterial({ color: hdr(1.2, 1.5, 2.6) }));
      torus.position.y = 1.5;
      var torus2 = new THREE.Mesh(new THREE.TorusGeometry(1.32, 0.015, 8, 72), new THREE.MeshBasicMaterial({ color: hdr(1.1, 0.5, 2.0) }));
      torus2.position.y = 1.5;
      var disc = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 2.3), new THREE.ShaderMaterial(additive({
        uniforms: { uTime: uTime },
        vertexShader: SH.portalVert,
        fragmentShader: SH.portalFrag,
        side: THREE.DoubleSide
      })));
      disc.position.y = 1.5;
      var plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 0.16, 40), MAT_PILLAR);
      plinth.position.y = 0.08;
      plinth.receiveShadow = true;
      var plinthRing = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.02, 8, 64), new THREE.MeshBasicMaterial({ color: hdr(0.5, 1.2, 1.6) }));
      plinthRing.rotation.x = Math.PI / 2;
      plinthRing.position.y = 0.17;
      var plight = new THREE.PointLight(0x8e7bff, 5, 12, 2);
      plight.position.y = 1.6;
      portal.add(torus, torus2, disc, plinth, plinthRing, plight);
      stageGroup.add(portal);
      v.portal = portal; v.portalTorus2 = torus2;

      return v;
    }

    /* ================================================================ */
    /* Game state                                                        */
    /* ================================================================ */
    var state = 'title';       // title | playing | clear | ending
    var respawn = null;        // { t, type, moved }
    var clearT = 0;
    var exposure = 0;
    var checkpoint = 0;
    var stats = { time: 0, falls: 0, caught: 0, restarts: 0 };
    var fx = { glitch: 0, fade: 0, fadeTarget: 1 };
    var camFocus = new THREE.Vector3();
    var camZoom = 1;
    var keys = {};
    var drag = { active: false, x: 0, y: 0, activity: 0 };
    var toastTimer = 0;
    var bannerTimer = 0;

    function placePlayer(x, z) {
      player.x = x; player.y = 0; player.z = z;
      player.vx = 0; player.vy = 0; player.vz = 0;
      player.grounded = true; player.sunk = false; player.onBridge = false;
      player.coyote = 0; player.jumpBuf = 0; player.stepDist = 0;
      player.mesh.scale.setScalar(1);
      player.mesh.visible = true;
    }

    function showToast(text, danger) {
      var el = $('toast');
      el.textContent = text;
      el.className = 'toast show' + (danger ? ' danger' : '');
      toastTimer = 2.2;
    }

    function showBanner(st) {
      $('banner-kicker').textContent = 'STAGE ' + st.id + ' / ' + STAGES.length;
      $('banner-title').textContent = st.name;
      $('banner-sub').textContent = st.en;
      $('banner').className = 'banner show';
      bannerTimer = 3.0;
    }

    function loadStage(index, keepStats) {
      stageIndex = index;
      stage = STAGES[index];
      sim.theta = stage.light.theta0 * DEG;
      sim.height = stage.light.height;
      sim.time = 0;
      sim.thetaVel = 0;
      sim.heightVel = 0;
      view = buildStage(stage);
      world = World.compute(stage, sim);
      placePlayer(stage.start[0], stage.start[1]);
      checkpoint = World.platformAt(stage, player.x, player.z);
      exposure = 0;
      respawn = null;
      clearT = 0;
      camFocus.set(player.x * 0.62 + view.center[0] * 0.38, 0, player.z * 0.62 + view.center[1] * 0.38);
      for (var i = 0; i < TRAIL_N; i++) trail.life[i] = 0;
      $('hud-stage').textContent = 'STAGE ' + stage.id + ' / ' + STAGES.length;
      $('hud-name').textContent = stage.name;
      $('hud-hint').textContent = stage.hint;
      if (!keepStats) { /* stats persist across stages; nothing to reset here */ }
    }

    function restartStage() {
      if (state !== 'playing') return;
      stats.restarts++;
      Audio.restart();
      loadStage(stageIndex, true);
      fx.fade = 0.15;
      fx.fadeTarget = 1;
      showToast('스테이지 재시작');
    }

    function startRespawn(type) {
      if (respawn) return;
      respawn = { t: 0, type: type, moved: false };
      if (type === 'caught') {
        stats.caught++;
        Audio.caught();
        showToast('감시자에게 발각되었습니다', true);
      } else {
        stats.falls++;
        showToast('심연으로 추락했습니다');
      }
    }

    function updateRespawn(dt) {
      if (!respawn) {
        fx.glitch = Math.max(0, fx.glitch - dt * 4);
        return;
      }
      respawn.t += dt;
      var caught = respawn.type === 'caught';
      var total = caught ? 1.0 : 0.6;
      var swap = caught ? 0.5 : 0.25;
      var peak = caught ? 1.0 : 0.45;
      var k = respawn.t < swap ? respawn.t / swap : 1 - (respawn.t - swap) / (total - swap);
      fx.glitch = Math.max(0, Math.min(1, k)) * peak;
      if (!respawn.moved && respawn.t >= swap) {
        respawn.moved = true;
        var spawn;
        if (caught) {
          spawn = stage.start;
        } else {
          var plat = stage.platforms[Math.max(0, checkpoint)];
          spawn = plat.spawn || [(plat.x0 + plat.x1) / 2, (plat.z0 + plat.z1) / 2];
        }
        placePlayer(spawn[0], spawn[1]);
        checkpoint = World.platformAt(stage, spawn[0], spawn[1]);
        exposure = 0;
        spawnRipple(player.x, player.z, 3.2, 0.9, 0.5, 0.9, 1.0);
      }
      if (respawn.t >= total) { respawn = null; fx.glitch = 0; }
    }

    function showEnding() {
      state = 'ending';
      var t = Math.floor(stats.time);
      var mm = Math.floor(t / 60), ss = t % 60;
      $('end-time').textContent = (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
      $('end-falls').textContent = String(stats.falls);
      $('end-caught').textContent = String(stats.caught);
      $('ending').className = 'overlay show';
      $('hud').className = 'hud hidden';
      fx.fadeTarget = 0.28;
    }

    function beginGame() {
      Audio.init();
      $('title-screen').className = 'overlay';
      $('hud').className = 'hud';
      state = 'playing';
      showBanner(stage);
    }

    function replay() {
      Audio.init();
      stats.time = 0; stats.falls = 0; stats.caught = 0; stats.restarts = 0;
      $('ending').className = 'overlay';
      $('hud').className = 'hud';
      loadStage(0, false);
      state = 'playing';
      fx.fade = 0;
      fx.fadeTarget = 1;
      showBanner(stage);
    }

    /* ================================================================ */
    /* Input                                                             */
    /* ================================================================ */
    var GAME_KEYS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1, KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1, KeyQ: 1, KeyE: 1, KeyZ: 1, KeyX: 1, KeyR: 1 };

    root.addEventListener('keydown', function (e) {
      if (GAME_KEYS[e.code]) e.preventDefault();
      if (e.repeat) return;
      keys[e.code] = true;
      if (state === 'title' && (e.code === 'Enter' || e.code === 'Space')) { beginGame(); return; }
      if (state === 'ending' && e.code === 'Enter') { replay(); return; }
      if (e.code === 'Space') player.jumpBuf = 0.13;
      if (e.code === 'KeyR') restartStage();
      if (e.code === 'KeyM') toggleMute();
    });
    root.addEventListener('keyup', function (e) { keys[e.code] = false; });
    root.addEventListener('blur', function () { keys = {}; drag.active = false; });

    canvas.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      Audio.init();
      drag.active = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      canvas.classList.add('dragging');
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag.active || state !== 'playing' || respawn) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      sim.theta -= dx * 0.0065;
      sim.height = Math.max(stage.light.minH, Math.min(stage.light.maxH, sim.height - dy * 0.018));
      drag.activity = Math.min(1, drag.activity + (Math.abs(dx) + Math.abs(dy)) * 0.03);
    });
    function endDrag() { drag.active = false; canvas.classList.remove('dragging'); }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      camZoom = Math.max(0.65, Math.min(1.6, camZoom + (e.deltaY > 0 ? 0.08 : -0.08)));
    }, { passive: false });

    function toggleMute() {
      Audio.init();
      var m = Audio.toggleMute();
      var btn = $('btn-mute');
      btn.textContent = m ? '🔇' : '🔊';
      btn.setAttribute('aria-pressed', m ? 'true' : 'false');
      btn.title = m ? '사운드 켜기 (M)' : '사운드 끄기 (M)';
    }
    $('btn-mute').addEventListener('click', function (e) { toggleMute(); e.currentTarget.blur(); });
    $('btn-start').addEventListener('click', beginGame);
    $('btn-replay').addEventListener('click', replay);

    root.addEventListener('resize', function () {
      var w = root.innerWidth, h = root.innerHeight;
      pixelRatio = Math.min(root.devicePixelRatio || 1, 2);
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(w, h);
      composer.setSize(Math.floor(w * pixelRatio), Math.floor(h * pixelRatio));
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      uPointScale.value = h * pixelRatio * 0.5;
    });

    /* ================================================================ */
    /* Simulation                                                        */
    /* ================================================================ */
    var vA = new THREE.Vector3(), vB = new THREE.Vector3();
    var humLevel = 0;

    function updateLightControl(dt) {
      var canControl = state === 'playing' && !respawn;
      var dir = 0, lift = 0;
      if (canControl) {
        dir = (keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0);
        lift = (keys.KeyX ? 1 : 0) - (keys.KeyZ ? 1 : 0);
      }
      var omega = Math.max(0.5, Math.min(1.15, 7 / stage.light.radius));
      var k = 1 - Math.exp(-9 * dt);
      sim.thetaVel += (dir * omega - sim.thetaVel) * k;
      sim.heightVel += (lift * 2.2 - sim.heightVel) * k;
      sim.theta += sim.thetaVel * dt;
      sim.height = Math.max(stage.light.minH, Math.min(stage.light.maxH, sim.height + sim.heightVel * dt));
      drag.activity = Math.max(0, drag.activity - dt * 3.2);
      var target = Math.min(1, Math.abs(sim.thetaVel) / omega * 0.8 + Math.abs(sim.heightVel) / 2.2 * 0.5 + drag.activity);
      humLevel += (target - humLevel) * (1 - Math.exp(-10 * dt));
    }

    function syncStageVisuals(dt) {
      var i;
      var L = world.L;
      // occluders
      for (i = 0; i < view.occ.length; i++) view.occ[i].position.y = world.occ[i].y;

      // lamp + main spotlight aims through the floating occluders at their shadows
      var ax = 0, az = 0, n = 0;
      for (i = 0; i < world.polys.length; i++) {
        var poly = world.polys[i];
        if (poly.src !== 0 || stage.occluders[poly.occ].solid) continue;
        var c = Geo.polygonCentroid(poly.pts);
        var oc = world.occ[poly.occ].center;
        ax += (c[0] + oc[0]) * 0.5; az += (c[1] + oc[2]) * 0.5; n++;
      }
      if (n > 0) { ax /= n; az /= n; } else { ax = stage.light.pivot[0]; az = stage.light.pivot[1]; }
      // keep the aim within a sane distance so the pool never flies off to infinity
      var ddx = ax - L[0], ddz = az - L[2];
      var dl = Math.hypot(ddx, ddz);
      if (dl > 16) { ax = L[0] + ddx / dl * 16; az = L[2] + ddz / dl * 16; }
      var ak = 1 - Math.exp(-6 * dt);
      view.aim.x += (ax - view.aim.x) * ak;
      view.aim.z += (az - view.aim.z) * ak;

      view.lamp.position.set(L[0], L[1], L[2]);
      view.lampRingA.rotation.y += dt * 0.8;
      view.lampRingA.rotation.x += dt * 0.5;
      view.lampRingB.rotation.z += dt * (0.4 + humLevel * 5);
      view.rail.position.y = L[1];
      view.spot.position.set(L[0], L[1], L[2]);
      view.spot.target.position.copy(view.aim);
      vA.set(L[0], L[1], L[2]);
      var len = vA.distanceTo(view.aim) * 1.04;
      aimCone(view.lampCone, vA, view.aim, len, len * Math.tan(view.spot.angle) * 0.92);

      // mirror
      if (view.mirror) {
        var mv = view.mirror, ms = world.mirror;
        var on = ms.active ? 1 : 0;
        mv.level += (on - mv.level) * (1 - Math.exp(-8 * dt));
        mv.mat.uniforms.uActive.value = mv.level;
        mv.spot.intensity = 42 * mv.level;
        mv.spot.position.set(ms.Lp[0], ms.Lp[1], ms.Lp[2]);
        if (ms.active) {
          // aim the reflected beam through the occluder to where its shadow lands
          var tgt = ms.target;
          var t = ms.Lp[1] / Math.max(0.1, ms.Lp[1] - tgt[1]);
          mv.target.set(ms.Lp[0] + (tgt[0] - ms.Lp[0]) * t, 0, ms.Lp[2] + (tgt[2] - ms.Lp[2]) * t);
          mv.spot.target.position.copy(mv.target);
          vB.set(ms.hit[0], ms.hit[1], ms.hit[2]);
          var rl = vB.distanceTo(mv.target) * 1.03;
          aimCone(mv.cone, vB, mv.target, rl, rl * 0.36);
          mv.cone.material.uniforms.uIntensity.value = 0.17 * mv.level;
          mv.cone.visible = true;
          // beam lamp -> mirror
          var bl = vA.distanceTo(vB);
          mv.beam.position.copy(vA).add(vB).multiplyScalar(0.5);
          tmpV.copy(vB).sub(vA).normalize();
          mv.beam.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, tmpV);
          mv.beam.scale.set(1, bl, 1);
          mv.beam.visible = true;
          mv.spark.position.copy(vB);
          mv.spark.scale.setScalar(0.8 + 0.3 * Math.sin(uTime.value * 9));
          mv.spark.visible = true;
        } else {
          mv.cone.visible = mv.level > 0.03;
          mv.cone.material.uniforms.uIntensity.value = 0.17 * mv.level;
          mv.beam.visible = false;
          mv.spark.visible = false;
        }
      }

      // sentinels
      for (i = 0; i < view.sentinels.length; i++) {
        var sv = view.sentinels[i], spec = stage.sentinels[i];
        var aim = World.sentinelAim(spec, sim.time);
        sv.target.set(aim[0], aim[1], aim[2]);
        sv.light.target.position.copy(sv.target);
        var sl = sv.apex.distanceTo(sv.target) * 1.03;
        aimCone(sv.cone, sv.apex, sv.target, sl, sl * Math.tan(spec.cone * DEG));
        sv.cone.material.uniforms.uIntensity.value = 0.42 + 0.5 * sv.heat;
        sv.light.intensity = 46 + 40 * sv.heat;
        sv.eye.rotation.y += dt * (1.2 + sv.heat * 8);
        sv.eye.rotation.x += dt * 0.7;
        sv.cage.rotation.y -= dt * 2.1;
      }

      // portal
      view.portalTorus2.rotation.z += dt * 0.6;
      view.portalTorus2.rotation.y = Math.sin(uTime.value * 0.7) * 0.25;

      syncBridges(world.polys);
    }

    function updatePlayer(dt) {
      var p = player;
      var control = state === 'playing' && !respawn;
      var ix = 0, iz = 0;
      if (control) {
        ix = ((keys.KeyD || keys.ArrowRight) ? 1 : 0) - ((keys.KeyA || keys.ArrowLeft) ? 1 : 0);
        iz = ((keys.KeyS || keys.ArrowDown) ? 1 : 0) - ((keys.KeyW || keys.ArrowUp) ? 1 : 0);
        var il = Math.hypot(ix, iz);
        if (il > 0) { ix /= il; iz /= il; }
      }
      var k = 1 - Math.exp(-(p.grounded ? 14 : 6) * dt);
      p.vx += (ix * SPEED - p.vx) * k;
      p.vz += (iz * SPEED - p.vz) * k;

      // jump (with coyote time + input buffer)
      p.coyote = p.grounded ? 0.09 : Math.max(0, p.coyote - dt);
      p.jumpBuf = Math.max(0, p.jumpBuf - dt);
      if (control && p.jumpBuf > 0 && p.coyote > 0 && !p.sunk) {
        p.vy = JUMP_V;
        p.grounded = false;
        p.coyote = 0;
        p.jumpBuf = 0;
        Audio.jump();
        if (p.onBridge) spawnRipple(p.x, p.z, 2.4, 0.7, 0.4, 1.0, 1.0);
      }

      var nx = p.x + p.vx * dt, nz = p.z + p.vz * dt;
      var i, r;
      // standing pillars block movement
      for (i = 0; i < stage.occluders.length; i++) {
        var oc = stage.occluders[i];
        if (!oc.solid) continue;
        if (p.y > oc.pos[1] + oc.size[1] / 2) continue;
        r = Geo.pushOutOfRect(nx, nz, PLAYER_R, oc.pos[0] - oc.size[0] / 2, oc.pos[0] + oc.size[0] / 2, oc.pos[2] - oc.size[2] / 2, oc.pos[2] + oc.size[2] / 2);
        nx = r[0]; nz = r[1];
      }
      // once below the floor, tower walls are solid too
      if (p.y < -0.35) {
        for (i = 0; i < stage.platforms.length; i++) {
          var pl = stage.platforms[i];
          r = Geo.pushOutOfRect(nx, nz, PLAYER_R, pl.x0, pl.x1, pl.z0, pl.z1);
          nx = r[0]; nz = r[1];
        }
      }
      var moved = Math.hypot(nx - p.x, nz - p.z);
      p.x = nx; p.z = nz;

      var sup = World.supportAt(stage, world.polys, p.x, p.z);
      var supported = sup.platform >= 0 || sup.shadow;
      var landed = false;

      if (p.grounded) {
        if (supported) { p.y = 0; p.vy = 0; }
        else { p.grounded = false; p.vy = 0; }
      }
      if (!p.grounded) {
        p.vy -= GRAVITY * dt;
        p.y += p.vy * dt;
        if (p.y <= 0 && p.vy <= 0 && !p.sunk) {
          if (supported) {
            landed = p.vy < -2.5;
            p.y = 0; p.vy = 0; p.grounded = true;
          } else if (p.y < -0.35) {
            p.sunk = true;
            if (control) Audio.fall();
          }
        }
      }

      // bridge enter / exit
      var onBridge = p.grounded && sup.platform < 0 && sup.shadow;
      if (onBridge !== p.onBridge) {
        if (control || onBridge) {
          if (onBridge) { Audio.bridgeEnter(); spawnRipple(p.x, p.z, 3.4, 1.0, 0.45, 0.9, 1.0); }
          else if (p.grounded) Audio.bridgeExit();
        }
        p.onBridge = onBridge;
      }
      if (p.grounded && sup.platform >= 0) checkpoint = sup.platform;

      if (landed) {
        Audio.land();
        if (onBridge) spawnRipple(p.x, p.z, 3.0, 0.9, 0.4, 1.0, 1.0);
        else spawnRipple(p.x, p.z, 1.6, 0.5, 0.5, 0.5, 0.6);
      }
      // footsteps on the bridge spread ripples
      if (onBridge) {
        p.stepDist += moved;
        if (p.stepDist > 0.85) {
          p.stepDist = 0;
          spawnRipple(p.x, p.z, 2.1, 0.85, 0.35, 0.95, 1.0);
          Audio.step();
        }
      } else {
        p.stepDist = 0.6;
      }

      // afterimage particles
      var speed = Math.hypot(p.vx, p.vz);
      if (speed > 0.6 || !p.grounded) {
        trail.acc += dt * (16 + speed * 9);
        while (trail.acc >= 1) {
          trail.acc -= 1;
          spawnTrail(p.x - p.vx * 0.04, p.y + 0.12, p.z - p.vz * 0.04, 0.34, 0.25);
        }
      }

      if (p.y < -13 && control) startRespawn('fall');

      // visuals
      if (speed > 0.3) {
        var want = Math.atan2(p.vx, p.vz);
        var diff = want - p.facing;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        p.facing += diff * (1 - Math.exp(-14 * dt));
      }
      var bobY = p.grounded ? Math.abs(Math.sin(uTime.value * 9)) * 0.05 * Math.min(1, speed / SPEED) : 0;
      p.mesh.position.set(p.x, p.y + bobY, p.z);
      p.mesh.rotation.y = p.facing;
      p.halo.rotation.z += dt * 1.6;
      p.halo.position.y = 0.6 + Math.sin(uTime.value * 2.2) * 0.06;
      p.halo2.rotation.y += dt * 2.3;
      p.halo2.rotation.x += dt * 1.1;
    }

    function updateDetection(dt) {
      var seen = false;
      var active = state === 'playing' && !respawn && player.y > -1.5;
      var P = [player.x, player.y + 0.6, player.z];
      for (var i = 0; i < stage.sentinels.length; i++) {
        var spec = stage.sentinels[i];
        var sees = active && World.sentinelSees(spec, World.sentinelAim(spec, sim.time), P, world.occ);
        var sv = view.sentinels[i];
        sv.heat += ((sees ? 1 : 0) - sv.heat) * (1 - Math.exp(-7 * dt));
        if (sees) seen = true;
      }
      if (seen) exposure += dt / DETECT_TIME;
      else exposure -= dt * DETECT_DECAY;
      exposure = Math.max(0, Math.min(1, exposure));
      if (exposure >= 1 && active) { startRespawn('caught'); }
      return seen;
    }

    function updatePortal(dt) {
      if (state === 'playing' && !respawn && player.grounded) {
        var d = Math.hypot(player.x - stage.portal[0], player.z - stage.portal[1]);
        if (d < 1.25) {
          state = 'clear';
          clearT = 0;
          exposure = 0;
          Audio.fanfare(stageIndex === STAGES.length - 1);
          spawnRipple(stage.portal[0], stage.portal[1], 6, 1.4, 0.7, 0.6, 1.0);
          showToast(stageIndex === STAGES.length - 1 ? '마지막 그림자를 건넜습니다' : 'STAGE ' + stage.id + ' CLEAR');
        }
      }
      if (state === 'clear') {
        clearT += dt;
        var k = Math.min(1, clearT / 1.1);
        player.x += (stage.portal[0] - player.x) * (1 - Math.exp(-6 * dt));
        player.z += (stage.portal[1] - player.z) * (1 - Math.exp(-6 * dt));
        player.mesh.position.set(player.x, k * k * 1.2, player.z);
        player.mesh.scale.setScalar(Math.max(0.02, 1 - k * 0.95));
        player.mesh.rotation.y += dt * (4 + k * 14);
        if (Math.random() < 0.7) spawnTrail(player.x, 0.2 + k * 1.2, player.z, 1.2, 1.4);
        fx.fadeTarget = clearT > 1.0 ? 0 : 1;
        if (clearT > 2.0) {
          if (stageIndex >= STAGES.length - 1) {
            showEnding();
          } else {
            loadStage(stageIndex + 1, true);
            state = 'playing';
            fx.fade = 0;
            fx.fadeTarget = 1;
            showBanner(stage);
          }
        }
      }
    }

    function updateCamera(dt, snap) {
      var ty = Math.max(-3, Math.min(1.2, player.y));
      var k = snap ? 1 : 1 - Math.exp(-4.2 * dt);
      // frame the player together with the puzzle: lean the focus towards the stage centre
      var fx0 = player.x * 0.62 + view.center[0] * 0.38;
      var fz0 = player.z * 0.62 + view.center[1] * 0.38;
      camFocus.x += (fx0 - camFocus.x) * k;
      camFocus.y += (ty - camFocus.y) * k;
      camFocus.z += (fz0 - camFocus.z) * k;
      var narrow = camera.aspect < 1.3 ? 1.3 / camera.aspect : 1;
      var z = camZoom * narrow;
      camera.position.set(camFocus.x, camFocus.y + 27 * z, camFocus.z + 19 * z);
      camera.lookAt(camFocus.x, camFocus.y + 0.4, camFocus.z - 2.4);
    }

    function updateHud(dt) {
      var gauge = $('alert');
      if (exposure > 0.01 && state === 'playing') {
        gauge.className = 'alert show' + (exposure > 0.6 ? ' hot' : '');
        $('alert-fill').style.width = Math.round(exposure * 100) + '%';
      } else {
        gauge.className = 'alert';
      }
      if (toastTimer > 0) {
        toastTimer -= dt;
        if (toastTimer <= 0) $('toast').className = 'toast';
      }
      if (bannerTimer > 0) {
        bannerTimer -= dt;
        if (bannerTimer <= 0) $('banner').className = 'banner';
      }
    }

    /* ================================================================ */
    /* Main loop                                                         */
    /* ================================================================ */
    var last = performance.now();
    var firstFrame = true;

    function step(dt) {
      uTime.value += dt;
      if (state === 'playing') stats.time += dt;

      updateLightControl(dt);
      sim.time += dt;
      world = World.compute(stage, sim);
      syncStageVisuals(dt);

      if (state !== 'clear') updatePlayer(dt);
      updateDetection(dt);
      updateRespawn(dt);
      updatePortal(dt);

      updateTrail(dt);
      updateRipples(dt);
      updateCamera(dt, firstFrame);
      updateHud(dt);

      fx.fade += (fx.fadeTarget - fx.fade) * (1 - Math.exp(-(fx.fadeTarget < fx.fade ? 5 : 2.6) * dt));
      var u = finalPass.uniforms;
      u.uTime.value = uTime.value;
      u.uGlitch.value = fx.glitch;
      u.uAlert.value = state === 'playing' ? exposure : 0;
      u.uFade.value = fx.fade;

      Audio.update(dt, state === 'playing' ? humLevel : 0, state === 'playing' && !respawn ? exposure : 0);
      firstFrame = false;
    }

    function frame(nowMs) {
      root.requestAnimationFrame(frame);
      var dt = Math.min(0.05, Math.max(0, (nowMs - last) / 1000));
      last = nowMs;
      // two physics sub-steps keep fast falls and thin shadows stable
      var sub = dt > 0.02 ? 2 : 1;
      for (var s = 0; s < sub; s++) step(dt / sub);
      composer.render();
    }

    loadStage(0, false);
    fx.fade = 0;
    fx.fadeTarget = 1;
    SW.booted = true;
    SW.debug = {
      get state() { return state; },
      get stageIndex() { return stageIndex; },
      get sim() { return sim; },
      get player() { return player; },
      get world() { return world; },
      get exposure() { return exposure; },
      get fx() { return fx; },
      renderer: renderer, composer: composer, scene: scene, camera: camera,
      begin: beginGame,
      load: function (i) { loadStage(i, true); state = 'playing'; fx.fadeTarget = 1; }
    };
    root.requestAnimationFrame(frame);
  };
})(window);
