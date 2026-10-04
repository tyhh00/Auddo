// Network test: paste a YouTube link into the app -> MP3 lands in the Backing folder and loads as backing.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dsp = require('../src/main/dsp');

const URL = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // 19 s, "Me at the zoo"
const FMT = process.argv[3] === 'mp4' ? 'mp4' : 'mp3';
const T = path.join(os.tmpdir(), 'auddo-yt');
fs.rmSync(T, { recursive: true, force: true });

(async () => {
  const app = await electron.launch({
    args: ['.', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AUDDO_TAKES: path.join(T, 'takes') },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.__ready, null, { timeout: 30000 });
  const t0 = Date.now();
  const stages = new Set();
  const poll = setInterval(async () => { try { stages.add(await page.textContent('#ytStage')); } catch {} }, 150);
  await page.click(`#ytFmt button[data-f="${FMT}"]`);
  await page.fill('#ytUrl', URL);
  await page.press('#ytUrl', 'Enter');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(T, 'yt-progress.png') });
  await page.waitForFunction(() => window.__S.backing || document.getElementById('ytStatus').classList.contains('err'), null, { timeout: 240000 });
  clearInterval(poll);
  const r = await page.evaluate(() => ({ file: window.__S.backingFile, dur: window.__S.backing?.duration, name: document.getElementById('backingName').textContent, stage: document.getElementById('ytStage').textContent }));
  await page.screenshot({ path: path.join(T, 'yt-done.png') });
  const vid = await page.evaluate(() => ({ shown: !document.getElementById('lyricsBox').hidden, dur: document.getElementById('lyricsVideo').duration }));
  if (FMT === 'mp4') console.log(vid.shown && vid.dur > 15 ? 'PASS  lyrics video panel shows the download' : 'FAIL  video panel', vid);
  await app.close();
  console.log('stages seen:', [...stages].filter(Boolean).join(' | '));
  console.log(r, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!r.file) { console.log('FAIL', r.stage); process.exit(1); }
  const probe = await dsp.run(['-i', r.file, '-f', 'null', '-']).catch((e) => e.message);
  let ok = r.file.endsWith('.' + FMT) && r.file.includes(path.join('takes', 'Backing')) && r.dur > 15;
  if (FMT === 'mp3') ok = ok && /mp3/.test(probe);
  else {
    ok = ok && /Video: h264/.test(probe) && /Audio: aac/.test(probe);
  }
  const streams = probe.split('\n').filter((l) => /Stream/.test(l)).join('\n');
  console.log(ok ? `PASS  link -> ${FMT.toUpperCase()} -> loaded as backing` : 'FAIL', '\n' + streams);
  console.log('screens in', T);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
