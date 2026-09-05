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
import { starsFromCounts } from './accuracy.js';
import { CALIBRATION_LEVELS, calibrationIsUsable } from './dynamics.js';

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
    // The file this profile lives in. Recorded rather than worked out from the
    // name every time, so that renaming can move the file rather than orphan
    // it, and so two profiles whose names look alike cannot end up sharing one.
    filename: null,
    // Where this player's soft, ordinary and loud sit on their own keyboard.
    // Belongs to the person, not to the app, which is why it lives here and
    // travels with the profile file.
    calibration: null,
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
    filename: typeof raw.filename === 'string' && raw.filename.endsWith(FILE_SUFFIX)
      ? raw.filename.slice(0, 120)
      : null,
    calibration: sanitiseCalibration(raw.calibration),
  };
}

// A calibration decides how hard a player is judged to have struck every note,
// so a hand-edited or damaged one is dropped rather than half-trusted. Anything
// that does not describe three levels in order is not a calibration at all —
// see `calibrationIsUsable`, which is the same rule the capture screen applies
// before it will store one.
function sanitiseCalibration(raw) {
  if (!raw || typeof raw !== 'object' || !raw.anchors || typeof raw.anchors !== 'object') return null;
  const anchors = {};
  for (const { key } of CALIBRATION_LEVELS) {
    const level = raw.anchors[key];
    if (!level || typeof level !== 'object' || !Number.isFinite(level.velocity)) return null;
    anchors[key] = {
      velocity: int(level.velocity, 1, 127, 64),
      spread: int(level.spread, 0, 64, 6),
    };
  }
  if (!calibrationIsUsable(anchors)) return null;
  return {
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
    // Which controller it was measured on, so a different one can be noticed
    inputId: typeof raw.inputId === 'string' ? raw.inputId.slice(0, 200) : null,
    inputName: typeof raw.inputName === 'string' ? raw.inputName.slice(0, 120) : null,
    anchors,
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
    // Field for field, and in the same order, as what `rememberBest` writes —
    // so a record read back off disk is indistinguishable from the one that was
    // just put there, down to the shape
    const counts = {
      perfect: int(value.perfect, 0, 1e6, 0),
      good: int(value.good, 0, 1e6, 0),
      almost: int(value.almost, 0, 1e6, 0),
      missed: int(value.missed, 0, 1e6, 0),
      extra: int(value.extra, 0, 1e6, 0),
      total: int(value.total, 0, 1e6, 0),
    };
    out[String(key).slice(0, 240)] = {
      score: int(value.score, 0, 100, 0),
      // A record written before the stars existed has none. It is worked out
      // here from the tallies it does have — which is exactly what the rating
      // is made of — rather than left empty.
      //
      // Left empty it was unbeatable. Two records can only be compared on stars
      // when both have them, so one without fell back to the percentage, and a
      // percentage already at a hundred can never be improved on: every later
      // run tied it and stood down, however much better it actually was. The
      // player watched their stars climb and their best sit still.
      stars: Number.isFinite(value.stars)
        ? Math.min(10, Math.max(0, Math.round(value.stars * 4) / 4))
        : (counts.total ? starsFromCounts(counts) : null),
      ...counts,
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
  if (settleFileNames()) persist();
  return current();
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ current: currentId, list: profiles }));
  } catch { /* storage full or blocked; this session still works */ }
  emit('profiles:changed', { profiles: listProfiles(), current: current() });
}

export function listProfiles() {
  return profiles.map(p => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, filename: fileNameFor(p) }));
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
  profile.filename = claimFileName(profile);
  profiles.push(profile);
  currentId = profile.id;
  persist();
  return profile;
}

// Renaming moves the file too, so the folder keeps reading like the list of
// profiles rather than like a history of what they used to be called. The old
// and new names are handed back because only the caller has the folder — and
// only it can delete the file the profile has just stopped living in.
export function renameProfile(id, name) {
  const profile = profiles.find(p => p.id === id);
  if (!profile || !name.trim()) return null;
  const from = fileNameFor(profile);
  profile.name = name.trim().slice(0, 60);
  profile.filename = claimFileName(profile);
  profile.updatedAt = Date.now();
  persist();
  return { from, to: profile.filename, profile };
}

// Hands back the file the deleted profile was living in, so it can be taken off
// disk as well. A file left behind is not merely clutter: the next folder scan
// would read it and bring the deleted profile back.
export function deleteProfile(id) {
  if (profiles.length <= 1) return null;   // there is always one
  const going = profiles.find(p => p.id === id);
  if (!going) return null;
  profiles = profiles.filter(p => p.id !== id);
  if (currentId === id) currentId = profiles[0].id;
  persist();
  return fileNameFor(going);
}

// Merge one in from a file, replacing a profile of the same id.
//
// The file it arrived in is where it goes on living — that is what makes a scan
// idempotent rather than a way of accumulating copies. But a file someone sent
// may be named the same as a file already here, and then the newcomer is the
// one that moves.
export function adoptProfile(raw) {
  const profile = sanitise(raw);
  if (!profile) return null;
  const at = profiles.findIndex(p => p.id === profile.id);
  const others = profiles.filter(p => p.id !== profile.id);
  if (!profile.filename || others.some(p => p.filename === profile.filename)) {
    profile.filename = claimFileName(profile, others);
  }
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

// The key read back apart again, for listing what a profile has achieved.
//
// Split from the right. A song may have a bar in its name — "Prelude | No. 2"
// is a filename somebody will type sooner or later — and only the last three
// fields are known to be free of one, so the song is whatever is left after
// they are taken off the end.
export function parseTrainingKey(key) {
  const parts = String(key).split('|');
  if (parts.length < 4) return null;
  const bpm = Number(parts.pop());
  const hand = parts.pop();
  const bars = parts.pop();
  if (!Number.isFinite(bpm) || !parts.length) return null;
  return { songName: parts.join('|'), bars, hand, bpm };
}

export function bestFor(key) {
  return current().bests?.[key] || null;
}

// Everything a profile has to show for itself, as a tree: the piece, then which
// hand it was practised with, then how fast. Sorted at every level, because a
// list of achievements that reorders itself between visits is hard to read
// against last time.
const HAND_ORDER = { both: 0, left: 1, right: 2 };

export function bestsTree(profile = current()) {
  const songs = new Map();
  for (const [key, run] of Object.entries(profile.bests || {})) {
    const at = parseTrainingKey(key);
    if (!at) continue;
    const hands = songs.get(at.songName) || new Map();
    const speeds = hands.get(at.hand) || new Map();
    const runs = speeds.get(at.bpm) || [];
    runs.push({ key, bars: at.bars, ...run });
    speeds.set(at.bpm, runs);
    hands.set(at.hand, speeds);
    songs.set(at.songName, hands);
  }

  const barsOrder = (a, b) =>
    (parseInt(a.bars, 10) || 0) - (parseInt(b.bars, 10) || 0) || a.bars.localeCompare(b.bars);

  return [...songs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([songName, hands]) => ({
      songName,
      hands: [...hands.entries()]
        .sort(([a], [b]) => (HAND_ORDER[a] ?? 9) - (HAND_ORDER[b] ?? 9))
        .map(([hand, speeds]) => ({
          hand,
          speeds: [...speeds.entries()]
            .sort(([a], [b]) => a - b)
            .map(([bpm, runs]) => ({ bpm, runs: runs.sort(barsOrder) })),
        })),
    }));
}

// Which of two runs is the better one.
//
// The stars decide, and the percentage only breaks their ties — because the two
// can genuinely disagree, and the stars are what the screen leads with.
//
// They disagree because the percentage treats a note played inside fifty
// milliseconds and one played inside a hundred and fifty as the same thing,
// and the stars do not. So a run that is entirely "good" takes a hundred per
// cent with seven and a half stars, while one that is mostly "perfect" with a
// couple of misses takes eighty per cent with eight. Ranking those by
// percentage put the looser run on top and then showed the player their star
// count going down as they "improved", which is not a tuning problem: any
// rating that separates perfect from good will invert against a score that
// does not.
//
// A record written before the stars existed has none, and one cannot be
// inferred from its score for exactly that reason. Those fall back to the
// percentage rather than being written off.
function beats(run, standing) {
  // A record with no stars and no tallies to work them out from cannot be rated
  // at all. It yields to one that can be, as soon as it is matched, rather than
  // standing for ever on a percentage that has nothing above it to beat.
  if (standing.stars == null) return run.score >= standing.score;
  if (run.stars == null) return run.score > standing.score;
  return run.stars !== standing.stars ? run.stars > standing.stars : run.score > standing.score;
}

// Records the run when it beats what is there, and says whether it did. A run
// that ties does not replace the one that stands — the earlier one got there
// first, and its take is the one already familiar.
export function rememberBest(key, run) {
  if (!key || !Number.isFinite(run?.score)) return false;
  const profile = current();
  if (!profile.bests) profile.bests = {};
  const standing = profile.bests[key];
  if (standing && !beats(run, standing)) return false;

  profile.bests[key] = {
    score: Math.round(run.score),
    stars: Number.isFinite(run.stars) ? run.stars : null,
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

// ── Calibration ──────────────────────────────────────────────────────────────
// Measured once per player per keyboard, and read at the start of every run
// that is being graded on dynamics.

export function calibrationOf(profile = current()) {
  return profile?.calibration ?? null;
}

export function setCalibration(calibration) {
  const profile = current();
  profile.calibration = calibration ? sanitiseCalibration(calibration) : null;
  profile.updatedAt = Date.now();
  persist();
  return profile.calibration;
}

// Whether the keyboard being played now is the one the calibration was taken
// on. A different controller has a different curve, and a calibration is a
// measurement of a curve — so this is worth saying out loud.
//
// Only a *changed* device can be noticed. The same keyboard with its velocity
// curve switched over in its own settings sends different numbers for the same
// gesture and looks identical from here, which is why the capture screen says
// so in as many words rather than relying on this.
export function calibrationMatchesInput(inputs, calibration = calibrationOf()) {
  if (!calibration?.inputId) return true;   // nothing recorded to disagree with
  const live = (inputs || []).filter(i => i.state === 'connected' && i.enabled);
  if (!live.length) return true;            // nothing plugged in to disagree either
  return live.some(i => i.id === calibration.inputId);
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

// The folder as chosen, without asking whether it can still be written to.
//
// Those are two different questions and the answers come apart: a folder chosen
// last week is still chosen after a refresh, but the permission to write to it
// usually is not — the browser drops that on every page load unless the player
// answered its prompt with "allow on every visit". Code that only asks
// `folderHandle()` cannot tell "no folder" from "a folder we may not touch yet",
// and told the player to go and choose one they had already chosen.
export async function storedFolder() {
  try {
    return (await handleStore().getItem(HANDLE_KEY)) || null;
  } catch {
    return null;
  }
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

const FILE_SUFFIX = '.miditrain.json';

const readableName = (label) =>
  label.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-') || 'profile';

// What a profile's file is called.
//
// The readable part is the profile's own name, which is the point of it — a
// folder of these should be legible without opening any of them. But a name is
// not unique and the sanitising makes it less so: "Anna B." and "Anna B" and
// "Anna  B" all reduce to the same thing, and a profile whose name is entirely
// punctuation or entirely non-Latin reduces to "profile". Two of those pointed
// at one file, and creating the second silently wrote over the first — its
// bests, gone, with nothing said.
//
// So the name is claimed once, against the names every other profile has
// claimed, and a short piece of the profile's own id settles any argument. The
// common case keeps the plain readable name it always had; only a genuine
// clash gets the suffix.
export function claimFileName(profile, others = profiles) {
  const base = readableName(profile.name);
  const taken = new Set(others
    .filter(p => p.id !== profile.id && p.filename)
    .map(p => p.filename));
  const plain = `${base}${FILE_SUFFIX}`;
  if (!taken.has(plain)) return plain;
  // Six characters of a UUID settle every argument anybody will actually have.
  // Growing the slice is for the argument nobody will: two ids alike for six
  // characters still differ by the whole of them, so this always terminates.
  for (let len = 6; len < profile.id.length; len++) {
    const tagged = `${base}.${profile.id.slice(0, len)}${FILE_SUFFIX}`;
    if (!taken.has(tagged)) return tagged;
  }
  return `${base}.${profile.id}${FILE_SUFFIX}`;
}

// A profile that never went through the store — one still inside a bundle being
// read — keeps the name it would have had, so its file is found rather than
// left behind. Everything in the store has claimed a file of its own.
export function fileNameFor(profile) {
  return profile.filename || `${readableName(profile.name)}${FILE_SUFFIX}`;
}

// Nothing in the store may be without a file: not the "Default" profile the app
// makes for itself before anyone has chosen a folder, and not the profiles made
// before a profile recorded where it lived. Claimed in list order, so anything
// already settled keeps its file and the newcomers work around it.
function settleFileNames() {
  let changed = false;
  for (const profile of profiles) {
    if (profile.filename) continue;
    profile.filename = claimFileName(profile);
    changed = true;
  }
  return changed;
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

// Renaming a profile moves its file rather than leaving the old one behind, and
// deleting a profile takes its file with it — otherwise the next folder scan
// would bring the deleted one back.
export async function removeFromFolder(handle, filename) {
  try {
    await handle.removeEntry(filename);
    return true;
  } catch {
    return false;   // already gone, or never written
  }
}

export async function readFromFolder(handle, filename) {
  try {
    const file = await handle.getFileHandle(filename);
    return bundleFromJSON(await (await file.getFile()).text());
  } catch {
    return null;   // nothing written there yet, or not one of ours
  }
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
    if (entry.kind !== 'file' || !entry.name.endsWith(FILE_SUFFIX)) continue;
    try {
      const text = await (await entry.getFile()).text();
      const bundle = bundleFromJSON(text);
      // The file it was found in is where it belongs from now on
      if (bundle.profile) bundle.profile.filename = entry.name;
      found.push({ filename: entry.name, bundle });
    } catch { /* not one of ours, or damaged — leave it alone */ }
  }
  return found;
}
