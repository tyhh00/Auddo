/* global AUDDO_IR, api */
// Real-time version of the Auddo chain, built from Web Audio nodes + AudioWorklets.
// Works on an AudioContext (live) or an OfflineAudioContext (tests): same graph, same numbers.
//
//   src -> HPF x2 -> [AI denoise wet | delayed dry] -> dyn (expander + 2-stage comp)
//       -> warmth / mud / presence / air EQ -> (+ harmonic sheen) -> de-ess
//       -> dry + stereo convolver send (reverb + echo IR) -> master (leveler + look-ahead limiter)
(function (root) {
  const NS_DIR = '../../node_modules/@sapphi-red/web-noise-suppressor/dist/';
  const ENGINES = {
    gtcrn: { id: '@sapphi-red/web-noise-suppressor/gtcrn', module: NS_DIR + 'gtcrn/workletProcessor.js', wasm: 'gtcrn' },
    rnnoise: { id: '@sapphi-red/web-noise-suppressor/rnnoise', module: NS_DIR + 'rnnoise/workletProcessor.js', wasm: 'rnnoise_simd' },
  };
  // Denoiser latency in samples @48 kHz, measured with clean speech in test/live.e2e.js
  // (RNNoise ≈ 512-sample ring + one 480 frame; GTCRN ≈ two 768 frames). The dry path is delayed to
  // match, so a partial denoise mix doesn't comb-filter.
  const LATENCY = { gtcrn: 1531, rnnoise: 991 };

  const wasmCache = {};
  const loaded = new WeakMap();

  async function prepare(ctx, engine) {
    const mods = loaded.get(ctx) || new Set();
    loaded.set(ctx, mods);
    const want = ['live-worklet.js', engine && ENGINES[engine].module].filter(Boolean);
    for (const m of want) if (!mods.has(m)) { await ctx.audioWorklet.addModule(m); mods.add(m); }
    if (engine && !wasmCache[engine]) {
      const buf = await api.readWasm(ENGINES[engine].wasm);
      wasmCache[engine] = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
  }

  function biquad(ctx, type, f, q = 0.707, g = 0) {
    const b = ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g;
    return b;
  }

  function shaperCurve(drive) {
    const n = 2048, c = new Float32Array(n), t = Math.tanh(drive);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(drive * x) / t; }
    return c;
  }

  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} source  mono (or downmixed) voice
   * @param {object} params     same shape as AUDDO.PRESETS[x].params
   * @param {'gtcrn'|'rnnoise'|null} engine
   */
  async function build(ctx, source, params, engine = 'gtcrn') {
    await prepare(ctx, engine);
    const mono = (node) => { node.channelCount = 1; node.channelCountMode = 'explicit'; node.channelInterpretation = 'speakers'; return node; };

    const inGain = mono(ctx.createGain());
    source.connect(inGain);
    const hp1 = mono(biquad(ctx, 'highpass', 100)), hp2 = mono(biquad(ctx, 'highpass', 60));
    inGain.connect(hp1).connect(hp2);

    // ---- AI denoise with a latency-matched dry path for partial mixes
    const nsOut = mono(ctx.createGain());
    const wet = mono(ctx.createGain()), dry = mono(ctx.createGain());
    let ns = null;
    if (engine) {
      ns = new AudioWorkletNode(ctx, ENGINES[engine].id, {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
        processorOptions: { maxChannels: 1, wasmBinary: wasmCache[engine] },
      });
      hp2.connect(ns).connect(wet).connect(nsOut);
    }
    const dly = ctx.createDelay(0.1);
    dly.delayTime.value = engine ? LATENCY[engine] / ctx.sampleRate : 0;
    hp2.connect(dly).connect(dry).connect(nsOut);

    const dyn = new AudioWorkletNode(ctx, 'auddo-dyn', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
    nsOut.connect(dyn);

    const warm = mono(biquad(ctx, 'lowshelf', 150));
    const mud = mono(biquad(ctx, 'peaking', 320, 1.1));
    const pres = mono(biquad(ctx, 'peaking', 4000, 0.9));
    const air = mono(biquad(ctx, 'highshelf', 10000));
    dyn.connect(warm).connect(mud).connect(pres).connect(air);

    // Harmonic sheen: a gently saturated copy of the top end, mixed back in.
    const exHp = mono(biquad(ctx, 'highpass', 6500));
    const exSh = ctx.createWaveShaper(); exSh.curve = shaperCurve(4); exSh.oversample = '4x';
    const exGain = mono(ctx.createGain());
    const sum = mono(ctx.createGain());
    air.connect(sum);
    air.connect(exHp).connect(exSh).connect(exGain).connect(sum);

    const deess = new AudioWorkletNode(ctx, 'auddo-deess', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
    sum.connect(deess);

    // ---- space: centred dry + stereo convolution send
    const bus = ctx.createGain(); bus.channelCount = 2; bus.channelCountMode = 'explicit'; bus.channelInterpretation = 'speakers';
    deess.connect(bus); // mono -> stereo upmix (same signal both sides)
    const sendHp = mono(biquad(ctx, 'highpass', 220)), sendLp = mono(biquad(ctx, 'lowpass', 12000));
    const conv = ctx.createConvolver(); conv.normalize = false;
    const wetGain = ctx.createGain();
    deess.connect(sendHp).connect(sendLp).connect(conv).connect(wetGain).connect(bus);

    const master = new AudioWorkletNode(ctx, 'auddo-master', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    bus.connect(master);

    let irKey = '', irTimer = null;
    function setIR(p) {
      const key = ['reverb', 'size', 'predelay', 'damping', 'width', 'echo', 'echoMs'].map((k) => p[k]).join('|');
      if (key === irKey) return;
      irKey = key;
      if (!(p.reverb > 0 || p.echo > 0)) { wetGain.gain.value = 0; return; }
      const [L, R] = AUDDO_IR.buildIR(p);
      const b = ctx.createBuffer(2, L.length, ctx.sampleRate);
      b.copyToChannel(L, 0); b.copyToChannel(R, 1);
      conv.buffer = b;
      wetGain.gain.value = 1;
    }

    function setParams(p, { immediate = false } = {}) {
      const t = ctx.currentTime, k = (param, v) => (immediate ? (param.value = v) : param.setTargetAtTime(v, t, 0.03));
      k(hp1.frequency, p.lowcut); k(hp2.frequency, Math.round(p.lowcut * 0.6));
      // Offline adds a spectral denoise after RNNoise; live has only the AI stage, so it runs a
      // stronger mix to land at similar noise reduction (30% -> 0.48, 55% -> 0.88, 63%+ -> fully wet).
      const d = engine ? Math.max(0, Math.min(1, (p.denoise / 100) * 1.6)) : 0;
      k(wet.gain, d); k(dry.gain, 1 - d);
      k(warm.gain, p.warmth || 0); k(mud.gain, -(p.mud || 0)); k(pres.gain, p.presence || 0); k(air.gain, p.air || 0);
      k(exGain.gain, (p.excite / 100) * 0.35);
      dyn.port.postMessage({ comp: p.comp, denoise: p.denoise });
      deess.port.postMessage({ deess: p.deess });
      master.port.postMessage({ loudness: p.loudness ?? -16 });
      if (immediate) setIR(p);
      else { clearTimeout(irTimer); irTimer = setTimeout(() => setIR(p), 120); }
    }

    setParams(params, { immediate: true });

    return {
      output: master,
      meter: master.port,
      setParams,
      setOutputDb: (db) => master.port.postMessage({ outputDb: db }),
      latencySamples: (engine ? LATENCY[engine] : 0) + Math.round(ctx.sampleRate * 0.0015),
      dispose() {
        try { source.disconnect(inGain); } catch {}
        [inGain, hp1, hp2, ns, wet, dry, dly, nsOut, dyn, warm, mud, pres, air, exHp, exSh, exGain, sum, deess, bus, sendHp, sendLp, conv, wetGain, master]
          .forEach((n) => { try { n && n.disconnect(); } catch {} });
        try { ns && ns.port.postMessage('destroy'); } catch {}
      },
    };
  }

  root.AuddoLive = { build, prepare, ENGINES, LATENCY };
})(this);
