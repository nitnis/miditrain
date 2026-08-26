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
  return best;
}

// A tempo twice the right one explains the attacks at least as well as the
// right one does — every beat line it draws has an attack near it, because it
// draws twice as many. Nothing in the timing alone breaks that tie, and for a
// stream of even eighths nothing can: whether the beat is the eighth or the
// quarter is a question about the music, not about the signal.
//
// So the tie is broken the way a listener breaks it, by where the pulse feels
// comfortable. Scores are weighted by how far the candidate sits from a walking
// tempo, on a log scale because tempo is heard in ratios. The width is what
// decides how much better a doubled reading has to be before it wins, and was
// measured rather than reasoned about: at 0.7 octaves three of four test cases
// come out right, and the fourth is a genuine ambiguity rather than a mistake.
//
// Charging for attacks that land between beats was tried here too, on the
// theory that it would tell a beat from a slower pulse containing some of the
// same attacks. It scored no better at any width and is not here.
const PREFERRED_BPM = 100;
export const PRIOR_WIDTH = { octaves: 0.7 };

function tempoPrior(bpm) {
  const away = Math.log2(bpm / PREFERRED_BPM) / PRIOR_WIDTH.octaves;
  return Math.exp(-0.5 * away * away);
}

export function detectTempo(notes) {
  const attacks = attackTimes(notes);
  if (attacks.length < 8) return null;

  // Candidate beat lengths, a fifth of a semitone apart in tempo — fine enough
  // that the winner is within a few tenths of a BPM
  const candidates = [];
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.25) {
    const periodMs = 60000 / bpm;
    const { score, phase, hits } = fitPeriod(attacks, periodMs);
    candidates.push({ bpm, periodMs, score, phase, hits,
                      weighted: Math.max(0, score) * tempoPrior(bpm) });
  }

  const best = candidates.reduce((a, b) => (b.weighted > a.weighted ? b : a));
  if (best.score <= 0) return null;

  // How much of the music this actually accounts for, so a caller can tell a
  // confident reading from a shrug
  const explained = best.hits / attacks.length;
  return {
    tempo: Math.round(best.bpm * 10) / 10,
    periodMs: best.periodMs,
    offsetMs: best.phase,
    attacks: attacks.length,
    confidence: Math.min(1, explained),
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
const SNAP_TOLERANCE = 0.3;       // of a step; further off and it is left alone

export function snapToBeatGrid(notes, fit) {
  if (!fit) return notes;
  const step = fit.periodMs / SNAP_DIVISION;
  const tol = step * SNAP_TOLERANCE;
  return notes.map(n => {
    const target = Math.round(n.startTime / step) * step;
    if (Math.abs(target - n.startTime) > tol) return n;
    const shift = target - n.startTime;
    return { ...n, startTime: Math.max(0, target), duration: Math.max(step, n.duration - shift) };
  });
}
