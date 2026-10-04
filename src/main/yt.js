// Paste-a-link backing tracks: yt-dlp fetches the best audio stream (our ffmpeg makes the MP3), or a
// karaoke video merged to MP4 so the on-screen lyrics can play in sync while you sing.
// yt-dlp is downloaded on first use; Electron itself serves as its JS runtime (ELECTRON_RUN_AS_NODE),
// so nothing else (deno/node) needs installing.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const dsp = require('./dsp');

const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
let binDir = path.join(os.tmpdir(), 'auddo-bin');
let current = null;

function setBinDir(d) { binDir = d; }
const binPath = () => process.env.YTDLP_PATH || path.join(binDir, 'yt-dlp.exe');

function download(url, dest, onProgress, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Auddo' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 8) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`yt-dlp download failed: HTTP ${res.statusCode}`)); }
      const total = +res.headers['content-length'] || 0;
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => { got += c.length; if (total) onProgress(got / total); });
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureBinary(onProgress) {
  const p = binPath();
  if (fs.existsSync(p)) return p;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const part = p + '.part';
  await download(RELEASE, part, onProgress);
  fs.renameSync(part, p);
  return p;
}

function runYt(args, onLine) {
  return new Promise((resolve, reject) => {
    const ps = spawn(binPath(), args, {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' },
    });
    current = ps;
    let log = '';
    const feed = (d) => {
      const s = d.toString('utf8');
      log += s; if (log.length > 1e5) log = log.slice(-5e4);
      s.split(/\r?\n/).forEach((l) => l && onLine && onLine(l));
    };
    ps.stdout.on('data', feed);
    ps.stderr.on('data', feed);
    ps.on('error', reject);
    ps.on('close', (code, sig) => {
      current = null;
      if (code === 0) return resolve(log);
      const e = new Error(sig ? 'cancelled' : (log.match(/ERROR: .*/g) || ['yt-dlp failed']).pop().replace(/^ERROR: /, ''));
      e.cancelled = !!sig;
      reject(e);
    });
  });
}

const safeName = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 140);

/**
 * Downloads a link as a backing track.
 *   format 'mp3': best audio stream -> LAME V0 MP3.
 *   format 'mp4': video (<=1080p, H.264 preferred so Chromium plays it) + audio merged into MP4,
 *                 for karaoke videos whose on-screen lyrics you want to read while singing.
 * @returns {Promise<{file: string, title: string, video: boolean}>}
 */
async function fetchMedia(url, outDir, onProgress = () => {}, { format = 'mp3' } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Paste a full link (https://…)');
  const video = format === 'mp4';
  fs.mkdirSync(outDir, { recursive: true });
  onProgress({ stage: 'Preparing downloader…', p: 0 });
  await ensureBinary((p) => onProgress({ stage: 'Fetching yt-dlp (first run only)…', p: p * 0.1 }));

  const tmp = path.join(os.tmpdir(), 'auddo', 'yt-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  const args = [
    '--no-playlist', '--no-mtime', '--newline', '--progress',
    '--js-runtimes', `node:${process.execPath}`,
    '-P', tmp, '-o', '%(title).150B [%(id)s].%(ext)s',
  ];
  if (video) {
    args.push(
      '-f', 'bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/b[ext=mp4][height<=1080]/bv*[height<=1080]+ba/b',
      '--merge-output-format', 'mp4', '--ffmpeg-location', dsp.FFMPEG,
    );
  } else {
    args.push('-f', 'bestaudio/best');
  }
  args.push(url);

  // Video mode downloads two streams (video, then audio); progress runs 0-100 for each.
  let part = 0;
  const onLine = (l) => {
    if (/\[download\] Destination:/.test(l)) part++;
    if (/\[Merger\]/.test(l)) return onProgress({ stage: 'Merging video and audio…', p: 0.9 });
    const m = /\[download\]\s+([\d.]+)%/.exec(l);
    if (!m) return;
    const frac = +m[1] / 100;
    if (video) {
      const vid = part <= 1;
      onProgress({ stage: vid ? 'Downloading video…' : 'Downloading audio…', p: 0.1 + (vid ? frac * 0.65 : 0.65 + frac * 0.15) });
    } else onProgress({ stage: 'Downloading audio…', p: 0.1 + frac * 0.7 });
  };
  try {
    await runYt(args, onLine);
  } catch (e) {
    if (e.cancelled || process.env.YTDLP_PATH) throw e;
    // YouTube changes often; a stale yt-dlp is the usual cause. Self-update once and retry.
    onProgress({ stage: 'Updating yt-dlp and retrying…', p: 0.1 });
    await runYt(['-U']).catch(() => {});
    part = 0;
    await runYt(args, onLine);
  }

  const got = fs.readdirSync(tmp).filter((n) => !/\.(part|ytdl|json)$/.test(n) && !/\.f\d+\./.test(n));
  if (!got.length) throw new Error('Nothing was downloaded');
  const src = path.join(tmp, got[0]);
  const title = got[0].replace(/ \[[\w-]{6,}\]\.\w+$/, '').replace(/\.\w+$/, '');
  const dest = path.join(outDir, safeName(got[0].replace(/\.\w+$/, '')) + (video ? '.mp4' : '.mp3'));

  if (!fs.existsSync(dest)) {
    if (video) {
      onProgress({ stage: 'Saving video…', p: 0.95 });
      fs.copyFileSync(src, dest);
    } else {
      onProgress({ stage: 'Converting to MP3…', p: 0.85 });
      // LAME V0 straight from the source stream at its native rate.
      await dsp.run(['-y', '-i', src, '-vn', '-map_metadata', '-1', '-metadata', `title=${title}`, '-c:a', 'libmp3lame', '-q:a', '0', dest]);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  onProgress({ stage: 'Done', p: 1 });
  return { file: dest, title, video };
}

function cancel() { if (current) current.kill(); }

module.exports = { fetchMedia, cancel, setBinDir, ensureBinary };
