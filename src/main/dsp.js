// ffmpeg-driven offline processing: filter-chain builder, loudness measurement, render + export.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildIR, wavFloatStereo, SR } = require('./ir');

const CEILING_DB = -1.0; // true-peak ceiling for every render

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const p = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(p)) return p;
  } catch {}
  return 'ffmpeg';
}

const FFMPEG = resolveFfmpeg();
let caps = null;

// Option names differ across ffmpeg versions (afir gtype -> irnorm in 7.x; soxr only in full builds).
function capabilities() {
  if (caps) return caps;
  const help = (f) => { try { return execFileSync(FFMPEG, ['-hide_banner', '-h', 'filter=' + f], { encoding: 'utf8', windowsHide: true }); } catch { return ''; } };
  let conf = '';
  try { conf = execFileSync(FFMPEG, ['-hide_banner', '-buildconf'], { encoding: 'utf8', windowsHide: true }); } catch {}
  let version = '?';
  try { version = execFileSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true }).split('\n')[0]; } catch {}
  const afir = help('afir');
  caps = {
    path: FFMPEG, version,
    soxr: conf.includes('libsoxr'),
    irnorm: afir.includes('irnorm'),
    limiterLatency: help('alimiter').includes('latency'),
    lame: conf.includes('libmp3lame'),
  };
  return caps;
}

function resample(rate) {
  return capabilities().soxr
    ? `aresample=${rate}:resampler=soxr:precision=28`
    : `aresample=${rate}:filter_size=256:cutoff=0.97`;
}

const db2lin = (db) => Math.pow(10, db / 20);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const f = (n, d = 3) => Number(n).toFixed(d);

/**
 * Builds the -filter_complex graph. Input 0 = voice, input 1 = IR (when reverb/echo is on).
 * Order: HPF -> denoise -> subtractive EQ -> compressor -> additive EQ -> exciter -> de-ess -> space.
 */
function buildGraph(p, opts = {}) {
  const nf = clamp(Math.round(opts.noiseFloorDb ?? -60), -80, -20);
  const chain = [
    resample(SR),
    'aformat=sample_fmts=fltp:channel_layouts=mono',
    `highpass=f=${p.lowcut}:poles=2`,
    `highpass=f=${Math.round(p.lowcut * 0.6)}:poles=2`, // 4th-order total: kills rumble/plosive thump
  ];
  if (p.declick) chain.push('adeclick=w=55:o=75:a=2:t=2');
  if (p.denoise > 0) {
    if (opts.model) chain.push(`arnndn=m=${opts.model}:mix=${f(clamp(p.denoise / 100 * 0.95, 0, 1), 2)}`);
    // Spectral cleanup of the residual hiss using the measured floor of this take.
    chain.push(`afftdn=nr=${f(4 + p.denoise * 0.14, 1)}:nf=${nf}:tn=1`);
    // Soft downward expander between phrases, so the compressor below can't pull the floor back up.
    // Keyed ~12 dB above the measured room tone; max 6-14 dB of attenuation, slow release keeps tails natural.
    chain.push(`agate=threshold=${f(db2lin(nf + 12), 6)}:range=${f(db2lin(-6 - p.denoise * 0.08), 4)}:ratio=2:attack=8:release=350:knee=4:detection=rms`);
  }
  if (p.warmth) chain.push(`lowshelf=f=150:g=${p.warmth}:t=s:w=0.6`);
  if (p.mud) chain.push(`equalizer=f=320:t=q:w=1.1:g=${-p.mud}`);
  if (p.comp > 0) {
    const c = p.comp / 100;
    // Two gentle stages sound more transparent than one hard one.
    chain.push(`acompressor=threshold=${f(db2lin(-14 - 10 * c), 5)}:ratio=${f(1.5 + 1.5 * c, 2)}:attack=${f(25 - 12 * c, 1)}:release=180:knee=6:detection=rms`);
    chain.push(`acompressor=threshold=${f(db2lin(-8 - 6 * c), 5)}:ratio=${f(2 + 2 * c, 2)}:attack=${f(6 - 3 * c, 1)}:release=90:knee=4`);
  }
  if (p.presence) chain.push(`equalizer=f=4000:t=q:w=0.9:g=${p.presence}`);
  if (p.air) chain.push(`highshelf=f=10000:g=${p.air}:t=s:w=0.5`);
  if (p.excite > 0) chain.push(`aexciter=amount=${f(p.excite / 100 * 2.5, 2)}:drive=6:blend=0:freq=6500:ceil=18000`);
  if (p.deess > 0) chain.push(`deesser=i=${f(0.2 + p.deess / 100 * 0.6, 2)}:m=${f(0.3 + p.deess / 100 * 0.5, 2)}:f=0.5:s=o`);
  chain.push('aformat=channel_layouts=stereo');

  const space = p.reverb > 0 || p.echo > 0;
  if (!space) return { graph: `[0:a]${chain.join(',')}[out]`, needsIR: false };

  const irOpt = capabilities().irnorm ? 'irnorm=-1' : 'gtype=none';
  const graph = [
    `[0:a]${chain.join(',')},asplit=2[dry][send]`,
    // Keep the reverb out of the low end so the voice stays tight.
    `[send]highpass=f=220,lowpass=f=12000[sendf]`,
    `[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo[ir]`,
    `[sendf][ir]afir=dry=1:wet=1:${irOpt}:minp=256:maxp=8192[wet]`,
    `[dry][wet]amix=inputs=2:weights=1 1:normalize=0[out]`,
  ].join(';');
  return { graph, needsIR: true };
}

// ---------------------------------------------------------------- process runner
const running = new Set();

function run(args, { cwd, duration, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const ps = spawn(FFMPEG, ['-hide_banner', '-nostdin', ...args], { cwd, windowsHide: true });
    running.add(ps);
    let err = '';
    ps.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 2e6) err = err.slice(-1e6);
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
      if (m && duration && onProgress) onProgress(clamp((+m[1] * 3600 + +m[2] * 60 + +m[3]) / duration, 0, 1));
    });
    ps.on('error', (e) => { running.delete(ps); reject(e); });
    ps.on('close', (code, sig) => {
      running.delete(ps);
      if (code === 0) resolve(err);
      else { const e = new Error(sig ? 'cancelled' : `ffmpeg exited ${code}: ${err.split('\n').slice(-8).join('\n')}`); e.cancelled = !!sig; reject(e); }
    });
  });
}

function cancelAll() { for (const ps of running) ps.kill(); }

/** EBU R128 integrated loudness / true peak / LRA via loudnorm's analysis pass. */
async function measure(file, cwd) {
  const err = await run(['-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { cwd });
  const j = JSON.parse(err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1));
  const num = (v) => (isFinite(parseFloat(v)) ? parseFloat(v) : null);
  return { I: num(j.input_i), TP: num(j.input_tp), LRA: num(j.input_lra) };
}

async function probeDuration(file) {
  const err = await run(['-i', file, '-f', 'null', '-'], {}).catch((e) => e.message);
  const all = [...String(err).matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  return all ? +all[1] * 3600 + +all[2] * 60 + +all[3] : 0;
}

/** Gain to target LUFS, then a 4x-oversampled limiter so the true peak stays under the ceiling. */
async function normalize(input, output, targetLufs, cwd, measured) {
  const m = measured || (await measure(input, cwd));
  const gain = targetLufs != null && m.I != null ? targetLufs - m.I : 0;
  const lim = [`limit=${f(db2lin(CEILING_DB - 0.3), 4)}`, 'attack=1.5', 'release=80', 'level=0'];
  if (capabilities().limiterLatency) lim.push('latency=1');
  const af = [`volume=${f(gain, 2)}dB`, resample(SR * 4), `alimiter=${lim.join(':')}`, resample(SR)].join(',');
  await run(['-y', '-i', input, '-af', af, '-c:a', 'pcm_f32le', output], { cwd });
  return gain;
}

const TMP = path.join(os.tmpdir(), 'auddo');
const recentJobs = [];

function jobDir() {
  const d = path.join(TMP, 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Each render is ~23 MB/min of float audio; auto-render while dragging sliders would pile them up.
function keepRecentJobs(dir, keep = 3) {
  recentJobs.push(dir);
  while (recentJobs.length > keep) fs.rmSync(recentJobs.shift(), { recursive: true, force: true });
}

/**
 * Rebuilds peaks flattened by clipping upstream of the app. adeclip only recognises clips at full
 * scale, so the take is lifted until its ceiling sits just over 0 dBFS (float, nothing is lost),
 * repaired, and put back. Slow (~1/3 realtime), so the result is cached per take + ceiling.
 */
async function declipped(input, lowEdgeDb, onProgress) {
  const gain = clamp(-lowEdgeDb + 0.3, 0.3, 40);
  const st = fs.statSync(input);
  const key = require('crypto').createHash('sha1').update(`${input}|${st.size}|${st.mtimeMs}|${gain.toFixed(1)}`).digest('hex').slice(0, 16);
  const out = path.join(TMP, 'cache', `declip-${key}.wav`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const duration = await probeDuration(input);
  await run(['-y', '-i', input, '-af', `aformat=sample_fmts=fltp:channel_layouts=mono,volume=${f(gain, 2)}dB,adeclip=w=55:o=75:a=8:t=10:n=1000,volume=${f(-gain, 2)}dB`,
    '-c:a', 'pcm_f32le', out + '.part.wav'], { duration, onProgress });
  fs.renameSync(out + '.part.wav', out);
  return out;
}

/**
 * Full render: voice file -> processed 48 kHz float stereo WAV, loudness-normalised.
 * Returns { output, stats }.
 */
async function processVoice({ input, params, noiseFloorDb, modelPath, declipLowEdgeDb = null, onProgress = () => {} }) {
  const dir = jobDir();
  keepRecentJobs(dir);
  const original = input;
  // Repair (if on) takes the first 40% of the progress bar; on a cache hit it just jumps ahead.
  const span = declipLowEdgeDb != null ? 0.4 : 0;
  if (span) input = await declipped(input, declipLowEdgeDb, (x) => onProgress(x * span));
  const scaled = (x) => onProgress(span + x * (1 - span));
  const duration = await probeDuration(input);
  let model = null;
  if (modelPath && fs.existsSync(modelPath)) { fs.copyFileSync(modelPath, path.join(dir, 'voice.rnnn')); model = 'voice.rnnn'; }
  const { graph, needsIR } = buildGraph(params, { noiseFloorDb, model });

  const args = ['-y', '-i', input];
  if (needsIR) {
    fs.writeFileSync(path.join(dir, 'ir.wav'), wavFloatStereo(buildIR(params)));
    args.push('-i', 'ir.wav');
  }
  args.push('-filter_complex', graph, '-map', '[out]', '-ar', String(SR), '-c:a', 'pcm_f32le', 'stage1.wav');

  const origP = measure(original, dir).catch(() => ({}));
  await run(args, { cwd: dir, duration, onProgress: (x) => scaled(x * 0.8) });
  scaled(0.82);
  const pre = await measure('stage1.wav', dir);
  scaled(0.88);
  const target = params.loudness ?? -16;
  await normalize('stage1.wav', 'processed.wav', target, dir, pre);
  const final = await measure('processed.wav', dir);
  onProgress(1);
  fs.rmSync(path.join(dir, 'stage1.wav'), { force: true });
  return { output: path.join(dir, 'processed.wav'), dir, stats: { original: await origP, final, duration } };
}

const FORMATS = {
  wav24: { ext: 'wav', args: ['-c:a', 'pcm_s24le'] },
  wav16: { ext: 'wav', args: ['-c:a', 'pcm_s16le'], af: 'aresample=osf=s16:dither_method=triangular_hp' },
  flac24: { ext: 'flac', args: ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-compression_level', '8'] },
  mp3: { ext: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '320k'] },
};

/**
 * Encode the processed vocal, optionally mixed over a backing track.
 * backingDelayMs > 0 delays the backing relative to the vocal (vocal recorded late = positive).
 */
async function exportMix({ processed, dest, format, backing, backingDelayMs = 0, vocalDb = 0, backingDb = 0, loudness = -14 }) {
  const fmt = FORMATS[format] || FORMATS.wav24;
  const dir = jobDir();
  let src = processed;
  if (backing) {
    const d = Math.round(backingDelayMs);
    const voc = d < 0 ? `atrim=start=${f(-d / 1000)},asetpts=PTS-STARTPTS,` : '';
    const bk = d > 0 ? `,adelay=delays=${d}:all=1` : '';
    const graph = `[0:a]${voc}volume=${vocalDb}dB[v];[1:a]${resample(SR)},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${backingDb}dB${bk}[b];[v][b]amix=inputs=2:normalize=0:duration=longest[out]`;
    await run(['-y', '-i', processed, '-i', backing, '-filter_complex', graph, '-map', '[out]', '-ar', String(SR), '-c:a', 'pcm_f32le', 'mix.wav'], { cwd: dir });
    await normalize('mix.wav', 'mixn.wav', loudness, dir);
    src = path.join(dir, 'mixn.wav');
  }
  const args = ['-y', '-i', src];
  if (fmt.af) args.push('-af', fmt.af);
  args.push(...fmt.args, dest);
  await run(args, { cwd: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return dest;
}

module.exports = { TMP, declipped, capabilities, buildGraph, processVoice, exportMix, measure, cancelAll, run, FORMATS, FFMPEG };
