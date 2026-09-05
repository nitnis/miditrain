// Dynamics: how loud each note was written, and how far off you may be.
//
// This is the whole of professional mode's arithmetic, deliberately kept out of
// accuracy.js. Nothing here can reach the score, the stars or the extras — it
// only ever hands back numbers, and the one place they are read from adds them
// to the results as a separate block.
//
// The bands were fitted against a real performance rather than picked: a
// 16,662-note Schubert recording, 111 distinct velocities, mean 62 and standard
// deviation 17.9. What it settles is below.
import { handOf } from './hands.js';

// Stamped onto every rating this produces. A stored professional best has to
// stay comparable with one set tomorrow, and it cannot be if the bands moved
// underneath it — so a run records which rules it was judged by, and a change
// here means a change of number, not a silent re-grading of everybody's past.
export const BANDS_VERSION = 1;

// ── Whether the file carries dynamics at all ─────────────────────────────────
//
// A MIDI file exported from notation software usually holds one velocity for
// the whole piece, or two for a forte and a piano. Grading against that would
// score "play everything at exactly 80", which is the opposite of what this
// mode is for — and the generated exercises in scales.js are literally two
// values, 92 for the right hand and 74 for the left.
//
// Both tests are needed. Those two hard-coded values have a standard deviation
// of about 9 and would pass a spread test on their own; it is the count of
// distinct values that catches them. And a file that wanders over twenty values
// inside a narrow band carries no dynamics worth grading either.
const MIN_DISTINCT = 12;
const MIN_SD = 6;

export function dynamicsIn(notes) {
  const v = notes.map(n => n.velocity ?? 90);
  if (!v.length) return { ok: false, distinct: 0, sd: 0, mean: 0, reason: 'there are no notes' };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  const distinct = new Set(v).size;
  const ok = distinct >= MIN_DISTINCT && sd >= MIN_SD;
  return {
    ok, distinct, sd, mean,
    reason: ok ? null
      : distinct < MIN_DISTINCT
        ? `this file only holds ${distinct} velocity value${distinct === 1 ? '' : 's'} — there is nothing to grade against`
        : 'this file’s dynamics barely move — there is nothing to grade against',
  };
}

// ── How wide the band is ─────────────────────────────────────────────────────
//
// Not a fixed number of velocity units, because loudness is roughly logarithmic
// in velocity: a fixed 1.5 dB step is ±1.8 units at velocity 20 and ±9.9 at
// velocity 110. One absolute tolerance would be unplayably tight down at the
// bottom and meaningless at the top, so the band is a share of the target.
//
//   Δ(v) = v × (10^(dB/40) − 1)
//
// The dB figures are chosen so that ±perfect at the reference's median velocity
// of 62 comes out at 7.6 — which is that performer's own median note-to-note
// consistency, measured two ways: the same pitch restruck inside two seconds
// differed by a median of 7, and a note sat a median of 6.9 from the mean of its
// sixteen neighbours. That is the ceiling on what can fairly be asked. A band
// tighter than it would be demanding more consistency than the player being
// copied managed.
const DB = { perfect: 2, good: 3, almost: 5 };

// Very soft notes would otherwise get a band of ±2, which is under the
// resolution of most keybeds and all of most players. Calibration replaces this
// with the player's own measured reproducibility; until then it is a guess, and
// on the reference recording it is what sets the band for 12% of the notes.
export const DEFAULT_FLOOR = 5;

// Where the reference performer was themselves scattered, a tight band measures
// their noise rather than the player's control. So the local spread of the
// reference is a second floor under the band.
//
// Measured within one hand: a melody over an accompaniment is two different
// dynamic levels sounding together, and reading that as scatter would widen
// every band in the piece for a texture that is perfectly deliberate.
const LOCAL_WINDOW = 8;                                     // neighbours each side
const LOCAL_SHARE = { perfect: 0.5, good: 0.75, almost: 1.25 };

const sdOf = (values) => {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
};

const widthFor = (target, db, floor, localSd, share) =>
  Math.max(floor, target * (Math.pow(10, db / 40) - 1), localSd * share);

// The three widths for one note, given what it was written at and how settled
// the reference was around it. The whole rule in one place, so it can be read
// and checked without a piece of music to hang it on.
export function bandWidths(target, { floor = DEFAULT_FLOOR, localSd = 0 } = {}) {
  return {
    target,
    perfect: widthFor(target, DB.perfect, floor, localSd, LOCAL_SHARE.perfect),
    good: widthFor(target, DB.good, floor, localSd, LOCAL_SHARE.good),
    almost: widthFor(target, DB.almost, floor, localSd, LOCAL_SHARE.almost),
  };
}

// ── The bands for a whole piece, worked out once ─────────────────────────────
//
// Over the whole composition, not over the section being trained. A band is a
// property of how the piece was played, and computing it from a two-bar window
// would make the same note forgiving in one section and strict in another
// depending on what happened to be beside it.
function computeBands(notes, floor) {
  const bands = new Map();
  const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);

  const hands = new Map();
  for (const n of sorted) {
    const hand = handOf(n);
    if (!hands.has(hand)) hands.set(hand, []);
    hands.get(hand).push(n);
  }

  for (const list of hands.values()) {
    for (let i = 0; i < list.length; i++) {
      const around = [];
      for (let j = Math.max(0, i - LOCAL_WINDOW); j < Math.min(list.length, i + LOCAL_WINDOW + 1); j++) {
        if (j !== i) around.push(list[j].velocity ?? 90);
      }
      bands.set(list[i].id, bandWidths(list[i].velocity ?? 90, {
        floor, localSd: sdOf(around),
      }));
    }
  }
  return bands;
}

// One composition is loaded at a time, so one slot is enough. The key is cheap
// to compute and changes whenever an edit could have moved a band: a note added
// or removed, or any velocity altered.
let memo = null;

// Start times are in it as well as velocities: a note dragged somewhere else
// keeps its own band but changes whose neighbour it is, and the local spread
// that widens the bands around it moves with it.
const keyFor = (notes, floor) => {
  let sum = 0;
  for (const n of notes) sum += (n.velocity ?? 90) + n.startTime;
  return `${notes.length}:${sum}:${floor}`;
};

// Everything professional mode needs to know about a piece, worked out upfront:
// whether it is worth grading at all, and what each note's tolerance is.
export function analyseDynamics(notes, { floorDelta = DEFAULT_FLOOR } = {}) {
  const key = keyFor(notes, floorDelta);
  if (memo && memo.key === key) return memo.value;

  const found = dynamicsIn(notes);
  const value = {
    version: BANDS_VERSION,
    floorDelta,
    ...found,
    // No point costing out bands for a file that will not be graded on them
    bands: found.ok ? computeBands(notes, floorDelta) : new Map(),
  };
  memo = { key, value };
  return value;
}

export function forgetDynamics() {
  memo = null;
}

// ── What a struck note was worth ─────────────────────────────────────────────
// 'off' rather than 'miss': the note was played, and the timing score has
// already said whether it was played at the right moment. This says only that
// it was played at the wrong volume.
export function levelGradeFor(delta, band) {
  const off = Math.abs(delta);
  if (off <= band.perfect) return 'perfect';
  if (off <= band.good) return 'good';
  if (off <= band.almost) return 'almost';
  return 'off';
}
