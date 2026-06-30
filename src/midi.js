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

function onMidiMessage(e) {
  const [status, data1, data2] = e.data;
  const cmd = status >> 4;

  if (cmd === 9 && data2 > 0) {
    noteOn(data1, data2, e.timeStamp);
  } else if (cmd === 8 || (cmd === 9 && data2 === 0)) {
    noteOff(data1, e.timeStamp);
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

function noteOff(pitch, timeStamp) {
  state.midi.activeNotes.delete(pitch);
  emit('midi:noteoff', { pitch, perf: performance.now() });
}

function refreshInputList() {
  if (!midiAccess) return;
  const inputs = [];
  midiAccess.inputs.forEach(i => inputs.push({ id: i.id, name: i.name, state: i.state }));
  update('midi.inputs', inputs);
  update('midi.connected', inputs.some(i => i.state === 'connected'));
}

export function getPendingNoteOn(pitch) {
  return pendingNoteOns.get(pitch);
}

export function clearPendingNoteOn(pitch) {
  pendingNoteOns.delete(pitch);
}
