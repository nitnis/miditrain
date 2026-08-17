// Central application state and event bus

const _state = {
  composition: {
    id: null,
    name: 'Untitled',
    tempo: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    keySignature: 'C',
    notes: [], // NoteEvent[]
  },
  transport: {
    mode: 'stopped', // 'stopped' | 'playing' | 'recording' | 'step-recording' | 'count-in' | 'learning'
    currentTime: 0,  // ms from composition start
    loopEnabled: false,
    loopStartBar: 1,
    loopEndBar: 4,
    speed: 1.0,
  },
  midi: {
    available: false,
    connected: false,
    inputs: [],
    activeNotes: new Set(), // currently held pitches
  },
  ui: {
    view: 'sheet',          // 'sheet' | 'piano-roll' | 'split'
    trainMode: false,
    learnMode: false,       // wait at each note until it is played
    learnSectionBars: 0,    // 0 = learn the whole piece, otherwise section size
    learnCluster: 'off',    // how much is learned at once: 'off' is note by note
    recordHand: 'auto',     // 'auto' | 'left' | 'right' — the hand new notes are written to
    practiceHand: 'both',   // 'both' | 'left' | 'right' — the hand train and learn work on
    metronomeEnabled: false,
    metronomeSubdivision: 1, // clicks per beat: 1 beat only, 2 eighths, 3 triplets, 4 sixteenths
    showBeatOverlay: true,  // the beat counter over the falling notes, seen without being heard
    showChordOverlay: true, // the name of the chord under the playhead
    muted: false,           // master audio mute; audible by default
    volume: 1,              // 0..1, applied at the master gain
    clicksOnly: false,      // silence the notes, keep the metronome and count-in
    countInEnabled: true,   // click one bar before live recording and training
    stepLegato: false,      // step recording holds each note until the next one
    quantize: 8,            // grid division (8 = 1/8 note); also the step-record step size
    keySignature: 'C',
    transpose: 0,           // semitones the piece has been shifted by, for the slider
    editorSelectedNotes: new Set(), // selected note IDs in piano roll editor
  },
  accuracy: {
    active: false,
    results: [],
    score: 0,
  },
};

const _listeners = new Map();

export function on(event, fn) {
  if (!_listeners.has(event)) _listeners.set(event, new Set());
  _listeners.get(event).add(fn);
  return () => off(event, fn);
}

export function off(event, fn) {
  _listeners.get(event)?.delete(fn);
}

export function emit(event, data) {
  const handlers = _listeners.get(event);
  if (!handlers) return;
  // Iterate a copy. A Set visits entries added while it is being iterated, so
  // a handler that subscribes to the same event — one step of a sequence
  // arming the next — would be called by the very dispatch that registered it.
  for (const fn of [...handlers]) {
    try { fn(data); } catch (e) { console.error(`Handler error [${event}]:`, e); }
  }
}

export const state = _state;

export function update(path, value) {
  const parts = path.split('.');
  let obj = _state;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj[parts[i]];
  }
  const key = parts[parts.length - 1];
  const old = obj[key];
  obj[key] = value;
  emit(`change:${path}`, { value, old });
  emit('change', { path, value, old });
}
