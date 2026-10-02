// Detects clipping that happened *before* the app: the signal was flattened at some ceiling and then
// turned down digitally (mic gain too hot, then Windows volume / Maono Link output pulls it lower), so
// the meter reads "fine" while every loud peak is squared off.
// Signature: a level histogram that piles up near the top instead of thinning out. Natural voice gets
// rarer the louder it gets; a clipped one has a crowd of samples at one level.
(function (root) {
  const BIN = 0.1; // dB per histogram bin
  const FLOOR = -40;
  const NB = Math.round(-FLOOR / BIN) + 1;

  // First NB slots: level histogram. Next NB: how many of those samples sit on a flat top
  // (near-zero curvature). A clipped crest is flat; any real waveform crest, even a pure sine, curves.
  function newHist() { return new Float64Array(NB * 2); }

  function addSamples(h, data, weight = 1) {
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a < 0.01) continue; // -40 dBFS
      const db = 20 * Math.log10(a);
      const k = Math.min(NB - 1, Math.max(0, Math.round((db - FLOOR) / BIN)));
      h[k] += weight;
      if (i > 0 && i < data.length - 1 && Math.abs(data[i - 1] + data[i + 1] - 2 * data[i]) < 2e-5 * a) h[NB + k] += weight;
    }
  }

  /** @returns {{clipped:boolean, ceilingDb:number, lowEdgeDb:number, ratio:number, share:number}} */
  function analyse(h) {
    let top = -1;
    for (let k = NB - 1; k >= 0; k--) if (h[k] >= 3) { top = k; break; }
    const none = { clipped: false, ceilingDb: null, lowEdgeDb: null, ratio: 0, share: 0 };
    if (top < 0) return none;
    const smooth = (k) => { let s = 0, n = 0; for (let j = k - 2; j <= k + 2; j++) if (j >= 0 && j < NB) { s += h[j]; n++; } return s / n; };
    // Baseline density 5-8 dB under the top; peak density within the top 4 dB.
    const base = [];
    for (let k = top - 80; k <= top - 50; k++) if (k >= 0) base.push(smooth(k));
    base.sort((a, b) => a - b);
    const baseline = base.length ? base[base.length >> 1] : 0;
    let mode = top, peak = 0;
    for (let k = top; k >= Math.max(0, top - 40); k--) { const v = smooth(k); if (v > peak) { peak = v; mode = k; } }
    const ratio = baseline > 0 ? peak / baseline : 0;
    let total = 0;
    for (let k = Math.max(0, top - 120); k <= top; k++) total += h[k];
    if (baseline <= 0 || total < 2000 || ratio < 1.8) return { ...none, ratio };
    let low = mode;
    while (low > 0 && smooth(low - 1) > baseline * 1.25) low--;
    // A moderate clip is a narrow wall (<~2.5 dB). A wide pile-up is either a severe clip or a pure
    // steady tone lingering at its crest; only the clip has flat tops, so require those.
    if ((mode - low) * BIN > 2.5) {
      let n = 0, flat = 0;
      for (let k = mode - 3; k <= mode + 3; k++) if (k >= 0 && k < NB) { n += h[k]; flat += h[NB + k]; }
      if (!n || flat / n < 0.2) return { ...none, ratio };
    }
    let excess = 0;
    for (let k = low; k <= top; k++) excess += Math.max(0, h[k] - baseline);
    const db = (k) => +(FLOOR + k * BIN).toFixed(1);
    return { clipped: true, ceilingDb: db(mode), lowEdgeDb: db(low), ratio: +ratio.toFixed(2), share: +(excess / total).toFixed(3) };
  }

  function analyseBuffer(channels) {
    const h = newHist();
    for (const d of channels) addSamples(h, d);
    return analyse(h);
  }

  const api = { newHist, addSamples, analyse, analyseBuffer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CLIP = api;
})(this);
