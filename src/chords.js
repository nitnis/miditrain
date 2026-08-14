// Chord detection without external dependencies
const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_NAMES_FLAT  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// Common chord interval patterns (sorted, relative to root = 0)
const CHORD_PATTERNS = [
  { name: 'maj7', intervals: [0, 4, 7, 11] },
  { name: 'm7',   intervals: [0, 3, 7, 10] },
  { name: '7',    intervals: [0, 4, 7, 10] },
  { name: 'dim7', intervals: [0, 3, 6, 9] },
  { name: 'm7b5', intervals: [0, 3, 6, 10] },
  { name: 'maj',  intervals: [0, 4, 7] },
  { name: 'min',  intervals: [0, 3, 7] },
  { name: 'dim',  intervals: [0, 3, 6] },
  { name: 'aug',  intervals: [0, 4, 8] },
  { name: 'sus2', intervals: [0, 2, 7] },
  { name: 'sus4', intervals: [0, 5, 7] },
  { name: '5',    intervals: [0, 7] },
];

function pitchClass(midi) { return midi % 12; }

export function detectChord(midiPitches, useFlats = false) {
  if (midiPitches.length < 2) return null;
  const names = useFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  const pcs = [...new Set(midiPitches.map(pitchClass))].sort((a, b) => a - b);
  // The lowest sounding note decides the inversion
  const bass = pitchClass(Math.min(...midiPitches));

  // Try each pc as root
  for (const root of pcs) {
    const intervals = pcs.map(p => (p - root + 12) % 12).sort((a, b) => a - b);
    for (const { name, intervals: pattern } of CHORD_PATTERNS) {
      if (intervals.length === pattern.length &&
          intervals.every((v, i) => v === pattern[i])) {
        const rootName = names[root];
        const label = name === 'maj' ? rootName : `${rootName}${name}`;
        return bass === root ? label : `${label}/${names[bass]}`;
      }
    }
  }
  return null;
}

// Find chords across *consecutive* events so an arpeggio reads as one chord.
// `events` is time-ordered: [{ beat, pitches }], where one event is a set of
// notes struck together (a single note is just an event of one).
//
// Longest run wins, so C-E-G-C is one chord rather than a triad plus a
// leftover. A run of several events needs three distinct pitch classes before
// it counts — two notes spread over time are too ambiguous to name, though a
// genuinely simultaneous dyad is still labelled as it was before.
export function detectChordRuns(events, useFlats = false, maxSpanBeats = 4, maxEvents = 8) {
  const runs = [];
  let i = 0;

  while (i < events.length) {
    const last = Math.min(events.length - 1, i + maxEvents - 1);
    const seen = new Set();
    const pitches = [];
    let found = null;

    for (let j = i; j <= last; j++) {
      if (events[j].beat - events[i].beat > maxSpanBeats + 1e-6) break;

      // An event that adds no new pitch class means the chord is already
      // spelled out — anything after it belongs to the next one. Without this
      // the scan runs on and swallows the head of the following chord.
      const addsNew = events[j].pitches.some(p => !seen.has(pitchClass(p)));
      if (j > i && !addsNew) break;

      for (const p of events[j].pitches) {
        seen.add(pitchClass(p));
        pitches.push(p);
      }

      // Two notes spread over time are too ambiguous to name; a genuinely
      // simultaneous dyad is still labelled as it was before
      if (seen.size < (j === i ? 2 : 3)) continue;

      const label = detectChord(pitches, useFlats);
      // Keep extending: the longer reading is the better one (Am7 over Am)
      if (label) {
        found = { beat: events[i].beat, endIndex: j, pitches: [...pitches], label, arpeggiated: j > i };
      }
    }

    if (found) {
      runs.push(found);
      i = found.endIndex + 1;
    } else {
      i++;
    }
  }
  return runs;
}

export function midiToNoteName(midi, useFlats = false) {
  const names = useFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  return names[midi % 12];
}

export function midiToNoteWithOctave(midi) {
  const name = NOTE_NAMES_SHARP[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb']);
export function keyUsesFlats(key) { return FLAT_KEYS.has(key); }

// ── Staff positions ──────────────────────────────────────────────────────────
// A staff position is a diatonic index: octave * 7 + letter, so consecutive
// values are consecutive lines/spaces. C4 is 4 * 7 + 0 = 28.
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER  = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const KEY_ACCIDENTAL_COUNT = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6,
  F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6,
};

// Semitone offset of each letter within its octave
const LETTER_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

function keyAccidentalFor(letter, keySignature) {
  const n = KEY_ACCIDENTAL_COUNT[keySignature] ?? 0;
  if (n > 0 && SHARP_ORDER.slice(0, n).includes(letter)) return '♯';
  if (n < 0 && FLAT_ORDER.slice(0, -n).includes(letter)) return '♭';
  return '';
}

// Staff position → display name, with the key signature's accidental applied
export function staffPositionName(dia, keySignature = 'C') {
  const letter = LETTERS[((dia % 7) + 7) % 7];
  const octave = Math.floor(dia / 7);
  return `${letter}${keyAccidentalFor(letter, keySignature)}${octave}`;
}

// Staff position → MIDI pitch, with the key signature's accidental applied
export function staffPositionToMidi(dia, keySignature = 'C') {
  const idx = ((dia % 7) + 7) % 7;
  const octave = Math.floor(dia / 7);
  const acc = keyAccidentalFor(LETTERS[idx], keySignature);
  const shift = acc === '♯' ? 1 : acc === '♭' ? -1 : 0;
  return (octave + 1) * 12 + LETTER_SEMITONES[idx] + shift;
}
