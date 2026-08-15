// Web Audio API metronome with look-ahead scheduling
import { state } from './state.js';
import { getAudioContext, getClickBus } from './audio.js';

let schedulerTimer = null;
let nextBeatTime = 0;
let beatCount = 0;

const LOOKAHEAD_MS = 100;
const SCHEDULE_INTERVAL_MS = 25;

// Clicks run on their own bus under the same master, so mute and volume cover
// them while "clicks only" — which closes the note bus — leaves them audible
function getAudioCtx() { return getAudioContext(); }

function scheduleClick(time, isDownbeat) {
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(getClickBus());

  osc.frequency.value = isDownbeat ? 1200 : 800;
  gain.gain.setValueAtTime(0.3, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

  osc.start(time);
  osc.stop(time + 0.05);
  osc.addEventListener('ended', () => { osc.disconnect(); gain.disconnect(); });
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

// Exactly `beats` clicks for a count-in, independent of the metronome toggle —
// the count-in has to be audible even with the metronome off. Returns the lead
// time in seconds before the first click, so the caller can line its countdown
// up with the audio.
export function scheduleCountInClicks(beats, tempo, timeSignature) {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();

  const lead = 0.12;
  const interval = 60 / tempo;
  const perBar = Math.max(1, timeSignature.numerator);

  for (let i = 0; i < beats; i++) {
    scheduleClick(ctx.currentTime + lead + i * interval, i % perBar === 0);
  }
  return lead;
}
