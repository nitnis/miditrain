// How fast is it, and where is beat one?
//
// The transcriber gives notes in milliseconds, which is enough to play back but
// not enough to write down. Everything the app does with notation — the grid it
// snaps to, the triplets it brackets, the swing it marks — is a function of the
// notes and a tempo, so finding the tempo is the whole of what stands between a
// list of onsets and a score.
//
// Two questions, answered in that order: how long is a beat, and where does one
// land. Neither needs the audio again; the attacks alone carry it.

// The range worth searching. Slower than 40 and the beat stops being something
// anyone taps; faster than 200 and what is being measured is the subdivision.
const MIN_BPM = 40;
const MAX_BPM = 200;

// How close an onset has to sit to a beat line to be counted as on it, as a
// fraction of the beat. A tenth is about the looseness of a rendered file's
// own quantisation plus the transcriber's own twenty milliseconds of error.
const ON_BEAT = 0.12;

// Distinct attack moments. A chord is one event however many notes are in it,
// and counting it as five would let thick writing outvote the rhythm.
export function attackTimes(notes, groupMs = 45) {
  const times = [...new Set(notes.map(n => Math.round(n.startTime)))].sort((a, b) => a - b);
  const out = [];
  for (const t of times) {
    if (!out.length || t - out[out.length - 1] > groupMs) out.push(t);
  }
  return out;
}

// How well a given beat length explains the attacks, at its best phase.
//
// Scored on how near each attack sits to the nearest beat line rather than on
// how many land exactly, so a period that is slightly wrong is penalised
// smoothly instead of falling off a cliff — which is what lets the search find
// the bottom of the valley rather than a point beside it.
function fitPeriod(attacks, periodMs, phases = 24) {
  let best = { score: -Infinity, phase: 0, hits: 0 };
  for (let i = 0; i < phases; i++) {
    const phase = (i / phases) * periodMs;
    let score = 0;
    let hits = 0;
    for (const t of attacks) {
      const off = Math.abs(((t - phase) % periodMs + periodMs) % periodMs);
      const dist = Math.min(off, periodMs - off) / periodMs;
      if (dist <= ON_BEAT) { score += 1 - dist / ON_BEAT; hits++; }
    }
    if (score > best.score) best = { score, phase, hits };
  }
  return { ...best, ...beatEvidence(attacks, periodMs, best.phase, best.hits) };
}

// Two things about a candidate that its score cannot say.
//
// `between` is how much happens halfway between the beats, per beat that has
// something on it. This is what tells a beat from a subdivision. A candidate at
// twice the true tempo explains the attacks beautifully — it drew its beat
// lines through the eighth notes, so every line has something on it — but it
// leaves nothing in between, because there is nothing left to be in between.
// The right level keeps its own subdivision underneath it.
//
// `coverage` is the fraction of the candidate's own beat lines that have
// anything on them at all. The score counts attacks near lines, so a candidate
// drawing twice as many lines collects twice as much even when half of them are
// empty — and a candidate at one and a half times the true tempo does exactly
// that, catching every other attack at precisely its halfway point. It looks
// beautifully subdivided and is an artefact. Measured, those impostors cover
// about a third of their own lines where a real reading covers two thirds or
// more; a pulse you could count along with keeps having something on it.
// Attacks arrive sorted, so the beat a given one falls on never goes backwards
// and counting the distinct ones needs only the previous — which keeps this
// allocation-free across the six hundred odd candidates it runs on.
function beatEvidence(attacks, periodMs, phase, hits) {
  if (!hits) return { between: 0, coverage: 0 };
  const span = attacks[attacks.length - 1] - attacks[0];
  const lines = Math.max(1, Math.round(span / periodMs));
  let filled = 0;
  let last = NaN;
  let between = 0;
  for (const t of attacks) {
    const beat = (t - phase) / periodMs;
    const rel = beat - Math.floor(beat);
    if (Math.min(rel, 1 - rel) <= ON_BEAT) {
      const line = Math.round(beat);
      if (line !== last) { filled++; last = line; }
    } else if (Math.abs(rel - 0.5) <= ON_BEAT) between++;
  }
  return {
    between: Math.min(1, between / hits),
    coverage: Math.min(1, filled / lines),
  };
}

// A tempo twice the right one explains the attacks at least as well as the
// right one does — every beat line it draws has an attack near it, because it
// draws twice as many. Two things weigh against it.
//
// The first is where the pulse feels comfortable: scores are weighted by how
// far the candidate sits from a walking tempo, on a log scale because tempo is
// heard in ratios. On its own this is a blunt instrument. It has to be wide
// enough not to drag a Mozart rondo down to two thirds of its tempo, and that
// width is far too wide to stop a 6/8 andante being read at its eighth note.
//
// The second is what `beatEvidence` measures, and it is the one that actually
// decides these cases: the doubled reading has nothing between its beats. It
// spent the subdivision on its beat lines, so there is none left underneath.
// Weighted by that, the 6/8 andante of K331 comes out at its written 64 rather
// than at its eighth note, and a bare stream of eighths comes out at its beat
// rather than its subdivision — neither of which the prior could manage at any
// width, having been swept over all of them.
//
// Charging for attacks that land *anywhere* between beats was tried first, on
// the theory that it would tell a beat from a slower pulse containing some of
// the same attacks. It scored no better at any width. Rewarding attacks at the
// halfway point specifically — the level below, rather than everything off the
// grid — is what works.
const PREFERRED_BPM = 100;
export const PRIOR_WIDTH = { octaves: 1.0 };

function tempoPrior(bpm) {
  const away = Math.log2(bpm / PREFERRED_BPM) / PRIOR_WIDTH.octaves;
  return Math.exp(-0.5 * away * away);
}

// How much having a level below is worth, and it is a narrow window rather than
// a setting with room to spare. Too little and the andante stays at its eighth
// note; too much and a plain stream of quarters gets halved, because a reading
// at half speed always has every other note sitting exactly between its beats
// and starts collecting this reward for it.
//
// It was one while the beats were a rigid grid. Tracking moved it: a tracker
// that can follow the music helps the wrong finer-grained reading more than the
// right one, because more beats means more chances to settle onto an onset, so
// the subdivision has to be worth more to hold the balance. Re-swept across the
// whole test set — synthetic shapes and real piano together, with the room and
// the noise seeded so the sweep measured the parameter and not the dice — the
// plateau runs from about 2.8 to 3.2 and this is the middle of it.
//
// Every piece of real music in the set is read correctly there. What is given
// up is the featureless end: a stream of identical quarter notes with nothing
// between them reads an octave slow, because such a stream genuinely has no
// answer — whether those are quarters or eighths is a question about music that
// was never played. Lower settings buy one of those back and cost a rondo read
// at four thirds of its speed, which is the worse failure by far: an octave is
// one press of the double button in the review step, and four thirds is
// nothing a user can straighten out.
export const SUBDIVISION_WEIGHT = { k: 3 };

// ── Following a tempo that moves ─────────────────────────────────────────────

// Nobody plays to a click, and a single beat length laid over a whole
// performance is wrong before the second bar. Worse, it fails in a particular
// direction: a rigid grid at the true tempo drifts out of step with the
// playing, while a grid at half that tempo has twice the tolerance and stays in
// step long enough to score better. So rubato does not merely blur the answer,
// it argues for the wrong one. Measured on a rondo with a little push and pull,
// the rigid search read it at half speed and did so confidently.
//
// The fix is to stop asking where a fixed ruler lands and start asking where a
// tapping foot would go — a beat sequence that prefers to sit on attacks and
// prefers not to change speed abruptly, with the balance between those two
// wishes settled by dynamic programming over every sequence at once. This is
// the Ellis beat-tracking recurrence, over discrete attacks rather than an
// onset envelope, because by this point the notes are already known.

const GRID_MS = 10;             // how finely a beat may be placed
const BEAT_TOL_MS = 70;         // how near an attack has to be to reward a beat

// What it costs to change speed, against a reward of at most one per beat for
// landing on an attack. A tenth of a beat's worth for a five percent change,
// half a beat's for ten — loose enough to follow a performance, tight enough
// that the tracker will not chase every stray note.
export const TRANSITION_WEIGHT = { w: 60 };

// The reward for putting a beat at each moment: how near the nearest attack is.
function onsetCurve(attacks, startMs, cells) {
  const curve = new Float32Array(cells);
  const span = Math.ceil(BEAT_TOL_MS / GRID_MS);
  for (const t of attacks) {
    const c = Math.round((t - startMs) / GRID_MS);
    for (let d = -span; d <= span; d++) {
      const i = c + d;
      if (i < 0 || i >= cells) continue;
      const v = 1 - Math.abs(d * GRID_MS) / BEAT_TOL_MS;
      if (v > curve[i]) curve[i] = v;
    }
  }
  return curve;
}

// The best beat sequence at roughly this speed, allowed to drift.
//
// Every cell holds the score of the best sequence ending there, so one pass
// forward considers every sequence there is and one walk back recovers the
// winner. The interval may stretch from six tenths of the target to one and
// six tenths, which is room for any rubato short of a written change of tempo.
export function trackBeats(attacks, periodMs) {
  const startMs = attacks[0];
  const cells = Math.floor((attacks[attacks.length - 1] - startMs) / GRID_MS) + 1;
  const tau = periodMs / GRID_MS;
  const lo = Math.max(1, Math.round(tau * 0.6));
  const hi = Math.max(lo + 1, Math.round(tau * 1.6));
  if (cells < lo * 2) return [];

  const curve = onsetCurve(attacks, startMs, cells);
  const best = new Float32Array(cells);
  const prev = new Int32Array(cells).fill(-1);
  const w = TRANSITION_WEIGHT.w;

  for (let i = 0; i < cells; i++) {
    // A sequence may simply begin here, which is what the first beat does
    let top = i < hi ? curve[i] : -Infinity;
    let from = -1;
    const near = Math.min(hi, i);
    for (let d = lo; d <= near; d++) {
      const ratio = Math.log(d / tau);
      const v = best[i - d] - w * ratio * ratio;
      if (v > top - curve[i]) { top = v + curve[i]; from = i - d; }
    }
    best[i] = top;
    prev[i] = from;
  }

  // The winner ends somewhere in the final period; a longer sequence always
  // outscores a shorter one, so this is only choosing where to stop
  let end = cells - 1;
  for (let i = Math.max(0, cells - hi); i < cells; i++) if (best[i] > best[end]) end = i;

  const beats = [];
  for (let i = end; i >= 0; i = prev[i]) {
    beats.push(startMs + i * GRID_MS);
    if (prev[i] < 0) break;
  }
  return beats.reverse();
}

// The same three questions as before, asked of beats that bend.
//
// `score` and `coverage` and `between` mean exactly what they meant against a
// rigid grid — this only walks a list of beat times instead of stepping by a
// constant, so a performance that speeds up is no longer punished for it.
function scoreTrackedBeats(attacks, beats) {
  if (beats.length < 4) return null;
  const gaps = [];
  for (let i = 1; i < beats.length; i++) gaps.push(beats[i] - beats[i - 1]);

  let score = 0, hits = 0, filled = 0, between = 0;
  let b = 0;
  let lastFilled = -1;
  for (const t of attacks) {
    while (b < beats.length - 1 && Math.abs(beats[b + 1] - t) <= Math.abs(beats[b] - t)) b++;
    // The beat interval this attack belongs to, for judging distance in beats
    const gap = gaps[Math.min(b, gaps.length - 1)] || 1;
    const dist = Math.abs(t - beats[b]) / gap;
    if (dist <= ON_BEAT) {
      score += 1 - dist / ON_BEAT;
      hits++;
      if (b !== lastFilled) { filled++; lastFilled = b; }
    } else {
      // Halfway to the neighbour it actually sits between
      const side = t > beats[b] ? b : b - 1;
      if (side >= 0 && side < gaps.length) {
        const mid = beats[side] + gaps[side] / 2;
        if (Math.abs(t - mid) / gaps[side] <= ON_BEAT) between++;
      }
    }
  }
  return {
    score, hits,
    coverage: Math.min(1, filled / beats.length),
    between: hits ? Math.min(1, between / hits) : 0,
    periodMs: meanPeriod(beats),
    beats,
  };
}

// The average beat, fitted rather than counted.
//
// Beats are placed on a ten millisecond grid, so any single gap is rounded by
// up to five — which at a brisk tempo is a whole percent, and reporting 117.6
// for a piece at 120 looks like an error even though every beat is in the right
// place. A straight line through beat number against beat time has a slope that
// averages that rounding away over the whole piece, and under rubato it is the
// mean tempo, which is the honest single number to put on a score.
function meanPeriod(beats) {
  const n = beats.length;
  const midIndex = (n - 1) / 2;
  const midTime = beats.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const di = i - midIndex;
    num += di * (beats[i] - midTime);
    den += di * di;
  }
  return den > 0 ? num / den : beats[1] - beats[0];
}

// Which beat lengths are worth tracking.
//
// Tracking is far too expensive to run at all six hundred candidates, and it
// does not need to: the rigid search is a good enough guide to where the peaks
// are, even when it is wrong about which one to believe. Its favourites go in,
// and so do their halves, doubles, thirds and triples — because being wrong by
// exactly one of those is the whole failure mode this is here to survive, and a
// shortlist that only contained the rigid answer would inherit its mistake.
// A whole BPM apart is plenty: this only has to say which hills to climb, and
// the tracker settles the exact tempo afterwards from the beats it places. It
// used to step by a quarter, back when its answer was the answer, and that cost
// four times as much for a precision that is now thrown away.
const SHORTLIST_STEP = 1;

function shortlist(attacks) {
  const rigid = [];
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += SHORTLIST_STEP) {
    const { score, between, coverage } = fitPeriod(attacks, 60000 / bpm);
    rigid.push({ bpm, weighted: Math.max(0, score) * tempoPrior(bpm) * coverage
                                * (1 + SUBDIVISION_WEIGHT.k * between) });
  }
  rigid.sort((a, b) => b.weighted - a.weighted);

  const picks = [];
  const seen = new Set();
  const add = (bpm) => {
    if (bpm < MIN_BPM || bpm > MAX_BPM) return;
    const key = Math.round(bpm * 2);
    if (seen.has(key)) return;
    seen.add(key);
    picks.push(bpm);
  };
  for (const r of rigid.slice(0, 3)) {
    for (const mult of [1, 2, 0.5, 3, 1 / 3]) add(r.bpm * mult);
  }
  return picks;
}

export function detectTempo(notes) {
  const attacks = attackTimes(notes);
  if (attacks.length < 8) return null;

  let best = null;
  for (const bpm of shortlist(attacks)) {
    const fit = scoreTrackedBeats(attacks, trackBeats(attacks, 60000 / bpm));
    if (!fit || fit.score <= 0) continue;
    // Judged at the speed it actually settled on, not the one it was seeded
    // with, since the tracker is free to have found something a little different
    const settled = 60000 / fit.periodMs;
    const weighted = fit.score * tempoPrior(settled) * fit.coverage
                     * (1 + SUBDIVISION_WEIGHT.k * fit.between);
    if (!best || weighted > best.weighted) best = { ...fit, bpm: settled, weighted };
  }
  if (!best) return null;

  // A whole number, and the period that goes with it.
  //
  // A composition carries one integer tempo, so that is the grid the notation
  // will be read against, and it has to be the same grid the notes are written
  // onto. Keeping a fractional period here and letting the caller round the
  // tempo puts the two a hair apart, which over twenty seconds is enough drift
  // to take every note off the grid — and the grid detector answers that by
  // halving the note value until they fit. It showed up as a page of
  // thirty-second notes in a piece that has none.
  const tempo = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(best.bpm)));

  return {
    tempo,
    periodMs: 60000 / tempo,
    offsetMs: best.beats[0],
    attacks: attacks.length,
    // Where the beats actually fell, which is not a constant step apart when
    // the playing was not. Everything downstream that wants to line up with the
    // music should use these rather than counting periods from the offset.
    beats: best.beats,
    // How far to trust the barlines, which is the share of beats that had
    // something on them — not the share of attacks that sat on a beat.
    //
    // The latter was here first and it measures the wrong thing: the more
    // subdivision a piece has, the fewer of its attacks can possibly land on a
    // beat, so it marks down exactly the readings that have most to go on. It
    // called this movement 0.86 while reading it an octave too fast and 0.48
    // once it read it correctly, which is worse than useless in a message to
    // the user. Coverage asks whether the pulse keeps having something on it,
    // which is what someone deciding whether to trust the barlines wants to
    // know, and it does not change with the metrical level.
    confidence: best.coverage,
    onBeatShare: Math.min(1, best.hits / attacks.length),
  };
}

// ── Tidying what was heard ───────────────────────────────────────────────────

// Sliding the whole piece so that beat one sits at zero was tried here and is
// not worth having: a transcription's absolute times are already right, and
// moving them can only take them somewhere else. Measured, it shifted one test
// piece by a beat and a bit and took its F1 from 0.96 to 0.34.
//
// Onsets arrive with about twenty milliseconds of error, which is inaudible but
// is enough to defeat the grid detector: nothing sits close enough to a
// sixteenth for a sixteenth to win, so the notation falls back to 1/32 and the
// score fills with rubbish. Knowing the tempo makes it fixable — the error is
// against a grid that is now known, so it can simply be taken off.
//
// Only where the note is already near a line. A note genuinely between two of
// them is either an ornament or a mistake, and dragging it onto the grid would
// hide which.
export const SNAP_DIVISION = 4;   // sixteenths, as a count per beat
// How near a sixteenth a note has to be to be pulled onto it, as a fraction of
// the step. It has to comfortably exceed the transcriber's own onset error,
// which is about twenty milliseconds: at three tenths that is thirty
// milliseconds at a rondo's tempo, close enough to the error that a good tenth
// of the notes stayed off the grid — and a grid detector that sees a tenth of
// the piece off the sixteenths answers by writing the whole thing in
// thirty-seconds. Four tenths clears the error at both tempos in the set while
// still leaving the middle of the step alone, so an ornament played between two
// sixteenths stays where it was played instead of becoming a wrong one.
export const SNAP = { tolerance: 0.4 };

// Performance time in, metrical time out.
//
// The tracked beats say where the player put each beat; a score says where the
// beats belong. Those are the same thing only for a metronome, so this reads
// every note as a position in beats — interpolating between the beats either
// side of it — and writes it back out against an even beat. A performance that
// pushed and pulled comes out written straight, which is what a score is.
//
// This also has to happen for the notation to work at all. Everything
// downstream measures bars from time zero at a constant tempo, so notes aligned
// to a first beat that landed twenty milliseconds late read as off the grid,
// and the grid detector answers by halving the note value until they fit. That
// showed up as sixteenths where the piece is written in eighths.
//
// Snapping stays conservative: a position already close to a sixteenth is
// pulled onto it, and one that is not keeps the fraction it was played at, so
// an ornament stays an ornament rather than becoming a wrong sixteenth.
export function snapToBeatGrid(notes, fit) {
  if (!fit) return notes;
  const period = fit.periodMs;
  const beats = fit.beats && fit.beats.length >= 2 ? fit.beats : null;
  if (!beats) {
    const step = period / SNAP_DIVISION;
    const tol = step * SNAP.tolerance;
    return notes.map(n => {
      const target = Math.round(n.startTime / step) * step;
      if (Math.abs(target - n.startTime) > tol) return n;
      return { ...n, startTime: Math.max(0, target),
               duration: Math.max(step, n.duration - (target - n.startTime)) };
    });
  }

  const first = beats[0];
  const last = beats[beats.length - 1];
  const headGap = beats[1] - first;
  const tailGap = last - beats[beats.length - 2];
  // Where a time sits in beats, carrying the end tempos on past either end
  const toBeats = (t) => {
    if (t <= first) return (t - first) / headGap;
    if (t >= last) return beats.length - 1 + (t - last) / tailGap;
    let lo = 0, hi = beats.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] <= t) lo = mid; else hi = mid;
    }
    return lo + (t - beats[lo]) / (beats[lo + 1] - beats[lo]);
  };
  const tol = SNAP.tolerance / SNAP_DIVISION;
  const onGrid = (p) => {
    const target = Math.round(p * SNAP_DIVISION) / SNAP_DIVISION;
    return Math.abs(target - p) <= tol ? target : p;
  };

  const mapped = notes.map(n => {
    const start = onGrid(toBeats(n.startTime));
    const end = onGrid(toBeats(n.startTime + n.duration));
    return { n, start, length: Math.max(1 / SNAP_DIVISION, end - start) };
  });

  // A pickup can sit before the first tracked beat. Shifting everything by a
  // whole number of beats keeps the downbeats where they are.
  let shift = 0;
  for (const m of mapped) shift = Math.max(shift, Math.ceil(-m.start));
  return mapped.map(m => ({ ...m.n,
    startTime: (m.start + shift) * period,
    duration: m.length * period }));
}
