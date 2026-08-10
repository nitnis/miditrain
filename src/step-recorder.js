// Step-time recording: write notes one step at a time, no real-time clock
import { state, update, emit, on } from './state.js';
import { beatsToMs } from './quantizer.js';

let cleanupFns = [];
let pendingNotes = new Map(); // pitch -> velocity
let chordTimer = null;
const CHORD_WINDOW_MS = 80; // collect simultaneous notes into one chord

// Step size is the quantize value, so recorded steps always land on the grid
// the notation is snapped to.
export function getStepMs() {
  const beats = 4 / state.ui.quantize;
  return beatsToMs(beats, state.composition.tempo);
}

export function startStepRecord() {
  if (state.transport.mode === 'step-recording') return;
  cleanupFns.forEach(fn => fn());
  cleanupFns = [];
  pendingNotes.clear();
  update('transport.mode', 'step-recording');
  cleanupFns = [
    on('midi:noteon', handleNoteOn),
    on('change:transport.mode', handleModeChange),
  ];
  emit('transport:step-record');
}

export function stopStepRecord() {
  clearTimeout(chordTimer);
  chordTimer = null;
  pendingNotes.clear();
  cleanupFns.forEach(fn => fn());
  cleanupFns = [];
  if (state.transport.mode === 'step-recording') {
    update('transport.mode', 'stopped');
    emit('transport:stop');
  }
}

export function stepInsertRest() {
  if (state.transport.mode !== 'step-recording') return;
  advanceStep();
}

export function stepGoBack() {
  if (state.transport.mode !== 'step-recording') return;
  const stepMs = getStepMs();
  const pos = state.transport.currentTime;
  const prevPos = Math.max(0, pos - stepMs);
  // Remove notes placed at the previous step
  state.composition.notes = state.composition.notes.filter(
    n => !(n.startTime >= prevPos - 1 && n.startTime < pos)
  );
  update('transport.currentTime', prevPos);
  emit('transport:noteschanged', state.composition.notes);
}

function handleModeChange({ value }) {
  if (value !== 'step-recording') {
    // Cleaned up externally (e.g. stop() called from transport)
    clearTimeout(chordTimer);
    pendingNotes.clear();
    cleanupFns.forEach(fn => fn());
    cleanupFns = [];
  }
}

function handleNoteOn({ pitch, velocity }) {
  if (state.transport.mode !== 'step-recording') return;
  pendingNotes.set(pitch, velocity);
  clearTimeout(chordTimer);
  chordTimer = setTimeout(commitChord, CHORD_WINDOW_MS);
}

function commitChord() {
  if (!pendingNotes.size) return;
  const stepMs = getStepMs();
  const stepPos = state.transport.currentTime;

  for (const [pitch, velocity] of pendingNotes) {
    state.composition.notes.push({
      id: crypto.randomUUID(),
      pitch,
      velocity,
      startTime: stepPos,
      duration: stepMs,
    });
  }
  pendingNotes.clear();
  emit('transport:noteschanged', state.composition.notes);
  advanceStep();
}

function advanceStep() {
  update('transport.currentTime', state.transport.currentTime + getStepMs());
}
