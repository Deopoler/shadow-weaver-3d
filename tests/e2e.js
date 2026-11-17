/*
 * End-to-end smoke test: launches headless Chrome, opens index.html straight from disk (file://),
 * and plays all six stages through the real input handlers via the DevTools protocol.
 *   node tests/e2e.js [screenshot-dir]
 * Requires Chrome and Node 22+ (global WebSocket). Needs internet for the three.js CDN.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(p => fs.existsSync(p));
const PORT = 9333 + Math.floor(Math.random() * 500);
const shotDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'sw-shots-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-profile-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!ok) failures++;
}

async function main() {
  if (!CHROME) throw new Error('Chrome not found; set CHROME=/path/to/chrome');
  fs.mkdirSync(shotDir, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1280,720', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run', '--allow-file-access-from-files',
    'about:blank'
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(250);
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
        target = list.find(t => t.type === 'page');
      } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('Chrome DevTools endpoint did not come up');

    ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ' ' + JSON.stringify(msg.params.exceptionDetails.exception || {}).slice(0, 300));
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      errors.push('[console.' + msg.params.type + '] ' + msg.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 400));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push('[log] ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
  };
  const send = (method, params) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value;
  };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const VK = { KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyQ: 81, KeyE: 69, KeyR: 82, KeyZ: 90, KeyX: 88, Space: 32, Enter: 13 };
  const key = (type, code) => send('Input.dispatchKeyEvent', { type, code, key: code === 'Space' ? ' ' : code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: VK[code] });
  const hold = async (code, ms) => { await key('keyDown', code); await sleep(ms); await key('keyUp', code); };
  const dbg = expr => evaluate('(function(){var d=SW.debug;return ' + expr + ';})()');
  const waitFor = async (expr, timeout, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await dbg(expr)) return true;
      await sleep(60);
    }
    console.log('    timeout waiting for: ' + (label || expr));
    return false;
  };
  /** Rotate the lamp with Q/E until it sits at the wanted angle (degrees). */
  const aimLamp = async deg => {
    const get = () => dbg('((d.sim.theta*180/Math.PI)%360+360)%360');
    for (let i = 0; i < 400; i++) {
      const cur = await get();
      let diff = ((deg - cur + 540) % 360) - 180;
      if (Math.abs(diff) < 1.5) break;
      const code = diff > 0 ? 'KeyE' : 'KeyQ';
      await hold(code, Math.min(700, Math.max(30, Math.abs(diff) * 14)));
      await sleep(120);
    }
    return get();
  };
  /** Adjust the lamp height with Z/X until it reaches target height. */
  const aimHeight = async targetH => {
    const get = () => dbg('d.sim.height');
    for (let i = 0; i < 400; i++) {
      const cur = await get();
      const diff = targetH - cur;
      if (Math.abs(diff) < 0.25) break;
      const code = diff > 0 ? 'KeyX' : 'KeyZ';
      await hold(code, Math.min(600, Math.max(30, Math.abs(diff) * 200)));
      await sleep(100);
    }
    return get();
  };
  /** Walk towards a world point using WASD until close (or timeout). Returns true on arrival. */
  const walkTo = async (x, z, opts) => {
    opts = opts || {};
    const tol = opts.tol || 0.45;
    const t0 = Date.now();
    let held = {};
    const set = async want => {
      for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
        if (want[c] && !held[c]) { await key('keyDown', c); held[c] = true; }
        if (!want[c] && held[c]) { await key('keyUp', c); held[c] = false; }
      }
    };
    let ok = false;
    while (Date.now() - t0 < (opts.timeout || 15000)) {
      const p = await dbg('[d.player.x,d.player.z,d.player.y,d.stageIndex,d.state]');
      if (opts.until && await dbg(opts.until)) { ok = true; break; }
      const dx = x - p[0], dz = z - p[1];
      if (Math.hypot(dx, dz) < tol) { ok = true; break; }
      await set({ KeyD: dx > 0.2, KeyA: dx < -0.2, KeyS: dz > 0.2, KeyW: dz < -0.2 });
      await sleep(30);
    }
    await set({});
    return ok;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  const url = pathToFileURL(path.resolve(__dirname, '..', 'index.html')).href;
  await send('Page.navigate', { url });

  console.log('Boot (file://)');
  let booted = false;
  for (let i = 0; i < 120 && !booted; i++) { await sleep(250); try { booted = await evaluate('!!(window.SW && SW.booted)'); } catch (e) { /* loading */ } }
  check('game boots from file:// with CDN three.js', booted);
  if (!booted) { console.log(errors.join('\n')); failures++; throw new Error('Game failed to boot'); }
  await sleep(1500);
  await shot('00-title');
  check('title overlay is visible', await evaluate('document.getElementById("title-screen").classList.contains("show")'));

  // start through the real button
  await evaluate('document.getElementById("btn-start").click()');
  await sleep(800);
  check('game enters playing state', (await dbg('d.state')) === 'playing');
  check('HUD shows stage 1', (await evaluate('document.getElementById("hud-stage").textContent')).includes('STAGE 1'));
  await shot('01-stage1-start');

  /**
   * Stealth helper: wait until the route (from the player's position through the waypoints, at run speed)
   * will not be swept by any sentinel, then run it. Cover from occluders is ignored (conservative).
   */
  const routeIsSafe = pts => dbg(`(function(){
    var st = SW.STAGES[d.stageIndex], pts = ${JSON.stringify(pts)};
    var x = d.player.x, z = d.player.z, t = d.sim.time + 0.12, sp = 3.4, dt = 0.05;
    for (var i = 0; i < pts.length; i++) {
      var guard = 0;
      while (Math.hypot(pts[i][0] - x, pts[i][1] - z) > 0.1 && guard++ < 2000) {
        var dx = pts[i][0] - x, dz = pts[i][1] - z, l = Math.hypot(dx, dz), stp = Math.min(l, sp * dt);
        x += dx / l * stp; z += dz / l * stp; t += dt;
        for (var k = 0; k < st.sentinels.length; k++) {
          var s = st.sentinels[k], wide = { pos: s.pos, cone: s.cone + 2.5 };
          if (SW.World.sentinelSees(wide, SW.World.sentinelAim(s, t), [x, 0.6, z], [])) return false;
        }
      }
    }
    return true;
  })()`);
  const sneak = async (pts, abort) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && !(await routeIsSafe(pts))) await sleep(50);
    for (const p of pts) await walkTo(p[0], p[1], { timeout: 7000, until: abort, tol: 0.35 });
  };
  const jumpHeld = async (code, ms) => {
    await key('keyDown', code); await sleep(70);
    await key('keyDown', 'Space'); await sleep(60); await key('keyUp', 'Space');
    await sleep(ms); await key('keyUp', code);
  };

  /* ---- Stage 1 ---- */
  console.log('Stage 1');
  // without a bridge the player must fall and respawn
  await walkTo(1, 0, { timeout: 4000, until: 'd.player.y < -1' });
  check('walking off the cliff without a shadow makes the player fall', await waitFor('d.player.y < -1', 3000));
  check('fall respawns on the last platform', await waitFor('d.player.y === 0 && d.player.x < -3', 6000));
  await sleep(700);
  const th1 = await aimLamp(180);
  check('lamp rotates with Q/E', Math.abs(th1 - 180) < 3, 'theta=' + th1.toFixed(1));
  await sleep(300);
  await shot('02-stage1-bridge');
  await walkTo(0, 0, { timeout: 6000 });
  check('player stands on the shadow bridge over the void', await dbg('d.player.onBridge && d.player.grounded && d.player.y === 0'));
  await shot('03-stage1-on-bridge');
  await walkTo(4.6, 0, { timeout: 5000 });
  for (let attempt = 0; attempt < 5 && (await dbg('d.stageIndex')) === 0; attempt++) {
    if (await dbg('d.player.x < 0')) await walkTo(4.6, 0, { timeout: 12000 });
    await sneak([[6, 3.9], [14.5, 3.9], [14.5, 0]], 'd.stageIndex !== 0 || d.state !== "playing" || d.player.x < 0');
    await waitFor('(d.stageIndex === 1 && d.state === "playing") || d.player.x < 0', 6000, 'stage 2 load');
  }
  check('stage 1 cleared through the portal', (await dbg('d.stageIndex')) === 1);
  await sleep(1500);
  await shot('04-stage2-start');

  /* ---- Stage 2 ---- */
  console.log('Stage 2');
  const toIsland = async () => {
    await aimLamp(0);
    await walkTo(-12.4, 0, { timeout: 9000, tol: 0.3 });
    await jumpHeld('KeyD', 700);
    const landed = await dbg('d.player.grounded && d.player.y === 0 && d.player.x > -11');
    await walkTo(-3.8, 1.4, { timeout: 6000, until: 'd.player.y < -1' });
    return landed;
  };
  await aimLamp(0);
  await sleep(300);
  await shot('05-stage2-stones');
  check('jumped between two shadow stepping stones', await toIsland());
  check('reached the central island (safe zone)', await dbg('d.player.x > -5 && d.player.y === 0 && !d.player.onBridge'));
  await aimLamp(90);
  await sleep(300);
  check('re-aiming on the island is undisturbed', await dbg('d.player.x > -5 && d.player.y === 0 && d.exposure === 0'));
  await shot('06-stage2-second-bridge');
  for (let attempt = 0; attempt < 5 && (await dbg('d.stageIndex')) === 1; attempt++) {
    if (await dbg('d.player.x < -10 && d.player.z > -6')) { await toIsland(); await aimLamp(90); }
    const lost = 'd.stageIndex !== 1 || d.state !== "playing" || d.player.y < -1 || (d.player.x < -10 && d.player.z > -6)';
    await sneak([[-3.6, -4.2], [-3.6, -7.4], [-5.4, -10.6]], lost);
    if (await dbg(lost)) { await waitFor('d.player.y === 0', 5000); await sleep(700); continue; }
    await jumpHeld('KeyW', 650);
    await walkTo(-5.5, -13.4, { timeout: 4000, until: lost });
    if (attempt === 0) await shot('06b-stage2-goal-side');
    await sneak([[-1.8, -13.4], [-1.8, -20], [-3, -20]], lost);
    await waitFor('(d.stageIndex === 2 && d.state === "playing") || (d.player.x < -10 && d.player.z > -6)', 6000, 'stage 3 load');
  }
  check('stage 2 cleared through the portal', (await dbg('d.stageIndex')) === 2);
  await sleep(1500);
  await shot('07-stage3-start');

  /* ---- Stage 3 ---- */
  console.log('Stage 3');
  const toTerrace = async () => {
    await aimLamp(138);
    await walkTo(4.6, 8, { timeout: 12000, until: 'd.player.y < -1' });
  };
  await toTerrace();
  check('crossed the primary shadow bridge to the mirror terrace', await dbg('d.player.x > 3 && d.player.y === 0'));
  await aimLamp(318);
  await sleep(400);
  check('mirror is lit and casts a reflected shadow', await dbg('d.world.mirror.active && d.world.polys.some(function(p){return p.src===1;})'));
  await shot('08-stage3-mirror');
  for (let attempt = 0; attempt < 6 && (await dbg('d.stageIndex')) === 2 && (await dbg('d.state')) !== 'ending'; attempt++) {
    const sentBack = 'd.player.x < 0 && d.player.z > 0';
    if (await dbg(sentBack)) { await toTerrace(); await aimLamp(318); }
    if (await dbg('d.player.z > -4')) await sneak([[4.2, 4.5], [4.2, -8]], sentBack);
    if (await dbg(sentBack)) continue;
    // wait until the drifting shadow touches the terrace and is still sliding west, then ride it
    await waitFor('SW.World.shadowAt(d.world.polys, 2.6, -8) && SW.World.shadowAt(d.world.polys, -0.8, -8) && Math.cos(2*Math.PI*d.sim.time/7) > 0', 12000, 'drifting shadow near terrace');
    if (attempt === 0) await shot('08b-stage3-drifting-bridge');
    await walkTo(-5.4, -8, { timeout: 9000, until: 'd.player.y < -1 || (d.player.x < -4.2 && d.player.grounded)' });
    if (await dbg('d.player.y < -1')) { await waitFor('d.player.y === 0', 5000); await sleep(700); continue; }
    if (attempt === 0) await shot('09-stage3-goal-side');
    await sneak([[-6, -5], [-13.5, -5], [-13.5, -8]], 'd.stageIndex !== 2 || d.state !== "playing" || d.player.z > 0');
    await waitFor('(d.stageIndex === 3 && d.state === "playing") || d.player.z > 0', 6000, 'stage 4 load');
  }
  check('stage 3 cleared through the portal', (await dbg('d.stageIndex')) === 3);
  await sleep(1500);
  await shot('10-stage4-start');

  /* ---- Stage 4 ---- */
  console.log('Stage 4');
  check('HUD shows stage 4', (await evaluate('document.getElementById("hud-stage").textContent')).includes('STAGE 4'));
  const th4 = await aimLamp(136);
  check('lamp rotates with Q/E to 136°', Math.abs(th4 - 136) < 3, 'theta=' + th4.toFixed(1));
  const h4high = await aimHeight(17.2);
  check('lamp height raised with KeyX', h4high > 16, 'height=' + h4high.toFixed(1));
  await sleep(300);
  await shot('11-stage4-high-lamp');
  await walkTo(1.0, -1.0, { timeout: 4000 });
  await walkTo(2.0, -2.4, { timeout: 4000 });
  await walkTo(4.0, -3.8, { timeout: 4000 });
  await walkTo(6.0, -5.3, { timeout: 4000 });
  await walkTo(8.5, -6.8, { timeout: 4000 });
  await walkTo(10.0, -7.0, { timeout: 4000 });
  check('player reached island 1 via high-elevation shadow bridge', await dbg('d.player.x > 8.5 && d.player.y === 0'));
  await shot('12-stage4-island1');

  await aimLamp(144);
  const h4low = await aimHeight(10.5);
  check('lamp height lowered with KeyZ', h4low < 11.5, 'height=' + h4low.toFixed(1));
  await sleep(300);
  await shot('13-stage4-low-lamp');
  await walkTo(14.0, -9.5, { timeout: 4000 });
  await walkTo(18.0, -12.5, { timeout: 4000 });
  await walkTo(21.5, -15.0, { timeout: 4000 });
  await walkTo(25.0, -17.0, { timeout: 4000 });
  await walkTo(25.5, -13.0, { timeout: 4000 });
  check('player reached goal platform via stretched low-elevation shadow bridge', await dbg('d.player.x > 24.5 && d.player.y === 0'));
  await shot('14-stage4-goal-platform');

  for (let attempt = 0; attempt < 5 && (await dbg('d.stageIndex')) === 3; attempt++) {
    const lost = 'd.stageIndex !== 3 || d.state !== "playing" || d.player.x < 24.5';
    await sneak([[25.0, -20], [29, -20], [29, -17]], lost);
    await waitFor('(d.stageIndex === 4 && d.state === "playing") || d.player.x < 24.5', 6000, 'stage 5 load');
  }
  check('stage 4 cleared through the portal', (await dbg('d.stageIndex')) === 4);
  await sleep(1500);
  await shot('15-stage5-start');

  /* ---- Stage 5 ---- */
  console.log('Stage 5');
  check('HUD shows stage 5', (await evaluate('document.getElementById("hud-stage").textContent')).includes('STAGE 5'));
  const th5 = await aimLamp(146);
  check('lamp rotates with Q/E to 146°', Math.abs(th5 - 146) < 3, 'theta=' + th5.toFixed(1));
  await sleep(300);
  await shot('16-stage5-aimed');

  for (let attempt = 0; attempt < 5 && (await dbg('d.player.x < 6.5 && d.stageIndex === 4')); attempt++) {
    if (await dbg('d.player.y < -1')) { await waitFor('d.player.y === 0', 5000); await sleep(500); }
    // Walk towards the edge of platform 0 safely
    await walkTo(-7.0, 3.8, { timeout: 5000 });
    // Wait for bridge to be connected and aligned with a large time window ahead
    await waitFor('SW.World.shadowAt(d.world.polys, 0, 0) && (d.sim.time % 18 > 1.5 && d.sim.time % 18 < 7.0)', 25000, 'dual bobbing bridge alignment');
    if (attempt === 0) await shot('17-stage5-aligned-bridge');
    // Cross the dual-bobbing bridge via tested waypoints
    await walkTo(-3.5, 2.0, { timeout: 5000, until: 'd.player.y < -1' });
    await walkTo(0.5, -0.5, { timeout: 5000, until: 'd.player.y < -1' });
    await walkTo(4.5, -2.5, { timeout: 5000, until: 'd.player.y < -1' });
    await walkTo(8.0, -4.5, { timeout: 5000, until: 'd.player.y < -1' });
    await walkTo(12, -6, { timeout: 5000, until: 'd.player.y < -1 || d.player.x > 7' });
  }
  check('crossed timed dual-bobbing shadow bridge to goal platform', await dbg('d.player.x > 6.5 && d.player.y === 0'));
  await shot('18-stage5-goal-platform');

  for (let attempt = 0; attempt < 5 && (await dbg('d.stageIndex')) === 4; attempt++) {
    const lost = 'd.stageIndex !== 4 || d.state !== "playing" || d.player.x < 6.5';
    await sneak([[13, -8]], lost);
    await waitFor('(d.stageIndex === 5 && d.state === "playing") || d.player.x < 6.5', 6000, 'stage 6 load');
  }
  check('stage 5 cleared through the portal', (await dbg('d.stageIndex')) === 5);
  await sleep(1500);
  await shot('19-stage6-start');

  /* ---- Stage 6 ---- */
  console.log('Stage 6');
  check('HUD shows stage 6', (await evaluate('document.getElementById("hud-stage").textContent')).includes('STAGE 6'));

  // Bridge 1: Start to Center Island
  await aimLamp(90);
  await sleep(300);
  await shot('20-stage6-bridge1');
  await walkTo(0, -6.5, { timeout: 6000 });
  await walkTo(0, -2.0, { timeout: 6000 });
  await walkTo(2.5, 1.2, { timeout: 6000 });
  check('crossed primary shadow bridge to center island', await dbg('d.player.z > -5 && d.player.y === 0'));
  await shot('21-stage6-center-island');

  // Bridge 2: Center Island to West Terrace (The Fusion Bridge)
  await aimLamp(0);
  await sleep(400);
  check('primary and reflected shadows combine into fusion bridge', await dbg('d.world.mirror && d.world.mirror.active && d.world.polys.some(function(p){return p.src===0;}) && d.world.polys.some(function(p){return p.src===1;})'));
  await shot('22-stage6-fusion-bridge');
  await walkTo(0, 0, { timeout: 5000 });
  await walkTo(-5, 0, { timeout: 5000 });
  await walkTo(-10, 0, { timeout: 5000 });
  await walkTo(-15, 0, { timeout: 5000 });
  await walkTo(-19, 0, { timeout: 6000 });
  check('crossed fusion bridge to west terrace', await dbg('d.player.x < -17 && d.player.y === 0'));
  await shot('23-stage6-west-terrace');

  // Bridge 3: West Terrace to Goal Platform
  await aimLamp(246);
  await sleep(300);
  await shot('24-stage6-bridge3');
  await walkTo(-19, 4, { timeout: 5000 });
  await walkTo(-20, 6, { timeout: 5000 });
  await walkTo(-20, 8.8, { timeout: 6000 });
  check('crossed reflected shadow bridge to goal platform', await dbg('d.player.z > 8.0 && d.player.y === 0'));
  await shot('25-stage6-goal-platform');

  // Final sneak to portal
  for (let attempt = 0; attempt < 6 && (await dbg('d.state')) !== 'ending'; attempt++) {
    const lost = 'd.state !== "playing" || d.player.z < 8.0';
    await sneak([[-20, 13]], lost);
    await waitFor('d.state === "ending" || d.player.z < 8.0', 6000, 'ending');
  }
  check('stage 6 cleared and the ending screen is shown', (await dbg('d.state')) === 'ending' && await evaluate('document.getElementById("ending").classList.contains("show")'));
  await sleep(1200);
  await shot('26-ending');
  console.log('    run stats: time ' + await evaluate('document.getElementById("end-time").textContent') + ', falls ' + await evaluate('document.getElementById("end-falls").textContent') + ', caught ' + await evaluate('document.getElementById("end-caught").textContent'));

  console.log('Replay');
  await evaluate('document.getElementById("btn-replay").click()');
  await sleep(600);
  check('replay button restarts from stage 1', await dbg('d.stageIndex === 0 && d.state === "playing"'));
  await hold('KeyD', 300);
  await key('keyDown', 'KeyR'); await key('keyUp', 'KeyR');
  await sleep(200);
  check('R restarts the current stage', await dbg('Math.abs(d.player.x + 12) < 0.3'));
  await evaluate('document.getElementById("btn-mute").click()');
  check('mute toggle works', await evaluate('SW.Audio.isMuted() === true && document.getElementById("btn-mute").getAttribute("aria-pressed") === "true"'));

  console.log('Touch controls emulation');
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: true });

  await send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 300, y: 300, id: 0 }]
  });
  await send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
  await sleep(150);

  const touchVisible = await evaluate(
    '!document.getElementById("touch-layer").classList.contains("hidden") && ' +
    'window.getComputedStyle(document.getElementById("touch-layer")).display !== "none"'
  );
  check('touch layer is visible during play', touchVisible);
  await shot('27-touch-layer-visible');

  const joyRect = await evaluate(
    'var r = document.getElementById("touch-joystick").getBoundingClientRect(); ' +
    '({ x: r.left + r.width / 2, y: r.top + r.height / 2 })'
  );
  const startX = await dbg('d.player.x');
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: joyRect.x, y: joyRect.y, id: 0 }]
  });
  await sleep(50);
  await send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: joyRect.x + 36, y: joyRect.y, id: 0 }]
  });
  await sleep(400);
  await send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
  await sleep(100);

  const endX = await dbg('d.player.x');
  check('dragging joystick moves the player', endX > startX + 0.1, 'startX=' + startX.toFixed(2) + ' endX=' + endX.toFixed(2));

  await waitFor('d.player.grounded && d.player.y === 0', 3000, 'grounded before touch jump');
  const jumpRect = await evaluate(
    'var r = document.getElementById("btn-touch-jump").getBoundingClientRect(); ' +
    '({ x: r.left + r.width / 2, y: r.top + r.height / 2 })'
  );
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: jumpRect.x, y: jumpRect.y, id: 0 }]
  });
  await sleep(50);
  await send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });

  const airborne = await waitFor('d.player.y > 0.05 && !d.player.grounded', 2000, 'touch jump airborne');
  check('tapping Jump makes the player leave the ground', airborne);
  await waitFor('d.player.grounded && d.player.y === 0', 3000, 'touch jump landed');

  const startTheta = await dbg('d.sim.theta');
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 500, y: 300, id: 1 }]
  });
  await sleep(50);
  await send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 440, y: 300, id: 1 }]
  });
  await sleep(50);
  await send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
  const endTheta = await dbg('d.sim.theta');
  check('lamp rotates with touch drag on canvas', Math.abs(endTheta - startTheta) > 0.05, 'diff=' + Math.abs(endTheta - startTheta).toFixed(3));

  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: false });

  console.log('Runtime errors');
  check('no exceptions or console errors', errors.length === 0, errors.length ? '\n    ' + errors.join('\n    ') : '');

  console.log('\nscreenshots: ' + shotDir);
  } finally {
    if (ws) {
      try { ws.close(); } catch (e) {}
    }
    if (chrome) {
      try { chrome.kill(); } catch (e) {}
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (e) {}
  }

  console.log(failures ? failures + ' CHECK(S) FAILED' : 'ALL E2E CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
