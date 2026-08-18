// Scales and arpeggios, generated as playable exercises.
//
// The point of this module is that a practised scale is just a composition:
// once it is a list of notes with hands on them, the score draws it, the notes
// fall, training grades it, learn mode walks it and the loop marks a stretch of
// it. So nothing here knows about any of that — it turns a set of choices into
// notes and stops.
//
// The shape of the thing is: intervals → ladder → pattern → direction → hands.
// A ladder is every pitch of the scale across the octaves asked for, in order.
// A pattern is an index sequence over that ladder, which is what makes a run
// out of a scale. Direction decides whether it is walked up, down, or both.
// Hands place the result on the keyboard.
import { spellPitchClass } from './chords.js';
import { fingersByRung } from './fingering.js';

// ── What to play ─────────────────────────────────────────────────────────────
// Semitones above the tonic, tonic excluded at the top — the ladder repeats it
// an octave up. `down` is for the scales that change on the way back.

export const SCALES = {
  major:            { name: 'Major',              group: 'Major and minor', steps: [0, 2, 4, 5, 7, 9, 11] },
  naturalMinor:     { name: 'Natural minor',      group: 'Major and minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  harmonicMinor:    { name: 'Harmonic minor',     group: 'Major and minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  // The one scale that is genuinely different coming down: raised sixth and
  // seventh going up, plain natural minor coming back
  melodicMinor:     { name: 'Melodic minor',      group: 'Major and minor', steps: [0, 2, 3, 5, 7, 9, 11],
                                                  down: [0, 2, 3, 5, 7, 8, 10] },
  dorian:           { name: 'Dorian',             group: 'Modes', steps: [0, 2, 3, 5, 7, 9, 10] },
  phrygian:         { name: 'Phrygian',           group: 'Modes', steps: [0, 1, 3, 5, 7, 8, 10] },
  lydian:           { name: 'Lydian',             group: 'Modes', steps: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian:       { name: 'Mixolydian',         group: 'Modes', steps: [0, 2, 4, 5, 7, 9, 10] },
  locrian:          { name: 'Locrian',            group: 'Modes', steps: [0, 1, 3, 5, 6, 8, 10] },
  majorPentatonic:  { name: 'Major pentatonic',   group: 'Pentatonic and blues', steps: [0, 2, 4, 7, 9] },
  minorPentatonic:  { name: 'Minor pentatonic',   group: 'Pentatonic and blues', steps: [0, 3, 5, 7, 10] },
  blues:            { name: 'Blues',              group: 'Pentatonic and blues', steps: [0, 3, 5, 6, 7, 10] },
  majorBlues:       { name: 'Major blues',        group: 'Pentatonic and blues', steps: [0, 2, 3, 4, 7, 9] },
  chromatic:        { name: 'Chromatic',          group: 'Symmetrical', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  wholeTone:        { name: 'Whole tone',         group: 'Symmetrical', steps: [0, 2, 4, 6, 8, 10] },
  diminishedWH:     { name: 'Diminished (W–H)',   group: 'Symmetrical', steps: [0, 2, 3, 5, 6, 8, 9, 11] },
  diminishedHW:     { name: 'Diminished (H–W)',   group: 'Symmetrical', steps: [0, 1, 3, 4, 6, 7, 9, 10] },
  bebopDominant:    { name: 'Bebop dominant',     group: 'Jazz', steps: [0, 2, 4, 5, 7, 9, 10, 11] },
  bebopMajor:       { name: 'Bebop major',        group: 'Jazz', steps: [0, 2, 4, 5, 7, 8, 9, 11] },
};

export const CHORDS = {
  major:        { name: 'Major',              group: 'Triads', steps: [0, 4, 7] },
  minor:        { name: 'Minor',              group: 'Triads', steps: [0, 3, 7] },
  diminished:   { name: 'Diminished',         group: 'Triads', steps: [0, 3, 6] },
  augmented:    { name: 'Augmented',          group: 'Triads', steps: [0, 4, 8] },
  sus4:         { name: 'Suspended 4th',      group: 'Triads', steps: [0, 5, 7] },
  dom7:         { name: 'Dominant 7th',       group: 'Sevenths', steps: [0, 4, 7, 10] },
  maj7:         { name: 'Major 7th',          group: 'Sevenths', steps: [0, 4, 7, 11] },
  min7:         { name: 'Minor 7th',          group: 'Sevenths', steps: [0, 3, 7, 10] },
  halfDim7:     { name: 'Half-diminished 7th', group: 'Sevenths', steps: [0, 3, 6, 10] },
  dim7:         { name: 'Diminished 7th',     group: 'Sevenths', steps: [0, 3, 6, 9] },
  minMaj7:      { name: 'Minor-major 7th',    group: 'Sevenths', steps: [0, 3, 7, 11] },
  major6:       { name: 'Major 6th',          group: 'Sevenths', steps: [0, 4, 7, 9] },
};

// ── How to walk it ───────────────────────────────────────────────────────────
// Each pattern turns a ladder of `n` rungs into the order they are played in.
// Straight is the scale itself; the rest are the runs that get built on top of
// one, and they are why practising a scale is not just playing it once.

export const PATTERNS = {
  straight:  { name: 'Straight',      indices: (n) => range(n) },
  thirds:    { name: 'In thirds',     indices: (n) => window2(n, [0, 2]) },
  groups3:   { name: 'Groups of 3',   indices: (n) => window2(n, [0, 1, 2]) },
  groups4:   { name: 'Groups of 4',   indices: (n) => window2(n, [0, 1, 2, 3]) },
  broken:    { name: 'Broken (1-2-3-2)', indices: (n) => window2(n, [0, 1, 2, 1], 2) },
  pairs:     { name: 'Turns (1-2-1-3)',  indices: (n) => window2(n, [0, 1, 0, 2], 1) },
};

const range = (n) => Array.from({ length: n }, (_, i) => i);

// Slide `shape` along the ladder. A group that would run off the top is not
// played at all — a truncated run reads as a mistake rather than an ending.
function window2(n, shape, step = 1) {
  const reach = Math.max(...shape);
  const out = [];
  for (let i = 0; i + reach < n; i += step) out.push(...shape.map(s => i + s));
  // Every run ends on the tonic it has been climbing towards
  if (out.length && out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

// ── The ladder ───────────────────────────────────────────────────────────────

// Every pitch of the scale from the tonic up through `octaves` octaves, ending
// on the tonic again — which is how a scale is played and counted.
export function buildLadder(rootMidi, steps, octaves) {
  const out = [];
  for (let o = 0; o < octaves; o++) {
    for (const step of steps) out.push(rootMidi + o * 12 + step);
  }
  out.push(rootMidi + octaves * 12);
  return out;
}

// An inversion is the same chord started from a different one of its notes:
// rotate the tones below it up an octave. It answers with both the shape and
// how far above the root the new bass sits, because the chord has not changed
// key — a C major triad in first inversion still begins on the E of that C.
export function invert(steps, inversion) {
  const n = steps.length;
  const turns = ((inversion % n) + n) % n;
  const rotated = [...steps.slice(turns), ...steps.slice(0, turns).map(s => s + 12)];
  const bass = rotated[0];
  return { bass, steps: rotated.map(s => s - bass) };
}

// ── Spelling ─────────────────────────────────────────────────────────────────
// A scale uses each letter once, and a chord is stacked thirds. Both rules say
// more than the key signature can: in A harmonic minor the seventh degree is
// G sharp, and a speller that only knows the key of C will call it A flat
// because A flat is nearer to C on the circle of fifths. So the exercise says.
//
// Only where the rule holds. Pentatonics, blues, chromatic and the symmetrical
// scales have no letter-per-degree to follow, and the key-based speller does a
// perfectly good job of those on its own.

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_SEMITONE = [0, 2, 4, 5, 7, 9, 11];
const ACCIDENTALS = { '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: '##' };

// `letterStep` is how far apart consecutive degrees are in letters: 1 for a
// scale, 2 for the stacked thirds of a chord.
function spellings(rootPc, steps, keySignature, letterStep) {
  const rootName = spellPitchClass(rootPc, keySignature).name;
  const rootLetter = LETTERS.indexOf(rootName[0]);
  if (rootLetter < 0) return null;
  const rootOffset = (rootName.slice(1) === 'b' ? -1 : rootName.slice(1) === '#' ? 1 : 0);

  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const letterIndex = (rootLetter + i * letterStep) % 7;
    const naturalPc = LETTER_SEMITONE[letterIndex];
    const wantedPc = (((LETTER_SEMITONE[rootLetter] + rootOffset + steps[i]) % 12) + 12) % 12;
    // Nearest way round the octave, so B to C is one step and not eleven
    let delta = wantedPc - naturalPc;
    if (delta > 6) delta -= 12;
    if (delta < -6) delta += 12;
    const accidental = ACCIDENTALS[delta];
    if (accidental === undefined) return null;  // a triple accidental: give up
    out.push(LETTERS[letterIndex] + accidental);
  }
  return out;
}

// Pitch class → spelling, for the degrees this exercise actually uses
function spellingMap(rootPc, steps, keySignature, letterStep) {
  if (letterStep === 1 && steps.length !== 7) return null;
  const names = spellings(rootPc, steps, keySignature, letterStep);
  if (!names) return null;
  const map = new Map();
  steps.forEach((step, i) => map.set((((rootPc + step) % 12) + 12) % 12, names[i]));
  return map;
}

// ── Building the exercise ────────────────────────────────────────────────────

export const HANDS = {
  right:    { name: 'Right hand' },
  left:     { name: 'Left hand' },
  both:     { name: 'Both hands' },
  contrary: { name: 'Contrary motion' },
};

export const DIRECTIONS = {
  up:     { name: 'Up' },
  down:   { name: 'Down' },
  updown: { name: 'Up and down' },
};

// Notes to the beat, so the note value follows whatever the tempo is
export const NOTE_VALUES = {
  4:  { name: 'Quarter notes', perBeat: 1 },
  8:  { name: 'Eighth notes',  perBeat: 2 },
  12: { name: 'Triplets',      perBeat: 3 },
  16: { name: 'Sixteenths',    perBeat: 4 },
};

const NOTE_NAMES = ['C', 'C♯/D♭', 'D', 'D♯/E♭', 'E', 'F', 'F♯/G♭', 'G', 'G♯/A♭', 'A', 'A♯/B♭', 'B'];
export const ROOTS = NOTE_NAMES.map((name, pc) => ({ pc, name }));

const LOWEST = 21;   // A0
const HIGHEST = 108; // C8

// One pass, in playing order. The ladder is always built upwards from
// `lowMidi`; going down is that same ladder read backwards.
//
// Each note carries the rung it came from, because that is what the fingering
// is attached to. A run in thirds jumps about the ladder, but every note keeps
// the finger it has in the scale — which is the whole point of practising the
// scale that way rather than as a new set of notes.
function pass(lowMidi, steps, octaves, pattern, descending) {
  const ladder = buildLadder(lowMidi, steps, octaves).map((pitch, rung) => ({ pitch, rung }));
  const rungs = descending ? [...ladder].reverse() : ladder;
  const order = (PATTERNS[pattern] || PATTERNS.straight).indices(rungs.length);
  return order.map(i => rungs[i]);
}

// Which way each half goes. Contrary motion is the same exercise with every
// way flipped, which is all `reversed` means.
function waysFor(direction, reversed) {
  const flip = (way) => (reversed ? (way === 'up' ? 'down' : 'up') : way);
  return direction === 'updown' ? [flip('up'), flip('down')] : [flip(direction)];
}

// One hand's whole part, in playing order. Whichever way it sets off, it sets
// off from the tonic that was chosen — so a descending scale starts on that
// note and the ladder hangs below it.
function partFor(rootMidi, scale, octaves, pattern, direction, reversed) {
  const ways = waysFor(direction, reversed);
  const lowMidi = ways[0] === 'down' ? rootMidi - octaves * 12 : rootMidi;

  const out = [];
  for (const way of ways) {
    const descending = way === 'down';
    // Melodic minor is a different scale coming down; everything else is the
    // same one read backwards
    const steps = descending && scale.down ? scale.down : scale.steps;
    const half = pass(lowMidi, steps, octaves, pattern, descending);
    // The turn is one note, not two
    if (out.length && half.length && out[out.length - 1].pitch === half[0].pitch) half.shift();
    out.push(...half);
  }
  return out;
}

// Which key signature spells this best: the one whose own scale covers most of
// the pitches, and among equals the one with fewest accidentals. Works out to
// the relative major for the modes, C for A harmonic minor with its written-in
// G sharp, and something sensible for the scales that belong to no key at all.
const MAJOR_KEYS = [
  { key: 'C', fifths: 0 }, { key: 'G', fifths: 1 }, { key: 'D', fifths: 2 },
  { key: 'A', fifths: 3 }, { key: 'E', fifths: 4 }, { key: 'B', fifths: 5 },
  { key: 'F#', fifths: 6 }, { key: 'F', fifths: -1 }, { key: 'Bb', fifths: -2 },
  { key: 'Eb', fifths: -3 }, { key: 'Ab', fifths: -4 }, { key: 'Db', fifths: -5 },
];
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const KEY_TONIC_PC = { C: 0, G: 7, D: 2, A: 9, E: 4, B: 11, 'F#': 6, F: 5, Bb: 10, Eb: 3, Ab: 8, Db: 1 };

export function keySignatureFor(rootPc, steps) {
  const wanted = new Set(steps.map(s => (((rootPc + s) % 12) + 12) % 12));
  let best = null;
  for (const { key, fifths } of MAJOR_KEYS) {
    const tonic = KEY_TONIC_PC[key];
    const inKey = new Set(MAJOR_STEPS.map(s => (tonic + s) % 12));
    let covered = 0;
    for (const pc of wanted) if (inKey.has(pc)) covered++;
    const score = { key, covered, accidentals: Math.abs(fifths) };
    if (!best || score.covered > best.covered ||
        (score.covered === best.covered && score.accidentals < best.accidentals)) {
      best = score;
    }
  }
  return best.key;
}

// Keep a part on the keyboard: shift it by whole octaves until it fits, so the
// fingering a player is practising does not change
function fitToKeyboard(pitches) {
  if (!pitches.length) return 0;
  let shift = 0;
  const lo = Math.min(...pitches);
  const hi = Math.max(...pitches);
  while (lo + shift < LOWEST && hi + shift + 12 <= HIGHEST) shift += 12;
  while (hi + shift > HIGHEST && lo + shift - 12 >= LOWEST) shift -= 12;
  return shift;
}

// `octave` is the octave the tonic starts in for the right hand, in scientific
// pitch notation: 4 means the C4 of middle C.
export function buildExercise({
  kind = 'scale',
  rootPc = 0,
  type = 'major',
  inversion = 0,
  octaves = 2,
  octave = 4,
  hands = 'right',
  direction = 'updown',
  pattern = 'straight',
  noteValue = 8,
  tempo = 120,
} = {}) {
  const table = kind === 'arpeggio' ? CHORDS : SCALES;
  const chosen = table[type] || table.major;
  const turned = kind === 'arpeggio' ? invert(chosen.steps, inversion) : { bass: 0, steps: chosen.steps };
  const scale = { steps: turned.steps, down: chosen.down };

  // An inverted arpeggio starts on the note the inversion names, not on the
  // chord's root — that is the whole of what an inversion is
  const rootMidi = 12 * (octave + 1) + rootPc + turned.bass;   // C4 = 60

  // Both halves count: melodic minor's key signature is the one that suits the
  // natural minor it comes down as, not only the raised sixth and seventh
  const usedSteps = [...new Set([...chosen.steps, ...(chosen.down || [])])];
  const keySignature = keySignatureFor(rootPc, usedSteps);
  const perBeat = (NOTE_VALUES[noteValue] || NOTE_VALUES[8]).perBeat;
  const noteMs = (60000 / tempo) / perBeat;

  // The left hand plays the same thing two octaves down, except in contrary
  // motion where both hands start on the same key and move apart
  const parts = [];
  if (hands === 'right' || hands === 'both') {
    parts.push({ hand: 'right', root: rootMidi, reversed: false });
  }
  if (hands === 'left' || hands === 'both') {
    parts.push({ hand: 'left', root: rootMidi - 24, reversed: false });
  }
  if (hands === 'contrary') {
    parts.push({ hand: 'right', root: rootMidi, reversed: false });
    parts.push({ hand: 'left', root: rootMidi, reversed: true });
  }

  // Melodic minor changes on the way down, so both halves contribute
  const spellAs = new Map();
  for (const set of [chosen.steps, chosen.down].filter(Boolean)) {
    const map = spellingMap(rootPc, set, keySignature, kind === 'arpeggio' ? 2 : 1);
    if (map) for (const [pc, name] of map) if (!spellAs.has(pc)) spellAs.set(pc, name);
  }

  // The fingering of a scale that changes on the way down is the fingering of
  // its descending form, used both ways: a melodic minor is fingered as the
  // natural minor it comes back as, and the raised sixth and seventh going up
  // take whatever finger their degree already had.
  const fingeredSteps = kind === 'arpeggio' ? turned.steps : (chosen.down || chosen.steps);

  const notes = [];
  let count = 0;
  for (const part of parts) {
    const played = partFor(part.root, scale, octaves, pattern, direction, part.reversed);
    const shift = fitToKeyboard(played.map(p => p.pitch));
    // Shifting the part by whole octaves to fit the keyboard cannot change the
    // fingering, so this is asked once per part rather than once per note
    const fingers = fingersByRung({
      hand: part.hand,
      kind,
      rootPc: (((part.root % 12) + 12) % 12),
      steps: fingeredSteps,
      octaves,
    });
    played.forEach(({ pitch, rung }, i) => {
      const midi = pitch + shift;
      const spelling = spellAs.get(((midi % 12) + 12) % 12);
      const finger = fingers ? fingers[rung] : null;
      notes.push({
        id: `gen-${part.hand}-${i}`,
        pitch: midi,
        velocity: 88,
        startTime: i * noteMs,
        duration: noteMs,
        hand: part.hand,
        ...(spelling ? { spelling } : {}),
        ...(finger ? { finger } : {}),
      });
    });
    count = Math.max(count, played.length);
  }

  const rootName = spellPitchClass(rootPc, keySignature).name;
  const typeName = chosen.name;
  const inversionName = kind === 'arpeggio' && inversion
    ? ` (${['root', '1st', '2nd', '3rd'][inversion] || inversion} inversion)` : '';
  const patternName = pattern === 'straight' ? '' : `, ${PATTERNS[pattern].name.toLowerCase()}`;

  return {
    notes,
    count,
    durationMs: count * noteMs,
    keySignature,
    title: `${rootName} ${typeName}${inversionName} — ${octaves} octave${octaves > 1 ? 's' : ''}${patternName}`,
  };
}
