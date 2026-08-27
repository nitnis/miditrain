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
// a setting with room to spare. Below about 0.8 the andante stays at its eighth
// note; above about 1.2 a plain stream of quarters gets halved, because a
// reading at half speed always has every other note sitting exactly between its
// beats and starts collecting this reward for it. The two bounds are a genuine
// conflict and not a tuning failure — the crossings were measured at 2.0 and
// 1.07 on clean input, and they do not overlap. One is the middle of what is
// left, and every piece in the test set is read correctly there.
export const SUBDIVISION_WEIGHT = { k: 1 };

export function detectTempo(notes) {
  const attacks = attackTimes(notes);
  if (attacks.length < 8) return null;

  // Candidate beat lengths, a fifth of a semitone apart in tempo — fine enough
  // that the winner is within a few tenths of a BPM
  const candidates = [];
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.25) {
    const periodMs = 60000 / bpm;
    const { score, phase, hits, between, coverage } = fitPeriod(attacks, periodMs);
    candidates.push({ bpm, periodMs, score, phase, hits, between, coverage,
                      weighted: Math.max(0, score) * tempoPrior(bpm) * coverage
                                * (1 + SUBDIVISION_WEIGHT.k * between) });
  }

  const best = candidates.reduce((a, b) => (b.weighted > a.weighted ? b : a));
  if (best.score <= 0) return null;

  return {
    tempo: Math.round(best.bpm * 10) / 10,
    periodMs: best.periodMs,
    offsetMs: best.phase,
    attacks: attacks.length,
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
