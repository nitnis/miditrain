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
const RELEASE_S = 0.12;

export function getAudioContext() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = state.ui.muted ? 0 : 1;
    master.connect(ctx.destination);

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

// A voice is a triangle oscillator through its own envelope gain
function startVoice(pitch, velocity, when) {
  const c = getAudioContext();
  const osc = c.createOscillator();
  const gain = c.createGain();
  const peak = 0.05 + (Math.min(127, Math.max(1, velocity)) / 127) * 0.18;

  osc.type = 'triangle';
  osc.frequency.value = midiToFreq(pitch);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(peak, when + 0.012);

  osc.connect(gain);
  gain.connect(getMasterGain());
  osc.start(when);

  const voice = { osc, gain, peak };
  osc.addEventListener('ended', () => {
    try { osc.disconnect(); gain.disconnect(); } catch (_) {}
    scheduledVoices.delete(voice);
  });
  return voice;
}

function releaseVoice(voice, when) {
  const c = getAudioContext();
  const t = Math.max(when, c.currentTime);
  try {
    voice.gain.gain.cancelScheduledValues(t);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, t + RELEASE_S);
    voice.osc.stop(t + RELEASE_S + 0.02);
  } catch (_) {}
}

// ── Live monitoring (MIDI input) ─────────────────────────────────────────────

export function noteOn(pitch, velocity = 90) {
  const c = getAudioContext();
  if (c.state === 'suspended') c.resume();
  // Retrigger cleanly if the same pitch is already held
  if (liveVoices.has(pitch)) releaseVoice(liveVoices.get(pitch), c.currentTime);
  liveVoices.set(pitch, startVoice(pitch, velocity, c.currentTime));
}

export function noteOff(pitch) {
  const voice = liveVoices.get(pitch);
  if (!voice) return;
  liveVoices.delete(pitch);
  releaseVoice(voice, getAudioContext().currentTime);
}

// Sound a note for a fixed length — used where there is no note-off to wait
// for, such as a step-recorded chord
export function playNote(pitch, velocity, durationMs) {
  const c = getAudioContext();
  if (c.state === 'suspended') c.resume();
  const voice = startVoice(pitch, velocity, c.currentTime);
  scheduledVoices.add(voice);
  releaseVoice(voice, c.currentTime + durationMs / 1000);
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
    const when = ctxTimeFor(note.startTime, speed);
    const voice = startVoice(note.pitch, note.velocity ?? 90, Math.max(when, c.currentTime));
    scheduledVoices.add(voice);
    releaseVoice(voice, when + note.duration / (1000 * speed));
  }
  scheduledUpToMs = horizonMs;
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
  // Notes already queued in the graph have to be cut explicitly
  const c = getAudioContext();
  for (const voice of scheduledVoices) {
    try { voice.gain.gain.cancelScheduledValues(c.currentTime); } catch (_) {}
    try { voice.osc.stop(c.currentTime + 0.02); } catch (_) {}
  }
  scheduledVoices.clear();
}

export function stopAllAudio() {
  stopPlaybackAudio();
  for (const [, voice] of liveVoices) releaseVoice(voice, getAudioContext().currentTime);
  liveVoices.clear();
}
