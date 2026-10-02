// Captures channel 0 of the mic bit-exact (float32) and ships ~100 ms blocks to the main thread.
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(4800);
    this.n = 0;
    this.first = -1;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.first = -1; this.n = 0; }
      if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (!this.n) return;
    const out = this.buf.slice(0, this.n);
    this.port.postMessage({ data: out }, [out.buffer]);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!this.on) return true;
    if (this.first < 0) { this.first = currentFrame; this.port.postMessage({ first: currentFrame }); }
    const src = ch || new Float32Array(128); // keep the timeline continuous even if the device hiccups
    for (let i = 0; i < src.length; i++) {
      this.buf[this.n++] = src[i];
      if (this.n === this.buf.length) this.flush();
    }
    return true;
  }
}
registerProcessor('recorder', Recorder);
