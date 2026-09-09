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
//
// It settles it for a rendering. It does not settle it for a piano, and that
// is the largest known fault here. A recorded low F was measured with its
// second partial at twice its own fundamental, so at the moment it is struck
// the F an octave above scores higher than it does — every one of that upper
// F's partials is one of this one's even partials, it has no evidence of its
// own anywhere, and it still wins the round and is written down. The reported
// symptom is notes shown as struck together that were played one after
// another: a bass F and a treble A are held, a treble F joins a second and a
// half later, and the score shows all three at the downbeat.
//
// Three fixes were built and measured against that recording and none worked.
// Subtracting what is observed at each partial rather than what the template
// predicts: no effect on the ghost, and it cost the genuine-octave test.
// Preferring the pitch an octave below when it has support at its own
// fundamental, so the real note is peeled first: same. Both together, across
// sixteen combinations: same. The measured reason is in the salience — at that
// instant the ghost stands at twice the gate level, and the real entries of
// the same note a second later peak lower than it does. No threshold separates
// them because the ghost is the stronger signal.
//
// What is left is not a threshold. For an exact octave every partial of the
// upper note lies on an even partial of the lower, so a single frame holds no
// evidence that could tell a real octave from an invented one; only the shape
// of a particular instrument's partial envelope, or the two notes decaying at
// their own rates over time, can. Both are a different design from this one.
// The synthetic octave test does not catch any of it, because the app's own
// voice has no even partials at all and so never creates the ambiguity.
import { buildSupport, spectrogram, factorise } from './nmf.js';
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

// Two onsets this close are one instant, as far as anything about octaves is
// concerned — the analysis hop is 23 ms, so a doubled onset lands one or two
// frames apart rather than exactly together.
const TOGETHER_MS = 60;
// Atoms either side of the pitches in question, so a factorisation asked about
// one octave is not blind to what is sounding beside it
const OCTAVE_ATOM_MARGIN = 12;

// How many rounds of peeling a frame gets.
//
// This was eight, for a reason that sounded right and measured wrong: ten
// fingers, and a frame with eight distinct pitches in it is already a chord
// nobody voiced deliberately. But the rounds are not notes. Nothing stops a
// pitch winning twice — subtraction takes away 0.7 of what the template
// predicts, so a loud note is still standing afterwards — and a frame under the
// pedal holds everything struck in the last few seconds, not just what ten
// fingers are on.
//
// Measured, the budget was almost never what stopped the peeling: across the
// three rendered files, between none and five percent of frames ever reached
// eight rounds. `voiceFloor` is the guard that actually binds, and it is the
// right one, because it asks what a candidate is worth against the loudest
// thing beside it rather than counting. The count only ever bit in the densest
// frames in the music — which is exactly where the notes being missed are.
//
// Raised to sixteen, the rendered set goes 0.8624 to 0.8694 and bass recall
// 0.303 to 0.338, for sixty milliseconds on a twenty-five second file. Twenty-
// four is worse than sixteen: past the point where `voiceFloor` stops it, more
// rounds only add ghosts.
const MAX_VOICES = 16;

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
  // What a doubled note has to be carrying, over the octave below it, to be
  // believed. Swept on the fixture: below this the invented notes go and the
  // played octaves stay.
  octaveShare: 1.0, nmfIterations: 24, nmfSettle: 8, nmfStride: 3,
  voiceFloor: VOICE_FLOOR, subtract: SUBTRACT_STRENGTH, maxVoices: MAX_VOICES,
  minFrames: 4, restrikeLag: 2, presence: 0.6, dip: 0.75, restrikeSpan: 4,
  reattackFloor: 0.14,
  // How much more a bass re-strike has to move than a treble one. Its timing
  // comes from partials it shares with whatever is playing above it, so the
  // evidence is noisier — see `buildAttackTable`
  bassReattack: 1,
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

// ── Where a bass note is struck ──────────────────────────────────────────────
//
// A repeated note is found by the level falling between the strikes and coming
// back. Below the crossover that cannot work, and no threshold can make it:
// those pitches are heard through a 743 ms window, so two strikes closer
// together than that are both inside the window at once and the level between
// them never falls at all.
//
// Measured, C3 struck six times with nothing else sounding. Recall against the
// gap between strikes:
//
//   gap        200   300   400   500   600   750   900  1100  1400
//   MIDI 48    17%   17%   17%   17%   17%   17%  100%  100%  100%
//   MIDI 72   100%  100%  100%  100%  100%  100%  100%  100%  100%
//
// 17% is one strike in six — the first one. The cliff sits exactly at the
// window length, and above the crossover, where the window is 186 ms, there is
// no problem to solve.
//
// But the note's own upper partials are not down there. C3 is 131 Hz and its
// second partial is 262 Hz, well above the crossover, in the fine spectrum
// where the window is 186 ms. Between those same six strikes, the level at
// partials 2-5 falls 42% every time where the coarse salience falls 1% — nearly
// six times deeper, and consistent rather than collapsing after the first
// strike. The evidence was never missing; it was being read in the one band
// that cannot see it.
//
// So a bass pitch gets a second envelope, built from its partials in the fine
// spectrum, and the re-strike test reads that instead. Only the timing comes
// from it. Whether the pitch is sounding at all is still the salience's
// question, because the fundamental is the thing that says a note is that note
// rather than the octave below it.
//
// Which partials: everything from the second up to the eighth that lands above
// the crossover frequency. Below that the fine spectrum's 5.4 Hz bins cannot
// keep a partial apart from its neighbour a semitone away, and including one
// there would measure the neighbour.
const ATTACK_PARTIALS = 8;
const COARSE_PITCHES = CROSSOVER_MIDI - LOWEST_PITCH;

function buildAttackTable() {
  const binHz = RATE / FINE_WINDOW;
  const bins = FINE_WINDOW / 2 + 1;
  const floor = midiToFreq(CROSSOVER_MIDI);
  const table = [];
  for (let pitch = LOWEST_PITCH; pitch < CROSSOVER_MIDI; pitch++) {
    const f0 = midiToFreq(pitch);
    const ranges = [];
    for (let h = 2; h <= ATTACK_PARTIALS; h++) {
      const f = f0 * h;
      if (f < floor || f > (RATE / 2) * 0.9) continue;
      const lo = Math.max(1, Math.round((f * Math.pow(2, -PARTIAL_TOLERANCE / 12)) / binHz));
      const hi = Math.min(bins - 1, Math.round((f * Math.pow(2, PARTIAL_TOLERANCE / 12)) / binHz));
      if (hi >= lo) ranges.push({ lo, hi });
    }
    table.push(ranges);
  }
  return table;
}


// How the partials are combined into one number.
//
// Summing them treats a note landing on one partial as if this note had been
// struck: the sixth partial of C2 is 392 Hz, which is G4. Taking the middle one
// instead is robust to that — a re-strike lifts every partial of the note at
// once, and a colliding note lifts one.

// ── The salience surface ─────────────────────────────────────────────────────

// For every frame, how strongly each pitch is sounding. This is the only thing
// held for the whole piece: eighty-eight floats a frame, against the thousands
// a spectrum would need.
export function computeSalience(pcm, onProgress) {
  const analyzer = makeAnalyzer(pcm);
  const table = buildPitchTable();
  const attackTable = buildAttackTable();
  const frames = analyzer.frames;
  const salience = new Float32Array(frames * PITCHES);
  // Only the pitches below the crossover need one, so this is a little under
  // half the size of the salience surface rather than another copy of it
  const attack = new Float32Array(frames * COARSE_PITCHES);
  const scores = new Float32Array(PITCHES);
  const buf = new Float64Array(ATTACK_PARTIALS + 1);
  const levels = new Float64Array(COARSE_PITCHES * (ATTACK_PARTIALS + 1));

  for (let f = 0; f < frames; f++) {
    const { fine, coarse } = analyzer.at(f);
    const base = f * PITCHES;
    // The levels come from the spectrum before anything is peeled out of it,
    // which is what actually arrived at each partial
    for (let i = 0; i < COARSE_PITCHES; i++) {
      const ranges = attackTable[i];
      const at = i * (ATTACK_PARTIALS + 1);
      for (let h = 0; h < ranges.length; h++) {
        const r = ranges[h];
        let best = 0;
        for (let k = r.lo; k <= r.hi; k++) if (fine[k] > best) best = fine[k];
        levels[at + h] = best;
      }
    }


    let loudest = 0;
    for (let v = 0; v < TUNING.maxVoices; v++) {
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

    // Read AFTER the peeling, from what it left behind.
    //
    // A bass note's upper partials are not private to it: the sixth partial of
    // C2 is 392 Hz, which is also G4, so a right hand playing G4 makes the bass
    // note look struck again. Measured, that split one held bass note into as
    // many as five.
    //
    // Peeling is what settles it, and it settles it for free. A pitch below the
    // crossover subtracts from the COARSE spectrum only — `subtractPitch` picks
    // the spectrum from the pitch's own band — so nothing here removes the bass
    // note's own partials. Everything above the crossover subtracts from this
    // one, so the right hand's G4 is taken out of 392 Hz before this reads it.
    // What is left at a bass note's partials is the part of them the peeling
    // could not account for any other way.
    // The middle partial, not the sum of them. A bass note's partials are not
    // private to it — the sixth partial of C2 is 392 Hz, which is G4 — and in
    // tonal music the notes above a bass note sit on its partials by
    // definition. A real re-strike lifts every partial of the note at once; a
    // note landing on one lifts one, and the middle of the distribution does
    // not move. Summing them instead split a held bass note into five.
    const aBase = f * COARSE_PITCHES;
    for (let i = 0; i < COARSE_PITCHES; i++) {
      const n = attackTable[i].length;
      const at = i * (ATTACK_PARTIALS + 1);
      for (let h = 0; h < n; h++) buf[h] = levels[at + h];
      const slice = Array.prototype.slice.call(buf, 0, n).sort((a, b) => a - b);
      attack[aBase + i] = n ? slice[n >> 1] : 0;
    }

    if (onProgress && (f & 63) === 0) onProgress(f / frames);
  }

  // The attack envelope is in the fine spectrum's units and the salience is an
  // average over a weighted partial series, so the two do not share a scale.
  // Rather than give the re-strike test a second set of thresholds, each bass
  // pitch's envelope is scaled to its own salience: same peak, same units, and
  // every constant that was swept against the salience still means what it
  // meant. A pitch that never sounds is left at zero, where the gate keeps it.
  for (let i = 0; i < COARSE_PITCHES; i++) {
    let sPeak = 0, aPeak = 0;
    for (let f = 0; f < frames; f++) {
      const sv = salience[f * PITCHES + i];
      const av = attack[f * COARSE_PITCHES + i];
      if (sv > sPeak) sPeak = sv;
      if (av > aPeak) aPeak = av;
    }
    if (!(aPeak > 0) || !(sPeak > 0)) continue;
    const k = sPeak / aPeak;
    for (let f = 0; f < frames; f++) attack[f * COARSE_PITCHES + i] *= k;
  }

  return { salience, attack, frames, pitches: PITCHES, analyzer };
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

// How far back to look for the rise that dates a second strike. Half the fine
// window, and the same for both bands: this is not asking how long a note takes
// to speak, it is asking when the level turned upward, and that moment is the
// strike whichever band heard it.


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
export function tracksToNotes(salience, frames, pitches, frameMs, reference, originMs = 0, attack = null) {
  const onsetOf = (p, gateFrame, ramp) => onsetFrame(salience, frames, pitches, p, gateFrame, ramp);
  const hi = reference * TUNING.gateHi;
  const lo = reference * TUNING.gateLo;
  const jump = reference * TUNING.reattackFloor;
  const notes = [];
  let id = 0;

  for (let p = 0; p < pitches; p++) {
    const pitch = p + LOWEST_PITCH;
    const ramp = rampFrames(pitch);
    // Which envelope times a second strike. Above the crossover the salience is
    // the only thing there is and this is the identity; below it, the note's own
    // upper partials, which are heard through a window four times shorter — see
    // `buildAttackTable`. Scaled to the salience, so every constant below still
    // means what it meant.
    const timing = (attack && pitch < CROSSOVER_MIDI)
      ? (f) => attack[f * COARSE_PITCHES + p]
      : (f) => salience[f * pitches + p];
    let start = -1;
    let peak = 0;      // of the timing envelope, which is what `bar` is measured on
    let trough = 0;
    let loudest = 0;   // ...and of the salience, which is what velocity is read from
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
          pitch,
          startTime: Math.max(0, began * frameMs + originMs),
          duration: Math.max(frameMs, (endFrame - began) * frameMs),
          velocity: Math.max(1, Math.min(127, Math.round(20 + 107 * Math.min(1, loudest / (reference * 0.6))))),
        });
      }
      start = -1;
      peak = 0;
      loudest = 0;
    };

    for (let f = 0; f < frames; f++) {
      const v = salience[f * pitches + p];

      if (start < 0) {
        if (v >= hi) {
          start = f; quiet = 0; restruck = false;
          peak = trough = timing(f);
          loudest = v;
        }
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
      // Two conditions, and each rules out a different mistake. Against the
      // trough since the peak, so a first attack never qualifies — while it
      // climbs the trough climbs with it — which is what stopped every bass
      // note being cut in two partway up its own long ramp. And across a fixed
      // span as well, which is what says *when*: the trough condition is
      // satisfied the moment the level clears its low point, and a note struck
      // again does not start there. Timed by the trough alone, every re-strike
      // was reported early enough to miss the note it belonged to.
      const e = timing(f);
      const ePrev = f > 0 ? timing(f - 1) : 0;
      const back = timing(Math.max(0, f - TUNING.restrikeSpan));
      // How big the rise has to be: a proportion of this note's own peak, or an
      // absolute share of the recording's loudest, whichever is larger.
      //
      // The floor is what quiet notes are held to, and the proportion only
      // binds above about seven eighths of the reference — so in practice this
      // asks more of loud notes than of quiet ones, and that asymmetry is the
      // point. A loud note's sustain wanders by more in absolute terms than a
      // quiet note's does, so a single absolute bar is simultaneously too tight
      // to let a quiet inner voice be struck again and too loose to stop a loud
      // one wobbling into two. Scaling the bar with the note stops the second
      // without giving up the first.
      const bar = Math.max(peak * TUNING.reattack, jump)
                  * (pitch < CROSSOVER_MIDI ? TUNING.bassReattack : 1);
      // Whether the pitch is sounding is the salience's question — the
      // fundamental is what says this note rather than the octave below it.
      // Whether it was struck again is the timing envelope's.
      const again = v >= hi && e >= ePrev
                    && (e - trough) >= bar && (peak - trough) >= bar * TUNING.dip
                    && (e - back) >= bar;
      if (again && f - start >= TUNING.minFrames) {
        close(f); start = f; peak = trough = e; loudest = v; quiet = 0; restruck = true; continue;
      }

      if (v < lo) {
        quiet++;
        if (quiet > MAX_GAP_FRAMES) { close(f - quiet + 1); quiet = 0; }
      } else {
        quiet = 0;
        if (v > loudest) loudest = v;
        if (e > peak) { peak = e; trough = e; }
        else if (e < trough) trough = e;
      }
    }
    close(frames);
  }

  return notes.sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
}

// What counts as loud, for this recording. A high percentile rather than the
// maximum, so one clipped chord does not set the scale for the whole piece.
//
// One number for the whole recording is a real limitation and not an oversight.
// A bass line under a melody was measured sitting at a third of this level for
// half a minute — plainly audible, a full harmonic series, verified in the
// samples — and never reached the four tenths that opens the gate, so not one
// of its notes was written down.
//
// Letting the level follow the music was tried: a four-second running mean of
// the loudest thing per frame, floored at a fraction of this. It finds those
// notes and costs more than they are worth. Swept from a tenth to none, it
// moved unexplained energy in a real recording by half a point while taking
// chroma, onset agreement and round-trip agreement all down with it, and the
// rendered test set fell from 0.90 to 0.88. The gate is not what should be
// adapting — a threshold that chases the music finds notes in whatever the
// music is quiet enough to leave behind.
// ── The octave veto ──────────────────────────────────────────────────────────
//
// A note that begins at the same instant as the octave below it is the one
// shape this transcriber invents, and the peeling cannot tell an invented one
// from a played one — see the measurements in nmf.js. So where that shape
// appears, and only there, a second opinion is asked for: the recording is
// factorised against a dictionary learned from itself, and the doubled note is
// kept only if it is carrying its own weight over the note below it.
//
// Asked for only where it is needed. A piece with no doubled onsets in it never
// pays for the factorisation, and on one that has them it is the difference
// between ten invented notes and none.
export function vetoOctaveGhosts(notes, pcm) {
  if (!(TUNING.octaveShare > 0)) return notes;   // switched off, and free
  const doubles = notes.filter(n => octaveBelow(notes, n));
  if (!doubles.length) return notes;

  // Only the pitches in question and the octave under them need atoms
  const wanted = new Set();
  for (const n of doubles) { wanted.add(n.pitch); wanted.add(n.pitch - 12); }
  const lowest = Math.max(LOWEST_PITCH, Math.min(...wanted) - OCTAVE_ATOM_MARGIN);
  const highest = Math.min(HIGHEST_PITCH, Math.max(...wanted) + OCTAVE_ATOM_MARGIN);

  const { V, frames, bins } = spectrogram(pcm);
  const atoms = buildSupport(lowest, highest);
  const H = factorise(V, frames, bins, atoms, {
    iterations: TUNING.nmfIterations, settle: TUNING.nmfSettle, stride: TUNING.nmfStride,
  });
  const frameMs = (HOP / RATE) * 1000;
  const level = (ms, pitch) => {
    const k = pitch - lowest;
    if (k < 0 || k >= atoms.length) return 0;
    const f = Math.min(frames - 1, Math.max(0, Math.round(ms / frameMs)));
    return H[f * atoms.length + k];
  };

  return notes.filter(n => {
    const low = octaveBelow(notes, n);
    if (!low) return true;
    const share = level(n.startTime, n.pitch) / (level(n.startTime, n.pitch - 12) + 1e-12);
    return share >= TUNING.octaveShare;
  });
}

// The note an octave under this one, beginning at what is the same moment as
// far as an onset is concerned
function octaveBelow(notes, note) {
  return notes.find(l => l.pitch === note.pitch - 12
    && l.startTime <= note.startTime
    && note.startTime - l.startTime <= TOGETHER_MS) || null;
}

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
  const { salience, attack, frames, pitches, analyzer } = computeSalience(pcm, onProgress);
  const frameMs = (HOP / RATE) * 1000;
  const reference = referenceLevel(salience);
  if (!reference || reference < SILENCE_FLOOR * 0.001) {
    return { notes: [], frames, reference: 0 };
  }
  const originMs = analyzer.frameTimeMs(0);
  const notes = vetoOctaveGhosts(
    tracksToNotes(salience, frames, pitches, frameMs, reference, originMs, attack), pcm);
  return { notes, frames, frameMs, reference, salience, pitches, analyzer };
}
