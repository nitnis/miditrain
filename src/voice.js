// Counting the bar out loud: "one e and a two e and a".
//
// ── Why this is synthesised rather than spoken ──
//
// The browser can already speak, through `speechSynthesis`. It cannot speak in
// time. An utterance is queued, not scheduled: it starts when the speech engine
// gets round to it, tens to hundreds of milliseconds later, and there is no way
// to ask for a moment on the audio clock. A sixteenth at 120 BPM is 125ms, so
// that jitter is not a rough edge — it is the whole of what a count is for.
// (It is also simply absent on some platforms: this app's own test browser
// reports the API present and no voices at all.)
//
// Recordings would sound better than anything here. They are also megabytes of
// somebody's voice, per language, and this app already refuses to carry audio
// it has no licence to.
//
// So the syllables are built out of formants, and scheduled on the same clock
// as the clicks, which makes them exactly as punctual as the clicks are. It
// sounds like a machine counting, because that is what it is. What it does do
// is land on the beat.
//
// ── How a syllable is made ──
//
// A vowel is two or three resonances. Feed a buzz rich in harmonics through
// bandpass filters at those frequencies and the ear hears the vowel, which is
// the whole of formant synthesis:
//
//   sawtooth ──┬─→ bandpass F1 ─→ gain ─┐
//    (buzz)    ├─→ bandpass F2 ─→ gain ─┼─→ envelope ─→ click bus
//              └─→ bandpass F3 ─→ gain ─┘
//   noise ────────→ highpass ──→ gain ──┘   (the consonant in front)
//
// Consonants are a short burst of filtered noise before the vowel — "t", "s",
// "f" and friends really are mostly noise — and the nasal at the end of "one"
// and "nine" is the vowel closing onto a low resonance.
import { state } from './state.js';

// Where the resonances sit, in hertz. A speaking voice, not a singing one.
const VOWELS = {
  uh: [620, 1200, 2450],   // one
  oo: [330,  900, 2300],   // two
  ee: [280, 2250, 3000],   // three, and "e"
  aw: [570,  850, 2400],   // four
  ah: [720, 1240, 2500],   // the open half of "five" and "nine"
  ih: [420, 1990, 2550],   // six, trip
  eh: [530, 1840, 2480],   // seven, ten, let
  ay: [420, 2000, 2600],   // eight
  er: [500, 1500, 2500],   // "a", the schwa
  an: [660, 1720, 2410],   // "and"
};

// The noise in front. `hp` is where it sits, `q` how narrow, `ms` how long.
const ONSETS = {
  t:  { hp: 3200, q: 0.9, ms: 18, level: 0.5 },
  th: { hp: 2200, q: 0.7, ms: 26, level: 0.3 },
  f:  { hp: 2600, q: 0.6, ms: 28, level: 0.32 },
  s:  { hp: 4800, q: 1.2, ms: 34, level: 0.42 },
  n:  { hp:  300, q: 0.8, ms: 22, level: 0.16 },
  l:  { hp:  500, q: 0.8, ms: 20, level: 0.14 },
};

// Every syllable a bar can be counted in. Numbers up to twelve, because the
// meter can be; "eleven" and "twelve" are clipped to one syllable, which is
// what anybody counting a bar of twelve at speed does anyway.
const SYLLABLES = {
  1:  { v: 'uh', nasal: true },                 // one
  2:  { onset: 't',  v: 'oo' },
  3:  { onset: 'th', v: 'ee' },
  4:  { onset: 'f',  v: 'aw' },
  5:  { onset: 'f',  v: 'ah', glide: 'ee' },    // five
  6:  { onset: 's',  v: 'ih' },
  7:  { onset: 's',  v: 'eh', nasal: true },    // sev'n
  8:  { v: 'ay' },
  9:  { onset: 'n',  v: 'ah', glide: 'ee', nasal: true },
  10: { onset: 't',  v: 'eh', nasal: true },
  11: { onset: 'l',  v: 'eh', nasal: true },    // 'leven
  12: { onset: 't',  v: 'eh' },                 // twelve
  e: { v: 'ee' },
  '&': { v: 'an', nasal: true },                // and
  a: { v: 'er' },
  trip: { onset: 't', v: 'ih' },
  let: { onset: 'l', v: 'eh' },
};

// The voice's pitch. Low enough to read as speech rather than as another note
// in the music, and it falls a little through the syllable the way speech does.
const F0 = 132;
const F0_FALL = 0.94;
// A syllable has to be over before the next one is due, or the count slurs into
// a drone. Whichever is shorter: what a syllable wants, or most of the gap.
const WANTS_MS = 135;
const OF_THE_GAP = 0.8;

let noiseBuffer = null;

function noise(ctx) {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
  const samples = Math.ceil(ctx.sampleRate * 0.12);
  noiseBuffer = ctx.createBuffer(1, samples, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

// What to say at a given tick. `beat` is 1-based; `slot` is where in the beat,
// against the syllables the count is written in.
export function syllableFor(beat, slot, between) {
  if (slot === 0) return String(Math.min(12, Math.max(1, beat)));
  return between[slot - 1] || null;
}

// One syllable, at a moment on the audio clock. `gapMs` is how long until the
// next one is due, so a fast count is clipped rather than run together.
//
// The context and the node to sing into are passed rather than reached for, so
// this can be rendered offline and measured — a voice that makes no sound, or
// makes the wrong one, is otherwise something you can only find out by
// listening, which no test can do.
export function speakSyllable(ctx, bus, when, name, { gapMs = 500, accent = 'beat' } = {}) {
  const spec = SYLLABLES[name];
  if (!spec) return;

  const ms = Math.max(45, Math.min(WANTS_MS, gapMs * OF_THE_GAP));
  const dur = ms / 1000;
  // The downbeat is said harder and a touch higher, the way anybody counting
  // marks the start of a bar; the divisions are said lightly, under the beats
  const level = accent === 'downbeat' ? 0.5 : accent === 'sub' ? 0.2 : 0.34;
  const f0 = F0 * (accent === 'downbeat' ? 1.08 : 1);

  const onset = ONSETS[spec.onset];
  const onsetS = onset ? onset.ms / 1000 : 0;
  // The consonant LEADS the beat, so the vowel lands on it.
  //
  // A listener hears a syllable as happening at its vowel, not at the hiss in
  // front of it — "six" said with the "s" starting on the beat is heard a
  // clear thirty milliseconds late, which on a count is the difference between
  // a pulse to play with and one to fight. So the noise goes before.
  const vowelAt = when;
  const onsetAt = Math.max(0, when - onsetS);
  const vowelDur = Math.max(0.03, dur);

  // The vowel's envelope only. The consonant carries its own and goes straight
  // out: routed through this it was multiplied by a gain still ramping up from
  // silence, so the lead was scheduled, rendered, and inaudible — the count
  // sounded exactly as late as it had before the lead was added.
  const out = ctx.createGain();
  out.connect(bus);
  out.gain.setValueAtTime(0.0001, vowelAt);

  // ── the consonant ──
  if (onset) {
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = onset.hp;
    hp.Q.value = onset.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, onsetAt);
    g.gain.exponentialRampToValueAtTime(onset.level * level * 2, onsetAt + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, vowelAt + 0.012);
    src.connect(hp); hp.connect(g); g.connect(bus);
    src.start(onsetAt);
    src.stop(vowelAt + 0.03);
    src.addEventListener('ended', () => { src.disconnect(); hp.disconnect(); g.disconnect(); });
  }

  // ── the vowel ──
  const buzz = ctx.createOscillator();
  buzz.type = 'sawtooth';
  buzz.frequency.setValueAtTime(f0, vowelAt);
  buzz.frequency.linearRampToValueAtTime(f0 * F0_FALL, vowelAt + vowelDur);

  const from = VOWELS[spec.v] || VOWELS.er;
  // A diphthong is one vowel moving to another — "five" is not a sound, it is
  // a journey — and a nasal is the mouth closing onto a low resonance
  const to = spec.glide ? VOWELS[spec.glide] : (spec.nasal ? [280, 1100, 2400] : from);
  const moves = to !== from;

  const parts = [];
  for (let i = 0; i < 3; i++) {
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = i === 0 ? 9 : 12;
    band.frequency.setValueAtTime(from[i], vowelAt);
    if (moves) {
      // The move happens over the back half, so the vowel is heard before it
      // turns into the next thing
      band.frequency.setValueAtTime(from[i], vowelAt + vowelDur * 0.45);
      band.frequency.linearRampToValueAtTime(to[i], vowelAt + vowelDur);
    }
    const g = ctx.createGain();
    // The upper formants carry less energy in a real voice, and letting them
    // through at full strength makes a buzz rather than a vowel
    g.gain.value = [1, 0.5, 0.22][i];
    buzz.connect(band); band.connect(g); g.connect(out);
    parts.push(band, g);
  }

  // ── the shape of it ──
  out.gain.exponentialRampToValueAtTime(level, vowelAt + 0.014);
  out.gain.setValueAtTime(level, vowelAt + vowelDur * 0.7);
  out.gain.exponentialRampToValueAtTime(0.0001, vowelAt + vowelDur);

  buzz.start(vowelAt);
  buzz.stop(vowelAt + vowelDur + 0.02);
  buzz.addEventListener('ended', () => {
    buzz.disconnect();
    for (const node of parts) node.disconnect();
    out.disconnect();
  });
}

export function countingAloud() {
  return state.ui.countAloud === true;
}
