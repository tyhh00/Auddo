// Offline DSP checks: render every preset over a noisy synthetic take and verify loudness,
// true-peak ceiling, noise reduction and that the pipeline is sample-aligned (for backing sync).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const dsp = require('../src/main/dsp');
const { PRESETS } = require('../src/shared/presets');

const out = path.join(os.tmpdir(), 'auddo-test');
fs.mkdirSync(out, { recursive: true });
const model = path.join(__dirname, '..', 'assets', 'models', 'bd.rnnn');
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };

async function rmsDb(file, start, dur) {
  const err = await dsp.run(['-ss', String(start), '-t', String(dur), '-i', file, '-af', 'astats=measure_overall=RMS_level:measure_perchannel=none', '-f', 'null', '-']);
  return parseFloat(/RMS level dB: (-?[\d.]+|-inf)/.exec(err)[1]);
}

// Peak sample index of an impulse - used to prove zero added latency.
function peakIndex(file) {
  const raw = execFileSync(dsp.FFMPEG, ['-hide_banner', '-i', file, '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  let best = 0, at = 0;
  for (let i = 0; i < raw.length / 4; i++) { const v = Math.abs(raw.readFloatLE(i * 4)); if (v > best) { best = v; at = i; } }
  return at;
}

(async () => {
  const caps = dsp.capabilities();
  console.log('ffmpeg:', caps.version, caps);

  // 2 s room tone, then a voice-like source; whole thing over pink noise + 50 Hz hum at a realistic floor.
  const take = path.join(out, 'take.wav');
  let voice;
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', "flite=text='The quick brown fox jumps over the lazy dog. She sells sea shells by the sea shore.':voice=slt", '-y', path.join(out, 'voice.wav')]);
    voice = path.join(out, 'voice.wav');
  } catch {
    console.log('(no flite; using synthetic vowel)');
  }
  const src = voice ? ['-i', voice] : ['-f', 'lavfi', '-i', 'sine=f=180:d=6,aformat=channel_layouts=mono'];
  await dsp.run(['-y', ...src,
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.004:d=12',
    '-f', 'lavfi', '-i', 'sine=f=50:d=12,volume=0.002',
    '-filter_complex', '[0:a]aresample=48000,aformat=channel_layouts=mono,volume=0.35,adelay=2000[v];[v][1:a][2:a]amix=inputs=3:normalize=0:duration=longest',
    '-ar', '48000', '-c:a', 'pcm_f32le', take]);

  const origNoise = await rmsDb(take, 0.3, 1.4);
  const origVoice = await rmsDb(take, 2.2, 3);
  console.log(`original: room tone ${origNoise.toFixed(1)} dB, voice ${origVoice.toFixed(1)} dB -> SNR ${(origVoice - origNoise).toFixed(1)} dB`);

  for (const [key, pre] of Object.entries(PRESETS)) {
    const t0 = Date.now();
    const r = await dsp.processVoice({ input: take, params: pre.params, noiseFloorDb: origNoise, modelPath: model });
    const dest = path.join(out, `out-${key}.wav`);
    fs.copyFileSync(r.output, dest);
    const { final } = r.stats;
    const n = await rmsDb(dest, 0.3, 1.4), v = await rmsDb(dest, 2.2, 3);
    console.log(`\n[${pre.name}] ${((Date.now() - t0) / 1000).toFixed(1)}s  I=${final.I} TP=${final.TP} LRA=${final.LRA}  SNR ${(v - n).toFixed(1)} dB  -> ${dest}`);
    check(Math.abs(final.I - pre.params.loudness) < 1, `integrated loudness ${final.I} ~ ${pre.params.loudness} LUFS`);
    check(final.TP <= -0.8, `true peak ${final.TP} <= -0.8 dBTP`);
    check(v - n > origVoice - origNoise + 10, `SNR improved by >10 dB (${(v - n - (origVoice - origNoise)).toFixed(1)} dB)`);
  }

  // Alignment: a click at exactly 1.000 s must still peak at 1.000 s after the full chain (dry path dominant).
  const click = path.join(out, 'click.wav');
  await dsp.run(['-y', '-f', 'lavfi', '-i', "aevalsrc='if(eq(n,48000),0.5,0)':s=48000:d=3", '-c:a', 'pcm_f32le', click]);
  const r = await dsp.processVoice({ input: click, params: { ...PRESETS.ktv.params, denoise: 0, comp: 0, deess: 0, excite: 0, declick: 0 }, noiseFloorDb: -90 });
  const at = peakIndex(r.output);
  check(Math.abs(at - 48000) <= 48, `pipeline latency ${at - 48000} samples (<= 1 ms)`);

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
