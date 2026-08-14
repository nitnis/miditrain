// Step-time recording: write notes one step at a time, no real-time clock
import { state, update, emit, on } from './state.js';
import { beatsToMs } from './quantizer.js';

let cleanupFns = [];
let pendingNotes = new Map(); // pitch -> velocity
let lastChord = [];           // notes from the previous step, for legato holding
let chordTimer = null;
const CHORD_WINDOW_MS = 80; // collect simultaneous notes into one chord

// How much of its step a note actually sounds for. Filling the step exactly
// leaves nothing for legato to extend — with one note per step the switch made
// no difference at all — so notes are written slightly detached by default and
// overrun the next attack under legato, which is what makes them blend.
const DETACHED_GATE = 0.8;
const LEGATO_OVERLAP_RATIO = 0.3;
const LEGATO_OVERLAP_MIN_MS = 40;

// Capped below half a step so quantizing always rounds the overlap back off.
// Past that the written note would gain a step and pick up a spurious tie.
function legatoOverlap(stepMs) {
  return Math.min(stepMs * 0.45, Math.max(LEGATO_OVERLAP_MIN_MS, stepMs * LEGATO_OVERLAP_RATIO));
}

// Sounding length for a note occupying `spanMs` of written time. Quantizing
// snaps both back to the same written value, so this changes articulation
// without changing the notation.
function soundingDuration(spanMs, stepMs) {
  return state.ui.stepLegato ? spanMs + legatoOverlap(stepMs) : spanMs * DETACHED_GATE;
}

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
  lastChord = [];
  update('transport.mode', 'step-recording');
  // Entering step mode from an arbitrary playback position would write every
  // step off the grid, so square the cursor up to the nearest step boundary.
  const stepMs = getStepMs();
  update('transport.currentTime', Math.round(state.transport.currentTime / stepMs) * stepMs);
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
  lastChord = [];
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
  // A legato note started earlier and was stretched over this step; pull it back
  for (const note of state.composition.notes) {
    if (note.startTime < prevPos && note.startTime + note.duration > prevPos) {
      note.duration = soundingDuration(Math.max(stepMs, prevPos - note.startTime), stepMs);
    }
  }
  lastChord = lastChord.filter(n => state.composition.notes.includes(n));
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

  const committed = [];
  for (const [pitch, velocity] of pendingNotes) {
    const note = {
      id: crypto.randomUUID(),
      pitch,
      velocity,
      startTime: stepPos,
      duration: soundingDuration(stepMs, stepMs),
    };
    state.composition.notes.push(note);
    committed.push(note);
  }
  lastChord = committed;
  pendingNotes.clear();
  emit('transport:noteschanged', state.composition.notes);
  advanceStep();
}

function advanceStep() {
  const stepMs = getStepMs();
  const next = state.transport.currentTime + stepMs;

  // Legato: the note you wrote keeps sounding through the steps you skip, so
  // advancing lengthens it rather than leaving a rest behind. This is how a
  // note longer than one step gets written at all.
  if (state.ui.stepLegato && lastChord.length) {
    for (const note of lastChord) {
      note.duration = soundingDuration(Math.max(stepMs, next - note.startTime), stepMs);
    }
    emit('transport:noteschanged', state.composition.notes);
  }

  update('transport.currentTime', next);
}
