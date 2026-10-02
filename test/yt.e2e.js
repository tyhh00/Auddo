// Network test: paste a YouTube link into the app -> MP3 lands in the Backing folder and loads as backing.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dsp = require('../src/main/dsp');

const URL = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // 19 s, "Me at the zoo"
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
  await page.fill('#ytUrl', URL);
  await page.press('#ytUrl', 'Enter');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(T, 'yt-progress.png') });
  await page.waitForFunction(() => window.__S.backing || document.getElementById('ytStatus').classList.contains('err'), null, { timeout: 240000 });
  clearInterval(poll);
  const r = await page.evaluate(() => ({ file: window.__S.backingFile, dur: window.__S.backing?.duration, name: document.getElementById('backingName').textContent, stage: document.getElementById('ytStage').textContent }));
  await page.screenshot({ path: path.join(T, 'yt-done.png') });
  await app.close();
  console.log('stages seen:', [...stages].filter(Boolean).join(' | '));
  console.log(r, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!r.file) { console.log('FAIL', r.stage); process.exit(1); }
  const probe = await dsp.run(['-i', r.file, '-f', 'null', '-']).catch((e) => e.message);
  const ok = r.file.endsWith('.mp3') && r.file.includes(path.join('takes', 'Backing')) && r.dur > 15 && /mp3/.test(probe);
  console.log(ok ? 'PASS  link -> MP3 -> loaded as backing' : 'FAIL'); console.log('screens in', T);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
