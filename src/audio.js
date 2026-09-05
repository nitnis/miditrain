// Web Audio output: live note monitoring and scheduled playback.
//
//   notes  → noteBus  ─┐
//   clicks → clickBus ─┴→ master → compressor → destination
//
// Two buses rather than one, so each switch is a single gain: the master
// carries volume and mute, and the note bus is what "clicks only" silences —
// leaving the metronome and the count-in audible through their own path.
import { state } from './state.js';
import { atOrPast, EDGE_MS } from './quantizer.js';
import { isAudible } from './tracks.js';
import { sustainSpans, soundingEnd } from './pedal.js';

let ctx = null;
let master = null;
let noteBus = null;
let clickBus = null;

// Currently sounding voices, so stop() can cut them
let liveVoices = new Map();   // pitch → voice (held MIDI input)
let scheduledVoices = new Set(); // voices queued for playback

const LOOKAHEAD_MS = 150;
const PUMP_INTERVAL_MS = 25;

// Envelope. The attack and release are long enough that no segment steps the
// waveform discontinuously, which is what produced the click at each note edge.
const ATTACK_S  = 0.020;
const DECAY_S   = 0.090;
const RELEASE_S = 0.220;
const SUSTAIN_RATIO = 0.65;
const MIN_GAIN = 0.0001; // exponential ramps cannot reach zero

// What the master gain should sit at: the volume, or nothing when muted
function outputLevel() {
  return state.ui.muted ? 0 : state.ui.volume;
}

export function getAudioContext() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = outputLevel();

    noteBus = ctx.createGain();
    noteBus.gain.value = state.ui.clicksOnly ? 0 : 1;
    clickBus = ctx.createGain();
    clickBus.gain.value = 1;

    // Keeps a dense chord from summing into the clipping ceiling, the other
    // half of what made playback sound harsh
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 20;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;

    noteBus.connect(master);
    clickBus.connect(master);
    master.connect(comp);
    comp.connect(ctx.destination);

    // A silent source keeps the graph rendering. Without something pulling it,
    // gain automation stalls while nothing is playing, so a mute fade would
    // only resume — and audibly leak — once the next note started. It feeds
    // the head of the chain rather than the master, so the note bus is pulled
    // too and "clicks only" takes effect the moment it is switched.
    // It also feeds the master directly, so closing the note bus cannot stall
    // the master's own automation on the way through.
    const keepAlive = ctx.createConstantSource();
    keepAlive.offset.value = 0;
    keepAlive.connect(noteBus);
    keepAlive.connect(master);
    keepAlive.start();
  }
  return ctx;
}

export function getNoteBus() {
  getAudioContext();
  return noteBus;
}

export function getClickBus() {
  getAudioContext();
  return clickBus;
}

export function resumeAudioContext() {
  const c = getAudioContext();
  if (c.state === 'suspended') c.resume();
}

// Ramp rather than jump, so a change mid-note doesn't click. Both of these
// read the state they follow — the context is built from that same state, so
// there is nothing to do before a user gesture has created it.
function rampTo(param, value) {
  if (!ctx) return;
  param.cancelScheduledValues(ctx.currentTime);
  param.setTargetAtTime(value, ctx.currentTime, 0.008);
}

// Volume and mute meet at the master gain
export function applyOutputLevel() {
  rampTo(master?.gain, outputLevel());
}

// "Clicks only" closes the note bus and leaves the click bus open
export function applyClicksOnly() {
  rampTo(noteBus?.gain, state.ui.clicksOnly ? 0 : 1);
}

function midiToFreq(pitch) {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

// How loud a note is, for how hard it was struck.
//
// This was a straight line from 0.04 to 0.15, which is eleven decibels from the
// softest note this app can make to the loudest. A piano is nearer forty. The
// practical effect was that the app played every dynamic marking at very nearly
// the same volume — a pianissimo and a fortissimo were a fifth of a doubling
// apart — and professional mode then asked the player to reproduce distinctions
// they could not hear coming back.
//
// Loudness goes roughly as the square of velocity on a real instrument, so the
// curve is a power law rather than a line. The exponent is a little under two
// because this is a triangle wave through a lowpass and not a string: pushed
// all the way, the bottom of the range goes inaudible rather than quiet.
//
// The numbers are chosen to leave the app's own loudness where it was. A note
// at the default velocity of 90 — which is every generated exercise and every
// note that never had one — comes out within a decibel and a half of where it
// always did, and the top is up by less than two. What changes is the shape
// between them: thirty-one decibels of range instead of eleven.
const PEAK_FF = 0.18;
const PEAK_PPP = 0.005;
const PEAK_GAMMA = 1.8;

function peakFor(velocity) {
  const v = Math.min(127, Math.max(1, velocity)) / 127;
  return PEAK_PPP + (PEAK_FF - PEAK_PPP) * Math.pow(v, PEAK_GAMMA);
}

// How many harmonics get through, as a multiple of the note's own frequency.
// Solved so that velocity 90 lands on 6, which is what every note used to get.
const OPEN_PPP = 2.5;
const OPEN_FF = 7.44;

function opennessFor(velocity) {
  const v = Math.min(127, Math.max(1, velocity)) / 127;
  return OPEN_PPP + (OPEN_FF - OPEN_PPP) * v;
}

// ...and how much there is for it to let through.
//
// Opening the filter with velocity was tried on its own and measured almost
// nothing: 357 Hz of brightness at velocity 30 against 416 at 120, where the
// two had been identical. The reason is the oscillator, not the filter. A
// triangle's harmonics fall away as one over n squared — its third partial is
// already at a ninth and its fifth at a twenty-fifth — so there is next to
// nothing up there for a wider filter to admit. It cannot brighten what is not
// there.
//
// So a second, much richer oscillator is mixed in, and how much of it there is
// depends on how hard the note was struck. Squared, so the soft end of the
// keyboard is very nearly the pure triangle this app has always sounded like
// and the harmonics arrive where a real string would give them: at the top.
const BRIGHT_MIX_FF = 0.4;

function brightMixFor(velocity) {
  const v = Math.min(127, Math.max(1, velocity)) / 127;
  return BRIGHT_MIX_FF * v * v;
}

// How long a string goes on ringing.
//
// The envelope held flat: a note was within 1.3 dB of its own peak two and a
// half seconds after it began, which is an organ. A piano loses its energy from
// the moment it is struck, and loses it faster the higher the note — bass
// strings are heavy and ring for many seconds, treble strings are short and
// stiff and are gone in well under one.
//
// It matters more than it did, because a note under the sustain pedal now goes
// on sounding until the pedal comes up. Holding it at full volume for the four
// seconds a pedal can be down is not what a damper does.
const DECAY_TAU_C4 = 1.1;         // seconds, at middle C
const DECAY_OCTAVES = 24;         // ...doubling every two octaves down

function decayTauFor(pitch) {
  return DECAY_TAU_C4 * Math.pow(2, (60 - pitch) / DECAY_OCTAVES);
}

// Oscillator → lowpass → envelope gain → wherever it is going.
//
// Takes its context rather than reaching for the live one, so the same note can
// be built on an OfflineAudioContext and rendered to a buffer. That matters
// because the only honest way to test transcription is to feed it audio this
// app made, and a second copy of the voice for the test rig would be a second
// thing to drift.
export function makeVoice(c, dest, pitch, velocity, when) {
  const osc = c.createOscillator();
  const bright = c.createOscillator();
  const brightGain = c.createGain();
  const filter = c.createBiquadFilter();
  const gain = c.createGain();
  const freq = midiToFreq(pitch);

  osc.type = 'triangle';
  osc.frequency.value = freq;

  // The harmonics a hard strike brings with it. A sawtooth falls away as one
  // over n rather than one over n squared, so it has the upper partials the
  // triangle has not — and its level, not the filter, is what carries how hard
  // the note was hit.
  bright.type = 'sawtooth';
  bright.frequency.value = freq;
  brightGain.gain.value = brightMixFor(velocity);

  // Roll the upper harmonics off relative to the note, so high notes stay
  // bright and low ones don't buzz — and open the filter with how hard the note
  // was struck, because that is the other half of what "harder" sounds like.
  //
  // This was a fixed multiple of the pitch, so a note played at 30 and the same
  // note played at 120 came out with their energy in exactly the same place:
  // 401 Hz for both, measured. On a real instrument a hard strike throws far
  // more into the upper partials, and it is at least as much of the cue as the
  // extra volume is. Professional mode asks a player to reproduce dynamics; it
  // was rendering them with one of their two natural signals missing.
  //
  // Six is what the multiple always was, and it is still exactly six at the
  // default velocity of 90 — so the app sounds as it did, and only the spread
  // around it is new.
  filter.type = 'lowpass';
  filter.frequency.value = Math.min(6000, Math.max(600, freq * opennessFor(velocity)));
  filter.Q.value = 0.7;

  osc.connect(filter);
  bright.connect(brightGain);
  brightGain.connect(filter);
  filter.connect(gain);
  gain.connect(dest);

  osc.start(when);
  bright.start(when);
  return {
    osc, bright, brightGain, gain, filter,
    peak: peakFor(velocity), tau: decayTauFor(pitch),
  };
}

function createVoice(pitch, velocity, when) {
  const voice = makeVoice(getAudioContext(), getNoteBus(), pitch, velocity, when);
  voice.osc.addEventListener('ended', () => {
    try {
      voice.osc.disconnect(); voice.bright.disconnect(); voice.brightGain.disconnect();
      voice.filter.disconnect(); voice.gain.disconnect();
    } catch (_) {}
    scheduledVoices.delete(voice);
  });
  return voice;
}

// The strike, and then the string losing its energy for as long as it sounds.
//
// Hands back what it planned, because a note whose end is known in advance —
// everything the app itself plays — has to pick the release up from wherever
// the decay had got to by then, and only the caller knows when that is.
export function applyAttack(voice, when) {
  const g = voice.gain.gain;
  const sustain = Math.max(voice.peak * SUSTAIN_RATIO, MIN_GAIN);
  const from = when + ATTACK_S + DECAY_S;
  g.cancelScheduledValues(when);
  g.setValueAtTime(MIN_GAIN, when);
  g.exponentialRampToValueAtTime(voice.peak, when + ATTACK_S);
  g.exponentialRampToValueAtTime(sustain, from);
  // Approaches silence rather than reaching it, which is what a string does and
  // what `setTargetAtTime` is for. A key still held goes on decaying under the
  // finger; the value is live, so releasing it still picks up from here.
  g.setTargetAtTime(MIN_GAIN, from, voice.tau);
  return { sustain, from, tau: voice.tau };
}

// A voice is two oscillators now, and both of them have to be stopped or the
// bright one goes on running with nothing to switch it off
function stopVoice(voice, at) {
  voice.osc.stop(at);
  voice.bright.stop(at);
}

// Where that decay has got to at a given moment
function decayedTo({ sustain, from, tau }, at) {
  if (at <= from) return sustain;
  return Math.max(MIN_GAIN, MIN_GAIN + (sustain - MIN_GAIN) * Math.exp(-(at - from) / tau));
}

// Release a voice that is sounding now — safe to read the live gain value
function releaseNow(voice, fade = RELEASE_S) {
  const c = getAudioContext();
  const t = c.currentTime;
  const g = voice.gain.gain;
  try {
    const current = Math.max(g.value, MIN_GAIN);
    g.cancelScheduledValues(t);
    g.setValueAtTime(current, t);
    g.exponentialRampToValueAtTime(MIN_GAIN, t + fade);
    stopVoice(voice, t + fade + 0.05);
  } catch (_) {}
}

// ── Live monitoring (MIDI input) ─────────────────────────────────────────────

// Sounding what the player is playing, as against what the app is playing at
// them. Somebody going through a VST or a hardware voice already hears their
// own keys and does not want them doubled — but they still want the piece, the
// prompts and the click, so this is its own switch rather than a corner of the
// volume. Nothing else changes: playback and the metronome have their own paths
// to the output and never come through here.
export function monitorNoteOn(pitch, velocity = 90) {
  if (!state.ui.monitorEnabled) return;
  noteOn(pitch, velocity);
}

// Switched off mid-phrase, it should go quiet at once rather than hanging on
// until the player happens to lift their hands. What they are holding is
// exactly what the monitor is sounding.
export function silenceMonitored() {
  for (const pitch of [...state.midi.activeNotes]) noteOff(pitch);
}

export function noteOn(pitch, velocity = 90) {
  const c = getAudioContext();
  if (c.state === 'suspended') c.resume();
  // Retrigger cleanly if the same pitch is already held
  if (liveVoices.has(pitch)) releaseNow(liveVoices.get(pitch), 0.03);
  const voice = createVoice(pitch, velocity, c.currentTime);
  applyAttack(voice, c.currentTime);
  liveVoices.set(pitch, voice);
}

export function noteOff(pitch) {
  const voice = liveVoices.get(pitch);
  if (!voice) return;
  liveVoices.delete(pitch);
  releaseNow(voice);
}

// ── Scheduled playback ───────────────────────────────────────────────────────

let pumpTimer = null;
let anchorCtxTime = 0; // ctx.currentTime when playback was anchored
let anchorMs = 0;      // composition position at that moment
let scheduledUpToMs = 0;
let playUntilMs = Infinity; // past this, notes belong to whatever comes next

// Composition ms → audio context time, honouring the speed multiplier
function ctxTimeFor(compMs, speed) {
  return anchorCtxTime + (compMs - anchorMs) / (1000 * speed);
}

// Normally the piece. Set to something else — a recording of what the player
// just did — to hear that instead, on the same clock and through the same
// scheduler, so a replay is not a second sound path that can drift from the
// first one.
let playbackSource = null;

export function setPlaybackSource(notes) {
  playbackSource = notes && notes.length ? notes : null;
}

// ── The damper ───────────────────────────────────────────────────────────────
//
// A note stops sounding when its key comes up *and* the pedal is up. Playing a
// pedalled performance without this sounds it detached: the Schubert recording
// these were built against holds its damper off the strings for 60% of its
// length, and the app was cutting every note at the key release.
//
// Worked out once for a piece rather than per note, because a run of that piece
// asks it of sixteen thousand of them. Rebuilt when the pedal list changes,
// which is on import and on load, and never during playback.
let spans = [];
let spansFrom = null;

function damperSpans() {
  const pedal = state.composition.pedal;
  if (pedal !== spansFrom) {
    spansFrom = pedal;
    spans = sustainSpans(pedal || []);
  }
  return spans;
}

// A replay is what the player pressed, and their own feet were not recorded —
// so a take rings for as long as the keys were held and no longer.
const pedalled = () => !playbackSource && damperSpans().length > 0;

function pump() {
  const c = getAudioContext();
  const speed = state.transport.speed || 1;
  const nowMs = anchorMs + (c.currentTime - anchorCtxTime) * 1000 * speed;
  const horizonMs = nowMs + LOOKAHEAD_MS * speed;
  if (horizonMs <= scheduledUpToMs) return;

  for (const note of (playbackSource || state.composition.notes)) {
    if (note.startTime < scheduledUpToMs || note.startTime >= horizonMs) continue;
    if (!isAudible(note)) continue;
    // A bounded stretch runs a little past its last barline so the note it
    // ends on can ring. That is room for one note to finish, not for the next
    // section's to begin — and asked through atOrPast, so the section sounds
    // the same notes its walk is about to ask for.
    if (atOrPast(note.startTime, playUntilMs)) continue;
    const when = Math.max(ctxTimeFor(note.startTime, speed), c.currentTime);
    const keyUp = note.startTime + note.duration;
    const stops = pedalled() ? soundingEnd(damperSpans(), keyUp) : keyUp;
    scheduleVoice(note.pitch, note.velocity ?? 90, when, (stops - note.startTime) / (1000 * speed));
  }
  scheduledUpToMs = horizonMs;
}

// A whole note, envelope and all, planned up front against `when`. Reading the
// live gain value to build a release for a note that has not started yet is
// what stepped the gain from peak straight to silence and clicked at every
// note edge.
//
// Exported for the offline renderer, which needs exactly this and on its own
// context — so what a transcription test listens to is what the speakers play.
export function playNoteAt(voice, when, durSec) {
  const plan = applyAttack(voice, when);
  const g = voice.gain.gain;

  // Pick the release up from wherever the string had got to, then damp it.
  // Without this anchor the release would ramp from the wrong level and step
  // the waveform, which is what clicked at every note edge.
  const releaseAt = when + Math.max(durSec, ATTACK_S + DECAY_S);
  g.setValueAtTime(decayedTo(plan, releaseAt), releaseAt);
  g.exponentialRampToValueAtTime(MIN_GAIN, releaseAt + RELEASE_S);
  stopVoice(voice, releaseAt + RELEASE_S + 0.05);
  return releaseAt + RELEASE_S + 0.05;
}

function scheduleVoice(pitch, velocity, when, durSec) {
  const voice = createVoice(pitch, velocity, when);
  playNoteAt(voice, when, durSec);
  scheduledVoices.add(voice);
  return voice;
}

// Notes are started from `fromMs` up to but not including `untilMs`, which is
// the end of the stretch being played rather than the moment playback stops —
// the two differ by the tail a bounded section rings out into.
export function startPlaybackAudio(fromMs, untilMs = Infinity) {
  const c = getAudioContext();
  if (c.state === 'suspended') c.resume();
  stopPlaybackAudio();
  anchorCtxTime = c.currentTime;
  anchorMs = fromMs;
  playUntilMs = untilMs;
  // The same tolerance at this end, so a note written on the barline a section
  // starts on is not left behind by having drifted a hair in front of it
  scheduledUpToMs = fromMs - EDGE_MS;
  pumpTimer = setInterval(pump, PUMP_INTERVAL_MS);
  pump();
}

export function stopPlaybackAudio() {
  clearInterval(pumpTimer);
  pumpTimer = null;
  // Notes already queued in the graph have to be cut explicitly, and faded
  // rather than hard-stopped or the cut itself clicks
  for (const voice of scheduledVoices) releaseNow(voice, 0.05);
  scheduledVoices.clear();
}

export function stopAllAudio() {
  stopPlaybackAudio();
  for (const [, voice] of liveVoices) releaseNow(voice);
  liveVoices.clear();
}
