/*
 * Chiaroscuro: Shadow Weaver — procedural audio.
 * Everything is synthesised with Web Audio oscillators, filters, gains and delays. No samples.
 */
(function (root) {
  'use strict';
  var SW = root.SW = root.SW || {};

  var ctx = null;
  var master = null;      // final volume (mute)
  var bus = null;         // dry mix
  var send = null;        // echo/reverb send
  var hum = null;         // lamp motor voice
  var ready = false;
  var muted = false;
  var bellTimer = 2.5;
  var alertTimer = 0;
  var lastStep = 0;

  var PENTA = [293.66, 349.23, 392.0, 440.0, 523.25, 587.33, 698.46, 783.99]; // D minor pentatonic

  function now() { return ctx.currentTime; }

  function osc(type, freq, dest, detune) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    o.connect(dest);
    return o;
  }

  function gain(value, dest) {
    var g = ctx.createGain();
    g.gain.value = value;
    if (dest) g.connect(dest);
    return g;
  }

  function filter(type, freq, q, dest) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q || 0.7;
    if (dest) f.connect(dest);
    return f;
  }

  /** One enveloped oscillator note. */
  function tone(type, freq, t, attack, decay, vol, dest, freqEnd) {
    var g = gain(0, dest || bus);
    var o = osc(type, freq, g);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + decay);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
    return o;
  }

  /** Glassy bell: slightly inharmonic sine partials with staggered decays. */
  function bell(freq, t, vol, dur, wet) {
    var partials = [1, 2.0, 3.01, 4.2, 5.43];
    var levels = [1, 0.45, 0.22, 0.14, 0.07];
    var out = gain(1, bus);
    if (wet) {
      var w = gain(wet, send);
      out.connect(w);
    }
    for (var i = 0; i < partials.length; i++) {
      tone('sine', freq * partials[i], t, 0.004, dur / (1 + i * 0.7), vol * levels[i], out);
    }
  }

  function buildGraph() {
    master = gain(muted ? 0 : 0.9, null);
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 5;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    master.connect(comp);
    comp.connect(ctx.destination);

    bus = gain(1, master);

    // feedback delay network used as a cheap, dreamy reverb
    send = gain(1, null);
    var wetOut = gain(0.5, master);
    var times = [0.293, 0.431, 0.617];
    for (var i = 0; i < times.length; i++) {
      var d = ctx.createDelay(1.5);
      d.delayTime.value = times[i];
      var damp = filter('lowpass', 2100 - i * 350, 0.5, null);
      var fb = gain(0.52, null);
      send.connect(d);
      d.connect(damp);
      damp.connect(fb);
      fb.connect(d);
      damp.connect(wetOut);
    }
  }

  function startDrone() {
    var droneGain = gain(0.0001, null);
    var lp = filter('lowpass', 380, 1.2, droneGain);
    droneGain.connect(bus);
    var wet = gain(0.35, send);
    droneGain.connect(wet);
    droneGain.gain.exponentialRampToValueAtTime(0.2, now() + 6);

    // slow filter breathing
    var lfo = osc('sine', 0.031, gain(170, lp.frequency));
    lfo.start();

    var voices = [
      { f: 73.42, type: 'sawtooth', vol: 0.5, rate: 0.05 },   // D2
      { f: 110.0, type: 'sawtooth', vol: 0.34, rate: 0.073 }, // A2
      { f: 146.83, type: 'triangle', vol: 0.4, rate: 0.041 }, // D3
      { f: 174.61, type: 'triangle', vol: 0.26, rate: 0.089 },// F3
      { f: 220.0, type: 'sine', vol: 0.2, rate: 0.063 },      // A3
      { f: 587.33, type: 'sine', vol: 0.05, rate: 0.11 }      // D5 shimmer
    ];
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      var vg = gain(v.vol * 0.6, lp);
      osc(v.type, v.f, vg, -5).start();
      osc(v.type, v.f, vg, 6).start();
      // amplitude drift per voice
      var mod = osc('sine', v.rate, gain(v.vol * 0.4, vg.gain));
      mod.start();
    }
  }

  function startHum() {
    var g = gain(0.0001, bus);
    var lp = filter('lowpass', 140, 5, g);
    var o1 = osc('sawtooth', 62, lp);
    var o2 = osc('square', 93.4, gain(0.4, lp));
    var wob = osc('sine', 11, gain(3, o1.frequency));
    o1.start(); o2.start(); wob.start();
    hum = { g: g, lp: lp, o1: o1, o2: o2 };
  }

  var Audio = {};

  /** Must be called from a user gesture. Safe to call repeatedly. */
  Audio.init = function () {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      buildGraph();
      startDrone();
      startHum();
      ready = true;
      if (ctx.state === 'suspended') ctx.resume();
    } catch (err) {
      ready = false;
      if (root.console) root.console.warn('Audio unavailable:', err);
    }
  };

  Audio.isMuted = function () { return muted; };

  Audio.setMuted = function (m) {
    muted = !!m;
    if (ready) master.gain.setTargetAtTime(muted ? 0 : 0.9, now(), 0.05);
  };

  Audio.toggleMute = function () {
    Audio.setMuted(!muted);
    return muted;
  };

  /**
   * Per-frame update.
   * humLevel 0..1 : how fast the lamp is being moved (drives the low-pass sweep)
   * alert    0..1 : sentinel exposure gauge (drives the warning pulse)
   */
  Audio.update = function (dt, humLevel, alert) {
    if (!ready) return;
    var t = now();
    var h = Math.max(0, Math.min(1, humLevel));
    hum.g.gain.setTargetAtTime(0.0001 + h * 0.085, t, 0.07);
    hum.lp.frequency.setTargetAtTime(140 + h * 1250, t, 0.09);
    hum.o1.frequency.setTargetAtTime(62 + h * 22, t, 0.12);
    hum.o2.frequency.setTargetAtTime(93.4 + h * 33, t, 0.12);

    // sparse ambient bells
    bellTimer -= dt;
    if (bellTimer <= 0) {
      bellTimer = 3.5 + Math.random() * 5.5;
      var f = PENTA[Math.floor(Math.random() * PENTA.length)];
      bell(f * (Math.random() < 0.3 ? 0.5 : 1), t + 0.02, 0.035, 3.2, 0.9);
    }

    // warning pulse accelerates as the gauge fills
    if (alert > 0.02) {
      alertTimer -= dt;
      if (alertTimer <= 0) {
        alertTimer = 0.52 - 0.34 * alert;
        var vol = 0.16 + 0.3 * alert;
        tone('sine', 74, t, 0.008, 0.2, vol, bus, 40);
        var lp = filter('lowpass', 260 + alert * 500, 4, bus);
        tone('sawtooth', 55, t, 0.01, 0.16, vol * 0.5, lp, 49);
        tone('square', 880 + alert * 440, t + 0.02, 0.004, 0.05, 0.012 + 0.02 * alert, bus);
      }
    } else {
      alertTimer = 0;
    }
  };

  Audio.bridgeEnter = function () {
    if (!ready) return;
    var t = now();
    bell(587.33, t, 0.11, 1.6, 0.8);
    bell(880.0, t + 0.09, 0.09, 1.9, 0.8);
    bell(1174.66, t + 0.19, 0.06, 2.2, 0.9);
  };

  Audio.bridgeExit = function () {
    if (!ready) return;
    var t = now();
    bell(880.0, t, 0.08, 1.3, 0.8);
    bell(587.33, t + 0.1, 0.07, 1.7, 0.8);
  };

  /** Soft water-drop when stepping on a shadow bridge. */
  Audio.step = function () {
    if (!ready) return;
    var t = now();
    if (t - lastStep < 0.12) return;
    lastStep = t;
    var f = PENTA[2 + Math.floor(Math.random() * 5)] * 2;
    tone('sine', f, t, 0.003, 0.22, 0.03, bus, f * 1.25);
    tone('sine', f, t, 0.003, 0.3, 0.012, send);
  };

  Audio.jump = function () {
    if (!ready) return;
    tone('triangle', 260, now(), 0.006, 0.14, 0.06, bus, 520);
  };

  Audio.land = function () {
    if (!ready) return;
    tone('sine', 130, now(), 0.004, 0.11, 0.1, bus, 58);
  };

  Audio.fall = function () {
    if (!ready) return;
    var t = now();
    tone('sine', 520, t, 0.01, 0.75, 0.1, bus, 62);
    tone('triangle', 392, t, 0.01, 0.75, 0.05, send, 49);
  };

  /** Caught by a sentinel: digital glitch burst + falling siren. */
  Audio.caught = function () {
    if (!ready) return;
    var t = now();
    var lp = filter('bandpass', 1400, 0.8, bus);
    for (var v = 0; v < 5; v++) {
      var g = gain(0, lp);
      var o = osc('square', 200, g);
      for (var k = 0; k < 22; k++) {
        var tt = t + k * 0.024;
        o.frequency.setValueAtTime(90 + Math.random() * 2600, tt);
        g.gain.setValueAtTime(Math.random() < 0.7 ? 0.07 : 0, tt);
      }
      g.gain.setValueAtTime(0, t + 0.54);
      o.start(t);
      o.stop(t + 0.56);
    }
    tone('sawtooth', 330, t, 0.01, 0.7, 0.14, filter('lowpass', 900, 3, bus), 41);
    tone('sine', 98, t, 0.01, 0.9, 0.3, bus, 36);
  };

  Audio.restart = function () {
    if (!ready) return;
    var t = now();
    tone('triangle', 440, t, 0.005, 0.12, 0.06, bus, 220);
    tone('triangle', 220, t + 0.09, 0.005, 0.16, 0.06, bus, 330);
  };

  /** Stage-clear fanfare (longer, with a final cadence, when `finale` is true). */
  Audio.fanfare = function (finale) {
    if (!ready) return;
    var t = now() + 0.03;
    var notes = finale
      ? [293.66, 369.99, 440.0, 587.33, 739.99, 880.0, 1174.66]
      : [293.66, 369.99, 440.0, 587.33, 739.99];
    var step = finale ? 0.13 : 0.11;
    var wet = gain(0.6, send);
    var dry = gain(1, bus);
    dry.connect(wet);
    for (var i = 0; i < notes.length; i++) {
      var tt = t + i * step;
      tone('triangle', notes[i], tt, 0.008, 0.5, 0.13, dry);
      tone('sine', notes[i] * 2, tt, 0.008, 0.35, 0.05, dry);
      tone('sawtooth', notes[i], tt, 0.01, 0.3, 0.025, filter('lowpass', 1800, 1, dry));
    }
    var end = t + notes.length * step;
    var chord = finale ? [146.83, 220.0, 293.66, 369.99, 440.0, 587.33, 880.0] : [146.83, 293.66, 369.99, 440.0, 587.33];
    var len = finale ? 3.6 : 1.9;
    for (var c = 0; c < chord.length; c++) {
      tone('triangle', chord[c], end, 0.03, len, 0.085, dry);
      tone('sine', chord[c] * 2.005, end, 0.05, len * 0.8, 0.03, dry);
    }
    bell(1174.66, end, 0.07, len, 0.9);
    if (finale) {
      bell(1479.98, end + 0.4, 0.05, 3, 0.9);
      bell(1760.0, end + 0.8, 0.045, 3.4, 0.9);
    }
  };

  SW.Audio = Audio;
})(typeof globalThis !== 'undefined' ? globalThis : this);
