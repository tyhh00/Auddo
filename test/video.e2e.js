// Karaoke-video backing: a synthetic MP4 (original placeholder text + running timecode, no real lyrics)
// is loaded as the backing track; checks the picture tracks the audio clock in preview and while
// recording, Focus mode, picture offset, idle-frame seeking, and exporting a mix with an MP4 backing.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dsp = require('../src/main/dsp');

const T = path.join(os.tmpdir(), 'auddo-video');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };

async function makeVideo(file, seconds = 12) {
  const font = "fontfile='C\\:/Windows/Fonts/segoeui.ttf'";
  const lines = ['Auddo demo video', 'placeholder line one', 'placeholder line two', 'placeholder line three'];
  const text = lines.map((l, i) => `drawtext=${font}:text='${l}':fontcolor=white:fontsize=46:x=(w-tw)/2:y=h*0.62:enable='between(t,${i * 3},${i * 3 + 3})'`).join(',');
  await dsp.run(['-y',
    '-f', 'lavfi', '-i', `color=c=0x1b1030:s=1280x720:r=30:d=${seconds}`,
    '-f', 'lavfi', '-i', `aevalsrc='0.06*sin(2*PI*220*t)+0.05*sin(2*PI*277.2*t)+0.05*sin(2*PI*329.6*t)+0.3*sin(2*PI*55*t)*exp(-12*mod(t,0.5))':s=48000:d=${seconds}`,
    '-vf', `${text},drawtext=${font}:text='%{pts\\:hms}':fontcolor=0xe46fa3:fontsize=34:x=40:y=40`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '160k', '-shortest', file]);
}

(async () => {
  const take = path.join(os.tmpdir(), 'auddo-test', 'take.wav');
  if (!fs.existsSync(take)) throw new Error('run npm test first');
  const video = path.join(T, 'Demo karaoke [abcdefghijk].mp4');
  await makeVideo(video);
  const mic = path.join(T, 'mic.wav');
  await dsp.run(['-y', '-i', take, '-c:a', 'pcm_s16le', mic]);

  const app = await electron.launch({
    args: ['.', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`, '--autoplay-policy=no-user-gesture-required'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AUDDO_TAKES: path.join(T, 'takes'), AUDDO_NO_TRASH: '1' },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()));
  await page.waitForFunction(() => window.__ready, null, { timeout: 30000 });

  // ---- load the MP4 as backing
  await page.evaluate((f) => window.setBacking(f), video);
  await page.waitForFunction(() => document.getElementById('lyricsVideo').duration > 0, null, { timeout: 15000 });
  const st = await page.evaluate(() => ({ box: !document.getElementById('lyricsBox').hidden, vdur: document.getElementById('lyricsVideo').duration, adur: window.__S.backing.duration, title: document.getElementById('lyricsTitle').textContent, name: document.getElementById('backingName').textContent }));
  check(st.box && Math.abs(st.vdur - 12) < 0.2 && Math.abs(st.adur - 12) < 0.2, `MP4 loads as backing: video ${st.vdur.toFixed(2)} s, audio ${st.adur.toFixed(2)} s`);
  check(st.title === 'Demo karaoke' && st.name.startsWith('🎬'), `title "${st.title}", backing label "${st.name}"`);

  // ---- record against the video: Focus on, picture follows the track clock
  await page.click('#recBtn');
  await page.waitForTimeout(4500); // 2 s room tone, then ~2.5 s of track
  const rec = await page.evaluate(() => {
    const v = document.getElementById('lyricsVideo');
    return { theater: document.querySelector('.stage').classList.contains('theater'), paused: v.paused, t: v.currentTime, exp: window.__S.videoExpected, err: window.__S.videoErr };
  });
  check(rec.theater, 'Focus mode turns on while recording against a video');
  check(!rec.paused && rec.t > 1.5, `video is playing during the take (at ${rec.t.toFixed(2)} s)`);
  check(Math.abs(rec.t - rec.exp) < 0.12, `picture within 120 ms of the track while recording (${((rec.t - rec.exp) * 1000).toFixed(0)} ms)`);
  await page.screenshot({ path: path.join(T, '1-recording-focus.png') });
  await page.waitForTimeout(5000); // ~9.5 s take, long enough for the preview checks below
  await page.click('#recBtn');
  await page.waitForFunction(() => window.__S.proc, null, { timeout: 120000 });
  const after = await page.evaluate(() => ({ theater: document.querySelector('.stage').classList.contains('theater'), paused: document.getElementById('lyricsVideo').paused, src: window.__S.source }));
  check(!after.theater && after.paused, 'Focus restored and video stopped after the take');
  const meta = JSON.parse(fs.readFileSync(after.src.replace(/\.wav$/, '.json'), 'utf8'));
  check(meta.backingFile === video, 'take remembers the MP4 backing');

  // ---- preview playback: drift stays small over several seconds
  await page.evaluate(() => { window.__S.playFrom = 2.5; });
  await page.click('#playBtn');
  const errs = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(350);
    errs.push(await page.evaluate(() => { const v = document.getElementById('lyricsVideo'); return v.paused ? null : v.currentTime - window.__S.videoExpected; }));
  }
  const live = errs.filter((e) => e != null).map((e) => Math.abs(e));
  check(live.length >= 10 && Math.max(...live.slice(2)) < 0.1, `preview: picture tracks audio (worst ${(Math.max(...live.slice(2)) * 1000).toFixed(0)} ms over ${live.length} samples)`);
  await page.screenshot({ path: path.join(T, '2-preview.png') });

  // ---- picture offset shifts the expected position
  const e0 = await page.evaluate(() => window.__S.videoExpected);
  await page.evaluate(() => { const s = document.getElementById('vidOff'); s.value = 500; s.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(120);
  const e1 = await page.evaluate(() => window.__S.videoExpected);
  check(Math.abs((e0 + 0.12) - e1 - 0.5) < 0.08, `+500 ms picture offset delays the picture (Δ ${((e0 + 0.12 - e1) * 1000).toFixed(0)} ms)`);
  await page.evaluate(() => { const s = document.getElementById('vidOff'); s.value = 0; s.dispatchEvent(new Event('input')); });
  await page.evaluate(() => window.__S.playing && window.pause());
  check(await page.evaluate(() => !window.__S.playing), 'paused for the idle test');

  // ---- idle: clicking the waveform shows the frame under the playhead
  const box = await page.locator('#wave').boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await page.waitForTimeout(500);
  const idle = await page.evaluate(() => ({ t: document.getElementById('lyricsVideo').currentTime, want: window.__S.playFrom - window.syncDelayMs() / 1000 }));
  check(Math.abs(idle.t - Math.max(0, idle.want)) < 0.1, `idle seek shows the matching frame (${idle.t.toFixed(2)} s vs ${idle.want.toFixed(2)} s)`);

  // ---- Focus toggle by hand
  await page.click('#theaterBtn');
  const th = await page.evaluate(() => document.querySelector('.stage').classList.contains('theater'));
  await page.screenshot({ path: path.join(T, '3-focus.png') });
  await page.click('#theaterBtn');
  check(th, 'Focus button toggles big video');

  // ---- export a mix whose backing is the MP4 (audio track used, video ignored)
  const S = await page.evaluate(() => ({ p: window.__S.procFile, d: window.syncDelayMs(), b: window.__S.backingFile }));
  const dest = path.join(T, 'mix.wav');
  await dsp.exportMix({ processed: S.p, dest, format: 'wav24', backing: S.b, backingDelayMs: S.d, vocalDb: 0, backingDb: -6, loudness: -14 });
  const m = await dsp.measure(dest);
  check(Math.abs(m.I + 14) < 1.2 && m.TP < -0.5, `export with MP4 backing: ${m.I} LUFS, ${m.TP} dBTP`);

  // ---- switching back to an audio backing hides the video
  const mp3 = path.join(T, 'tone.mp3');
  await dsp.run(['-y', '-f', 'lavfi', '-i', 'sine=f=330:d=6', '-c:a', 'libmp3lame', mp3]);
  await page.evaluate((f) => window.setBacking(f), mp3);
  check(await page.evaluate(() => document.getElementById('lyricsBox').hidden && !document.getElementById('lyricsVideo').getAttribute('src')), 'audio backing hides and unloads the video');

  await app.close();
  console.log(failed ? `\n${failed} failed` : '\nall video checks passed', '\nfiles in', T);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
