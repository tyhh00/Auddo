// Takes library: listing, star/keep, delete, import, and age-based auto-clean.
// User audio (takes, downloaded tracks) goes to the Recycle Bin, never straight to oblivion.
// Exports are never touched: they don't match the take-* pattern and live wherever the user saved them.
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

const DAY = 86400000;
// Tests set AUDDO_NO_TRASH so they don't fill the real Recycle Bin.
const trash = (p) => (process.env.AUDDO_NO_TRASH ? Promise.resolve(fs.rmSync(p, { force: true })) : shell.trashItem(p));
const DEFAULTS = { autoClean: true, days: 7, cleanTakes: true, cleanBacking: true };

class Library {
  constructor({ takesDir, backingDir, settingsFile, tmpDir }) {
    Object.assign(this, { takesDir, backingDir, settingsFile, tmpDir });
  }

  settings() {
    try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) }; } catch { return { ...DEFAULTS }; }
  }

  saveSettings(patch) {
    const s = { ...this.settings(), ...patch };
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify(s, null, 2));
    return s;
  }

  sidecar(file) { return file.replace(/\.[^.\\/]+$/, '.json'); }

  readMeta(file) {
    try { return JSON.parse(fs.readFileSync(this.sidecar(file), 'utf8')); } catch { return {}; }
  }

  writeMeta(file, patch) {
    const m = { ...this.readMeta(file), ...patch };
    fs.writeFileSync(this.sidecar(file), JSON.stringify(m, null, 2));
    return m;
  }

  takeFiles() {
    return fs.readdirSync(this.takesDir)
      .filter((n) => /^take-.*\.(wav|mp3|flac|m4a|aac|ogg|opus|aiff?|webm)$/i.test(n))
      .map((n) => path.join(this.takesDir, n));
  }

  list(limit = 60) {
    const days = this.settings().days;
    return this.takeFiles()
      .map((file) => {
        const st = fs.statSync(file);
        const meta = this.readMeta(file);
        const created = meta.created || st.birthtimeMs || st.mtimeMs;
        return { file, name: path.basename(file), size: st.size, meta, created, expires: meta.keep ? null : created + days * DAY };
      })
      .sort((a, b) => b.created - a.created)
      .slice(0, limit);
  }

  inTakes(file) {
    const rel = path.relative(this.takesDir, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
  }

  async remove(file) {
    if (!this.inTakes(file) || !/^take-/.test(path.basename(file))) throw new Error('Only takes in the Auddo folder can be deleted here');
    await trash(file);
    if (fs.existsSync(this.sidecar(file))) await trash(this.sidecar(file)).catch(() => fs.rmSync(this.sidecar(file), { force: true }));
    return true;
  }

  setKeep(file, keep) {
    if (!this.inTakes(file)) throw new Error('Not a take');
    return this.writeMeta(file, { keep: !!keep });
  }

  /** Copies an outside file into the library so it shows up (and can be managed) like a recorded take. */
  importFile(src) {
    if (this.inTakes(src) && /^take-/.test(path.basename(src))) return src;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const clean = path.basename(src).replace(/[^\w\-. ()À-￿]/g, '_').slice(0, 80);
    const dest = path.join(this.takesDir, `take-${stamp}-${clean}`);
    fs.copyFileSync(src, dest);
    this.writeMeta(dest, { imported: src, created: Date.now() });
    return dest;
  }

  /** Marks a downloaded backing track as used (so active songs don't age out). */
  touchBacking(file) {
    try {
      const rel = path.relative(this.backingDir, file);
      if (!rel.startsWith('..') && fs.existsSync(file)) { const now = new Date(); fs.utimesSync(file, now, now); }
    } catch {}
  }

  usage() {
    const sum = (files) => files.reduce((a, f) => { try { return a + fs.statSync(f).size; } catch { return a; } }, 0);
    const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); } catch { return []; } };
    return {
      takes: sum(this.takeFiles()),
      backing: sum(walk(this.backingDir)),
      cache: sum(walk(this.tmpDir)),
    };
  }

  /**
   * @param {{force?: boolean, keepFiles?: string[]}} opts  keepFiles = currently open take/backing
   */
  async clean({ force = false, keepFiles = [] } = {}) {
    const s = this.settings();
    const out = { takes: 0, backing: 0, cache: 0, bytes: 0 };
    if (!s.autoClean && !force) return out;
    const cutoff = Date.now() - s.days * DAY;
    const keep = new Set(keepFiles.filter(Boolean).map((f) => path.resolve(f)));
    const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

    // Render scratch + declip cache: always safe to drop (regenerated on demand).
    const tmpCut = Date.now() - Math.min(s.days, 1) * DAY;
    for (const sub of ['', 'cache']) {
      let names = [];
      try { names = fs.readdirSync(path.join(this.tmpDir, sub)); } catch {}
      for (const n of names) {
        const p = path.join(this.tmpDir, sub, n);
        try {
          const st = fs.statSync(p);
          if (n === 'cache' && !sub) continue;
          if (st.mtimeMs < tmpCut) { out.bytes += st.isDirectory() ? 0 : st.size; fs.rmSync(p, { recursive: true, force: true }); out.cache++; }
        } catch {}
      }
    }

    // Backing tracks still referenced by a starred take are kept.
    const takes = this.list(100000);
    for (const t of takes) if (t.meta.keep && t.meta.backingFile) keep.add(path.resolve(t.meta.backingFile));

    if (s.cleanTakes) {
      for (const t of takes) {
        if (t.meta.keep || keep.has(path.resolve(t.file)) || t.created >= cutoff) continue;
        const b = size(t.file);
        try { await this.remove(t.file); out.takes++; out.bytes += b; } catch {}
      }
    }
    if (s.cleanBacking) {
      let names = [];
      try { names = fs.readdirSync(this.backingDir); } catch {}
      for (const n of names) {
        const p = path.join(this.backingDir, n);
        try {
          const st = fs.statSync(p);
          if (!st.isFile() || keep.has(path.resolve(p)) || st.mtimeMs >= cutoff) continue;
          await trash(p); out.backing++; out.bytes += st.size;
        } catch {}
      }
    }
    return out;
  }
}

module.exports = { Library, DEFAULTS };
