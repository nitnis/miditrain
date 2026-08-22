// Main application entry point
import { initMidi } from './midi.js';
import { initUI } from './ui.js';
import { on, emit, state } from './state.js';
import { monitorNoteOn, noteOff as audioNoteOff } from './audio.js';
import { restoreSettings, restoreComposition, initSession } from './session.js';
import { loadProfiles } from './profiles.js';

async function boot() {
  // Last session first, so the UI is built from where the app was left rather
  // than from defaults it would then have to be talked out of
  loadProfiles();
  restoreSettings();
  await restoreComposition();

  initUI();
  initSession();

  // Monitor incoming MIDI in every mode — stopped, live recording and step
  // recording all sound the key you press. Registered before MIDI init: that
  // await sits on a permission prompt that can stay pending indefinitely, and
  // anything registered after it would never attach.
  on('midi:noteon', ({ pitch, velocity }) => {
    monitorNoteOn(pitch, velocity);
    emit('ui:activenotes', state.midi.activeNotes);
  });

  on('midi:noteoff', ({ pitch }) => {
    audioNoteOff(pitch);
    emit('ui:activenotes', state.midi.activeNotes);
  });

  // Initialize MIDI (may show warning if unavailable)
  await initMidi();

  console.log('MidiTrain ready.');
}

boot().catch(err => {
  console.error('Boot error:', err);
  document.getElementById('toast').textContent = `Error: ${err.message}`;
  document.getElementById('toast').classList.remove('hidden');
});
