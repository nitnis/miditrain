// Transport engine: record, play, stop, seek
import { state, update, emit, on } from './state.js';
import { startMetronome, stopMetronome, scheduleCountInClicks } from './metronome.js';
import { startPlaybackAudio, stopPlaybackAudio, stopAllAudio } from './audio.js';
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
  if (state.transport.mode === 'playing') startPlaybackAudio(state.transport.currentTime);
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
  startPlaybackAudio(posStart);

  rafId = requestAnimationFrame(loop);
  emit('transport:play');
}

// Halt where we are. This is what the Pause button does, and what everything
// internally means by "stop" — record(), play() and seekTo() all rely on it
// leaving the position alone.
export function stop() {
  if (state.transport.mode === 'count-in') {
    cancelCountIn();
    update('transport.mode', 'stopped');
    emit('transport:countin-end');
    emit('transport:stop');
    return;
  }

  // step-recording mode: just transition; step-recorder cleans up via mode-change listener
  if (state.transport.mode === 'step-recording') {
    stopAllAudio();
    update('transport.mode', 'stopped');
    emit('transport:stop');
    return;
  }

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
  stopPlaybackAudio();
  if (state.transport.mode === 'stopped') return; // idempotent: no event when already stopped
  update('transport.mode', 'stopped');
  emit('transport:stop');
}

// Halt and return to the beginning. This is what the Stop button does.
export function stopAndRewind() {
  stop();
  update('transport.currentTime', 0);
  emit('transport:stop');
}

// ── Count-in ─────────────────────────────────────────────────────────────────

let countInTimers = [];

function cancelCountIn() {
  countInTimers.forEach(clearTimeout);
  countInTimers = [];
}

// Click out one bar, then hand over to `onComplete`. The clicks are scheduled
// on the audio clock; the timers only drive the on-screen count, so a late
// timer cannot shift where recording actually begins.
export function startCountIn(onComplete) {
  cancelCountIn();
  stop();

  const { tempo, timeSignature } = state.composition;
  const beats = Math.max(1, timeSignature.numerator);
  const beatMs = (60 / tempo) * 1000;
  const leadMs = scheduleCountInClicks(beats, tempo, timeSignature) * 1000;

  update('transport.mode', 'count-in');
  emit('transport:countin-start', { total: beats });

  for (let i = 0; i < beats; i++) {
    countInTimers.push(setTimeout(
      () => emit('transport:countin', { beat: i + 1, total: beats }),
      leadMs + i * beatMs
    ));
  }

  countInTimers.push(setTimeout(() => {
    cancelCountIn();
    // Leave count-in mode first. record()/play() begin by calling stop(), and
    // from count-in that emits transport:stop — which would tear down the
    // accuracy session training had just started.
    update('transport.mode', 'stopped');
    emit('transport:countin-end');
    onComplete();
  }, leadMs + beats * beatMs));
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

export function updateNote(noteId, changes) {
  const note = state.composition.notes.find(n => n.id === noteId);
  if (!note) return;
  Object.assign(note, changes);
  emit('transport:noteschanged', state.composition.notes);
}

export function deleteNotes(noteIds) {
  const ids = new Set(noteIds);
  state.composition.notes = state.composition.notes.filter(n => !ids.has(n.id));
  emit('transport:noteschanged', state.composition.notes);
}

export function transposeNotes(noteIds, semitones) {
  for (const id of noteIds) {
    const note = state.composition.notes.find(n => n.id === id);
    if (note) note.pitch = Math.max(21, Math.min(108, note.pitch + semitones));
  }
  emit('transport:noteschanged', state.composition.notes);
}

export function applyLegato(noteIds) {
  const selected = state.composition.notes
    .filter(n => noteIds.has(n.id))
    .sort((a, b) => a.startTime - b.startTime);
  for (let i = 0; i < selected.length - 1; i++) {
    const next = selected[i + 1];
    selected[i].duration = next.startTime - selected[i].startTime;
  }
  emit('transport:noteschanged', state.composition.notes);
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
