// UI updates: DOM manipulation, modals, controls
import { state, update, emit, on } from './state.js';
import { record, play, stop, stopAndRewind, startCountIn, playRange, seekTo, seekToStart, seekToEnd, clearAllNotes, transposeNotes, transposeAll, setNotesHand, applyLegato, deleteNotes, changeTempo, getCompositionDuration } from './transport.js';
import { renderSheet, initSheet, getChordOverlayData, getStaveGeometry, movePlayhead, markLoopRange, barAtPoint } from './sheet.js';
import { refreshSuggestions, hasSuggestions } from './autofinger.js';
import { initPianoRoll, renderPianoRoll, spawnKeyEffect, clearKeyEffects, setWaitingPitches, setFallingBlind, setLoopPick, setTakeGhosts, noteAtFallingPoint, fallingMsPerPixel } from './pianoroll.js';
import { startLearn, stopLearn, isHoldingMessage, CLUSTERS } from './learn.js';
import {
  startSectionWalk, stopSectionWalk, repeatSection, advanceSection,
  handOverForTraining, isWalking, buildSections,
} from './section-learn.js';
import { saveComposition, listCompositions, deleteComposition, compositionToJSON, compositionFromJSON } from './storage.js';
import { compositionToMidi, midiToComposition } from './midi-file.js';
import { startAccuracy, stopAccuracy, getWorstSection, getTake, EXTRA_PENALTY_PCT } from './accuracy.js';
import { startMetronome, stopMetronome } from './metronome.js';
import { resumeAudioContext, applyOutputLevel, applyClicksOnly, setPlaybackSource } from './audio.js';
import { setInputEnabled } from './midi.js';
import { startStepRecord, stopStepRecord, stepInsertRest, stepGoBack, getStepMs } from './step-recorder.js';
import { initNoteEditor, getSelectedIds, clearSelection } from './note-editor.js';
import { staffPositionName, midiToNoteWithOctave } from './chords.js';
import { barRangeMs, barAtMs, detectGridDivision } from './quantizer.js';
import { loopBars } from './range.js';
import { inferHands } from './hands.js';
import { SCALES, CHORDS, PATTERNS, HANDS, DIRECTIONS, NOTE_VALUES, ROOTS, buildExercise } from './scales.js';
import {
  listProfiles, current as currentProfile, switchProfile, createProfile, deleteProfile,
  adoptProfile, sectionKey, sectionTempo, rememberSectionTempo, setLearningPosition,
  learningPosition, canUseFolder, chooseFolder, folderHandle, scanFolder, writeToFolder,
  fileNameFor, bundleToJSON, bundleFromJSON,
} from './profiles.js';
import { collectBundle, applyBundle } from './session.js';
import { initHistory, resetHistory, undo, redo } from './history.js';
import {
  initShortcuts, getActions, bindingsFor, formatBinding, setBinding,
  resetBinding, resetAllBindings, findConflict, startCapture, cancelCapture,
  isCustomised,
} from './shortcuts.js';

let sheetContainer = null;
let renderDebounce = null;
let sheetShowsStepCursor = false;

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
  bindFallingScrub();
  bindLoopHandles();
  bindShortcutsPanel();
  bindSectionWalk();
  bindProfiles();
  bindPracticeGenerator();
  initHistory();

  // The piano roll canvas is sized from its viewport, so re-render whenever
  // that viewport changes (window resize, or dragging the piano resizer).
  new ResizeObserver(() => {
    if (state.ui.view === 'piano-roll') scheduleSheetRender();
  }).observe(document.getElementById('roll-scroll'));

  // Re-render sheet on notes change. That pass also rebuilds any suggested
  // fingering, which is worked out for the whole passage at once and would
  // otherwise be left describing the notes as they used to be.
  on('transport:noteschanged', () => scheduleSheetRender());
  // Stopping used to repaint so the playhead would follow, and again to clear
  // it. The overlay does both for free now, so the only thing left that stop
  // has to erase is the step cursor, which is part of the drawing.
  on('transport:stop', () => { if (sheetShowsStepCursor) scheduleSheetRender(); });
  on('transport:tick', (t) => {
    updatePositionDisplay(t);
    movePlayhead(t);
  });

  // MIDI status updates
  on('change:composition.tempo', () => { syncTempoControls(); scheduleSheetRender(); });
  // Undo can move the key and the transpose too, so the controls follow state
  on('change:ui.transpose', () => syncTransposeControls());
  on('change:composition.keySignature', () => {
    // A generated exercise spells its own notes, which was right for the key it
    // was written in. Choosing another key hands the spelling back to it.
    for (const note of state.composition.notes) delete note.spelling;
    syncTransposeControls();
    scheduleSheetRender();
  });
  // However the loop range is set — the fields, the checkbox, a click on the
  // falling notes, a restored session — the marking on the score follows it
  for (const path of ['loopEnabled', 'loopStartBar', 'loopEndBar']) {
    on(`change:transport.${path}`, () => { refreshLoopMarker(); syncLoopControls(); });
  }
  on('change:midi.connected', ({ value }) => updateMidiStatus(value));
  on('change:midi.inputs', ({ value }) => {
    updateMidiInputsList(value);
    updateMidiStatus(state.midi.connected);
  });
  on('midi:unavailable', ({ reason }) => showMidiWarning(reason));
  on('midi:statechange', () => {});

  // Accuracy: key effects land where the hand is, the gauge tracks the run
  on('accuracy:note', ({ pitch, grade }) => {
    if (grade === 'perfect') spawnKeyEffect(pitch, 'perfect');
    else if (grade === 'good') spawnKeyEffect(pitch, 'good');
  });
  on('accuracy:wrong', ({ pitch }) => spawnKeyEffect(pitch, 'wrong'));

  // Learn: the highlighted keys are the instruction, so they follow the state
  on('transport:learn', ({ total, looping, startBar, endBar }) => {
    showLearnStatus(true);
    showToast(looping
      ? `Learn — bars ${startBar}–${endBar}, looping until you play it clean`
      : `Learn mode — ${total} note${total === 1 ? '' : 's'} to play`, 2000);
  });
  on('learn:waiting', (info) => {
    if (info.pitches.length || info.phase === 'memory' || info.phase === 'listen') updateLearnStatus(info);
    else setWaitingPitches([]);
  });
  // learn.js says what happened; the wording is this layer's business
  on('learn:say', ({ tone }) => showLearnBanner(tone));
  on('learn:react', ({ tone }) => showLearnReaction(tone));
  on('learn:tally', ({ correct, misses }) => updateLearnCounters(correct, misses));
  // The memory pass shows nothing, so the window has to be told to show nothing
  on('learn:phase', ({ phase, blind, cluster, clusters, whole }) => {
    setFallingBlind(blind);
    if (!clusters) { setLearnPhase(''); return; }
    const which = whole ? 'the whole section' : `cluster ${cluster + 1}/${clusters}`;
    setLearnPhase(`${CLUSTER_PHASE[phase] || ''} · ${which}`);
  });
  on('learn:hit', ({ pitch }) => spawnKeyEffect(pitch, 'good'));
  on('learn:wrong', ({ pitch }) => spawnKeyEffect(pitch, 'wrong'));
  // Only a looping session reports the pass it just finished; a straight
  // run-through has nothing to say until it is complete
  on('learn:pass', ({ pass, slips, clean }) => {
    if (clean) return;
    showToast(`${slips} slip${slips === 1 ? '' : 's'} on pass ${pass} — from the top`, 1800);
  });
  on('learn:complete', ({ total, passes, looping, clusters }) => {
    learnedInClusters = Boolean(clusters);
    showToast(looping
      ? `Clean pass — ${total} played in ${passes} attempt${passes === 1 ? '' : 's'}`
      : `Learn complete — ${total} played`, 2400);
  });

  on('accuracy:progress', (p) => updateGauge(p));
  on('accuracy:complete', (results) => showAccuracyResults(results));

  updateMidiStatus(false);
  applyStateToControls();
  syncFingeringGuessNote();
  scheduleSheetRender();
}

// Every control set from state in one pass. The app restores its last session
// before the UI is built, so each control has to be able to catch up rather
// than relying on the markup's default being right.
function applyStateToControls() {
  const { composition, ui } = state;

  document.getElementById('composition-name').textContent = composition.name || 'Untitled';
  document.getElementById('key-select').value = composition.keySignature;
  document.getElementById('ts-num').value = composition.timeSignature.numerator;
  document.getElementById('ts-den').value = composition.timeSignature.denominator;
  syncTempoControls();
  syncTransposeControls();

  for (const sel of quantizeSelects()) sel.value = String(ui.quantize);
  document.getElementById('learn-sections').value = String(ui.learnSectionBars);
  syncRecordHand();
  syncPracticeHand();
  document.getElementById('learn-cluster').value = ui.learnCluster;
  syncClusterHints();
  document.getElementById('legato-toggle').checked = ui.stepLegato;

  applyMuteUI(ui.muted);
  setVolume(Math.round(ui.volume * 100));
  applyClicksOnly();
  document.getElementById('btn-clicks-only').classList.toggle('active', ui.clicksOnly);
  document.getElementById('btn-metronome').classList.toggle('active', ui.metronomeEnabled);
  document.getElementById('metro-subdivision').value = String(ui.metronomeSubdivision);
  document.getElementById('btn-beat-overlay').classList.toggle('active', ui.showBeatOverlay);
  document.getElementById('btn-chord-overlay').classList.toggle('active', ui.showChordOverlay);
  document.getElementById('btn-fingering').classList.toggle('active', ui.showFingering);
  document.getElementById('btn-suggest-fingering').classList.toggle('active', ui.suggestFingering);
  document.getElementById('btn-hand-overlay').classList.toggle('active', ui.handOverlay);
  syncHandStage();
  document.getElementById('btn-count-in').classList.toggle('active', ui.countInEnabled);
  setPracticeMode(ui.trainMode ? 'train' : ui.learnMode ? 'learn' : null);

  syncLoopControls();

  setView(ui.view);
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
    if (holdingLearnMessage()) return;
    if (state.transport.mode === 'learning') { stopLearn(); return; }
    if (state.transport.mode === 'playing' || state.transport.mode === 'count-in') { stop(); return; }
    if (state.ui.learnMode) { startLearnSession(); return; }
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
  on('transport:learn', () => {
    document.getElementById('btn-play').classList.add('active');
    document.getElementById('btn-play').textContent = '⏸';
    document.getElementById('btn-record').classList.remove('active');
    document.getElementById('btn-step-record').classList.remove('active');
    setStepControlsVisible(false);
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
    showLearnStatus(false);
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

  // Everything that moves the playhead comes through here, including the moves
  // nothing is running to tick for: seeking, scrubbing, a section jump
  on('change:transport.currentTime', ({ value }) => {
    updatePositionDisplay(value);
    if (state.transport.mode === 'step-recording') {
      scheduleSheetRender(); // the step cursor is part of the drawing
    } else {
      movePlayhead(value);   // seeking while stopped only moves the overlay
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

// ── Transpose ────────────────────────────────────────────────────────────────
// The slider reads as a total offset from where the piece started, not a nudge,
// so moving it to +2 always means "two semitones above the original" however it
// got there. The key selector travels the same interval.

const TRANSPOSE_RANGE = 12;
const MIN_PITCH = 21;
const MAX_PITCH = 108;

// One key per pitch class, in the spellings the selector offers
const KEY_BY_PITCH_CLASS = {
  0: 'C', 1: 'Db', 2: 'D', 3: 'Eb', 4: 'E', 5: 'F',
  6: 'F#', 7: 'G', 8: 'Ab', 9: 'A', 10: 'Bb', 11: 'B',
};
const PITCH_CLASS_BY_KEY = {
  C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5,
  'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11,
};

// How far the piece can still move before a note leaves the keyboard. Checked
// up front so the shift is applied whole or not at all — clamping note by note
// would squash a chord together at the edges and could not be undone by
// dragging back.
function transposeBounds() {
  const pitches = state.composition.notes.map(n => n.pitch);
  if (!pitches.length) return { lo: -TRANSPOSE_RANGE, hi: TRANSPOSE_RANGE };
  const applied = state.ui.transpose;
  return {
    lo: Math.max(-TRANSPOSE_RANGE, applied + MIN_PITCH - Math.min(...pitches)),
    hi: Math.min(TRANSPOSE_RANGE, applied + MAX_PITCH - Math.max(...pitches)),
  };
}

function setTranspose(value) {
  const wanted = Math.round(Number(value));
  if (!Number.isFinite(wanted)) return;
  const { lo, hi } = transposeBounds();
  const target = Math.max(lo, Math.min(hi, wanted));
  if (target !== wanted) {
    showToast(`Cannot go past ${target > 0 ? '+' : ''}${target} — notes would fall off the keyboard`, 2200);
  }

  const delta = target - state.ui.transpose;
  if (delta) {
    transposeAll(delta);
    const pc = PITCH_CLASS_BY_KEY[state.composition.keySignature] ?? 0;
    update('composition.keySignature', KEY_BY_PITCH_CLASS[(((pc + delta) % 12) + 12) % 12]);
    update('ui.transpose', target);
    scheduleSheetRender();
  }
  syncTransposeControls();
}

// The slider follows the state, so undo moves it too
function syncTransposeControls() {
  const semitones = state.ui.transpose;
  const slider = document.getElementById('transpose-slider');
  const label = document.getElementById('transpose-value');
  if (!slider) return;
  slider.value = semitones;
  label.textContent = semitones > 0 ? `+${semitones}` : String(semitones);
  label.classList.toggle('shifted', semitones !== 0);
  document.getElementById('key-select').value = state.composition.keySignature;
}

function nudgeTranspose(direction) {
  setTranspose(state.ui.transpose + direction);
  showToast(`Transpose ${state.ui.transpose > 0 ? '+' : ''}${state.ui.transpose} · key of ${state.composition.keySignature}`, 1200);
}

// ── Hands ────────────────────────────────────────────────────────────────────
// Two ways to say which hand plays what: pick one before you record, or select
// notes afterwards and say so. Both write an explicit hand onto the note, which
// the inference then leaves alone.

const HAND_LABEL = { auto: 'worked out from the texture', left: 'the left hand', right: 'the right hand' };

function setRecordHand(hand) {
  update('ui.recordHand', hand);
  syncRecordHand();
  showToast(`New notes go to ${HAND_LABEL[hand]}`, 1600);
}

function syncRecordHand() {
  for (const opt of document.querySelectorAll('#record-hand .hand-opt')) {
    opt.classList.toggle('on', opt.dataset.hand === state.ui.recordHand);
  }
}

// Step through auto → left → right, so one key covers the whole control
const HAND_CYCLE = ['auto', 'left', 'right'];
function cycleRecordHand() {
  const next = HAND_CYCLE[(HAND_CYCLE.indexOf(state.ui.recordHand) + 1) % HAND_CYCLE.length];
  setRecordHand(next);
}

// Which hand the practice modes work on. A separate thing from the hand new
// notes are written to: this one changes nothing about the music, only what
// you are held to.
const PRACTICE_LABEL = { both: 'both hands', left: 'the left hand', right: 'the right hand' };
const PRACTICE_CYCLE = ['both', 'left', 'right'];

function setPracticeHand(hand) {
  const want = PRACTICE_CYCLE.includes(hand) ? hand : 'both';
  update('ui.practiceHand', want);
  syncPracticeHand();
  showToast(`Practising ${PRACTICE_LABEL[want]}`, 1600);
}

function syncPracticeHand() {
  const el = document.getElementById('practice-hand');
  el.value = state.ui.practiceHand;
  el.classList.toggle('left', state.ui.practiceHand === 'left');
  el.classList.toggle('right', state.ui.practiceHand === 'right');
}

function cyclePracticeHand() {
  const next = PRACTICE_CYCLE[(PRACTICE_CYCLE.indexOf(state.ui.practiceHand) + 1) % PRACTICE_CYCLE.length];
  setPracticeHand(next);
}

// What each choice does, said on hover — over the row while the list is open,
// and over the control itself once one is chosen. The list is the only place
// the difference is visible, and the names alone do not carry it: every choice
// but the first has a memory pass in it, which is the whole reason to pick one.
const CLUSTER_HOW = 'played to you in time, then walked through in silence, '
  + 'then asked for from memory — a wrong note anywhere in it and it comes round again';
const CLUSTER_HINTS = {
  off: 'Straight through the piece, one note at a time, waiting at each one until you play it. '
     + 'No memory pass — the quickest way to get a piece under your fingers.',
  halfBeat: `Half a beat at a time: ${CLUSTER_HOW}.`,
  beat:     `One beat at a time: ${CLUSTER_HOW}.`,
  twoBeats: `Two beats at a time: ${CLUSTER_HOW}.`,
  bar:      `One bar at a time: ${CLUSTER_HOW}.`,
  twoBars:  `Two bars at a time: ${CLUSTER_HOW}.`,
};

function syncClusterHints() {
  const sel = document.getElementById('learn-cluster');
  for (const opt of sel.options) opt.title = CLUSTER_HINTS[opt.value] || '';
  sel.title = CLUSTER_HINTS[sel.value] || '';
}

// How much learn mode takes at once. Remembered like every other option, so
// the way somebody has settled on learning is the way the next song starts.
function setLearnCluster(value) {
  const choice = CLUSTERS[value] ? value : 'off';
  update('ui.learnCluster', choice);
  document.getElementById('learn-cluster').value = choice;
  syncClusterHints();
  showToast(choice === 'off'
    ? 'Fast learn — one note at a time, no memory pass'
    : `Learn in ${CLUSTERS[choice].name.toLowerCase().replace(' clusters', '-long clusters')}`, 1800);
}

function assignSelectedHand(hand) {
  const ids = getSelectedIds();
  if (!ids.size) { showToast('Select some notes first', 1600); return; }
  const changed = setNotesHand(ids, hand);
  showToast(changed
    ? `${changed} note${changed === 1 ? '' : 's'} → ${HAND_LABEL[hand]}`
    : `Already ${HAND_LABEL[hand]}`, 1800);
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

// Train and Learn both take over the Play button, so only one can be armed
function setPracticeMode(mode) {
  update('ui.trainMode', mode === 'train');
  update('ui.learnMode', mode === 'learn');
  document.getElementById('btn-train-mode').classList.toggle('active', mode === 'train');
  document.getElementById('btn-learn-mode').classList.toggle('active', mode === 'learn');
  document.getElementById('btn-play').title =
    mode === 'train' ? 'Start Training' : mode === 'learn' ? 'Start Learning' : 'Play';
  // The loop range doubles as the section learn mode drills, so say so while
  // that is what it will do
  document.getElementById('loop-enabled').title = mode === 'learn'
    ? 'Loop the bar range — in learn mode, repeat it until you play it clean'
    : 'Loop the bar range during playback';
}

function toggleTrainMode() {
  const active = !state.ui.trainMode;
  setPracticeMode(active ? 'train' : null);
  showToast(active ? 'Training mode ON — press Play to start' : 'Training mode OFF');
}

function toggleLearnMode() {
  const active = !state.ui.learnMode;
  setPracticeMode(active ? 'learn' : null);
  showToast(active
    ? 'Learn mode ON — press Play, then play each note as it lands'
    : 'Learn mode OFF');
}

// ── Learn sessions ───────────────────────────────────────────────────────────

function sectionSize() {
  return state.ui.learnSectionBars;
}

// Space and the play button both mean "get on with it". Learn mode reads as
// still running while it holds a message — a verdict, or what the next pass is
// asking for — so both of them would land on "stop whatever is running" and end
// a session that is a moment away from carrying on by itself. A section walk
// stopped that way never offers its end-of-section choice at all, so the keys
// wait for the message instead.
function holdingLearnMessage() {
  return state.transport.mode === 'learning' && isHoldingMessage();
}

function startLearnSession() {
  if (!state.composition.notes.length) {
    showToast('Record something first to learn');
    return;
  }
  if (isWalking()) { stopSectionWalk(); return; }
  clearKeyEffects();

  const bars = sectionSize();
  if (bars) {
    const count = startSectionWalk(bars);
    if (!count) showToast('Nothing to learn here');
    return;
  }
  if (!startLearn()) showToast('Nothing to learn here');
}

// ── Scales and arpeggios ─────────────────────────────────────────────────────
// A generated exercise is an ordinary composition, which is the whole trick:
// once the notes are on the stave with hands on them, playing, looping,
// training, learn mode and hand-selective practice all work on a scale for
// free. Nothing downstream needs to know it was generated.

let genKind = 'scale';

const OCTAVE_CHOICES = [2, 3, 4, 5, 6];

function fillOptions(el, entries) {
  el.replaceChildren();
  // Grouped tables get their groups; flat ones are a plain list
  const groups = new Map();
  for (const [value, item] of entries) {
    const group = item.group || '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push([value, item.name]);
  }
  for (const [group, items] of groups) {
    const parent = group ? document.createElement('optgroup') : el;
    if (group) { parent.label = group; el.appendChild(parent); }
    for (const [value, name] of items) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = name;
      parent.appendChild(opt);
    }
  }
}

function genOptions() {
  return {
    kind: genKind,
    rootPc: Number(document.getElementById('gen-root').value),
    type: document.getElementById('gen-type').value,
    inversion: Number(document.getElementById('gen-inversion').value) || 0,
    octaves: Number(document.getElementById('gen-octaves').value),
    octave: Number(document.getElementById('gen-octave').value),
    hands: document.getElementById('gen-hands').value,
    direction: document.getElementById('gen-direction').value,
    pattern: document.getElementById('gen-pattern').value,
    noteValue: Number(document.getElementById('gen-note-value').value),
    tempo: state.composition.tempo,
  };
}

// Inversions only go as far as the chord has notes, so the list is rebuilt
// whenever the chord changes rather than offering a third inversion of a triad
function syncInversions() {
  const field = document.getElementById('gen-inversion-field');
  field.classList.toggle('hidden', genKind !== 'arpeggio');
  if (genKind !== 'arpeggio') return;
  const el = document.getElementById('gen-inversion');
  const chord = CHORDS[document.getElementById('gen-type').value] || CHORDS.major;
  const names = ['Root position', '1st inversion', '2nd inversion', '3rd inversion'];
  const wanted = Math.min(chord.steps.length, names.length);
  if (el.options.length !== wanted) {
    const keep = Math.min(Number(el.value) || 0, wanted - 1);
    el.replaceChildren();
    for (let i = 0; i < wanted; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = names[i];
      el.appendChild(opt);
    }
    el.value = String(keep);
  }
}

function updatePracticeSummary() {
  syncInversions();
  const opts = genOptions();
  const exercise = buildExercise(opts);
  const beats = exercise.durationMs / ((60 / opts.tempo) * 1000);
  const bars = beats / (state.composition.timeSignature.numerator *
    (4 / state.composition.timeSignature.denominator));
  const hands = opts.hands === 'right' || opts.hands === 'left' ? '' : ' per hand';
  document.getElementById('practice-summary').textContent =
    `${exercise.title} — ${exercise.count} notes${hands}, ` +
    `${bars.toFixed(bars % 1 ? 1 : 0)} bars at ${Math.round(opts.tempo)} BPM, key of ${exercise.keySignature}`;
}

function setGenKind(kind) {
  genKind = kind;
  for (const tab of document.querySelectorAll('.practice-tab')) {
    tab.classList.toggle('active', tab.dataset.kind === kind);
  }
  document.getElementById('gen-type-label').textContent = kind === 'arpeggio' ? 'Chord' : 'Scale';
  document.getElementById('practice-blurb').textContent = kind === 'arpeggio'
    ? 'Write an arpeggio onto the stave to practise. Everything else works on it: play it, loop a stretch, train it, or walk it in learn mode.'
    : 'Write a scale onto the stave to practise. Everything else works on it: play it, loop a stretch, train it, or walk it in learn mode.';
  fillOptions(document.getElementById('gen-type'), Object.entries(kind === 'arpeggio' ? CHORDS : SCALES));
  document.getElementById('btn-practice-generate').textContent =
    kind === 'arpeggio' ? 'Write the arpeggio' : 'Write the scale';
  updatePracticeSummary();
}

function writeExercise() {
  const exercise = buildExercise(genOptions());
  if (!exercise.notes.length) { showToast('Nothing to write'); return; }

  // The key first: the notes carry spellings written for it, and changing the
  // key is what hands spelling back to the key signature
  update('composition.keySignature', exercise.keySignature);
  state.composition.notes = exercise.notes;
  state.composition.name = exercise.title;
  // A generated exercise starts at the top, and the last thing loop-marked was
  // about some other piece
  update('transport.currentTime', 0);
  update('transport.loopEnabled', false);
  update('ui.transpose', 0);
  emit('transport:noteschanged', state.composition.notes);

  document.getElementById('composition-name').textContent = exercise.title;
  document.getElementById('practice-modal').classList.add('hidden');
  showToast(exercise.title, 2400);
}

function bindPracticeGenerator() {
  const modal = document.getElementById('practice-modal');

  fillOptions(document.getElementById('gen-root'), ROOTS.map(r => [String(r.pc), { name: r.name }]));
  fillOptions(document.getElementById('gen-hands'), Object.entries(HANDS));
  fillOptions(document.getElementById('gen-direction'), Object.entries(DIRECTIONS));
  fillOptions(document.getElementById('gen-pattern'), Object.entries(PATTERNS));
  fillOptions(document.getElementById('gen-note-value'), Object.entries(NOTE_VALUES));
  fillOptions(document.getElementById('gen-octave'),
    OCTAVE_CHOICES.map(o => [String(o), { name: `Octave ${o}${o === 4 ? ' (middle C)' : ''}` }]));

  document.getElementById('gen-direction').value = 'updown';
  document.getElementById('gen-octave').value = '4';
  document.getElementById('gen-note-value').value = '8';

  for (const tab of document.querySelectorAll('.practice-tab')) {
    tab.onclick = () => setGenKind(tab.dataset.kind);
  }
  for (const el of modal.querySelectorAll('select')) {
    el.addEventListener('change', updatePracticeSummary);
  }
  document.getElementById('btn-practice').onclick = () => openPracticeGenerator();
  document.getElementById('btn-practice-cancel').onclick = () => modal.classList.add('hidden');
  document.getElementById('btn-practice-generate').onclick = writeExercise;
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  setGenKind('scale');
}

function openPracticeGenerator(kind = genKind) {
  setGenKind(kind);
  document.getElementById('practice-modal').classList.remove('hidden');
}

// ── Profiles ─────────────────────────────────────────────────────────────────

function bindProfiles() {
  const modal = document.getElementById('profiles-modal');
  const select = document.getElementById('profile-select');

  select.onchange = (e) => { switchProfile(e.target.value); showProfileWelcome(); };
  document.getElementById('btn-profiles').onclick = () => { renderProfiles(); modal.classList.remove('hidden'); };
  document.getElementById('btn-close-profiles').onclick = () => modal.classList.add('hidden');

  document.getElementById('btn-profile-create').onclick = () => {
    const input = document.getElementById('profile-new-name');
    createProfile(input.value);
    input.value = '';
    renderProfiles();
    showToast(`Now practising as ${currentProfile().name}`);
  };

  document.getElementById('btn-profile-folder').onclick = async () => {
    if (!canUseFolder()) {
      showToast('This browser cannot be given a folder — profile files download instead', 4000);
      return;
    }
    try {
      await chooseFolder();
      await renderFolderState();
      showToast('Profile folder set');
    } catch { /* the picker was dismissed */ }
  };

  document.getElementById('btn-profile-scan').onclick = async () => {
    const handle = await folderHandle({ prompt: true });
    if (!handle) { showToast('No folder chosen yet', 2200); return; }
    const found = await scanFolder(handle);
    for (const { bundle } of found) adoptProfile(bundle.profile);
    renderProfiles();
    showToast(found.length
      ? `Found ${found.length} profile${found.length === 1 ? '' : 's'} in the folder`
      : 'No profile files in that folder', 2600);
  };

  const fileInput = document.getElementById('profile-file');
  document.getElementById('btn-profile-file').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const bundle = bundleFromJSON(await file.text());
      loadBundle(bundle);
      renderProfiles();
    } catch (err) {
      showToast(`Could not read that file: ${err.message}`, 4000);
    }
  };

  on('profiles:changed', () => renderProfileSelect());
  renderProfileSelect();
}

// A file carries the profile, the settings and the song together, so taking
// one on means becoming that player mid-practice rather than just borrowing
// their name
function loadBundle(bundle) {
  if (state.composition.notes.length &&
      !confirm('Load this profile? It replaces the current song and settings.')) return;
  const applied = applyBundle(bundle);
  applyStateToControls();
  resetHistory();
  scheduleSheetRender();
  const parts = [applied.profile ? `profile "${applied.profile.name}"` : null,
                 applied.composition ? 'song' : null,
                 applied.settings ? 'settings' : null].filter(Boolean);
  showToast(`Loaded ${parts.join(', ')}`, 3000);
  showProfileWelcome();
}

// Say where this profile left off, if it left off anywhere
function showProfileWelcome() {
  const position = learningPosition();
  if (!position) return;
  showToast(
    `${currentProfile().name} · last learning "${position.songName}", section ${position.sectionIndex + 1}`,
    3200
  );
}

function renderProfileSelect() {
  const select = document.getElementById('profile-select');
  const active = currentProfile();
  select.innerHTML = '';
  for (const profile of listProfiles()) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.name;
    option.selected = profile.id === active.id;
    select.appendChild(option);
  }
}

function renderProfiles() {
  const list = document.getElementById('profile-list');
  const active = currentProfile();
  list.innerHTML = '';

  for (const profile of listProfiles()) {
    const row = document.createElement('div');
    row.className = `profile-item${profile.id === active.id ? ' active' : ''}`;

    const name = document.createElement('span');
    name.className = 'profile-item-name';
    name.textContent = profile.name;

    const meta = document.createElement('span');
    meta.className = 'profile-item-meta';
    const at = profile.id === active.id ? learningPosition() : null;
    meta.textContent = at ? `section ${at.sectionIndex + 1} of "${at.songName}"` : '';

    row.append(name, meta);

    if (profile.id !== active.id) {
      const use = document.createElement('button');
      use.className = 'modal-btn';
      use.textContent = 'Use';
      use.onclick = () => { switchProfile(profile.id); renderProfiles(); showProfileWelcome(); };
      row.appendChild(use);
    }

    const remove = document.createElement('button');
    remove.className = 'modal-btn';
    remove.textContent = 'Delete';
    remove.disabled = listProfiles().length <= 1;
    remove.onclick = () => { if (deleteProfile(profile.id)) renderProfiles(); };
    row.appendChild(remove);

    list.appendChild(row);
  }
  renderFolderState();
}

async function renderFolderState() {
  const el = document.getElementById('profile-folder-state');
  if (!canUseFolder()) {
    el.textContent = 'This browser cannot be given a folder. Save downloads a profile file instead, and it can be loaded back below.';
    return;
  }
  const handle = await folderHandle();
  el.textContent = handle
    ? `Using "${handle.name}". Save writes this profile there.`
    : 'No folder chosen. Save downloads a profile file instead.';
}

// ── Section walk ─────────────────────────────────────────────────────────────

function setLearnPhase(text) {
  const el = document.getElementById('learn-phase');
  el.classList.toggle('hidden', !text);
  el.textContent = text || '';
}

// Which button the section-end choice lands on, and which key Space follows
let learnedInClusters = false;

function setSectionDefault(which) {
  const again = document.getElementById('btn-section-again');
  const next = document.getElementById('btn-section-next');
  again.classList.toggle('primary', which === 'again');
  next.classList.toggle('primary', which === 'next');
  // The key hint moves with the default, so the label never lies about it
  again.querySelector('.kbd-hint').textContent = which === 'again' ? 'Space' : 'A';
  next.querySelector('.kbd-hint').textContent = which === 'next' ? 'Space' : 'N';
}

function barsLabel({ startBar, endBar }) {
  return startBar === endBar ? `bar ${startBar}` : `bars ${startBar}–${endBar}`;
}

function bindSectionWalk() {
  const modal = document.getElementById('section-modal');

  on('sections:preview', (s) => {
    showLearnStatus(true);
    setWaitingPitches([]);
    modal.classList.add('hidden');
    setLearnPhase(`Listen · section ${s.index + 1}/${s.total}`);
    document.getElementById('learn-count').textContent = barsLabel(s);
    document.getElementById('learn-hint').textContent = 'Playing it through first';
  });

  on('sections:walk', (s) => {
    setLearnPhase(`Your turn · section ${s.index + 1}/${s.total}`);
    // Where this profile has got to, so loading it comes back here
    setLearningPosition({
      songName: state.composition.name,
      sectionBars: state.ui.learnSectionBars,
      sectionIndex: s.index,
    });
  });

  on('sections:done', (s) => {
    setLearnPhase('');
    showLearnStatus(false);
    // Learning it again is the default when the section was walked note by
    // note. In clusters it has just been played through whole from memory, so
    // going on is what somebody is reaching for.
    setSectionDefault(learnedInClusters ? 'next' : 'again');
    document.getElementById('section-title').textContent =
      `${barsLabel(s).replace(/^b/, 'B')} done`;
    document.getElementById('section-sub').textContent = s.last
      ? 'That was the last section.'
      : `Section ${s.index + 1} of ${s.total}. What next?`;
    // Only the label — writing the button's whole content would take the key
    // hint out with it
    document.getElementById('section-next-label').textContent =
      s.last ? 'Finish' : 'Next section';
    modal.classList.remove('hidden');
  });

  on('sections:end', () => { modal.classList.add('hidden'); setLearnPhase(''); showLearnStatus(false); });
  on('sections:complete', ({ total }) =>
    showToast(`Worked through all ${total} section${total === 1 ? '' : 's'}`, 2600));

  document.getElementById('learn-sections').onchange = (e) =>
    update('ui.learnSectionBars', parseInt(e.target.value) || 0);
  document.getElementById('btn-section-again').onclick = () => repeatSection();
  document.getElementById('btn-section-next').onclick = () => advanceSection();
  document.getElementById('btn-section-train').onclick = () => trainCurrentSection();
}

// Training takes the transport, so the walk steps aside rather than competing
// The section being trained, so the speed it ends up at can be remembered
// against it rather than against the piece as a whole
let trainingSectionKey = null;

function keyForSection(section) {
  return sectionKey(state.composition.name, state.ui.learnSectionBars, section);
}

function trainCurrentSection() {
  const section = handOverForTraining();
  document.getElementById('section-modal').classList.add('hidden');
  if (!section) return;

  // A section starts slow the first time and picks up where this profile left
  // it after that — the speed is the thing a player earns, so it belongs to
  // them rather than to the piece
  trainingSectionKey = keyForSection(section);
  const bpm = sectionTempo(trainingSectionKey);
  if (bpm !== state.composition.tempo) {
    setTempo(bpm);
    showToast(`Training bars ${section.startBar}–${section.endBar} at ${bpm} BPM`, 1800);
  }

  setPracticeMode('train');
  startTrainingSession(section);
}

function showLearnStatus(visible) {
  document.getElementById('learn-status').classList.toggle('hidden', !visible);
  document.getElementById('learn-counters').classList.toggle('hidden', !visible);
  if (visible) { learnCounts = {}; updateLearnCounters(0, 0); return; }
  showLearnReaction(null);
  setWaitingPitches([]);
}

// ── The middle of the falling window ─────────────────────────────────────────
// Said large, where somebody looking at their hands will still catch it — and
// one thing at a time. The banner is what a whole pass is asking for or how it
// went; the face is the answer to the note just played. Whichever spoke last
// has the middle: a face means the player has started, so the instruction that
// opened the pass has done its job, and a verdict means the notes it is a
// verdict on are finished with.

const BANNER = {
  memory: 'Now try from memory',
  memoryWhole: 'Now the whole section from memory',
  good: 'Good job!',
  almost: 'Almost…',
};

const REACTION = { hit: '👍', miss: '😞' };
const REACTION_MS = 700;
let reactionTimer = null;

function hideLearnBanner() {
  const el = document.getElementById('learn-banner');
  el.classList.add('hidden');
  el.classList.remove('good', 'almost');
  el.textContent = '';
}

function hideLearnReaction() {
  clearTimeout(reactionTimer);
  reactionTimer = null;
  document.getElementById('learn-react').classList.add('hidden');
}

function showLearnBanner(tone) {
  const text = BANNER[tone];
  if (!text) { hideLearnBanner(); return; }
  hideLearnReaction();
  const el = document.getElementById('learn-banner');
  el.classList.remove('hidden');
  el.classList.toggle('good', tone === 'good');
  el.classList.toggle('almost', tone === 'almost');
  el.textContent = text;
}

function showLearnReaction(tone) {
  const face = REACTION[tone];
  // Unconditionally, so a second face gets its own full life rather than
  // inheriting what was left of the one before it
  clearTimeout(reactionTimer);
  if (!face) { hideLearnReaction(); return; }
  hideLearnBanner();
  const el = document.getElementById('learn-react');
  el.textContent = face;
  el.classList.remove('hidden', 'pop');
  void el.offsetWidth; // restart the pop rather than inherit a running one
  el.classList.add('pop');
  reactionTimer = setTimeout(() => el.classList.add('hidden'), REACTION_MS);
}

const LEARN_COUNTS = [['correct', 'lc-correct'], ['missed', 'lc-missed']];
let learnCounts = {};

function updateLearnCounters(correct, misses) {
  paintCounts(LEARN_COUNTS, { correct, missed: misses }, learnCounts);
}

// What each pass of a cluster is called, and what it asks of the player
const CLUSTER_PHASE = { listen: 'Listen', guided: 'Follow it', memory: 'From memory' };
const CLUSTER_HINT = {
  listen: 'Listen to the cluster',
  memory: 'Now play the cluster again from memory',
};

function updateLearnStatus({ pitches, done, total, looping, pass, slips, phase, cluster }) {
  setWaitingPitches(pitches);
  document.getElementById('learn-count').textContent = cluster
    ? `${done - cluster.from + 1} / ${cluster.to - cluster.from + 1}`
    : `${done + 1} / ${total}`;
  document.getElementById('learn-hint').textContent = CLUSTER_HINT[phase] || (pitches.length === 1
    ? 'Play the highlighted key'
    : `Play the ${pitches.length} highlighted keys together`);

  const passEl = document.getElementById('learn-pass');
  passEl.classList.toggle('hidden', !looping);
  if (!looping) return;
  passEl.classList.toggle('dirty', slips > 0);
  passEl.textContent = slips
    ? `pass ${pass} · ${slips} slip${slips === 1 ? '' : 's'}`
    : `pass ${pass} · clean`;
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

// Save keeps the composition in the browser, as it always has, and also writes
// the whole state — profile included — to a file. Pressing Save is the one
// moment the app can be sure the player wants something kept outside it.
async function saveCurrentComposition() {
  const name = document.getElementById('composition-name').textContent.trim() || 'Untitled';
  update('composition.name', name);
  const saved = await saveComposition({ ...state.composition });
  update('composition.id', saved.id);

  const profile = currentProfile();
  const text = bundleToJSON(collectBundle());
  const filename = fileNameFor(profile);

  const handle = await folderHandle({ prompt: true });
  if (handle) {
    try {
      await writeToFolder(handle, filename, text);
      showToast(`Saved · ${filename} written to the profile folder`, 2600);
      return;
    } catch (err) {
      showToast(`Saved to the browser, but the folder refused: ${err.message}`, 4000);
      return;
    }
  }
  // No folder configured, so the file goes the only other way out
  download(text, 'application/json', filename);
}

function download(data, mimeType, filename) {
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`Exported ${filename}`);
}

// The composition name is editable in place, so read it back before writing
// it into the file
function currentName() {
  const name = document.getElementById('composition-name').textContent.trim() || 'Untitled';
  update('composition.name', name);
  return name;
}

function exportComposition() {
  const name = currentName();
  download(compositionToJSON(state.composition), 'application/json', `${fileSafeName(name)}.json`);
}

function exportMidi() {
  const name = currentName();
  if (!state.composition.notes.length) {
    showToast('Nothing to export yet');
    return;
  }
  download(compositionToMidi(state.composition), 'audio/midi', `${fileSafeName(name)}.mid`);
}

function importComposition() {
  document.getElementById('import-file').click();
}

// One Import button for both formats. A MIDI file announces itself in its
// first four bytes, which is more reliable than trusting the extension.
async function readImportedFile(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isMidi = String.fromCharCode(...head) === 'MThd';
  if (isMidi) return midiToComposition(await file.arrayBuffer());
  if (/\.midi?$/i.test(file.name)) throw new Error('That .mid file does not start with a MIDI header');
  return compositionFromJSON(await file.text());
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
  // Dismissing the section choice means stopping there, not skipping ahead
  else if (top.id === 'section-modal') stopSectionWalk();
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

const SUBDIVISIONS = [1, 2, 3, 4];
const SUBDIVISION_NAME = { 1: 'the beat only', 2: 'eighths', 3: 'triplets', 4: 'sixteenths' };

function setSubdivision(value) {
  const subs = SUBDIVISIONS.includes(Number(value)) ? Number(value) : 1;
  update('ui.metronomeSubdivision', subs);
  document.getElementById('metro-subdivision').value = String(subs);
  // Ticks are counted in the old division, so a running metronome has to be
  // re-anchored rather than left to carry a stale count into the new one
  if (state.ui.metronomeEnabled && state.transport.mode !== 'stopped') {
    startMetronome(state.transport.currentTime);
  }
  showToast(`Metronome clicks ${SUBDIVISION_NAME[subs]}`, 1500);
}

function cycleSubdivision() {
  const i = SUBDIVISIONS.indexOf(state.ui.metronomeSubdivision);
  setSubdivision(SUBDIVISIONS[(i + 1) % SUBDIVISIONS.length]);
}

// What is written over the playing, beyond the notes themselves. Each is its
// own switch: the beat counter is worth watching whether or not the clicks are
// audible, the finger numbers are a crutch to be put down at some point, and
// any of them can go when the notes are all you want to see.
const OVERLAYS = {
  beat:      { path: 'ui.showBeatOverlay',  button: 'btn-beat-overlay',  on: 'Beat counter on',  off: 'Beat counter off' },
  chord:     { path: 'ui.showChordOverlay', button: 'btn-chord-overlay', on: 'Chord names on',   off: 'Chord names off' },
  // The falling notes are redrawn every frame and pick their overlays up for
  // free; the score is drawn on demand and has to be asked again
  fingering: { path: 'ui.showFingering',    button: 'btn-fingering',     on: 'Fingering on',     off: 'Fingering off', redrawsSheet: true },
};

function toggleOverlay(which) {
  const { path, button, on, off, redrawsSheet } = OVERLAYS[which];
  const shown = !state.ui[path.split('.')[1]];
  update(path, shown);
  document.getElementById(button).classList.toggle('active', shown);
  if (redrawsSheet) scheduleSheetRender();

  // Switching a display on and seeing nothing appear reads as a broken switch,
  // and there is no way to tell from the button — which is lit either way —
  // that the piece simply has nothing to show. Say so, and say what would.
  if (shown && which === 'fingering' && !fingeringAvailable()) {
    showToast('Fingering on — this piece has none written. Turn on Suggest for an automated one.', 3000);
    return;
  }
  showToast(shown ? on : off, 1200);
}

// Whether there is any fingering to draw: one the piece carries, or one the
// suggester has worked out
function fingeringAvailable() {
  return hasSuggestions() || state.composition.notes.some(n => n.finger);
}

// ── Suggested fingering ──────────────────────────────────────────────────────
// Working out a fingering for a piece nobody has fingered. Kept apart from the
// Fingering switch above, which only decides whether to show numbers: this one
// decides whether to invent them, and what it invents is a guess. It says so
// on the button, in the toast, above the score, and in the italics the digits
// are set in.

function syncFingeringGuessNote() {
  const note = document.getElementById('fingering-guess-note');
  if (note) note.classList.toggle('hidden', !(state.ui.suggestFingering && state.ui.showFingering));
}

// The suggestion is for the whole passage at once, so any edit invalidates all
// of it rather than just the note that moved. Called from the render pass,
// after the hands have been inferred and no more than once per debounce.
function rebuildFingeringSuggestions() {
  refreshSuggestions(state.composition.notes);
  syncFingeringGuessNote();
}

// ── Hands instead of numbers ─────────────────────────────────────────────────
// The same fingering, shown as a hand on the keys rather than a digit. It says
// the thing a digit cannot: which way the hand is facing, and when the thumb
// has to travel under it to reach the next note.
function syncHandStage() {
  document.body.classList.toggle('hands-shown', state.ui.handOverlay && state.ui.showFingering);
}

function toggleHandOverlay() {
  const on = !state.ui.handOverlay;
  update('ui.handOverlay', on);
  document.getElementById('btn-hand-overlay').classList.toggle('active', on);

  // Hands are a way of showing the fingering, so asking for them asks for it
  if (on && !state.ui.showFingering) {
    update('ui.showFingering', true);
    document.getElementById('btn-fingering').classList.add('active');
    scheduleSheetRender();
  }
  syncHandStage();
  showToast(on ? 'Hands on the keys' : 'Finger numbers on the keys', 1400);
}

function toggleSuggestFingering() {
  const on = !state.ui.suggestFingering;
  update('ui.suggestFingering', on);
  document.getElementById('btn-suggest-fingering').classList.toggle('active', on);

  // Asking for a fingering and being shown nothing is not an answer, so turning
  // this on turns the numbers on with it
  if (on && !state.ui.showFingering) {
    update('ui.showFingering', true);
    document.getElementById('btn-fingering').classList.add('active');
  }

  syncFingeringGuessNote();
  scheduleSheetRender();
  showToast(on ? 'Suggested fingering on — an automated guess, not editorial' : 'Suggested fingering off', 2200);
}

function toggleMetronome() {
  const enabled = !state.ui.metronomeEnabled;
  update('ui.metronomeEnabled', enabled);
  document.getElementById('btn-metronome').classList.toggle('active', enabled);
  if (enabled) {
    // Turning it on mid-take should be audible straight away
    if (state.transport.mode === 'playing' || state.transport.mode === 'recording') {
      startMetronome(state.transport.currentTime);
    }
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

// The section size divides a piece for training the same way it divides one for
// learning — it is one setting, and the two disagreeing about what a section is
// would make it useless. Training read only the loop range, so a player who had
// set 2-bar sections and pressed Train got the whole piece and no hint as to
// why.
//
// Which section: the one the playhead is in. "Train where I am" is what
// reaching for the button means, and after a section walk or a scrub the
// playhead is already sitting in the passage being worked on.
function sectionAtPlayhead() {
  const size = sectionSize();
  if (!size) return null;
  const sections = buildSections(size);
  if (!sections.length) return null;
  const { tempo, timeSignature } = state.composition;
  const here = barAtMs(state.transport.currentTime, tempo, timeSignature);
  return sections.find(s => here >= s.startBar && here <= s.endBar) || sections[0];
}

// Bar numbers are 1-based and inclusive of `startBar`, exclusive past `endBar`
function rangeForBars({ startBar, endBar }) {
  const { tempo, timeSignature } = state.composition;
  return barRangeMs(startBar, endBar, tempo, timeSignature);
}

function startTrainingSession(bars = null) {
  if (!state.composition.notes.length) {
    showToast('Record something first to train with');
    return;
  }
  document.getElementById('accuracy-modal').classList.add('hidden');
  // An explicit section wins, then a marked loop, then the section size — each
  // one a narrower statement of intent than the last, and the whole piece only
  // when none of them has been made
  const target = bars || loopBars() || sectionAtPlayhead();
  lastTrainingBars = target ? { startBar: target.startBar, endBar: target.endBar } : null;
  if (!bars && lastTrainingBars) {
    showToast(`Training bars ${lastTrainingBars.startBar}–${lastTrainingBars.endBar}`, 1800);
  }
  endReplay();
  clearKeyEffects();
  showGauge(true);

  const range = lastTrainingBars ? rangeForBars(lastTrainingBars) : null;
  update('transport.currentTime', range ? range.startMs : 0);

  withCountIn(() => {
    startAccuracy(state.composition, range);
    if (range) playRange(range.startMs, range.endMs, range.tailMs);
    else play();
  });
}

function retryTraining() {
  startTrainingSession(lastTrainingBars);
}

// ── Replaying the take ───────────────────────────────────────────────────────
// A score tells you how it went. It does not tell you where, and "68%" with a
// note or two missed is a puzzle rather than a lesson. So the run is played
// back: what the player actually pressed, sounding on the same clock, with
// every keypress drawn as an outline over the note it was aimed at. A ring
// trailing above its note is a note played late; one running ahead is a rush;
// a red one on its own is a note that was not written at all.

let replayStopper = null;
// The last run's results, kept so the replay can put the screen back up
let lastResults = null;

function replayTake() {
  const take = getTake();
  if (!take || !take.notes.length) {
    showToast('Nothing to replay — no keys were pressed in that run', 2200);
    return;
  }
  document.getElementById('accuracy-modal').classList.add('hidden');
  endReplay();

  const range = take.range;
  // Far enough back that the first keypress is not already at the hit line,
  // and far enough on that the last one has somewhere to land
  const first = Math.min(...take.notes.map(n => n.startTime));
  const last = Math.max(...take.notes.map(n => n.startTime + n.duration));
  const from = Math.max(0, Math.min(range ? range.startMs : first, first) - 200);
  const to = Math.max(range ? range.endMs : last, last) + 700;

  setTakeGhosts(take.notes);
  setPlaybackSource(take.notes);
  startReplayCounters(take);
  // Reaching the end puts the results back up, so Try Again and the practice
  // suggestion are where they were rather than a screen the replay swallowed
  replayStopper = on('transport:stop', () => endReplay(true));
  showToast('Replaying your take — outlines are the keys you pressed', 2600);
  playRange(from, to);
}

// Whatever ends the replay — it running out, the transport being stopped, a new
// run being started — puts the sound and the drawing back to the piece
function endReplay(reopenResults = false) {
  const wasReplaying = Boolean(replayStopper);
  if (replayStopper) { replayStopper(); replayStopper = null; }
  setPlaybackSource(null);
  setTakeGhosts([]);
  stopReplayCounters();
  if (wasReplaying && reopenResults && lastResults) showAccuracyResults(lastResults);
}

// ── The tally, counted off as it goes ────────────────────────────────────────
// The same numbers the results screen ends on, but arrived at in front of you:
// the missed counter ticking up at the moment the note goes past unplayed says
// where it went wrong far more plainly than the same figure does afterwards.
//
// Everything at or before the playhead is counted, rather than kept as a
// running total that events push at — so scrubbing backwards during a replay
// takes the counts back down with it instead of leaving them stranded high.

const REPLAY_COUNTS = [
  ['perfect', 'rc-perfect'],
  ['good', 'rc-good'],
  ['almost', 'rc-almost'],
  ['missed', 'rc-missed'],
  ['extra', 'rc-extra'],
];

let replayData = null;
let replayTicker = null;
let replayShown = {};

function startReplayCounters(take) {
  replayData = take;
  replayShown = {};
  document.getElementById('replay-counters').classList.remove('hidden');
  for (const [, id] of REPLAY_COUNTS) document.getElementById(id).textContent = '0';
  replayTicker = on('transport:tick', updateReplayCounters);
  updateReplayCounters(state.transport.currentTime);
}

function stopReplayCounters() {
  if (replayTicker) { replayTicker(); replayTicker = null; }
  replayData = null;
  document.getElementById('replay-counters').classList.add('hidden');
}

function updateReplayCounters(nowMs) {
  if (!replayData) return;
  const counts = { perfect: 0, good: 0, almost: 0, missed: 0, extra: 0 };

  // A written note is accounted for once the playhead has passed it
  for (const note of replayData.expected) {
    if (note.startTime > nowMs) continue;
    if (note.grade === 'perfect') counts.perfect++;
    else if (note.grade === 'good') counts.good++;
    else if (note.grade === 'almost') counts.almost++;
    else counts.missed++;
  }
  // A stray is counted from the moment the key went down, which is where the
  // outline for it is on screen
  for (const note of replayData.notes) {
    if (note.stray && note.startTime <= nowMs) counts.extra++;
  }

  paintCounts(REPLAY_COUNTS, counts, replayShown);
}

// Write the counts that moved, and flash them, so the moment a number goes up
// is visible rather than only the total afterwards. `seen` carries what is on
// screen between calls; an empty one paints the figures without flashing them,
// which is what a tally opening at zero wants.
function paintCounts(pairs, counts, seen) {
  for (const [key, id] of pairs) {
    if (seen[key] === counts[key]) continue;
    const el = document.getElementById(id);
    el.textContent = counts[key];
    // Restart the flash rather than letting a second bump inherit a running one
    el.classList.remove('bumped');
    void el.offsetWidth;
    // Only on the way up. Scrubbing a replay backwards and clearing a tally for
    // a fresh attempt both take counts down, and the bump reads as "that just
    // went up" — the wrong thing to say about either.
    if (seen[key] !== undefined && counts[key] > seen[key]) el.classList.add('bumped');
    seen[key] = counts[key];
  }
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
  // Getting a section faster is progress worth keeping
  if (trainingSectionKey) rememberSectionTempo(trainingSectionKey, state.composition.tempo);
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

  for (const opt of document.querySelectorAll('#record-hand .hand-opt')) {
    opt.onclick = () => setRecordHand(opt.dataset.hand);
  }
  document.getElementById('practice-hand').onchange = (e) => setPracticeHand(e.target.value);
  document.getElementById('learn-cluster').onchange = (e) => setLearnCluster(e.target.value);
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
  document.getElementById('metro-subdivision').onchange = (e) => setSubdivision(e.target.value);
  document.getElementById('btn-beat-overlay').onclick = () => toggleOverlay('beat');
  document.getElementById('btn-chord-overlay').onclick = () => toggleOverlay('chord');
  document.getElementById('btn-fingering').onclick = () => {
    toggleOverlay('fingering'); syncFingeringGuessNote(); syncHandStage();
  };
  document.getElementById('btn-suggest-fingering').onclick = toggleSuggestFingering;
  document.getElementById('btn-hand-overlay').onclick = toggleHandOverlay;
  document.getElementById('btn-learn-mode').onclick = toggleLearnMode;

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

  document.getElementById('transpose-slider').oninput = (e) => setTranspose(e.target.value);
  document.getElementById('btn-transpose-reset').onclick = () => setTranspose(0);
  syncTransposeControls();

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

// ── The falling window as a control surface ──────────────────────────────────
// Scroll it to move through the piece, and — once Start loop has been pressed
// — point at the notes a passage runs between. Between them that is the whole
// "find the hard four bars and drill them" loop without touching a number
// field, and it takes a button press first so that no stray click can do it.

// Modes that are driving the playhead themselves; scrubbing would be pulling
// against them
const SCRUB_LOCKED = new Set(['learning', 'count-in', 'step-recording']);

// Wheel deltas arrive in pixels, lines or pages depending on the device
function wheelPixels(e, viewportH) {
  if (e.deltaMode === 1) return e.deltaY * 16;
  if (e.deltaMode === 2) return e.deltaY * viewportH;
  return e.deltaY;
}

function bindFallingScrub() {
  const canvas = document.getElementById('falling-canvas');
  loopPickButton().onclick = toggleLoopPicking;
  syncLoopPickButton();
  let pending = 0;
  let frame = null;

  const apply = () => {
    frame = null;
    const delta = pending;
    pending = 0;
    const end = getCompositionDuration();
    const target = Math.min(end, Math.max(0, state.transport.currentTime + delta));
    if (target !== state.transport.currentTime) seekTo(target);
  };

  canvas.addEventListener('wheel', (e) => {
    if (SCRUB_LOCKED.has(state.transport.mode)) return;
    const msPerPixel = fallingMsPerPixel();
    if (!msPerPixel) return;
    // Scrolling down brings the notes down, which is what time passing looks
    // like here — the gesture drags the ribbon rather than a scrollbar
    e.preventDefault();
    pending += wheelPixels(e, canvas.height) * msPerPixel;
    if (!frame) frame = requestAnimationFrame(apply);
  }, { passive: false });

  canvas.addEventListener('click', (e) => {
    // Only while a loop is being marked. A bare click used to set a range,
    // which meant every stray click on the window set one.
    if (!picking) return;
    const box = canvas.getBoundingClientRect();
    pickNoteForLoop(e.clientX - box.left, e.clientY - box.top);
  });
}

// ── Marking a loop ───────────────────────────────────────────────────────────
// Point at the note the passage starts on, scroll, point at the note it ends
// on. Two deliberate acts with a button pressed first, rather than something a
// misplaced click can do by accident.

let picking = false;      // a selection is under way
let firstPick = null;     // the note chosen as one end of it

// What the range is for, which is whatever mode is armed. All three read the
// same loop bars, so this only changes what the message calls it.
function rangeName() {
  if (state.ui.trainMode) return 'Training';
  if (state.ui.learnMode) return 'Learning';
  return 'Loop';
}

function loopPickButton() { return document.getElementById('btn-loop-pick'); }

function syncLoopPickButton() {
  const btn = loopPickButton();
  btn.classList.toggle('picking', picking);
  btn.classList.toggle('armed', !picking && state.transport.loopEnabled);
  btn.textContent = picking
    ? (firstPick ? 'Pick the last note' : 'Pick the first note')
    : (state.transport.loopEnabled ? 'Cancel loop' : 'Start loop');
}

function toggleLoopPicking() {
  // Pressing it while it is blinking abandons the selection, which is the way
  // out of having started one by mistake
  if (picking) { endPicking(); showToast('Loop selection cancelled', 1400); return; }
  if (state.transport.loopEnabled) {
    update('transport.loopEnabled', false);
    syncLoopControls();
    showToast('Loop off', 1200);
    return;
  }
  if (!state.composition.notes.length) { showToast('Nothing to loop yet', 1600); return; }
  picking = true;
  firstPick = null;
  setLoopPick(null);
  document.getElementById('falling-canvas').classList.add('picking');
  syncLoopPickButton();
  showToast('Click the note the passage starts on', 2400);
}

function endPicking() {
  picking = false;
  firstPick = null;
  setLoopPick(null);
  document.getElementById('falling-canvas').classList.remove('picking');
  syncLoopPickButton();
}

function pickNoteForLoop(x, y) {
  const note = noteAtFallingPoint(x, y, state.composition.notes, state.transport.currentTime);
  if (!note) { showToast('Click one of the falling notes', 1600); return; }

  const { tempo, timeSignature } = state.composition;
  const bar = barAtMs(note.startTime, tempo, timeSignature);

  if (!firstPick) {
    firstPick = { note, bar };
    setLoopPick(note.id);
    syncLoopPickButton();
    showToast(`From bar ${bar} — now the note it ends on`, 2400);
    return;
  }

  // Picked back to front is still a range; the ends sort themselves out
  const startBar = Math.min(firstPick.bar, bar);
  const endBar = Math.max(firstPick.bar, bar);
  update('transport.loopStartBar', startBar);
  update('transport.loopEndBar', endBar);
  update('transport.loopEnabled', true);
  endPicking();
  syncLoopControls();
  showToast(`${rangeName()} bars ${startBar}–${endBar}`, 2000);
}

// ── Dragging the loop's edges ────────────────────────────────────────────────
// The handles are rebuilt every time the range moves, so the listeners live on
// the scrolling container and find them by class rather than being attached to
// elements that will not survive the next redraw.

function bindLoopHandles() {
  const box = document.getElementById('sheet-container');
  let edge = null;

  box.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest && e.target.closest('.sheet-loop-handle');
    if (!handle) return;
    edge = handle.dataset.edge;
    handle.classList.add('dragging');
    // Captured on the container rather than the handle: the handle is redrawn
    // the moment the range moves, and a capture on it would go with it
    box.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  box.addEventListener('pointermove', (e) => {
    if (!edge) return;
    const bar = barAtPoint(e.clientX, e.clientY, edge);
    if (!bar) return;
    const { loopStartBar, loopEndBar } = state.transport;
    // Bars are the unit, so this snaps on its own; the ends cannot cross
    const path = edge === 'start' ? 'transport.loopStartBar' : 'transport.loopEndBar';
    const want = edge === 'start' ? Math.min(bar, loopEndBar) : Math.max(bar, loopStartBar);
    // Every change redraws the bands, and a pointer moving within one bar has
    // nothing to redraw
    if (want !== state.transport[edge === 'start' ? 'loopStartBar' : 'loopEndBar']) update(path, want);
  });

  const release = (e) => {
    if (!edge) return;
    edge = null;
    if (box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId);
    showToast(`${rangeName()} bars ${state.transport.loopStartBar}–${state.transport.loopEndBar}`, 1600);
  };
  box.addEventListener('pointerup', release);
  box.addEventListener('pointercancel', release);
}

function syncLoopControls() {
  document.getElementById('loop-start').value = String(state.transport.loopStartBar);
  document.getElementById('loop-end').value = String(state.transport.loopEndBar);
  updateLoopDisplay();
  syncLoopPickButton();
}

// The looped bars, marked on the score. Only when the loop is on: an unused
// range is a leftover, not something to draw over the music.
function refreshLoopMarker() {
  const marked = loopBars();
  markLoopRange(marked ? marked.startBar : null, marked ? marked.endBar : null);
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
  document.getElementById('btn-export-midi').onclick = exportMidi;
  const importInput = document.getElementById('import-file');
  document.getElementById('btn-import').onclick = importComposition;
  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    // Reset first, so picking the same file twice still fires a change
    importInput.value = '';
    if (!file) return;
    try {
      const imported = await readImportedFile(file);
      if (state.composition.notes.length &&
          !confirm('Replace the current composition with the imported one?')) return;
      const regrid = loadComposition(imported);
      const n = imported.notes.length;
      const detail = imported.warnings?.length ? ` · ${imported.warnings.join(' · ')}` : '';
      showToast(`Imported "${imported.name}" — ${n} note${n === 1 ? '' : 's'}${detail}${gridNote(regrid)}`,
        imported.warnings?.length ? 5000 : 2500);
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
  // The slider measures distance from where the piece arrived, so a new piece
  // starts back at zero
  update('ui.transpose', 0);
  syncTempoControls();
  const [num, den] = [song.timeSignature.numerator, song.timeSignature.denominator];
  document.getElementById('ts-num').value = num;
  document.getElementById('ts-den').value = den;
  if (song.keySignature) {
    document.getElementById('key-select').value = song.keySignature;
  }
  seekToStart();
  const regrid = adoptGridFor(song);
  resetHistory();
  scheduleSheetRender();
  showToast(`Opened: ${song.name}${gridNote(regrid)}`);
  return regrid;
}

// A piece arriving brings its own rhythm, and the grid has to be fine enough to
// write it down. Left on whatever the last piece wanted, a dotted or triplet
// figure has two notes stacked on one grid line — so the grid is read off the
// music rather than carried over. Returns the division when it changed, for
// saying so: a setting that moves on its own has to be visible, and the control
// still overrules it.
function adoptGridFor(song) {
  const wanted = detectGridDivision(song.notes, song.tempo);
  if (wanted === state.ui.quantize) return null;
  update('ui.quantize', wanted);
  for (const sel of quantizeSelects()) sel.value = String(wanted);
  return wanted;
}

function gridNote(division) {
  return division ? ` · written in 1/${division} notes, which is what the rhythm needs` : '';
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
  const sectionUp = () => !document.getElementById('section-modal').classList.contains('hidden');

  return [
    // While the end-of-section choice is up these shadow the global keys, the
    // same way Space retries while the results are showing.
    //
    // Space takes whichever choice is highlighted, and which that is depends on
    // how the section was learned: on the fast learn it is worth going again,
    // but a section just played through whole from memory is finished with.
    { id: 'section-default', group: 'sections', scope: sectionUp,
      section: 'Training', label: 'Take the highlighted choice',
      defaultBindings: [{ code: 'Space' }, { code: 'Enter' }],
      run: () => (learnedInClusters ? advanceSection() : repeatSection()) },
    { id: 'section-again', group: 'sections', scope: sectionUp, hint: 'btn-section-again',
      section: 'Training', label: 'Learn this section again',
      defaultBindings: [{ code: 'KeyA' }, { code: 'KeyR' }],
      run: () => repeatSection() },
    { id: 'section-train', group: 'sections', scope: sectionUp, hint: 'btn-section-train',
      section: 'Training', label: 'Train over this section',
      defaultBindings: [{ code: 'KeyT' }],
      run: () => trainCurrentSection() },
    { id: 'section-next', group: 'sections', scope: sectionUp, hint: 'btn-section-next',
      section: 'Training', label: 'Move to the next section',
      defaultBindings: [{ code: 'KeyN' }],
      run: () => advanceSection() },

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
    { id: 'editor-hand-left', group: 'editor', scope: editing, hint: 'btn-hand-left',
      section: 'Piano roll editing', label: 'Put the selection in the left hand',
      defaultBindings: [{ code: 'BracketLeft' }],
      run: () => assignSelectedHand('left') },
    { id: 'editor-hand-right', group: 'editor', scope: editing, hint: 'btn-hand-right',
      section: 'Piano roll editing', label: 'Put the selection in the right hand',
      defaultBindings: [{ code: 'BracketRight' }],
      run: () => assignSelectedHand('right') },
    { id: 'editor-hand-auto', group: 'editor', scope: editing, hint: 'btn-hand-auto',
      section: 'Piano roll editing', label: 'Let the texture decide for the selection',
      defaultBindings: [{ code: 'Backslash' }],
      run: () => assignSelectedHand('auto') },
    { id: 'editor-legato', group: 'editor', scope: editing, hint: 'btn-legato',
      section: 'Piano roll editing', label: 'Extend selection to the next note',
      defaultBindings: [{ code: 'KeyG' }],
      run: () => applyLegato(getSelectedIds()) },

    // Transport
    { id: 'transport-toggle', group: 'global',
      section: 'Transport', label: 'Play, or stop whatever is running',
      defaultBindings: [{ code: 'Space' }],
      run: () => {
        if (holdingLearnMessage()) return;
        if (state.transport.mode !== 'stopped') stop();
        else if (state.ui.learnMode) startLearnSession();
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
    { id: 'metro-subdivision', group: 'global', hint: 'metro-subdivision',
      section: 'Options', label: 'Metronome subdivision',
      defaultBindings: [{ code: 'KeyM', shift: true }],
      run: () => cycleSubdivision() },
    { id: 'beat-overlay', group: 'global', hint: 'btn-beat-overlay',
      section: 'Options', label: 'Show the beat over the falling notes',
      defaultBindings: [{ code: 'KeyB', shift: true }],
      run: () => toggleOverlay('beat') },
    { id: 'chord-overlay', group: 'global', hint: 'btn-chord-overlay',
      section: 'Options', label: 'Show the chord over the falling notes',
      defaultBindings: [{ code: 'KeyC', shift: true }],
      run: () => toggleOverlay('chord') },
    { id: 'fingering', group: 'global', hint: 'btn-fingering',
      section: 'Options', label: 'Show fingering on the keyboard',
      defaultBindings: [{ code: 'KeyF', shift: true }],
      run: () => toggleOverlay('fingering') },
    { id: 'hand-overlay', group: 'global', hint: 'btn-hand-overlay',
      section: 'Options', label: 'Hands on the keys instead of numbers',
      defaultBindings: [{ code: 'KeyD', shift: true }],
      run: () => toggleHandOverlay() },
    { id: 'suggest-fingering', group: 'global', hint: 'btn-suggest-fingering',
      section: 'Options', label: 'Suggest a fingering for this piece',
      defaultBindings: [{ code: 'KeyG', shift: true }],
      run: () => toggleSuggestFingering() },
    { id: 'record-hand', group: 'global', hint: 'record-hand',
      section: 'Options', label: 'Which hand new notes are written to',
      defaultBindings: [{ code: 'KeyH' }],
      run: () => cycleRecordHand() },
    { id: 'practice-hand', group: 'global', hint: 'practice-hand',
      section: 'Options', label: 'Which hand to train and learn',
      defaultBindings: [{ code: 'KeyH', shift: true }],
      run: () => cyclePracticeHand() },
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
    // Shift on the training key: the two practice modes are a pair
    { id: 'learn', group: 'global', hint: 'btn-learn-mode',
      section: 'Options', label: 'Toggle learn mode',
      defaultBindings: [{ code: 'KeyT', shift: true }],
      run: () => toggleLearnMode() },
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
    // "<" and ">" — the usual pair for shifting pitch
    { id: 'transpose-down', group: 'global',
      section: 'Options', label: 'Transpose down a semitone',
      defaultBindings: [{ code: 'Comma', shift: true }],
      run: () => nudgeTranspose(-1) },
    { id: 'transpose-up', group: 'global',
      section: 'Options', label: 'Transpose up a semitone',
      defaultBindings: [{ code: 'Period', shift: true }],
      run: () => nudgeTranspose(1) },
    { id: 'transpose-reset', group: 'global', hint: 'btn-transpose-reset',
      section: 'Options', label: 'Back to the original pitch',
      defaultBindings: [{ code: 'Digit0', shift: true }],
      run: () => setTranspose(0) },
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
    { id: 'practice-generator', group: 'global', hint: 'btn-practice',
      section: 'File', label: 'Write a scale or arpeggio to practise',
      defaultBindings: [{ code: 'KeyS', shift: true }],
      run: () => openPracticeGenerator() },
    { id: 'save', group: 'global', hint: 'btn-save',
      section: 'File', label: 'Save',
      defaultBindings: [{ code: 'KeyS', mod: true }],
      run: () => saveCurrentComposition() },
    { id: 'export', group: 'global', hint: 'btn-export',
      section: 'File', label: 'Export as JSON',
      defaultBindings: [{ code: 'KeyE', mod: true }],
      run: () => exportComposition() },
    { id: 'export-midi', group: 'global', hint: 'btn-export-midi',
      section: 'File', label: 'Export as MIDI',
      defaultBindings: [{ code: 'KeyE', mod: true, shift: true }],
      run: () => exportMidi() },
    { id: 'profiles', group: 'global', hint: 'btn-profiles',
      section: 'File', label: 'Manage profiles',
      defaultBindings: [{ code: 'KeyP', shift: true }],
      run: () => document.getElementById('btn-profiles').click() },
    { id: 'import', group: 'global', hint: 'btn-import',
      section: 'File', label: 'Import a JSON or MIDI file',
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

// A running transport both updates the position and ticks, so this is asked
// the same question twice a frame; the second time is free.
let shownPositionMs = null;

function updatePositionDisplay(ms) {
  if (ms === shownPositionMs) return;
  shownPositionMs = ms;
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
    // The step cursor stands in for the playhead while stepping; otherwise the
    // playhead shows wherever the position is, stopped or not — moving it with
    // the arrows or the mouse should be visible on the stave too
    // Which hand plays what is read off the texture, so it has to be up to
    // date before either view draws
    inferHands(state.composition.notes, (60 / state.composition.tempo) * 1000);
    // ...and a suggested fingering is worked out per hand, so it has to come
    // after that and not before, or a note whose hand was only just inferred
    // gets fingered as though it belonged to the other one. Inside the debounce
    // rather than on every note change, so holding a chord down while recording
    // does not re-solve the whole piece once per key.
    rebuildFingeringSuggestions();
    sheetShowsStepCursor = state.transport.mode === 'step-recording';
    const t = sheetShowsStepCursor ? null : state.transport.currentTime;
    if (state.ui.view !== 'piano-roll') {
      renderSheet(state.composition.notes, state.composition, t);
      updateChordOverlay();
      // The bands are placed from the layout that was just built
      refreshLoopMarker();
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
  const status = document.getElementById('midi-status');
  // A device that is plugged in but switched off is not something you can play
  // on, so it does not count as connected — but saying so is worth a word,
  // otherwise "No MIDI" looks like the cable came out
  const live = state.midi.inputs.filter(i => i.state === 'connected' && i.enabled !== false);
  const muted = state.midi.inputs.filter(i => i.state === 'connected' && i.enabled === false);

  dot.className = 'status-dot ' + (live.length ? 'connected' : 'disconnected');
  if (live.length > 1) text.textContent = `MIDI: ${live.length} devices`;
  else if (live.length === 1) text.textContent = `MIDI: ${live[0].name}`;
  else if (muted.length) text.textContent = `MIDI: ${muted.length} ignored`;
  else text.textContent = 'No MIDI';

  if (status) status.title = 'Click to choose which controllers to listen to';
  dot.onclick = openMidiInfo;
  if (status) status.onclick = openMidiInfo;
}

// Every port, each with a switch. A desk can present half a dozen of them and
// any one sending notes lands in the piece or is graded as a wrong note, so the
// list is a set of choices rather than a read-out.
function updateMidiInputsList(inputs) {
  const el = document.getElementById('midi-devices-list');
  if (!el) return;
  if (!inputs || !inputs.length) {
    el.innerHTML = '<p class="midi-empty">No MIDI devices detected.</p>';
    return;
  }
  el.innerHTML = inputs.map(i => `
    <label class="midi-device ${i.state}${i.enabled ? '' : ' off'}">
      <input type="checkbox" class="midi-device-check" data-id="${escapeAttr(i.id)}" ${i.enabled ? 'checked' : ''}>
      <span class="device-dot"></span>
      <span class="device-name">${escapeHtml(i.name)}</span>
      <span class="device-state">${i.state === 'connected' ? (i.enabled ? 'listening' : 'ignored') : i.state}</span>
    </label>
  `).join('');

  for (const box of el.querySelectorAll('.midi-device-check')) {
    box.onchange = () => {
      setInputEnabled(box.dataset.id, box.checked);
      showToast(box.checked ? 'Listening to that controller' : 'Ignoring that controller', 1600);
    };
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeAttr = escapeHtml;

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
  document.getElementById('btn-hand-left').onclick = () => assignSelectedHand('left');
  document.getElementById('btn-hand-right').onclick = () => assignSelectedHand('right');
  document.getElementById('btn-hand-auto').onclick = () => assignSelectedHand('auto');
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

// The tooltip is absolutely positioned inside the score's scrolling container,
// so it has to be placed in that container's *content* coordinates. Measuring
// against the container's viewport rectangle alone left out the scroll offset,
// which put the tooltip that many pixels too high — off the top of the visible
// area entirely once the score was scrolled down to a lower system.
function placeChordTooltip(tooltip, label, containerEl) {
  const box = containerEl.getBoundingClientRect();
  const rect = label.getBoundingClientRect();
  const toContentX = (x) => x - box.left + containerEl.scrollLeft;
  const toContentY = (y) => y - box.top + containerEl.scrollTop;

  const visibleTop = containerEl.scrollTop;
  const visibleBottom = visibleTop + containerEl.clientHeight;

  // Below the label, unless that would run past what is on screen — then above
  let top = toContentY(rect.bottom) + 4;
  if (top + tooltip.offsetHeight > visibleBottom) {
    top = Math.max(visibleTop + 4, toContentY(rect.top) - tooltip.offsetHeight - 4);
  }

  const left = toContentX(rect.left);
  const maxLeft = containerEl.scrollLeft + containerEl.clientWidth - tooltip.offsetWidth - 8;
  tooltip.style.left = `${Math.max(containerEl.scrollLeft + 4, Math.min(left, maxLeft))}px`;
  tooltip.style.top = `${top}px`;
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
    // The overlay is positioned absolutely inside #sheet-container
    for (const item of data) {
      const el = document.createElement('span');
      el.className = 'chord-label-el' + (item.arpeggiated ? ' arp' : '');
      el.textContent = item.label;
      if (item.arpeggiated) el.title = 'Arpeggiated chord';
      el.style.left = item.x + 'px';
      el.style.top = item.y + 'px';
      el.addEventListener('mouseenter', () => {
        tooltip.innerHTML = `<div class="chord-tooltip-name">${item.label}</div>` +
          buildMiniPianoSVG(item.pitches) +
          `<div class="chord-tooltip-voicing">${buildVoicingCaption(item.pitches)}</div>`;
        tooltip.classList.remove('hidden'); // has to be laid out before it can be measured
        placeChordTooltip(tooltip, el, containerEl);
      });
      overlay.appendChild(el);
    }
  }, 120);
}

function showAccuracyResults(results) {
  lastResults = results;
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
  // Say what the extras actually cost. A handful are charged at what a missed
  // note costs and no more; past a tenth of the piece they are charged in full,
  // and the label says which of the two happened.
  document.getElementById('stat-extra').textContent = extra
    ? `${extra} (−${results.penalty}%${results.extrasCharged ? ', over 10%' : ''})`
    : '0';
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
  document.getElementById('btn-replay-take').onclick = replayTake;
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
