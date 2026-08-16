// Which hand plays a note.
//
// Middle C is a bad answer. Hands overlap constantly — in the Rondo alla Turca
// the left hand reaches up to F#4 while the right never goes below E4, so a
// fixed line puts a whole chord in the wrong hand. What actually separates the
// hands is the gap between them: at any moment the notes fall into a low
// cluster and a high one, each inside a hand's reach, with daylight between.
//
// A file that already knows is believed instead. Nothing inferred here beats
// two tracks named "Piano right" and "Piano left".
import { state } from './state.js';

const MAX_HAND_SPAN = 14;   // a tenth, about as far as a hand stretches
const MIN_GAP = 2;          // adjacent semitones are one shape, not two hands
const DEFAULT_SPLIT = 60;   // middle C, when there is nothing else to go on
const MIN_SLICE_MS = 120;

let inferred = new Map();   // note id → 'left' | 'right'

export function handOf(note) {
  if (note.hand === 'left' || note.hand === 'right') return note.hand;
  return inferred.get(note.id) || (note.pitch >= DEFAULT_SPLIT ? 'right' : 'left');
}

export function isRightHand(note) {
  return handOf(note) === 'right';
}

// Which hand the practice modes are working on. Hands are learned separately
// long before they are put together, so training and learn mode can be pointed
// at one of them; 'both' is the whole texture.
export function practiceHand() {
  const want = state.ui.practiceHand;
  return want === 'left' || want === 'right' ? want : 'both';
}

export function isPractised(note) {
  const want = practiceHand();
  return want === 'both' || handOf(note) === want;
}

const median = (sorted) => sorted[Math.floor(sorted.length / 2)];

// Two notes further apart than a hand can reach, sounding at the same instant,
// cannot be the same hand. That is the one thing here that is certain rather
// than likely, and it is what tells an alternating left hand — a low bass then
// a middle chord — apart from two hands sharing the middle of the keyboard.
// Returns the window the split has to fall inside.
function separationBounds(notes) {
  let floor = -Infinity;   // the split must be above this
  let ceiling = Infinity;  // and at or below this
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i];
      const b = notes[j];
      if (Math.abs(a.pitch - b.pitch) <= MAX_HAND_SPAN) continue;
      const overlaps = a.startTime < b.startTime + b.duration &&
                       b.startTime < a.startTime + a.duration;
      if (!overlaps) continue;
      floor = Math.max(floor, Math.min(a.pitch, b.pitch));
      ceiling = Math.min(ceiling, Math.max(a.pitch, b.pitch));
    }
  }
  return { floor, ceiling };
}

// Where to divide a moment's pitches. The split is the lowest pitch of the
// upper hand, so a note is right-handed when its pitch is at or above it.
function twoHandSplit(sorted, previous, bounds) {
  let best = { score: -Infinity, split: null };
  for (let i = 1; i < sorted.length; i++) {
    const split = sorted[i];
    // A split that leaves two simultaneous, unreachable notes in one hand is
    // not a candidate at all
    if (split <= bounds.floor || split > bounds.ceiling) continue;
    const gap = split - sorted[i - 1];
    if (gap < MIN_GAP) continue;
    const lowSpan = sorted[i - 1] - sorted[0];
    const highSpan = sorted[sorted.length - 1] - split;
    // Reaching past what a hand can hold counts against a split, but does not
    // rule it out — a rolled bass figure can cover two octaves
    const overreach = Math.max(0, lowSpan - MAX_HAND_SPAN) + Math.max(0, highSpan - MAX_HAND_SPAN);
    // Ties go to the split nearest the last one, so the hands do not swap
    // places over a passing note
    const score = gap - overreach * 0.5 - Math.abs(split - previous) * 0.05;
    if (score > best.score) best = { score, split };
  }
  return best.split ?? previous;
}

// Recompute for every note without an explicit hand. Cheap enough to run on
// each edit: one pass to slice, one to assign.
export function inferHands(notes, beatMs = 500) {
  inferred = new Map();
  const loose = notes.filter(n => n.hand !== 'left' && n.hand !== 'right');
  if (!loose.length) return;

  const sliceMs = Math.max(MIN_SLICE_MS, beatMs / 2);
  const end = loose.reduce((max, n) => Math.max(max, n.startTime + n.duration), 0);
  const sliceCount = Math.floor(end / sliceMs) + 1;

  // What each slice sees. The window reaches a beat either side, because the
  // hands often alternate rather than sound together — in an Alla Turca
  // texture the right hand's semiquavers and the left hand's chords never
  // overlap, and a window narrow enough to hold only one of them would call
  // every moment a solo.
  const reach = Math.max(1, Math.round(beatMs / sliceMs));
  const buckets = Array.from({ length: sliceCount }, () => []);
  for (const note of loose) {
    const from = Math.max(0, Math.floor(note.startTime / sliceMs) - reach);
    const to = Math.min(sliceCount - 1, Math.floor((note.startTime + note.duration) / sliceMs) + reach);
    for (let s = from; s <= to; s++) buckets[s].push(note);
  }

  const splits = new Array(sliceCount);
  let split = DEFAULT_SPLIT;
  // Where each hand last was. A moment holding only one cluster cannot say
  // which hand it is from its own shape — but a hand does not teleport, so the
  // cluster belongs to whichever hand it is nearer.
  let leftCentre = 50;
  let rightCentre = 72;

  for (let s = 0; s < sliceCount; s++) {
    const sorted = [...new Set(buckets[s].map(n => n.pitch))].sort((a, b) => a - b);
    if (!sorted.length) { splits[s] = split; continue; }

    if (sorted[sorted.length - 1] - sorted[0] <= MAX_HAND_SPAN) {
      const centre = median(sorted);
      if (Math.abs(centre - rightCentre) <= Math.abs(centre - leftCentre)) {
        split = sorted[0];            // all of it is the right hand
        rightCentre = centre;
      } else {
        split = sorted[sorted.length - 1] + 1;   // all of it is the left
        leftCentre = centre;
      }
    } else {
      split = twoHandSplit(sorted, split, separationBounds(buckets[s]));
      const low = sorted.filter(p => p < split);
      const high = sorted.filter(p => p >= split);
      if (low.length) leftCentre = median(low);
      if (high.length) rightCentre = median(high);
    }
    splits[s] = split;
  }

  for (const note of loose) {
    const slice = Math.min(sliceCount - 1, Math.max(0, Math.floor(note.startTime / sliceMs)));
    inferred.set(note.id, note.pitch >= splits[slice] ? 'right' : 'left');
  }
}

// For tests and diagnostics
export function inferredSplitAt(notes, beatMs, ms) {
  inferHands(notes, beatMs);
  const sliceMs = Math.max(MIN_SLICE_MS, beatMs / 2);
  const sounding = notes.filter(n => n.startTime <= ms && n.startTime + n.duration > ms);
  return { sliceMs, sounding: sounding.map(n => n.pitch).sort((a, b) => a - b) };
}
