// The pedals: what a pianist does with their feet.
//
// A MIDI file records them as continuous controllers, and until now this app
// read those bytes and threw them away — all of them, at three separate points.
// On a real performance that is a great deal to discard. The Schubert recording
// this was built against holds 33,667 sustain events against its 16,662 notes,
// and 78% of them are neither fully up nor fully down: continuous half-pedalling
// off a real damper sensor, not a switch.
//
// This module only *carries* the pedals. Playback honours the sustain pedal,
// because a piece whose damper is up for 60% of its length is played wrong
// without it — the app was sounding a legato performance detached. The soft and
// sostenuto pedals are kept faithfully and not yet acted on: one is a timbre
// change this synth has no way to make, and the other needs a per-note model of
// which dampers were caught.

export const PEDAL_NAMES = ['sustain', 'sostenuto', 'soft'];
export const PEDAL_FROM_CC = { 64: 'sustain', 66: 'sostenuto', 67: 'soft' };
export const CC_FOR_PEDAL = { sustain: 64, sostenuto: 66, soft: 67 };

// Where a controller stops counting as up and starts counting as down. The MIDI
// convention, and on a switch pedal the only two values there are.
//
// It is a simplification on a continuous pedal, and knowingly so: this synth is
// an oscillator through a lowpass and cannot voice a half-raised damper at all.
// The value is kept unrounded so that something later can do better with it.
export const PEDAL_DOWN_AT = 64;

// A note whose damper never falls would otherwise ring for the rest of the
// piece — the envelope holds at its sustain level rather than decaying the way
// a string does. A pedal left down at the end of a file is the ordinary way to
// meet this, and it is not a reason to hear one note for four minutes.
export const MAX_RING_MS = 10000;

// How many events one piece keeps. The recording above is 1.6 MB of JSON
// unthinned, against 2 MB for its notes — carried into every profile file on
// every new best. Thinning is by tolerance, raised until it fits, and a
// crossing of the threshold is never thinned away: those are what playback
// reads, and losing one would change what is heard rather than how precisely.
export const MAX_PEDAL_EVENTS = 8000;

const int = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));

// Sorted, bounded, and with the redundancy taken out. Read as strictly as notes
// are: a stored composition can be stale, hand-edited or written by a version
// of the app that meant something else.
export function normalizePedal(raw) {
  if (!Array.isArray(raw)) return [];
  const events = raw
    .filter(e => e && Number.isFinite(e.time) && Number.isFinite(e.value)
                 && PEDAL_NAMES.includes(e.pedal))
    .map(e => ({ time: Math.max(0, Math.round(e.time)), pedal: e.pedal, value: int(e.value, 0, 127) }))
    .sort((a, b) => a.time - b.time);
  return thin(events, MAX_PEDAL_EVENTS);
}

// Drop events that say nothing the one before them did not, at a tolerance
// raised until the whole lot fits. Crossings of the threshold always survive.
export function thin(events, cap = MAX_PEDAL_EVENTS) {
  let kept = atTolerance(events, 0);
  for (const tolerance of [2, 4, 8, 16, 32, 64]) {
    if (kept.length <= cap) return kept;
    kept = atTolerance(events, tolerance);
  }
  return kept.slice(0, cap);
}

function atTolerance(events, tolerance) {
  const kept = [];
  const last = new Map();
  for (const e of events) {
    const prev = last.get(e.pedal);
    const crossed = prev !== undefined
      && (prev >= PEDAL_DOWN_AT) !== (e.value >= PEDAL_DOWN_AT);
    if (prev === undefined || crossed || Math.abs(e.value - prev) > tolerance) {
      kept.push(e);
      last.set(e.pedal, e.value);
    }
  }
  return kept;
}

export function hasPedal(events, pedal = null) {
  if (!events?.length) return false;
  return pedal ? events.some(e => e.pedal === pedal) : true;
}

// What a pedal is at, at a moment. The last thing said about it before then,
// and zero if nothing has been said yet.
//
// Found rather than scanned to, because the gauge asks this of every frame and
// walking a real performance's thousands of events from the beginning each time
// gets slower the further into the piece you are.
export function pedalAt(events, timeMs, pedal = 'sustain') {
  if (!events?.length) return 0;
  let lo = 0;
  let hi = events.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time <= timeMs) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  for (let i = at; i >= 0; i--) {
    if (events[i].pedal === pedal) return events[i].value;
  }
  return 0;
}

// ── What the drawing needs ───────────────────────────────────────────────────
//
// The stretch of one pedal's events that a window of time covers, and the one
// before it — without that first one the window would start at nothing, and a
// pedal held down across the whole of it would draw as up.
//
// A binary search rather than a filter because this runs on every frame of the
// falling notes and a real performance holds thousands of events.
export function pedalSlice(events, fromMs, toMs, pedal = 'sustain') {
  const out = [];
  if (!events?.length) return out;

  let lo = 0;
  let hi = events.length - 1;
  let at = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time <= fromMs) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // Back up to the last event of this pedal at or before the window opens
  let before = null;
  for (let i = at; i >= 0; i--) {
    if (events[i].pedal === pedal) { before = events[i]; break; }
  }
  if (before) out.push(before);
  for (let i = at; i < events.length && events[i].time < toMs; i++) {
    if (events[i].pedal === pedal && events[i] !== before) out.push(events[i]);
  }
  return out;
}

// ── Grading the feet ─────────────────────────────────────────────────────────
//
// What is graded is the *changes*: the moments the damper leaves the strings
// and the moments it comes back. Not whether the pedal was down at each instant
// — the recording this was built against has its damper up for 60% of its
// length, so holding the pedal down from beginning to end would score 60% and
// doing nothing at all would score 40%, and neither is pedalling.
//
// The changes are where the skill is. Lifting on the new harmony and pressing
// again just after it has sounded is the whole of what a pianist is taught
// about the sustain pedal, and it is a matter of a tenth of a second either
// way. That is a thing worth being graded on, and it grades like a note does.
export const PEDAL_GRADE_VERSION = 1;

// Wider than the note windows, and deliberately. A pedal change is placed
// against a harmony rather than against a beat, and the reference is a person
// rather than a grid — the recording's own presses sit a tenth of a second
// after the chords they catch. Tighter than the shortest presses in it, though:
// the shortest twentieth are 119 ms apart, and a window wider than the gap
// between two changes would let one keypress answer both.
export const PEDAL_PERFECT_MS = 110;
export const PEDAL_GOOD_MS = 240;
export const PEDAL_ALMOST_MS = 480;

// The moments the damper moves, within a stretch of time. A press is up going
// down and a lift is down coming up; the value in between is not a change.
export function pedalChanges(events, fromMs = 0, toMs = Infinity, pedal = 'sustain') {
  const out = [];
  let down = false;
  for (const e of events || []) {
    if (e.pedal !== pedal) continue;
    const nowDown = e.value >= PEDAL_DOWN_AT;
    if (nowDown === down) continue;
    down = nowDown;
    if (e.time >= fromMs && e.time < toMs) out.push({ time: e.time, down });
  }
  return out;
}

const pedalGradeFor = (off) => (off <= PEDAL_PERFECT_MS ? 'perfect'
  : off <= PEDAL_GOOD_MS ? 'good' : 'almost');

// Each expected change against the earliest unclaimed one the player made in
// the same direction.
//
// Earliest unclaimed rather than nearest, for the reason the note grading
// already learned: a player uniformly late by a fraction of a second is closer
// to the *next* change than to the one they were answering, and matching on
// distance shunts the whole run along by one and leaves the last change
// unanswered.
export function gradePedalChanges(expected, played) {
  const taken = new Array(played.length).fill(false);
  const graded = [];

  for (const want of expected) {
    let at = -1;
    for (let i = 0; i < played.length; i++) {
      if (taken[i] || played[i].down !== want.down) continue;
      if (Math.abs(played[i].time - want.time) > PEDAL_ALMOST_MS) continue;
      at = i;
      break;
    }
    if (at === -1) { graded.push({ ...want, grade: 'miss', deltaMs: null }); continue; }
    taken[at] = true;
    const deltaMs = Math.round(played[at].time - want.time);
    graded.push({ ...want, grade: pedalGradeFor(Math.abs(deltaMs)), deltaMs });
  }

  const count = (g) => graded.filter(x => x.grade === g).length;
  const deltas = graded.filter(x => x.deltaMs !== null).map(x => x.deltaMs);
  return {
    graded,
    perfect: count('perfect'), good: count('good'), almost: count('almost'),
    missed: count('miss'),
    // Changes the player made that answered nothing. A foot going up and down
    // through a passage that asked for neither is its own kind of wrong.
    extra: taken.filter(t => !t).length,
    total: expected.length,
    // Which way they were out, not only how far. Consistently late is one habit
    // to correct; scattered either side is a lack of control.
    biasMs: deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0,
  };
}

// How much of the passage the two agreed about, damper up or damper down.
// Reported rather than scored — it is dominated by doing nothing, which is
// exactly why the changes are what gets graded.
export function heldShare(expected, played, fromMs, toMs) {
  const span = toMs - fromMs;
  if (!(span > 0)) return 0;
  const edges = [...new Set([fromMs, toMs,
    ...expected.map(c => c.time), ...played.map(c => c.time)])]
    .filter(t => t >= fromMs && t <= toMs)
    .sort((a, b) => a - b);
  const stateAt = (changes, t) => {
    let down = false;
    for (const c of changes) { if (c.time > t) break; down = c.down; }
    return down;
  };
  let agreed = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const mid = (edges[i] + edges[i + 1]) / 2;
    if (stateAt(expected, mid) === stateAt(played, mid)) agreed += edges[i + 1] - edges[i];
  }
  return agreed / span;
}

// ── What playback needs ──────────────────────────────────────────────────────
//
// The stretches where the damper is off the strings, as [from, to). Worked out
// once for a piece rather than per note: a run of the Schubert asks this of
// sixteen thousand notes.
export function sustainSpans(events, pedal = 'sustain') {
  const spans = [];
  let openedAt = null;
  for (const e of events) {
    if (e.pedal !== pedal) continue;
    const down = e.value >= PEDAL_DOWN_AT;
    if (down && openedAt === null) openedAt = e.time;
    else if (!down && openedAt !== null) { spans.push({ from: openedAt, to: e.time }); openedAt = null; }
  }
  // A pedal still down when the file runs out holds for as long as anything
  // ever holds here, and no longer
  if (openedAt !== null) spans.push({ from: openedAt, to: openedAt + MAX_RING_MS });
  return spans;
}

// When a note actually stops sounding, as against when the key came up.
//
// A damper falls when the key is released *and* the pedal is up. So a note
// released while the pedal is down goes on sounding until the pedal is
// released — which is the whole of what pedalling does, and what the app was
// missing. A pedal pressed after the key came up is too late: that damper is
// already down, and catching the note again is what the sostenuto pedal is for.
export function soundingEnd(spans, keyUpMs) {
  if (!spans.length) return keyUpMs;
  // Binary search for the last span starting at or before the key release
  let lo = 0;
  let hi = spans.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].from <= keyUpMs) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found === -1) return keyUpMs;
  const span = spans[found];
  if (keyUpMs >= span.to) return keyUpMs;      // the pedal had already come up
  return Math.min(span.to, keyUpMs + MAX_RING_MS);
}
