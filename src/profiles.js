// Profiles: who is practising, and how far they have got.
//
// A profile carries the two things that are personal rather than part of the
// music — which section of the piece they are working through, and how fast
// they have got each section up to. The song itself is the same for everyone.
//
// Profiles live in the browser. A folder on disk can be configured as well, and
// then a profile can be written out and read back — but the browser is where
// the app looks first, because a folder needs permission the app may not have.
import { emit } from './state.js';

const STORE_KEY = 'miditrain.profiles';
const HANDLE_DB = 'miditrain-folder';
const HANDLE_KEY = 'folder';

// Training a section for the first time starts here. Slow enough to get the
// notes right, and the retry buttons are how it goes up from there.
export const DEFAULT_TRAIN_BPM = 60;

export const FILE_FORMAT = 'miditrain.profile';
const FILE_VERSION = 1;

let profiles = [];
let currentId = null;

// How many personal bests one profile keeps. They live in localStorage
// alongside everything else, and each one carries the take that earned it, so
// this is the thing that could fill it. Past the cap the oldest go.
const MAX_BESTS = 120;
// ...and one take is capped too, so a best set on a very long piece cannot
// crowd out every other one. A run longer than this keeps its score and loses
// its replay rather than not being recorded.
const MAX_TAKE_NOTES = 500;

function blank(name) {
  return {
    id: crypto.randomUUID(),
    name,
    updatedAt: Date.now(),
    // Where they were: the piece, how it was divided, and which section
    learning: null,
    // BPM last trained at, per section
    sectionTempos: {},
    // The best run of each passage, at each hand setting and each speed —
    // see "What counts as the same thing" below
    bests: {},
  };
}

// A stored profile is untrusted — hand-edited, or from a file someone sent.
// Anything unrecognisable is replaced rather than trusted.
function sanitise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : null;
  if (!name) return null;

  const tempos = {};
  if (raw.sectionTempos && typeof raw.sectionTempos === 'object') {
    for (const [key, value] of Object.entries(raw.sectionTempos)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        tempos[String(key).slice(0, 200)] = Math.min(300, Math.max(20, Math.round(value)));
      }
    }
  }

  const l = raw.learning;
  const learning = l && typeof l === 'object' && typeof l.songName === 'string'
    ? {
        songName: l.songName.slice(0, 120),
        sectionBars: [0, 2, 4, 8].includes(l.sectionBars) ? l.sectionBars : 0,
        sectionIndex: Number.isFinite(l.sectionIndex) ? Math.max(0, Math.round(l.sectionIndex)) : 0,
      }
    : null;

  return {
    id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
    name,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    learning,
    sectionTempos: tempos,
    bests: sanitiseBests(raw.bests),
  };
}

const int = (v, lo, hi, fallback) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
const GRADES = ['perfect', 'good', 'almost', 'miss'];

// A stored take goes back onto the falling-notes canvas and into the player, so
// it is read as strictly as an imported file: every field bounded, anything
// unrecognisable dropped. A best whose take will not validate keeps its score.
function sanitiseTake(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.notes)) return null;
  if (raw.notes.length > MAX_TAKE_NOTES) return null;
  const notes = raw.notes
    .filter(n => n && Number.isFinite(n.pitch) && Number.isFinite(n.startTime))
    .map((n, i) => ({
      id: `take-${i}`,
      pitch: int(n.pitch, 21, 108, 60),
      velocity: int(n.velocity, 1, 127, 90),
      startTime: Math.max(0, n.startTime),
      duration: Math.max(1, Number.isFinite(n.duration) ? n.duration : 200),
      matched: n.matched === true,
      stray: n.stray === true,
      after: n.after === true,
    }));
  if (!notes.length) return null;

  const expected = (Array.isArray(raw.expected) ? raw.expected : [])
    .filter(n => n && Number.isFinite(n.pitch) && Number.isFinite(n.startTime))
    .slice(0, MAX_TAKE_NOTES)
    .map(n => ({
      pitch: int(n.pitch, 21, 108, 60),
      startTime: Math.max(0, n.startTime),
      grade: GRADES.includes(n.grade) ? n.grade : 'miss',
    }));

  // Kept whole, tail and all, so a take read back off disk is the same shape as
  // one still in memory and the replay cannot come to depend on which it got
  const r = raw.range;
  const range = r && Number.isFinite(r.startMs) && Number.isFinite(r.endMs)
    ? {
        startMs: Math.max(0, r.startMs),
        endMs: Math.max(0, r.endMs),
        tailMs: int(r.tailMs, 0, 60000, 0),
      }
    : null;

  return { range, notes, expected };
}

function sanitiseBests(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || !Number.isFinite(value.score)) continue;
    out[String(key).slice(0, 240)] = {
      score: int(value.score, 0, 100, 0),
      perfect: int(value.perfect, 0, 1e6, 0),
      good: int(value.good, 0, 1e6, 0),
      almost: int(value.almost, 0, 1e6, 0),
      missed: int(value.missed, 0, 1e6, 0),
      extra: int(value.extra, 0, 1e6, 0),
      total: int(value.total, 0, 1e6, 0),
      avgLatencyMs: int(value.avgLatencyMs, 0, 100000, 0),
      // The composition tempo the run was played at. The take's times are in
      // milliseconds against that tempo, so replaying it against the piece at
      // some other tempo needs them scaled — which is only possible if the
      // tempo they were written at is kept with them.
      tempo: int(value.tempo, 20, 300, 120),
      at: Number.isFinite(value.at) ? value.at : Date.now(),
      take: sanitiseTake(value.take),
    };
  }
  return capBests(out);
}

// Oldest out first when the cap is reached
function capBests(bests) {
  const keys = Object.keys(bests);
  if (keys.length <= MAX_BESTS) return bests;
  keys.sort((a, b) => bests[b].at - bests[a].at);
  return Object.fromEntries(keys.slice(0, MAX_BESTS).map(k => [k, bests[k]]));
}

// ── Browser store ────────────────────────────────────────────────────────────

export function loadProfiles() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY));
  } catch { /* fall through to the default */ }

  profiles = Array.isArray(saved?.list) ? saved.list.map(sanitise).filter(Boolean) : [];
  // There is always one to be using
  if (!profiles.length) profiles = [blank('Default')];

  currentId = profiles.some(p => p.id === saved?.current) ? saved.current : profiles[0].id;
  return current();
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ current: currentId, list: profiles }));
  } catch { /* storage full or blocked; this session still works */ }
  emit('profiles:changed', { profiles: listProfiles(), current: current() });
}

export function listProfiles() {
  return profiles.map(p => ({ id: p.id, name: p.name, updatedAt: p.updatedAt }));
}

export function current() {
  return profiles.find(p => p.id === currentId) || profiles[0];
}

export function switchProfile(id) {
  if (!profiles.some(p => p.id === id)) return false;
  currentId = id;
  persist();
  return true;
}

export function createProfile(name) {
  const profile = blank((name || '').trim() || `Profile ${profiles.length + 1}`);
  profiles.push(profile);
  currentId = profile.id;
  persist();
  return profile;
}

export function renameProfile(id, name) {
  const profile = profiles.find(p => p.id === id);
  if (!profile || !name.trim()) return;
  profile.name = name.trim().slice(0, 60);
  profile.updatedAt = Date.now();
  persist();
}

export function deleteProfile(id) {
  if (profiles.length <= 1) return false;   // there is always one
  profiles = profiles.filter(p => p.id !== id);
  if (currentId === id) currentId = profiles[0].id;
  persist();
  return true;
}

// Merge one in from a file, replacing a profile of the same id
export function adoptProfile(raw) {
  const profile = sanitise(raw);
  if (!profile) return null;
  const at = profiles.findIndex(p => p.id === profile.id);
  if (at === -1) profiles.push(profile);
  else profiles[at] = profile;
  persist();
  return profile;
}

// ── What a profile remembers ─────────────────────────────────────────────────

export function sectionKey(songName, sectionBars, section) {
  return `${songName || 'Untitled'}|${sectionBars}|${section.startBar}-${section.endBar}`;
}

export function sectionTempo(key) {
  return current().sectionTempos[key] ?? DEFAULT_TRAIN_BPM;
}

export function rememberSectionTempo(key, bpm) {
  const profile = current();
  const rounded = Math.min(300, Math.max(20, Math.round(bpm)));
  if (profile.sectionTempos[key] === rounded) return;
  profile.sectionTempos[key] = rounded;
  profile.updatedAt = Date.now();
  persist();
}

// ── Personal bests ───────────────────────────────────────────────────────────
//
// What counts as the same thing, and therefore as a best to beat:
//
//   the piece · the bars · which hand · how fast
//
// All four have to be in the key. The same eight bars right-hand-only and
// hands-together are two different exercises and always were, and a run at 60
// BPM says nothing about a run at 110 — a personal best that quietly compared
// them would go up when the tempo came down, which is the opposite of progress.
//
// Speed is the tempo the notes were written at multiplied by the speed slider,
// because that is the rate they actually arrived at. Two ways of reaching 90
// BPM are the same 90 BPM to the fingers.
export function trainingKey({ songName, bars, hand, bpm }) {
  const where = bars ? `${bars.startBar}-${bars.endBar}` : 'all';
  return `${songName || 'Untitled'}|${where}|${hand || 'both'}|${Math.round(bpm)}`;
}

export function bestFor(key) {
  return current().bests?.[key] || null;
}

// Records the run when it beats what is there, and says whether it did. A run
// that ties does not replace the one that stands — the earlier one got there
// first, and its take is the one already familiar.
export function rememberBest(key, run) {
  if (!key || !Number.isFinite(run?.score)) return false;
  const profile = current();
  if (!profile.bests) profile.bests = {};
  const standing = profile.bests[key];
  if (standing && standing.score >= run.score) return false;

  profile.bests[key] = {
    score: Math.round(run.score),
    perfect: run.perfect | 0,
    good: run.good | 0,
    almost: run.almost | 0,
    missed: run.missed | 0,
    extra: run.extra | 0,
    total: run.total | 0,
    avgLatencyMs: run.avgLatencyMs | 0,
    tempo: Math.round(run.tempo || 120),
    at: Date.now(),
    // A run too long to keep still counts; it just cannot be played back
    take: run.take && run.take.notes.length <= MAX_TAKE_NOTES ? run.take : null,
  };
  profile.bests = capBests(profile.bests);
  profile.updatedAt = Date.now();
  persist();
  return true;
}

export function setLearningPosition(position) {
  const profile = current();
  profile.learning = position;
  profile.updatedAt = Date.now();
  persist();
}

export function learningPosition() {
  return current().learning;
}

// ── The folder on disk ───────────────────────────────────────────────────────
// A browser cannot be handed a path; it can only be given a folder the user
// picks, and remember it afterwards. That handle is what "a configured path"
// means here. Where the API is missing the same files still work — they are
// just downloaded and picked back up by hand.

export function canUseFolder() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function handleStore() {
  return localforage.createInstance({ name: HANDLE_DB, storeName: 'handles' });
}

export async function chooseFolder() {
  const handle = await window.showDirectoryPicker({ id: 'miditrain-profiles', mode: 'readwrite' });
  await handleStore().setItem(HANDLE_KEY, handle);
  return handle;
}

export async function folderHandle({ prompt = false } = {}) {
  let handle;
  try {
    handle = await handleStore().getItem(HANDLE_KEY);
  } catch { return null; }
  if (!handle) return null;

  // A handle survives a reload but its permission does not always come with it
  const options = { mode: 'readwrite' };
  let permission = await handle.queryPermission?.(options);
  if (permission !== 'granted' && prompt) permission = await handle.requestPermission?.(options);
  return permission === 'granted' ? handle : null;
}

export async function forgetFolder() {
  try { await handleStore().removeItem(HANDLE_KEY); } catch { /* nothing to forget */ }
}

export function fileNameFor(profile) {
  const safe = profile.name.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-') || 'profile';
  return `${safe}.miditrain.json`;
}

export function bundleToJSON(bundle) {
  return JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, savedAt: new Date().toISOString(), ...bundle }, null, 2);
}

export function bundleFromJSON(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file');
  }
  if (!parsed || parsed.format !== FILE_FORMAT) throw new Error('Not a MidiTrain profile file');
  if (!sanitise(parsed.profile)) throw new Error('No profile in this file');
  return parsed;
}

export async function writeToFolder(handle, filename, text) {
  const file = await handle.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(text);
  await writable.close();
}

// Every profile file the folder holds, read and validated
export async function scanFolder(handle) {
  const found = [];
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.miditrain.json')) continue;
    try {
      const text = await (await entry.getFile()).text();
      const bundle = bundleFromJSON(text);
      found.push({ filename: entry.name, bundle });
    } catch { /* not one of ours, or damaged — leave it alone */ }
  }
  return found;
}
