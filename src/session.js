// Everything the app was last doing, so a refresh puts it back — and so does
// picking a profile back up.
//
// The state belongs to the PROFILE, not to the browser. Two people sharing a
// tab do not share a tempo, a marked loop, a metronome or a place in the piece,
// and before this they did: the settings sat under one key for everybody and
// switching profiles left the app exactly as the last person had it. Now each
// profile carries its own, so switching puts the app back the way that person
// left it, down to where the playhead was.
//
// Two stores, because the halves have different shapes. Settings are a handful
// of values wanted before the first paint, so they ride in the profile record
// in localStorage and are read synchronously; the song can be thousands of
// notes, so it goes to IndexedDB beside the saved compositions, keyed by whose
// it is.
import { state, update, on, emit } from './state.js';
import { stop as stopTransport } from './transport.js';
import { saveWorkingComposition, loadWorkingComposition, compositionToJSON, compositionFromJSON } from './storage.js';
import {
  current as currentProfile, adoptProfile, switchProfile,
  rememberSession, sessionOf,
} from './profiles.js';

const SETTINGS_KEY = 'miditrain.settings';
const SAVE_DEBOUNCE_MS = 400;

// Stored values are untrusted: they can be stale, hand-edited, or written by a
// version of the app that meant something else by them. Each one is checked
// rather than assigned, and anything that does not survive keeps its default.
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const oneOf = (...allowed) => (v) => (allowed.includes(v) ? v : undefined);
const range = (lo, hi) => (v) =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const wholeRange = (lo, hi) => (v) => {
  const n = range(lo, hi)(v);
  return n === undefined ? undefined : Math.round(n);
};

const stringList = (v) =>
  (Array.isArray(v) && v.every(x => typeof x === 'string') ? v.slice(0, 64) : undefined);

// Every option the app remembers. What is still missing is deliberately
// transient: the selection, and whatever the transport is in the middle of.
const SETTINGS = {
  'ui.view': oneOf('sheet', 'piano-roll'),
  'ui.trainMode': bool,
  'ui.professional': bool,
  'ui.learnMode': bool,
  'ui.metronomeEnabled': bool,
  'ui.metronomeSubdivision': oneOf(1, 2, 3, 4),
  'ui.showBeatOverlay': bool,
  'ui.showChordOverlay': bool,
  'ui.showCountOverlay': bool,
  'ui.showPedal': bool,
  'ui.showFingering': bool,
  'ui.suggestFingering': bool,
  'ui.handOverlay': bool,
  'ui.muted': bool,
  'ui.volume': range(0, 1),
  'ui.clicksOnly': bool,
  'ui.monitorEnabled': bool,
  'ui.countInEnabled': bool,
  'ui.stepLegato': bool,
  'ui.quantize': oneOf(1, 2, 4, 8, 16, 32),
  'ui.swing': oneOf('auto', 'on', 'off'),
  'ui.middleC': oneOf(3, 4, 5),
  'ui.swingAmount': oneOf('light', 'medium', 'hard'),
  'ui.transpose': wholeRange(-12, 12),
  'ui.learnSectionBars': oneOf(0, 2, 4, 8),
  'ui.learnCluster': oneOf('off', 'halfBeat', 'beat', 'twoBeats', 'bar', 'twoBars'),
  'ui.recordHand': oneOf('auto', 'left', 'right'),
  'ui.practiceHand': oneOf('both', 'left', 'right'),
  'midi.disabledInputs': stringList,
  'transport.loopEnabled': bool,
  'transport.loopStartBar': wholeRange(1, 999),
  'transport.loopEndBar': wholeRange(1, 999),
  // Where they were in the piece. This used to be left out on the grounds that
  // a playhead is not a setting, which is true and was still wrong: coming back
  // to a piece and being put at the top of it is not where anybody left off.
  // Twelve hours is longer than any piece and keeps a damaged value bounded.
  'transport.currentTime': range(0, 12 * 60 * 60 * 1000),
};

// ...but it moves on every frame of playback, and a save on every frame is a
// write to localStorage forty times a second. It is written whenever anything
// else is, and always on the way out, which is what makes it accurate at the
// only moment it is read.
const NOT_WORTH_SAVING_FOR = new Set(['transport.currentTime']);

function readPath(path) {
  return path.split('.').reduce((obj, key) => (obj ? obj[key] : undefined), state);
}

// ── Restore, before the first render ─────────────────────────────────────────

// What the app kept under one key for everybody, before profiles had their own.
// Read once, as the starting point for a profile that has never been put down.
function legacySettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return saved && typeof saved === 'object' ? saved : null;
  } catch {
    return null;
  }
}

function applySettings(saved) {
  if (!saved || typeof saved !== 'object') return false;
  for (const [path, check] of Object.entries(SETTINGS)) {
    const value = check(saved[path]);
    if (value !== undefined) update(path, value);
  }
  // Two practice modes cannot both be armed; a stored pair that says otherwise
  // came from an older build
  if (state.ui.trainMode && state.ui.learnMode) update('ui.learnMode', false);
  return true;
}

export function restoreSettings() {
  const mine = sessionOf();
  // A profile with nothing of its own inherits whatever the browser was set to,
  // so upgrading does not reset everybody to defaults
  applySettings(Object.keys(mine).length ? mine : legacySettings());
}

export async function restoreComposition() {
  try {
    const composition = await loadWorkingComposition(currentProfile()?.id || null);
    if (!composition) return false;
    Object.assign(state.composition, composition);
    return true;
  } catch {
    // A composition that will not load is not worth blocking start-up over
    return false;
  }
}

// ── The whole of it, for a file ──────────────────────────────────────────────
// One definition of "all current state", so what Save writes and what loading
// a file puts back cannot drift apart.

export function collectBundle() {
  const settings = {};
  for (const path of Object.keys(SETTINGS)) settings[path] = readPath(path);
  return {
    profile: currentProfile(),
    settings,
    composition: JSON.parse(compositionToJSON(state.composition)).composition,
  };
}

// Returns what it actually restored, so the caller can say so
export function applyBundle(bundle) {
  const applied = { profile: null, settings: false, composition: false };

  const profile = adoptProfile(bundle.profile);
  if (profile) { switchProfile(profile.id); applied.profile = profile; }

  if (bundle.settings && typeof bundle.settings === 'object') {
    for (const [path, check] of Object.entries(SETTINGS)) {
      const value = check(bundle.settings[path]);
      if (value !== undefined) update(path, value);
    }
    applied.settings = true;
  }

  if (bundle.composition) {
    try {
      const composition = compositionFromJSON(JSON.stringify(bundle.composition));
      Object.assign(state.composition, composition);
      applied.composition = true;
    } catch { /* the profile is still worth having without the song */ }
  }
  return applied;
}

// ── Save, as things change ───────────────────────────────────────────────────

let timer = null;

function collectSettings() {
  const out = {};
  for (const path of Object.keys(SETTINGS)) out[path] = readPath(path);
  return out;
}

// `who` is the profile being written to, which is not always the current one:
// on the way out of a profile the state still on screen is the departing one's.
function flush(who = currentProfile()?.id || null) {
  clearTimeout(timer);
  timer = null;
  rememberSession(collectSettings());
  saveWorkingComposition(state.composition, who).catch(() => {});
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
}

export function initSession() {
  on('transport:noteschanged', schedule);
  on('change', ({ path }) => {
    if (NOT_WORTH_SAVING_FOR.has(path)) return;
    if (SETTINGS[path] || path.startsWith('composition.')) schedule();
  });

  // ── Handing over between profiles ──
  //
  // The order matters and is the whole of it. Whatever is on screen belongs to
  // the profile being put down, so it is written there first — while it is
  // still the current one, since `rememberSession` writes to whoever that is.
  on('profile:leaving', ({ id }) => flush(id));
  on('profile:switched', async ({ to }) => {
    // A profile that has never been put down has nothing to restore, so it
    // takes what is on screen as its starting point and that is written to it
    // straight away. Wiping the desk instead was tried and is wrong twice
    // over: it throws away work for anyone adding a profile mid-practice, and
    // "as that profile last had it" has no meaning for one that has no last.
    if (!Object.keys(sessionOf()).length) {
      flush(to);
      emit('profile:restored', { id: to });
      return;
    }

    // Nothing should still be sounding from the last person's piece. `stop()`
    // rather than the event it emits: the event announces a stop, it does not
    // perform one, and it leaves the position alone — which matters, because
    // the position being restored below is the incoming profile's.
    stopTransport();
    applySettings(sessionOf());
    let composition = null;
    try { composition = await loadWorkingComposition(to); } catch { /* keep what is loaded */ }
    if (composition) Object.assign(state.composition, composition);
    // Everything that draws from the piece redraws from this
    emit('transport:noteschanged');
    emit('profile:restored', { id: to });
  });

  // Debouncing means the last few hundred milliseconds are still pending when
  // a tab goes away. Settings can be written synchronously on the way out;
  // the composition write is started here and usually lands, which is the best
  // IndexedDB offers from an unload.
  // Always, not only when a save is already pending: the playhead moves without
  // scheduling one, and where they got to is the thing most worth having
  const onLeaving = () => flush();
  window.addEventListener('pagehide', onLeaving);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeaving();
  });
}
