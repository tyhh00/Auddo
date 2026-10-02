// Drives the real Electron app with a fake mic (the synthetic take from dsp.test.js) and a
// synthetic backing track: record -> auto-render each preset -> A/B -> export with backing.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dsp = require('../src/main/dsp');

const T = path.join(os.tmpdir(), 'auddo-e2e');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const shot = (p, n) => p.screenshot({ path: path.join(T, n) });
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };

(async () => {
  const take = path.join(os.tmpdir(), 'auddo-test', 'take.wav');
  if (!fs.existsSync(take)) throw new Error('run npm test first (creates the synthetic take)');
  const mic = path.join(T, 'mic.wav'), backing = path.join(T, 'backing.mp3');
  await dsp.run(['-y', '-i', take, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', mic]);
  // Simple chord pad + kick as a stand-in instrumental.
  await dsp.run(['-y', '-f', 'lavfi', '-i', "aevalsrc='0.08*sin(2*PI*220*t)+0.06*sin(2*PI*277.2*t)+0.06*sin(2*PI*329.6*t)+0.3*sin(2*PI*55*t)*exp(-12*mod(t,0.5))':s=48000:d=10", '-c:a', 'libmp3lame', '-b:a', '256k', backing]);

  const app = await electron.launch({
    args: ['.', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${mic}%noloop`, '--autoplay-policy=no-user-gesture-required'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AUDDO_TAKES: path.join(T, 'takes'), AUDDO_NO_TRASH: '1' },
  });
  const page = await app.firstWindow();
  page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.waitForFunction(() => window.__ready, null, { timeout: 30000 });
  await page.setViewportSize?.({ width: 1440, height: 900 });
  check(true, 'app booted: ' + (await page.textContent('#engine')));

  // Load backing via the renderer hook (native dialogs can't be driven).
  await page.evaluate((f) => window.__setBacking ? window.__setBacking(f) : null, backing);
  await page.evaluate(async (f) => {
    const S = window.__S;
    const buf = await window.api.readFile(f);
    S.backingFile = f;
    S.backing = await S.ctx.decodeAudioData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    document.getElementById('backingName').textContent = f.split(/[\\/]/).pop();
    ['mixWrap', 'syncBox', 'backingClear'].forEach((id) => (document.getElementById(id).hidden = false));
  }, backing);

  await page.click('#recBtn');
  await page.waitForTimeout(1200);
  await shot(page, '1-recording.png');
  await page.waitForTimeout(7000);
  await page.click('#recBtn');
  await page.waitForFunction(() => window.__S.proc, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => ({ stats: window.__S.stats, src: window.__S.source, bs: window.__S.backingStartMs, lat: window.__S.autoLatencyMs, floor: window.__S.noiseFloor, dur: window.__S.orig.duration }));
  console.log('take:', st.src, 'dur', st.dur.toFixed(2), 'floor', st.floor.toFixed(1), 'backingStart', st.bs.toFixed(1), 'ms latency', st.lat.toFixed(1), 'ms');
  check(st.dur > 7, 'take length plausible');
  check(Math.abs(st.bs - 2000) < 30, `backing scheduled after room tone (${st.bs.toFixed(1)} ms)`);
  check(Math.abs(st.stats.final.I - -16) < 1, `Hi-Fi render at ${st.stats.final.I} LUFS`);
  const takeMeta = JSON.parse(fs.readFileSync(st.src.replace(/\.wav$/, '.json'), 'utf8'));
  check(takeMeta.backingFile === backing, 'take sidecar remembers backing track');

  await page.click('#playBtn');
  await page.waitForTimeout(2600);
  await shot(page, '2-hifi-playing.png');
  await page.keyboard.press('a');
  await page.waitForTimeout(400);
  await page.keyboard.press('b');
  await page.click('#playBtn');

  await page.click('.preset[data-k="ktv"]');
  await page.waitForFunction(() => Math.abs(window.__S.stats?.final?.I - -14) < 1, null, { timeout: 60000 });
  check(true, 'KTV preset re-rendered at -14 LUFS');
  // Vocal 40 ms earlier => backing starts 40 ms later on the vocal timeline.
  const before = await page.evaluate(() => window.syncDelayMs());
  await page.evaluate(() => { const s = document.getElementById('sync'); s.value = -40; s.dispatchEvent(new Event('input')); });
  check(Math.abs((await page.evaluate(() => window.syncDelayMs())) - before - 40) < 0.01, 'vocal earlier => backing delay grows by the same amount');
  await shot(page, '3-ktv.png');

  // Export via main-process function directly (save dialog can't be automated).
  const S = await page.evaluate(() => ({ p: window.__S.procFile, d: window.syncDelayMs(), b: window.__S.backingFile }));
  for (const fmt of ['wav24', 'flac24', 'mp3']) {
    const dest = path.join(T, `export.${dsp.FORMATS[fmt].ext}`);
    await dsp.exportMix({ processed: S.p, dest, format: fmt, backing: S.b, backingDelayMs: S.d, vocalDb: 0, backingDb: -6, loudness: -14 });
    const m = await dsp.measure(dest);
    check(fs.statSync(dest).size > 10000 && Math.abs(m.I - -14) < 1.2 && m.TP < -0.5, `export ${fmt}: I=${m.I} TP=${m.TP}`);
  }

  await page.click('#guideBtn');
  await page.waitForTimeout(300);
  await shot(page, '4-guide.png');
  await app.close();
  console.log(failed ? `\n${failed} failed` : '\nall e2e checks passed', '\nscreenshots in', T);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
