// Live chain, measured: renders the noisy demo take through the real-time graph in an
// OfflineAudioContext inside the app (same worklets/WASM as live), then checks noise reduction,
// ceiling, loudness, speed and true latency per denoise engine. Finally goes live on a fake mic.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dsp = require('../src/main/dsp');

const T = path.join(os.tmpdir(), 'auddo-live');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };

function wav(file, chans, sr = 48000) {
  const n = chans[0].length, c = chans.length, b = Buffer.alloc(44 + n * 4 * c);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4 * c, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(c, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 4 * c, 28); b.writeUInt16LE(4 * c, 32); b.writeUInt16LE(32, 34); b.write('data', 36); b.writeUInt32LE(n * 4 * c, 40);
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) b.writeFloatLE(chans[k][i], 44 + (i * c + k) * 4);
  fs.writeFileSync(file, b);
}

(async () => {
  const take = path.join(os.tmpdir(), 'auddo-test', 'take.wav');
  if (!fs.existsSync(take)) throw new Error('run npm test first');
  const mic = path.join(T, 'mic.wav');
  await dsp.run(['-y', '-stream_loop', '3', '-i', take, '-c:a', 'pcm_s16le', mic]);

  const app = await electron.launch({
    args: ['.', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AUDDO_TAKES: path.join(T, 'takes'), AUDDO_NO_TRASH: '1' },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()));
  await page.waitForFunction(() => window.__ready, null, { timeout: 30000 });

  const render = (engine, params) => page.evaluate(async ({ take, engine, params }) => {
    const buf = await window.api.readFile(take);
    const tmp = new AudioContext({ sampleRate: 48000 });
    const ab = await tmp.decodeAudioData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    tmp.close();
    const off = new OfflineAudioContext(2, ab.length, 48000);
    const src = off.createBufferSource(); src.buffer = ab;
    const chain = await window.AuddoLive.build(off, src, params, engine);
    chain.output.connect(off.destination);
    src.start();
    // The WASM denoisers load asynchronously; hold the render until they are ready.
    off.suspend(128 / 48000).then(async () => { await new Promise((r) => setTimeout(r, 800)); off.resume(); });
    const t0 = performance.now();
    const out = await off.startRendering();
    const ms = performance.now() - t0;
    return { ms, dur: ab.duration, input: Array.from(ab.getChannelData(0)), L: Array.from(out.getChannelData(0)), R: Array.from(out.getChannelData(1)) };
  }, { take, engine, params });

  const rms = (a, s, e) => { let q = 0; const i0 = Math.round(s * 48000), i1 = Math.round(e * 48000); for (let i = i0; i < i1; i++) q += a[i] * a[i]; return 10 * Math.log10(q / (i1 - i0) + 1e-20); };
  const lag = (x, y) => { // cross-correlation peak, lags 0..3000, over the voice region
    let best = -Infinity, at = 0;
    for (let L = 0; L <= 3000; L += 1) { let s = 0; for (let i = 2.3 * 48000; i < 4.3 * 48000; i += 2) s += x[i] * y[i + L]; if (s > best) { best = s; at = L; } }
    return at;
  };
  const presets = await page.evaluate(() => window.AUDDO.PRESETS);
  const inNoise = rms((await render(null, { ...presets.clean.params, denoise: 0 })).input, 0.3, 1.7);

  // ---- latency: clean speech through the full chain with only the denoiser active (fully wet)
  const voice = path.join(os.tmpdir(), 'auddo-test', 'voice.wav');
  const lat = await page.evaluate(async (voice) => {
    const buf = await window.api.readFile(voice);
    const tmp = new AudioContext({ sampleRate: 48000 });
    const ab = await tmp.decodeAudioData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); tmp.close();
    const p = { lowcut: 40, denoise: 100, declick: 0, warmth: 0, mud: 0, presence: 0, air: 0, excite: 0, deess: 0, comp: 0, reverb: 0, echo: 0, size: 1, predelay: 0, damping: 50, width: 50, echoMs: 190, loudness: null };
    const out = {};
    for (const eng of [null, 'rnnoise', 'gtcrn']) {
      const off = new OfflineAudioContext(2, ab.length + 48000, 48000);
      const src = off.createBufferSource(); src.buffer = ab;
      const ch = await window.AuddoLive.build(off, src, { ...p, denoise: eng ? 100 : 0 }, eng);
      ch.output.connect(off.destination); src.start(0.5);
      off.suspend(0.25).then(async () => { await new Promise((r) => setTimeout(r, 800)); off.resume(); });
      const y = (await off.startRendering()).getChannelData(0);
      const x = new Float32Array(y.length); x.set(ab.getChannelData(0), 24000);
      let best = -1e9, at = 0;
      for (let L = -100; L <= 2500; L++) { let s = 0; for (let i = 48000; i < 48000 * 3; i += 2) s += x[i] * y[i + L]; if (s > best) { best = s; at = L; } }
      out[eng || 'none'] = { lag: at, assumed: ch.latencySamples };
    }
    return out;
  }, voice);
  // Compare each engine against the no-engine baseline: cancels the probe's own few-sample bias.
  for (const k of ['rnnoise', 'gtcrn']) {
    const meas = lat[k].lag - lat.none.lag, code = lat[k].assumed - lat.none.assumed;
    console.log(`${k}: measured ${meas} samples (${(meas / 48).toFixed(1)} ms) over baseline, code compensates ${code}`);
    check(Math.abs(meas - code) <= 4, `${k} dry-path delay matches the engine's real latency`);
  }

  // ---- presets through each engine
  for (const eng of ['gtcrn', 'rnnoise']) {
    for (const key of ['ktv', 'hifi', 'clean']) {
      const p = presets[key].params;
      const r = await render(eng, p);
      const nIn = rms(r.input, 0.3, 1.7), vIn = rms(r.input, 2.4, 5.4);
      const nOut = rms(r.L, 0.3, 1.7), vOut = rms(r.L, 2.4, 5.4);
      let peak = 0, nan = false;
      for (const a of [r.L, r.R]) for (const v of a) { if (!Number.isFinite(v)) nan = true; peak = Math.max(peak, Math.abs(v)); }
      const f = path.join(T, `live-${eng}-${key}.wav`);
      wav(f, [Float32Array.from(r.L), Float32Array.from(r.R)]);
      const m = await dsp.measure(f);
      const snrGain = (vOut - nOut) - (vIn - nIn);
      console.log(`[${eng} ${key}] ${(r.dur / (r.ms / 1000)).toFixed(0)}x realtime · SNR +${snrGain.toFixed(1)} dB · peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS · ${m.I} LUFS (target ${p.loudness}) -> ${f}`);
      check(!nan, 'no NaN/Inf');
      check(peak <= Math.pow(10, -1 / 20) + 1e-4, 'output never exceeds -1 dBFS');
      const bar = key === 'ktv' ? 10 : 12; // KTV keeps denoise light on purpose (sung notes)
      check(snrGain > bar, `noise reduced (${snrGain.toFixed(1)} dB, bar ${bar})`);
      check(r.dur / (r.ms / 1000) > 3, 'renders comfortably faster than real time');
    }
  }

  // ---- loudness: leveler converges on a longer, steady programme (4 loops of the take)
  const long = path.join(T, 'long.wav');
  await dsp.run(['-y', '-stream_loop', '3', '-i', take, '-c:a', 'pcm_f32le', long]);
  const lr = await page.evaluate(async ({ long, params }) => {
    const buf = await window.api.readFile(long);
    const tmp = new AudioContext({ sampleRate: 48000 });
    const ab = await tmp.decodeAudioData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); tmp.close();
    const off = new OfflineAudioContext(2, ab.length, 48000);
    const src = off.createBufferSource(); src.buffer = ab;
    const chain = await window.AuddoLive.build(off, src, params, 'gtcrn');
    chain.output.connect(off.destination); src.start();
    off.suspend(128 / 48000).then(async () => { await new Promise((r) => setTimeout(r, 800)); off.resume(); });
    const out = await off.startRendering();
    const from = Math.round(out.length / 2); // second half: after the leveler has settled
    return { L: Array.from(out.getChannelData(0).subarray(from)), R: Array.from(out.getChannelData(1).subarray(from)) };
  }, { long, params: presets.hifi.params });
  const lf = path.join(T, 'live-leveler.wav');
  wav(lf, [Float32Array.from(lr.L), Float32Array.from(lr.R)]);
  const lm = await dsp.measure(lf);
  check(Math.abs(lm.I - presets.hifi.params.loudness) < 2.5, `leveler settles near target: ${lm.I} LUFS vs ${presets.hifi.params.loudness}`);

  // ---- actually go live on the fake mic and watch the meters
  await page.selectOption('#liveOut', { index: 0 }).catch(() => {});
  await page.click('#liveBtn');
  // The fake mic loops a 12 s take that is half silence, so look at a full loop (~10 s of meters).
  await page.waitForFunction(() => window.__live && window.__live.meters && window.__live.meters.length > 240, null, { timeout: 30000 });
  const meters = await page.evaluate(() => window.__live.meters.slice(-240));
  const active = meters.filter((m) => m.rms > -60).length;
  check(active > 20, `live output carries audio (${active}/240 meter frames active)`);
  check(meters.every((m) => m.peak <= -0.99), 'live output stays under -1 dBFS');
  const maxLev = Math.max(...meters.map((m) => m.leveler));
  check(maxLev < 14, `leveler doesn't climb on pauses/room tone (max +${maxLev.toFixed(1)} dB)`);
  const quiet = meters.filter((m) => m.rms < -60).length;
  check(quiet > 10, `pauses stay quiet live (${quiet}/240 frames below -60 dBFS)`);
  const liveLat = await page.evaluate(() => window.__live.latencyMs);
  console.log('live latency estimate:', liveLat.toFixed(1), 'ms');
  await page.screenshot({ path: path.join(T, 'live.png') });
  await page.click('#liveBtn');

  await app.close();
  console.log(failed ? `\n${failed} failed` : '\nall live checks passed', '\nfiles in', T);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
