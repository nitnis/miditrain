// Audio in, notes out.
//
// The problem this solves is narrower than "transcribe music", and the narrowing
// is what makes it tractable: the audio is a rendering of a MIDI file, so it is
// one instrument, in tune, with clean attacks, no percussion and no room. Every
// note begins at one of eighty-eight known frequencies and none of them ever
// slides. That is enough prior knowledge to do this with signal processing and
// a template rather than with a model.
//
// Three steps, per frame:
//
//   score    every pitch by the energy sitting at its partials
//   peel     the winner, subtract what it explains, and score again
//   track    the resulting per-pitch salience into notes
//
// Peeling is the part that matters. Without it a loud C is also heard as the C
// an octave above, because that C's fundamental is exactly the first C's second
// harmonic and there is nothing in a single frame to tell them apart. Taking
// the winner and removing the energy it accounts for is what settles it.
import {
  makeAnalyzer, midiToFreq, RATE, HOP,
  FINE_WINDOW, COARSE_WINDOW, COARSE_RATE, COARSE_CEILING, CROSSOVER_MIDI,
} from './spectrum.js';

export const LOWEST_PITCH = 21;   // A0
export const HIGHEST_PITCH = 108; // C8
const PITCHES = HIGHEST_PITCH - LOWEST_PITCH + 1;

// What a piano partial series looks like, near enough. Falling roughly as 1/k
// covers both a real instrument and the app's own triangle voice, whose even
// partials are missing entirely — a weight on a partial that is not there costs
// only a little score, and costs it equally to every pitch, so the ranking is
// unaffected.
const HARMONIC_WEIGHTS = [1, 0.5, 0.4, 0.25, 0.2, 0.15];

// How far off a partial may sit and still be that partial. A quarter of a
// semitone covers the window's own smearing and a render tuned a few cents away
// from A440, without reaching far enough to collect the neighbour.
const PARTIAL_TOLERANCE = 0.25;

// How many notes may sound at once before the rest is called noise. Ten fingers,
// but a frame with eight distinct pitches in it is already a chord nobody voiced
// deliberately, and every extra round is another chance to invent a note.
const MAX_VOICES = 8;

// A peak has to be this much of the loudest thing in the piece to be a note at
// all. Below it the peeling would start explaining the noise floor.
const SILENCE_FLOOR = 0.012;

// ...and this much of the loudest thing in its own frame. A quiet note under a
// loud one is real; a whisper under a loud one is that note's leakage.
const VOICE_FLOOR = 0.18;

// How much of what the template predicts to actually take away.
//
// Never all of it. Where two notes an octave apart sound together, the lower
// one's second partial and the upper one's fundamental are the same bins, and
// subtracting the full prediction there removes a note that is really being
// played. Taking most of it settles the octave question without deleting the
// evidence for the octave.
const SUBTRACT_STRENGTH = 0.7;

// Everything above, gathered so a sweep can move it. The defaults are what the
// sweep settled on; nothing here is a guess left in place.
export const TUNING = {
  gateHi: 0.40, gateLo: 0.18, reattack: 0.16,
  voiceFloor: VOICE_FLOOR, subtract: SUBTRACT_STRENGTH,
  minFrames: 4, restrikeLag: 2, presence: 0.6, dip: 0.75,
};

// ── Where each pitch's partials live ─────────────────────────────────────────

// Built once: for every pitch, which spectrum to read and which bins hold each
// of its partials. Doing this per frame would be most of the cost of the run.
function buildPitchTable() {
  const table = [];
  const fineBinHz = RATE / FINE_WINDOW;
  const coarseBinHz = COARSE_RATE / COARSE_WINDOW;
  const fineBins = FINE_WINDOW / 2 + 1;
  const coarseBins = COARSE_WINDOW / 2 + 1;

  for (let pitch = LOWEST_PITCH; pitch <= HIGHEST_PITCH; pitch++) {
    const coarse = pitch < CROSSOVER_MIDI;
    const binHz = coarse ? coarseBinHz : fineBinHz;
    const bins = coarse ? coarseBins : fineBins;
    const ceiling = coarse ? COARSE_CEILING : (RATE / 2) * 0.9;
    const f0 = midiToFreq(pitch);

    const partials = [];
    let weightSum = 0;
    for (let h = 0; h < HARMONIC_WEIGHTS.length; h++) {
      const f = f0 * (h + 1);
      if (f > ceiling) break;
      const lo = Math.max(1, Math.round((f * Math.pow(2, -PARTIAL_TOLERANCE / 12)) / binHz));
      const hi = Math.min(bins - 1, Math.round((f * Math.pow(2, PARTIAL_TOLERANCE / 12)) / binHz));
      if (hi < lo) continue;
      partials.push({ lo, hi, weight: HARMONIC_WEIGHTS[h] });
      weightSum += HARMONIC_WEIGHTS[h];
    }
    table.push({ pitch, coarse, partials, weightSum: weightSum || 1 });
  }
  return table;
}

// The loudest bin in a partial's range. A max rather than a sum, because the
// peak is the note and the shoulders are the window; summing would reward a
// pitch for its neighbour's leakage.
function partialEnergy(spec, lo, hi) {
  let best = 0;
  for (let k = lo; k <= hi; k++) if (spec[k] > best) best = spec[k];
  return best;
}

// ── One frame ────────────────────────────────────────────────────────────────

// A pitch is only sounding if something is at its own fundamental.
//
// The score is an average over the partial series, which is what makes it a
// good detector and also what lets a pitch score well on partials it does not
// own. Every note shares its whole series with the note an octave below, so a
// loud C4 hands C3 four of its six partials, and C3 comes back as a chord tone
// nobody played. Peeling is supposed to settle that and cannot: it subtracts
// only after a pitch has won, and the ghost's evidence is what the winner left
// behind.
//
// So the fundamental gets a vote. Not a demand that it dominate — on a real
// piano a low string's first partial is often weaker than its second, which is
// the very thing that had this transcriber hearing a bass F an octave high — but
// a demand that it be there at all, with the score tapering off as it goes
// missing rather than falling off a cliff.
function scorePitch(entry, fine, coarse) {
  const spec = entry.coarse ? coarse : fine;
  if (!entry.partials.length) return 0;
  let acc = 0;
  let f0 = 0;
  for (let i = 0; i < entry.partials.length; i++) {
    const p = entry.partials[i];
    const e = partialEnergy(spec, p.lo, p.hi);
    if (i === 0) f0 = e;
    acc += p.weight * e;
  }
  const score = acc / entry.weightSum;
  const need = score * TUNING.presence;
  return need > 0 && f0 < need ? score * (f0 / need) : score;
}

// How loud this pitch's fundamental actually is. Not the same number as its
// score — the score is an average over partials, and averaging is what makes it
// a good detector — but this is the one to subtract by, because it is what the
// pitch is really putting into the spectrum.
function fundamentalLevel(entry, fine, coarse) {
  if (!entry.partials.length) return 0;
  const spec = entry.coarse ? coarse : fine;
  const p = entry.partials[0];
  return partialEnergy(spec, p.lo, p.hi);
}

// Take away what a pitch accounts for, so the next round scores what is left
// rather than the same energy again. Each partial is reduced by what the
// template says this pitch should be putting there — never below zero, so two
// notes sharing a partial leave the second one's share behind.
//
// Subtracting the score instead of the fundamental takes away well under half
// of what the note contributed, and the leftovers are enough for the octave
// below to win a later round on the strength of its second partial. Which is
// the exact error peeling exists to prevent.
function subtractPitch(entry, fine, coarse, level) {
  const spec = entry.coarse ? coarse : fine;
  for (const p of entry.partials) {
    const predicted = level * p.weight * TUNING.subtract;
    for (let k = p.lo; k <= p.hi; k++) {
      spec[k] = Math.max(0, spec[k] - predicted);
    }
  }
}

// ── The salience surface ─────────────────────────────────────────────────────

// For every frame, how strongly each pitch is sounding. This is the only thing
// held for the whole piece: eighty-eight floats a frame, against the thousands
// a spectrum would need.
export function computeSalience(pcm, onProgress) {
  const analyzer = makeAnalyzer(pcm);
  const table = buildPitchTable();
  const frames = analyzer.frames;
  const salience = new Float32Array(frames * PITCHES);
  const scores = new Float32Array(PITCHES);

  for (let f = 0; f < frames; f++) {
    const { fine, coarse } = analyzer.at(f);
    const base = f * PITCHES;

    let loudest = 0;
    for (let v = 0; v < MAX_VOICES; v++) {
      let best = -1;
      let bestScore = 0;
      for (let i = 0; i < PITCHES; i++) {
        const s = scorePitch(table[i], fine, coarse);
        scores[i] = s;
        if (s > bestScore) { bestScore = s; best = i; }
      }
      if (best < 0 || bestScore <= 0) break;
      // Stop once what is left is a shadow of the loudest thing in the frame.
      // Without this the rounds keep going until MAX_VOICES is used up and the
      // last few are peeling the leakage off the ones that already won.
      if (v === 0) loudest = bestScore;
      else if (bestScore < loudest * TUNING.voiceFloor) break;
      // Keep the strongest reading of each pitch: a later round can only see
      // what earlier ones left, and that is not what the pitch was doing.
      if (bestScore > salience[base + best]) salience[base + best] = bestScore;
      subtractPitch(table[best], fine, coarse, fundamentalLevel(table[best], fine, coarse));
    }

    if (onProgress && (f & 63) === 0) onProgress(f / frames);
  }

  return { salience, frames, pitches: PITCHES, analyzer };
}

// ── Salience into notes ──────────────────────────────────────────────────────

// A note is on above the high threshold and stays on until it falls below the
// low one. One threshold would chatter a note into a dozen where the level
// happens to sit on it.


const MAX_GAP_FRAMES = 1;    // a single frame's dip is the envelope, not a rest

// How long a strike takes to show up is the same half-window ramp an onset
// climbs, because a note struck again is an onset that happens to land on a
// pitch that was already sounding. Comparing against the frame before misses it
// entirely — the rise is real, but spread across the ramp it is a fraction of
// its size in any one frame, and a threshold able to see that fraction splits
// every held note in the piece. `rampFrames` below has the length, which is not
// the same for both bands.

// Where in the frame the note actually started.
//
// A frame is named for the centre of a window reaching 93 ms either side, so a
// note starting at T first shows up in the frame named T minus 93 and is only
// fully in view at T plus 93. In between, the energy in the window is the
// fraction of it that comes after T — which rises in a straight line and passes
// half way exactly at T.
//
// So the onset is not where the gate opened, which is wherever the threshold
// happens to sit on that ramp and is always early. It is where the level first
// reached half of what the note settles at, and that can be read off the ramp
// itself without a fudge factor.
const PLATEAU_LOOKAHEAD = 10;   // ~230 ms, long enough to see the note settle

// How far back the half-way point may be looked for. The ramp is half a window
// long, so a few frames is generous — and a bound is essential, because a note
// struck again while the last one is still ringing never drops below half, and
// an unbounded search walks back through it to the start of the piece.
const BACKTRACK_LIMIT = 5;

// How many frames a note takes to come into view, which is not one number.
//
// Everything about reading an attack — how far back the half-way point can be,
// how long to wait for the level to settle, how wide a rise has to be measured
// to mean a second strike — is a fraction of the window that saw it. The bass
// is analysed through a 743 ms window against the treble's 186, so its notes
// ramp up over four times as many frames.
//
// Using the treble's figure for both is what split every bass note in two: a
// rise measured across four frames, a third of the way up a sixteen-frame ramp,
// is indistinguishable from the same note being struck again.
const FRAME_MS = (HOP / RATE) * 1000;
const FINE_RAMP = Math.round((FINE_WINDOW / RATE) * 500 / FRAME_MS);
const COARSE_RAMP = Math.round((COARSE_WINDOW / COARSE_RATE) * 500 / FRAME_MS);

function rampFrames(pitch) {
  return pitch < CROSSOVER_MIDI ? COARSE_RAMP : FINE_RAMP;
}

function onsetFrame(salience, frames, pitches, p, gateFrame, ramp) {
  let plateau = 0;
  const until = Math.min(frames, gateFrame + Math.max(PLATEAU_LOOKAHEAD, ramp + 2));
  for (let f = gateFrame; f < until; f++) {
    const v = salience[f * pitches + p];
    if (v > plateau) plateau = v;
  }
  const half = plateau / 2;
  // Back up to before the gate opened: on a slow ramp the half-way point can be
  // a frame or two behind the threshold crossing
  let f = gateFrame;
  const floor = Math.max(0, gateFrame - Math.max(BACKTRACK_LIMIT, ramp));
  while (f > floor && salience[(f - 1) * pitches + p] >= half) f--;
  // ...and forward, for the usual case where the gate opened below half
  while (f < until && salience[f * pitches + p] < half) f++;
  return f;
}

// `frameMs` is the step between frames; `originMs` is where frame zero actually
// sits in the recording, which is the middle of its window rather than its
// start. Leaving that out reports every onset most of a window early.
export function tracksToNotes(salience, frames, pitches, frameMs, reference, originMs = 0) {
  const onsetOf = (p, gateFrame, ramp) => onsetFrame(salience, frames, pitches, p, gateFrame, ramp);
  const hi = reference * TUNING.gateHi;
  const lo = reference * TUNING.gateLo;
  const jump = reference * TUNING.reattack;
  const notes = [];
  let id = 0;

  for (let p = 0; p < pitches; p++) {
    const ramp = rampFrames(p + LOWEST_PITCH);
    let start = -1;
    let peak = 0;
    let trough = 0;
    let quiet = 0;
    // Whether this segment began from silence or from the note being struck
    // again while it was still sounding. The two need different answers about
    // when they started, and giving them the same one is what made every split
    // land a hundred milliseconds early.
    let restruck = false;

    const close = (endFrame) => {
      if (start < 0) return;
      const length = endFrame - start;
      if (length >= TUNING.minFrames) {
        // Reading a ramp's half-way point only works where there is a ramp. A
        // note struck again never drops below half of anything, so the search
        // walks back as far as it is allowed and reports the strike early by
        // exactly that. Here the strike itself is the best evidence there is.
        const began = restruck ? Math.max(0, start - TUNING.restrikeLag) : onsetOf(p, start, ramp);
        notes.push({
          id: `tr-${id++}`,
          pitch: p + LOWEST_PITCH,
          startTime: Math.max(0, began * frameMs + originMs),
          duration: Math.max(frameMs, (endFrame - began) * frameMs),
          velocity: Math.max(1, Math.min(127, Math.round(20 + 107 * Math.min(1, peak / (reference * 0.6))))),
        });
      }
      start = -1;
      peak = 0;
    };

    for (let f = 0; f < frames; f++) {
      const v = salience[f * pitches + p];
      const prev = f > 0 ? salience[(f - 1) * pitches + p] : 0;

      if (start < 0) {
        if (v >= hi) { start = f; peak = v; trough = v; quiet = 0; restruck = false; }
        continue;
      }

      // Struck again without ever stopping — which is most of what a repeated
      // note in a held chord looks like, since the gate never gets a chance to
      // close.
      //
      // What makes it a second strike is that the level fell and came back. A
      // rise on its own is not enough and was the whole trouble: a note's first
      // attack is a rise too, and measuring it across any fixed span reads as a
      // strike partway up. That span was half the treble's window, and the bass
      // is heard through a window four times longer, so every bass note climbed
      // for long enough to be caught rising and was cut in two.
      //
      // Against the trough since the peak rather than a fixed number of frames
      // back, so the climb itself never qualifies — while it is climbing, the
      // trough climbs with it — and a note that decays and is struck again does,
      // however long its instrument takes to speak.
      const again = v >= hi && v >= prev
                    && (v - trough) >= jump && (peak - trough) >= jump * TUNING.dip;
      if (again && f - start >= TUNING.minFrames) {
        close(f); start = f; peak = v; trough = v; quiet = 0; restruck = true; continue;
      }

      if (v < lo) {
        quiet++;
        if (quiet > MAX_GAP_FRAMES) { close(f - quiet + 1); quiet = 0; }
      } else {
        quiet = 0;
        if (v > peak) { peak = v; trough = v; }
        else if (v < trough) trough = v;
      }
    }
    close(frames);
  }

  return notes.sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
}

// What counts as loud, for this recording. A high percentile rather than the
// maximum, so one clipped chord does not set the scale for the whole piece.
export function referenceLevel(salience) {
  const sample = [];
  const stride = Math.max(1, Math.floor(salience.length / 40000));
  for (let i = 0; i < salience.length; i += stride) if (salience[i] > 0) sample.push(salience[i]);
  if (!sample.length) return 0;
  sample.sort((a, b) => a - b);
  return sample[Math.floor(sample.length * 0.98)];
}

// ── The whole of it ──────────────────────────────────────────────────────────

export function transcribe(pcm, { onProgress } = {}) {
  const { salience, frames, pitches, analyzer } = computeSalience(pcm, onProgress);
  const frameMs = (HOP / RATE) * 1000;
  const reference = referenceLevel(salience);
  if (!reference || reference < SILENCE_FLOOR * 0.001) {
    return { notes: [], frames, reference: 0 };
  }
  const originMs = analyzer.frameTimeMs(0);
  const notes = tracksToNotes(salience, frames, pitches, frameMs, reference, originMs);
  return { notes, frames, frameMs, reference, salience, pitches, analyzer };
}
