// Web Audio output: live note monitoring and scheduled playback.
// Everything routes through one master gain so mute is a single switch.
import { state } from './state.js';

let ctx = null;
let master = null;

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

export function getAudioContext() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = state.ui.muted ? 0 : 1;

    // Keeps a dense chord from summing into the clipping ceiling, the other
    // half of what made playback sound harsh
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 20;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;

    master.connect(comp);
    comp.connect(ctx.destination);

    // A silent source keeps the graph rendering. Without something pulling it,
    // gain automation stalls while nothing is playing, so a mute fade would
    // only resume — and audibly leak — once the next note started.
    const keepAlive = ctx.createConstantSource();
    keepAlive.offset.value = 0;
    keepAlive.connect(master);
    keepAlive.start();
  }
  return ctx;
}

export function getMasterGain() {
  getAudioContext();
  return master;
}

export function resumeAudioContext() {
  const c = getAudioContext();
  if (c.state === 'suspended') c.resume();
}

export function setMuted(muted) {
  // Don't force the context into existence before a user gesture — it is
  // created with the current mute state anyway
  if (!ctx) return;
  // Ramp rather than jump, so muting mid-note doesn't click
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.008);
}

function midiToFreq(pitch) {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

function peakFor(velocity) {
  const v = Math.min(127, Math.max(1, velocity)) / 127;
  return 0.04 + v * 0.11;
}

// Oscillator → lowpass → envelope gain → master
function createVoice(pitch, velocity, when) {
  const c = getAudioContext();
  const osc = c.createOscillator();
  const filter = c.createBiquadFilter();
  const gain = c.createGain();
  const freq = midiToFreq(pitch);

  osc.type = 'triangle';
  osc.frequency.value = freq;

  // Roll the upper harmonics off relative to the note, so high notes stay
  // bright and low ones don't buzz
  filter.type = 'lowpass';
  filter.frequency.value = Math.min(6000, Math.max(900, freq * 6));
  filter.Q.value = 0.7;

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(getMasterGain());

  const voice = { osc, gain, filter, peak: peakFor(velocity) };
  osc.addEventListener('ended', () => {
    try { osc.disconnect(); filter.disconnect(); gain.disconnect(); } catch (_) {}
    scheduledVoices.delete(voice);
  });
  osc.start(when);
  return voice;
}

function applyAttack(voice, when) {
  const g = voice.gain.gain;
  const sustain = Math.max(voice.peak * SUSTAIN_RATIO, MIN_GAIN);
  g.cancelScheduledValues(when);
  g.setValueAtTime(MIN_GAIN, when);
  g.exponentialRampToValueAtTime(voice.peak, when + ATTACK_S);
  g.exponentialRampToValueAtTime(sustain, when + ATTACK_S + DECAY_S);
  return sustain;
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
    voice.osc.stop(t + fade + 0.05);
  } catch (_) {}
}

// ── Live monitoring (MIDI input) ─────────────────────────────────────────────

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

// Composition ms → audio context time, honouring the speed multiplier
function ctxTimeFor(compMs, speed) {
  return anchorCtxTime + (compMs - anchorMs) / (1000 * speed);
}

function pump() {
  const c = getAudioContext();
  const speed = state.transport.speed || 1;
  const nowMs = anchorMs + (c.currentTime - anchorCtxTime) * 1000 * speed;
  const horizonMs = nowMs + LOOKAHEAD_MS * speed;
  if (horizonMs <= scheduledUpToMs) return;

  for (const note of state.composition.notes) {
    if (note.startTime < scheduledUpToMs || note.startTime >= horizonMs) continue;
    const when = Math.max(ctxTimeFor(note.startTime, speed), c.currentTime);
    scheduleVoice(note.pitch, note.velocity ?? 90, when, note.duration / (1000 * speed));
  }
  scheduledUpToMs = horizonMs;
}

// The whole envelope is planned up front against `when`. Reading the live gain
// value to build a release for a note that has not started yet is what stepped
// the gain from peak straight to silence and clicked at every note edge.
function scheduleVoice(pitch, velocity, when, durSec) {
  const voice = createVoice(pitch, velocity, when);
  const sustain = applyAttack(voice, when);
  const g = voice.gain.gain;

  // Hold at the sustain level until the note ends, then release. Without this
  // anchor the release would ramp from the end of the decay instead.
  const releaseAt = when + Math.max(durSec, ATTACK_S + DECAY_S);
  g.setValueAtTime(sustain, releaseAt);
  g.exponentialRampToValueAtTime(MIN_GAIN, releaseAt + RELEASE_S);
  voice.osc.stop(releaseAt + RELEASE_S + 0.05);

  scheduledVoices.add(voice);
  return voice;
}

export function startPlaybackAudio(fromMs) {
  const c = getAudioContext();
  if (c.state === 'suspended') c.resume();
  stopPlaybackAudio();
  anchorCtxTime = c.currentTime;
  anchorMs = fromMs;
  scheduledUpToMs = fromMs;
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
