// Clipping detection + repair, take management, auto-clean and wide sync range, in the real app.
// Uses a clipped take: pass a path as argv[2] (e.g. one of your own), else a synthetic one is made.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dsp = require('../src/main/dsp');
const CLIP = require('../src/shared/clip');

const T = path.join(os.tmpdir(), 'auddo-lib');
fs.rmSync(T, { recursive: true, force: true });
const TAKES = path.join(T, 'takes'), BACK = path.join(TAKES, 'Backing');
fs.mkdirSync(BACK, { recursive: true });
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const DAY = 86400000;

async function pcm(file) {
  const raw = require('child_process').execFileSync(dsp.FFMPEG, ['-hide_banner', '-v', 'error', '-i', file, '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

(async () => {
  // A clipped take: real one if given, else speech hard-clipped at 0.5 then pulled down 14 dB (like a hot knob + low Windows volume).
  const clipped = path.join(TAKES, 'take-2026-09-01-10-00-00.wav');
  if (process.argv[2]) await dsp.run(['-y', '-t', '25', '-i', process.argv[2], '-c:a', 'pcm_f32le', clipped]);
  else await dsp.run(['-y', '-i', path.join(os.tmpdir(), 'auddo-test', 'take.wav'), '-af', 'volume=12dB,asoftclip=type=hard:threshold=0.5,volume=-14dB', '-c:a', 'pcm_f32le', clipped]);
  const write = (name, meta, ageDays) => {
    const f = path.join(TAKES, name);
    if (!fs.existsSync(f)) fs.copyFileSync(path.join(os.tmpdir(), 'auddo-test', 'take.wav'), f);
    fs.writeFileSync(f.replace(/\.wav$/, '.json'), JSON.stringify({ created: Date.now() - ageDays * DAY, ...meta }));
    return f;
  };
  write('take-2026-09-01-10-00-00.wav', {}, 20); // the clipped one: old but will be open => protected
  const oldTake = write('take-2026-09-02-10-00-00.wav', {}, 10);
  const keptOld = write('take-2026-09-03-10-00-00.wav', { keep: true, backingFile: path.join(BACK, 'kept-song.mp3') }, 30);
  const fresh = write('take-2026-10-01-10-00-00.wav', {}, 1);
  for (const [n, age] of [['old-song.mp3', 12], ['kept-song.mp3', 40], ['new-song.mp3', 2]]) {
    const f = path.join(BACK, n); fs.writeFileSync(f, 'x'); const t = new Date(Date.now() - age * DAY); fs.utimesSync(f, t, t);
  }

  // Fake mic plays the clipped take so the live meter sees it (fake capture wants 16-bit PCM).
  const mic = path.join(T, 'mic.wav');
  await dsp.run(['-y', '-stream_loop', '3', '-i', clipped, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', mic]);

  const app = await electron.launch({
    args: ['.', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AUDDO_TAKES: TAKES, AUDDO_NO_TRASH: '1' },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.waitForFunction(() => window.__ready, null, { timeout: 30000 });

  // 1) take: open it first (an open take is protected from the auto-clean that runs 8 s after launch)
  const t0 = Date.now();
  await page.click(`.takes li[data-file="${clipped.replace(/\\/g, '\\\\')}"]`);

  // 2) live: meter flags clipping that sits well below 0 dBFS
  await page.waitForFunction(() => /BEFORE THE APP/.test(document.getElementById('levelHint').textContent), null, { timeout: 15000 }).catch(() => {});
  const hint = await page.textContent('#levelHint');
  check(/BEFORE THE APP/.test(hint), `live meter: "${hint.slice(0, 70)}…"`);

  await page.waitForFunction(() => window.__S.proc, null, { timeout: 180000 });
  const st = await page.evaluate(() => ({ clip: window.__S.clip, banner: !document.getElementById('clipBanner').hidden, repair: document.getElementById('repair').checked }));
  check(st.clip.clipped && st.banner && st.repair, `take flagged (ceiling ${st.clip.ceilingDb} dBFS, ${Math.round(st.clip.share * 100)}%) with repair on; render ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const cache = fs.readdirSync(path.join(dsp.TMP, 'cache')).filter((n) => n.startsWith('declip-')).map((n) => path.join(dsp.TMP, 'cache', n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const after = CLIP.analyseBuffer([await pcm(cache)]);
  check(!after.clipped, `declipped intermediate no longer reads as clipped (ratio ${after.ratio.toFixed(2)})`);
  await page.screenshot({ path: path.join(T, '1-clipped-take.png') });

  // re-render with a slider change must hit the cache (fast)
  const t1 = Date.now();
  await page.evaluate(() => { window.__S.proc = null; const el = document.querySelector('[data-k="air"]'); el.value = 4; el.dispatchEvent(new Event('input')); });
  await page.waitForFunction(() => window.__S.proc, null, { timeout: 60000 });
  check(Date.now() - t1 < 15000, `re-render uses declip cache (${((Date.now() - t1) / 1000).toFixed(1)} s)`);

  // 3) sync: wide range, number box, nudge, persisted per take
  const song = path.join(BACK, 'sync-song.mp3');
  await dsp.run(['-y', '-f', 'lavfi', '-i', 'sine=f=220:d=20', '-c:a', 'libmp3lame', '-q:a', '4', song]);
  await page.evaluate((f) => window.setBacking(f), song);
  await page.fill('#syncNum', '-850'); await page.press('#syncNum', 'Enter');
  await page.click('#syncMinus');
  await page.waitForTimeout(600);
  const shift = await page.evaluate(() => +document.getElementById('sync').value);
  check(shift === -860, `vocal shift -850 then -10 nudge = ${shift} ms`);
  await page.fill('#syncNum', '-3200'); await page.press('#syncNum', 'Enter');
  await page.waitForTimeout(600);
  const wide = await page.evaluate(() => ({ v: +document.getElementById('sync').value, min: +document.getElementById('sync').min }));
  check(wide.v === -3200 && wide.min <= -3200, `typed -3200 ms widens slider (min ${wide.min})`);
  const meta = JSON.parse(fs.readFileSync(clipped.replace(/\.wav$/, '.json'), 'utf8'));
  check(meta.vocalShiftMs === -3200, 'shift saved in take sidecar');

  // 4) star + delete (two-step) on the fresh take
  const sel = (f) => `.takes li[data-file="${f.replace(/\\/g, '\\\\')}"]`;
  await page.click(`${sel(fresh)} .star`);
  await page.waitForTimeout(400);
  check(JSON.parse(fs.readFileSync(fresh.replace(/\.wav$/, '.json'), 'utf8')).keep === true, 'star marks take as kept');
  await page.click(`${sel(fresh)} .star`);
  await page.waitForTimeout(400);
  await page.click(`${sel(fresh)} .del`);
  await page.waitForTimeout(200);
  check(fs.existsSync(fresh), 'first delete click only arms');
  await page.click(`${sel(fresh)} .del`);
  await page.waitForTimeout(600);
  check(!fs.existsSync(fresh) && !fs.existsSync(fresh.replace(/\.wav$/, '.json')), 'second click deletes take + sidecar');

  // 5) clean now (7 days)
  await page.click('#cleanNow');
  await page.waitForTimeout(1500);
  check(!fs.existsSync(oldTake), '10-day-old unstarred take cleaned');
  check(fs.existsSync(keptOld), 'starred 30-day-old take kept');
  check(fs.existsSync(clipped), 'open (old) take protected');
  check(!fs.existsSync(path.join(BACK, 'old-song.mp3')), '12-day-unused track cleaned');
  check(fs.existsSync(path.join(BACK, 'kept-song.mp3')), "starred take's track kept");
  check(fs.existsSync(path.join(BACK, 'new-song.mp3')), 'recent track kept');
  console.log('clean msg:', await page.textContent('#cleanMsg'));

  // 6) delete the open take from the stage header
  await page.click('#delCur'); await page.click('#delCur');
  await page.waitForTimeout(600);
  check(!fs.existsSync(clipped) && (await page.textContent('#srcName')).startsWith('Record a take'), 'stage "Delete take" removes the open take and clears the stage');
  await page.screenshot({ path: path.join(T, '2-after.png') });

  await app.close();
  console.log(failed ? `\n${failed} failed` : '\nall library checks passed', '\nscreens in', T);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
