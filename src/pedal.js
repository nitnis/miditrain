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
export function pedalAt(events, timeMs, pedal = 'sustain') {
  let value = 0;
  for (const e of events) {
    if (e.time > timeMs) break;
    if (e.pedal === pedal) value = e.value;
  }
  return value;
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
