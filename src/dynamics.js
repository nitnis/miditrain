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
// Two, since balance joined the rating. What a ♪ rating means changed, so what
// it is comparable with changed with it.
export const BANDS_VERSION = 2;

// ── Balance ──────────────────────────────────────────────────────────────────
//
// Judging every note of a chord against its own band alone leaves a hole big
// enough to walk through. The perfect band at the reference recording's median
// velocity is ±7.6 and its chords spread their notes a median of 14 apart —
// two windows 14 apart overlap in the middle, so playing both notes at the
// midpoint passes both. Measured on that recording: **2,509 of its 4,604 chords
// could be played completely flat, every note at one identical velocity, and
// every note would grade perfect.** Chords are 54% of its attacks.
//
// So the melody and the accompaniment could be played at exactly the same
// volume through half the piece and the rating would call the dynamics
// flawless. Balance is that hole closed.
//
// What is compared is the shape of the chord rather than its level: each side
// has its own mean taken out first, so a player who voices the chord correctly
// but plays the whole of it softer is right, which is what "balance" means.
//
// Not "was the top note loudest" — in that recording the top note is the
// loudest only 76% of the time, so a rule would be wrong a quarter of the time.
// The reference's own spread is the target, by definition.
const CHORD_MS = 40;

// The tiers sit between two things, and have to, because a fixed tolerance
// cannot be right for both ends of the music.
//
// Below: the player's own reproducibility. Balance is a difference of
// differences and their wobble is what limits it — no band can be tighter than
// what they can physically repeat.
//
// Above: how much the chord was voiced in the first place. A chord whose notes
// are 24 apart, played flat, is a plain failure; a chord whose notes are 6
// apart, played flat, is barely distinguishable from an unsteady hand. The
// natural scale for both is the error a completely flat performance would
// produce, which is exactly the reference chord's own mean spread about its
// middle — so the thresholds are stated as fractions of "how wrong flat would
// be". A quarter of the way to flat is on the mark; three-quarters of the way
// is off.
//
// It is also, quietly, another reason to calibrate. Uncalibrated, the floor is
// a guess of five and a lightly voiced chord played flat cannot be told from
// wobble; measured, the floor drops and it can.
const BALANCE_TIERS = { perfect: 0.8, good: 1.2, almost: 1.6 };
const BALANCE_OF_VOICING = { perfect: 0.25, good: 0.45, almost: 0.7 };

// How much of a chord's rating is its balance. The rest is what it always was:
// whether the notes were at the level they were written at. A passage with no
// chords in it has no balance to judge and is all level.
export const BALANCE_WEIGHT = 0.5;

// Notes struck together, as chords. Anything alone is not one.
export function chordsOf(notes, at = (n) => n.startTimeMs) {
  const sorted = [...notes].sort((a, b) => at(a) - at(b));
  const out = [];
  let group = [];
  for (const n of sorted) {
    if (group.length && at(n) - at(group[0]) > CHORD_MS) {
      if (group.length > 1) out.push(group);
      group = [];
    }
    group.push(n);
  }
  if (group.length > 1) out.push(group);
  return out;
}

// One chord's balance: how far the shape the player made is from the shape the
// piece asked for, once the level of each is taken out.
export function balanceErrorOf(chord) {
  const want = chord.map(n => n.target);
  const got = chord.map(n => n.target + n.delta);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const wantMid = mean(want);
  const gotMid = mean(got);
  return mean(chord.map((_, i) => Math.abs((got[i] - gotMid) - (want[i] - wantMid))));
}

// How much this chord was voiced at all: its notes' mean distance from their
// own middle, which is the error a completely flat performance would produce.
export function voicingOf(chord) {
  const want = chord.map(n => n.target);
  const mid = want.reduce((a, b) => a + b, 0) / want.length;
  return want.reduce((a, v) => a + Math.abs(v - mid), 0) / want.length;
}

export function balanceGradeFor(error, floor, voicing = 0) {
  const at = (tier) =>
    Math.max(floor * BALANCE_TIERS[tier], voicing * BALANCE_OF_VOICING[tier]);
  if (error <= at('perfect')) return 'perfect';
  if (error <= at('good')) return 'good';
  if (error <= at('almost')) return 'almost';
  return 'off';
}

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

const quantile = (sorted, p) => sorted[Math.max(0, Math.min(sorted.length - 1,
  Math.round((sorted.length - 1) * p)))];

// Where this piece's own soft, ordinary and loud sit. A performance has its own
// idea of mezzo-forte — the reference recording's is 62, not the 64 or 80 that
// a table of MIDI conventions would say — and it is the piece's idea that a
// player is being asked to reproduce, so it is the piece that a calibrated
// keyboard is mapped onto.
export function anchorsOf(velocities) {
  const sorted = [...velocities].sort((a, b) => a - b);
  return {
    soft: quantile(sorted, 0.10),
    medium: quantile(sorted, 0.50),
    loud: quantile(sorted, 0.90),
  };
}

export function dynamicsIn(notes) {
  const v = notes.map(n => n.velocity ?? 90);
  if (!v.length) {
    return { ok: false, distinct: 0, sd: 0, mean: 0, anchors: null, reason: 'there are no notes' };
  }
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  const distinct = new Set(v).size;
  const ok = distinct >= MIN_DISTINCT && sd >= MIN_SD;
  return {
    ok, distinct, sd, mean, anchors: anchorsOf(v),
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

// ── Calibration ──────────────────────────────────────────────────────────────
//
// Velocity is not a measurement of anything physical. It is whatever a keybed's
// own curve makes of a gesture, and a weighted hammer action and a cheap synth
// action hand back very different numbers for the same playing. Grading against
// a recording made on somebody else's instrument, uncalibrated, grades the
// instrument at least as much as the player.
//
// So the player is asked where their own soft, ordinary and loud are, once. The
// piece is asked the same three questions — it answers them itself, in
// `anchorsOf` — and the map takes one to the other. What is stored is only the
// measurement of the player; which piece it is being applied to is decided
// afresh every time, because the same player copying a whisper and a thunder
// should not be asked to play them at the same volume.
export const CALIBRATION_LEVELS = [
  { key: 'soft', name: 'piano', ask: 'as softly as you would play a quiet passage' },
  { key: 'medium', name: 'mezzo-forte', ask: 'your ordinary, comfortable playing' },
  { key: 'loud', name: 'forte', ask: 'strong — but not hammering' },
];

// Enough that one wild strike cannot move the median, few enough that nobody
// gives up in the middle
export const CALIBRATION_STRIKES = 8;

// What one level of the calibration came out at: where it sits, and how much it
// wandered. The spread is the interesting half — it is this player's own
// reproducibility on this keybed, and it is what stops the bands being narrower
// than anything they could hit.
export function summariseStrikes(velocities) {
  if (!velocities.length) return null;
  const sorted = [...velocities].sort((a, b) => a - b);
  const velocity = quantile(sorted, 0.5);
  const offsets = sorted.map(v => Math.abs(v - velocity)).sort((a, b) => a - b);
  return { velocity, spread: quantile(offsets, 0.75) };
}

// A calibration whose levels are not in order is not a calibration: it says the
// player's forte is softer than their piano, which means the three passes were
// not what they were asked for. Better said out loud than quietly fitted.
export function calibrationIsUsable(anchors) {
  return Boolean(anchors)
    && CALIBRATION_LEVELS.every(l => Number.isFinite(anchors[l.key]?.velocity))
    && anchors.soft.velocity < anchors.medium.velocity
    && anchors.medium.velocity < anchors.loud.velocity;
}

const lerp = (x, x0, y0, x1, y1) => y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);

// The player's scale onto the piece's. Straight lines between the three
// anchors, and the nearest line carried on beyond the outer two, so a note
// played harder than the calibration's forte still lands somewhere sensible
// rather than flattening against it.
export function velocityMap(anchors, piece) {
  if (!calibrationIsUsable(anchors) || !piece) return (v) => v;
  const from = {
    soft: anchors.soft.velocity, medium: anchors.medium.velocity, loud: anchors.loud.velocity,
  };
  return (v) => {
    const mapped = v <= from.medium
      ? lerp(v, from.soft, piece.soft, from.medium, piece.medium)
      : lerp(v, from.medium, piece.medium, from.loud, piece.loud);
    return Math.max(1, Math.min(127, mapped));
  };
}

// Under three, the band is narrower than the steps a keybed reports in. Over
// about two dozen, nothing is being graded any more.
const MIN_FLOOR = 3;
const MAX_FLOOR = 24;

// The narrowest band this player can fairly be asked to hit, in the piece's own
// units. Their measured wobble at mezzo-forte, stretched by however much the
// map stretches their playing — a keyboard that squeezes everything into thirty
// velocity units turns a five-unit wobble into a larger one once it has been
// opened out to fit a piece that uses sixty.
export function calibratedFloor(anchors, piece) {
  if (!calibrationIsUsable(anchors) || !piece) return DEFAULT_FLOOR;
  const range = anchors.loud.velocity - anchors.soft.velocity;
  const slope = range > 0 ? (piece.loud - piece.soft) / range : 1;
  const wobble = (anchors.medium.spread ?? DEFAULT_FLOOR) * slope;
  return Math.max(MIN_FLOOR, Math.min(MAX_FLOOR, wobble));
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
// that widens the bands around it moves with it. The calibration is in it
// because every band in the piece rests on the floor it sets.
// Weighted by position, not a plain sum. A plain one collides whenever two
// pieces move the same total between their notes — swap a chord's top and
// bottom velocities and the sum is unchanged — and the bands that come back
// are keyed by the *other* piece's note ids, so not one note gets a band and
// the whole rating quietly reads zero. Caught by two test fixtures that
// differed only in how far their chords were spread.
const keyFor = (notes, calibration) => {
  let sum = 0;
  for (let i = 0; i < notes.length; i++) {
    sum += ((notes[i].velocity ?? 90) + notes[i].startTime) * (i + 1);
  }
  return `${notes.length}:${sum}:${calibration?.at ?? 'raw'}`;
};

// Everything professional mode needs to know about a piece, worked out upfront:
// whether it is worth grading at all, what each note's tolerance is, and how to
// read this player's keyboard onto the scale the piece was written on.
export function analyseDynamics(notes, { calibration = null } = {}) {
  const key = keyFor(notes, calibration);
  if (memo && memo.key === key) return memo.value;

  const found = dynamicsIn(notes);
  const anchors = calibration?.anchors ?? null;
  const floorDelta = calibratedFloor(anchors, found.anchors);
  const value = {
    version: BANDS_VERSION,
    ...found,
    floorDelta,
    calibrated: calibrationIsUsable(anchors),
    // The identity when there is no calibration, so an uncalibrated run is
    // graded on exactly the numbers the keyboard sent
    map: velocityMap(anchors, found.anchors),
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
