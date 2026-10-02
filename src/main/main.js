const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const dsp = require('./dsp');
const yt = require('./yt');
const { Library } = require('./library');
const { PRESETS } = require('../shared/presets');

const ROOT = path.join(__dirname, '..', '..');
const MODEL = path.join(ROOT, 'assets', 'models', 'bd.rnnn').replace('app.asar', 'app.asar.unpacked');
let win, lib;

// One-time move from the app's old name: Music\SilkVox -> Music\Auddo (sidecar paths rewritten),
// plus settings and the downloaded yt-dlp from the old user-data folder.
function migrateFromSilkVox() {
  if (process.env.AUDDO_TAKES) return;
  try {
    const oldDir = path.join(app.getPath('music'), 'SilkVox');
    const newDir = path.join(app.getPath('music'), 'Auddo');
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
      for (const n of fs.readdirSync(newDir).filter((x) => x.endsWith('.json'))) {
        const f = path.join(newDir, n);
        const txt = fs.readFileSync(f, 'utf8');
        const esc = JSON.stringify(oldDir).slice(1, -1);
        if (txt.includes(esc)) fs.writeFileSync(f, txt.split(esc).join(JSON.stringify(newDir).slice(1, -1)));
      }
    }
    const oldData = path.join(app.getPath('appData'), 'SilkVox');
    const newData = app.getPath('userData');
    for (const rel of ['settings.json', path.join('bin', 'yt-dlp.exe')]) {
      const from = path.join(oldData, rel), to = path.join(newData, rel);
      if (fs.existsSync(from) && !fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
    }
  } catch (e) { console.warn('migration skipped:', e.message); }
}

function takesDir() {
  const d = process.env.AUDDO_TAKES || path.join(app.getPath('music'), 'Auddo');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0d0f14', title: 'Auddo',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  migrateFromSilkVox();
  yt.setBinDir(path.join(app.getPath('userData'), 'bin'));
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media' || perm === 'speaker-selection'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media' || perm === 'speaker-selection');
  lib = new Library({
    takesDir: takesDir(), backingDir: backingDir(), tmpDir: dsp.TMP,
    settingsFile: path.join(app.getPath('userData'), 'settings.json'),
  });
  createWindow();
  // Auto-clean shortly after launch and every 6 h while open (open take/backing are protected).
  const tick = () => lib.clean({ keepFiles: openFiles }).then((r) => {
    if (r.takes + r.backing + r.cache && win && !win.isDestroyed()) win.webContents.send('lib:cleaned', r);
  }).catch(() => {});
  setTimeout(tick, 8000);
  setInterval(tick, 6 * 3600 * 1000);
});
let openFiles = [];
app.on('window-all-closed', () => { dsp.cancelAll(); app.quit(); });

// ---------------------------------------------------------------- recording (streamed to disk)
// 32-bit float WAV: whatever the mic delivers is kept bit-exact, and the file is valid even
// if the app dies mid-take (header is patched on stop; ffmpeg tolerates a stale size anyway).
let rec = null;

function wavHeader(frames, rate, ch) {
  const data = frames * 4 * ch, b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4 * ch, 28); b.writeUInt16LE(4 * ch, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(data, 40);
  return b;
}

ipcMain.handle('rec:begin', (_e, { rate }) => {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(takesDir(), `take-${stamp}.wav`);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, wavHeader(0, rate, 1));
  rec = { file, fd, rate, frames: 0 };
  return file;
});

ipcMain.on('rec:chunk', (_e, buf) => {
  if (!rec) return;
  const b = ArrayBuffer.isView(buf) ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : Buffer.from(buf);
  fs.writeSync(rec.fd, b);
  rec.frames += b.length / 4;
});

ipcMain.handle('rec:end', (_e, meta) => {
  if (!rec) return null;
  const { file, fd, rate, frames } = rec;
  fs.writeSync(fd, wavHeader(frames, rate, 1), 0, 44, 0);
  fs.closeSync(fd);
  rec = null;
  fs.writeFileSync(file.replace(/\.wav$/, '.json'), JSON.stringify({ created: Date.now(), ...(meta || {}) }, null, 2));
  return { file, duration: frames / rate };
});

ipcMain.handle('takes:list', () => lib.list());
ipcMain.handle('takes:delete', (_e, file) => lib.remove(file));
ipcMain.handle('takes:keep', (_e, file, keep) => lib.setKeep(file, keep));
ipcMain.handle('takes:import', (_e, file) => lib.importFile(file));
ipcMain.handle('takes:meta', (_e, file, patch) => lib.writeMeta(file, patch));
ipcMain.handle('lib:settings', (_e, patch) => (patch ? lib.saveSettings(patch) : lib.settings()));
ipcMain.handle('lib:usage', () => lib.usage());
ipcMain.handle('lib:clean', () => lib.clean({ force: true, keepFiles: openFiles }));
ipcMain.on('lib:open', (_e, files) => {
  openFiles = files.filter(Boolean);
  files.forEach((f) => f && lib.touchBacking(f));
});

function backingDir() {
  const d = path.join(takesDir(), 'Backing');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

ipcMain.handle('yt:fetch', (e, url) =>
  yt.fetchAudio(String(url).trim(), backingDir(), (p) => e.sender.send('yt:progress', p)));
ipcMain.handle('yt:cancel', () => yt.cancel());

ipcMain.handle('takes:reveal', (_e, file) => shell.showItemInFolder(file || takesDir()));

// ---------------------------------------------------------------- files
ipcMain.handle('file:open', async (_e, kind) => {
  const r = await dialog.showOpenDialog(win, {
    title: kind === 'backing' ? 'Choose backing track' : 'Open vocal recording',
    defaultPath: kind === 'backing' ? backingDir() : takesDir(),
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aiff', 'aif', 'wma', 'webm', 'mp4'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// Renderer decodes for waveform/preview. Non-browser formats get transcoded to WAV first.
ipcMain.handle('file:read', async (_e, file) => {
  if (/\.(wav|mp3|flac|ogg|opus|m4a|aac|webm|mp4)$/i.test(file)) return fs.readFileSync(file);
  const tmp = path.join(dsp.TMP, 'decode-' + Date.now() + '.wav');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  await dsp.run(['-y', '-i', file, '-c:a', 'pcm_f32le', tmp]);
  const data = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return data;
});

// ---------------------------------------------------------------- live chain assets
const NS_DIST = path.join(ROOT, 'node_modules', '@sapphi-red', 'web-noise-suppressor', 'dist');
ipcMain.handle('asset:wasm', (_e, name) => {
  if (!/^(gtcrn|rnnoise|rnnoise_simd)$/.test(name)) throw new Error('unknown wasm');
  return fs.readFileSync(path.join(NS_DIST, name + '.wasm').replace('app.asar', 'app.asar.unpacked'));
});
const EXTERNAL = ['https://vb-audio.com/Cable/'];
ipcMain.handle('open:external', (_e, url) => (EXTERNAL.includes(url) ? shell.openExternal(url) : null));

// ---------------------------------------------------------------- processing
let jobSeq = 0;
ipcMain.handle('dsp:info', () => ({ ...dsp.capabilities(), model: fs.existsSync(MODEL), presets: Object.keys(PRESETS) }));

ipcMain.handle('dsp:process', async (e, { input, params, noiseFloorDb, declipLowEdgeDb }) => {
  const id = ++jobSeq;
  dsp.cancelAll(); // newest settings win
  try {
    const r = await dsp.processVoice({
      input, params, noiseFloorDb, declipLowEdgeDb, modelPath: MODEL,
      onProgress: (p) => { if (id === jobSeq) e.sender.send('dsp:progress', p); },
    });
    if (id !== jobSeq) return { stale: true };
    return r;
  } catch (err) {
    if (err.cancelled || id !== jobSeq) return { stale: true };
    throw err;
  }
});

ipcMain.handle('dsp:export', async (_e, opts) => {
  const fmt = dsp.FORMATS[opts.format] || dsp.FORMATS.wav24;
  const base = path.basename(opts.source || 'vocal', path.extname(opts.source || '')).replace(/^take-/, '');
  const r = await dialog.showSaveDialog(win, {
    title: 'Export',
    defaultPath: path.join(takesDir(), `${base}-${opts.presetKey || 'mix'}${opts.backing ? '-mix' : ''}.${fmt.ext}`),
    filters: [{ name: fmt.ext.toUpperCase(), extensions: [fmt.ext] }],
  });
  if (r.canceled) return null;
  await dsp.exportMix({ ...opts, dest: r.filePath });
  return r.filePath;
});
