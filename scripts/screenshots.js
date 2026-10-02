// Regenerates docs/screenshots/*.png from a synthetic demo (TTS voice + generated chord loop),
// driving the real app. Needs a system ffmpeg with libflite on PATH for the voice (gyan "full" build).
//   node scripts/screenshots.js
const { _electron: electron } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dsp = require('../src/main/dsp');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const T = path.join(os.tmpdir(), 'auddo-shots');
const TAKES = path.join(T, 'takes');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(path.join(TAKES, 'Backing'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const DAY = 86400000;

async function makeAssets() {
  const voice = path.join(T, 'voice.wav');
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    "flite=text='Hello, and welcome to Auddo. This is a quick demo of a voice recorded close to a dynamic microphone, in an ordinary bedroom, with a fan running in the background.':voice=slt", voice]);
  // Take = 2 s room tone + voice over pink noise and a little hum: a realistic untreated room.
  const take = path.join(T, 'take.wav');
  await dsp.run(['-y', '-i', voice, '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.006:d=16', '-f', 'lavfi', '-i', 'sine=f=60:d=16,volume=0.002',
    '-filter_complex', '[0:a]aresample=48000,aformat=channel_layouts=mono,volume=0.4,adelay=2000[v];[v][1:a][2:a]amix=inputs=3:normalize=0:duration=longest',
    '-ar', '48000', '-c:a', 'pcm_f32le', take]);
  // Same take hard-clipped at a hot gain then pulled down 10 dB (what a too-high knob does).
  const clipped = path.join(T, 'clipped.wav');
  await dsp.run(['-y', '-i', take, '-af', 'volume=14dB,asoftclip=type=hard:threshold=0.55,volume=-10dB', '-c:a', 'pcm_f32le', clipped]);
  // Original chord loop backing: I-V-vi-IV pads + kick + hats, 16 s.
  const backing = path.join(TAKES, 'Backing', 'Demo backing - chord loop.mp3');
  const prog = [[261.6, 329.6, 392], [196, 246.9, 293.7], [220, 261.6, 329.6], [174.6, 220, 261.6]];
  let expr = [];
  for (let bar = 0; bar < 8; bar++) expr.push(`(${prog[bar % 4].map((x) => `0.05*sin(2*PI*${x}*t)`).join('+')})*between(t,${bar * 2},${bar * 2 + 2})`);
  expr.push('0.35*sin(2*PI*52*t)*exp(-14*mod(t,0.5))');
  await dsp.run(['-y', '-f', 'lavfi', '-i', `aevalsrc='${expr.join('+')}':s=48000:d=16`,
    '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.25:d=16,highpass=f=7000,volume=0.25',
    '-filter_complex', "[1:a]volume='if(lt(mod(t,0.25),0.03),1,0)':eval=frame[h];[0:a][h]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo",
    '-c:a', 'libmp3lame', '-q:a', '2', backing]);
  // Library: a few earlier takes so the list looks lived-in.
  const add = (name, meta, ageDays) => {
    const f = path.join(TAKES, name);
    fs.copyFileSync(take, f);
    fs.writeFileSync(f.replace(/\.wav$/, '.json'), JSON.stringify({ created: Date.now() - ageDays * DAY, ...meta }));
    return f;
  };
  add('take-2026-09-28-21-14-03.wav', { keep: true, backingFile: backing }, 5);
  add('take-2026-09-30-22-40-51.wav', { backingFile: backing }, 3);
  add('take-2026-10-01-20-05-12.wav', {}, 1.5);
  const mic = path.join(T, 'mic.wav'), micClip = path.join(T, 'mic-clip.wav');
  await dsp.run(['-y', '-stream_loop', '4', '-i', take, '-c:a', 'pcm_s16le', mic]);
  await dsp.run(['-y', '-stream_loop', '4', '-i', clipped, '-c:a', 'pcm_s16le', micClip]);
  return { take, clipped, backing, mic, micClip };
}

async function launch(mic) {
  const app = await electron.launch({
    args: ['.', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`, '--autoplay-policy=no-user-gesture-required'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AUDDO_TAKES: TAKES, AUDDO_NO_TRASH: '1' },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.waitForFunction(() => window.__ready, null, { timeout: 30000 });
  // Chromium's fake devices have test names; show generic ones instead.
  await page.evaluate(() => {
    for (const o of document.querySelectorAll('#inDev option')) o.textContent = 'Microphone (USB Audio CODEC)';
    for (const o of document.querySelectorAll('#outDev option')) o.textContent = 'Headphones (USB Audio CODEC)';
  });
  return { app, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) }).then(() => console.log('saved', name));
const rendered = (page) => page.waitForFunction(() => window.__S.proc && !document.getElementById('procBtn').disabled, null, { timeout: 120000 });

(async () => {
  const a = await makeAssets();

  // ---- session 1: normal mic
  let { app, page } = await launch(a.mic);
  await page.evaluate((f) => window.setBacking(f), a.backing);

  await page.click('#recBtn');
  await page.waitForTimeout(5200);
  await shot(page, 'recording.png');
  await page.waitForTimeout(8800); // full sentence (~14 s take)
  await page.click('#recBtn');
  await rendered(page);

  await page.click('.preset[data-k="ktv"]');
  await page.waitForFunction(() => window.__S.stats && Math.abs(window.__S.stats.final.I + 14) < 1, null, { timeout: 120000 });
  await rendered(page);
  await page.evaluate(() => { window.__S.playFrom = 3.2; });
  await page.click('#playBtn');
  await page.waitForTimeout(1600);
  await shot(page, 'ktv.png');
  await page.click('#playBtn');

  await page.click('.preset[data-k="hifi"]');
  await page.waitForFunction(() => window.__S.stats && Math.abs(window.__S.stats.final.I + 16) < 1, null, { timeout: 120000 });
  await rendered(page);
  await page.evaluate(() => {
    document.querySelectorAll('#sliders details').forEach((d) => { d.open = d.querySelector('summary').textContent !== 'Clean-up'; });
    document.querySelector('.process').scrollTop = 180;
  });
  await page.evaluate(() => { window.__S.playFrom = 4.0; });
  await page.click('#playBtn');
  await page.waitForTimeout(1600);
  await shot(page, 'hifi.png');
  await page.click('#playBtn');

  await page.click('#guideBtn');
  await page.waitForTimeout(300);
  await shot(page, 'guide.png');
  await app.close();

  // ---- session 2: clipped mic + clipped take
  ({ app, page } = await launch(a.micClip));
  const clippedTake = path.join(TAKES, 'take-2026-10-02-19-30-44.wav');
  fs.copyFileSync(a.clipped, clippedTake);
  fs.writeFileSync(clippedTake.replace(/\.wav$/, '.json'), JSON.stringify({ created: Date.now() }));
  await page.evaluate(() => window.refreshTakes());
  await page.click(`.takes li[data-file="${clippedTake.replace(/\\/g, '\\\\')}"]`);
  await rendered(page);
  await page.waitForFunction(() => /BEFORE THE APP/.test(document.getElementById('levelHint').textContent), null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => { window.__S.playFrom = 6.0; });
  await page.click('#playBtn');
  await page.waitForTimeout(1500);
  await shot(page, 'clipping.png');
  await page.click('#playBtn');
  await app.close();
  console.log('done ->', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
