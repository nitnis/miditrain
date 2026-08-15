// Learn mode: walk the piece one attack at a time.
//
// The notes fall at tempo until the next one reaches the hit line, then
// everything freezes: the chord sounds once as a prompt, and the clock does
// not move again until exactly those keys have been played.
//
// This is much closer to step recording than to playback — an input-driven
// mode with its own clock — so it runs beside transport.js rather than through
// it, and cleans itself up when something else takes the transport, the same
// way the step recorder does.
import { state, update, emit, on } from './state.js';
import { noteOn, noteOff, resumeAudioContext } from './audio.js';
import { barRangeMs } from './quantizer.js';

// Notes struck this close together are one thing to play, so they are waited
// on together. Matches the tolerance the slur renderer uses for "same attack".
const CHORD_MS = 40;

// How long the prompt chord sounds if nothing interrupts it. It steps aside
// the moment the first correct key goes down, so this is only the ceiling.
const PROMPT_MIN_MS = 250;
const PROMPT_MAX_MS = 900;

let groups = [];        // [{ startMs, durationMs, pitches:Set, notes:[] }]
let index = -1;
let pending = new Set();  // pitches of the current group not yet played
let prompting = [];       // pitches the prompt is holding down
let promptTimer = null;
let rafId = null;         // non-null only while the notes are falling
let perfStart = 0;
let posStart = 0;
let targetMs = 0;
let cleanupFns = [];

// Section practice. The loop range is already the app's way of naming a
// stretch of bars, so learn mode reads the same one — with loop on it repeats
// the section until you get through it without a wrong note, rather than
// looping forever the way playback does.
let sectionStartMs = 0;
let looping = false;
let pass = 1;
let slips = 0;          // wrong notes in the current pass

function loopRange() {
  const { loopEnabled, loopStartBar, loopEndBar } = state.transport;
  if (!loopEnabled) return null;
  const { tempo, timeSignature } = state.composition;
  return barRangeMs(loopStartBar, loopEndBar, tempo, timeSignature);
}

// One entry per attack, in time order
export function groupAttacks(notes) {
  const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);
  const out = [];
  for (const note of sorted) {
    const last = out[out.length - 1];
    // Measured against the group's own start, so a run of notes 40ms apart
    // cannot chain into one arbitrarily wide chord
    if (last && note.startTime - last.startMs <= CHORD_MS) {
      last.pitches.add(note.pitch);
      last.notes.push(note);
      last.durationMs = Math.max(last.durationMs, note.duration);
    } else {
      out.push({
        startMs: note.startTime,
        durationMs: note.duration,
        pitches: new Set([note.pitch]),
        notes: [note],
      });
    }
  }
  return out;
}

// `bars` walks just that stretch and leaves the repeat-until-clean behaviour
// off — the section walk offers its own choice at the end of each one. With no
// bars given it falls back to the loop range, which is the standalone drill.
export function startLearn(bars = null) {
  if (state.transport.mode === 'learning') return false;

  const { tempo, timeSignature } = state.composition;
  const section = bars
    ? barRangeMs(bars.startBar, bars.endBar, tempo, timeSignature)
    : loopRange();
  looping = Boolean(section) && !bars;
  sectionStartMs = section ? section.startMs : 0;
  groups = groupAttacks(state.composition.notes)
    .filter(g => !section || (g.startMs >= section.startMs && g.startMs < section.endMs));
  if (!groups.length) return false;

  resumeAudioContext();
  releaseListeners();
  index = -1;
  pass = 1;
  slips = 0;
  update('transport.currentTime', sectionStartMs);
  update('transport.mode', 'learning');
  // Registered after the mode change, so entering the mode cannot trip the
  // listener that exists to notice something else leaving it
  cleanupFns = [
    on('midi:noteon', handleNoteOn),
    on('change:transport.mode', ({ value }) => { if (value !== 'learning') finish(false); }),
  ];
  emit('transport:learn', {
    total: groups.length,
    looping,
    startBar: bars ? bars.startBar : (looping ? state.transport.loopStartBar : null),
    endBar: bars ? bars.endBar : (looping ? state.transport.loopEndBar : null),
    walking: Boolean(bars),
  });
  goTo(0);
  return true;
}

export function stopLearn() {
  finish(false);
}

export function getLearnProgress() {
  if (!groups.length || index < 0) return null;
  return { done: index, total: groups.length, pending: [...pending], looping, pass, slips };
}

function releaseListeners() {
  cleanupFns.forEach(fn => fn());
  cleanupFns = [];
}

function finish(completed) {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  clearPrompt();
  releaseListeners();
  pending.clear();
  emit('learn:waiting', { pitches: [], done: index, total: groups.length, looping, pass, slips });
  if (completed) {
    emit('learn:pass', { pass, slips, clean: slips === 0, total: groups.length });
    emit('learn:complete', { total: groups.length, passes: pass, looping });
  }
  // Already out of the mode when something else stopped us — saying so twice
  // would bounce back through the mode listener
  if (state.transport.mode === 'learning') {
    update('transport.mode', 'stopped');
    emit('transport:stop');
  }
}

function goTo(i) {
  // End of the section. Looping means going again until a pass is clean —
  // "correctly" can only mean without a wrong note, since learn mode will not
  // move past a note until the right one is played anyway.
  if (i >= groups.length) {
    if (looping && slips > 0) { restartPass(); return; }
    finish(true);
    return;
  }

  index = i;

  pending = new Set(groups[i].pitches);
  targetMs = groups[i].startMs;
  perfStart = performance.now();
  posStart = state.transport.currentTime;

  if (posStart >= targetMs) { arrive(); return; }
  rafId = requestAnimationFrame(fall);
}

// The only time the clock moves: between one attack and the next
function fall() {
  const t = posStart + (performance.now() - perfStart) * (state.transport.speed || 1);
  if (t >= targetMs) { arrive(); return; }
  update('transport.currentTime', t);
  emit('transport:tick', t);
  rafId = requestAnimationFrame(fall);
}

function arrive() {
  rafId = null;
  update('transport.currentTime', targetMs);
  emit('transport:tick', targetMs);
  playPrompt(groups[index]);
  announce();
}

function restartPass() {
  clearPrompt();
  emit('learn:pass', { pass, slips, clean: false, total: groups.length });
  pass += 1;
  slips = 0;
  index = -1;
  update('transport.currentTime', sectionStartMs);
  goTo(0);
}

function announce() {
  emit('learn:waiting', {
    pitches: [...pending], done: index, total: groups.length, looping, pass, slips,
  });
}

function playPrompt(group) {
  clearPrompt();
  for (const note of group.notes) {
    noteOn(note.pitch, note.velocity ?? 90);
    prompting.push(note.pitch);
  }
  const ms = Math.min(PROMPT_MAX_MS, Math.max(PROMPT_MIN_MS, group.durationMs));
  promptTimer = setTimeout(clearPrompt, ms);
}

function clearPrompt() {
  clearTimeout(promptTimer);
  promptTimer = null;
  for (const pitch of prompting) {
    // A pitch the player is holding is theirs now — the prompt and the live
    // monitor share one voice per pitch, so releasing it would cut their note
    if (!state.midi.activeNotes.has(pitch)) noteOff(pitch);
  }
  prompting = [];
}

function handleNoteOn({ pitch }) {
  // Input counts only at the wait, never while the notes are still falling
  if (state.transport.mode !== 'learning' || rafId !== null) return;

  if (!pending.has(pitch)) {
    slips += 1;
    emit('learn:wrong', { pitch, slips });
    if (looping) announce();
    return;
  }

  clearPrompt(); // the prompt steps aside as soon as the player starts
  pending.delete(pitch);
  emit('learn:hit', { pitch });
  if (pending.size === 0) goTo(index + 1);
  else announce();
}
