// IndexedDB persistence via localforage

let store;
let workingStore;

function getStore() {
  if (!store) {
    store = localforage.createInstance({ name: 'miditrain', storeName: 'compositions' });
  }
  return store;
}

// The working composition lives in its own store rather than alongside the
// saved ones. It is whatever the app happened to have open, not something the
// user chose to keep, and it must not turn up in the Open browser.
function getWorkingStore() {
  if (!workingStore) {
    workingStore = localforage.createInstance({ name: 'miditrain', storeName: 'session' });
  }
  return workingStore;
}

const WORKING_KEY = 'working';

export async function saveComposition(composition) {
  const id = composition.id || crypto.randomUUID();
  const data = { ...composition, id, updatedAt: Date.now(), createdAt: composition.createdAt || Date.now() };
  await getStore().setItem(id, data);
  return data;
}

export async function loadComposition(id) {
  return getStore().getItem(id);
}

export async function listCompositions() {
  const items = [];
  await getStore().iterate(value => { items.push(value); });
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteComposition(id) {
  await getStore().removeItem(id);
}

// ── JSON export / import ─────────────────────────────────────────────────────
// Browser storage is per-origin and browsers evict it, so a composition needs
// a way out of the app that the user actually holds.

const FILE_FORMAT = 'miditrain.composition';
const FILE_VERSION = 1;

export function compositionToJSON(composition) {
  const { name, tempo, timeSignature, keySignature, notes } = composition;
  return JSON.stringify({
    format: FILE_FORMAT,
    version: FILE_VERSION,
    exportedAt: new Date().toISOString(),
    composition: {
      name: name || 'Untitled',
      tempo,
      timeSignature,
      keySignature,
      notes: notes.map(n => ({
        id: n.id,
        pitch: n.pitch,
        velocity: n.velocity,
        startTime: n.startTime,
        duration: n.duration,
        // Only when the source actually said so — an inferred hand is derived
        // from the notes and would go stale the moment they are edited
        ...(n.hand ? { hand: n.hand } : {}),
      })),
    },
  }, null, 2);
}

// Stored as the export format, so restoring runs the same validation an
// imported file gets — browser storage can be stale, half-written or left over
// from an older version of the app, and none of that should load over the top
// of a working state the app has no code for.
export async function saveWorkingComposition(composition) {
  await getWorkingStore().setItem(WORKING_KEY, {
    id: composition.id || null,
    json: compositionToJSON(composition),
  });
}

export async function loadWorkingComposition() {
  const saved = await getWorkingStore().getItem(WORKING_KEY);
  if (!saved || typeof saved.json !== 'string') return null;
  const composition = compositionFromJSON(saved.json);
  // Unlike an import, this keeps its identity: Save should still update the
  // record it came from rather than making a second copy
  composition.id = typeof saved.id === 'string' ? saved.id : null;
  return composition;
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// Throws with a message worth showing the user. Never returns a partly-valid
// composition — a malformed file must not be able to half-load over their work.
export function compositionFromJSON(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file');
  }

  const src = parsed && parsed.composition ? parsed.composition : parsed;
  if (!src || typeof src !== 'object') throw new Error('No composition in this file');
  if (parsed.format && parsed.format !== FILE_FORMAT) {
    throw new Error('This JSON is not a MidiTrain composition');
  }
  if (!Array.isArray(src.notes)) throw new Error('No notes in this file');

  const notes = src.notes
    .filter(n => n && isFiniteNumber(n.pitch) && isFiniteNumber(n.startTime) && isFiniteNumber(n.duration))
    .map(n => ({
      id: typeof n.id === 'string' ? n.id : crypto.randomUUID(),
      pitch: Math.round(Math.min(108, Math.max(21, n.pitch))),
      velocity: isFiniteNumber(n.velocity) ? Math.round(Math.min(127, Math.max(1, n.velocity))) : 90,
      startTime: Math.max(0, n.startTime),
      duration: Math.max(1, n.duration),
      ...(n.hand === 'left' || n.hand === 'right' ? { hand: n.hand } : {}),
    }))
    .sort((a, b) => a.startTime - b.startTime);

  if (src.notes.length && !notes.length) throw new Error('No usable notes in this file');

  const num = src.timeSignature?.numerator;
  const den = src.timeSignature?.denominator;

  return {
    // No id: an imported file lands as a new composition rather than
    // overwriting whatever it was exported from
    id: null,
    name: typeof src.name === 'string' && src.name.trim() ? src.name.trim() : 'Imported',
    tempo: isFiniteNumber(src.tempo) ? Math.min(300, Math.max(20, Math.round(src.tempo))) : 120,
    timeSignature: {
      numerator: isFiniteNumber(num) ? num : 4,
      denominator: isFiniteNumber(den) ? den : 4,
    },
    keySignature: typeof src.keySignature === 'string' ? src.keySignature : 'C',
    notes,
  };
}
