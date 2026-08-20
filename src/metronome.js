// Web Audio API metronome with look-ahead scheduling
import { state } from './state.js';
import { getAudioContext, getClickBus } from './audio.js';

let schedulerTimer = null;
let nextTickTime = 0;
let tickCount = 0;

const LOOKAHEAD_MS = 100;
const SCHEDULE_INTERVAL_MS = 25;

// Three weights, so the bar has a shape: the downbeat lands hardest, the other
// beats sit under it, and a subdivision is a light tick you can follow without
// it competing with the beat it divides.
const CLICKS = {
  downbeat: { freq: 1400, gain: 0.34, decay: 0.045 },
  beat:     { freq: 900,  gain: 0.26, decay: 0.040 },
  sub:      { freq: 1750, gain: 0.09, decay: 0.022 },
};

// Clicks run on their own bus under the same master, so mute and volume cover
// them while "clicks only" — which closes the note bus — leaves them audible
function getAudioCtx() { return getAudioContext(); }

function scheduleClick(time, kind) {
  const { freq, gain: peak, decay } = CLICKS[kind] || CLICKS.beat;
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(getClickBus());

  osc.frequency.value = freq;
  gain.gain.setValueAtTime(peak, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + decay);

  osc.start(time);
  osc.stop(time + decay + 0.01);
  osc.addEventListener('ended', () => { osc.disconnect(); gain.disconnect(); });
}

// How many clicks to the beat, and what each of them is
export function subdivision() {
  return Math.max(1, Math.min(4, state.ui.metronomeSubdivision || 1));
}

export function clickKind(tick, subs, beatsPerBar) {
  if (tick % subs !== 0) return 'sub';
  return Math.floor(tick / subs) % beatsPerBar === 0 ? 'downbeat' : 'beat';
}

// A tick is counted in composition time, so tick 0 is the start of the piece
// and every downbeat lands on a bar line wherever playback happened to begin.
function tickMs() {
  return (60000 / state.composition.tempo) / subdivision();
}

// ...and heard in real time, which the speed control stretches
function realSeconds(ms) {
  return ms / 1000 / (state.transport.speed || 1);
}

function scheduler() {
  if (!state.ui.metronomeEnabled) return;

  const ctx = getAudioCtx();
  const beatsPerBar = Math.max(1, state.composition.timeSignature.numerator);
  const subs = subdivision();
  // Recomputed every pass, so changing the tempo or the subdivision takes
  // effect at the next tick rather than at the next bar
  const step = realSeconds(tickMs());

  while (nextTickTime < ctx.currentTime + LOOKAHEAD_MS / 1000) {
    scheduleClick(nextTickTime, clickKind(tickCount, subs, beatsPerBar));
    nextTickTime += step;
    tickCount++;
  }
}

// `positionMs` is where in the piece the transport is starting from; the first
// click is the next tick at or after it, so what you hear agrees with the beat
// the animation is showing.
// Where on the audio clock the beat after a count-in falls. The count-in
// schedules its clicks on that clock, but hands over on a wall-clock timer, and
// the two do not agree to better than a few tens of milliseconds — which lands
// as a stumble on the very first beat, exactly where a count-in is supposed to
// have made the pulse certain. Left here for startMetronome to pick up, so its
// grid continues the count-in's instead of restarting from whenever the
// hand-over timer happened to fire.
let handoverCtxTime = null;

// Only worth using while it is still about to happen. A count-in that was
// cancelled, or a start that has nothing to do with one, must not be pulled
// onto a stale anchor.
const HANDOVER_WINDOW_S = 0.25;

export function startMetronome(positionMs = 0) {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();

  const step = tickMs();
  const ticksIn = Math.max(0, positionMs) / step;
  tickCount = Math.ceil(ticksIn - 1e-6);

  const handover = handoverCtxTime;
  handoverCtxTime = null;
  const fresh = handover != null &&
    handover > ctx.currentTime - HANDOVER_WINDOW_S &&
    handover < ctx.currentTime + HANDOVER_WINDOW_S;
  const anchor = fresh ? handover : ctx.currentTime;
  nextTickTime = Math.max(ctx.currentTime, anchor + realSeconds((tickCount - ticksIn) * step));

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
// How long a beat actually lasts, in real milliseconds. The tempo is what the
// music is written at; the speed control is what it is being played at, and a
// count-in that ignores the second one counts you in at a pulse the music is
// not about to arrive at — which at half speed means coming in twice as fast
// as the first bar.
export function beatRealMs() {
  return realSeconds((60 / state.composition.tempo) * 1000) * 1000;
}

export function scheduleCountInClicks(beats, tempo, timeSignature) {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume();

  const lead = 0.12;
  const interval = realSeconds((60 / tempo) * 1000);
  const perBar = Math.max(1, timeSignature.numerator);

  // The count-in stays on plain beats: it is a countdown, and subdividing it
  // would make it harder to count rather than easier
  for (let i = 0; i < beats; i++) {
    scheduleClick(ctx.currentTime + lead + i * interval, i % perBar === 0 ? 'downbeat' : 'beat');
  }
  // The beat the music begins on, measured on the same clock the clicks were
  // scheduled against rather than on the timer that will announce it
  handoverCtxTime = ctx.currentTime + lead + beats * interval;
  return lead;
}
