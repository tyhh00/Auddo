// Shared between main (require) and renderer (<script>): preset values + slider schema.
(function (root) {
  const PARAMS = [
    // group, key, label, min, max, step, unit
    { g: 'Clean-up', k: 'lowcut',   label: 'Low cut',        min: 40,  max: 200, step: 1,   unit: 'Hz' },
    { g: 'Clean-up', k: 'denoise',  label: 'Denoise',        min: 0,   max: 100, step: 1,   unit: '%' },
    { g: 'Clean-up', k: 'declick',  label: 'Mouth de-click', min: 0,   max: 1,   step: 1,   unit: 'bool' },
    { g: 'Tone',     k: 'warmth',   label: 'Warmth (150 Hz)',  min: -6, max: 6,  step: 0.5, unit: 'dB' },
    { g: 'Tone',     k: 'mud',      label: 'Mud cut (300 Hz)', min: 0,  max: 8,  step: 0.5, unit: 'dB' },
    { g: 'Tone',     k: 'presence', label: 'Presence (4 kHz)', min: -4, max: 6,  step: 0.5, unit: 'dB' },
    { g: 'Tone',     k: 'air',      label: 'Air (10 kHz+)',    min: -2, max: 8,  step: 0.5, unit: 'dB' },
    { g: 'Tone',     k: 'excite',   label: 'Harmonic sheen',   min: 0,  max: 100, step: 1,  unit: '%' },
    { g: 'Dynamics', k: 'deess',    label: 'De-ess',         min: 0,   max: 100, step: 1,   unit: '%' },
    { g: 'Dynamics', k: 'comp',     label: 'Compression',    min: 0,   max: 100, step: 1,   unit: '%' },
    { g: 'Space',    k: 'reverb',   label: 'Reverb mix',     min: 0,   max: 100, step: 1,   unit: '%' },
    { g: 'Space',    k: 'size',     label: 'Reverb decay',   min: 0.3, max: 4,   step: 0.1, unit: 's' },
    { g: 'Space',    k: 'predelay', label: 'Pre-delay',      min: 0,   max: 120, step: 1,   unit: 'ms' },
    { g: 'Space',    k: 'damping',  label: 'Damping',        min: 0,   max: 100, step: 1,   unit: '%' },
    { g: 'Space',    k: 'width',    label: 'Stereo width',   min: 0,   max: 100, step: 1,   unit: '%' },
    { g: 'Space',    k: 'echo',     label: 'KTV echo',       min: 0,   max: 100, step: 1,   unit: '%' },
    { g: 'Space',    k: 'echoMs',   label: 'Echo time',      min: 60,  max: 500, step: 5,   unit: 'ms' },
    { g: 'Output',   k: 'loudness', label: 'Loudness target', min: -24, max: -9, step: 1,   unit: 'LUFS' },
  ];

  const PRESETS = {
    ktv: {
      name: 'KTV Vocal',
      blurb: 'Glossy, forward singing voice with a lush plate-style reverb and the classic karaoke echo. Sits on top of a backing track.',
      params: { lowcut: 100, denoise: 30, declick: 0, warmth: 1.5, mud: 3, presence: 3, air: 4, excite: 30,
        deess: 50, comp: 70, reverb: 34, size: 2.2, predelay: 35, damping: 35, width: 90, echo: 28, echoMs: 190, loudness: -14 },
    },
    hifi: {
      name: 'Hi-Fi Studio',
      blurb: 'Intimate, dead-quiet, detailed. Warm low end, silky top, gentle dynamics and a small 3D room for premium headphones.',
      params: { lowcut: 70, denoise: 55, declick: 1, warmth: 2, mud: 2.5, presence: 1.5, air: 3.5, excite: 15,
        deess: 40, comp: 40, reverb: 13, size: 1.1, predelay: 18, damping: 55, width: 80, echo: 0, echoMs: 190, loudness: -16 },
    },
    clean: {
      name: 'Clean Voice',
      blurb: 'Dry, clear speech for voiceover, podcasts and calls. Strong denoise, no reverb.',
      params: { lowcut: 85, denoise: 75, declick: 1, warmth: 1, mud: 3, presence: 2.5, air: 2, excite: 5,
        deess: 50, comp: 60, reverb: 0, size: 0.8, predelay: 10, damping: 50, width: 50, echo: 0, echoMs: 190, loudness: -16 },
    },
  };

  const api = { PARAMS, PRESETS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AUDDO = api;
})(this);
