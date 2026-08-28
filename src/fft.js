// Radix-2 complex FFT, iterative and in place.
//
// Written rather than imported: this is the one transform the transcriber
// needs, it is a hundred lines, and the alternative is either a build step this
// app does not have or another minified bundle in lib/ that would dwarf it.
//
// A plan is precomputed per size — the bit-reversal permutation and the twiddle
// table — because a transcription runs the same size some thousands of times
// and rebuilding those each pass is most of the cost.

const plans = new Map();

export function fftPlan(n) {
  if ((n & (n - 1)) !== 0 || n < 2) throw new Error(`FFT size must be a power of two, got ${n}`);
  let plan = plans.get(n);
  if (plan) return plan;

  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }

  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }

  plan = { n, rev, cos, sin };
  plans.set(n, plan);
  return plan;
}

// Forward transform, overwriting `re` and `im`.
export function fft(re, im, plan) {
  const { n, rev, cos, sin } = plan;

  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const wr = cos[k];
        const wi = -sin[k];          // forward transform, so the twiddle turns backwards
        const a = i + j;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr;        im[a] += ti;
      }
    }
  }
}

// ── What the caller actually wants ───────────────────────────────────────────

// A Hann window, precomputed per size. Hann rather than rectangular because a
// note is not periodic in the frame, and the sidelobes of a rectangular window
// would put a loud note's leakage on top of a quiet one three semitones away.
const windows = new Map();

export function hann(n) {
  let w = windows.get(n);
  if (w) return w;
  w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  windows.set(n, w);
  return w;
}

// What a windowed transform does to the height of a sinusoid.
//
// A transform of length n gives a unit sinusoid a peak of half the window's
// sum, so a longer window reports a louder note for the same sound. That is
// harmless when everything is measured with one window and quietly wrong when
// it is not: this analyser runs two, and a note read with the shorter one
// scored less than half of what the same note scored with the longer, purely
// for being in the band that uses it. Dividing it out puts both on the scale of
// the signal itself, where a unit sinusoid reads one whatever measured it.
const windowGains = new Map();

function hannGain(n) {
  let gain = windowGains.get(n);
  if (gain === undefined) {
    const w = hann(n);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += w[i];
    gain = sum / 2;
    windowGains.set(n, gain);
  }
  return gain;
}

// Magnitude spectrum of one windowed frame of real samples, first half only —
// the rest is the mirror image and carries nothing a real signal has not
// already said. `out` is reused across frames rather than reallocated.
//
// Calibrated in amplitude, so the numbers mean the same thing at any n.
export function magnitudes(samples, at, n, out, scratchRe, scratchIm) {
  const plan = fftPlan(n);
  const w = hann(n);
  const gain = hannGain(n);
  // A window may reach past either end of the signal — before it, for the frame
  // centred on the very first sample. Silence outside is what a recording that
  // began a moment earlier would have held.
  for (let i = 0; i < n; i++) {
    const j = at + i;
    const s = j >= 0 && j < samples.length ? samples[j] : 0;
    scratchRe[i] = s * w[i];
    scratchIm[i] = 0;
  }
  fft(scratchRe, scratchIm, plan);

  const half = n >> 1;
  for (let k = 0; k <= half; k++) {
    out[k] = Math.sqrt(scratchRe[k] * scratchRe[k] + scratchIm[k] * scratchIm[k]) / gain;
  }
  return out;
}
