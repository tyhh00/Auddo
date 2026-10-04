/* global AUDDO, CLIP, AuddoLive, api */
const $ = (id) => document.getElementById(id);
const SR = 48000;
const { PARAMS, PRESETS } = AUDDO;

const S = {
  ctx: null, stream: null, src: null, analyser: null, worklet: null, mute: null,
  recording: false, recStart: 0, recPeaks: [], firstFrame: 0, backingStartFrame: null, roomToneUntil: 0,
  inputLatency: 0,
  source: null, orig: null, proc: null, procFile: null, stats: null, noiseFloor: null,
  backingFile: null, backing: null, backingStartMs: 0, autoLatencyMs: 0,
  presetKey: 'hifi', params: { ...PRESETS.hifi.params }, custom: false,
  ab: 'B', playing: false, playStart: 0, playFrom: 0, nodes: [],
  gOrig: null, gProc: null, gBack: null, master: null, outAnalyser: null,
};

const dbfs = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const fmtDb = (v, d = 1) => (isFinite(v) ? v.toFixed(d) : '–∞');
const fmtT = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
const base = (p) => p.split(/[\\/]/).pop();

// ------------------------------------------------------------------ audio graph
function ensureCtx() {
  if (S.ctx) return S.ctx;
  const ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
  S.ctx = ctx;
  S.master = ctx.createGain();
  S.outAnalyser = ctx.createAnalyser();
  S.outAnalyser.fftSize = 8192;
  S.outAnalyser.smoothingTimeConstant = 0.8;
  S.master.connect(S.outAnalyser).connect(ctx.destination);
  S.gOrig = ctx.createGain(); S.gProc = ctx.createGain(); S.gBack = ctx.createGain();
  [S.gOrig, S.gProc, S.gBack].forEach((g) => g.connect(S.master));
  return ctx;
}

async function openInput(deviceId) {
  const ctx = ensureCtx();
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  if (S.src) S.src.disconnect();
  // Every browser "voice" feature off: we want the raw capsule signal.
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      channelCount: { ideal: 1 }, sampleRate: { ideal: SR }, sampleSize: { ideal: 24 },
    },
  });
  const set = S.stream.getAudioTracks()[0].getSettings();
  S.inputLatency = typeof set.latency === 'number' ? set.latency : 0.01;
  S.src = ctx.createMediaStreamSource(S.stream);
  if (!S.analyser) {
    S.analyser = ctx.createAnalyser();
    S.analyser.fftSize = 2048;
    await ctx.audioWorklet.addModule('recorder-worklet.js');
    S.worklet = new AudioWorkletNode(ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    S.mute = ctx.createGain(); S.mute.gain.value = 0;
    S.worklet.connect(S.mute).connect(ctx.destination);
    S.worklet.port.onmessage = onWorklet;
  }
  S.liveHist = null;
  S.src.connect(S.analyser);
  S.src.connect(S.worklet);
  return set;
}

async function listDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, pick) => {
    const prev = sel.value;
    sel.innerHTML = '';
    devs.filter((d) => d.kind === kind && d.deviceId !== 'communications').forEach((d) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || kind;
      sel.appendChild(o);
    });
    const want = [...sel.options].find((o) => o.value === prev) || [...sel.options].find((o) => pick.test(o.textContent));
    if (want) sel.value = want.value;
  };
  fill($('inDev'), 'audioinput', /maono|pd400/i);
  fill($('outDev'), 'audiooutput', /maono|pd400/i);
  const saved = pref('liveOutLabel');
  fill($('liveOut'), 'audiooutput', /^CABLE Input/i);
  if (!/CABLE Input/i.test($('liveOut').selectedOptions[0]?.textContent || '')) {
    const v = [...$('liveOut').options].find((o) => /VB-Audio|Voicemeeter|Virtual/i.test(o.textContent));
    if (v) $('liveOut').value = v.value;
  }
  if (saved) { const o = [...$('liveOut').options].find((x) => x.textContent === saved); if (o) $('liveOut').value = o.value; }
  const hasCable = [...$('liveOut').options].some((o) => /CABLE Input|VB-Audio|Voicemeeter|Virtual/i.test(o.textContent));
  $('cableHint').hidden = hasCable;
}

// ------------------------------------------------------------------ meter
let floorWin = [];
function meterLoop() {
  requestAnimationFrame(meterLoop);
  if (!S.analyser) return;
  const buf = new Float32Array(S.analyser.fftSize);
  S.analyser.getFloatTimeDomainData(buf);
  let pk = 0, sum = 0;
  for (const v of buf) { const a = Math.abs(v); if (a > pk) pk = a; sum += v * v; }
  const peak = dbfs(pk), rms = dbfs(Math.sqrt(sum / buf.length));
  meterLoop.hold = Math.max(peak, (meterLoop.hold ?? -90) - 0.35);
  if (peak > -0.5) meterLoop.clip = performance.now();
  floorWin.push(rms); if (floorWin.length > 180) floorWin.shift();
  // Clipping that happened before the app (gain knob too hot, then a digital volume pulls it down):
  // invisible to a 0 dBFS meter, obvious in the level histogram. ~5 s memory.
  if (!S.liveHist) S.liveHist = CLIP.newHist();
  for (let i = 0; i < S.liveHist.length; i++) S.liveHist[i] *= 0.997;
  if (peak > -30) CLIP.addSamples(S.liveHist, buf, 0.4);
  meterLoop.n = (meterLoop.n || 0) + 1;
  if (meterLoop.n % 15 === 0) {
    const r = CLIP.analyse(S.liveHist);
    if (r.clipped && r.share > 0.03) meterLoop.upstream = { ...r, at: performance.now() };
  }
  const up = meterLoop.upstream && performance.now() - meterLoop.upstream.at < 4000 ? meterLoop.upstream : null;
  if (up) meterLoop.clip = performance.now();
  const floor = Math.min(...floorWin);
  $('peakRead').textContent = fmtDb(peak); $('rmsRead').textContent = fmtDb(rms); $('floorRead').textContent = fmtDb(floor, 0);
  drawMeter(peak, rms, meterLoop.hold, performance.now() - (meterLoop.clip || 0) < 1500, up);
  if (S.recording) drawRecWave();
}

function drawMeter(peak, rms, hold, clip, upstream) {
  const c = $('meter'), g = c.getContext('2d');
  const w = c.width = c.clientWidth * devicePixelRatio, h = c.height = 34 * devicePixelRatio;
  const x = (db) => Math.max(0, Math.min(1, (db + 60) / 60)) * w;
  g.fillStyle = '#0f1218'; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(73,194,122,.13)'; g.fillRect(x(-18), 0, x(-6) - x(-18), h);
  g.fillStyle = 'rgba(240,180,60,.1)'; g.fillRect(x(-6), 0, x(-1) - x(-6), h);
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#2f8f5b'); grad.addColorStop(x(-18) / w, '#49c27a'); grad.addColorStop(x(-6) / w, '#f0b43c'); grad.addColorStop(1, '#ff5a5f');
  g.fillStyle = grad;
  g.fillRect(0, h * 0.18, x(peak), h * 0.32);
  g.globalAlpha = 0.55; g.fillRect(0, h * 0.55, x(rms), h * 0.27); g.globalAlpha = 1;
  g.fillStyle = '#fff'; g.fillRect(x(hold) - 1, h * 0.12, 2 * devicePixelRatio, h * 0.76);
  g.fillStyle = clip ? '#ff5a5f' : '#2a2f3c'; g.fillRect(w - 8 * devicePixelRatio, 0, 8 * devicePixelRatio, h);
  g.fillStyle = '#5b6478'; g.font = `${9 * devicePixelRatio}px Segoe UI`;
  for (const db of [-48, -36, -24, -18, -12, -6, 0]) g.fillText(db, x(db) - (db === 0 ? 14 : 6) * devicePixelRatio, h - 1);
  const hint = $('levelHint');
  if (upstream) {
    g.fillStyle = '#ff5a5f'; g.fillRect(x(upstream.ceilingDb) - 1, 0, 2 * devicePixelRatio, h);
    hint.textContent = `CLIPPING BEFORE THE APP: peaks are flattened at ${upstream.ceilingDb.toFixed(0)} dBFS. Turn the mic's gain knob down, set Windows mic volume to 100, and switch off Maono Link's limiter.`;
    hint.style.color = 'var(--red)';
  } else if (clip) { hint.textContent = 'CLIPPING: turn the gain knob down or back off the mic.'; hint.style.color = 'var(--red)'; }
  else if (hold > -6) { hint.textContent = 'Hot: fine for one-off peaks, but aim a little lower for safety.'; hint.style.color = 'var(--amber)'; }
  else if (hold > -20) { hint.textContent = 'Level is good.'; hint.style.color = 'var(--green)'; }
  else { hint.textContent = 'Sing your loudest line: peaks should land in the green zone (−18 to −6 dBFS).'; hint.style.color = ''; }
}

// ------------------------------------------------------------------ recording
function onWorklet(e) {
  const m = e.data;
  if (m.first != null) S.firstFrame = m.first;
  if (m.data) {
    api.recChunk(m.data);
    let pk = 0; for (const v of m.data) pk = Math.max(pk, Math.abs(v));
    S.recPeaks.push(pk);
  }
  if (m.done && S.onDone) S.onDone();
}

async function startRecording() {
  stopPlayback();
  const ctx = ensureCtx();
  await ctx.resume();
  S.recPeaks = []; S.backingStartFrame = null;
  await api.recBegin(SR);
  S.worklet.port.postMessage('start');
  S.recording = true; S.recStart = ctx.currentTime;
  $('recBtn').classList.add('live'); $('recLabel').textContent = 'Stop';
  const tone = $('roomTone').checked ? 2 : 0;
  S.roomToneUntil = ctx.currentTime + tone;
  if (S.backing) {
    // Track starts on the sample clock shared with the mic, so the offset is exact.
    const at = ctx.currentTime + Math.max(tone, 0.4);
    const src = ctx.createBufferSource();
    src.buffer = S.backing; src.connect(S.gBack); S.gBack.gain.value = db2g(+$('bakDb').value);
    src.start(at);
    S.recBackingNode = src;
    S.backingStartFrame = Math.round(at * ctx.sampleRate);
    S.backClock = { t0: at, pos0: 0 };
    if (S.backingVideo) { S.theaterBefore = isTheater(); setTheater(true); }
  }
  recBannerLoop();
}

function recBannerLoop() {
  if (!S.recording) { $('recBanner').hidden = true; return; }
  const ctx = S.ctx, b = $('recBanner'), left = S.roomToneUntil - ctx.currentTime;
  b.hidden = false;
  if (left > 0) { b.className = 'rec-banner'; b.textContent = `Room tone… stay silent (${left.toFixed(1)} s)`; }
  else { b.className = 'rec-banner go'; b.textContent = S.backing ? 'Recording. Sing along to the track.' : 'Recording. Go!'; }
  $('timer').textContent = fmtT(ctx.currentTime - S.recStart).padStart(7, '0');
  setTimeout(recBannerLoop, 100);
}

async function stopRecording() {
  S.recording = false;
  if (S.recBackingNode) { try { S.recBackingNode.stop(); } catch {} S.recBackingNode = null; }
  S.backClock = null;
  if (S.theaterBefore !== undefined) { setTheater(S.theaterBefore); S.theaterBefore = undefined; }
  await new Promise((res) => { S.onDone = res; S.worklet.port.postMessage('stop'); });
  S.onDone = null;
  $('recBtn').classList.remove('live'); $('recLabel').textContent = 'Record';
  const ctx = S.ctx;
  const meta = { device: $('inDev').selectedOptions[0]?.textContent, roomTone: $('roomTone').checked };
  if (S.backingStartFrame != null) {
    meta.backingFile = S.backingFile;
    meta.backingStartMs = ((S.backingStartFrame - S.firstFrame) / SR) * 1000;
    // Round trip: what you hear is late by output latency, what you sing arrives late by input latency.
    meta.latencyMs = ((ctx.outputLatency || 0) + (ctx.baseLatency || 0) + S.inputLatency) * 1000;
  }
  const r = await api.recEnd(meta);
  await refreshTakes();
  if (r) await loadSource(r.file, meta);
}

function drawRecWave() {
  const c = $('wave'), g = c.getContext('2d');
  const w = c.width = c.clientWidth * devicePixelRatio, h = c.height = c.clientHeight * devicePixelRatio;
  g.fillStyle = '#0f1218'; g.fillRect(0, 0, w, h);
  const n = Math.min(S.recPeaks.length, Math.floor(w / 3));
  const pk = S.recPeaks.slice(-n);
  g.fillStyle = '#ff5a5f';
  pk.forEach((v, i) => { const a = Math.max(1, v * h * 0.48); g.fillRect(w - (n - i) * 3, h / 2 - a, 2, a * 2); });
}

// ------------------------------------------------------------------ loading
async function decode(file) {
  const buf = await api.readFile(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return ensureCtx().decodeAudioData(ab);
}

function estimateFloor(buffer) {
  // Quietest 10% of 50 ms windows ≈ the room tone.
  const d = buffer.getChannelData(0), win = Math.round(buffer.sampleRate * 0.05), vals = [];
  for (let i = 0; i + win <= d.length; i += win) {
    let s = 0; for (let j = i; j < i + win; j++) s += d[j] * d[j];
    vals.push(dbfs(Math.sqrt(s / win)));
  }
  const finite = vals.filter(isFinite).sort((a, b) => a - b);
  return finite.length ? finite[Math.floor(finite.length * 0.1)] : -90;
}

async function loadSource(file, meta = null) {
  stopPlayback();
  S.source = file; S.proc = null; S.procFile = null; S.stats = null;
  $('srcName').textContent = base(file);
  setCurrentTake(file, meta);
  S.orig = await decode(file);
  S.noiseFloor = estimateFloor(S.orig);
  S.clip = CLIP.analyseBuffer([...Array(S.orig.numberOfChannels).keys()].map((i) => S.orig.getChannelData(i)));
  showClip(meta);
  $('sFloor').textContent = fmtDb(S.noiseFloor, 0);
  ['sOrig', 'sFinal', 'sTP', 'sLRA'].forEach((id) => ($(id).textContent = '–'));
  if (meta && meta.backingFile) {
    await setBacking(meta.backingFile).catch(() => {});
    S.backingStartMs = meta.backingStartMs || 0;
    S.autoLatencyMs = meta.latencyMs || 0;
    setVocalShift(meta.vocalShiftMs || 0, { save: false });
  } else if (S.backing) {
    S.backingStartMs = 0; S.autoLatencyMs = 0;
    setVocalShift(meta?.vocalShiftMs || 0, { save: false });
  }
  updateSync();
  $('playBtn').disabled = false; $('stopBtn').disabled = false; $('procBtn').disabled = false;
  [...document.querySelectorAll('.takes li')].forEach((li) => li.classList.toggle('on', li.dataset.file === file));
  drawWave();
  notifyOpen();
  render();
}

function showClip(meta) {
  const c = S.clip, on = !!(c && c.clipped);
  $('clipBanner').hidden = !on; $('repairWrap').hidden = !on;
  if (!on) { $('repair').checked = false; return; }
  const pct = Math.round(c.share * 100);
  $('clipBanner').innerHTML = `<b>This take clipped before it reached Auddo.</b> Loud peaks are flattened at about ${c.ceilingDb.toFixed(0)} dBFS (${pct}% of loud samples). Repair rebuilds the peaks; for the next take, turn the mic's gain knob down. See the Recording guide.`;
  $('repair').checked = meta?.repair !== false;
  $('repairInfo').textContent = `rebuilds peaks flattened at ${c.ceilingDb.toFixed(0)} dBFS (slow on the first render, then cached)`;
}

function setCurrentTake(file, meta) {
  const isTake = !!file && /[\\/]take-[^\\/]+$/.test(file);
  $('delCur').hidden = !isTake; $('starCur').hidden = !isTake;
  $('starCur').textContent = meta?.keep ? '★ Kept' : '☆ Keep';
  S.sourceMeta = meta || {};
}

function clearStage() {
  stopPlayback();
  Object.assign(S, { source: null, orig: null, proc: null, procFile: null, stats: null, clip: null, playFrom: 0 });
  $('srcName').textContent = 'Record a take or open a file';
  ['sOrig', 'sFinal', 'sTP', 'sLRA', 'sFloor'].forEach((id) => ($(id).textContent = '–'));
  ['playBtn', 'stopBtn', 'procBtn', 'exportBtn'].forEach((id) => ($(id).disabled = true));
  showClip(); setCurrentTake(null);
  drawWave(); notifyOpen();
}

function notifyOpen() { api.libOpen([S.source, S.backingFile]); }

// Two-step confirm without a modal: first click arms, second click (within 3 s) acts.
function armed(btn, label, fn) {
  if (btn.dataset.armed) { delete btn.dataset.armed; clearTimeout(btn._t); btn.textContent = btn.dataset.label; return fn(); }
  btn.dataset.armed = '1'; btn.dataset.label = btn.textContent; btn.textContent = label;
  btn._t = setTimeout(() => { delete btn.dataset.armed; btn.textContent = btn.dataset.label; }, 3000);
}

async function deleteTake(file, btn) {
  try {
    await api.deleteTake(file);
    if (file === S.source) clearStage();
    await refreshTakes(); refreshUsage();
  } catch (e) { if (btn) btn.textContent = '!'; console.warn(e); }
}

async function toggleKeep(file, keep) {
  const m = await api.keepTake(file, keep);
  if (file === S.source) setCurrentTake(file, m);
  await refreshTakes();
}

const isVideoFile = (f) => /\.(mp4|mkv|webm|mov|m4v)$/i.test(f || '');

async function setBacking(file) {
  S.backingFile = file;
  S.backing = file ? await decode(file) : null;
  S.backingVideo = isVideoFile(file);
  const v = $('lyricsVideo');
  if (S.backingVideo) {
    v.src = await api.fileUrl(file);
    $('lyricsTitle').textContent = base(file).replace(/ \[[\w-]{6,}\]\.\w+$/, '');
  } else if (v.getAttribute('src')) { v.pause(); v.removeAttribute('src'); v.load(); }
  $('lyricsBox').hidden = !S.backingVideo;
  if (!S.backingVideo) setTheater(false);
  S.vidIdleAt = null;
  $('backingName').textContent = file ? (S.backingVideo ? '🎬 ' : '') + base(file) : 'No backing track (optional, for KTV)';
  $('backingClear').hidden = !file;
  $('mixWrap').hidden = !file;
  $('syncBox').hidden = !file;
  drawWave();
  notifyOpen();
}

async function refreshTakes() {
  const list = await api.takes();
  const ul = $('takes'); ul.innerHTML = '';
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  for (const t of list) {
    const li = document.createElement('li');
    li.dataset.file = t.file;
    const d = t.name.replace(/^take-|\.\w+$/g, '').replace(/^(\d{4}-\d\d-\d\d)-(\d\d)-(\d\d)-(\d\d)-?/, '$1 $2:$3 ');
    const left = t.expires ? Math.max(0, Math.ceil((t.expires - Date.now()) / 86400000)) : null;
    const sub = [
      t.meta?.backingFile ? '♪ ' + base(t.meta.backingFile).replace(/ \[[\w-]+\]\.\w+$/, '').slice(0, 24) : t.meta?.imported ? 'imported' : '',
      `${(t.size / 1048576).toFixed(1)} MB`,
      t.meta?.keep ? 'kept' : S.lib?.autoClean && S.lib?.cleanTakes && left != null ? `cleans in ${left}d` : '',
    ].filter(Boolean).join(' · ');
    li.innerHTML = `<div class="t-main"><span class="t-name">${esc(d)}</span><span class="t-sub">${esc(sub)}</span></div>
      <div class="t-act"><button class="star ${t.meta?.keep ? 'on' : ''}" title="Keep forever">${t.meta?.keep ? '★' : '☆'}</button><button class="del" title="Delete (Recycle Bin)">🗑</button></div>`;
    li.onclick = () => loadSource(t.file, t.meta);
    li.querySelector('.star').onclick = (e) => { e.stopPropagation(); toggleKeep(t.file, !t.meta?.keep); };
    li.querySelector('.del').onclick = (e) => { e.stopPropagation(); armed(e.currentTarget, 'Delete?', () => deleteTake(t.file, e.currentTarget)); };
    if (t.file === S.source) li.classList.add('on');
    ul.appendChild(li);
  }
  if (!list.length) ul.innerHTML = '<li class="muted">No takes yet</li>';
}

// ------------------------------------------------------------------ processing
let renderTimer = null, renderSeq = 0;
function scheduleRender() {
  if (!$('auto').checked || !S.source) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 650);
}

async function render() {
  if (!S.source) return;
  const seq = ++renderSeq;
  $('err').hidden = true; $('prog').style.width = '2%';
  $('procBtn').disabled = true; $('procBtn').textContent = 'Rendering…';
  try {
    const repair = S.clip?.clipped && $('repair').checked;
    const r = await api.process({ input: S.source, params: S.params, noiseFloorDb: S.noiseFloor, declipLowEdgeDb: repair ? S.clip.lowEdgeDb : null });
    if (r.stale || seq !== renderSeq) return;
    S.procFile = r.output; S.stats = r.stats;
    const wasPlaying = S.playing, at = currentPos();
    S.proc = await decode(r.output);
    $('sOrig').textContent = fmtDb(r.stats.original.I);
    $('sFinal').textContent = fmtDb(r.stats.final.I);
    $('sTP').textContent = fmtDb(r.stats.final.TP);
    $('sLRA').textContent = fmtDb(r.stats.final.LRA);
    $('exportBtn').disabled = false;
    drawWave();
    if (wasPlaying) play(at);
  } catch (e) {
    if (seq !== renderSeq) return;
    $('err').hidden = false; $('err').textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': /, '');
  } finally {
    if (seq === renderSeq) { $('procBtn').disabled = false; $('procBtn').textContent = 'Render'; setTimeout(() => ($('prog').style.width = '0'), 600); }
  }
}

// ------------------------------------------------------------------ playback
const db2g = (db) => Math.pow(10, db / 20);
function vocalShiftMs() { return +$('sync').value || 0; }
// Where the backing starts on the vocal's timeline. Vocal earlier by x ms == backing later by x ms.
function syncDelayMs() { return S.backingStartMs + S.autoLatencyMs - vocalShiftMs(); }

function setVocalShift(ms, { save = true } = {}) {
  ms = Math.round(Math.max(-5000, Math.min(5000, +ms || 0)));
  const sl = $('sync');
  // Past the slider's range: widen it rather than clamp, so any earpiece delay can be dialled in.
  if (Math.abs(ms) > +sl.max) { sl.max = Math.abs(ms); sl.min = -Math.abs(ms); }
  sl.value = ms;
  if (document.activeElement !== $('syncNum')) $('syncNum').value = ms;
  updateSync();
  if (S.playing) play();
  if (save && S.source) {
    clearTimeout(setVocalShift.t);
    setVocalShift.t = setTimeout(() => api.takeMeta(S.source, { vocalShiftMs: ms }).catch(() => {}), 400);
  }
}
function duration() { return Math.max(S.orig?.duration || 0, S.proc?.duration || 0); }
function currentPos() { return S.playing ? S.playFrom + (S.ctx.currentTime - S.playStart) : S.playFrom; }

function applyGains() {
  if (!S.ctx) return;
  const t = S.ctx.currentTime, voc = db2g(+$('vocDb').value);
  let match = 1;
  if ($('matched').checked && S.stats?.original?.I != null && S.stats?.final?.I != null) {
    // Mono original plays on both speakers (+3 dB vs its mono measurement).
    const origI = S.stats.original.I + (S.orig?.numberOfChannels === 1 ? 3.01 : 0);
    match = db2g(S.stats.final.I - origI);
  }
  const useB = S.ab === 'B' && S.proc;
  S.gOrig.gain.setTargetAtTime(useB ? 0 : match * voc, t, 0.015);
  S.gProc.gain.setTargetAtTime(useB ? voc : 0, t, 0.015);
  S.gBack.gain.setTargetAtTime(S.backing ? db2g(+$('bakDb').value) : 0, t, 0.015);
}

function play(from = currentPos()) {
  if (!S.orig) return;
  stopPlayback(true);
  const ctx = ensureCtx(); ctx.resume();
  if (from >= duration() - 0.05) from = 0;
  const when = ctx.currentTime + 0.05;
  const start = (buf, gain, offset) => {
    if (!buf) return;
    const s = ctx.createBufferSource(); s.buffer = buf; s.connect(gain);
    if (offset >= 0) { if (offset < buf.duration) s.start(when, offset); }
    else s.start(when - offset, 0);
    S.nodes.push(s);
  };
  start(S.orig, S.gOrig, from);
  start(S.proc, S.gProc, from);
  if (S.backing) {
    start(S.backing, S.gBack, from - syncDelayMs() / 1000);
    S.backClock = { t0: when, pos0: from - syncDelayMs() / 1000 };
  }
  applyGains();
  S.playing = true; S.playStart = when; S.playFrom = from;
  $('playBtn').textContent = '❚❚';
}

function stopPlayback(keepPos = false) {
  if (S.playing && keepPos) S.playFrom = currentPos();
  S.nodes.forEach((n) => { try { n.stop(); } catch {} });
  S.nodes = [];
  S.playing = false;
  if (!S.recording) S.backClock = null;
  $('playBtn').textContent = '▶';
}

function pause() { const p = currentPos(); stopPlayback(); S.playFrom = p; }

// ------------------------------------------------------------------ drawing
function peaks(buf, w) {
  const out = new Float32Array(w * 2), chs = [...Array(buf.numberOfChannels).keys()].map((i) => buf.getChannelData(i));
  const per = buf.length / w;
  for (let x = 0; x < w; x++) {
    let mn = 0, mx = 0;
    const a = Math.floor(x * per), b = Math.min(buf.length, Math.floor((x + 1) * per));
    for (const d of chs) for (let i = a; i < b; i += 2) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    out[x * 2] = mn; out[x * 2 + 1] = mx;
  }
  return out;
}

let waveCache = null;
function drawWave() {
  const c = $('wave');
  const w = c.width = c.clientWidth * devicePixelRatio, h = c.height = c.clientHeight * devicePixelRatio;
  const g = c.getContext('2d');
  g.fillStyle = '#0f1218'; g.fillRect(0, 0, w, h);
  if (!S.orig) { waveCache = null; return; }
  const dur = duration(), lane = S.backing ? h * 0.8 : h, mid = lane / 2;
  const draw = (buf, color, alpha) => {
    const px = Math.round((buf.duration / dur) * w), p = peaks(buf, px);
    g.globalAlpha = alpha; g.fillStyle = color;
    for (let x = 0; x < px; x++) g.fillRect(x, mid - p[x * 2 + 1] * mid * 0.95, 1, Math.max(1, (p[x * 2 + 1] - p[x * 2]) * mid * 0.95));
    g.globalAlpha = 1;
  };
  if (S.proc) draw(S.proc, '#e8b45c', 0.8);
  draw(S.orig, S.proc ? '#c7cede' : '#5b6478', S.proc ? 0.35 : 0.9);
  if (S.backing) {
    const off = syncDelayMs() / 1000, x0 = (off / dur) * w, px = Math.round((S.backing.duration / dur) * w);
    const p = peaks(S.backing, Math.max(1, px)), bm = lane + (h - lane) / 2, bh = (h - lane) / 2;
    g.fillStyle = '#e46fa3'; g.globalAlpha = 0.6;
    for (let x = 0; x < px; x++) if (x0 + x >= 0 && x0 + x < w) g.fillRect(x0 + x, bm - p[x * 2 + 1] * bh, 1, Math.max(1, (p[x * 2 + 1] - p[x * 2]) * bh));
    g.globalAlpha = 1;
  }
  g.fillStyle = '#8a91a3'; g.font = `${10 * devicePixelRatio}px Segoe UI`;
  g.fillText(S.proc ? 'original ▪ processed' : 'original', 8 * devicePixelRatio, 14 * devicePixelRatio);
  waveCache = g.getImageData(0, 0, w, h);
}

// Keeps the muted lyrics video on the backing track's clock. Small drift is absorbed by nudging
// playbackRate (no visible jumps); only a real jump (> 250 ms) seeks. Output latency is subtracted so
// the picture matches what you hear; the Picture offset slider covers Bluetooth and TV lag.
function syncVideo() {
  const v = $('lyricsVideo');
  if (!S.backingVideo || !S.ctx || !v.getAttribute('src') || !(v.duration > 0)) return;
  const off = (+$('vidOff').value || 0) / 1000;
  if (S.backClock) {
    const lat = (S.ctx.outputLatency || 0) + (S.ctx.baseLatency || 0);
    const exp = S.backClock.pos0 + (S.ctx.currentTime - S.backClock.t0) - lat - off;
    S.videoExpected = exp;
    if (exp < 0 || exp >= v.duration) {
      if (!v.paused) v.pause();
      if (exp < 0 && v.currentTime > 0.05) v.currentTime = 0;
      return;
    }
    if (v.paused) { v.currentTime = exp; v.playbackRate = 1; v.play().catch(() => {}); return; }
    const err = v.currentTime - exp;
    S.videoErr = err;
    if (Math.abs(err) > 0.25) { v.currentTime = exp; v.playbackRate = 1; }
    else v.playbackRate = Math.max(0.9, Math.min(1.1, 1 - err * 0.8));
  } else {
    // Idle: show the frame under the playhead.
    if (!v.paused) v.pause();
    const target = Math.max(0, Math.min(v.duration - 0.05, (S.orig ? S.playFrom : 0) - (S.orig ? syncDelayMs() / 1000 : 0) - off));
    if (S.vidIdleAt == null || Math.abs(S.vidIdleAt - target) > 0.04) { S.vidIdleAt = target; v.currentTime = target; }
  }
}

function isTheater() { return document.querySelector('.stage').classList.contains('theater'); }
function setTheater(on) {
  document.querySelector('.stage').classList.toggle('theater', !!on);
  $('theaterBtn').classList.toggle('on', !!on);
  requestAnimationFrame(() => { if (!S.recording) drawWave(); });
}

function frameLoop() {
  requestAnimationFrame(frameLoop);
  syncVideo();
  if (S.recording) return;
  const c = $('wave'), g = c.getContext('2d');
  if (waveCache) {
    g.putImageData(waveCache, 0, 0);
    const pos = currentPos(), x = (pos / duration()) * c.width;
    g.fillStyle = '#fff'; g.fillRect(x, 0, 1.5 * devicePixelRatio, c.height);
    $('pos').textContent = fmtT(pos); $('dur').textContent = fmtT(duration());
    if (S.playing && pos >= duration()) { stopPlayback(); S.playFrom = 0; }
  }
  drawSpectrum();
}

function drawSpectrum() {
  const c = $('spec'), g = c.getContext('2d');
  const w = c.width = c.clientWidth * devicePixelRatio, h = c.height = 120 * devicePixelRatio;
  g.fillStyle = '#0f1218'; g.fillRect(0, 0, w, h);
  const fx = (hz) => (Math.log10(hz / 20) / Math.log10(20000 / 20)) * w;
  g.fillStyle = '#262b38'; g.font = `${9 * devicePixelRatio}px Segoe UI`;
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 16000]) { g.fillRect(fx(hz), 0, 1, h); g.fillStyle = '#5b6478'; g.fillText(hz >= 1000 ? hz / 1000 + 'k' : hz, fx(hz) + 3, h - 3); g.fillStyle = '#262b38'; }
  if (!S.outAnalyser || !S.playing) return;
  const a = S.outAnalyser, d = new Float32Array(a.frequencyBinCount);
  a.getFloatFrequencyData(d);
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, S.ab === 'B' ? '#e8b45c' : '#8a91a3'); grad.addColorStop(1, S.ab === 'B' ? '#e46fa3' : '#5b6478');
  g.beginPath(); g.moveTo(0, h);
  for (let x = 0; x < w; x += 2) {
    const hz = 20 * Math.pow(1000, x / w), i = Math.min(d.length - 1, Math.round((hz / (SR / 2)) * d.length));
    const y = h - Math.max(0, Math.min(1, (d[i] + 100) / 80)) * h;
    g.lineTo(x, y);
  }
  g.lineTo(w, h); g.closePath(); g.fillStyle = grad; g.globalAlpha = 0.55; g.fill(); g.globalAlpha = 1;
}

// ------------------------------------------------------------------ presets + sliders
function buildPresetUI() {
  const box = $('presets');
  for (const [k, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.className = 'preset'; b.dataset.k = k;
    b.innerHTML = `<b>${p.name}</b><span>${p.blurb}</span>`;
    b.onclick = () => selectPreset(k);
    box.appendChild(b);
  }
  const groups = {};
  for (const p of PARAMS) (groups[p.g] = groups[p.g] || []).push(p);
  const host = $('sliders');
  for (const [g, list] of Object.entries(groups)) {
    const det = document.createElement('details');
    if (g === 'Space' || g === 'Clean-up') det.open = true;
    det.innerHTML = `<summary>${g}</summary>`;
    for (const p of list) {
      const row = document.createElement('div'); row.className = 'sl';
      if (p.unit === 'bool') {
        row.innerHTML = `<label class="check" style="margin:0"><input type="checkbox" data-k="${p.k}"> ${p.label}</label>`;
        row.querySelector('input').onchange = (e) => setParam(p.k, e.target.checked ? 1 : 0);
      } else {
        row.innerHTML = `<label>${p.label}</label><output></output><input type="range" min="${p.min}" max="${p.max}" step="${p.step}" data-k="${p.k}">`;
        row.querySelector('input').oninput = (e) => setParam(p.k, +e.target.value);
      }
      det.appendChild(row);
    }
    host.appendChild(det);
  }
}

function fmtParam(p, v) {
  if (p.k === 'reverb' && v === 0) return 'off';
  if (p.k === 'echo' && v === 0) return 'off';
  const s = p.step < 1 ? (+v).toFixed(1) : String(Math.round(v));
  return `${p.unit === 'dB' && v > 0 ? '+' : ''}${s} ${p.unit}`;
}

function syncSliders() {
  for (const p of PARAMS) {
    const el = document.querySelector(`[data-k="${p.k}"]`);
    if (p.unit === 'bool') el.checked = !!S.params[p.k];
    else { el.value = S.params[p.k]; el.parentElement.querySelector('output').textContent = fmtParam(p, S.params[p.k]); }
  }
  document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('on', b.dataset.k === S.presetKey));
  $('customNote').hidden = !S.custom;
  $('customBase').textContent = PRESETS[S.presetKey].name;
}

function selectPreset(k) {
  S.presetKey = k; S.params = { ...PRESETS[k].params }; S.custom = false;
  syncSliders();
  if (S.live.on) S.live.chain.setParams(S.params);
  if (S.source) { clearTimeout(renderTimer); render(); }
}

function setParam(k, v) {
  S.params[k] = v; S.custom = true;
  syncSliders();
  if (S.live.on) S.live.chain.setParams(S.params);
  scheduleRender();
}

// ------------------------------------------------------------------ sync controls
function updateSync() {
  if (document.activeElement !== $('syncNum')) $('syncNum').value = vocalShiftMs();
  $('syncTotal').textContent = S.backing ? `Track starts at ${(syncDelayMs() / 1000).toFixed(3)} s on the vocal timeline (measured latency ${Math.round(S.autoLatencyMs)} ms).` : '';
  $('vocOut').textContent = `${+$('vocDb').value > 0 ? '+' : ''}${$('vocDb').value} dB`;
  $('bakOut').textContent = `${$('bakDb').value} dB`;
  drawWave();
}

// ------------------------------------------------------------------ wiring
async function init() {
  buildPresetUI();
  syncSliders();
  meterLoop(); frameLoop();

  const info = await api.info();
  $('engine').textContent = `ffmpeg ${(info.version.match(/version (\S+)/) || [])[1] || '?'} · ${info.model ? 'RNNoise voice model' : 'no RNN model'} · 48 kHz float pipeline`;

  try {
    await openInput();
    await listDevices();
    const sel = $('inDev').value;
    if (sel) await openInput(sel);
  } catch (e) {
    $('levelHint').textContent = 'Microphone unavailable: ' + e.message;
  }
  navigator.mediaDevices.ondevicechange = listDevices;
  $('inDev').onchange = () => { openInput($('inDev').value); restartLive(); };
  $('outDev').onchange = async () => { try { await ensureCtx().setSinkId($('outDev').value); } catch (e) { console.warn(e); } };
  if ($('outDev').value) ensureCtx().setSinkId?.($('outDev').value).catch(() => {});

  $('recBtn').onclick = () => (S.recording ? stopRecording() : startRecording());
  $('importBtn').onclick = async () => {
    const f = await api.openFile('vocal');
    if (!f) return;
    const copy = await api.importTake(f);
    await refreshTakes(); refreshUsage();
    loadSource(copy, (await api.takes()).find((t) => t.file === copy)?.meta);
  };
  $('delCur').onclick = (e) => armed(e.currentTarget, 'Click again to delete', () => deleteTake(S.source, e.currentTarget));
  $('starCur').onclick = () => toggleKeep(S.source, !S.sourceMeta?.keep);
  $('repair').onchange = () => {
    if (S.source) api.takeMeta(S.source, { repair: $('repair').checked }).catch(() => {});
    clearTimeout(renderTimer); render();
  };

  // Storage / auto-clean
  S.lib = await api.libSettings();
  const libUI = () => {
    $('autoClean').checked = S.lib.autoClean; $('cleanDays').value = String(S.lib.days);
    $('cleanTakes').checked = S.lib.cleanTakes; $('cleanBacking').checked = S.lib.cleanBacking;
    ['cleanDays', 'cleanTakes', 'cleanBacking'].forEach((id) => ($(id).disabled = !S.lib.autoClean));
  };
  const saveLib = async (patch) => { S.lib = await api.libSettings(patch); libUI(); refreshTakes(); };
  libUI();
  $('autoClean').onchange = (e) => saveLib({ autoClean: e.target.checked });
  $('cleanDays').onchange = (e) => saveLib({ days: +e.target.value });
  $('cleanTakes').onchange = (e) => saveLib({ cleanTakes: e.target.checked });
  $('cleanBacking').onchange = (e) => saveLib({ cleanBacking: e.target.checked });
  const reportClean = (r) => {
    const parts = [r.takes && `${r.takes} take(s)`, r.backing && `${r.backing} track(s)`, r.cache && `${r.cache} cache item(s)`].filter(Boolean);
    $('cleanMsg').textContent = parts.length ? `Cleaned ${parts.join(', ')} (${(r.bytes / 1048576).toFixed(0)} MB).` : 'Nothing older than the limit.';
    refreshTakes(); refreshUsage();
  };
  $('cleanNow').onclick = async () => reportClean(await api.libClean());
  api.onCleaned(reportClean);
  refreshUsage();
  $('revealBtn').onclick = () => api.reveal();
  $('backingBtn').onclick = async () => {
    const f = await api.openFile('backing');
    if (!f) return;
    await setBacking(f);
    if (!S.recording) { S.backingStartMs = 0; S.autoLatencyMs = 0; updateSync(); }
  };
  $('backingClear').onclick = () => setBacking(null);

  // Paste a link -> MP3 in Music\Auddo\Backing -> loaded as the backing track.
  const ytGo = async () => {
    const url = $('ytUrl').value.trim();
    if (!url || S.ytBusy) return;
    S.ytBusy = true;
    $('ytBtn').disabled = true; $('ytCancel').hidden = false;
    $('ytStatus').hidden = false; $('ytStatus').classList.remove('err');
    $('ytStage').textContent = 'Starting…'; $('ytProg').style.width = '0';
    try {
      const r = await api.ytFetch(url, S.ytFmt);
      $('ytStage').textContent = `Loaded “${r.title}”`;
      $('ytUrl').value = '';
      await setBacking(r.file);
      if (!S.recording) { S.backingStartMs = 0; S.autoLatencyMs = 0; updateSync(); }
      setTimeout(() => { if (!S.ytBusy) $('ytStatus').hidden = true; }, 4000);
    } catch (e) {
      $('ytStatus').classList.add('err');
      const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      $('ytStage').textContent = msg === 'cancelled' ? 'Cancelled' : msg;
    } finally {
      S.ytBusy = false; $('ytBtn').disabled = false; $('ytCancel').hidden = true;
    }
  };
  $('ytBtn').onclick = ytGo;
  const setYtFmt = (f) => {
    S.ytFmt = f === 'mp4' ? 'mp4' : 'mp3';
    pref('ytFormat', S.ytFmt);
    document.querySelectorAll('#ytFmt button').forEach((b) => { b.classList.toggle('on', b.dataset.f === S.ytFmt); b.setAttribute('aria-checked', b.dataset.f === S.ytFmt); });
    $('ytFmtHint').textContent = S.ytFmt === 'mp4' ? 'video, shows on-screen lyrics' : 'audio only';
  };
  document.querySelectorAll('#ytFmt button').forEach((b) => (b.onclick = () => setYtFmt(b.dataset.f)));
  setYtFmt(pref('ytFormat') || 'mp3');

  // Lyrics video controls
  const setVidOff = (ms) => { $('vidOff').value = ms; $('vidOffOut').textContent = `${ms > 0 ? '+' : ''}${ms} ms`; pref('videoOffsetMs', +ms); S.vidIdleAt = null; };
  setVidOff(pref('videoOffsetMs') || 0);
  $('vidOff').oninput = () => setVidOff(+$('vidOff').value);
  $('vidOff').ondblclick = () => setVidOff(0);
  $('theaterBtn').onclick = () => setTheater(!isTheater());
  $('ytUrl').onkeydown = (e) => { if (e.key === 'Enter') ytGo(); };
  $('ytUrl').onpaste = () => setTimeout(() => { if (/^https?:\/\//.test($('ytUrl').value.trim())) ytGo(); }, 0);
  $('ytCancel').onclick = () => api.ytCancel();
  api.onYtProgress(({ stage, p }) => { $('ytStage').textContent = stage; $('ytProg').style.width = `${Math.round(p * 100)}%`; });

  $('playBtn').onclick = () => (S.playing ? pause() : play());
  $('stopBtn').onclick = () => { stopPlayback(); S.playFrom = 0; };
  $('wave').onclick = (e) => {
    if (!S.orig) return;
    const r = e.target.getBoundingClientRect(), t = ((e.clientX - r.left) / r.width) * duration();
    if (S.playing) play(t); else S.playFrom = t;
  };
  document.querySelectorAll('#ab button').forEach((b) => (b.onclick = () => setAB(b.dataset.ab)));
  $('matched').onchange = applyGains;
  $('procBtn').onclick = render;
  $('revert').onclick = () => selectPreset(S.presetKey);

  $('sync').oninput = () => setVocalShift($('sync').value);
  $('syncNum').onchange = () => setVocalShift($('syncNum').value);
  $('syncNum').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); setVocalShift($('syncNum').value); e.target.blur(); } };
  $('syncMinus').onclick = (e) => setVocalShift(vocalShiftMs() - (e.shiftKey ? 1 : 10));
  $('syncPlus').onclick = (e) => setVocalShift(vocalShiftMs() + (e.shiftKey ? 1 : 10));
  $('syncReset').onclick = () => setVocalShift(0);
  $('vocDb').oninput = () => { updateSync(); applyGains(); };
  $('bakDb').oninput = () => { updateSync(); applyGains(); };

  $('exportBtn').onclick = async () => {
    $('exportMsg').textContent = 'Exporting…';
    try {
      const withBacking = S.backing && $('mixBacking').checked;
      const out = await api.exportMix({
        processed: S.procFile, source: S.source, format: $('fmt').value, presetKey: S.presetKey,
        backing: withBacking ? S.backingFile : null, backingDelayMs: syncDelayMs(),
        vocalDb: +$('vocDb').value, backingDb: +$('bakDb').value, loudness: S.params.loudness,
      });
      $('exportMsg').textContent = out ? `Saved ${base(out)}` : '';
    } catch (e) { $('exportMsg').textContent = 'Export failed: ' + e.message; }
  };

  $('liveEngine').value = pref('liveEngine') || 'gtcrn';
  $('liveMonitor').checked = !!pref('liveMonitor');
  $('liveBtn').onclick = () => (S.live.on ? stopLive() : goLive());
  $('liveEngine').onchange = () => { pref('liveEngine', $('liveEngine').value); restartLive(); };
  $('liveMonitor').onchange = () => { pref('liveMonitor', $('liveMonitor').checked); setMonitor(); };
  $('liveOut').onchange = async () => {
    pref('liveOutLabel', $('liveOut').selectedOptions[0]?.textContent || null);
    if (S.live.on) { try { await S.live.ctx.setSinkId($('liveOut').value); } catch (e) { console.warn(e); } setMonitor(); goLiveBadge(); }
  };
  const goLiveBadge = () => ($('liveBadgeInfo').textContent = `→ ${$('liveOut').selectedOptions[0]?.textContent.replace(/\s*\(.*\)$/, '') || 'output'}`);
  $('cableGet').onclick = () => api.openExternal('https://vb-audio.com/Cable/');
  drawLiveMeter(null);

  $('guideBtn').onclick = () => $('guide').showModal();
  $('guideClose').onclick = () => $('guide').close();

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    if (e.code === 'Space') { e.preventDefault(); if (S.orig) (S.playing ? pause() : play()); }
    if (e.key === 'a' || e.key === 'A') setAB('A');
    if (e.key === 'b' || e.key === 'B') setAB('B');
  });
  window.addEventListener('resize', drawWave);
  api.onProgress((p) => ($('prog').style.width = `${Math.round(p * 100)}%`));
  await refreshTakes();
  window.__ready = true;
}

async function refreshUsage() {
  const u = await api.libUsage();
  const mb = (b) => (b / 1048576).toFixed(0);
  $('usage').textContent = `Takes ${mb(u.takes)} MB · tracks ${mb(u.backing)} MB · cache ${mb(u.cache)} MB`;
}

// ------------------------------------------------------------------ live (real-time) chain
const LS = (() => { try { return window.localStorage; } catch { return null; } })();
function pref(k, v) {
  try {
    if (v === undefined) return LS ? JSON.parse(LS.getItem('auddo.' + k)) : null;
    LS && LS.setItem('auddo.' + k, JSON.stringify(v));
  } catch { return null; }
}

S.live = { on: false, meters: [] };
window.__live = S.live; // test hook

async function goLive() {
  const L = S.live;
  if (L.on || L.starting) return;
  L.starting = true;
  $('liveBtn').disabled = true; $('liveBtn').textContent = 'Starting…';
  try {
    const ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
    const sink = $('liveOut').value;
    if (sink && sink !== 'default') await ctx.setSinkId(sink);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: $('inDev').value ? { exact: $('inDev').value } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 1 }, sampleRate: { ideal: SR }, sampleSize: { ideal: 24 },
      },
    });
    const src = ctx.createMediaStreamSource(stream);
    const engine = $('liveEngine').value;
    const chain = await AuddoLive.build(ctx, src, S.params, engine);
    chain.output.connect(ctx.destination);
    chain.meter.onmessage = (e) => onLiveMeter(e.data);
    await ctx.resume();
    const inLat = stream.getAudioTracks()[0].getSettings().latency || 0.01;
    Object.assign(L, {
      on: true, ctx, stream, src, chain, engine, meters: [],
      latencyMs: (chain.latencySamples / SR + (ctx.baseLatency || 0) + (ctx.outputLatency || 0) + inLat) * 1000,
    });
    await setMonitor();
    $('liveBox').classList.add('on'); $('liveBadge').hidden = false;
    $('liveBtn').textContent = 'Stop live';
    $('liveBadgeInfo').textContent = `→ ${$('liveOut').selectedOptions[0]?.textContent.replace(/\s*\(.*\)$/, '') || 'output'}`;
  } catch (e) {
    $('liveStats').textContent = 'Could not go live: ' + e.message;
    $('liveBtn').textContent = 'Go live';
    stopLive();
  } finally {
    L.starting = false; $('liveBtn').disabled = false;
  }
}

async function setMonitor() {
  const L = S.live;
  if (L.monitorEl) { L.monitorEl.pause(); L.monitorEl.srcObject = null; L.monitorEl = null; }
  if (L.monitorDest) { try { L.chain.output.disconnect(L.monitorDest); } catch {} L.monitorDest = null; }
  if (!L.on || !$('liveMonitor').checked) return;
  // Same device as the live output would just double the signal.
  if ($('outDev').value === $('liveOut').value) return;
  L.monitorDest = L.ctx.createMediaStreamDestination();
  L.chain.output.connect(L.monitorDest);
  const el = new Audio();
  el.srcObject = L.monitorDest.stream;
  try { if ($('outDev').value) await el.setSinkId($('outDev').value); } catch {}
  await el.play().catch(() => {});
  L.monitorEl = el;
}

function stopLive() {
  const L = S.live;
  try { L.chain && L.chain.dispose(); } catch {}
  try { L.stream && L.stream.getTracks().forEach((t) => t.stop()); } catch {}
  if (L.monitorEl) { L.monitorEl.pause(); L.monitorEl.srcObject = null; }
  try { L.ctx && L.ctx.close(); } catch {}
  Object.assign(L, { on: false, ctx: null, stream: null, src: null, chain: null, monitorEl: null, monitorDest: null });
  $('liveBox').classList.remove('on'); $('liveBadge').hidden = true;
  $('liveBtn').textContent = 'Go live';
  drawLiveMeter(null);
}

async function restartLive() { if (S.live.on) { stopLive(); await goLive(); } }

function onLiveMeter(m) {
  const L = S.live;
  L.meters.push(m); if (L.meters.length > 400) L.meters.shift();
  drawLiveMeter(m);
  const now = performance.now();
  if (!L.statT || now - L.statT > 250) {
    L.statT = now;
    $('liveStats').textContent = `≈${Math.round(L.latencyMs)} ms delay · leveler ${m.leveler >= 0 ? '+' : ''}${m.leveler.toFixed(1)} dB · limiter ${m.limiter < -0.1 ? m.limiter.toFixed(1) + ' dB' : 'idle'}`;
  }
}

function drawLiveMeter(m) {
  const c = $('liveMeter'), g = c.getContext('2d');
  const w = c.width = c.clientWidth * devicePixelRatio, h = c.height = 26 * devicePixelRatio;
  const x = (db) => Math.max(0, Math.min(1, (db + 60) / 60)) * w;
  g.fillStyle = '#0f1218'; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(228,111,163,.12)'; g.fillRect(x(-24), 0, x(-9) - x(-24), h);
  if (!m) return;
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#7d3a63'); grad.addColorStop(0.7, '#e46fa3'); grad.addColorStop(1, '#ffd0e4');
  g.fillStyle = grad;
  g.fillRect(0, h * 0.2, x(m.peak), h * 0.3);
  g.globalAlpha = 0.6; g.fillRect(0, h * 0.55, x(m.rms), h * 0.25); g.globalAlpha = 1;
  g.fillStyle = '#fff'; g.fillRect(x(-1), 0, 1.5 * devicePixelRatio, h);
}

function setAB(v) {
  S.ab = v;
  document.querySelectorAll('#ab button').forEach((b) => b.classList.toggle('on', b.dataset.ab === v));
  applyGains();
}

window.__S = S; // test hook
init();
