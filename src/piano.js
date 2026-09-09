// A recorded piano, instead of a shape.
//
// The app's own voice is a triangle plus a sawtooth through a lowpass. A
// triangle has only ODD harmonics; a struck string has all of them. Measured on
// the same note at the same velocity, against a recording of a real piano:
//
//   partial          2      3      4      5      6      7      8
//   recorded      0.379  0.063  0.199  0.131  0.107  0.121  0.040
//   the synth     0.057  0.060  0.035  0.072  0.021  0.001  0.009
//
// Summed over the even partials the recording carries six times what the synth
// does at C4, twelve times at C2. The recording's partials also run sharp of
// exact multiples — up to +14 cents by the eighth — because a real string is
// stiff, and an oscillator's never do.
//
// That gap is why this exists, and it is worth more than the sound. The octave
// ambiguity the transcriber spends `nmf.js` on only arises when a note has
// strong even partials: every partial of the upper note has to land on one of
// the lower one's. The synth has almost none, so the rendered test suite has
// never once produced the failure the real recording produces. Rendering
// through this instead means the tests finally contain the bug.
//
// ── What this is not ─────────────────────────────────────────────────────────
//
// One velocity layer, because the source has exactly one: `VELOCITY = 85` is
// hardcoded in the script that rendered these files, so every one of them is
// that note struck once, at mezzo-forte. How hard a note was struck is carried
// by loudness and by a lowpass that opens with velocity.
//
// That is better than what it replaced, not worse. Measured at C4 as spectral
// centroid, this spans 623–1711 Hz across the dynamic where the oscillator
// voice spanned 348–631 — 2.75x against 1.81x — because a filter closing on a
// real piano has far more to take away than one closing on a triangle.
//
// The limitation is the loud half. Velocity 20 to 85 climbs 133%; 85 to 127 —
// mf to fff — climbs 18%, because by then the filter is open and there is
// nothing left to reveal. Nothing can be brighter than the recording, and the
// recording is mezzo-forte. Fixing that needs layers, which needs a source that
// has them.
//
// Three seconds and a bit per note. Under the pedal a bass note on a real
// instrument rings far longer than the recording lasts, and when the sample
// runs out the note is simply gone.
//
// Everything is optional. With no samples present — the directory empty, a
// failed fetch, a browser that will not decode mp3 — `voiceFor` returns null
// and `audio.js` falls back to the oscillators, which is exactly what the app
// sounded like before. Nothing here may become a thing the app needs to work.
const DIR = new URL('../assets/piano/', import.meta.url).href;
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// How wide the filter opens, as a multiple of the note's own frequency. At the
// soft end a struck string gives up its upper partials; at the hard end this
// wants to be out of the way and let the recording through untouched.
const TONE_PPP = 3;
const TONE_FF = 26;
// A recording starts at its own attack, so this is only long enough to stop the
// gain step clicking — not an attack shape, which the sample already has
const SAMPLE_ATTACK_S = 0.004;

// The recordings peak around 0.09 rather than 1, because a soundfont leaves
// headroom for a whole orchestra playing at once. `peakFor` in `audio.js` was
// calibrated against oscillators that peak at 1, and a great deal is keyed to
// the app's loudness staying where it is: the transcriber's reference level,
// professional mode's dynamics bands, the output slider. So the recordings are
// brought up to meet it rather than the other way round.
//
// Measured across five pitches and four velocities, a rendered note needs
// between 13x and 26x to match what the oscillator gave, median 18. A single
// constant is deliberate: the spread IS the instrument — the top octave of a
// real piano is quieter than its middle, and the synth's flatness was the
// thing that was wrong. Only the middle is matched, and the rest keeps the
// balance the recordings were made with.
const MAKEUP = 18;
// How many files to have in flight at once. All of them at once is a stall on a
// slow connection and a burst of memory for no gain
const CONCURRENCY = 8;

// ── Which pitches have a recording ───────────────────────────────────────────

export function midiFor(name) {
  const m = /^([A-G]b?)(-?\d+)$/.exec(name);
  if (!m) return null;
  const i = NAMES.indexOf(m[1]);
  return i < 0 ? null : (Number(m[2]) + 1) * 12 + i;
}

let manifest = null;          // { pitch -> filename }, once loaded
let manifestPromise = null;

// The manifest is the whole of the coupling between this code and the sample
// set. Swap in a smaller set, or a set re-encoded to mono, and nothing here
// changes — pitches with no file of their own are covered by shifting a
// neighbour.
async function loadManifest() {
  if (manifest) return manifest;
  if (!manifestPromise) {
    manifestPromise = (async () => {
      try {
        const res = await fetch(`${DIR}manifest.json`);
        if (!res.ok) throw new Error(`manifest: ${res.status}`);
        const { notes } = await res.json();
        const map = new Map();
        for (const n of notes || []) {
          const pitch = midiFor(n);
          if (pitch !== null) map.set(pitch, `${n}.mp3`);
        }
        manifest = map.size ? map : null;
      } catch (_) {
        // The app goes on working without samples, on oscillators. It is a
        // fallback rather than a supported configuration, though: the samples
        // are in the repository, so a missing manifest means a deployment that
        // lost its assets, and the browser logging that failed request is the
        // right thing for it to do.
        manifest = null;
      }
      return manifest;
    })();
  }
  return manifestPromise;
}

// The recording to play for a pitch, and how far it has to be moved to get
// there. Nearest wins; a tie shifts down, which lengthens the decay rather than
// cutting it short.
function sourceFor(pitches, pitch) {
  if (pitches.has(pitch)) return { from: pitch, semitones: 0 };
  let best = null;
  for (const p of pitches.keys()) {
    const d = Math.abs(p - pitch);
    if (!best || d < best.d || (d === best.d && p > pitch)) best = { d, p };
  }
  return best ? { from: best.p, semitones: pitch - best.p } : null;
}

// ── Decoding, once per pitch and once per sample rate ────────────────────────

const bytes = new Map();                 // pitch -> ArrayBuffer, as downloaded
const decoded = new Map();               // sampleRate -> Map<pitch, AudioBuffer>

async function fetchAll(files) {
  const wanted = [...files].filter(([pitch]) => !bytes.has(pitch));
  for (let i = 0; i < wanted.length; i += CONCURRENCY) {
    await Promise.all(wanted.slice(i, i + CONCURRENCY).map(async ([pitch, file]) => {
      try {
        const res = await fetch(DIR + file);
        if (res.ok) bytes.set(pitch, await res.arrayBuffer());
      } catch (_) { /* a missing note falls back to a neighbour, or to the synth */ }
    }));
  }
}

// `decodeAudioData` resamples to the context it is called on, so a rendering at
// 22050 gets buffers at 22050 and the speakers get theirs at whatever rate the
// hardware runs. It also detaches what it is given, hence the slice.
async function decodeAll(sampleRate) {
  let atRate = decoded.get(sampleRate);
  if (atRate) return atRate;
  atRate = new Map();
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Offline(1, 1, sampleRate);
  for (const [pitch, raw] of bytes) {
    try {
      atRate.set(pitch, await ctx.decodeAudioData(raw.slice(0)));
    } catch (_) { /* as above */ }
  }
  decoded.set(sampleRate, atRate);
  return atRate;
}

const ready = new Map();                 // sampleRate -> Promise<Map|null>
const settled = new Map();               // ...and the answer, once it has one

// Call before rendering or playing, and await it. Safe to call repeatedly, from
// anywhere, at any time: the work happens once per rate and everybody waits on
// the same promise.
export function loadPiano(sampleRate) {
  if (!ready.has(sampleRate)) {
    ready.set(sampleRate, (async () => {
      const files = await loadManifest();
      if (!files) return null;
      await fetchAll(files);
      const buffers = await decodeAll(sampleRate);
      const answer = buffers.size ? buffers : null;
      settled.set(sampleRate, answer);
      return answer;
    })());
  }
  return ready.get(sampleRate);
}

// What `loadPiano` settled on, without waiting. Null while it is still going,
// and null forever if there are no samples — either way the caller plays an
// oscillator, which is the point of it being a synchronous question.
export function pianoFor(sampleRate) {
  return settled.get(sampleRate) ?? null;
}

// ── The voice ────────────────────────────────────────────────────────────────

// Same shape as the oscillator voice in `audio.js` and interchangeable with it:
// a node with a `gain` to put an envelope on, a `peak` to reach, and something
// that can be stopped. Returns null when there is nothing to play from, which
// is the signal to fall back.
export function voiceFor(c, dest, pitch, velocity, when, peak) {
  const buffers = pianoFor(c.sampleRate);
  if (!buffers) return null;
  const pick = sourceFor(buffers, pitch);
  const buffer = pick && buffers.get(pick.from);
  if (!buffer) return null;

  const src = c.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = Math.pow(2, pick.semitones / 12);

  // The one thing standing in for the velocity layers this does not have: a
  // note struck softly loses its top before it loses its volume.
  const v = Math.min(127, Math.max(1, velocity)) / 127;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  const freq = 440 * Math.pow(2, (pitch - 69) / 12);
  filter.frequency.value = Math.min(c.sampleRate / 2 * 0.9,
    Math.max(700, freq * (TONE_PPP + (TONE_FF - TONE_PPP) * v * v)));
  filter.Q.value = 0.7;

  const gain = c.createGain();
  src.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  src.start(when);

  // `sampled` tells `audio.js` not to impose a decay: the recording is already
  // a string losing its energy, and an exponential on top of it would be the
  // note dying twice.
  return {
    sampled: true, src, filter, gain,
    peak: peak * MAKEUP, tau: Infinity, attack: SAMPLE_ATTACK_S,
  };
}
