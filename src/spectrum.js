// Turning samples into something with pitches in it.
//
// The hard constraint is that music is spaced logarithmically and an FFT is not.
// A window long enough to tell A2 from B-flat-2 — they are 6.5 Hz apart — is
// 750 milliseconds, and running a 16k-point transform every 23 ms over a
// three-minute file is several billion operations, which is not something to do
// in a browser tab.
//
// So the range is split. Everything from the middle of the keyboard up is
// analysed at full rate with a 4096-point window, where 5.4 Hz bins resolve a
// semitone comfortably. Everything below is analysed on a copy of the signal
// decimated eight times, where the same 743 ms window is only 2048 points
// because the samples are eight times further apart. Same time resolution, same
// frequency resolution, a fraction of the work — which is the whole trick
// behind a constant-Q transform, done with two bands rather than one per octave.
//
// Frames are never all held at once. Each is computed into reused buffers, read,
// and overwritten: a three-minute file would otherwise want ninety megabytes of
// spectra to produce three megabytes of answer.
import { magnitudes } from './fft.js';

export const RATE = 22050;          // what everything is resampled to
export const HOP = 512;             // 23.2 ms — fine enough to place an onset
export const FINE_WINDOW = 4096;    // 186 ms at full rate, 5.4 Hz bins
export const COARSE_DECIM = 8;
export const COARSE_WINDOW = 2048;  // 743 ms at the decimated rate, 1.35 Hz bins

// Where the two bands meet.
//
// Pushed as high as the coarse band's ceiling allows rather than to the point
// where the fine band merely copes: at MIDI 52 the fine window gives under two
// bins to a semitone and lands a note twenty cents out, where the coarse band
// gives it nine. The limit from above is that a pitch's third harmonic has to
// stay under COARSE_CEILING, which puts it here.
export const CROSSOVER_MIDI = 56;

export const COARSE_RATE = RATE / COARSE_DECIM;      // 2756.25 Hz
export const COARSE_CEILING = COARSE_RATE / 2 * 0.9; // usable top of the low band

export function midiToFreq(pitch) {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

// ── Getting to 22.05 kHz and below ───────────────────────────────────────────

// A windowed-sinc lowpass, applied while dropping samples so only the ones kept
// are ever computed. Without it, everything above the new Nyquist folds back
// down and lands on top of the bass, which is exactly the register this band
// exists to hear clearly.
function decimationFilter(factor, taps = 97) {
  const fc = 0.45 / factor;                 // cutoff, as a fraction of the old rate
  const mid = (taps - 1) / 2;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * hamming;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;   // unity gain at DC
  return h;
}

export function decimate(pcm, factor) {
  const h = decimationFilter(factor);
  const taps = h.length;
  const mid = (taps - 1) >> 1;
  const out = new Float32Array(Math.ceil(pcm.length / factor));
  for (let o = 0; o < out.length; o++) {
    const centre = o * factor;
    let acc = 0;
    for (let t = 0; t < taps; t++) {
      const i = centre + t - mid;
      if (i >= 0 && i < pcm.length) acc += pcm[i] * h[t];
    }
    out[o] = acc;
  }
  return out;
}

// Average the channels and resample to RATE. Decoding at the right rate in the
// first place is cheaper and is what the importer does; this is the fallback
// for a buffer that arrived at some other rate.
export function toMono(buffer) {
  const chans = buffer.numberOfChannels;
  const src = buffer.getChannelData(0);
  if (chans === 1) return src;
  const out = new Float32Array(src.length);
  for (let c = 0; c < chans; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / chans;
  }
  return out;
}

// ── The analyser ─────────────────────────────────────────────────────────────

export function makeAnalyzer(pcm) {
  const coarsePcm = decimate(pcm, COARSE_DECIM);
  const coarseHop = HOP / COARSE_DECIM;

  // Frames are centred on i*HOP rather than starting there, so frame zero sits
  // on the first sample and a note that begins at the top of the file still has
  // half a window of run-up to be seen rising through. Windows reaching before
  // the signal read as silence, which is what the run-up would have been.
  const frames = Math.max(0, Math.ceil(pcm.length / HOP));

  const fine = new Float32Array(FINE_WINDOW / 2 + 1);
  const coarse = new Float32Array(COARSE_WINDOW / 2 + 1);
  const re = new Float64Array(FINE_WINDOW);
  const im = new Float64Array(FINE_WINDOW);

  // Both windows are centred on the same instant, so a note's onset lands in
  // the same frame whichever band hears it
  const fineOffset = -FINE_WINDOW / 2;
  const coarseOffset = -COARSE_WINDOW / 2;

  return {
    frames,
    fineBinHz: RATE / FINE_WINDOW,
    coarseBinHz: COARSE_RATE / COARSE_WINDOW,
    // Time at the centre of frame i, in ms
    frameTimeMs(i) { return ((i * HOP) / RATE) * 1000; },
    // Fills and returns the two spectra for frame i. Both are overwritten on
    // the next call — read what you need before asking for another.
    at(i) {
      magnitudes(pcm, i * HOP + fineOffset, FINE_WINDOW, fine, re, im);
      magnitudes(coarsePcm, i * coarseHop + coarseOffset, COARSE_WINDOW, coarse, re, im);
      return { fine, coarse };
    },
  };
}
