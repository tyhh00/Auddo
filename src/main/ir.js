// Synthetic stereo impulse response: early reflections + darkening diffuse tail + optional
// ping-pong echo taps. Fed to ffmpeg's afir (partitioned convolution) as the "wet" send.
const SR = 48000;

function rng(seed) { // mulberry32, deterministic so the same settings always sound the same
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

/**
 * @param {object} p  reverb (0-100), size = RT60 s, predelay ms, damping 0-100, width 0-100,
 *                    echo 0-100, echoMs
 * @returns {Float32Array[]} [L, R]
 */
function buildIR(p) {
  const rt60 = Math.max(0.2, p.size);
  const pre = Math.round((p.predelay / 1000) * SR);
  const damp = p.damping / 100;
  const width = p.width / 100;
  const revGain = p.reverb / 100;
  const echoGain = (p.echo / 100) * 0.55;
  const echoD = Math.round((p.echoMs / 1000) * SR);
  const echoTaps = echoGain > 0 ? 6 : 0;

  const tailLen = Math.round(rt60 * 1.15 * SR);
  const len = Math.min(SR * 8, pre + tailLen + echoTaps * echoD + SR / 10);
  const L = new Float32Array(len), R = new Float32Array(len);

  if (revGain > 0) {
    const r = rng(0x5eed);
    const n1 = new Float32Array(tailLen), n2 = new Float32Array(tailLen);
    // Diffuse tail: two decorrelated noises, exp decay, low-pass that closes over time
    // (high frequencies die first, like a real room / plate).
    const k = 6.907755 / (rt60 * SR); // ln(1000)
    const fade = Math.round(0.012 * SR);
    let y1 = 0, y2 = 0;
    for (let i = 0; i < tailLen; i++) {
      const t = i / tailLen;
      const cutoff = 16000 * Math.pow(1 - 0.85 * damp, 1 + 3 * t) + 1500 * (1 - t);
      const a = 1 - Math.exp(-2 * Math.PI * Math.min(cutoff, 20000) / SR);
      const env = Math.exp(-k * i) * Math.min(1, i / fade);
      y1 += a * (gauss(r) - y1);
      y2 += a * (gauss(r) - y2);
      n1[i] = y1 * env; n2[i] = y2 * env;
    }
    // Early reflections: sparse taps 4-70 ms, alternating sides.
    const er = new Float32Array(tailLen), erR = new Float32Array(tailLen);
    for (let j = 0; j < 18; j++) {
      const at = Math.round((0.004 + r() * 0.066) * SR);
      const g = (0.6 + 0.4 * r()) * Math.exp(-at / (0.05 * SR)) * (r() < 0.5 ? -1 : 1);
      if (at < tailLen) { (j % 2 ? er : erR)[at] += g; (j % 2 ? erR : er)[at] += g * (1 - width) * 0.7; }
    }
    // Width: R = c*n1 + sqrt(1-c^2)*n2, where c = correlation.
    const c = 1 - width, s = Math.sqrt(1 - c * c);
    let eL = 0, eR = 0;
    const tl = new Float32Array(tailLen), tr = new Float32Array(tailLen);
    for (let i = 0; i < tailLen; i++) {
      tl[i] = n1[i] + er[i] * 0.35;
      tr[i] = c * n1[i] + s * n2[i] + erR[i] * 0.35;
      eL += tl[i] * tl[i]; eR += tr[i] * tr[i];
    }
    // Unit energy per channel => wet RMS ~ dry RMS at revGain = 1.
    const gL = revGain / Math.sqrt(eL || 1), gR = revGain / Math.sqrt(eR || 1);
    for (let i = 0; i < tailLen && pre + i < len; i++) { L[pre + i] += tl[i] * gL; R[pre + i] += tr[i] * gR; }
  }

  if (echoTaps) {
    // Ping-pong repeats, each one darker and quieter (feedback ~0.5).
    for (let n = 1; n <= echoTaps; n++) {
      const g = echoGain * Math.pow(0.5, n - 1);
      const a = 0.6 / n; // one-pole smear gets slower each repeat
      const side = n % 2 ? [1, 0.35 + 0.65 * (1 - width)] : [0.35 + 0.65 * (1 - width), 1];
      let v = a;
      for (let i = 0; i < 400 && n * echoD + i < len; i++) {
        L[n * echoD + i] += g * v * side[0];
        R[n * echoD + i] += g * v * side[1];
        v *= 1 - a;
      }
    }
  }
  return [L, R];
}

function wavFloatStereo([L, R]) {
  const n = L.length, data = n * 8;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 8, 28); b.writeUInt16LE(8, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(data, 40);
  for (let i = 0; i < n; i++) { b.writeFloatLE(L[i], 44 + i * 8); b.writeFloatLE(R[i], 48 + i * 8); }
  return b;
}

module.exports = { buildIR, wavFloatStereo, SR };
