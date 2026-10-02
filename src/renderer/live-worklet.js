// Real-time dynamics for the live chain. Mirrors the offline ffmpeg stages closely enough that a
// preset sounds the same live as rendered:
//   auddo-dyn     mono  : room-floor tracker -> soft expander -> 2-stage compressor
//   auddo-deess   mono  : split-band de-esser (complementary one-pole split, perfect reconstruction)
//   auddo-master  stereo: voice-gated loudness leveler -> 1.5 ms look-ahead limiter (-1 dBFS) + meters
const SR = sampleRate;
const dbToLin = (db) => Math.pow(10, db / 20);
const linToDb = (v) => (v > 1e-9 ? 20 * Math.log10(v) : -180);
const coef = (ms) => Math.exp(-1 / ((ms / 1000) * SR));

// Soft-knee downward compressor gain (dB) for a detector level in dB.
function compGain(levelDb, thr, ratio, knee) {
  const over = levelDb - thr;
  if (2 * over < -knee) return 0;
  if (2 * Math.abs(over) <= knee) return -((1 - 1 / ratio) * Math.pow(over + knee / 2, 2)) / (2 * knee);
  return -(1 - 1 / ratio) * over;
}

class Comp {
  constructor() { this.env = 0; this.gr = 0; this.set({ thr: -20, ratio: 2, attack: 20, release: 150, knee: 6, rms: true }); }
  set(o) { Object.assign(this, o); this.a = coef(o.attack); this.r = coef(o.release); }
  // returns linear gain for this sample
  run(x) {
    const d = this.rms ? x * x : Math.abs(x);
    this.env = d > this.env ? this.a * this.env + (1 - this.a) * d : this.r * this.env + (1 - this.r) * d;
    const lvl = this.rms ? 10 * Math.log10(this.env + 1e-20) : linToDb(this.env);
    return dbToLin(compGain(lvl, this.thr, this.ratio, this.knee));
  }
}

class Dyn extends AudioWorkletProcessor {
  constructor() {
    super();
    this.c1 = new Comp(); this.c2 = new Comp();
    this.floor = -70; this.blk = 0; this.blkN = 0; this.blkLen = Math.round(SR * 0.02);
    this.expEnv = 0; this.expG = 1; this.expOn = true; this.expRange = -10;
    this.ea = coef(8); this.er = coef(350);
    this.compOn = true;
    this.port.onmessage = (e) => this.configure(e.data);
    this.configure({ comp: 50, denoise: 50 });
  }
  configure({ comp = 0, denoise = 0 }) {
    const c = comp / 100;
    this.compOn = comp > 0;
    this.c1.set({ thr: -14 - 10 * c, ratio: 1.5 + 1.5 * c, attack: 25 - 12 * c, release: 180, knee: 6, rms: true });
    this.c2.set({ thr: -8 - 6 * c, ratio: 2 + 2 * c, attack: 6 - 3 * c, release: 90, knee: 4, rms: false });
    this.expOn = denoise > 0;
    this.expRange = -6 - denoise * 0.08;
  }
  process(inputs, outputs) {
    const x = inputs[0][0], y = outputs[0][0];
    if (!y) return true;
    if (!x) { y.fill(0); return true; }
    for (let i = 0; i < x.length; i++) {
      let s = x[i];
      // Room floor: quietest 20 ms blocks, rising slowly (0.5 dB/s) so speech never drags it up fast.
      this.blk += s * s;
      if (++this.blkN === this.blkLen) {
        const db = 10 * Math.log10(this.blk / this.blkN + 1e-20);
        this.floor = db < this.floor ? db : this.floor + 0.01;
        this.blk = 0; this.blkN = 0;
      }
      if (this.expOn) {
        const d = s * s;
        this.expEnv = d > this.expEnv ? this.ea * this.expEnv + (1 - this.ea) * d : this.er * this.expEnv + (1 - this.er) * d;
        const lvl = 10 * Math.log10(this.expEnv + 1e-20), thr = this.floor + 12;
        const tgt = lvl < thr ? Math.max(this.expRange, (lvl - thr) * 1) : 0; // ratio 2 below threshold
        const g = dbToLin(tgt);
        this.expG = g < this.expG ? 0.995 * this.expG + 0.005 * g : 0.9995 * this.expG + 0.0005 * g;
        s *= this.expG;
      }
      if (this.compOn) { s *= this.c1.run(s); s *= this.c2.run(s); }
      y[i] = s;
    }
    return true;
  }
}

class DeEss extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lp = 0; this.envH = 0; this.envF = 0; this.g = 1;
    this.k = 1 - Math.exp(-2 * Math.PI * 5500 / SR);
    this.a = coef(1); this.r = coef(60);
    this.port.onmessage = (e) => this.configure(e.data);
    this.configure({ deess: 40 });
  }
  configure({ deess = 0 }) {
    this.on = deess > 0;
    this.maxRed = -(3 + deess * 0.09);   // up to -12 dB
    this.amount = 0.4 + deess / 100;     // dB of cut per dB of excess
  }
  process(inputs, outputs) {
    const x = inputs[0][0], y = outputs[0][0];
    if (!y) return true;
    if (!x) { y.fill(0); return true; }
    for (let i = 0; i < x.length; i++) {
      const s = x[i];
      this.lp += this.k * (s - this.lp);
      const hi = s - this.lp;
      if (!this.on) { y[i] = s; continue; }
      const h = hi * hi, fl = s * s;
      this.envH = h > this.envH ? this.a * this.envH + (1 - this.a) * h : this.r * this.envH + (1 - this.r) * h;
      this.envF = fl > this.envF ? this.a * this.envF + (1 - this.a) * fl : this.r * this.envF + (1 - this.r) * fl;
      // Sibilance = high band carrying most of the energy. Excess over -4 dB relative is cut.
      const rel = 10 * Math.log10((this.envH + 1e-20) / (this.envF + 1e-20));
      const excess = rel + 4;
      const tgt = excess > 0 && this.envF > 1e-7 ? dbToLin(Math.max(this.maxRed, -excess * this.amount * 3)) : 1;
      this.g = tgt < this.g ? 0.9 * this.g + 0.1 * tgt : 0.998 * this.g + 0.002 * tgt;
      y[i] = this.lp + hi * this.g;
    }
    return true;
  }
}

class Master extends AudioWorkletProcessor {
  constructor() {
    super();
    this.la = Math.round(SR * 0.0015);
    this.buf = [new Float32Array(this.la + 1), new Float32Array(this.la + 1)];
    this.w = 0;
    this.peakQ = []; // monotonic deque of [index, peak] for the look-ahead window max
    this.n = 0;
    this.limG = 1; this.lr = coef(80); this.lat = coef(0.3); // attack settles within the 1.5 ms look-ahead
    this.ceil = dbToLin(-1);
    this.levOn = true; this.target = -16; this.levDb = 0; this.voiced = 0; this.gms = 0; this.sinceVoice = 0;
    this.ms = 0; this.msA = coef(300);
    this.floor = -70; this.blk = 0; this.blkN = 0; this.blkLen = Math.round(SR * 0.02);
    this.mPk = 0; this.mSum = 0; this.mN = 0; this.mGr = 1; this.reportEvery = Math.round(SR * 0.05);
    this.gain = 1; this.manualDb = 0;
    this.port.onmessage = (e) => this.configure(e.data);
  }
  configure({ loudness, outputDb }) {
    if (loudness !== undefined) { this.levOn = loudness != null; this.target = loudness ?? -16; }
    if (outputDb !== undefined) this.manualDb = outputDb;
    if (this.levOn === false) this.levDb = 0;
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out[0]) return true;
    const L = inp[0] || null, R = inp[1] || inp[0] || null;
    const len = out[0].length;
    for (let i = 0; i < len; i++) {
      const l0 = L ? L[i] : 0, r0 = R ? R[i] : 0;
      // ---- leveler: rides gain toward the target only while a voice is present
      const m = 0.5 * (l0 * l0 + r0 * r0);
      this.ms = this.msA * this.ms + (1 - this.msA) * m;
      this.blk += m;
      if (++this.blkN === this.blkLen) {
        const db = 10 * Math.log10(this.blk / this.blkN + 1e-20);
        this.floor = db < this.floor ? db : this.floor + 0.01;
        this.blk = 0; this.blkN = 0;
        if (this.levOn) {
          // Gated loudness, EBU-style: only 20 ms blocks that are clearly speech feed the measurement.
          // Absolute gate -45 dBFS (after AI denoise the room can sit near -90, so floor-relative alone
          // would count hiss) and relative gate 15 dB under the current voice level, so the fading
          // tail after a sentence can't read as "quiet voice" and pump the gain up in the pause.
          const voiceDb = this.gms > 0 ? 10 * Math.log10(this.gms) : -45;
          // After 3 s with nothing gated, relax the voice estimate (~4 dB/s) so a speaker who moved
          // back from the mic is picked up again. This only loosens the gate; gain stays put in pauses.
          if (++this.sinceVoice > 150 && this.gms > 0) this.gms *= 0.98;
          if (db > -45 && db > this.floor + 15 && db > voiceDb - 15) {
            this.sinceVoice = 0;
            this.gms = this.gms > 0 ? 0.951 * this.gms + 0.049 * Math.pow(10, db / 10) : Math.pow(10, db / 10);
            const lvl = 10 * Math.log10(this.gms);
            // Gated voice RMS reads ~2 dB above integrated LUFS (calibrated in test/live.e2e.js).
            const err = this.target - 2 - (lvl + this.levDb);
            // dB per 20 ms: 12 dB/s down, 6 dB/s up; 4x faster for the first ~3 s of voice so a
            // fresh session reaches the target quickly instead of starting quiet.
            const fast = ++this.voiced < 150 ? 4 : 1;
            const step = (err < 0 ? 0.25 : 0.12) * fast;
            this.levDb = Math.max(-12, Math.min(20, this.levDb + Math.max(-step, Math.min(step, err))));
          }
        }
      }
      const g = dbToLin(this.levDb + this.manualDb);
      const l = l0 * g, r = r0 * g;
      // ---- look-ahead limiter
      const pk = Math.max(Math.abs(l), Math.abs(r));
      const idx = this.n++;
      while (this.peakQ.length && this.peakQ[this.peakQ.length - 1][1] <= pk) this.peakQ.pop();
      this.peakQ.push([idx, pk]);
      while (this.peakQ[0][0] <= idx - this.la) this.peakQ.shift();
      const winPk = this.peakQ[0][1];
      const tgt = winPk > this.ceil ? this.ceil / winPk : 1;
      this.limG = tgt < this.limG ? this.lat * this.limG + (1 - this.lat) * tgt : this.lr * this.limG + (1 - this.lr) * tgt;
      const gg = this.limG;
      this.buf[0][this.w] = l; this.buf[1][this.w] = r;
      const rd = (this.w + 1) % (this.la + 1);
      let ol = this.buf[0][rd] * gg, or = this.buf[1][rd] * gg;
      // safety: never exceed the ceiling
      if (ol > this.ceil) ol = this.ceil; else if (ol < -this.ceil) ol = -this.ceil;
      if (or > this.ceil) or = this.ceil; else if (or < -this.ceil) or = -this.ceil;
      this.w = rd;
      out[0][i] = ol; if (out[1]) out[1][i] = or;
      // ---- meters
      const ap = Math.max(Math.abs(ol), Math.abs(or));
      if (ap > this.mPk) this.mPk = ap;
      this.mSum += 0.5 * (ol * ol + or * or); this.mN++;
      if (gg < this.mGr) this.mGr = gg;
      if (this.mN >= this.reportEvery) {
        this.port.postMessage({ peak: linToDb(this.mPk), rms: 10 * Math.log10(this.mSum / this.mN + 1e-20), leveler: this.levDb, limiter: linToDb(this.mGr), floor: this.floor });
        this.mPk = 0; this.mSum = 0; this.mN = 0; this.mGr = 1;
      }
    }
    return true;
  }
}

registerProcessor('auddo-dyn', Dyn);
registerProcessor('auddo-deess', DeEss);
registerProcessor('auddo-master', Master);
