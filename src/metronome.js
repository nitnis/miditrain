// Web Audio API metronome with look-ahead scheduling
import { state } from './state.js';

let audioCtx = null;
let schedulerTimer = null;
let nextBeatTime = 0;
let beatCount = 0;

const LOOKAHEAD_MS = 100;
const SCHEDULE_INTERVAL_MS = 25;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function scheduleClick(time, isDownbeat) {
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.frequency.value = isDownbeat ? 1200 : 800;
  gain.gain.setValueAtTime(0.3, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

  osc.start(time);
  osc.stop(time + 0.05);
}

function scheduler() {
  if (!state.ui.metronomeEnabled) return;

  const ctx = getAudioCtx();
  const { tempo, timeSignature } = state.composition;
  const beatInterval = 60 / tempo;
  const beatsPerBar = timeSignature.numerator;

  while (nextBeatTime < ctx.currentTime + LOOKAHEAD_MS / 1000) {
    const isDownbeat = beatCount % beatsPerBar === 0;
    scheduleClick(nextBeatTime, isDownbeat);
    nextBeatTime += beatInterval;
    beatCount++;
  }
}

export function startMetronome(offsetMs = 0) {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();

  beatCount = 0;
  nextBeatTime = ctx.currentTime + offsetMs / 1000;

  clearInterval(schedulerTimer);
  schedulerTimer = setInterval(scheduler, SCHEDULE_INTERVAL_MS);
  scheduler();
}

export function stopMetronome() {
  clearInterval(schedulerTimer);
  schedulerTimer = null;
}

export function resumeAudioContext() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

export function scheduleNotePreview(pitch, durationMs) {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();

  const freq = 440 * Math.pow(2, (pitch - 69) / 12);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'triangle';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.2, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + durationMs / 1000 + 0.05);
}
