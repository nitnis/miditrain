// UI updates: DOM manipulation, modals, controls
import { state, update, emit, on } from './state.js';
import { record, play, stop, stopAndRewind, startCountIn, playRange, seekTo, seekToStart, seekToEnd, clearAllNotes, transposeNotes, transposeAll, setNotesHand, applyLegato, deleteNotes, changeTempo, getCompositionDuration } from './transport.js';
import { renderSheet, initSheet, getChordOverlayData, getStaveGeometry, movePlayhead, markLoopRange, barAtPoint } from './sheet.js';
import { refreshSuggestions, hasSuggestions } from './autofinger.js';
import { initPianoRoll, renderPianoRoll, spawnKeyEffect, clearKeyEffects, setWaitingPitches, setFallingBlind, setLoopPick, setTakeGhosts, noteAtFallingPoint, fallingMsPerPixel, HAND_COLORS } from './pianoroll.js';
import { startLearn, stopLearn, isHoldingMessage, CLUSTERS } from './learn.js';
import {
  startSectionWalk, stopSectionWalk, repeatSection, advanceSection, previousSection,
  handOverForTraining, isWalking, buildSections,
} from './section-learn.js';
import { saveComposition, listCompositions, deleteComposition, compositionToJSON, compositionFromJSON } from './storage.js';
import { compositionToMidi, midiToComposition } from './midi-file.js';
import { startAccuracy, stopAccuracy, getWorstSection, getTake, STAR_COUNT } from './accuracy.js';
import { startMetronome, stopMetronome } from './metronome.js';
import { resumeAudioContext, applyOutputLevel, applyClicksOnly, silenceMonitored, setPlaybackSource } from './audio.js';
import { setInputEnabled } from './midi.js';
import { startStepRecord, stopStepRecord, stepInsertRest, stepGoBack, getStepMs } from './step-recorder.js';
import { initNoteEditor, getSelectedIds, clearSelection } from './note-editor.js';
import { staffPositionName, midiToNoteWithOctave } from './chords.js';
import { barRangeMs, barAtMs, detectGridDivision } from './quantizer.js';
import { loopBars } from './range.js';
import { inferHands, practiceHand } from './hands.js';
import {
  TRACK_PALETTE, TRACK_HANDS, trackList, hasTracks, isAudible,
  updateTrack, setAllEnabled, noteCounts, normalizeTracks,
} from './tracks.js';
import { SCALES, CHORDS, LICKS, PATTERNS, HANDS, DIRECTIONS, NOTE_VALUES, ROOTS, buildExercise } from './scales.js';
import { SWING_AMOUNTS } from './quantizer.js';
import { looksLikeAudio, transcribeAudioFile } from './audio-import.js';
import {
  listProfiles, current as currentProfile, switchProfile, createProfile, deleteProfile,
  renameProfile, adoptProfile, sectionKey, sectionTempo, rememberSectionTempo, setLearningPosition,
  trainingKey, parseTrainingKey, bestFor, rememberBest, bestsTree,
  learningPosition, canUseFolder, chooseFolder, folderHandle, storedFolder, scanFolder,
  writeToFolder, readFromFolder, removeFromFolder,
  fileNameFor, bundleToJSON, bundleFromJSON,
  calibrationOf, setCalibration, calibrationMatchesInput,
} from './profiles.js';
import {
  CALIBRATION_LEVELS, CALIBRATION_STRIKES, summariseStrikes, calibrationIsUsable,
} from './dynamics.js';
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
  bindTracks();
  syncTracksButton();
  refreshFolderChosen();
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
  // The best is recorded once, where the run ends — not in the results screen,
  // which the replay puts back up again afterwards
  on('accuracy:complete', (results) => { recordBest(results); showAccuracyResults(results); });

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
  document.getElementById('swing-select').value = ui.swing;
  syncSwingAmount();
  document.getElementById('middle-c-select').value = String(ui.middleC);
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
  document.getElementById('btn-monitor').classList.toggle('active', ui.monitorEnabled);
  document.getElementById('btn-metronome').classList.toggle('active', ui.metronomeEnabled);
  document.getElementById('metro-subdivision').value = String(ui.metronomeSubdivision);
  document.getElementById('btn-beat-overlay').classList.toggle('active', ui.showBeatOverlay);
  document.getElementById('btn-chord-overlay').classList.toggle('active', ui.showChordOverlay);
  document.getElementById('btn-count-overlay').classList.toggle('active', ui.showCountOverlay);
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

// The slider's three stops, in the order it slides through them
const SWING_STOPS = ['light', 'medium', 'hard'];

function syncSwingAmount() {
  const feel = SWING_AMOUNTS[state.ui.swingAmount] || SWING_AMOUNTS.medium;
  document.getElementById('swing-amount').value =
    String(Math.max(0, SWING_STOPS.indexOf(state.ui.swingAmount)));
  document.getElementById('swing-amount-value').textContent = `${feel.name} ${feel.ratio}`;
}

// How hard the swing is changes what is heard rather than what is written, so
// the click and any phrase generated from here follow it while the page does
// not. The marking is the exception: it names the amount, because that is the
// one thing on the page whose whole job is to say how far to swing.
function setSwingAmount(amount) {
  update('ui.swingAmount', amount);
  syncSwingAmount();
  scheduleSheetRender();
  showToast(`${SWING_AMOUNTS[amount].name} swing — ${SWING_AMOUNTS[amount].ratio}`, 1100);
}

// The slider and its label read off the state rather than off the last thing
// that moved them, so anything that sets the speed — the slider, or a best being
// loaded back at the speed it was set — leaves the two agreeing.
function syncSpeedControls() {
  const pct = Math.round((state.transport.speed || 1) * 100);
  document.getElementById('speed-slider').value = pct;
  document.getElementById('speed-value').textContent = `${pct}%`;
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

// Hearing your own keys, as against hearing the app. Off is what a hardware
// piano calls local off: the keys still send, they just do not sound here.
function toggleMonitor() {
  const on = !state.ui.monitorEnabled;
  update('ui.monitorEnabled', on);
  document.getElementById('btn-monitor').classList.toggle('active', on);
  if (!on) silenceMonitored();
  showToast(on
    ? 'Your playing is audible again'
    : 'Your playing is silent here — playback, prompts and the click are not', 2200);
}

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
    swing: document.getElementById('gen-feel').value === 'swing',
    swingAmount: state.ui.swingAmount,
    tempo: state.composition.tempo,
  };
}

// A lick is a phrase, not a shape run through a machine: its notes, its rhythm
// and its harmony are all part of it, so the only choices left are which key to
// put it in, which hands play it, and whether to hear it swung.
const LICK_FIELDS = ['gen-root', 'gen-type', 'gen-hands', 'gen-octave', 'gen-feel'];

function syncGenFields(kind) {
  const lick = kind === 'lick';
  for (const field of document.querySelectorAll('.practice-field')) {
    const id = field.querySelector('select')?.id;
    if (!id || id === 'gen-inversion') continue;
    field.classList.toggle('hidden', lick && !LICK_FIELDS.includes(id));
  }
  document.getElementById('gen-feel-field').classList.toggle('hidden', !lick);
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
  const counted = exercise.blurb
    ? `${exercise.title} — ${bars.toFixed(bars % 1 ? 1 : 0)} bars at ${Math.round(opts.tempo)} BPM, key of ${exercise.keySignature}`
    : `${exercise.title} — ${exercise.count} notes${hands}, ` +
      `${bars.toFixed(bars % 1 ? 1 : 0)} bars at ${Math.round(opts.tempo)} BPM, key of ${exercise.keySignature}`;
  document.getElementById('practice-summary').textContent =
    exercise.blurb ? `${counted}\n${exercise.blurb}` : counted;
}

function setGenKind(kind) {
  genKind = kind;
  for (const tab of document.querySelectorAll('.practice-tab')) {
    tab.classList.toggle('active', tab.dataset.kind === kind);
  }
  const LABEL = { arpeggio: 'Chord', lick: 'Lick', scale: 'Scale' };
  const BLURB = {
    arpeggio: 'Write an arpeggio onto the stave to practise. Everything else works on it: play it, loop a stretch, train it, or walk it in learn mode.',
    lick: 'Phrases players actually use, written swung — so the stave shows straight eighths under a swing marking, the way a chart does. Everything else works on them: play, loop, train, learn.',
    scale: 'Write a scale onto the stave to practise. Everything else works on it: play it, loop a stretch, train it, or walk it in learn mode.',
  };
  const TABLE = { arpeggio: CHORDS, lick: LICKS, scale: SCALES };
  const WRITE = { arpeggio: 'Write the arpeggio', lick: 'Write the lick', scale: 'Write the scale' };

  document.getElementById('gen-type-label').textContent = LABEL[kind] || LABEL.scale;
  document.getElementById('practice-blurb').textContent = BLURB[kind] || BLURB.scale;
  fillOptions(document.getElementById('gen-type'), Object.entries(TABLE[kind] || SCALES));
  document.getElementById('btn-practice-generate').textContent = WRITE[kind] || WRITE.scale;
  syncGenFields(kind);
  updatePracticeSummary();
}

function writeExercise() {
  const exercise = buildExercise(genOptions());
  if (!exercise.notes.length) { showToast('Nothing to write'); return; }

  // The key first: the notes carry spellings written for it, and changing the
  // key is what hands spelling back to the key signature
  update('composition.keySignature', exercise.keySignature);
  // A lick's comping is written in bars of four; left in whatever the last
  // piece was in, its chords would land in the middle of them
  if (exercise.timeSignature) update('composition.timeSignature', exercise.timeSignature);
  // The feel came from the dialog, so the swing control says so rather than
  // leaving the detector to infer back out of the timing what was just asked for
  if (exercise.swing !== undefined) {
    update('ui.swing', exercise.swing ? 'on' : 'off');
    document.getElementById('swing-select').value = exercise.swing ? 'on' : 'off';
  }
  state.composition.notes = exercise.notes;
  state.composition.tracks = [];   // a generated exercise is one part
  state.composition.name = exercise.title;
  syncTracksButton();
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

// ── Tracks ───────────────────────────────────────────────────────────────────
//
// A multi-track file arrives as parts, and the four things worth setting per
// part are all here: whether it sounds, what colour it falls in, which hand it
// belongs to, and what it is called. Everything applies the moment it is
// changed — there is no Apply — because the piece behind the dialog is what
// says whether the change was the one you wanted.

const HAND_LABELS = { auto: 'Auto', left: 'Left', right: 'Right' };

// The colour a track's notes actually fall in. A track with no colour of its
// own falls in its hand's colour, which is what a piano score should do, so the
// chip shows the hand colours side by side rather than pretending to be one.
function chipStyle(track) {
  if (track.color) return `background:${track.color}`;
  const { right, left } = HAND_COLORS;
  return `background:linear-gradient(135deg,${right.white} 0 50%,${left.white} 50% 100%)`;
}

function renderTrackList() {
  const listEl = document.getElementById('track-list');
  const tracks = trackList();
  const counts = noteCounts();
  if (!tracks.length) {
    listEl.innerHTML = '<div class="empty-msg">This piece is in one part.</div>';
    return;
  }

  listEl.innerHTML = tracks.map(t => {
    const n = counts.get(t.id) || 0;
    const colors = [
      `<option value=""${t.color ? '' : ' selected'}>By hand</option>`,
      ...TRACK_PALETTE.map(c =>
        `<option value="${c.hex}"${t.color === c.hex ? ' selected' : ''}>${c.name}</option>`),
    ].join('');
    const hands = TRACK_HANDS.map(h =>
      `<option value="${h}"${t.hand === h ? ' selected' : ''}>${HAND_LABELS[h]}</option>`).join('');
    return `
      <div class="track-row${t.enabled ? '' : ' off'}" data-id="${t.id}">
        <label class="track-on" title="Play this part">
          <input type="checkbox" class="track-enabled"${t.enabled ? ' checked' : ''}>
        </label>
        <span class="track-chip" style="${chipStyle(t)}"></span>
        <input type="text" class="track-name" value="${escapeHtml(t.name)}" maxlength="60"
               title="What to call this part">
        <select class="track-color" title="The colour this part's notes fall in">${colors}</select>
        <select class="track-hand" title="Which hand plays this part. Auto lets the texture decide, the way it does for a piece that never said.">${hands}</select>
        <span class="track-count">${n} note${n === 1 ? '' : 's'}</span>
      </div>`;
  }).join('');

  for (const row of listEl.querySelectorAll('.track-row')) {
    const id = Number(row.dataset.id);
    const track = () => trackList().find(t => t.id === id);
    // The row is patched where it changed rather than rebuilt. Rebuilding would
    // take the focus out of the very control that was just used, which turns
    // stepping down a colour list with the keyboard into one change per press.
    const changed = () => {
      const t = track();
      row.classList.toggle('off', !t.enabled);
      row.querySelector('.track-chip').setAttribute('style', chipStyle(t));
      scheduleSheetRender();
    };
    row.querySelector('.track-enabled').onchange = (e) =>
      updateTrack(id, { enabled: e.target.checked }) && changed();
    row.querySelector('.track-color').onchange = (e) =>
      updateTrack(id, { color: e.target.value || null }) && changed();
    row.querySelector('.track-hand').onchange = (e) =>
      updateTrack(id, { hand: e.target.value }) && changed();
    // As it is typed, so the name is never a keystroke behind — but an empty
    // field is somebody midway through renaming rather than a part called
    // nothing, so it keeps the last name it had and gets it back on leaving.
    const nameEl = row.querySelector('.track-name');
    nameEl.oninput = (e) => {
      const text = e.target.value.trim();
      if (text) updateTrack(id, { name: text });
    };
    nameEl.onchange = (e) => { e.target.value = track().name; };
  }
}

// The button is only ever worth showing for a file written in more than one
// part, so it comes and goes with the piece.
function syncTracksButton() {
  document.getElementById('btn-tracks').classList.toggle('hidden', !hasTracks());
}

function openTracks() {
  renderTrackList();
  document.getElementById('tracks-modal').classList.remove('hidden');
}

function bindTracks() {
  const modal = document.getElementById('tracks-modal');
  document.getElementById('btn-tracks').onclick = openTracks;
  document.getElementById('btn-close-tracks').onclick = () => modal.classList.add('hidden');
  const setAll = (wanted) => { if (setAllEnabled(wanted)) { renderTrackList(); scheduleSheetRender(); } };
  document.getElementById('btn-tracks-all').onclick = () => setAll(true);
  document.getElementById('btn-tracks-none').onclick = () => setAll(false);
  // Clearing the piece takes its parts with it, and the button has to go too
  on('tracks:changed', syncTracksButton);
}

// ── What a profile has to show for itself ────────────────────────────────────
//
// Every best it holds, as a tree: the piece, then which hand it was practised
// with, then how fast. Those three are what make two runs comparable in the
// first place, so they are also what the list is grouped by — and the shape of
// the tree is the shape of the thing being worked at, one piece opening into
// the hands it was taken with and the speeds it reached.
//
// Any of them can be loaded back, which puts the piece, the tempo, the hand and
// the bars where they were and plays the run through the falling notes.

const HAND_NAMES = { both: 'Both hands', left: 'Left hand', right: 'Right hand' };

function whenText(at) {
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}

function renderBestsTree(profile) {
  const host = document.getElementById('bests-tree');
  const tree = bestsTree(profile);
  host.innerHTML = '';

  const total = tree.reduce((n, s) => n + s.hands.reduce(
    (m, h) => m + h.speeds.reduce((k, v) => k + v.runs.length, 0), 0), 0);
  document.getElementById('bests-title').textContent = `${profile.name} · best runs`;
  document.getElementById('bests-sub').textContent = total
    ? 'Open a piece to see what it has been played at. Load puts the piece, the hand, the speed and the bars back where they were, and plays the run.'
    : '';

  if (!total) {
    host.innerHTML = '<div class="bests-empty">No best runs yet. Train a passage through to the end and the first one is set.</div>';
    return;
  }

  const detail = (cls, label, count) => {
    const el = document.createElement('details');
    el.className = cls;
    const head = document.createElement('summary');
    head.textContent = label;
    if (count !== undefined) {
      const n = document.createElement('span');
      n.className = 'bests-count';
      n.textContent = count === 1 ? '1 run' : `${count} runs`;
      head.appendChild(n);
    }
    el.appendChild(head);
    return el;
  };

  for (const song of tree) {
    const runsHere = song.hands.reduce(
      (m, h) => m + h.speeds.reduce((k, v) => k + v.runs.length, 0), 0);
    const songEl = detail('bests-song', song.songName, runsHere);
    // One piece opens by itself, because opening it is then the only thing
    // there is to do
    songEl.open = tree.length === 1;

    for (const hand of song.hands) {
      const handEl = detail('bests-hand', HAND_NAMES[hand.hand] || hand.hand);
      for (const speed of hand.speeds) {
        const speedEl = detail('bests-speed', `${speed.bpm} BPM`);
        for (const run of speed.runs) {
          speedEl.appendChild(bestRow(run));
        }
        handEl.appendChild(speedEl);
      }
      songEl.appendChild(handEl);
    }
    host.appendChild(songEl);
  }
}

function bestRow(run) {
  const row = document.createElement('div');
  row.className = 'bests-run';

  const bars = document.createElement('span');
  bars.className = 'bests-bars';
  bars.textContent = run.bars === 'all' ? 'whole piece' : `bars ${run.bars.replace('-', '–')}`;

  const stars = document.createElement('span');
  stars.className = 'bests-stars';
  stars.textContent = run.stars == null ? '—' : `★ ${starText(run.stars)}`;

  const score = document.createElement('span');
  score.className = 'bests-score';
  score.textContent = `${run.score}%`;

  const when = document.createElement('span');
  when.className = 'bests-when';
  when.textContent = whenText(run.at);

  const load = document.createElement('button');
  load.className = 'small-btn';
  load.textContent = 'Load';
  // A run recorded on a piece too long to keep kept its score and lost its
  // replay, and there is then nothing to put back
  load.disabled = !run.take;
  load.title = run.take
    ? 'Put the piece, hand, speed and bars back where they were, and play this run'
    : 'This run was too long to keep a recording of';
  load.onclick = () => loadBestRun(run.key);

  row.append(bars, stars, score, when, load);
  return row;
}

function openBests(profile) {
  renderBestsTree(profile);
  document.getElementById('bests-modal').classList.remove('hidden');
}

// Put everything back where it was for this run, then play it.
//
// The piece is named rather than referenced — a best outlives whatever was
// loaded when it was set — so the first thing is to find it. If it is not the
// piece on screen and not one the browser is holding, nothing else here can
// mean anything, and saying so beats replaying a run against the wrong music.
async function loadBestRun(key) {
  const best = bestFor(key);
  const at = parseTrainingKey(key);
  if (!best || !at) return;

  if ((state.composition.name || 'Untitled') !== at.songName) {
    const songs = await listCompositions();
    const match = songs.find(s => (s.name || 'Untitled') === at.songName);
    if (!match) {
      showToast(`"${at.songName}" is not saved in this browser — open it first, then load this run`, 5000);
      return;
    }
    loadComposition(match);
  }

  document.getElementById('bests-modal').classList.add('hidden');
  document.getElementById('profiles-modal').classList.add('hidden');

  // The speed in the key is the tempo the notes were written at times whatever
  // the slider was doing, so putting it back takes both
  setTempo(best.tempo);
  const speed = Math.min(2, Math.max(0.25, at.bpm / best.tempo));
  update('transport.speed', speed);
  syncSpeedControls();

  update('ui.practiceHand', at.hand);
  document.getElementById('practice-hand').value = at.hand;

  const bars = at.bars === 'all' ? null : {
    startBar: parseInt(at.bars.split('-')[0], 10),
    endBar: parseInt(at.bars.split('-')[1], 10),
  };
  update('transport.loopEnabled', Boolean(bars));
  document.getElementById('loop-enabled').checked = Boolean(bars);
  if (bars) {
    update('transport.loopStartBar', bars.startBar);
    update('transport.loopEndBar', bars.endBar);
    document.getElementById('loop-start').value = bars.startBar;
    document.getElementById('loop-end').value = bars.endBar;
    refreshLoopMarker();
  }

  // Whatever was on the results screen described some other run, and this
  // replay has nothing to go back to — so it does not reappear when the
  // playback ends the way it does when the replay was started from it
  lastResults = null;

  // Armed for another attempt at the same thing, with the run itself playing
  // over the notes so it can be watched before it is beaten
  setPracticeMode('train');
  trainingRunKey = key;
  trainingRunTempo = best.tempo;
  seekTo(bars ? rangeForBars(bars).startMs : 0);
  showToast(`Loaded your best of ${at.songName} · ${at.hand === 'both' ? 'both hands' : `${at.hand} hand`} at ${at.bpm} BPM`, 3200);
  replayTake(scaleTake(best.take, best.tempo, state.composition.tempo),
             `your best (${starText(best.stars ?? 0)} stars)`);
}

// ── Profiles ─────────────────────────────────────────────────────────────────

function bindProfiles() {
  const modal = document.getElementById('profiles-modal');
  const select = document.getElementById('profile-select');

  select.onchange = (e) => { switchProfile(e.target.value); showProfileWelcome(); };
  document.getElementById('btn-profiles').onclick = () => {
    renderProfiles();
    backfillCurrentFile();
    modal.classList.remove('hidden');
  };
  document.getElementById('btn-close-profiles').onclick = () => modal.classList.add('hidden');
  document.getElementById('btn-close-bests').onclick = () =>
    document.getElementById('bests-modal').classList.add('hidden');

  const pro = document.getElementById('professional-enabled');
  pro.checked = state.ui.professional === true;
  pro.onchange = (e) => update('ui.professional', e.target.checked);
  document.getElementById('btn-calibrate').onclick = openCalibration;
  document.getElementById('btn-close-calibrate').onclick = closeCalibration;
  document.getElementById('btn-calibrate-redo').onclick = () => { calStage = 0; calTaken = {}; startCalibrationStage(); };

  // Making a profile is where the folder gets settled, because it is the one
  // moment that has both a reason to ask and a click to ask with. A profile is
  // a record of what somebody has achieved; it should not be built somewhere a
  // browser is entitled to throw away.
  //
  // The picker is opened before anything is awaited. A browser only lets a page
  // open one while the click that caused it is still fresh, and every `await`
  // in between is a chance for that to lapse — which is why whether a folder
  // exists is tracked as we go rather than looked up here.
  document.getElementById('btn-profile-create').onclick = async () => {
    const input = document.getElementById('profile-new-name');
    if (canUseFolder() && !folderChosen) {
      try {
        await chooseFolder();
        folderChosen = true;
        await renderFolderState();
      } catch {
        showToast('A profile is kept in a folder on disk · nothing was created', 4000);
        return;
      }
    }
    createProfile(input.value);
    input.value = '';
    renderProfiles();
    showToast(`Now practising as ${currentProfile().name}`);
    // Written out at once, so the folder holds the profile from the moment it
    // exists rather than from the first thing that happens to it
    keepProfileOnDisk();
  };

  document.getElementById('btn-profile-folder').onclick = async () => {
    if (!canUseFolder()) {
      showToast('This browser cannot be given a folder — profile files download instead', 4000);
      return;
    }
    try {
      await chooseFolder();
      folderChosen = true;
      await renderFolderState();
      showToast('Profile folder set');
      keepProfileOnDisk();
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

// ── Calibration ──────────────────────────────────────────────────────────────
//
// Three passes of eight strikes: soft, ordinary, loud. What comes out is where
// this player's dynamics sit on this keyboard, which is what lets a run be
// graded against a recording made on somebody else's.
//
// The capture listens to the same `midi:noteon` everything else does, so the
// notes sound as they are played and there is nothing to learn about how to do
// it. Nothing is written down until all three passes are in and they came out
// in order.
let calStage = 0;
let calStrikes = [];
let calTaken = {};
let calStopListening = null;

function openCalibration() {
  calStage = 0;
  calTaken = {};
  startCalibrationStage();
  document.getElementById('calibrate-modal').classList.remove('hidden');
}

function closeCalibration() {
  calStopListening?.();
  calStopListening = null;
  document.getElementById('calibrate-modal').classList.add('hidden');
  renderCalibrationState();
}

function startCalibrationStage() {
  calStrikes = [];
  const level = CALIBRATION_LEVELS[calStage];
  document.getElementById('calibrate-ask').innerHTML =
    `Play <strong>${CALIBRATION_STRIKES} notes</strong> at <strong>${level.name}</strong> — ${level.ask}.`;
  drawCalibrationMeter();
  setCalibrationNote(state.midi.connected
    ? `Pass ${calStage + 1} of ${CALIBRATION_LEVELS.length}.`
    : 'No MIDI keyboard is connected — there is nothing to measure.');

  calStopListening?.();
  calStopListening = on('midi:noteon', ({ velocity }) => {
    if (calStrikes.length >= CALIBRATION_STRIKES) return;
    calStrikes.push(velocity ?? 90);
    drawCalibrationMeter();
    if (calStrikes.length >= CALIBRATION_STRIKES) finishCalibrationStage();
  });
}

function finishCalibrationStage() {
  const level = CALIBRATION_LEVELS[calStage];
  calTaken[level.key] = summariseStrikes(calStrikes);
  calStopListening?.();
  calStopListening = null;

  if (calStage + 1 < CALIBRATION_LEVELS.length) {
    calStage += 1;
    setCalibrationNote(`${level.name} came out at ${calTaken[level.key].velocity}. Next one…`);
    setTimeout(startCalibrationStage, 900);
    return;
  }

  // The one thing that can go wrong is worth naming rather than fitting a curve
  // through: three passes that did not come out in order mean the passes were
  // not what was asked for, and a calibration built on them would be worse than
  // none at all.
  if (!calibrationIsUsable(calTaken)) {
    setCalibrationNote(
      `Those came out at ${CALIBRATION_LEVELS.map(l => `${l.name} ${calTaken[l.key].velocity}`).join(', ')}` +
      ' — which is not louder each time, so nothing was saved. Start again and lean into the last pass.');
    return;
  }

  const live = (state.midi.inputs || []).find(i => i.state === 'connected' && i.enabled);
  setCalibration({
    at: Date.now(),
    inputId: live?.id ?? null,
    inputName: live?.name ?? null,
    anchors: calTaken,
  });
  keepProfileOnDisk('Calibration');
  // The last thing asked for is over, so it stops being what the screen says
  document.getElementById('calibrate-ask').innerHTML =
    `<strong>Measured.</strong> Runs in professional mode are now graded against this keyboard.`;
  setCalibrationNote(CALIBRATION_LEVELS.map(l => `${l.name} ${calTaken[l.key].velocity}`).join(' · '));
  showToast('Keyboard calibrated', 2400);
  renderCalibrationState();
}

function drawCalibrationMeter() {
  const meter = document.getElementById('calibrate-meter');
  meter.innerHTML = '';
  for (let i = 0; i < CALIBRATION_STRIKES; i++) {
    const bar = document.createElement('div');
    bar.className = `calibrate-strike${i < calStrikes.length ? ' struck' : ''}`;
    // The height is the strike itself, so a pass that wandered looks like one
    bar.style.height = i < calStrikes.length ? `${8 + (calStrikes[i] / 127) * 46}px` : '4px';
    meter.appendChild(bar);
  }
}

const setCalibrationNote = (text) => { document.getElementById('calibrate-note').textContent = text; };

function renderCalibrationState() {
  const el = document.getElementById('profile-calibration-state');
  const cal = calibrationOf();
  if (!cal) {
    el.textContent = 'Not calibrated — dynamics are graded as though this keyboard were the one the piece was played on.';
    return;
  }
  const when = new Date(cal.at).toLocaleDateString();
  const where = cal.inputName ? ` on ${cal.inputName}` : '';
  const levels = CALIBRATION_LEVELS.map(l => `${l.name} ${cal.anchors[l.key].velocity}`).join(', ');
  const drifted = calibrationMatchesInput(state.midi.inputs, cal)
    ? ''
    : ' · a different keyboard is connected now, so this wants taking again';
  el.textContent = `Calibrated ${when}${where}: ${levels}.${drifted}`;
}

// Said once a load, at the moment it matters: the run about to start is going to
// be graded on dynamics measured somewhere else.
let toldAboutCalibration = false;

function noteCalibrationDrift() {
  if (toldAboutCalibration || !state.ui.professional) return;
  const cal = calibrationOf();
  if (!cal) return;
  if (calibrationMatchesInput(state.midi.inputs, cal)) return;
  toldAboutCalibration = true;
  showToast(`This is not the keyboard "${cal.inputName || 'your calibration'}" was measured on — calibrate again under Profiles…`, 5000);
}

// A rename takes the file with it, because the folder is meant to read like the
// list of profiles rather than like a history of what they used to be called.
//
// What is written under the new name is what was under the old one — that file
// holds the profile's settings and song as well, and those did not change — with
// only the renamed profile put back over the top. It cannot be rebuilt from what
// is on screen: that belongs to whoever is currently practising, who may not be
// the person being renamed.
async function renameFromDialog(profile) {
  const wanted = prompt(`Rename "${profile.name}" to:`, profile.name);
  if (wanted === null) return;
  const moved = renameProfile(profile.id, wanted);
  if (!moved) { showToast('A profile needs a name', 2200); return; }
  renderProfiles();

  if (moved.from === moved.to) return;
  const handle = await folderHandle();
  if (!handle) {
    showToast(`Renamed · its file becomes ${moved.to} the next time one is written`, 3200);
    return;
  }
  try {
    const carried = await readFromFolder(handle, moved.from);
    await writeToFolder(handle, moved.to, bundleToJSON({
      profile: moved.profile,
      settings: carried?.settings,
      composition: carried?.composition,
    }));
    await removeFromFolder(handle, moved.from);
    showToast(`Renamed · now kept in ${moved.to}`, 2600);
  } catch (err) {
    showToast(`Renamed, but the folder refused the move: ${err.message}`, 4000);
  }
}

// Deleting takes the file too. Leaving it is not merely untidy: the next scan of
// the folder reads every file in it, and the deleted profile would walk back in.
async function deleteFromDialog(profile) {
  if (!confirm(`Delete "${profile.name}"? Its best runs go with it, here and in the profile folder.`)) return;
  const filename = deleteProfile(profile.id);
  if (!filename) return;
  renderProfiles();
  const handle = await folderHandle();
  if (handle) await removeFromFolder(handle, filename);
}

function renderProfiles() {
  const list = document.getElementById('profile-list');
  const active = currentProfile();
  list.innerHTML = '';

  for (const profile of listProfiles()) {
    const row = document.createElement('div');
    row.className = `profile-item${profile.id === active.id ? ' active' : ''}`;

    // Pressing the profile is how you get at what it has done. Switching to it
    // first, because a best belongs to whoever set it and loading one back is
    // an invitation to go and beat it.
    const name = document.createElement('button');
    name.className = 'profile-item-name profile-open';
    name.textContent = profile.name;
    name.title = 'Browse this profile\u2019s best runs';
    name.onclick = () => {
      if (profile.id !== active.id) { switchProfile(profile.id); renderProfiles(); }
      openBests(currentProfile());
    };

    const meta = document.createElement('span');
    meta.className = 'profile-item-meta';
    const at = profile.id === active.id ? learningPosition() : null;
    meta.textContent = at ? `section ${at.sectionIndex + 1} of "${at.songName}"` : '';

    // Which file this profile lives in. Worth saying out loud: it is the thing
    // a player would go looking for in the folder, and seeing it here is how
    // two profiles with similar names are told apart.
    const file = document.createElement('span');
    file.className = 'profile-item-file';
    file.textContent = profile.filename;

    row.append(name, meta, file);

    if (profile.id !== active.id) {
      const use = document.createElement('button');
      use.className = 'modal-btn';
      use.textContent = 'Use';
      use.onclick = () => { switchProfile(profile.id); renderProfiles(); showProfileWelcome(); };
      row.appendChild(use);
    }

    const rename = document.createElement('button');
    rename.className = 'modal-btn';
    rename.textContent = 'Rename';
    rename.onclick = () => renameFromDialog(profile);
    row.appendChild(rename);

    const remove = document.createElement('button');
    remove.className = 'modal-btn';
    remove.textContent = 'Delete';
    remove.disabled = listProfiles().length <= 1;
    remove.onclick = () => deleteFromDialog(profile);
    row.appendChild(remove);

    list.appendChild(row);
  }
  renderFolderState();
  renderCalibrationState();
  document.getElementById('professional-enabled').checked = state.ui.professional === true;
}

// Making a profile insists on a folder and writes the file at once, but the
// "Default" profile is made by the app before anybody has been asked anything,
// and profiles that predate all of this have never been written out either.
// Opening the dialog is the moment to notice — it is where a folder is most
// likely to already be granted, and it is the screen that promises every
// profile a file.
async function backfillCurrentFile() {
  const handle = await folderHandle();
  if (!handle) return;
  if (await readFromFolder(handle, fileNameFor(currentProfile()))) return;
  keepProfileOnDisk();
}

async function renderFolderState() {
  const el = document.getElementById('profile-folder-state');
  if (!canUseFolder()) {
    el.textContent = 'This browser cannot be given a folder. Save downloads a profile file instead, and it can be loaded back below.';
    return;
  }
  const handle = await folderHandle();
  if (handle) {
    el.textContent = `Using "${handle.name}". Bests are written there as they are set.`;
    return;
  }
  // A folder that is chosen but not yet permitted for this page load is not the
  // same as no folder at all, and saying so is the difference between a click
  // that fixes it and a search for a setting that is already set.
  const stored = await storedFolder();
  el.textContent = stored
    ? `Using "${stored.name}", which needs permission again this visit — Choose folder… or Save will restore it.`
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

// ── Stepping between sections ────────────────────────────────────────────────
//
// Train and Learn both work on the section the playhead is in, so choosing a
// section meant scrubbing until the playhead landed in the right one. These
// move it a whole section at a time instead.
//
// While a section walk is running they step the walk itself, because that is
// what "the next section" means at that moment — the walk owns the transport
// and moving the playhead underneath it would be talking past it.

function sectionList() {
  const size = sectionSize();
  return size ? buildSections(size) : [];
}

function stepSection(delta) {
  if (isWalking()) {
    if (delta < 0) previousSection(); else advanceSection();
    return;
  }
  const sections = sectionList();
  if (!sections.length) {
    showToast('Choose a section size to step through the piece', 2000);
    return;
  }

  const { tempo, timeSignature } = state.composition;
  const here = barAtMs(state.transport.currentTime, tempo, timeSignature);
  // The last section that has started. A playhead sitting before the first one
  // — or in a stretch of rests between two — belongs to the one behind it.
  let at = -1;
  for (let i = 0; i < sections.length; i++) if (sections[i].startBar <= here) at = i;

  const to = Math.min(sections.length - 1, Math.max(0, at + delta));
  if (to === at) {
    showToast(delta < 0 ? 'Already at the first section' : 'Already at the last section', 1600);
    return;
  }

  const target = sections[to];
  seekTo(barRangeMs(target.startBar, target.endBar, tempo, timeSignature).startMs);
  showToast(`Section ${to + 1} of ${sections.length} · bars ${target.startBar}–${target.endBar}`, 1900);
}

// Nothing to step through while the piece is one section, or while it has no
// notes. The buttons dim rather than vanishing, so the row does not reflow.
function syncSectionButtons() {
  const usable = isWalking() || sectionList().length > 1;
  for (const id of ['btn-prev-section', 'btn-next-section']) {
    document.getElementById(id).disabled = !usable;
  }
}

function bindSectionWalk() {
  const modal = document.getElementById('section-modal');

  document.getElementById('btn-prev-section').onclick = () => stepSection(-1);
  document.getElementById('btn-next-section').onclick = () => stepSection(1);
  on('change:ui.learnSectionBars', syncSectionButtons);
  on('change:ui.practiceHand', syncSectionButtons);
  on('transport:noteschanged', syncSectionButtons);
  on('change:transport.loopEnabled', syncSectionButtons);
  // A walk owns the buttons while it runs, so they follow it starting and ending
  on('sections:preview', syncSectionButtons);
  on('sections:end', syncSectionButtons);
  syncSectionButtons();

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
    // On the first section there is nothing behind it, and going back to the
    // one you are on is what "Learn it again" already is
    document.getElementById('btn-section-prev').classList.toggle('hidden', s.index === 0);
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
  document.getElementById('btn-section-prev').onclick = () => previousSection();
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

// One Import button for every format. A MIDI file announces itself in its first
// four bytes, which is more reliable than trusting the extension; audio is
// asked about first, because a .wav read as text is nonsense rather than an
// error. Audio returns null here and is handled on its own path, since it is
// the one import that takes seconds and can be wrong.
async function readImportedFile(file) {
  if (looksLikeAudio(file)) return null;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isMidi = String.fromCharCode(...head) === 'MThd';
  if (isMidi) return midiToComposition(await file.arrayBuffer());
  if (/\.midi?$/i.test(file.name)) throw new Error('That .mid file does not start with a MIDI header');
  return compositionFromJSON(await file.text());
}

// ── Listening to a recording ─────────────────────────────────────────────────

// Transcription is a guess that takes a few seconds, so unlike every other
// import it shows its working and asks before replacing what is loaded.
let pendingTranscription = null;

const STAGE_TEXT = {
  decoding: 'Decoding the file…',
  listening: 'Listening for notes…',
};

function showTranscribeProgress(stage, fraction) {
  document.getElementById('transcribe-stage').textContent = STAGE_TEXT[stage] || 'Working…';
  document.getElementById('transcribe-fill').style.width = `${Math.round((fraction || 0) * 100)}%`;
}

function describeRange(lo, hi) {
  return `${midiToNoteWithOctave(lo, state.ui.middleC)} – ${midiToNoteWithOctave(hi, state.ui.middleC)}`;
}

function syncTranscribeTempo() {
  if (!pendingTranscription) return;
  tempoOctave = 0;
  const { composition, report } = pendingTranscription;
  document.getElementById('tr-tempo').value = String(composition.tempo);
  // Confidence is the share of beats that had something on them, so a clean
  // reading sits at or near 1 and anything much below it means the pulse had
  // gaps to guess across — which is exactly when the barlines are worth a look.
  const shaky = report.tempoConfidence < 0.8;
  document.getElementById('tr-tempo-note').textContent = shaky
    ? 'the beat was hard to find here — check the barlines'
    : 'halve or double it if the bars look long or short';
}

async function importAudio(file) {
  const modal = document.getElementById('transcribe-modal');
  const progress = document.getElementById('transcribe-progress');
  const report = document.getElementById('transcribe-report');
  const keep = document.getElementById('btn-transcribe-keep');

  pendingTranscription = null;
  modal.classList.remove('hidden');
  progress.classList.remove('hidden');
  report.classList.add('hidden');
  keep.classList.add('hidden');
  document.getElementById('transcribe-title').textContent = 'Listening…';
  document.getElementById('transcribe-sub').textContent = file.name;
  showTranscribeProgress('decoding', 0);

  try {
    const result = await transcribeAudioFile(file, {
      onProgress: ({ stage, fraction }) => showTranscribeProgress(stage, fraction),
    });
    pendingTranscription = result;

    document.getElementById('transcribe-title').textContent = 'Here is what it heard';
    document.getElementById('transcribe-sub').textContent =
      'Nothing has changed yet — look it over first.';
    document.getElementById('tr-notes').textContent = String(result.report.noteCount);
    document.getElementById('tr-range').textContent =
      describeRange(result.report.lowest, result.report.highest);
    document.getElementById('tr-length').textContent =
      `${Math.round(result.report.seconds)}s`;
    syncTranscribeTempo();

    progress.classList.add('hidden');
    report.classList.remove('hidden');
    keep.classList.remove('hidden');
  } catch (err) {
    modal.classList.add('hidden');
    pendingTranscription = null;
    showToast(err.message || 'Could not read that audio', 4000);
  }
}

function keepTranscription() {
  if (!pendingTranscription) return;
  const { composition } = pendingTranscription;
  composition.tempo = Math.max(20, Math.min(300,
    Number(document.getElementById('tr-tempo').value) || composition.tempo));
  document.getElementById('transcribe-modal').classList.add('hidden');
  const song = { ...composition, id: `heard-${Date.now()}` };
  pendingTranscription = null;
  loadComposition(song);
  emit('transport:noteschanged', state.composition.notes);
}

// Halving and doubling step around what was detected rather than around the
// last rounded value. Compounding the rounding turns 151 into 76 into 152, and
// a control that does not come back to where it started is a control nobody
// trusts.
let tempoOctave = 0;

function nudgeTranscribeTempo(direction) {
  if (!pendingTranscription) return;
  const base = pendingTranscription.report.tempo;
  const next = tempoOctave + direction;
  const shifted = base * Math.pow(2, next);
  if (shifted < 20 || shifted > 300) return;
  tempoOctave = next;
  document.getElementById('tr-tempo').value = String(Math.round(shifted));
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
  count:     { path: 'ui.showCountOverlay', button: 'btn-count-overlay', on: 'Counting the bar out', off: 'Counting off' },
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

// ── What a run is a run *of* ─────────────────────────────────────────────────
//
// Taken when the run starts rather than when it ends, because the results
// screen changes the tempo from underneath: its retry buttons move it before
// anything has been recorded, and a best filed under the tempo of the next
// attempt would be filed under a speed nobody has played yet.

// The identity of the run in progress, and the tempo its note times are in
let trainingRunKey = null;
let trainingRunTempo = 120;
// What stood before the run that just finished, whether it beat it, and
// whether it counted at all
let bestBefore = null;
let lastWasBest = false;
let lastAbandoned = false;

// The rate the notes actually arrive at. The tempo is what they are written at;
// the speed slider is a second multiplier on top of it, and a passage taken at
// 60 BPM with the slider at 150% is a passage at 90 BPM to the fingers.
function effectiveBpm() {
  return Math.round(state.composition.tempo * (state.transport.speed || 1));
}

function keyForRun(bars) {
  return trainingKey({
    songName: state.composition.name,
    bars,
    hand: practiceHand(),
    bpm: effectiveBpm(),
  });
}

// Called once, where the run ends
function recordBest(results) {
  bestBefore = null;
  lastWasBest = false;
  lastAbandoned = false;
  // A run with nothing in it to grade is not an attempt at anything
  if (!trainingRunKey || !results.total) return;

  // A run stopped before the end is not one either. Everything past where it
  // stopped counts as missed, so its score says when the player gave up rather
  // than how they played — and on a first attempt it would stand as a best that
  // every later run "beats" for no reason at all.
  if (!results.completed) { lastAbandoned = true; return; }

  bestBefore = bestFor(trainingRunKey);
  lastWasBest = rememberBest(trainingRunKey, {
    ...results, tempo: trainingRunTempo, take: getTake(),
  });
  if (lastWasBest) keepBestOnDisk();
}

// ── Keeping a profile on disk ────────────────────────────────────────────────
//
// A best is written out the moment it is set, rather than waiting for Save. It
// is the thing a player would most mind losing, and browser storage is
// evictable, does not survive clearing site data, and does not travel between
// machines.
//
// Two things stand between wanting to write and being able to. A folder can
// only be *chosen* with a click behind it, which is why making a profile
// insists on one. And the permission to write to a chosen folder is dropped on
// every page load unless the player told the browser to keep it — so a folder
// settled yesterday still needs a click today before anything can go into it.
// `armFolder` spends the click that starts a training run on exactly that, once
// per load, so the permission is live by the time the run produces a best.

// Whether a folder has ever been chosen. Tracked rather than looked up, because
// the answer is needed inside a click handler before it can afford to await.
let folderChosen = false;
let folderArmed = false;
let toldAboutFolder = false;

async function refreshFolderChosen() {
  folderChosen = Boolean(await storedFolder());
}

// Called from the click that starts a run: asks for the permission that a page
// load dropped, while there is still a gesture to ask with. Silent when there
// is no folder, and tried once per load so a refusal is not asked again.
function armFolder() {
  if (folderArmed || !folderChosen || !canUseFolder()) return;
  folderArmed = true;
  folderHandle({ prompt: true }).catch(() => { /* declined; the toast will say so */ });
}

function warnAboutFolderOnce(text) {
  if (toldAboutFolder) return;
  toldAboutFolder = true;
  showToast(text, 5000);
}

async function keepProfileOnDisk(what = 'Profile') {
  try {
    if (!canUseFolder()) {
      warnAboutFolderOnce(`${what} kept in this browser · it cannot be given a folder to write to`);
      return false;
    }
    const handle = await folderHandle();
    if (!handle) {
      // "No folder" and "a folder we may not touch yet" are different problems
      // with different remedies, and telling somebody to choose a folder they
      // already chose is the more annoying of the two answers.
      warnAboutFolderOnce(await storedFolder()
        ? `${what} kept in this browser · the profile folder needs permission again, which pressing Save will restore`
        : `${what} kept in this browser · choose a profile folder under Profiles… to keep it on disk too`);
      return false;
    }
    await writeToFolder(handle, fileNameFor(currentProfile()), bundleToJSON(collectBundle()));
    return true;
  } catch (err) {
    showToast(`${what} kept, but the folder refused it: ${err.message}`, 4000);
    return false;
  }
}

const keepBestOnDisk = () => keepProfileOnDisk('New best');

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

  trainingRunKey = keyForRun(lastTrainingBars);
  trainingRunTempo = state.composition.tempo;
  // Spend this click on the folder permission a page load dropped, so the best
  // this run might produce has somewhere to go
  armFolder();
  noteCalibrationDrift();

  withCountIn(() => {
    startAccuracy(state.composition, range, { calibration: calibrationOf() });
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

// A take is a list of times in milliseconds, and milliseconds only mean
// anything against the tempo the notes were at when it was recorded. Changing
// the tempo rescales every note in the piece, so a take kept from an earlier
// session has to be rescaled the same way or its outlines land on nothing.
function scaleTake(take, from, to) {
  if (!take || !from || !to || from === to) return take;
  const k = from / to;
  const scale = (n) => ({ ...n, startTime: n.startTime * k, duration: n.duration * k });
  return {
    range: take.range
      ? { startMs: take.range.startMs * k, endMs: take.range.endMs * k,
          tailMs: (take.range.tailMs || 0) * k }
      : null,
    notes: take.notes.map(scale),
    expected: take.expected.map(n => ({ ...n, startTime: n.startTime * k })),
  };
}

function replayTake(source = null, what = 'your take') {
  const take = source || getTake();
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
  showToast(`Replaying ${what} — outlines are the keys you pressed`, 2600);
  playRange(from, to);
}

// The best run of this passage, at this hand setting and this speed, played
// back against the piece as it stands now
function replayBest() {
  const best = trainingRunKey && bestFor(trainingRunKey);
  if (!best?.take) {
    showToast('No best run kept for this passage yet', 2200);
    return;
  }
  replayTake(scaleTake(best.take, best.tempo, state.composition.tempo),
             `your best (${best.score}%)`);
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
//
// The notch is ten beats a minute, not ten per cent. A percentage is a
// different number of beats at every tempo — it was six at sixty and eighteen
// at a hundred and eighty — so pressing the same button twice on two pieces did
// two different things, and a player working a passage up in tens had to do the
// arithmetic themselves. And the figure can be typed into, because after a few
// attempts you often already know which tempo you want to try.

const RETRY_TEMPO_STEP = 10; // BPM

// The tempo the run was played at, so the delta beside the figure can say how
// far it has moved from what was just attempted
let retryTempoBase = 120;

function setRetryTempo(bpm, { announce = true } = {}) {
  const before = state.composition.tempo;
  setTempo(bpm);
  updateRetryTempoLabel();
  if (state.composition.tempo === before) return false;
  // Getting a section faster is progress worth keeping
  if (trainingSectionKey) rememberSectionTempo(trainingSectionKey, state.composition.tempo);
  if (announce) showToast(`Retry at ${state.composition.tempo} BPM`, 1200);
  return true;
}

function nudgeRetryTempo(direction) {
  const moved = setRetryTempo(state.composition.tempo + direction * RETRY_TEMPO_STEP);
  if (!moved) {
    showToast(direction < 0 ? 'Already as slow as it goes' : 'Already as fast as it goes', 1400);
  }
}

// Typed in directly. An empty or unreadable field is somebody mid-edit rather
// than a request for a tempo of nothing, so it puts back what is actually set.
function commitRetryTempo(raw) {
  const wanted = parseInt(raw, 10);
  if (!Number.isFinite(wanted)) { updateRetryTempoLabel(); return; }
  setRetryTempo(wanted);
}

function updateRetryTempoLabel() {
  const el = document.getElementById('retry-tempo-value');
  if (!el) return;
  const bpm = state.composition.tempo;
  // Not while it is being typed into, or the cursor jumps to the end of a
  // half-finished number
  if (document.activeElement !== el) el.value = bpm;
  const delta = bpm - retryTempoBase;
  document.getElementById('retry-tempo-delta').textContent =
    delta ? `${delta > 0 ? '+' : '\u2212'}${Math.abs(delta)}` : '';
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
  document.getElementById('btn-monitor').onclick = toggleMonitor;
  document.getElementById('metro-subdivision').onchange = (e) => setSubdivision(e.target.value);
  document.getElementById('btn-beat-overlay').onclick = () => toggleOverlay('beat');
  document.getElementById('btn-chord-overlay').onclick = () => toggleOverlay('chord');
  document.getElementById('btn-count-overlay').onclick = () => toggleOverlay('count');
  document.getElementById('btn-fingering').onclick = () => {
    toggleOverlay('fingering'); syncFingeringGuessNote(); syncHandStage();
  };
  document.getElementById('btn-suggest-fingering').onclick = toggleSuggestFingering;
  document.getElementById('btn-hand-overlay').onclick = toggleHandOverlay;
  document.getElementById('btn-learn-mode').onclick = toggleLearnMode;

  document.getElementById('speed-slider').oninput = (e) => {
    update('transport.speed', parseInt(e.target.value) / 100);
    syncSpeedControls();
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

  const SWING_HINT = 'Uneven eighths written straight, under a swing marking — the way a jazz chart reads';
  const swingSelect = document.getElementById('swing-select');
  swingSelect.value = state.ui.swing;
  swingSelect.onchange = (e) => {
    update('ui.swing', e.target.value);
    scheduleSheetRender();
  };
  // Naming only: the pitch, the key and the exported MIDI are untouched, so
  // nothing needs rebuilding beyond whatever is currently drawing labels.
  const middleCSelect = document.getElementById('middle-c-select');
  middleCSelect.value = String(state.ui.middleC);
  middleCSelect.onchange = (e) => {
    update('ui.middleC', parseInt(e.target.value, 10));
    scheduleSheetRender();
    showToast(`Middle C is now ${midiToNoteWithOctave(60, state.ui.middleC)}`, 1400);
  };

  const amountSlider = document.getElementById('swing-amount');
  amountSlider.value = String(SWING_STOPS.indexOf(state.ui.swingAmount));
  amountSlider.oninput = (e) => setSwingAmount(SWING_STOPS[Number(e.target.value)]);
  syncSwingAmount();

  // On Auto the answer comes out of the music, so say which one it reached —
  // a reader looking at straight eighths deserves to know they were swung
  on('sheet:swing', ({ swinging }) => {
    const auto = state.ui.swing === 'auto';
    swingSelect.classList.toggle('auto-swinging', auto && swinging);
    swingSelect.title = auto
      ? `Auto — this piece reads as ${swinging ? 'swung' : 'straight'}`
      : SWING_HINT;
    // Nothing to act on while the piece is being written straight, so the
    // slider goes quiet rather than away — the setting still stands
    amountSlider.disabled = !swinging;
  });

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
  // Only what is on the stage can be clicked on it — a part that is switched
  // off is not drawn, and picking one to mark a loop with would be picking
  // something nobody can see.
  const note = noteAtFallingPoint(x, y, state.composition.notes.filter(isAudible),
                                  state.transport.currentTime);
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
      if (looksLikeAudio(file)) { await importAudio(file); return; }
      const imported = await readImportedFile(file);
      if (state.composition.notes.length &&
          !confirm('Replace the current composition with the imported one?')) return;
      const regrid = loadComposition(imported);
      const n = imported.notes.length;
      const detail = imported.warnings?.length ? ` · ${imported.warnings.join(' · ')}` : '';
      // Worth saying, because the control for it only just appeared in the
      // header and nothing else on screen shows the piece came in parts
      const parts = hasTracks() ? ` · ${trackList().length} tracks — see Tracks…` : '';
      showToast(`Imported "${imported.name}" — ${n} note${n === 1 ? '' : 's'}${parts}${detail}${gridNote(regrid)}`,
        imported.warnings?.length || parts ? 5000 : 2500);
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
  // Assigned rather than left to the spread: a piece written in one part has no
  // `tracks` at all, and without this the previous piece's parts would still be
  // sitting there deciding what sounds.
  state.composition.tracks = normalizeTracks(song.tracks, song.notes);
  syncTracksButton();
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
  document.getElementById('btn-transcribe-cancel').onclick = () => {
    document.getElementById('transcribe-modal').classList.add('hidden');
    pendingTranscription = null;
  };
  document.getElementById('btn-transcribe-keep').onclick = keepTranscription;
  document.getElementById('tr-halve').onclick = () => nudgeTranscribeTempo(-1);
  document.getElementById('tr-double').onclick = () => nudgeTranscribeTempo(1);

  document.getElementById('btn-close-accuracy').onclick = () => {
    document.getElementById('accuracy-modal').classList.add('hidden');
    lastTrainingBars = null;
  };
  document.getElementById('btn-train-again').onclick = retryTraining;
  document.getElementById('btn-retry-slower').onclick = () => nudgeRetryTempo(-1);
  document.getElementById('btn-retry-faster').onclick = () => nudgeRetryTempo(1);
  const retryInput = document.getElementById('retry-tempo-value');
  retryInput.onchange = (e) => commitRetryTempo(e.target.value);
  // Enter commits and gets out of the way, so the next thing pressed is Space
  // for another attempt rather than a keystroke into a field
  retryInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); retryInput.blur(); } };

  document.getElementById('btn-results-prev').onclick = () => trainAdjacentSection(-1);
  document.getElementById('btn-results-next').onclick = () => trainAdjacentSection(1);
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
    { id: 'count-overlay', group: 'global', hint: 'btn-count-overlay',
      section: 'Options', label: 'Count the bar out over the falling notes',
      defaultBindings: [{ code: 'KeyN', shift: true }],
      run: () => toggleOverlay('count') },
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
    { id: 'monitor', group: 'global', hint: 'btn-monitor',
      section: 'Options', label: 'Sound the keys you play (local off)',
      defaultBindings: [{ code: 'KeyL', shift: true }],
      run: () => toggleMonitor() },
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
      // A part that has been switched off is off the stave too. Two staves hold
      // two hands, and a four-part file with everything on them is unreadable —
      // narrowing it to the parts being worked on is most of why the track list
      // is worth having.
      renderSheet(state.composition.notes.filter(isAudible), state.composition, t);
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
      const name = midiToNoteWithOctave(p, state.ui.middleC);
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

// What this passage says about itself, under the score: whether the run just
// played is the best one at this speed with this hand, and what it beat.
//
// Nothing at all on a first attempt. A number to compare against is only worth
// putting on the screen once there is something to compare with, and a line
// saying "best: 64%" under a 64% is noise.
// What to say when a passage has just had its best run. Louder the closer it
// came to perfect, and quieter for a first attempt — which sets a best without
// having beaten anything.
function cheerFor(best, previous) {
  const stars = best.stars ?? 0;
  if (!previous) return `${starText(stars)} stars — that is the bar to beat`;
  if (stars >= STAR_COUNT) return 'Flawless. Every note dead on 🎉';
  if (stars >= 9) return 'New personal best — outstanding 🎉';
  if (stars >= 7) return 'New personal best 🎉';
  return 'Better than last time — a new personal best 🎉';
}

// Having just finished a section, the next thing is usually the one beside it.
// Trained rather than merely moved to, because the screen this is on is what a
// finished run leaves behind and starting the next one is what it is for.
function trainAdjacentSection(delta) {
  const sections = sectionList();
  const here = lastTrainingBars;
  let at = sections.findIndex(s => here && s.startBar === here.startBar && s.endBar === here.endBar);
  if (at < 0) {
    // The last run was not one of these sections — the whole piece, a marked
    // loop, or a rough patch picked out of the results. Step from wherever the
    // playhead ended up instead.
    const { tempo, timeSignature } = state.composition;
    const bar = barAtMs(state.transport.currentTime, tempo, timeSignature);
    for (let i = 0; i < sections.length; i++) if (sections[i].startBar <= bar) at = i;
  }
  const to = Math.min(sections.length - 1, Math.max(0, at + delta));
  if (!sections.length || to === at) {
    showToast(delta < 0 ? 'Already at the first section' : 'Already at the last section', 1600);
    return;
  }
  startTrainingSession(sections[to]);
}

// Only worth offering where there is more than one section to be at
function syncResultsSectionButtons() {
  const many = sectionList().length > 1;
  document.getElementById('btn-results-prev').classList.toggle('hidden', !many);
  document.getElementById('btn-results-next').classList.toggle('hidden', !many);
}

function showBestLine() {
  const line = document.getElementById('best-line');
  const cheer = document.getElementById('best-cheer');
  const replayBtn = document.getElementById('btn-replay-best');
  const best = trainingRunKey ? bestFor(trainingRunKey) : null;
  const bpm = effectiveBpm();

  // Restarted from the class rather than left running, so a second best in a
  // row is announced again instead of inheriting a finished animation
  cheer.classList.toggle('hidden', !(lastWasBest && best));
  cheer.classList.remove('pop');
  if (lastWasBest && best) {
    cheer.textContent = cheerFor(best, bestBefore);
    void cheer.offsetWidth;
    cheer.classList.add('pop');
  }

  if (!best && !lastAbandoned) {
    line.classList.add('hidden');
    replayBtn.classList.add('hidden');
    return;
  }

  line.classList.remove('hidden');
  line.classList.toggle('fresh', lastWasBest);
  // Led with in stars, because the stars are what decides which run is the
  // better one and what the screen above says. The percentage rides along,
  // where it can be seen to disagree without being mistaken for the thing
  // being beaten.
  const rating = (b) => b.stars == null ? `<b>${b.score}%</b>` : `<b>${starText(b.stars)}</b> stars`;

  if (lastAbandoned) {
    // Said rather than left to be noticed: a run that scored well on the part
    // that was played and then vanished without setting anything looks broken.
    line.innerHTML = best
      ? `Stopped early, so this one is not kept · your best at ${bpm} BPM is ${rating(best)}`
      : 'Stopped before the end, so this one is not kept as a best';
  } else if (lastWasBest) {
    line.innerHTML = bestBefore
      ? `New best at ${bpm} BPM — ${rating(best)}, past your ${rating(bestBefore)}`
      : `Your first time through at ${bpm} BPM — ${rating(best)} to beat`;
  } else {
    line.innerHTML = `Your best at ${bpm} BPM is ${rating(best)}` +
      `<span class="best-detail"> · ${best.score}%, ${best.perfect} perfect, ${best.missed} missed</span>`;
  }

  // Only when it is a different run from the one already on the screen — after
  // a new best the two are the same take, and "Replay my take" is that button.
  const offerBest = !lastWasBest && Boolean(best?.take);
  replayBtn.classList.toggle('hidden', !offerBest);
  if (offerBest) replayBtn.onclick = replayBest;
}

// ── The star rating ──────────────────────────────────────────────────────────

// Quarters, written the way they are read: 8¾ rather than 8.75.
const QUARTERS = ['', '¼', '½', '¾'];
function starText(value) {
  const whole = Math.floor(value + 1e-9);
  const quarter = Math.round((value - whole) * 4);
  return `${whole}${QUARTERS[quarter] || ''}`;
}

function showStars(value) {
  const row = document.getElementById('star-rating');
  row.innerHTML = Array.from({ length: STAR_COUNT }, (_, i) => {
    // How much of this one was earned: the whole of it until the rating runs
    // out, then whatever fraction is left, then nothing
    const fill = Math.max(0, Math.min(1, value - i));
    return `<span class="star"><i>★</i><b style="width:${(fill * 100).toFixed(0)}%">★</b></span>`;
  }).join('');
  row.setAttribute('aria-label', `${starText(value)} out of ${STAR_COUNT} stars`);
  document.getElementById('star-value').textContent = starText(value);
}

function showAccuracyResults(results) {
  lastResults = results;
  const modal = document.getElementById('accuracy-modal');
  const { score, stars, perfect, good, almost, missed, extra, avgLatencyMs } = results;

  showStars(stars ?? 0);
  showGauge(false);
  // Each results screen re-bases the retry steps on the tempo just played
  retryTempoBase = state.composition.tempo;
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

  showBestLine();
  syncResultsSectionButtons();

  // Offer the roughest couple of bars, when there is one worth repeating
  const worst = getWorstSection(state.composition);
  document.getElementById('btn-replay-take').onclick = () => replayTake();
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
