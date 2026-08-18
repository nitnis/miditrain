// Suggested fingering for music nobody has fingered.
//
// Tier 1 (fingering.js) answers the questions that have a settled answer: a
// scale, an arpeggio, the things every method book prints identically. This is
// the other kind of question — a piece somebody recorded or imported — where
// there is no printed answer, editors disagree with each other, and the best
// published models still score below what two human annotators agree on. So
// what comes out of here is a suggestion, labelled as one everywhere it is
// shown, and never written into the piece.
//
// ── How it decides ───────────────────────────────────────────────────────────
// The approach is the one the literature settled on: score a fingering by how
// awkward the hand would find it, then search for the cheapest. The cost model
// below is in the spirit of Parncutt's 1997 ergonomic rules — comfortable and
// practical spans between finger pairs, penalties for weak fingers, for the
// thumb on a black key, for crossings — but the numbers are this codebase's
// own, tuned until the model reproduced the scale fingerings that tier 1
// derives independently. That is the check worth having: a model that cannot
// find 1-2-3-1-2-3-4-5 for C major has no business suggesting anything else.
//
// The search is exact rather than greedy. Choosing each note's finger by what
// looks best at the time paints the hand into corners a bar later, which is
// exactly what fingering a passage is about avoiding. Every assignment of
// fingers to every note is scored by dynamic programming over the sequence, in
// time linear in the number of notes.
//
// ── Only one hand is modelled ────────────────────────────────────────────────
// The left hand is the right hand seen in a mirror: turn the keyboard upside
// down and the fifth finger is at the top of the hand again. So the left hand
// runs through the same tables with its pitches negated, and there is one set
// of numbers to get right instead of two.

import { state } from './state.js';
import { handOf } from './hands.js';

const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const isBlack = (pitch) => BLACK_PCS.has(((pitch % 12) + 12) % 12);

// ── Hand geometry ────────────────────────────────────────────────────────────
// For a pair of fingers, how far apart the keys they are on can be, measured in
// semitones from the lower-numbered finger to the higher. "Comfortable" is what
// the hand rests at; "practical" is what it can reach at all. Anything past
// practical means the hand has to move rather than stretch, which is allowed —
// it is just not free.
//
// The thumb's ranges start negative because the thumb passes under: in the
// middle of a scale it really is playing above the finger it just left.
const SPAN = {
  12: { comf: [-2,  5], prac: [-6, 10] },
  13: { comf: [ 1,  7], prac: [-4, 12] },
  14: { comf: [ 3,  9], prac: [-2, 14] },
  15: { comf: [ 5, 12], prac: [ 0, 16] },
  23: { comf: [ 1,  3], prac: [ 0,  5] },
  24: { comf: [ 2,  5], prac: [ 1,  8] },
  25: { comf: [ 4,  8], prac: [ 2, 12] },
  34: { comf: [ 1,  2], prac: [ 0,  4] },
  35: { comf: [ 2,  5], prac: [ 1,  8] },
  45: { comf: [ 1,  2], prac: [ 0,  4] },
};

// The span table read from f1 towards f2, in whichever order they come. Going
// from the higher finger to the lower one is the same reach backwards, so the
// range is negated and flipped.
function spanRange(f1, f2, kind) {
  const entry = SPAN[f1 < f2 ? `${f1}${f2}` : `${f2}${f1}`];
  const [lo, hi] = entry[kind];
  return f1 < f2 ? [lo, hi] : [-hi, -lo];
}

// ── What each choice costs ───────────────────────────────────────────────────

const W = {
  stretch: 0.42,      // per semitone past comfortable, super-linearly
  handShift: 1.25,    // the hand has to travel rather than stretch
  sameFinger: 2.2,    // the same finger twice on different keys: no legato
  heldFinger: 24,     // ...while the first note is still sounding: impossible
  cross: 2.1,         // two fingers swapping order without the thumb's help
  crossReach: 0.34,   // per semitone a crossing has to travel beyond a step
  thumbOnBlack: 1.7,  // short finger, wrong place on the key
  fifthOnBlack: 0.85,
  // The fourth finger is the weakest and least independent, and the fifth is
  // short — but avoiding them is not free either. Priced any higher than this,
  // the model runs a two-octave scale on 3-2-1 groups the whole way rather than
  // put the little finger down once, and shuffles the hand nine times to save
  // itself two weak fingers.
  weak4: 0.22,
  weak5: 0.10,
  leap: 0.14,         // per semitone the hand travels, whatever the fingering
  settle: 0.06,       // how far a held span sits from where those fingers rest
  jumpBase: 1.0,      // leaving the keys and landing again, at all
  jumpRoom: 0.12,     // landing without room to carry on the way you were going
};

// Passing the thumb under — or a finger over it — is not a stretch, which is
// the thing to get right about it. The hand pivots on the thumb and arrives
// somewhere new, so the cost is not "how far can finger 3 reach from here" but
// "how awkward is it to cross under 3", which is barely awkward at all. Charging
// it as a stretch is what makes a model finger a scale 1-2-1-2-1-2 to avoid a
// crossing it has priced at four times what it is worth.
//
// What does vary is which finger is crossed: under the third is the one every
// scale is built on, under the second is cramped, and under the fifth is not
// really done.
//
// A crossing is also a hand reposition, and repositioning twice where once
// would do is what separates 1-2-3-1-2-3-4-5 from 1-2-3-1-2-3-1-2. Priced
// below the fourth and fifth fingers those two come out within a hundredth of
// each other, and the model finishes a scale by crossing again instead of
// reaching for the end of the hand.
const CROSSING = { 2: 1.3, 3: 0.85, 4: 0.95, 5: 2.6 };
const CROSS_FREE = 3;   // semitones a crossing covers before it is a reach
const JUMP = 12;        // past an octave it is a leap, not a stretch or a cross

// Cost of following (p1, f1) with (p2, f2) in one hand
function stepCost(p1, f1, p2, f2, stillSounding) {
  const d = p2 - p1;

  if (f1 === f2) {
    if (d === 0) return 0;                        // a repeated note, same finger
    return (stillSounding ? W.heldFinger : W.sameFinger) + W.leap * Math.abs(d);
  }
  if (d === 0) return 0.35;                       // deliberate finger substitution

  // Past about an octave the hand leaves the keys and lands again. Nothing
  // about the previous finger survives the flight, so none of the reaching or
  // crossing arithmetic below applies to it — read as a crossing, a two-octave
  // jump onto the thumb scores as a thumb pass that has to travel twenty
  // semitones, and the model lands the leap on the third finger to avoid it.
  // What is left worth caring about is landing with room to carry on.
  if (Math.abs(d) > JUMP) {
    const room = d > 0 ? f2 - 1 : 5 - f2;
    return W.jumpBase + W.leap * (Math.abs(d) - JUMP) + W.jumpRoom * room;
  }

  const thumbUnder = f2 === 1 && d > 0;           // ascending onto the thumb
  const thumbOver = f1 === 1 && d < 0;            // descending off the thumb
  if (thumbUnder || thumbOver) {
    const crossed = thumbUnder ? f1 : f2;
    const past = Math.max(0, Math.abs(d) - CROSS_FREE);
    return CROSSING[crossed] + W.crossReach * Math.pow(past, 1.2);
  }

  const [clo, chi] = spanRange(f1, f2, 'comf');
  const [plo, phi] = spanRange(f1, f2, 'prac');

  const past = d < clo ? clo - d : d > chi ? d - chi : 0;
  let cost = W.stretch * Math.pow(past, 1.3);
  if (d < plo || d > phi) cost += W.handShift;
  if ((f2 > f1 && d < 0) || (f2 < f1 && d > 0)) cost += W.cross;  // 3 over 4
  return cost;
}

// Cost of using a finger on a key at all, whatever came before it.
//
// The fifth finger on a black key is only awkward in a line, where it has to
// get on and off a narrow key between white ones. In a chord it is just the
// top note, and charging it there fingers a dominant seventh 1-2-3-4 to keep
// the fifth off the flat — reaching a fourth between the third and fourth
// fingers to avoid a note that was never a problem.
function placeCost(pitch, finger, inChord) {
  let cost = 0;
  if (isBlack(pitch)) {
    if (finger === 1) cost += W.thumbOnBlack;
    else if (finger === 5 && !inChord) cost += W.fifthOnBlack;
  }
  if (finger === 4) cost += W.weak4;
  else if (finger === 5) cost += W.weak5;
  return cost;
}

// Holding several keys down at once: the fingers must be in the same order as
// the keys, and every gap has to be within reach.
//
// Comfortable is not a plateau. A third between two fingers that like being a
// third apart is better than the same third between two that would rather be a
// fifth, even though neither is uncomfortable — which is the whole difference
// between fingering a triad 1-3-5 and fingering it 1-2-5. Left flat, those two
// score identically and the winner is whichever the loop happened to try first.
function chordCost(pitches, fingers) {
  let cost = 0;
  for (let i = 0; i + 1 < pitches.length; i++) {
    const d = pitches[i + 1] - pitches[i];
    const [clo, chi] = spanRange(fingers[i], fingers[i + 1], 'comf');
    const [, phi] = spanRange(fingers[i], fingers[i + 1], 'prac');
    if (d > phi) return Infinity;                 // simply cannot be held
    const past = d < clo ? clo - d : d > chi ? d - chi : 0;
    cost += W.stretch * Math.pow(past, 1.3);
    cost += W.settle * Math.abs(d - (clo + chi) / 2);
  }
  // The outer fingers have to span the whole chord, not just their neighbours
  if (pitches.length > 2) {
    const d = pitches[pitches.length - 1] - pitches[0];
    const [, phi] = spanRange(fingers[0], fingers[fingers.length - 1], 'prac');
    if (d > phi) return Infinity;
  }
  return cost;
}

// ── Candidate fingerings for one event ───────────────────────────────────────
// Notes sounded together take fingers in the same order as their pitches, so
// the candidates for a chord of k notes are the increasing k-tuples of fingers.

const comboCache = new Map();

function combinations(k) {
  if (k > 5) return [];
  if (comboCache.has(k)) return comboCache.get(k);
  const out = [];
  const walk = (start, picked) => {
    if (picked.length === k) { out.push([...picked]); return; }
    for (let f = start; f <= 5; f++) { picked.push(f); walk(f + 1, picked); picked.pop(); }
  };
  walk(1, []);
  comboCache.set(k, out);
  return out;
}

// ── Grouping ─────────────────────────────────────────────────────────────────

const CHORD_MS = 45;    // notes this close together are one hand shape

// A key lifted a few milliseconds late is a key that was lifted. Played music
// overlaps everywhere — in a recording of the Rondo alla Turca the longest such
// overlap is 17ms — and reading those as notes held together forbids the finger
// that just played from playing the next note, which is most of legato.
const HELD_SLOP = 30;

function toEvents(notes) {
  const sorted = [...notes].sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
  const events = [];
  for (const note of sorted) {
    const last = events[events.length - 1];
    if (last && note.startTime - last.time <= CHORD_MS && last.notes.length < 5) {
      last.notes.push(note);
      last.endsAt = Math.max(last.endsAt, note.startTime + note.duration);
    } else {
      events.push({ time: note.startTime, notes: [note], endsAt: note.startTime + note.duration });
    }
  }
  // Pitch order within the event, which is what the finger order has to match
  for (const event of events) event.notes.sort((a, b) => a.pitch - b.pitch);
  return events;
}

// ── The search ───────────────────────────────────────────────────────────────
// One column of states per event, each state a way of fingering it. Every
// column keeps, for each of its states, the cheapest path that reaches it —
// so the whole passage is solved without ever enumerating whole fingerings.

function solve(events, into) {
  if (!events.length) return;

  let previous = null;   // one state per way of fingering the last event
  const columns = [];

  for (const event of events) {
    const pitches = event.notes.map(n => n.pitch);   // mirrored for the left hand
    const keys = event.notes.map(n => n.key);        // the keys actually pressed
    const column = [];

    for (const fingers of combinations(pitches.length)) {
      const shape = chordCost(pitches, fingers);
      if (!isFinite(shape)) continue;
      let here = shape;
      const inChord = pitches.length > 1;
      for (let i = 0; i < fingers.length; i++) here += placeCost(keys[i], fingers[i], inChord);

      let best = here;
      let from = -1;
      if (previous) {
        best = Infinity;
        for (let s = 0; s < previous.length; s++) {
          const prior = previous[s];
          const total = prior.cost + here + moveCost(prior, event.time, pitches, fingers);
          if (total < best) { best = total; from = s; }
        }
      }
      if (isFinite(best)) {
        column.push({ fingers, pitches, endsAt: event.endsAt, cost: best, from });
      }
    }

    // Every event must be fingered somehow. A shape no hand can hold — a chord
    // wider than a tenth, which is really two hands or a spread — still has to
    // come out with something rather than break the sequence in half.
    if (!column.length) {
      column.push({
        fingers: spread(pitches.length), pitches, endsAt: event.endsAt,
        cost: (previous ? previous[cheapestIndex(previous)].cost : 0) + 6,
        from: previous ? cheapestIndex(previous) : -1,
      });
    }

    columns.push({ event, column });
    previous = column;
  }

  // Walk the cheapest path back to the start
  let index = cheapestIndex(previous);
  for (let c = columns.length - 1; c >= 0; c--) {
    const { event, column } = columns[c];
    const state = column[index];
    event.notes.forEach((note, i) => into.set(note.id, state.fingers[i]));
    index = state.from;
    if (index < 0) break;
  }
}

// Moving the hand from one event's shape to the next. The bottom of the hand
// and the top of it each have to get where they are going; what happens in
// between follows from those.
function moveCost(prior, startTime, pitches, fingers) {
  const held = prior.endsAt > startTime + HELD_SLOP;
  const last = prior.pitches.length - 1;
  const top = pitches.length - 1;
  const low = stepCost(prior.pitches[0], prior.fingers[0], pitches[0], fingers[0], held);
  const high = stepCost(prior.pitches[last], prior.fingers[last], pitches[top], fingers[top], held);
  return (low + high) / 2;
}

function cheapest(column) {
  return column.reduce((best, s) => (s.cost < best.cost ? s : best), column[0]);
}
function cheapestIndex(column) {
  let best = 0;
  for (let i = 1; i < column.length; i++) if (column[i].cost < column[best].cost) best = i;
  return best;
}

// Fingers spread as evenly as possible over a shape too wide to hold
function spread(count) {
  if (count >= 5) return [1, 2, 3, 4, 5];
  const picks = [1, 2, 3, 4, 5];
  const out = [];
  for (let i = 0; i < count; i++) out.push(picks[Math.round(i * 4 / Math.max(1, count - 1))] || i + 1);
  return [...new Set(out)].length === count ? out : picks.slice(0, count);
}

// ── What the rest of the app calls ───────────────────────────────────────────

// Suggested fingers by note id. Both hands, each solved on its own, the left
// through the mirror. Notes that already carry a fingering are left alone —
// a suggestion never argues with an answer that is actually known.
export function suggestFingering(notes) {
  const out = new Map();
  if (!notes || !notes.length) return out;

  for (const hand of ['right', 'left']) {
    const mine = notes.filter(n => handOf(n) === hand && !n.finger);
    if (!mine.length) continue;

    // The mirror: the left hand is the right hand on an upside-down keyboard.
    // Only the geometry is mirrored. The keys themselves are not — negating a
    // pitch turns C sharp into B, so asking a mirrored pitch whether it is a
    // black key gets a different key's answer, and every black-key rule fires
    // in the wrong places for a whole hand. The real pitch travels alongside.
    const facing = mine.map(n => ({
      id: n.id,
      pitch: hand === 'left' ? -n.pitch : n.pitch,
      key: n.pitch,
      startTime: n.startTime,
      duration: n.duration,
    }));

    solve(toEvents(facing), out);
  }
  return out;
}

// ── The suggestion the app is currently showing ──────────────────────────────
// Held here rather than written onto the notes. A suggestion is not part of the
// piece: it must not be saved with it, must not survive into a file somebody
// exports, and must never be mistaken later for a fingering somebody chose.

let showing = new Map();

// Recomputed from scratch whenever the notes change, because a fingering is a
// property of the whole passage — inserting one note in bar 2 can legitimately
// change the fingering of bar 1.
export function refreshSuggestions(notes) {
  showing = state.ui.suggestFingering ? suggestFingering(notes) : new Map();
  return showing.size;
}

export function suggestedFinger(noteId) {
  return showing.get(noteId) ?? null;
}

export function hasSuggestions() {
  return showing.size > 0;
}
