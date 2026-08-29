// The tracks a MIDI file was written in.
//
// A Standard MIDI File is a stack of parallel tracks, and the app used to throw
// that away the moment it read one: every note went into one list, and the only
// thing kept from the track it came from was a guess at which hand it belonged
// to. That is right for a two-track piano score and wrong for everything else.
// A lead sheet with melody, chords and bass, or an arrangement with a part you
// want to hear but not play yet, has no way to say so.
//
// So the tracks survive the import, and each one carries the four things a
// player actually wants to set: whether it sounds at all, what colour its notes
// fall in, which hand it is for, and what it is called.
//
// The notes stay in one list. A track is a label on them — `note.trackId` —
// rather than a container, because every other part of the app already works on
// one flat list ordered by time, and splitting that would touch all of it.
import { state, emit } from './state.js';

// Colours for falling notes when a track is given one of its own. Chosen to sit
// apart from each other at a glance and to stay legible on the dark stage.
//
// The greens and the yellow are last on purpose: training recolours a note as
// it is graded, green for a hit and yellow for almost, so a track wearing one
// of those reads as a grade until the eye adjusts. They are still offered —
// somebody arranging four parts needs four colours more than they need that
// distinction — but they are not what a track gets by default.
export const TRACK_PALETTE = [
  { hex: '#3d8bfd', name: 'Blue' },
  { hex: '#f472b6', name: 'Pink' },
  { hex: '#f59e0b', name: 'Amber' },
  { hex: '#a855f7', name: 'Violet' },
  { hex: '#06b6d4', name: 'Cyan' },
  { hex: '#ef4444', name: 'Red' },
  { hex: '#84cc16', name: 'Lime' },
  { hex: '#22c55e', name: 'Green' },
  { hex: '#eab308', name: 'Yellow' },
];

// Below this a file is a piano score, and colouring its two tracks apart would
// replace the hand colouring — which says the same thing, and says it in the
// colours the player already knows. At three parts the hands stop being what
// the tracks are about, so they take a colour each.
const COLOR_FROM = 3;

export const TRACK_HANDS = ['auto', 'left', 'right'];

// Rebuilt whenever the track list is replaced. Falling notes ask this per note
// per frame, and a linear scan through the list would be the only lookup in
// that loop that grows with the file.
let index = { source: null, byId: new Map() };

function trackIndex() {
  const tracks = state.composition.tracks;
  if (index.source !== tracks) {
    index = { source: tracks, byId: new Map((tracks || []).map(t => [t.id, t])) };
  }
  return index.byId;
}

export function trackList() {
  return state.composition.tracks || [];
}

// Whether there is anything here worth showing a player. One track is the
// ordinary case — a recording, a generated exercise, a format-0 file — and a
// list with one row in it is a control that can only ever say the same thing.
export function hasTracks() {
  return trackList().length > 1;
}

export function trackFor(note) {
  if (!note || note.trackId === undefined) return null;
  return trackIndex().get(note.trackId) || null;
}

// Silenced tracks are not merely muted: they are not drawn, not trained on and
// not waited for in learn mode either. Switching a part off means "I am not
// working on this yet", and a part you are not working on should not be able to
// cost you a score.
export function isAudible(note) {
  const track = trackFor(note);
  return !track || track.enabled !== false;
}

// The hand a track has been put in, if it has been put in one. Null means the
// texture decides, which is what `hands.js` does with everything else.
export function trackHand(note) {
  const hand = trackFor(note)?.hand;
  return hand === 'left' || hand === 'right' ? hand : null;
}

export function trackColor(note) {
  return trackFor(note)?.color || null;
}

const clean = (name, fallback) => {
  const text = typeof name === 'string' ? name.trim().slice(0, 60) : '';
  return text || fallback;
};

// Build the list the app will hold, from whatever the reader found. Also the
// validator for a saved file: a colour that is not a colour, or a hand that is
// not a hand, is dropped rather than being allowed through to the canvas.
export function normalizeTracks(tracks, notes) {
  if (!Array.isArray(tracks)) return [];
  const used = new Set(notes.map(n => n.trackId).filter(id => id !== undefined));
  const kept = [];
  for (const t of tracks) {
    if (!t || t.id === undefined || !used.has(t.id)) continue;    // a track with no notes is not a part
    if (kept.some(k => k.id === t.id)) continue;
    const hand = TRACK_HANDS.includes(t.hand) ? t.hand : 'auto';
    kept.push({
      id: t.id,
      name: clean(t.name, `Track ${kept.length + 1}`),
      enabled: t.enabled !== false,
      color: /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : null,
      hand: hand === 'auto' ? 'auto' : hand,
    });
  }
  // Everything but the colours comes from the file. Colours are the app's to
  // choose, and only worth choosing once there are enough parts to need them.
  if (kept.length >= COLOR_FROM) {
    kept.forEach((t, i) => { if (!t.color) t.color = TRACK_PALETTE[i % TRACK_PALETTE.length].hex; });
  }
  return kept;
}

// One field of one track. Returns whether anything actually changed, so a
// colour picker dragging through a dozen values does not redraw the score a
// dozen times over.
export function updateTrack(id, patch) {
  const track = trackList().find(t => t.id === id);
  if (!track) return false;
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (track[key] === value) continue;
    track[key] = value;
    changed = true;
  }
  if (changed) emit('tracks:changed', trackList());
  return changed;
}

export function setAllEnabled(enabled) {
  let changed = false;
  for (const track of trackList()) {
    if (track.enabled === enabled) continue;
    track.enabled = enabled;
    changed = true;
  }
  if (changed) emit('tracks:changed', trackList());
  return changed;
}

// How many of a track's notes are in the piece, for the list to show. Counted
// on demand rather than stored, because editing changes it and a stored count
// would be one more thing that can go stale.
export function noteCounts() {
  const counts = new Map();
  for (const note of state.composition.notes) {
    if (note.trackId === undefined) continue;
    counts.set(note.trackId, (counts.get(note.trackId) || 0) + 1);
  }
  return counts;
}
