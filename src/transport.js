// Transport engine: record, play, stop, seek
import { state, update, emit, on } from './state.js';
import { startMetronome, stopMetronome } from './metronome.js';
import { barStartMs } from './quantizer.js';

let rafId = null;
let perfStart = 0;   // performance.now() when transport was (re)started
let posStart = 0;    // composition time (ms) when transport was (re)started
let activeRecordNotes = new Map(); // pitch -> {startTime, velocity}

function currentPosition() {
  return posStart + (performance.now() - perfStart) * state.transport.speed;
}

function getCompositionDuration() {
  const notes = state.composition.notes;
  if (!notes.length) return 0;
  return notes.reduce((max, n) => Math.max(max, n.startTime + n.duration), 0);
}

// Restart playback at a new position without emitting transport:stop (used for loop wrap)
function restartAt(ms) {
  cancelAnimationFrame(rafId);
  rafId = null;
  stopMetronome();
  update('transport.currentTime', Math.max(0, ms));
  perfStart = performance.now();
  posStart = state.transport.currentTime;
  if (state.ui.metronomeEnabled) startMetronome(0);
  rafId = requestAnimationFrame(loop);
}

function loop() {
  const t = currentPosition();
  update('transport.currentTime', t);

  // Check loop bounds
  if (state.transport.loopEnabled) {
    const loopEndMs = barStartMs(state.transport.loopEndBar, state.composition.tempo, state.composition.timeSignature);
    if (t >= loopEndMs) {
      const loopStartMs = barStartMs(state.transport.loopStartBar - 1, state.composition.tempo, state.composition.timeSignature);
      restartAt(loopStartMs);
      return;
    }
  }

  // Auto-stop at end in play mode
  if (state.transport.mode === 'playing') {
    const duration = getCompositionDuration();
    if (duration > 0 && t > duration + 500) {
      stop();
      return;
    }
  }

  emit('transport:tick', t);
  rafId = requestAnimationFrame(loop);
}

export function record() {
  if (state.transport.mode === 'recording') return;
  stop();
  update('transport.mode', 'recording');
  perfStart = performance.now();
  posStart = state.transport.currentTime;
  activeRecordNotes.clear();

  if (state.ui.metronomeEnabled) startMetronome(0);

  // Listen for MIDI notes
  on('midi:noteon', handleRecordNoteOn);
  on('midi:noteoff', handleRecordNoteOff);

  rafId = requestAnimationFrame(loop);
  emit('transport:record');
}

export function play() {
  if (state.transport.mode === 'playing') return;
  stop();
  update('transport.mode', 'playing');
  perfStart = performance.now();
  posStart = state.transport.currentTime;

  if (state.ui.metronomeEnabled) startMetronome(0);

  rafId = requestAnimationFrame(loop);
  emit('transport:play');
}

export function stop() {
  cancelAnimationFrame(rafId);
  rafId = null;

  if (state.transport.mode === 'recording') {
    // Finalize any held notes
    const t = currentPosition();
    for (const [pitch, info] of activeRecordNotes) {
      finalizeNote(pitch, info, t);
    }
    activeRecordNotes.clear();
    emit('transport:noteschanged', state.composition.notes);
  }

  stopMetronome();
  update('transport.mode', 'stopped');
  emit('transport:stop');
}

export function seekTo(ms) {
  const wasMode = state.transport.mode;
  stop();
  update('transport.currentTime', Math.max(0, ms));
  if (wasMode === 'playing') play();
  else if (wasMode === 'recording') record();
}

export function seekToStart() {
  seekTo(0);
}

export function seekToEnd() {
  seekTo(getCompositionDuration());
}

function handleRecordNoteOn({ pitch, velocity, perf }) {
  if (state.transport.mode !== 'recording') return;
  const startTime = posStart + (perf - perfStart) * state.transport.speed;
  activeRecordNotes.set(pitch, { startTime, velocity });
  emit('transport:recordnote', { pitch, startTime });
}

function handleRecordNoteOff({ pitch, perf }) {
  if (state.transport.mode !== 'recording') return;
  const info = activeRecordNotes.get(pitch);
  if (!info) return;
  activeRecordNotes.delete(pitch);
  const endTime = posStart + (perf - perfStart) * state.transport.speed;
  finalizeNote(pitch, info, endTime);
}

function finalizeNote(pitch, info, endTime) {
  const duration = Math.max(50, endTime - info.startTime);
  const note = {
    id: crypto.randomUUID(),
    pitch,
    velocity: info.velocity,
    startTime: info.startTime,
    duration,
  };
  state.composition.notes.push(note);
  emit('transport:noteschanged', state.composition.notes);
}

export function deleteNote(noteId) {
  const idx = state.composition.notes.findIndex(n => n.id === noteId);
  if (idx !== -1) {
    state.composition.notes.splice(idx, 1);
    emit('transport:noteschanged', state.composition.notes);
  }
}

export function clearAllNotes() {
  state.composition.notes = [];
  update('transport.currentTime', 0);
  emit('transport:noteschanged', []);
}

export function getCurrentTime() {
  if (state.transport.mode === 'stopped') return state.transport.currentTime;
  return currentPosition();
}
