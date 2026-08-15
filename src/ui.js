// UI updates: DOM manipulation, modals, controls
import { state, update, emit, on } from './state.js';
import { record, play, stop, stopAndRewind, startCountIn, playRange, seekTo, seekToStart, seekToEnd, clearAllNotes, transposeNotes, applyLegato, deleteNotes, changeTempo } from './transport.js';
import { renderSheet, initSheet, getChordOverlayData, getStaveGeometry } from './sheet.js';
import { initPianoRoll, renderPianoRoll, spawnKeyEffect, clearKeyEffects } from './pianoroll.js';
import { saveComposition, listCompositions, deleteComposition, compositionToJSON, compositionFromJSON } from './storage.js';
import { startAccuracy, stopAccuracy, getWorstSection } from './accuracy.js';
import { startMetronome, stopMetronome } from './metronome.js';
import { resumeAudioContext, applyOutputLevel, applyClicksOnly } from './audio.js';
import { startStepRecord, stopStepRecord, stepInsertRest, stepGoBack, getStepMs } from './step-recorder.js';
import { initNoteEditor, getSelectedIds, clearSelection } from './note-editor.js';
import { staffPositionName, midiToNoteWithOctave } from './chords.js';
import { initHistory, resetHistory, undo, redo } from './history.js';
import {
  initShortcuts, getActions, bindingsFor, formatBinding, setBinding,
  resetBinding, resetAllBindings, findConflict, startCapture, cancelCapture,
  isCustomised,
} from './shortcuts.js';

let sheetContainer = null;
let renderDebounce = null;

export function initUI() {
  sheetContainer = document.getElementById('vexflow-output');
  initSheet(sheetContainer);
  initPianoRoll(
    document.getElementById('falling-canvas'),
    document.getElementById('piano-keyboard')
  );
  initNoteEditor(document.getElementById('roll-canvas'));

  bindTransport();
  bindToolbar();
  bindViewTabs();
  bindCompositionControls();
  bindLoopControls();
  bindModalControls();
  bindKeyboardShortcuts();
  bindEditorToolbar();
  bindChordOverlay();
  bindStaffHint();
  bindPianoResizer();
  bindShortcutsPanel();
  initHistory();

  // The piano roll canvas is sized from its viewport, so re-render whenever
  // that viewport changes (window resize, or dragging the piano resizer).
  new ResizeObserver(() => {
    if (state.ui.view === 'piano-roll') scheduleSheetRender();
  }).observe(document.getElementById('roll-scroll'));

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
  on('change:composition.tempo', () => { syncTempoControls(); scheduleSheetRender(); });
  on('change:midi.connected', ({ value }) => updateMidiStatus(value));
  on('change:midi.inputs', ({ value }) => updateMidiInputsList(value));
  on('midi:unavailable', ({ reason }) => showMidiWarning(reason));
  on('midi:statechange', () => {});

  // Accuracy: key effects land where the hand is, the gauge tracks the run
  on('accuracy:note', ({ pitch, grade }) => {
    if (grade === 'perfect') spawnKeyEffect(pitch, 'perfect');
    else if (grade === 'good') spawnKeyEffect(pitch, 'good');
  });
  on('accuracy:wrong', ({ pitch }) => spawnKeyEffect(pitch, 'wrong'));
  on('accuracy:progress', (p) => updateGauge(p));
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
  // Pause holds position; Stop also rewinds to the beginning
  document.getElementById('btn-pause').onclick = () => { modeGuard(); stop(); };
  document.getElementById('btn-stop').onclick = () => { modeGuard(); stopAndRewind(); };
  document.getElementById('btn-record').onclick = toggleRecord;
  document.getElementById('btn-step-record').onclick = toggleStepRecord;
  document.getElementById('btn-step-rest').onclick = () => stepInsertRest();
  document.getElementById('btn-step-back').onclick = () => stepGoBack();
  document.getElementById('btn-play').onclick = () => {
    modeGuard();
    if (state.transport.mode === 'playing' || state.transport.mode === 'count-in') { stop(); return; }
    if (state.ui.trainMode) { startTrainingSession(); return; }
    if (state.transport.mode === 'step-recording') stopStepRecord();
    play();
  };
  document.getElementById('btn-to-end').onclick = () => { modeGuard(); seekToEnd?.(); };

  on('transport:record', () => {
    document.getElementById('btn-record').classList.add('active');
    document.getElementById('btn-step-record').classList.remove('active');
    document.getElementById('btn-play').classList.remove('active');
    document.getElementById('btn-play').textContent = '▶';
    setStepControlsVisible(false);
  });
  on('transport:step-record', () => {
    document.getElementById('btn-step-record').classList.add('active');
    document.getElementById('btn-record').classList.remove('active');
    document.getElementById('btn-play').classList.remove('active');
    document.getElementById('btn-play').textContent = '▶';
    setStepControlsVisible(true);
  });
  on('transport:play', () => {
    document.getElementById('btn-play').classList.add('active');
    document.getElementById('btn-play').textContent = '⏸';
    document.getElementById('btn-record').classList.remove('active');
    document.getElementById('btn-step-record').classList.remove('active');
    setStepControlsVisible(false);
  });
  on('transport:stop', () => {
    document.getElementById('btn-record').classList.remove('active');
    document.getElementById('btn-step-record').classList.remove('active');
    document.getElementById('btn-play').classList.remove('active');
    document.getElementById('btn-play').textContent = '▶';
    setStepControlsVisible(false);
    updatePositionDisplay(state.transport.currentTime);
    if (state.ui.trainMode && state.accuracy.active) {
      stopAccuracy();
    } else if (!state.accuracy.active) {
      showGauge(false);
    }
  });

  // Count-in countdown
  const countOverlay = document.getElementById('count-in-overlay');
  const countNumber = document.getElementById('count-in-number');
  on('transport:countin-start', ({ total }) => {
    countNumber.textContent = String(total);
    countOverlay.classList.remove('hidden');
  });
  on('transport:countin', ({ beat }) => {
    countNumber.textContent = String(beat);
    // Restart the pulse animation on each beat
    countNumber.style.animation = 'none';
    void countNumber.offsetWidth;
    countNumber.style.animation = '';
  });
  on('transport:countin-end', () => countOverlay.classList.add('hidden'));

  // Keep position display live during step recording
  on('change:transport.currentTime', ({ value }) => {
    if (state.transport.mode === 'step-recording') {
      updatePositionDisplay(value);
      scheduleSheetRender();
    }
  });
}

function quantizeSelects() {
  return ['quantize-select', 'step-division-select'].map(id => document.getElementById(id));
}

function setQuantize(value) {
  update('ui.quantize', value);
  for (const sel of quantizeSelects()) sel.value = String(value);
  scheduleSheetRender();
}

// Step through the grid values rather than by a fixed amount
const QUANTIZE_STEPS = [1, 2, 4, 8, 16, 32];
function nudgeQuantize(direction) {
  const i = QUANTIZE_STEPS.indexOf(state.ui.quantize);
  const next = QUANTIZE_STEPS[Math.min(QUANTIZE_STEPS.length - 1, Math.max(0, i + direction))];
  if (next !== state.ui.quantize) {
    setQuantize(next);
    showToast(`Quantize / step 1/${next}`, 1000);
  }
}

function setTempo(v) {
  changeTempo(v);
}

// Undo can move the tempo too, so the controls follow the state rather than
// being written by whoever changed it
function syncTempoControls() {
  const bpm = state.composition.tempo;
  document.getElementById('tempo-input').value = bpm;
  document.getElementById('tempo-slider').value = bpm;
  updateRetryTempoLabel();
}

function nudgeTempo(delta) {
  setTempo(state.composition.tempo + delta);
  showToast(`${state.composition.tempo} BPM`, 900);
}

function applyMuteUI(muted) {
  const btn = document.getElementById('btn-mute');
  applyOutputLevel();
  btn.classList.toggle('muted', muted);
  document.getElementById('icon-sound-on').classList.toggle('hidden', muted);
  document.getElementById('icon-sound-off').classList.toggle('hidden', !muted);
  document.getElementById('mute-label').textContent = muted ? 'Muted' : 'Sound';
  // The wording flips with the state, so hand it back to the hint generator
  // rather than writing the title here and losing the key
  btn.dataset.baseTitle = muted ? 'Unmute audio' : 'Mute all audio';
  refreshShortcutHints();
}

function toggleMute() {
  const muted = !state.ui.muted;
  update('ui.muted', muted);
  applyMuteUI(muted);
}

// ── Volume ───────────────────────────────────────────────────────────────────

const VOLUME_STEP = 10; // percent

function setVolume(percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(percent))));
  if (!Number.isFinite(clamped)) return;
  update('ui.volume', clamped / 100);
  applyOutputLevel();
  document.getElementById('volume-slider').value = clamped;
  document.getElementById('volume-value').textContent = `${clamped}%`;
}

function nudgeVolume(direction) {
  const before = Math.round(state.ui.volume * 100);
  setVolume(before + direction * VOLUME_STEP);
  const after = Math.round(state.ui.volume * 100);
  // Turning it up while muted would be silently ignored, so lift the mute
  if (state.ui.muted && after > 0) toggleMute();
  showToast(`Volume ${after}%`, 900);
}

// ── Clicks only ──────────────────────────────────────────────────────────────
// Practising against the click without hearing the notes: the note bus closes,
// the metronome and count-in keep their own path to the output.

function toggleClicksOnly() {
  const on = !state.ui.clicksOnly;
  update('ui.clicksOnly', on);
  applyClicksOnly();
  document.getElementById('btn-clicks-only').classList.toggle('active', on);

  if (!on) { showToast('Notes audible again', 1000); return; }
  showToast(state.ui.metronomeEnabled
    ? 'Clicks only — notes are silent'
    : 'Clicks only — turn the metronome on to hear anything but the count-in', 1800);
}

function toggleTrainMode() {
  const active = !state.ui.trainMode;
  update('ui.trainMode', active);
  document.getElementById('btn-train-mode').classList.toggle('active', active);
  document.getElementById('btn-play').title = active ? 'Start Training' : 'Play';
  showToast(active ? 'Training mode ON — press Play to start' : 'Training mode OFF');
}

function toggleLoop() {
  const enabled = !state.transport.loopEnabled;
  update('transport.loopEnabled', enabled);
  updateLoopDisplay();
  showToast(enabled ? 'Loop on' : 'Loop off', 1000);
}

function setView(view) {
  update('ui.view', view);
  document.querySelectorAll('.view-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === view));
  document.getElementById('panel-sheet').classList.toggle('hidden', view === 'piano-roll');
  document.getElementById('panel-roll').classList.toggle('hidden', view !== 'piano-roll');
  scheduleSheetRender();
}

function toggleView() {
  setView(state.ui.view === 'piano-roll' ? 'sheet' : 'piano-roll');
}

function clearAll() {
  if (confirm('Clear all notes?')) clearAllNotes();
}

function newComposition() {
  if (!confirm('Start a new composition? Unsaved changes will be lost.')) return;
  clearAllNotes();
  update('composition.name', 'Untitled');
  update('composition.id', null);
  document.getElementById('composition-name').textContent = 'Untitled';
  seekToStart();
  resetHistory();
}

async function saveCurrentComposition() {
  const name = document.getElementById('composition-name').textContent.trim() || 'Untitled';
  update('composition.name', name);
  const saved = await saveComposition({ ...state.composition });
  update('composition.id', saved.id);
  showToast('Saved!');
}

function exportComposition() {
  const name = document.getElementById('composition-name').textContent.trim() || 'Untitled';
  update('composition.name', name);
  const json = compositionToJSON(state.composition);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileSafeName(name)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`Exported ${a.download}`);
}

function importComposition() {
  document.getElementById('import-file').click();
}

function openMidiInfo() {
  document.getElementById('midi-info-modal').classList.remove('hidden');
}

// Esc closes whatever is on top
function anyModalOpen() {
  return Boolean(document.querySelector('.modal-overlay:not(.hidden)'));
}

function closeTopModal() {
  const open = [...document.querySelectorAll('.modal-overlay:not(.hidden)')];
  const top = open[open.length - 1];
  if (!top) return;
  if (top.id === 'shortcuts-modal') closeShortcutsPanel();
  else top.classList.add('hidden');
}

// Every transport action lives here and is called by both the button and the
// shortcut. Duplicating them is what let R start recording without its
// count-in while the button honoured it.
function toggleRecord() {
  resumeAudioContext();
  if (state.transport.mode === 'recording' || state.transport.mode === 'count-in') { stop(); return; }
  if (state.transport.mode === 'step-recording') stopStepRecord();
  withCountIn(record);
}

function toggleStepRecord() {
  resumeAudioContext();
  if (state.transport.mode === 'step-recording') stopStepRecord();
  else { stop(); startStepRecord(); }
}

function toggleCountIn() {
  const enabled = !state.ui.countInEnabled;
  update('ui.countInEnabled', enabled);
  document.getElementById('btn-count-in').classList.toggle('active', enabled);
  showToast(enabled ? 'Count-in on' : 'Count-in off', 1200);
}

function toggleMetronome() {
  const enabled = !state.ui.metronomeEnabled;
  update('ui.metronomeEnabled', enabled);
  document.getElementById('btn-metronome').classList.toggle('active', enabled);
  if (enabled) {
    // Turning it on mid-take should be audible straight away
    if (state.transport.mode === 'playing' || state.transport.mode === 'recording') startMetronome(0);
  } else {
    stopMetronome();
  }
}

// Move the playhead without leaving the current mode. Step recording keeps its
// cursor on the grid, so it moves a step at a time.
function nudgePlayhead(direction, wide) {
  const beatMs = (60 / state.composition.tempo) * 1000;
  const stepping = state.transport.mode === 'step-recording';
  const bar = state.composition.timeSignature.numerator * (4 / state.composition.timeSignature.denominator);
  const delta = stepping ? getStepMs() : beatMs * (wide ? bar : 1);
  const target = Math.max(0, state.transport.currentTime + direction * delta);

  if (stepping) update('transport.currentTime', target);
  else seekTo(target);
}

function setStepControlsVisible(visible) {
  document.getElementById('step-controls').classList.toggle('hidden', !visible);
  // Legato writing only means anything while stepping
  document.getElementById('legato-switch').classList.toggle('hidden', !visible);
}

function setStepLegato(on) {
  update('ui.stepLegato', on);
  document.getElementById('legato-toggle').checked = on;
}

// Run `start` after a one-bar count-in when the option is on
function withCountIn(start) {
  if (state.ui.countInEnabled) startCountIn(start);
  else start();
}

// The bars the last session covered, so Try Again repeats the same passage —
// at whatever the tempo happens to be by then
let lastTrainingBars = null;

// Bar numbers are 1-based and inclusive of `startBar`, exclusive past `endBar`
function rangeForBars({ startBar, endBar }) {
  const { tempo, timeSignature } = state.composition;
  const beatMs = (60 / tempo) * 1000;
  const barMs = timeSignature.numerator * (4 / timeSignature.denominator) * beatMs;
  return {
    startMs: (startBar - 1) * barMs,
    // The grading boundary is the barline itself. Playback runs a little past
    // it separately, so the last note can still be played without the next
    // bar's first note being pulled into the section.
    endMs: endBar * barMs,
    tailMs: beatMs,
  };
}

function startTrainingSession(bars = null) {
  if (!state.composition.notes.length) {
    showToast('Record something first to train with');
    return;
  }
  document.getElementById('accuracy-modal').classList.add('hidden');
  lastTrainingBars = bars ? { startBar: bars.startBar, endBar: bars.endBar } : null;
  clearKeyEffects();
  showGauge(true);

  const range = lastTrainingBars ? rangeForBars(lastTrainingBars) : null;
  update('transport.currentTime', range ? range.startMs : 0);

  withCountIn(() => {
    startAccuracy(state.composition, range);
    if (range) playRange(range.startMs, range.endMs + range.tailMs);
    else play();
  });
}

function retryTraining() {
  startTrainingSession(lastTrainingBars);
}

// ── Retry tempo ──────────────────────────────────────────────────────────────
// A passage that keeps going wrong is usually just too fast. The results screen
// offers the same passage a notch slower (or faster) before you go again.

const RETRY_TEMPO_STEP = 10; // percent

// Steps are counted off the tempo the run was played at, rather than compounded
// on each other, so down-then-up lands back where it started
let retryTempoBase = 120;
let retryTempoSteps = 0;

function nudgeRetryTempo(direction) {
  const before = state.composition.tempo;
  const steps = retryTempoSteps + direction;
  setTempo(Math.round(retryTempoBase * (1 + steps * RETRY_TEMPO_STEP / 100)));

  if (state.composition.tempo === before) {
    showToast(direction < 0 ? 'Already as slow as it goes' : 'Already as fast as it goes', 1400);
    return;
  }
  retryTempoSteps = steps;
  updateRetryTempoLabel();
  showToast(`Retry at ${state.composition.tempo} BPM`, 1200);
}

function updateRetryTempoLabel() {
  const el = document.getElementById('retry-tempo-value');
  if (!el) return;
  const percent = retryTempoSteps * RETRY_TEMPO_STEP;
  el.textContent = percent
    ? `${state.composition.tempo} BPM (${percent > 0 ? '+' : ''}${percent}%)`
    : `${state.composition.tempo} BPM`;
}

// ── Live gauge ───────────────────────────────────────────────────────────────

function showGauge(visible) {
  document.getElementById('accuracy-gauge').classList.toggle('hidden', !visible);
  if (visible) updateGauge({ played: 0, total: 0, wrong: 0, score: 100 });
}

function updateGauge({ played, total, wrong, score }) {
  const fill = document.getElementById('gauge-fill');
  const scoreEl = document.getElementById('gauge-score');
  const meta = document.getElementById('gauge-meta');

  // Nothing played yet reads as empty and neutral — a red bar before the first
  // note would be judging a run that has not started
  const shown = played ? score : 0;
  fill.style.height = `${shown}%`;
  const colour = !played ? 'var(--muted)'
    : shown >= 85 ? 'var(--green)'
    : shown >= 60 ? 'var(--yellow)'
    : 'var(--accent2)';
  fill.style.background = colour;
  scoreEl.textContent = played ? `${score}%` : '—';
  scoreEl.style.color = colour;
  meta.textContent = wrong ? `${played}/${total} · ${wrong}✗` : `${played}/${total}`;
}

function bindToolbar() {
  const tempoInput = document.getElementById('tempo-input');
  const tempoSlider = document.getElementById('tempo-slider');

  // Committed value only: a tempo change now rescales the whole piece, and
  // typing "120" would otherwise pass through 1 and 12 on the way
  tempoInput.onchange = (e) => setTempo(e.target.value);
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

  document.getElementById('btn-mute').onclick = toggleMute;
  applyMuteUI(state.ui.muted);
  document.getElementById('volume-slider').oninput = (e) => setVolume(e.target.value);
  setVolume(state.ui.volume * 100);

  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  undoBtn.onclick = () => undo();
  redoBtn.onclick = () => redo();
  on('history:changed', ({ canUndo, canRedo }) => {
    undoBtn.disabled = !canUndo;
    redoBtn.disabled = !canRedo;
  });

  const countInBtn = document.getElementById('btn-count-in');
  countInBtn.classList.toggle('active', state.ui.countInEnabled);
  countInBtn.onclick = toggleCountIn;

  document.getElementById('btn-metronome').onclick = toggleMetronome;
  document.getElementById('btn-clicks-only').onclick = toggleClicksOnly;

  const speedSlider = document.getElementById('speed-slider');
  const speedValue = document.getElementById('speed-value');
  speedSlider.oninput = (e) => {
    const pct = parseInt(e.target.value);
    update('transport.speed', pct / 100);
    speedValue.textContent = `${pct}%`;
  };

  document.getElementById('btn-train-mode').onclick = toggleTrainMode;

  document.getElementById('key-select').onchange = (e) => {
    update('composition.keySignature', e.target.value);
    update('ui.keySignature', e.target.value);
    scheduleSheetRender();
  };

  // Quantize and step size are one setting, surfaced in two places
  for (const sel of quantizeSelects()) {
    sel.value = String(state.ui.quantize);
    sel.onchange = (e) => setQuantize(parseInt(e.target.value));
  }

  const legatoToggle = document.getElementById('legato-toggle');
  legatoToggle.checked = state.ui.stepLegato;
  legatoToggle.onchange = (e) => setStepLegato(e.target.checked);

  document.getElementById('btn-clear').onclick = clearAll;
}

function bindViewTabs() {
  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.onclick = () => setView(tab.dataset.view);
  });
}

function bindLoopControls() {
  document.getElementById('loop-enabled').onchange = (e) => {
    update('transport.loopEnabled', e.target.checked);
    updateLoopDisplay();
  };
  // Everything else reaches the same state through toggleLoop()
  document.getElementById('loop-start').onchange = (e) => {
    update('transport.loopStartBar', Math.max(1, parseInt(e.target.value) || 1));
  };
  document.getElementById('loop-end').onchange = (e) => {
    update('transport.loopEndBar', Math.max(1, parseInt(e.target.value) || 4));
  };
}

// Keep the download name recognisable but safe for any filesystem
function fileSafeName(name) {
  const cleaned = name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
  return cleaned || 'composition';
}

function bindCompositionControls() {
  document.getElementById('btn-new').onclick = newComposition;
  document.getElementById('btn-save').onclick = saveCurrentComposition;
  document.getElementById('btn-open').onclick = () => openSongBrowser();

  document.getElementById('btn-export').onclick = exportComposition;
  const importInput = document.getElementById('import-file');
  document.getElementById('btn-import').onclick = importComposition;
  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    // Reset first, so picking the same file twice still fires a change
    importInput.value = '';
    if (!file) return;
    try {
      const imported = compositionFromJSON(await file.text());
      if (state.composition.notes.length &&
          !confirm('Replace the current composition with the imported one?')) return;
      loadComposition(imported);
      const n = imported.notes.length;
      showToast(`Imported "${imported.name}" — ${n} note${n === 1 ? '' : 's'}`);
    } catch (err) {
      showToast(`Import failed: ${err.message}`, 4000);
    }
  };

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
  syncTempoControls();
  const [num, den] = [song.timeSignature.numerator, song.timeSignature.denominator];
  document.getElementById('ts-num').value = num;
  document.getElementById('ts-den').value = den;
  if (song.keySignature) {
    document.getElementById('key-select').value = song.keySignature;
  }
  seekToStart();
  resetHistory();
  scheduleSheetRender();
  showToast(`Opened: ${song.name}`);
}

function bindModalControls() {
  document.getElementById('btn-close-browser').onclick = () => {
    document.getElementById('song-browser-modal').classList.add('hidden');
  };
  document.getElementById('btn-close-accuracy').onclick = () => {
    document.getElementById('accuracy-modal').classList.add('hidden');
    lastTrainingBars = null;
  };
  document.getElementById('btn-train-again').onclick = retryTraining;
  document.getElementById('btn-retry-slower').onclick = () => nudgeRetryTempo(-1);
  document.getElementById('btn-retry-faster').onclick = () => nudgeRetryTempo(1);
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

// Every shortcut in the app, in one list. The help panel renders from this and
// the dispatcher reads from it, so what is shown is always what is bound.
//
// group decides which actions may share a key: two actions only collide if
// they could be active together.
function shortcutActions() {
  const stepping = () => state.transport.mode === 'step-recording';
  const editing = () =>
    state.ui.view === 'piano-roll' &&
    state.transport.mode !== 'step-recording' &&
    state.ui.editorSelectedNotes.size > 0;

  const resultsUp = () => !document.getElementById('accuracy-modal').classList.contains('hidden');

  return [
    // While the results are up Space repeats the run rather than driving the
    // transport — a context binding, matched before the global one
    { id: 'retry-training', group: 'results', scope: resultsUp,
      section: 'Training', label: 'Try the same passage again',
      defaultBindings: [{ code: 'Space' }],
      run: () => retryTraining() },
    { id: 'retry-section', group: 'results', scope: resultsUp,
      section: 'Training', label: 'Practise the roughest bars',
      defaultBindings: [{ code: 'KeyW' }],
      run: () => {
        const worst = getWorstSection(state.composition);
        if (worst) startTrainingSession(worst);
        else showToast('Nothing stood out to practise', 1500);
      } },
    // Same keys as the global tempo nudge, deliberately: with the results up
    // they move the tempo by a useful practice step instead of 1 BPM
    { id: 'retry-slower', group: 'results', scope: resultsUp, hint: 'btn-retry-slower',
      section: 'Training', label: 'Retry 10% slower',
      defaultBindings: [{ code: 'BracketLeft' }],
      run: () => nudgeRetryTempo(-1) },
    { id: 'retry-faster', group: 'results', scope: resultsUp, hint: 'btn-retry-faster',
      section: 'Training', label: 'Retry 10% faster',
      defaultBindings: [{ code: 'BracketRight' }],
      run: () => nudgeRetryTempo(1) },

    // Step recording first: while stepping, Backspace belongs to the recorder
    { id: 'step-forward', group: 'step', scope: stepping,
      section: 'Step recording', label: 'Step forward (write a rest)',
      defaultBindings: [{ code: 'Period' }, { code: 'NumpadDecimal' }],
      run: () => stepInsertRest() },
    { id: 'step-back', group: 'step', scope: stepping,
      section: 'Step recording', label: 'Delete last step and go back',
      defaultBindings: [{ code: 'Backspace' }],
      run: () => stepGoBack() },
    { id: 'step-legato', group: 'step', scope: stepping,
      section: 'Step recording', label: 'Toggle legato writing',
      defaultBindings: [{ code: 'KeyL' }],
      run: () => setStepLegato(!state.ui.stepLegato) },

    // Piano roll editing, only with a selection
    { id: 'editor-delete', group: 'editor', scope: editing,
      section: 'Piano roll editing', label: 'Delete selected notes',
      defaultBindings: [{ code: 'Delete' }, { code: 'Backspace' }],
      run: () => { deleteNotes(getSelectedIds()); clearSelection(); } },
    { id: 'editor-up', group: 'editor', scope: editing,
      section: 'Piano roll editing', label: 'Transpose up a semitone',
      defaultBindings: [{ code: 'ArrowUp' }],
      run: () => transposeNotes(getSelectedIds(), 1) },
    { id: 'editor-down', group: 'editor', scope: editing,
      section: 'Piano roll editing', label: 'Transpose down a semitone',
      defaultBindings: [{ code: 'ArrowDown' }],
      run: () => transposeNotes(getSelectedIds(), -1) },
    { id: 'editor-oct-up', group: 'editor', scope: editing,
      section: 'Piano roll editing', label: 'Transpose up an octave',
      defaultBindings: [{ code: 'ArrowUp', shift: true }],
      run: () => transposeNotes(getSelectedIds(), 12) },
    { id: 'editor-oct-down', group: 'editor', scope: editing,
      section: 'Piano roll editing', label: 'Transpose down an octave',
      defaultBindings: [{ code: 'ArrowDown', shift: true }],
      run: () => transposeNotes(getSelectedIds(), -12) },
    { id: 'editor-legato', group: 'editor', scope: editing, hint: 'btn-legato',
      section: 'Piano roll editing', label: 'Extend selection to the next note',
      defaultBindings: [{ code: 'KeyG' }],
      run: () => applyLegato(getSelectedIds()) },

    // Transport
    { id: 'transport-toggle', group: 'global',
      section: 'Transport', label: 'Play, or stop whatever is running',
      defaultBindings: [{ code: 'Space' }],
      run: () => {
        if (state.transport.mode !== 'stopped') stop();
        else if (state.ui.trainMode) startTrainingSession();
        else play();
      } },
    { id: 'record', group: 'global',
      section: 'Transport', label: 'Record',
      defaultBindings: [{ code: 'KeyR' }],
      run: () => toggleRecord() },
    { id: 'step-record', group: 'global',
      section: 'Transport', label: 'Step record',
      defaultBindings: [{ code: 'KeyR', shift: true }],
      run: () => toggleStepRecord() },
    { id: 'playhead-forward', group: 'global',
      section: 'Transport', label: 'Playhead forward a beat',
      defaultBindings: [{ code: 'ArrowRight' }],
      run: () => nudgePlayhead(1, false) },
    { id: 'playhead-back', group: 'global',
      section: 'Transport', label: 'Playhead back a beat',
      defaultBindings: [{ code: 'ArrowLeft' }],
      run: () => nudgePlayhead(-1, false) },
    { id: 'playhead-forward-bar', group: 'global',
      section: 'Transport', label: 'Playhead forward a bar',
      defaultBindings: [{ code: 'ArrowRight', shift: true }],
      run: () => nudgePlayhead(1, true) },
    { id: 'playhead-back-bar', group: 'global',
      section: 'Transport', label: 'Playhead back a bar',
      defaultBindings: [{ code: 'ArrowLeft', shift: true }],
      run: () => nudgePlayhead(-1, true) },
    { id: 'pause', group: 'global', hint: 'btn-pause',
      section: 'Transport', label: 'Pause, holding position',
      defaultBindings: [{ code: 'KeyP' }],
      run: () => stop() },
    { id: 'stop-rewind', group: 'global', hint: 'btn-stop',
      section: 'Transport', label: 'Stop and rewind',
      defaultBindings: [{ code: 'Space', shift: true }],
      run: () => stopAndRewind() },
    { id: 'to-start', group: 'global', hint: 'btn-to-start',
      section: 'Transport', label: 'Go to the start',
      defaultBindings: [{ code: 'Home' }],
      run: () => seekToStart() },
    { id: 'to-end', group: 'global', hint: 'btn-to-end',
      section: 'Transport', label: 'Go to the end',
      defaultBindings: [{ code: 'End' }],
      run: () => seekToEnd() },

    // Toggles
    { id: 'count-in', group: 'global',
      section: 'Options', label: 'Toggle count-in',
      defaultBindings: [{ code: 'KeyC' }],
      run: () => toggleCountIn() },
    { id: 'metronome', group: 'global', hint: 'btn-metronome',
      section: 'Options', label: 'Toggle metronome',
      defaultBindings: [{ code: 'KeyM' }],
      run: () => toggleMetronome() },
    { id: 'clicks-only', group: 'global', hint: 'btn-clicks-only',
      section: 'Options', label: 'Hear only the metronome and count-in',
      defaultBindings: [{ code: 'KeyK' }],
      run: () => toggleClicksOnly() },
    { id: 'mute', group: 'global', hint: 'btn-mute',
      section: 'Options', label: 'Mute / unmute all audio',
      defaultBindings: [{ code: 'KeyS' }],
      run: () => toggleMute() },
    // Shift on the quantize keys, the way [ and ] carry the tempo
    { id: 'volume-down', group: 'global',
      section: 'Options', label: 'Volume down 10%',
      defaultBindings: [{ code: 'Minus', shift: true }],
      run: () => nudgeVolume(-1) },
    { id: 'volume-up', group: 'global',
      section: 'Options', label: 'Volume up 10%',
      defaultBindings: [{ code: 'Equal', shift: true }],
      run: () => nudgeVolume(1) },
    { id: 'train', group: 'global', hint: 'btn-train-mode',
      section: 'Options', label: 'Toggle training mode',
      defaultBindings: [{ code: 'KeyT' }],
      run: () => toggleTrainMode() },
    { id: 'loop', group: 'global',
      section: 'Options', label: 'Toggle loop',
      defaultBindings: [{ code: 'KeyL', shift: true }],
      run: () => toggleLoop() },
    { id: 'tempo-down', group: 'global', hint: 'btn-tempo-down',
      section: 'Options', label: 'Tempo down 1 BPM',
      defaultBindings: [{ code: 'BracketLeft' }],
      run: () => nudgeTempo(-1) },
    { id: 'tempo-up', group: 'global', hint: 'btn-tempo-up',
      section: 'Options', label: 'Tempo up 1 BPM',
      defaultBindings: [{ code: 'BracketRight' }],
      run: () => nudgeTempo(1) },
    { id: 'quantize-coarser', group: 'global',
      section: 'Options', label: 'Coarser quantize / step',
      defaultBindings: [{ code: 'Minus' }],
      run: () => nudgeQuantize(-1) },
    { id: 'quantize-finer', group: 'global',
      section: 'Options', label: 'Finer quantize / step',
      defaultBindings: [{ code: 'Equal' }],
      run: () => nudgeQuantize(1) },
    { id: 'toggle-view', group: 'global',
      section: 'Options', label: 'Switch sheet / piano roll',
      defaultBindings: [{ code: 'KeyV' }],
      run: () => toggleView() },

    // Editing
    { id: 'undo', group: 'global',
      section: 'Edit', label: 'Undo',
      defaultBindings: [{ code: 'KeyZ', mod: true }],
      run: () => undo() },
    { id: 'redo', group: 'global',
      section: 'Edit', label: 'Redo',
      defaultBindings: [{ code: 'KeyZ', mod: true, shift: true }, { code: 'KeyY', mod: true }],
      run: () => redo() },

    { id: 'new', group: 'global', hint: 'btn-new',
      section: 'File', label: 'New composition',
      defaultBindings: [{ code: 'KeyN', shift: true }],
      run: () => newComposition() },
    { id: 'open', group: 'global', hint: 'btn-open',
      section: 'File', label: 'Open a composition',
      defaultBindings: [{ code: 'KeyO', mod: true }],
      run: () => openSongBrowser() },
    { id: 'save', group: 'global', hint: 'btn-save',
      section: 'File', label: 'Save',
      defaultBindings: [{ code: 'KeyS', mod: true }],
      run: () => saveCurrentComposition() },
    { id: 'export', group: 'global', hint: 'btn-export',
      section: 'File', label: 'Export as JSON',
      defaultBindings: [{ code: 'KeyE', mod: true }],
      run: () => exportComposition() },
    { id: 'import', group: 'global', hint: 'btn-import',
      section: 'File', label: 'Import from JSON',
      defaultBindings: [{ code: 'KeyI', mod: true }],
      run: () => importComposition() },
    { id: 'clear-all', group: 'global', hint: 'btn-clear',
      section: 'File', label: 'Clear all notes',
      defaultBindings: [{ code: 'Backspace', mod: true }],
      run: () => clearAll() },
    { id: 'midi-info', group: 'global',
      section: 'File', label: 'MIDI settings',
      defaultBindings: [{ code: 'KeyM', mod: true }],
      run: () => openMidiInfo() },

    { id: 'close-modal', group: 'global', scope: anyModalOpen,
      section: 'Help', label: 'Close the open dialog',
      defaultBindings: [{ code: 'Escape' }],
      run: () => closeTopModal() },
    { id: 'help', group: 'global', hint: 'btn-shortcuts',
      section: 'Help', label: 'Keyboard shortcuts',
      defaultBindings: [{ code: 'Slash', shift: true }],
      run: () => openShortcutsPanel() },
  ];
}

function bindKeyboardShortcuts() {
  initShortcuts(shortcutActions());
  refreshShortcutHints();
}

// Buttons show their current key. Generated rather than written into the
// markup, so a rebound shortcut never leaves a stale tooltip behind.
function refreshShortcutHints() {
  for (const action of getActions()) {
    if (!action.hint) continue;
    const el = document.getElementById(action.hint);
    if (!el) continue;
    if (el.dataset.baseTitle === undefined) {
      el.dataset.baseTitle = (el.title || action.label).replace(/\s*\([^)]*\)\s*$/, '');
    }
    const binding = bindingsFor(action)[0];
    el.title = binding ? `${el.dataset.baseTitle} (${formatBinding(binding)})` : el.dataset.baseTitle;
  }
}

function openShortcutsPanel() {
  renderShortcutsList();
  document.getElementById('shortcuts-modal').classList.remove('hidden');
}

function bindShortcutsPanel() {
  document.getElementById('btn-shortcuts').onclick = openShortcutsPanel;
  document.getElementById('btn-close-shortcuts').onclick = closeShortcutsPanel;
  document.getElementById('btn-shortcuts-reset').onclick = () => {
    resetAllBindings();
    renderShortcutsList();
    refreshShortcutHints();
  };
}

function closeShortcutsPanel() {
  cancelCapture();
  document.getElementById('shortcuts-modal').classList.add('hidden');
}

// The registry is ordered for dispatch — scoped actions first, so Backspace
// resolves to the step recorder before the editor. Reading order is different.
const SECTION_ORDER = ['Transport', 'Options', 'Edit', 'File', 'Step recording', 'Piano roll editing', 'Training', 'Help'];

function renderShortcutsList(warning = '') {
  const list = document.getElementById('shortcuts-list');
  list.innerHTML = '';
  let section = null;

  const ordered = [...getActions()].sort(
    (a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section)
  );

  for (const action of ordered) {
    if (action.section !== section) {
      section = action.section;
      const head = document.createElement('div');
      head.className = 'shortcut-section';
      head.textContent = section;
      list.appendChild(head);
    }

    const row = document.createElement('div');
    row.className = 'shortcut-row' + (isCustomised(action.id) ? ' custom' : '');

    const label = document.createElement('span');
    label.className = 'shortcut-label';
    label.textContent = action.label;
    row.appendChild(label);

    const keys = document.createElement('span');
    keys.className = 'shortcut-keys';
    bindingsFor(action).forEach((binding, i) => {
      const key = document.createElement('button');
      // Only the first is editable; the rest are built-in alternates
      key.className = 'shortcut-key' + (i > 0 ? ' alt' : '');
      key.textContent = formatBinding(binding);
      if (i === 0) {
        key.onclick = () => beginRebind(action, key);
      } else {
        key.title = 'Alternate';
      }
      keys.appendChild(key);
    });
    row.appendChild(keys);

    const reset = document.createElement('button');
    reset.className = 'shortcut-reset';
    reset.textContent = '↺';
    reset.title = 'Restore the default';
    reset.onclick = () => { resetBinding(action.id); renderShortcutsList(); refreshShortcutHints(); };
    row.appendChild(reset);

    list.appendChild(row);
  }

  const note = document.createElement('div');
  note.className = 'shortcut-warning';
  note.textContent = warning;
  list.appendChild(note);
}

function beginRebind(action, keyEl) {
  cancelCapture();
  renderShortcutsList();
  // The row was rebuilt, so find the button again
  const fresh = [...document.querySelectorAll('.shortcut-row')]
    .find(r => r.querySelector('.shortcut-label').textContent === action.label)
    ?.querySelector('.shortcut-key');
  if (!fresh) return;

  fresh.classList.add('listening');
  fresh.textContent = 'Press a key…';

  startCapture((binding) => {
    if (!binding) { renderShortcutsList(); return; }

    const clash = findConflict(action.id, binding);
    if (clash) {
      renderShortcutsList(`${formatBinding(binding)} is already "${clash.label}"`);
      return;
    }
    setBinding(action.id, binding);
    renderShortcutsList();
    refreshShortcutHints();
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

const PIANO_H_KEY = 'miditrain.pianoHeight';
const PIANO_H_MIN = 130; // keyboard + a usable sliver of falling notes

function pianoHeightMax() {
  return Math.max(PIANO_H_MIN, window.innerHeight - 260);
}

function setPianoHeight(px) {
  const h = Math.round(Math.min(pianoHeightMax(), Math.max(PIANO_H_MIN, px)));
  document.documentElement.style.setProperty('--piano-h', h + 'px');
  return h;
}

function bindPianoResizer() {
  const bar = document.getElementById('piano-resizer');
  if (!bar) return;

  const saved = parseInt(localStorage.getItem(PIANO_H_KEY), 10);
  if (Number.isFinite(saved)) setPianoHeight(saved);

  let startY = 0;
  let startH = 0;

  function onMove(e) {
    // Dragging up grows the piano section, so invert the delta.
    setPianoHeight(startH + (startY - e.clientY));
  }

  function onUp(e) {
    bar.classList.remove('dragging');
    bar.releasePointerCapture?.(e.pointerId);
    bar.removeEventListener('pointermove', onMove);
    bar.removeEventListener('pointerup', onUp);
    bar.removeEventListener('pointercancel', onUp);
    const h = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--piano-h'), 10);
    if (Number.isFinite(h)) localStorage.setItem(PIANO_H_KEY, String(h));
  }

  bar.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    startH = document.getElementById('piano-section').offsetHeight;
    bar.classList.add('dragging');
    // Capture so the drag survives the pointer leaving the thin handle
    bar.setPointerCapture(e.pointerId);
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    bar.addEventListener('pointercancel', onUp);
    e.preventDefault();
  });

  // Double-click restores the default split
  bar.addEventListener('dblclick', () => {
    localStorage.setItem(PIANO_H_KEY, String(setPianoHeight(250)));
  });

  // Keep the section within bounds when the window itself changes size
  window.addEventListener('resize', () => {
    setPianoHeight(document.getElementById('piano-section').offsetHeight);
  });
}

function scheduleSheetRender() {
  clearTimeout(renderDebounce);
  renderDebounce = setTimeout(() => {
    renderDebounce = null;
    const t = (state.transport.mode !== 'stopped' && state.transport.mode !== 'step-recording')
      ? state.transport.currentTime : null;
    if (state.ui.view !== 'piano-roll') {
      renderSheet(state.composition.notes, state.composition, t);
      updateChordOverlay();
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
  dot.onclick = openMidiInfo;
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

function bindEditorToolbar() {
  document.getElementById('btn-transpose-up').onclick = () => {
    const sel = getSelectedIds();
    if (sel.size) transposeNotes(sel, 1);
  };
  document.getElementById('btn-transpose-down').onclick = () => {
    const sel = getSelectedIds();
    if (sel.size) transposeNotes(sel, -1);
  };
  document.getElementById('btn-oct-up').onclick = () => {
    const sel = getSelectedIds();
    if (sel.size) transposeNotes(sel, 12);
  };
  document.getElementById('btn-oct-down').onclick = () => {
    const sel = getSelectedIds();
    if (sel.size) transposeNotes(sel, -12);
  };
  document.getElementById('btn-legato').onclick = () => {
    const sel = getSelectedIds();
    if (sel.size) applyLegato(sel);
  };
  document.getElementById('btn-editor-delete').onclick = () => {
    const sel = getSelectedIds();
    if (!sel.size) return;
    deleteNotes(sel);
    sel.clear();
  };

  on('editor:selection', (sel) => {
    const hasSelection = sel && sel.size > 0;
    document.getElementById('editor-toolbar').classList.toggle('has-selection', hasSelection);
    const hint = document.getElementById('editor-hint');
    hint.textContent = hasSelection
      ? `${sel.size} note${sel.size > 1 ? 's' : ''} selected — drag to move, drag right edge to resize`
      : 'Click note to select · Shift+click multi-select · Del to delete · ↑↓ transpose';
  });
}

// ── Chord overlay + mini-piano hover ──────────────────────────────────────────

// Draws the actual voicing across the octaves it spans, so inversions look
// different from root position. Collapsing to pitch classes would render
// C/E identically to C.
function buildMiniPianoSVG(pitches) {
  const WHITE = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
  const BLACK = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 }; // pc → white-key index it sits after

  const sorted = [...new Set(pitches)].sort((a, b) => a - b);
  if (!sorted.length) return '';
  const held = new Set(sorted);
  const bass = sorted[0];

  const firstOct = Math.floor(bass / 12);
  const lastOct = Math.floor(sorted[sorted.length - 1] / 12);
  const octaves = lastOct - firstOct + 1;

  const KW = octaves > 2 ? 10 : 14;
  const BW = Math.round(KW * 0.62);
  const KH = 42, BH = 26;
  const totalW = octaves * WHITE.length * KW;

  const fillFor = (midi, plain) =>
    midi === bass ? '#e94560' : held.has(midi) ? '#5bc0eb' : plain;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${KH}" style="display:block">`;

  for (let o = 0; o < octaves; o++) {
    const base = (firstOct + o) * 12;
    const originX = o * WHITE.length * KW;

    WHITE.forEach((pc, i) => {
      const x = originX + i * KW;
      svg += `<rect x="${x}" y="0" width="${KW - 1}" height="${KH}" `
           + `fill="${fillFor(base + pc, '#dde')}" stroke="#444" stroke-width="1" rx="1"/>`;
    });

    for (const [pcStr, wIdx] of Object.entries(BLACK)) {
      const pc = parseInt(pcStr);
      const x = originX + wIdx * KW + KW - BW / 2;
      svg += `<rect x="${x}" y="0" width="${BW}" height="${BH}" `
           + `fill="${fillFor(base + pc, '#222')}" stroke="#111" stroke-width="1" rx="1"/>`;
    }
  }

  svg += '</svg>';
  return svg;
}

// Voicing bottom-to-top, e.g. "E4 · G4 · C5" — the bass note is what names
// the inversion, so it is marked.
function buildVoicingCaption(pitches) {
  const sorted = [...new Set(pitches)].sort((a, b) => a - b);
  return sorted
    .map((p, i) => {
      const name = midiToNoteWithOctave(p);
      return i === 0 ? `<span class="voicing-bass">${name}</span>` : name;
    })
    .join(' · ');
}

// Which stave the pointer is over, in SVG user units. `ledgerSteps` widens the
// band past the stave itself so ledger positions (and, for seeking, the gap
// between the staves) still count.
function staveUnderPointer(loc, ledgerSteps = 6) {
  return getStaveGeometry().find((g) => {
    if (loc.x < g.x || loc.x > g.x + g.w) return false;
    const pad = (ledgerSteps / 2) * g.spacing;
    return loc.y >= g.topLineY - pad && loc.y <= g.topLineY + 4 * g.spacing + pad;
  });
}

// Hovering a stave names the line or space under the pointer
function bindStaffHint() {
  const containerEl = document.getElementById('sheet-container');
  const hint = document.getElementById('staff-hint');
  const rule = document.getElementById('staff-hint-rule');
  if (!containerEl || !hint || !rule) return;

  function hide() {
    hint.classList.add('hidden');
    rule.classList.add('hidden');
  }

  containerEl.addEventListener('mouseleave', hide);

  // Clicking the score moves the playhead to that point in the bar
  containerEl.addEventListener('click', (e) => {
    if (e.target.closest('.chord-label-el, #chord-tooltip')) return;
    const svg = containerEl.querySelector('#vexflow-output svg');
    if (!svg || !svg.getScreenCTM) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;

    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const loc = pt.matrixTransform(ctm.inverse());

    // Anywhere in the system counts, including the gap between the staves
    const stave = staveUnderPointer(loc, 14);
    if (!stave) return;

    const bar = state.composition.timeSignature.numerator *
                (4 / state.composition.timeSignature.denominator);
    const span = Math.max(1, stave.noteEndX - stave.noteStartX);
    const frac = Math.min(1, Math.max(0, (loc.x - stave.noteStartX) / span));
    const beat = stave.measure * bar + frac * bar;
    const ms = beat * (60 / state.composition.tempo) * 1000;

    if (state.transport.mode === 'step-recording') {
      // Keep the step cursor on the grid it writes to
      const step = getStepMs();
      update('transport.currentTime', Math.max(0, Math.round(ms / step) * step));
    } else {
      seekTo(ms);
    }
  });

  containerEl.addEventListener('mousemove', (e) => {
    // Chord labels have their own tooltip; don't compete with it
    if (e.target.closest('.chord-label-el, #chord-tooltip')) return hide();

    const svg = containerEl.querySelector('#vexflow-output svg');
    const geom = getStaveGeometry();
    if (!svg || !geom.length || !svg.getScreenCTM) return hide();

    // Screen → SVG user units, which is what the geometry is recorded in
    const ctm = svg.getScreenCTM();
    if (!ctm) return hide();
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const loc = pt.matrixTransform(ctm.inverse());

    // Reach a few positions past each stave so ledger lines are still named
    const stave = staveUnderPointer(loc);
    if (!stave) return hide();

    // Each half-spacing is one diatonic step, counted downward from the top line
    const steps = Math.round((loc.y - stave.topLineY) / (stave.spacing / 2));
    const dia = stave.topLineDia - steps;
    const name = staffPositionName(dia, state.composition.keySignature);

    // Snap the readout to the exact line/space the name refers to
    const snappedSvgY = stave.topLineY + steps * (stave.spacing / 2);
    const originPt = svg.createSVGPoint();
    originPt.x = stave.x;
    originPt.y = snappedSvgY;
    const screen = originPt.matrixTransform(ctm);
    const cRect = containerEl.getBoundingClientRect();
    const left = screen.x - cRect.left + containerEl.scrollLeft;
    const top = screen.y - cRect.top + containerEl.scrollTop;

    hint.textContent = name;
    hint.style.left = (e.clientX - cRect.left + containerEl.scrollLeft + 14) + 'px';
    hint.style.top = (top - 9) + 'px';
    hint.classList.remove('hidden');

    rule.style.left = left + 'px';
    rule.style.top = top + 'px';
    rule.style.width = (stave.w * ctm.a) + 'px'; // ctm.a is the SVG→screen x scale
    rule.classList.remove('hidden');
  });
}

function bindChordOverlay() {
  const tooltip = document.getElementById('chord-tooltip');

  // After each sheet render, rebuild the chord label overlay
  on('transport:noteschanged', () => updateChordOverlay());
  on('transport:stop', () => updateChordOverlay());

  // Tooltip dismiss
  document.addEventListener('mousemove', (e) => {
    if (!e.target.closest('.chord-label-el, #chord-tooltip')) {
      tooltip.classList.add('hidden');
    }
  });
}

function updateChordOverlay() {
  const overlay = document.getElementById('chord-labels-overlay');
  if (!overlay) return;
  // Rebuild after a short delay so VexFlow SVG is fully laid out
  setTimeout(() => {
    overlay.innerHTML = '';
    const data = getChordOverlayData();
    const tooltip = document.getElementById('chord-tooltip');
    const containerEl = document.getElementById('sheet-container');
    const containerRect = containerEl ? containerEl.getBoundingClientRect() : { left: 0, top: 0 };
    // The overlay is positioned absolutely inside #sheet-container
    for (const item of data) {
      const el = document.createElement('span');
      el.className = 'chord-label-el' + (item.arpeggiated ? ' arp' : '');
      el.textContent = item.label;
      if (item.arpeggiated) el.title = 'Arpeggiated chord';
      el.style.left = item.x + 'px';
      el.style.top = item.y + 'px';
      el.addEventListener('mouseenter', (e) => {
        tooltip.innerHTML = `<div class="chord-tooltip-name">${item.label}</div>` +
          buildMiniPianoSVG(item.pitches) +
          `<div class="chord-tooltip-voicing">${buildVoicingCaption(item.pitches)}</div>`;
        const r = el.getBoundingClientRect();
        tooltip.style.left = (r.left - containerRect.left) + 'px';
        tooltip.style.top = (r.bottom - containerRect.top + 4) + 'px';
        tooltip.classList.remove('hidden');
      });
      overlay.appendChild(el);
    }
  }, 120);
}

function showAccuracyResults(results) {
  const modal = document.getElementById('accuracy-modal');
  const { score, perfect, good, almost, missed, extra, avgLatencyMs } = results;

  showGauge(false);
  // Each results screen re-bases the retry steps on the tempo just played
  retryTempoBase = state.composition.tempo;
  retryTempoSteps = 0;
  updateRetryTempoLabel();
  document.getElementById('score-pct').textContent = score;
  document.getElementById('stat-perfect').textContent = perfect;
  document.getElementById('stat-almost').textContent = almost;
  document.getElementById('stat-correct').textContent = good;
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

  // Offer the roughest couple of bars, when there is one worth repeating
  const worst = getWorstSection(state.composition);
  const sectionBtn = document.getElementById('btn-train-section');
  if (worst) {
    sectionBtn.hidden = false;
    sectionBtn.textContent = worst.startBar === worst.endBar
      ? `Practise bar ${worst.startBar}`
      : `Practise bars ${worst.startBar}–${worst.endBar}`;
    sectionBtn.onclick = () => startTrainingSession(worst);
  } else {
    sectionBtn.hidden = true;
  }

  modal.classList.remove('hidden');
}
