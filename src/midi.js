// Web MIDI API integration
import { state, update, emit } from './state.js';

let midiAccess = null;
const pendingNoteOns = new Map(); // pitch -> { startPerf, velocity }

export async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    emit('midi:unavailable', { reason: 'Web MIDI API not supported in this browser' });
    return false;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    update('midi.available', true);
    midiAccess.addEventListener('statechange', onPortStateChange);
    midiAccess.inputs.forEach(connectInput);
    refreshInputList();
    return true;
  } catch (e) {
    console.warn('MIDI access denied:', e.message);
    emit('midi:unavailable', { reason: e.message });
    return false;
  }
}

function onPortStateChange(e) {
  if (e.port.type === 'input') {
    if (e.port.state === 'connected') connectInput(e.port);
    refreshInputList();
    emit('midi:statechange', { port: { id: e.port.id, name: e.port.name, state: e.port.state } });
  }
}

function connectInput(input) {
  input.onmidimessage = onMidiMessage;
}

// ── Which controllers are listened to ────────────────────────────────────────
// A studio desk can present half a dozen ports — a drum pad, a control surface,
// a virtual loopback — and any of them sending notes lands in the piece or is
// graded as a wrong note. Each one can be switched off.
//
// The list holds the ones switched *off*, so a controller plugged in for the
// first time works without having to be found and enabled first, and a stored
// id belonging to a device no longer present simply never matches.

export function isInputEnabled(id) {
  return !state.midi.disabledInputs.includes(id);
}

export function setInputEnabled(id, enabled) {
  const off = state.midi.disabledInputs.filter(x => x !== id);
  if (!enabled) off.push(id);
  update('midi.disabledInputs', off);

  // A key held down on a controller that has just been switched off would
  // otherwise stay down for good, since its note-off is about to be ignored
  if (!enabled) releaseHeldNotes();
  refreshInputList();
}

function releaseHeldNotes() {
  for (const pitch of [...state.midi.activeNotes]) noteOff(pitch);
}

function onMidiMessage(e) {
  // e.target is the port the message arrived on
  if (e.target && !isInputEnabled(e.target.id)) return;

  const [status, data1, data2] = e.data;
  const cmd = status >> 4;

  if (cmd === 9 && data2 > 0) {
    noteOn(data1, data2, e.timeStamp);
  } else if (cmd === 8 || (cmd === 9 && data2 === 0)) {
    noteOff(data1);
  } else if (cmd === 11) {
    emit('midi:cc', { controller: data1, value: data2 });
  }
}

function noteOn(pitch, velocity, timeStamp) {
  const perf = performance.now();
  pendingNoteOns.set(pitch, { perf, velocity });
  state.midi.activeNotes.add(pitch);
  emit('midi:noteon', { pitch, velocity, perf });
}

function noteOff(pitch) {
  state.midi.activeNotes.delete(pitch);
  emit('midi:noteoff', { pitch, perf: performance.now() });
}

function refreshInputList() {
  if (!midiAccess) return;
  const inputs = [];
  midiAccess.inputs.forEach(i => inputs.push({
    id: i.id, name: i.name, state: i.state, enabled: isInputEnabled(i.id),
  }));
  update('midi.inputs', inputs);
  // Connected means something can actually be played on, so a device that is
  // present but switched off does not count
  update('midi.connected', inputs.some(i => i.state === 'connected' && i.enabled));
}

export function getPendingNoteOn(pitch) {
  return pendingNoteOns.get(pitch);
}

export function clearPendingNoteOn(pitch) {
  pendingNoteOns.delete(pitch);
}
