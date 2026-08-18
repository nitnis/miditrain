// Which finger plays which note of a practised scale or arpeggio.
//
// This is deliberately the small half of the problem. Fingering a piece of
// music is hard — the research on it (Parncutt's ergonomic cost model, and the
// statistical models trained on the PIG dataset since) still scores below what
// two human editors agree on. But fingering a *scale* is not hard, because it
// has been settled for two hundred years and every method book prints the same
// answer. So this module does not search or score anything. It reproduces the
// standard answer, and where there is no standard answer it says nothing.
//
// Saying nothing matters. A wrong fingering on a scale is worse than none: the
// player trusts it, drills it, and has to unlearn it. Every path out of here
// either returns the fingering the books print or returns null.
//
// ── The shape of a scale fingering ───────────────────────────────────────────
// A seven-note scale is played with two thumbs per octave, splitting the seven
// degrees into a group of three and a group of four. Which two degrees get the
// thumb is the whole decision; everything else follows by counting fingers out
// from them. There are only seven ways to make that split, so the right hand
// works them out from first principles rather than from a table:
//
//   1. the thumb never goes on a black key — it is short, and it has to pass
//      under, which it cannot do from between the black keys;
//   2. it does not pass under across an augmented second either — three
//      semitones is too far to reach cleanly, which is what keeps the thumb off
//      the raised seventh of a harmonic minor;
//   3. prefer a thumb on the tonic, which is what makes A minor and D dorian
//      start on 1 rather than on some interior split of the same white keys;
//   4. then prefer thumbs on C and F, which is what makes C major
//      1-2-3-1-2-3-4-5 and A flat major 3-4-1-2-3-1-2-3;
//   5. then the earliest split, so ties break the same way every time.
//
// That reproduces all twelve major scales in the right hand, and carries over
// to the minors and modes for free, because it is reasoning about where the
// black keys are rather than about which scale it is.
//
// The left hand does not follow the same reasoning. Its thumb passes over
// rather than under, and its little finger takes the bottom note, so the C/F
// preference simply is not true of it — left-hand B flat major puts its thumbs
// on D and A, not on C and F. There is no short rule; there is a table, which
// is below.

const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const isBlack = (pc) => BLACK_PCS.has(((pc % 12) + 12) % 12);

const DEGREES = 7;

// Left-hand thumb degrees by tonic, as the books print them. Keyed by the pitch
// class of the tonic: the four sharp-side keys and the naturals share one
// answer, B has its own, F sharp has its own, and the flat keys share a fourth.
const LEFT_THUMBS = {
  0: [0, 4],  7: [0, 4],  2: [0, 4],  9: [0, 4],  4: [0, 4],  5: [0, 4],
  11: [0, 3],
  6: [3, 6],
  10: [2, 6], 3: [2, 6],  8: [2, 6],  1: [2, 6],
};

// ── Right hand: which split ──────────────────────────────────────────────────

// The seven splits, each named by the degree its group of three starts on.
function thumbsFor(a) {
  return [a, (a + 3) % DEGREES];
}

// Semitones from the degree below `d` up to `d` — how far the thumb has to
// reach when it passes under to get there
function approach(d, pcs) {
  const below = (d - 1 + DEGREES) % DEGREES;
  return (((pcs[d] - pcs[below]) % 12) + 12) % 12;
}

function chooseRightThumbs(pcs) {
  let best = null;
  for (let a = 0; a < DEGREES; a++) {
    const thumbs = thumbsFor(a);
    if (thumbs.some(d => isBlack(pcs[d]))) continue;  // rule 1 is absolute
    const stretch = thumbs.filter(d => approach(d, pcs) > 2).length;
    const tonic = thumbs.includes(0) ? 1 : 0;
    const cf = thumbs.filter(d => pcs[d] === 0 || pcs[d] === 5).length;
    const score = [stretch, -tonic, -cf, a];
    if (!best || ranksBefore(score, best.score)) best = { thumbs, score };
  }
  return best ? best.thumbs : null;
}

// Arrays do not compare with <, so rank them explicitly: first difference wins
function ranksBefore(x, y) {
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] < y[i];
  }
  return false;
}

// ── Counting fingers out from the thumbs ─────────────────────────────────────
// Right hand climbing: the thumb starts each group and the fingers follow it
// upwards, 1-2-3 or 1-2-3-4. Left hand climbing: the fingers arrive *at* the
// thumb, so a group of four is 4-3-2-1 and the counting runs the other way.

// Rungs from `d` back down to the nearest thumb at or below it
function belowThumb(d, thumbs) {
  for (let k = 0; k < DEGREES; k++) {
    if (thumbs.includes((d - k + DEGREES) % DEGREES)) return k;
  }
  return 0;
}

// Rungs from `d` up to the nearest thumb at or above it
function aboveThumb(d, thumbs, minK = 0) {
  for (let k = minK; k < DEGREES + minK; k++) {
    if (thumbs.includes((d + k) % DEGREES)) return k;
  }
  return 0;
}

function rightScaleFingers(thumbs, octaves) {
  const top = DEGREES * octaves;
  const out = [];
  for (let r = 0; r <= top; r++) {
    // The last rung is the tonic arriving an octave up, and the hand does not
    // put the thumb under for a note it is not going to play on from. It
    // carries on with the group it is in — which is where C major's closing 5
    // comes from, and F major's closing 4.
    out.push(r === top ? out[r - 1] + 1 : 1 + belowThumb(r % DEGREES, thumbs));
  }
  return out;
}

function leftScaleFingers(thumbs, octaves) {
  const top = DEGREES * octaves;
  const out = [];
  for (let r = 0; r <= top; r++) {
    // Mirror of the right hand's top rung: nothing has been played below the
    // bottom note, so no thumb is needed under it and the hand reaches down
    // with whatever finger the climb to the first thumb leaves spare. That is
    // 5 in C major and 4 in B major, which is exactly what the books print.
    const first = r === 0 && thumbs.includes(0);
    out.push(1 + aboveThumb(r % DEGREES, thumbs, first ? 1 : 0));
  }
  return out;
}

// ── Arpeggios ────────────────────────────────────────────────────────────────
// Only the plain root-position major and minor triads on a white key. Those are
// 1-2-3 up and 5-4-2-1 down in every book. Once the root is black, or a seventh
// is added, or the chord is inverted, the printed fingerings stop agreeing with
// each other and there is nothing to reproduce.

const TRIADS = [[0, 4, 7], [0, 3, 7]];
const sameSteps = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const RIGHT_TRIAD = [1, 2, 3];   // by rung within the octave, climbing
const LEFT_TRIAD = [1, 4, 2];    // 5-4-2-1 read from the thumb downwards

function triadFingers(hand, octaves) {
  const top = 3 * octaves;
  const out = [];
  for (let r = 0; r <= top; r++) {
    if (hand === 'left') out.push(r === 0 ? 5 : LEFT_TRIAD[r % 3]);
    else out.push(r === top ? 5 : RIGHT_TRIAD[r % 3]);
  }
  return out;
}

// ── The one thing this module exports ────────────────────────────────────────

// Fingers by ladder rung — index 0 is the lowest note of the exercise, the last
// index is the tonic arriving `octaves` above it. Rungs, not playing order:
// running a scale in thirds jumps about, but each note keeps the finger it has
// in the scale, which is the point of practising it that way.
//
// Returns null when there is no settled answer, and the caller shows nothing.
export function fingersByRung({ hand, kind = 'scale', rootPc = 0, steps = [], octaves = 1 }) {
  if (hand !== 'left' && hand !== 'right') return null;
  if (!(octaves >= 1)) return null;

  if (kind === 'arpeggio') {
    if (isBlack(rootPc)) return null;
    if (!TRIADS.some(t => sameSteps(t, steps))) return null;
    return triadFingers(hand, octaves);
  }

  if (steps.length !== DEGREES) return null;
  const pcs = steps.map(s => (((rootPc + s) % 12) + 12) % 12);

  if (hand === 'right') {
    const thumbs = chooseRightThumbs(pcs);
    return thumbs ? rightScaleFingers(thumbs, octaves) : null;
  }

  // The left-hand table is written for the major scales. It carries over to
  // the minors and modes on the same tonic as long as the notes it wants the
  // thumb on are still white in this scale — B flat minor is where that fails,
  // and it gets nothing rather than a fingering with a thumb on D flat.
  const thumbs = LEFT_THUMBS[((rootPc % 12) + 12) % 12];
  if (!thumbs || thumbs.some(d => isBlack(pcs[d]))) return null;
  return leftScaleFingers(thumbs, octaves);
}
