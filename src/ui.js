// UI updates: DOM manipulation, modals, controls
import { state, update, emit, on } from './state.js';
import { record, play, stop, seekToStart, seekToEnd, clearAllNotes } from './transport.js';
import { renderSheet, initSheet } from './sheet.js';
import { initPianoRoll, renderPianoRoll } from './pianoroll.js';
import { saveComposition, listCompositions, deleteComposition } from './storage.js';
import { startAccuracy, stopAccuracy } from './accuracy.js';
import { resumeAudioContext, stopMetronome } from './metronome.js';

let sheetContainer = null;
let renderDebounce = null;

export function initUI() {
  sheetContainer = document.getElementById('vexflow-output');
  initSheet(sheetContainer);
  initPianoRoll(
    document.getElementById('falling-canvas'),
    document.getElementById('piano-keyboard')
  );

  bindTransport();
  bindToolbar();
  bindViewTabs();
  bindCompositionControls();
  bindLoopControls();
  bindModalControls();
  bindKeyboardShortcuts();

  // Re-render sheet on notes change
  on('transport:noteschanged', () => scheduleSheetRender());
  on('transport:stop', () => scheduleSheetRender());
  on('transport:tick', (t) => {
    updatePositionDisplay(t);
    if (renderDebounce === null) {
      // Update playhead periodically
      window._lastTickT = t;
    }
  });

  // MIDI status updates
  on('change:midi.connected', ({ value }) => updateMidiStatus(value));
  on('change:midi.inputs', ({ value }) => updateMidiInputsList(value));
  on('midi:unavailable', ({ reason }) => showMidiWarning(reason));
  on('midi:statechange', () => {});

  // Accuracy
  on('accuracy:complete', (results) => showAccuracyResults(results));

  updateMidiStatus(false);
  scheduleSheetRender();
  updateLoopDisplay();

  // Periodic sheet playhead update during playback
  setInterval(() => {
    if (state.transport.mode !== 'stopped') {
      scheduleSheetRender();
    }
  }, 250);
}

function bindTransport() {
  const modeGuard = () => resumeAudioContext();

  document.getElementById('btn-to-start').onclick = () => { modeGuard(); seekToStart(); };
  document.getElementById('btn-stop').onclick = () => { modeGuard(); stop(); };
  document.getElementById('btn-record').onclick = () => {
    modeGuard();
    if (state.transport.mode === 'recording') stop();
    else record();
  };
  document.getElementById('btn-play').onclick = () => {
    modeGuard();
    if (state.transport.mode === 'playing') stop();
    else if (state.ui.trainMode) startTrainingSession();
    else play();
  };
  document.getElementById('btn-to-end').onclick = () => { modeGuard(); seekToEnd?.(); };

  on('transport:record', () => {
    document.getElementById('btn-record').classList.add('active');
    document.getElementById('btn-play').classList.remove('active');
    document.getElementById('btn-play').textContent = '▶';
  });
  on('transport:play', () => {
    document.getElementById('btn-play').classList.add('active');
    document.getElementById('btn-play').textContent = '⏸';
    document.getElementById('btn-record').classList.remove('active');
  });
  on('transport:stop', () => {
    document.getElementById('btn-record').classList.remove('active');
    document.getElementById('btn-play').classList.remove('active');
    document.getElementById('btn-play').textContent = '▶';
    updatePositionDisplay(state.transport.currentTime);
    if (state.ui.trainMode && state.accuracy.active) {
      const results = stopAccuracy();
      showAccuracyResults(results);
    }
  });
}

function startTrainingSession() {
  if (!state.composition.notes.length) {
    showToast('Record something first to train with');
    return;
  }
  startAccuracy(state.composition);
  play();
}

function bindToolbar() {
  const tempoInput = document.getElementById('tempo-input');
  const tempoSlider = document.getElementById('tempo-slider');

  const setTempo = (v) => {
    const bpm = Math.max(20, Math.min(300, parseInt(v) || 120));
    update('composition.tempo', bpm);
    tempoInput.value = bpm;
    tempoSlider.value = bpm;
  };

  tempoInput.oninput = (e) => setTempo(e.target.value);
  tempoSlider.oninput = (e) => setTempo(e.target.value);
  document.getElementById('btn-tempo-down').onclick = () => setTempo(state.composition.tempo - 1);
  document.getElementById('btn-tempo-up').onclick = () => setTempo(state.composition.tempo + 1);

  document.getElementById('ts-num').onchange = (e) => {
    update('composition.timeSignature', { ...state.composition.timeSignature, numerator: parseInt(e.target.value) });
    scheduleSheetRender();
  };
  document.getElementById('ts-den').onchange = (e) => {
    update('composition.timeSignature', { ...state.composition.timeSignature, denominator: parseInt(e.target.value) });
    scheduleSheetRender();
  };

  document.getElementById('btn-metronome').onclick = () => {
    const enabled = !state.ui.metronomeEnabled;
    update('ui.metronomeEnabled', enabled);
    document.getElementById('btn-metronome').classList.toggle('active', enabled);
    if (!enabled) stopMetronome();
  };

  const speedSlider = document.getElementById('speed-slider');
  const speedValue = document.getElementById('speed-value');
  speedSlider.oninput = (e) => {
    const pct = parseInt(e.target.value);
    update('transport.speed', pct / 100);
    speedValue.textContent = `${pct}%`;
  };

  document.getElementById('btn-train-mode').onclick = () => {
    const active = !state.ui.trainMode;
    update('ui.trainMode', active);
    document.getElementById('btn-train-mode').classList.toggle('active', active);
    document.getElementById('btn-play').title = active ? 'Start Training' : 'Play';
    showToast(active ? 'Training mode ON — press Play to start' : 'Training mode OFF');
  };

  document.getElementById('key-select').onchange = (e) => {
    update('composition.keySignature', e.target.value);
    update('ui.keySignature', e.target.value);
    scheduleSheetRender();
  };

  document.getElementById('quantize-select').onchange = (e) => {
    update('ui.quantize', parseInt(e.target.value));
    scheduleSheetRender();
  };

  document.getElementById('btn-clear').onclick = () => {
    if (confirm('Clear all notes?')) clearAllNotes();
  };
}

function bindViewTabs() {
  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.onclick = () => {
      const view = tab.dataset.view;
      update('ui.view', view);
      document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-sheet').classList.toggle('hidden', view === 'piano-roll');
      document.getElementById('panel-roll').classList.toggle('hidden', view !== 'piano-roll');
    };
  });
}

function bindLoopControls() {
  document.getElementById('loop-enabled').onchange = (e) => {
    update('transport.loopEnabled', e.target.checked);
    updateLoopDisplay();
  };
  document.getElementById('loop-start').onchange = (e) => {
    update('transport.loopStartBar', Math.max(1, parseInt(e.target.value) || 1));
  };
  document.getElementById('loop-end').onchange = (e) => {
    update('transport.loopEndBar', Math.max(1, parseInt(e.target.value) || 4));
  };
}

function bindCompositionControls() {
  document.getElementById('btn-new').onclick = () => {
    if (!confirm('Start a new composition? Unsaved changes will be lost.')) return;
    clearAllNotes();
    update('composition.name', 'Untitled');
    update('composition.id', null);
    document.getElementById('composition-name').textContent = 'Untitled';
    seekToStart();
  };

  document.getElementById('btn-save').onclick = async () => {
    const name = document.getElementById('composition-name').textContent.trim() || 'Untitled';
    update('composition.name', name);
    const saved = await saveComposition({ ...state.composition });
    update('composition.id', saved.id);
    showToast('Saved!');
  };

  document.getElementById('btn-open').onclick = () => openSongBrowser();

  document.getElementById('composition-name').addEventListener('blur', () => {
    update('composition.name', document.getElementById('composition-name').textContent.trim() || 'Untitled');
  });
}

async function openSongBrowser() {
  const modal = document.getElementById('song-browser-modal');
  const listEl = document.getElementById('song-list');
  listEl.innerHTML = '<div class="loading">Loading…</div>';
  modal.classList.remove('hidden');

  const songs = await listCompositions();
  if (!songs.length) {
    listEl.innerHTML = '<div class="empty-msg">No saved compositions</div>';
    return;
  }

  listEl.innerHTML = songs.map(s => `
    <div class="song-item" data-id="${s.id}">
      <div class="song-info">
        <span class="song-name">${s.name || 'Untitled'}</span>
        <span class="song-meta">${s.notes?.length || 0} notes · ${s.tempo} BPM</span>
      </div>
      <div class="song-actions">
        <button class="small-btn song-load" data-id="${s.id}">Open</button>
        <button class="small-btn danger song-delete" data-id="${s.id}">Delete</button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('.song-load').forEach(btn => {
    btn.onclick = async () => {
      const song = songs.find(s => s.id === btn.dataset.id);
      if (!song) return;
      loadComposition(song);
      modal.classList.add('hidden');
    };
  });

  listEl.querySelectorAll('.song-delete').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Delete this composition?')) return;
      await deleteComposition(btn.dataset.id);
      btn.closest('.song-item').remove();
    };
  });
}

function loadComposition(song) {
  stop();
  Object.assign(state.composition, song);
  document.getElementById('composition-name').textContent = song.name || 'Untitled';
  document.getElementById('tempo-input').value = song.tempo;
  document.getElementById('tempo-slider').value = song.tempo;
  const [num, den] = [song.timeSignature.numerator, song.timeSignature.denominator];
  document.getElementById('ts-num').value = num;
  document.getElementById('ts-den').value = den;
  if (song.keySignature) {
    document.getElementById('key-select').value = song.keySignature;
  }
  seekToStart();
  scheduleSheetRender();
  showToast(`Opened: ${song.name}`);
}

function bindModalControls() {
  document.getElementById('btn-close-browser').onclick = () => {
    document.getElementById('song-browser-modal').classList.add('hidden');
  };
  document.getElementById('btn-close-accuracy').onclick = () => {
    document.getElementById('accuracy-modal').classList.add('hidden');
  };
  document.getElementById('btn-train-again').onclick = () => {
    document.getElementById('accuracy-modal').classList.add('hidden');
    seekToStart();
    startTrainingSession();
  };
  document.getElementById('btn-close-midi-info').onclick = () => {
    document.getElementById('midi-info-modal').classList.add('hidden');
  };

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });
}

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.contentEditable === 'true') return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (state.transport.mode === 'playing') stop();
        else play();
        break;
      case 'KeyR':
        if (state.transport.mode === 'recording') stop();
        else record();
        break;
      case 'Home':
        seekToStart();
        break;
    }
  });
}

function updateLoopDisplay() {
  const enabled = state.transport.loopEnabled;
  document.getElementById('loop-enabled').checked = enabled;
}

function updatePositionDisplay(ms) {
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  const ms3 = Math.floor(ms % 1000);
  document.getElementById('display-time').textContent =
    `${min}:${String(sec).padStart(2, '0')}.${String(ms3).padStart(3, '0')}`;

  const tempo = state.composition.tempo;
  const { numerator, denominator } = state.composition.timeSignature;
  const beatMs = (60 / tempo) * 1000;
  const beatsPerBar = numerator * (4 / denominator);
  const totalBeats = ms / beatMs;
  const bar = Math.floor(totalBeats / beatsPerBar) + 1;
  const beat = Math.floor(totalBeats % beatsPerBar) + 1;
  document.getElementById('display-beat').textContent = `${bar}.${beat}`;
}

function scheduleSheetRender() {
  clearTimeout(renderDebounce);
  renderDebounce = setTimeout(() => {
    renderDebounce = null;
    const t = state.transport.mode !== 'stopped' ? state.transport.currentTime : null;
    if (state.ui.view !== 'piano-roll') {
      renderSheet(state.composition.notes, state.composition, t);
    }
    if (state.ui.view === 'piano-roll') {
      const rollCanvas = document.getElementById('roll-canvas');
      renderPianoRoll(rollCanvas, state.composition.notes, state.transport.currentTime);
    }
  }, 80);
}

function updateMidiStatus(connected) {
  const dot = document.getElementById('midi-dot');
  const text = document.getElementById('midi-text');
  dot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
  text.textContent = connected ? `MIDI: ${state.midi.inputs.find(i => i.state === 'connected')?.name || 'Connected'}` : 'No MIDI';
  dot.onclick = () => document.getElementById('midi-info-modal').classList.remove('hidden');
}

function updateMidiInputsList(inputs) {
  const el = document.getElementById('midi-devices-list');
  if (!el) return;
  if (!inputs || !inputs.length) {
    el.innerHTML = '<p>No MIDI devices detected.</p>';
    return;
  }
  el.innerHTML = inputs.map(i =>
    `<div class="midi-device ${i.state}">
      <span class="device-dot"></span>${i.name} <span class="device-state">(${i.state})</span>
    </div>`
  ).join('');
}

function showMidiWarning(reason) {
  const dot = document.getElementById('midi-dot');
  const text = document.getElementById('midi-text');
  dot.className = 'status-dot unavailable';
  text.textContent = 'MIDI unavailable';
  dot.title = reason;

  // Show banner if on iOS Safari
  if (/iPad|iPhone/.test(navigator.userAgent)) {
    showToast('Web MIDI not supported in Safari. Use WebMIDI Browser app.', 6000);
  }
}

export function showToast(msg, duration = 2500) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden', 'fade-out');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.classList.add('hidden'), 500);
  }, duration);
}

function showAccuracyResults(results) {
  const modal = document.getElementById('accuracy-modal');
  const { score, correct, missed, extra, avgLatencyMs } = results;

  document.getElementById('score-pct').textContent = score;
  document.getElementById('stat-correct').textContent = correct;
  document.getElementById('stat-missed').textContent = missed;
  document.getElementById('stat-extra').textContent = extra;
  document.getElementById('stat-timing').textContent = `±${avgLatencyMs}ms`;

  // Animate the score arc
  const arc = document.getElementById('score-arc');
  if (arc) {
    const circumference = 2 * Math.PI * 50;
    const progress = score / 100;
    arc.style.strokeDasharray = `${circumference * progress} ${circumference}`;
    arc.style.stroke = score >= 80 ? '#2ecc71' : score >= 50 ? '#f1c40f' : '#e74c3c';
  }

  modal.classList.remove('hidden');
}
