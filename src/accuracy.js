// Accuracy tracking: compare live MIDI input against expected notes during playback
import { state, update, emit, on } from './state.js';
import { quantizeNotes } from './quantizer.js';

// Timing tiers, measured from the note's written position
const PERFECT_MS = 50;
const GOOD_MS = 150;
const ALMOST_MS = 350;

// What a played note is worth. "almost" is half credit: it was the right note
// at roughly the right time, which is not the same as missing it.
const GRADE_CREDIT = { perfect: 1, good: 1, almost: 0.5, miss: 0 };

let expectedNotes = []; // { id, pitch, startTimeMs, durationMs, grade, latencyMs }
let playedNotes = [];   // { pitch, time, matched }
let cleanupFns = [];
let sessionRange = null; // { startMs, endMs } when training a section

export function startAccuracy(composition, range = null) {
  const { tempo, timeSignature } = composition;
  const quantized = quantizeNotes(composition.notes, tempo, timeSignature, state.ui.quantize);
  const beatMs = (60 / tempo) * 1000;

  sessionRange = range;
  expectedNotes = quantized
    .map(n => ({
      id: n.id,
      pitch: n.pitch,
      startTimeMs: n.startBeats * beatMs,
      durationMs: n.durationBeats * beatMs,
      grade: null,
      latencyMs: null,
    }))
    // Training a section only grades what is inside it
    .filter(n => !range || (n.startTimeMs >= range.startMs - 1 && n.startTimeMs < range.endMs));

  playedNotes = [];
  update('accuracy.active', true);
  update('accuracy.results', []);
  emitProgress();

  const onNoteOn = ({ pitch }) => {
    const currentTime = state.transport.currentTime;
    const playedNote = { pitch, time: currentTime, matched: false };
    playedNotes.push(playedNote);
    checkHit(pitch, currentTime, playedNote);
  };

  cleanupFns.forEach(fn => fn()); // clean up any previous session listener
  cleanupFns = [on('midi:noteon', onNoteOn)];
}

function gradeFor(distanceMs) {
  if (distanceMs <= PERFECT_MS) return 'perfect';
  if (distanceMs <= GOOD_MS) return 'good';
  return 'almost';
}

function checkHit(pitch, time, playedNote) {
  // Closest ungraded note of the same pitch still inside the window
  let best = null;
  let bestDist = Infinity;

  for (const expected of expectedNotes) {
    if (expected.pitch !== pitch) continue;
    if (expected.grade !== null) continue;

    const dist = Math.abs(expected.startTimeMs - time);
    if (dist <= ALMOST_MS && dist < bestDist) {
      bestDist = dist;
      best = expected;
    }
  }

  if (best) {
    best.grade = gradeFor(bestDist);
    best.latencyMs = time - best.startTimeMs;
    playedNote.matched = true;
    emit('accuracy:note', {
      noteId: best.id,
      pitch: best.pitch,
      grade: best.grade,
      latencyMs: best.latencyMs,
    });
  } else {
    // Nothing it could have been: a wrong note
    emit('accuracy:wrong', { pitch, time });
  }
  emitProgress();
}

// Running score, for the live gauge
function emitProgress() {
  const graded = expectedNotes.filter(n => n.grade !== null);
  const wrong = playedNotes.filter(n => !n.matched).length;
  const credit = graded.reduce((sum, n) => sum + GRADE_CREDIT[n.grade], 0);

  emit('accuracy:progress', {
    played: graded.length,
    total: expectedNotes.length,
    wrong,
    score: graded.length ? Math.round((credit / graded.length) * 100) : 100,
  });
}

export function stopAccuracy() {
  cleanupFns.forEach(fn => fn());
  cleanupFns = [];

  for (const n of expectedNotes) {
    if (n.grade === null) n.grade = 'miss';
  }

  const results = computeResults();
  update('accuracy.results', results);
  update('accuracy.active', false);
  emit('accuracy:complete', results);
  return results;
}

function countGrade(grade) {
  return expectedNotes.filter(n => n.grade === grade).length;
}

function computeResults() {
  const total = expectedNotes.length;
  if (total === 0) {
    return { score: 0, perfect: 0, good: 0, almost: 0, correct: 0, missed: 0, extra: 0, avgLatencyMs: 0, total: 0 };
  }

  const perfect = countGrade('perfect');
  const good = countGrade('good');
  const almost = countGrade('almost');
  const missed = countGrade('miss');
  const extra = playedNotes.filter(n => !n.matched).length;

  const latencies = expectedNotes.filter(n => n.latencyMs !== null).map(n => Math.abs(n.latencyMs));
  const avgLatencyMs = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  const credit = perfect + good + almost * GRADE_CREDIT.almost;
  const score = Math.round((credit / total) * 100);

  return { score, perfect, good, almost, correct: perfect + good, missed, extra, avgLatencyMs, total };
}

export function getAccuracyResults() {
  return expectedNotes.map(n => ({
    noteId: n.id,
    grade: n.grade,
    // Kept for callers that only care whether it counted as a hit
    hit: n.grade === 'perfect' || n.grade === 'good',
    latencyMs: n.latencyMs,
  }));
}

export function getSessionRange() {
  return sessionRange;
}

// ── Where it went worst ──────────────────────────────────────────────────────
// Misses, near-misses and wrong notes are bucketed by bar, then the worst run
// of consecutive bars is returned so it can be practised on its own.

const SECTION_BARS = 2;

export function getWorstSection(composition) {
  if (!expectedNotes.length) return null;

  const { tempo, timeSignature } = composition;
  const beatMs = (60 / tempo) * 1000;
  const barMs = timeSignature.numerator * (4 / timeSignature.denominator) * beatMs;
  if (!barMs) return null;

  const lastMs = Math.max(
    ...expectedNotes.map(n => n.startTimeMs),
    ...playedNotes.map(n => n.time),
    0
  );
  const barCount = Math.floor(lastMs / barMs) + 1;
  const errors = new Array(barCount).fill(0);

  const bucket = (ms) => Math.min(barCount - 1, Math.max(0, Math.floor(ms / barMs)));
  for (const n of expectedNotes) {
    if (n.grade === 'miss') errors[bucket(n.startTimeMs)] += 1;
    else if (n.grade === 'almost') errors[bucket(n.startTimeMs)] += 0.5;
  }
  for (const n of playedNotes) {
    if (!n.matched) errors[bucket(n.time)] += 1;
  }

  let bestStart = 0;
  let bestScore = -1;
  for (let start = 0; start + 1 <= barCount; start++) {
    const end = Math.min(barCount, start + SECTION_BARS);
    let sum = 0;
    for (let i = start; i < end; i++) sum += errors[i];
    if (sum > bestScore) { bestScore = sum; bestStart = start; }
  }

  if (bestScore <= 0) return null; // nothing went wrong worth repeating

  // Bars, not milliseconds: the tempo can move between the run that produced
  // this section and the retry that practises it, and the section has to
  // follow the music rather than the clock.
  return {
    startBar: bestStart + 1,
    endBar: Math.min(barCount, bestStart + SECTION_BARS),
    errors: bestScore,
  };
}
