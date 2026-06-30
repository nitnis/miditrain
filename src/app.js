// Main application entry point
import { initMidi } from './midi.js';
import { initUI } from './ui.js';
import { on, emit, state } from './state.js';
import { scheduleNotePreview } from './metronome.js';

async function boot() {
  // Initialize UI first (draws empty staves)
  initUI();

  // Initialize MIDI (may show warning if unavailable)
  await initMidi();

  // Preview incoming MIDI notes as sound while not recording/playing
  on('midi:noteon', ({ pitch, velocity }) => {
    if (state.transport.mode === 'stopped') {
      scheduleNotePreview(pitch, 500);
    }
    // Update keyboard display
    emit('ui:activenotes', state.midi.activeNotes);
  });

  on('midi:noteoff', () => {
    emit('ui:activenotes', state.midi.activeNotes);
  });

  console.log('MidiTrain ready.');
}

boot().catch(err => {
  console.error('Boot error:', err);
  document.getElementById('toast').textContent = `Error: ${err.message}`;
  document.getElementById('toast').classList.remove('hidden');
});
