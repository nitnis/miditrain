// Standard MIDI File read and write.
//
// The app stores notes in milliseconds against a single tempo, which is what
// both directions have to bridge: ticks are musical, milliseconds are not.
// Everything here is plain bytes — no dependency, and no build step to add one.
//
// The file's own division into tracks survives the trip: reading returns a
// `tracks` list alongside the notes, each note tagged with the track it came
// from, and writing puts the parts back into their own chunks. See tracks.js.
import { normalizeTracks } from './tracks.js';
import { PEDAL_FROM_CC, CC_FOR_PEDAL, normalizePedal } from './pedal.js';

const TICKS_PER_BEAT = 480;
const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;
const CONTROL = 0xb0;
const META = 0xff;
const SYSEX = 0xf0;

// The app's key names, ordered by how many sharps (positive) or flats
// (negative) they carry — which is exactly what the key-signature meta stores
const KEY_BY_ACCIDENTALS = {
  '-5': 'Db', '-4': 'Ab', '-3': 'Eb', '-2': 'Bb', '-1': 'F',
  '0': 'C', '1': 'G', '2': 'D', '3': 'A', '4': 'E', '5': 'B', '6': 'F#',
};
const ACCIDENTALS_BY_KEY = Object.fromEntries(
  Object.entries(KEY_BY_ACCIDENTALS).map(([n, k]) => [k, Number(n)])
);

// Percussion. Mapping a kick drum onto a piano key produces noise, not music.
const DRUM_CHANNEL = 9;

// The app's keyboard
const MIN_PITCH = 21;
const MAX_PITCH = 108;

// ── Writing ──────────────────────────────────────────────────────────────────

function varLen(value) {
  const out = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}

function textBytes(str) {
  return [...new TextEncoder().encode(str)];
}

// `target.push(...source)` passes every element as an argument, and a big piece
// exceeds what a call can take: the Schubert recording this was built against
// is 16,662 notes and about two million bytes of track, and exporting it threw
// "Maximum call stack size exceeded" before a byte reached the disk. Only the
// spread is the problem — array-literal spread iterates and is fine — so this
// is the one place that has to append rather than spread.
function append(target, source) {
  for (let i = 0; i < source.length; i++) target.push(source[i]);
  return target;
}

function chunk(id, body) {
  const len = body.length;
  return [
    ...textBytes(id),
    (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
    ...body,
  ];
}

function metaEvent(type, data) {
  return [META, type, ...varLen(data.length), ...data];
}

// One MTrk from one list of notes, with its name if it has one — and, on the
// first part only, the pedals.
//
// The pedals go on one track because there is only one set of them. Writing
// them into every part would have both hands raising the same damper, which is
// harmless to hear and wrong to read.
function noteTrack(notes, toTicks, name, pedal = []) {
  // One event per note edge. Note-offs sort before note-ons at the same tick,
  // or a note repeated on the beat would be switched off the instant it began.
  const events = [];
  for (const note of notes) {
    const start = toTicks(note.startTime);
    const end = Math.max(start + 1, toTicks(note.startTime + note.duration));
    events.push({ tick: start, order: 1, bytes: [NOTE_ON, note.pitch, Math.max(1, Math.min(127, note.velocity ?? 90))] });
    events.push({ tick: end, order: 0, bytes: [NOTE_OFF, note.pitch, 64] });
  }
  // A pedal lifted at the same tick as a note begins sorts before it, so the
  // note is not caught by a damper that was on its way up anyway
  for (const e of pedal) {
    events.push({ tick: toTicks(e.time), order: 0, bytes: [CONTROL, CC_FOR_PEDAL[e.pedal], e.value] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track = name ? [...varLen(0), ...metaEvent(0x03, textBytes(name))] : [];
  let last = 0;
  for (const event of events) {
    track.push(...varLen(event.tick - last), ...event.bytes);
    last = event.tick;
  }
  track.push(...varLen(0), ...metaEvent(0x2f, []));
  return track;
}

// How the notes are divided across MTrk chunks on the way out.
//
// A piece that arrived as one part leaves as one, with no track name on it —
// which is what this always did, and what a recording or a generated exercise
// should be. A piece that arrived with parts leaves with the same parts, named,
// so that opening the export gets back the list the player set up rather than
// one merged blob. Switching a part off silences it in the app; it does not
// delete it, so the export still holds it.
//
// The colour and the hand do not survive: a MIDI file has nowhere to put them.
// The hand comes back if the name still reads as one — "Piano left" does, and
// is how it was read in the first place — and the app's own JSON export is
// what keeps all of it.
function partition(composition) {
  const { notes, tracks } = composition;
  if (!tracks || tracks.length < 2) return [{ name: null, notes }];
  const parts = tracks.map(t => ({ name: t.name, notes: [] }));
  const slot = new Map(tracks.map((t, i) => [t.id, i]));
  const loose = [];
  for (const note of notes) {
    const at = slot.get(note.trackId);
    if (at === undefined) loose.push(note);
    else parts[at].notes.push(note);
  }
  // Notes added since the import belong to no part. They go in their own rather
  // than being dropped or quietly folded into somebody else's.
  if (loose.length) parts.push({ name: 'Added', notes: loose });
  return parts.filter(p => p.notes.length);
}

export function compositionToMidi(composition) {
  const { name, tempo, timeSignature, keySignature } = composition;
  const msPerBeat = 60000 / tempo;
  const toTicks = (ms) => Math.max(0, Math.round((ms / msPerBeat) * TICKS_PER_BEAT));

  // Conductor track: everything about the piece rather than the notes
  const usPerBeat = Math.round(60000000 / tempo);
  const denominatorPower = Math.round(Math.log2(timeSignature.denominator));
  const conductor = [
    ...varLen(0), ...metaEvent(0x03, textBytes(name || 'Untitled')),
    ...varLen(0), ...metaEvent(0x51, [(usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff]),
    ...varLen(0), ...metaEvent(0x58, [timeSignature.numerator, denominatorPower, 24, 8]),
    ...varLen(0), ...metaEvent(0x59, [ACCIDENTALS_BY_KEY[keySignature] ?? 0, 0]),
    ...varLen(0), ...metaEvent(0x2f, []),
  ];

  const parts = partition(composition);
  const count = parts.length + 1;              // and the conductor
  const header = chunk('MThd', [
    0, 1,                                      // format 1
    (count >> 8) & 0xff, count & 0xff,
    (TICKS_PER_BEAT >> 8) & 0xff, TICKS_PER_BEAT & 0xff,
  ]);

  const bytes = [...header, ...chunk('MTrk', conductor)];
  parts.forEach((part, i) => {
    append(bytes, chunk('MTrk', noteTrack(part.notes, toTicks, part.name,
      i === 0 ? (composition.pedal || []) : [])));
  });
  return new Uint8Array(bytes);
}

// ── Reading ──────────────────────────────────────────────────────────────────

class Reader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  get done() { return this.pos >= this.bytes.length; }
  byte() {
    if (this.pos >= this.bytes.length) throw new Error('Unexpected end of file');
    return this.bytes[this.pos++];
  }
  bytesN(n) {
    if (this.pos + n > this.bytes.length) throw new Error('Unexpected end of file');
    return this.bytes.subarray(this.pos, this.pos += n);
  }
  uint16() { return (this.byte() << 8) | this.byte(); }
  uint32() { return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0; }
  string(n) { return String.fromCharCode(...this.bytesN(n)); }
  varLen() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.byte();
      value = (value << 7) | (b & 0x7f);
      if (!(b & 0x80)) return value;
    }
    throw new Error('Malformed variable-length value');
  }
}

// Files written from notation software usually say which hand is which, and
// nothing inferred from the notes can beat being told. "Piano right" and
// "Piano left" is the common spelling; treble and bass turn up too.
function handFromTrackName(name) {
  const text = (name || '').toLowerCase();
  if (/\b(right|treble|rh|r\.h)\b/.test(text)) return 'right';
  if (/\b(left|bass|lh|l\.h)\b/.test(text)) return 'left';
  return null;
}

// What to call a track in the list. Its own name if it has one; the instrument
// name if the writer put one there instead, which some engravers do; and a
// number if neither, because a row with no label is worse than a dull one.
function trackName(events, ordinal) {
  const meta = (type) => events.find(e => e.meta === type && e.data.length);
  const named = meta(0x03) || meta(0x04);
  const text = named ? new TextDecoder().decode(named.data).trim() : '';
  return text.slice(0, 60) || `Track ${ordinal}`;
}

// One track's events, at absolute ticks
function readTrack(reader, length) {
  const end = reader.pos + length;
  const events = [];
  let tick = 0;
  let status = 0; // running status: a byte-saving trick most real files use

  while (reader.pos < end) {
    tick += reader.varLen();
    const byte = reader.byte();
    if (byte & 0x80) status = byte;
    else if (status) reader.pos--; // a data byte: the previous status still stands
    else throw new Error('Malformed track: data before any status byte');

    if (status === META) {
      const type = reader.byte();
      const data = reader.bytesN(reader.varLen());
      events.push({ tick, meta: type, data });
      continue;
    }
    if (status === SYSEX || status === 0xf7) {
      reader.bytesN(reader.varLen());
      status = 0; // running status does not carry across a sysex
      continue;
    }

    const command = status & 0xf0;
    const channel = status & 0x0f;
    if (command === NOTE_ON || command === NOTE_OFF) {
      const pitch = reader.byte();
      const velocity = reader.byte();
      // Note-on at zero velocity is the usual way to write a note-off
      const on = command === NOTE_ON && velocity > 0;
      events.push({ tick, channel, pitch, velocity, on });
    } else if (command === 0xc0 || command === 0xd0) {
      reader.byte();
    } else if (command === CONTROL) {
      const controller = reader.byte();
      const value = reader.byte();
      // The three pedals are kept; every other controller is somebody's mixer
      // automation and none of this app's business
      if (PEDAL_FROM_CC[controller]) events.push({ tick, channel, controller, value });
    } else if (command >= 0xa0 && command <= 0xe0) {
      reader.bytesN(2);
    } else {
      throw new Error('Unrecognised MIDI event');
    }
  }

  reader.pos = end; // trust the chunk length over our own arithmetic
  return events;
}

export function midiToComposition(buffer) {
  const reader = new Reader(new Uint8Array(buffer));
  if (reader.bytes.length < 14 || reader.string(4) !== 'MThd') {
    throw new Error('Not a MIDI file');
  }

  const headerLength = reader.uint32();
  reader.uint16();                       // format: tracks are merged either way
  const trackCount = reader.uint16();
  const division = reader.uint16();
  reader.pos += Math.max(0, headerLength - 6);

  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  if (!division) throw new Error('MIDI file has no timing division');

  const events = [];
  const tracks = [];
  for (let i = 0; i < trackCount && !reader.done; i++) {
    const id = reader.string(4);
    const length = reader.uint32();
    if (id !== 'MTrk') { reader.bytesN(length); continue; }   // skip unknown chunks
    const trackEvents = readTrack(reader, length);
    // Both hands are usually written on the same channel, and their ranges
    // overlap, so a note has to be matched to its note-off within its own track
    for (const event of trackEvents) event.track = i;
    append(events, trackEvents);
    // A conductor track carries the tempo and the key and no notes at all, and
    // is not a part anybody plays. Listing it would put a row in the track
    // control that switches nothing off.
    if (!trackEvents.some(e => e.pitch !== undefined && e.on)) continue;
    const name = trackName(trackEvents, tracks.length + 1);
    // The track's own name decides the hand for everything on it, and nothing
    // inferred from the notes beats being told. It is a starting point rather
    // than a verdict: the player can put the part in the other hand, or hand
    // it back to the texture, from the track list.
    tracks.push({ id: i, name, enabled: true, color: null, hand: handFromTrackName(name) || 'auto' });
  }
  if (!events.length) throw new Error('No usable tracks in this MIDI file');

  events.sort((a, b) => a.tick - b.tick);

  // Piece-level settings come from the first of each that appears
  let tempo = 120;
  let tempoChanges = 0;
  let timeSignature = { numerator: 4, denominator: 4 };
  let haveTimeSignature = false;
  let keySignature = 'C';
  let name = '';
  for (const e of events) {
    if (e.meta === 0x51 && e.data.length === 3) {
      tempoChanges += 1;
      if (tempoChanges === 1) {
        const usPerBeat = (e.data[0] << 16) | (e.data[1] << 8) | e.data[2];
        if (usPerBeat > 0) tempo = Math.max(20, Math.min(300, Math.round(60000000 / usPerBeat)));
      }
    } else if (e.meta === 0x58 && e.data.length >= 2 && !haveTimeSignature) {
      haveTimeSignature = true;
      // The meter selector offers 2, 4 and 8 as denominators; anything else
      // gets the nearest one the app can actually notate
      const denominator = Math.max(2, Math.min(8, 2 ** e.data[1]));
      timeSignature = {
        numerator: Math.max(2, Math.min(12, e.data[0] || 4)),
        denominator: [2, 4, 8].includes(denominator) ? denominator : 4,
      };
    } else if (e.meta === 0x59 && e.data.length >= 1) {
      const sf = e.data[0] > 127 ? e.data[0] - 256 : e.data[0];
      keySignature = KEY_BY_ACCIDENTALS[String(sf)] || keySignature;
    } else if (e.meta === 0x03 && !name) {
      name = new TextDecoder().decode(e.data).trim();
    }
  }

  // A single tempo is all the app has, so ticks convert at one rate throughout.
  // Honouring a tempo map would put the notes in the right places in time but
  // the wrong places on the stave, which is the half that matters here.
  const msPerTick = (60000 / tempo) / division;
  const held = new Map();   // `${track}:${channel}:${pitch}` -> { pitch, tick, velocity, track }
  const notes = [];
  let dropped = 0;
  let clamped = 0;

  const closeNote = (key, endTick) => {
    const start = held.get(key);
    held.delete(key);
    const bounded = Math.max(MIN_PITCH, Math.min(MAX_PITCH, start.pitch));
    if (bounded !== start.pitch) clamped += 1;
    notes.push({
      id: crypto.randomUUID(),
      pitch: bounded,
      velocity: Math.max(1, Math.min(127, start.velocity)),
      startTime: start.tick * msPerTick,
      duration: Math.max(20, (endTick - start.tick) * msPerTick),
      trackId: start.track,
    });
  };

  for (const e of events) {
    if (e.pitch === undefined) continue;
    if (e.channel === DRUM_CHANNEL) { if (e.on) dropped += 1; continue; }
    const key = `${e.track}:${e.channel}:${e.pitch}`;

    if (e.on) {
      // A pitch restruck before its note-off ends the first one where the
      // second begins, rather than being dropped or left hanging
      if (held.has(key)) closeNote(key, e.tick);
      held.set(key, { pitch: e.pitch, tick: e.tick, velocity: e.velocity, track: e.track });
    } else if (held.has(key)) {
      closeNote(key, e.tick);
    }
  }
  // Anything still down at the end of the file gets closed there
  const lastTick = events[events.length - 1].tick;
  for (const key of [...held.keys()]) closeNote(key, lastTick);

  if (!notes.length) throw new Error('No playable notes in this MIDI file');
  notes.sort((a, b) => a.startTime - b.startTime);

  // The pedals, on the same clock as the notes. Merged across tracks and left
  // in the order they were written: which track a foot was recorded on is not a
  // musical fact, and both hands' parts share one set of pedals anyway.
  const pedal = normalizePedal(events
    .filter(e => e.controller !== undefined)
    .map(e => ({
      time: e.tick * msPerTick,
      pedal: PEDAL_FROM_CC[e.controller],
      value: e.value,
    })));

  const warnings = [];
  if (tempoChanges > 1) warnings.push(`${tempoChanges} tempo changes — kept the first (${tempo} BPM)`);
  if (dropped) warnings.push(`${dropped} percussion note${dropped === 1 ? '' : 's'} skipped`);
  if (clamped) warnings.push(`${clamped} note${clamped === 1 ? '' : 's'} moved into the 88-key range`);

  return {
    id: null,
    name: name || 'Imported MIDI',
    tempo,
    timeSignature,
    keySignature,
    notes,
    pedal,
    tracks: normalizeTracks(tracks, notes),
    warnings,
  };
}
