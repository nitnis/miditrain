// A second opinion on the octave question, and the only one that carries any
// information about it.
//
// The peeling in transcribe.js scores each pitch against a fixed template of
// partial strengths. For an exact octave that template is the whole problem:
// every partial of the upper note lies on an even partial of the lower one, so
// when the template under-predicts the lower note's second partial, the
// leftover energy is indistinguishable from the octave above being played. On
// the recording in test/fixtures the opening bass F invents a treble F this
// way, and no threshold can catch it — measured, the invented note is the
// *stronger* signal.
//
// Non-negative matrix factorisation with a per-note dictionary answers it
// differently. The atoms are pitches, their support is fixed to where that
// pitch's partials can be, and their *ratios* are learned from the recording
// being transcribed — no trained model, no reference instrument. A pitch's odd
// partials are bins the octave above cannot touch, so they pin its level; given
// that level and a learned second-partial ratio, what belongs at the octave is
// predicted rather than assumed, and what is left over is the octave really
// being played.
//
// What it is worth, measured on that fixture, as the upper note's activation
// over the lower one's at the moment of the doubled onset:
//
//                        the known ghost   a real entry   the next one
//   peeling                     0.93           0.93           1.29
//   this                        0.51           1.76           2.45
//
// The peeling gives the same number for the invented note and the real one. It
// is not that it weighs the evidence badly; it does not have any.
import { makeAnalyzer, midiToFreq, RATE, FINE_WINDOW } from './spectrum.js';

const PARTIALS = 8;
const TOLERANCE = 0.25;          // semitones, as the peeler uses
const INIT_WEIGHTS = [1, 0.5, 0.4, 0.25, 0.2, 0.15, 0.1, 0.08];
const EPS = 1e-9;

// Which bins each pitch's partials occupy, in the fine spectrum
export function buildSupport(lowest, highest) {
  const binHz = RATE / FINE_WINDOW;
  const bins = FINE_WINDOW / 2 + 1;
  const atoms = [];
  for (let pitch = lowest; pitch <= highest; pitch++) {
    const f0 = midiToFreq(pitch);
    const idx = [];
    const init = [];
    for (let h = 0; h < PARTIALS; h++) {
      const f = f0 * (h + 1);
      if (f > (RATE / 2) * 0.9) break;
      const lo = Math.max(1, Math.round((f * Math.pow(2, -TOLERANCE / 12)) / binHz));
      const hi = Math.min(bins - 1, Math.round((f * Math.pow(2, TOLERANCE / 12)) / binHz));
      for (let b = lo; b <= hi; b++) { idx.push(b); init.push(INIT_WEIGHTS[h]); }
    }
    atoms.push({ pitch, idx: Int32Array.from(idx), w: Float64Array.from(init) });
  }
  return atoms;
}

export function spectrogram(pcm) {
  const an = makeAnalyzer(pcm);
  const bins = FINE_WINDOW / 2 + 1;
  const V = new Float64Array(an.frames * bins);
  for (let f = 0; f < an.frames; f++) {
    const { fine } = an.at(f);
    V.set(fine.subarray(0, bins), f * bins);
  }
  return { V, frames: an.frames, bins, analyzer: an };
}

// KL-divergence NMF, multiplicative updates, with the dictionary confined to
// each pitch's own partial bins.
//
// Two phases, and the split is what makes it affordable.
//
// The first learns the dictionary, and can do it from every nth frame: a
// partial ratio is an average over hundreds of frames and does not need all of
// them. The second holds the dictionary still and settles the activations over
// every frame, because those are what gets read and they are read at moments a
// stride may never have visited.
//
// `sparsity` is a concave penalty rather than an L1 one, deliberately. L1 on
// the activations cannot break an octave tie at all: with the dictionary
// columns normalised, splitting one note's energy across two atoms costs
// exactly what putting it in one does. A concave penalty prefers concentration,
// which is the thing being asked for. It is off by default — the dictionary
// turned out to be the part that carries the answer.
export function factorise(V, frames, bins, atoms, {
  iterations = 24, settle = 8, sparsity = 0, onIter = null, stride = 3,
} = {}) {
  const K = atoms.length;
  const H = new Float64Array(frames * K).fill(0.1);
  const recon = new Float64Array(bins);
  const ratio = new Float64Array(bins);
  // Column sums of W, which normalise the activation update
  const colSum = new Float64Array(K);
  const wNum = atoms.map(a => new Float64Array(a.idx.length));
  const wDen = atoms.map(a => new Float64Array(a.idx.length));

  const passes = iterations + settle;
  for (let it = 0; it < passes; it++) {
    for (let k = 0; k < K; k++) {
      let s = 0;
      for (let i = 0; i < atoms[k].w.length; i++) s += atoms[k].w[i];
      colSum[k] = s + EPS;
    }
    const learning = it < iterations;
    if (learning) {
      for (let k = 0; k < K; k++) { wNum[k].fill(0); wDen[k].fill(0); }
    }

    const step = learning ? stride : 1;
    for (let f = 0; f < frames; f += step) {
      const vBase = f * bins;
      const hBase = f * K;
      recon.fill(0);
      for (let k = 0; k < K; k++) {
        const h = H[hBase + k];
        if (h <= EPS) continue;
        const { idx, w } = atoms[k];
        for (let i = 0; i < idx.length; i++) recon[idx[i]] += h * w[i];
      }
      for (let b = 0; b < bins; b++) ratio[b] = V[vBase + b] / (recon[b] + EPS);

      for (let k = 0; k < K; k++) {
        const { idx, w } = atoms[k];
        let num = 0;
        for (let i = 0; i < idx.length; i++) num += w[i] * ratio[idx[i]];
        const h = H[hBase + k];
        // Concave sparsity: the more an atom already carries, the cheaper its
        // next unit — so energy gathers into few atoms instead of spreading
        const pen = sparsity > 0 ? sparsity / (h + 1e-3) : 0;
        H[hBase + k] = h * num / (colSum[k] + pen);
        if (learning && h > EPS) {
          const wn = wNum[k], wd = wDen[k];
          for (let i = 0; i < idx.length; i++) { wn[i] += h * ratio[idx[i]]; wd[i] += h; }
        }
      }
    }

    if (learning) {
      for (let k = 0; k < K; k++) {
        const { w } = atoms[k];
        for (let i = 0; i < w.length; i++) {
          w[i] = Math.max(1e-6, w[i] * wNum[k][i] / (wDen[k][i] + EPS));
        }
        // The scale lives in H, not in W, or the two drift together
        let s = 0;
        for (let i = 0; i < w.length; i++) s += w[i];
        for (let i = 0; i < w.length; i++) w[i] = w[i] / (s + EPS);
      }
    }
    if (onIter) onIter(it);
  }
  return H;
}
