// Accuracy tracking: compare live MIDI input against expected notes during playback
import { state, update, emit, on } from './state.js';
import { quantizeNotes } from './quantizer.js';

const HIT_WINDOW_MS = 200;   // ±200ms counts as a hit
const LATE_WINDOW_MS = 450;  // ±450ms counts as "late"

let expectedNotes = []; // { pitch, startTimeMs, endTimeMs, id, hit, latencyMs }
let playedNotes = [];   // { pitch, time, matched }
let cleanupFns = [];

export function startAccuracy(composition) {
  const { tempo, timeSignature } = composition;
  const quantized = quantizeNotes(composition.notes, tempo, timeSignature, state.ui.quantize);

  expectedNotes = quantized.map(n => ({
    id: n.id,
    pitch: n.pitch,
    startTimeMs: n.startBeats * (60 / tempo) * 1000,
    durationMs: n.durationBeats * (60 / tempo) * 1000,
    hit: null,
    latencyMs: null,
  }));

  playedNotes = [];
  update('accuracy.active', true);
  update('accuracy.results', []);

  const onNoteOn = ({ pitch, perf }) => {
    const currentTime = state.transport.currentTime;
    playedNotes.push({ pitch, time: currentTime, matched: false });
    checkHit(pitch, currentTime);
  };

  const unsubOn = on('midi:noteon', onNoteOn);
  cleanupFns = [unsubOn];
}

function checkHit(pitch, time) {
  // Find closest expected note with matching pitch and within window
  let best = null;
  let bestDist = Infinity;

  for (const expected of expectedNotes) {
    if (expected.pitch !== pitch) continue;
    if (expected.hit !== null) continue; // already matched

    const dist = Math.abs(expected.startTimeMs - time);
    if (dist < LATE_WINDOW_MS && dist < bestDist) {
      bestDist = dist;
      best = expected;
    }
  }

  if (best) {
    best.hit = bestDist <= HIT_WINDOW_MS;
    best.latencyMs = time - best.startTimeMs;
    best.matched = true;
    emit('accuracy:note', { noteId: best.id, hit: best.hit, latencyMs: best.latencyMs });
  }
}

export function stopAccuracy() {
  cleanupFns.forEach(fn => fn());
  cleanupFns = [];

  // Mark remaining unmatched expected notes as missed
  for (const n of expectedNotes) {
    if (n.hit === null) n.hit = false;
  }

  const results = computeResults();
  update('accuracy.results', results);
  update('accuracy.active', false);
  emit('accuracy:complete', results);
  return results;
}

function computeResults() {
  const total = expectedNotes.length;
  if (total === 0) return { score: 0, correct: 0, missed: 0, extra: 0, avgLatencyMs: 0 };

  const correct = expectedNotes.filter(n => n.hit === true).length;
  const missed  = expectedNotes.filter(n => n.hit === false).length;
  const extra   = playedNotes.filter(n => !n.matched).length;

  const latencies = expectedNotes.filter(n => n.latencyMs !== null).map(n => Math.abs(n.latencyMs));
  const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  const score = Math.round((correct / total) * 100);

  return { score, correct, missed, extra, avgLatencyMs, total };
}

export function getAccuracyResults() {
  return expectedNotes.map(n => ({
    noteId: n.id,
    hit: n.hit,
    latencyMs: n.latencyMs,
  }));
}
