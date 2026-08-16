// Everything the app was last doing, so a refresh puts it back.
//
// Two stores, because the halves have different shapes. Settings are a handful
// of values wanted before the first paint, so they sit in localStorage and are
// read synchronously; the song can be thousands of notes, so it goes to
// IndexedDB beside the saved compositions.
import { state, update, on } from './state.js';
import { saveWorkingComposition, loadWorkingComposition } from './storage.js';

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

// Every option the app remembers. What is missing is deliberately transient:
// the playhead, the selection, and whatever the transport is doing.
const SETTINGS = {
  'ui.view': oneOf('sheet', 'piano-roll'),
  'ui.trainMode': bool,
  'ui.learnMode': bool,
  'ui.metronomeEnabled': bool,
  'ui.muted': bool,
  'ui.volume': range(0, 1),
  'ui.clicksOnly': bool,
  'ui.countInEnabled': bool,
  'ui.stepLegato': bool,
  'ui.quantize': oneOf(1, 2, 4, 8, 16, 32),
  'ui.transpose': wholeRange(-12, 12),
  'ui.learnSectionBars': oneOf(0, 2, 4, 8),
  'transport.loopEnabled': bool,
  'transport.loopStartBar': wholeRange(1, 999),
  'transport.loopEndBar': wholeRange(1, 999),
  'transport.speed': range(0.25, 2),
};

function readPath(path) {
  return path.split('.').reduce((obj, key) => (obj ? obj[key] : undefined), state);
}

// ── Restore, before the first render ─────────────────────────────────────────

export function restoreSettings() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return;
  }
  if (!saved || typeof saved !== 'object') return;

  for (const [path, check] of Object.entries(SETTINGS)) {
    const value = check(saved[path]);
    if (value !== undefined) update(path, value);
  }
  // Two practice modes cannot both be armed; a stored pair that says otherwise
  // came from an older build
  if (state.ui.trainMode && state.ui.learnMode) update('ui.learnMode', false);
}

export async function restoreComposition() {
  try {
    const composition = await loadWorkingComposition();
    if (!composition) return false;
    Object.assign(state.composition, composition);
    return true;
  } catch {
    // A composition that will not load is not worth blocking start-up over
    return false;
  }
}

// ── Save, as things change ───────────────────────────────────────────────────

let timer = null;

function saveSettings() {
  const out = {};
  for (const path of Object.keys(SETTINGS)) out[path] = readPath(path);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
  } catch { /* storage full or blocked; this session still works */ }
}

function flush() {
  clearTimeout(timer);
  timer = null;
  saveSettings();
  saveWorkingComposition(state.composition).catch(() => {});
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
}

export function initSession() {
  on('transport:noteschanged', schedule);
  on('change', ({ path }) => {
    if (SETTINGS[path] || path.startsWith('composition.')) schedule();
  });

  // Debouncing means the last few hundred milliseconds are still pending when
  // a tab goes away. Settings can be written synchronously on the way out;
  // the composition write is started here and usually lands, which is the best
  // IndexedDB offers from an unload.
  const onLeaving = () => { if (timer) flush(); };
  window.addEventListener('pagehide', onLeaving);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeaving();
  });
}
