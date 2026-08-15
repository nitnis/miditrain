// Standard MIDI File read and write.
//
// The app stores notes in milliseconds against a single tempo, which is what
// both directions have to bridge: ticks are musical, milliseconds are not.
// Everything here is plain bytes — no dependency, and no build step to add one.

const TICKS_PER_BEAT = 480;
const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;
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

export function compositionToMidi(composition) {
  const { name, tempo, timeSignature, keySignature, notes } = composition;
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

  // One event per note edge. Note-offs sort before note-ons at the same tick,
  // or a note repeated on the beat would be switched off the instant it began.
  const events = [];
  for (const note of notes) {
    const start = toTicks(note.startTime);
    const end = Math.max(start + 1, toTicks(note.startTime + note.duration));
    events.push({ tick: start, order: 1, bytes: [NOTE_ON, note.pitch, Math.max(1, Math.min(127, note.velocity ?? 90))] });
    events.push({ tick: end, order: 0, bytes: [NOTE_OFF, note.pitch, 64] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track = [];
  let last = 0;
  for (const event of events) {
    track.push(...varLen(event.tick - last), ...event.bytes);
    last = event.tick;
  }
  track.push(...varLen(0), ...metaEvent(0x2f, []));

  const header = chunk('MThd', [
    0, 1,                                   // format 1
    0, 2,                                   // two tracks
    (TICKS_PER_BEAT >> 8) & 0xff, TICKS_PER_BEAT & 0xff,
  ]);

  return new Uint8Array([...header, ...chunk('MTrk', conductor), ...chunk('MTrk', track)]);
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
  for (let i = 0; i < trackCount && !reader.done; i++) {
    const id = reader.string(4);
    const length = reader.uint32();
    if (id !== 'MTrk') { reader.bytesN(length); continue; }   // skip unknown chunks
    events.push(...readTrack(reader, length));
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
  const held = new Map();   // `${channel}:${pitch}` -> { pitch, tick, velocity }
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
    });
  };

  for (const e of events) {
    if (e.pitch === undefined) continue;
    if (e.channel === DRUM_CHANNEL) { if (e.on) dropped += 1; continue; }
    const key = `${e.channel}:${e.pitch}`;

    if (e.on) {
      // A pitch restruck before its note-off ends the first one where the
      // second begins, rather than being dropped or left hanging
      if (held.has(key)) closeNote(key, e.tick);
      held.set(key, { pitch: e.pitch, tick: e.tick, velocity: e.velocity });
    } else if (held.has(key)) {
      closeNote(key, e.tick);
    }
  }
  // Anything still down at the end of the file gets closed there
  const lastTick = events[events.length - 1].tick;
  for (const key of [...held.keys()]) closeNote(key, lastTick);

  if (!notes.length) throw new Error('No playable notes in this MIDI file');
  notes.sort((a, b) => a.startTime - b.startTime);

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
    warnings,
  };
}
