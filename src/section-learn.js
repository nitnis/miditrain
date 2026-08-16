// Walking a piece section by section.
//
// Each section runs the same three beats: hear it played through, walk it one
// attack at a time, then choose what to do about it. Hearing it first is the
// point — learn mode alone tells you which key is next but never what the
// passage is supposed to sound like.
//
// This coordinates rather than implements: the preview is ordinary playback,
// the walk is learn mode, and training a section is the training session that
// already takes a bar range. It owns only the order they happen in.
import { state, update, emit, on } from './state.js';
import { playRange, stop } from './transport.js';
import { startLearn, stopLearn } from './learn.js';
import { barRangeMs } from './quantizer.js';
import { loopBars } from './range.js';
import { isPractised } from './hands.js';

let sections = [];
let index = 0;
let phase = 'idle';      // idle | preview | walking | asking
let listeners = [];

// Bars that actually contain notes, chunked. A section of rests would stop the
// walk dead with nothing to play.
//
// A marked loop narrows what gets chunked. It is the app's way of naming a
// stretch of bars — training and plain learn mode both practise it — and a walk
// that marched through the whole piece regardless was the odd one out.
export function buildSections(barsPerSection) {
  // Only the hand being practised counts: a section of nothing but the other
  // hand's notes has nothing in it to walk
  const notes = state.composition.notes.filter(isPractised);
  if (!notes.length || barsPerSection < 1) return [];

  const { tempo, timeSignature } = state.composition;
  const barMs = barRangeMs(1, 1, tempo, timeSignature).endMs;
  if (!barMs) return [];

  const barOf = (ms) => Math.floor(ms / barMs) + 1;
  let firstBar = barOf(Math.min(...notes.map(n => n.startTime)));
  let lastBar = barOf(Math.max(...notes.map(n => n.startTime)));

  const marked = loopBars();
  if (marked) {
    firstBar = Math.max(firstBar, marked.startBar);
    lastBar = Math.min(lastBar, marked.endBar);
    if (lastBar < firstBar) return [];
  }

  const out = [];
  for (let bar = firstBar; bar <= lastBar; bar += barsPerSection) {
    const endBar = Math.min(lastBar, bar + barsPerSection - 1);
    const has = notes.some(n => barOf(n.startTime) >= bar && barOf(n.startTime) <= endBar);
    if (has) out.push({ startBar: bar, endBar });
  }
  return out;
}

export function startSectionWalk(barsPerSection) {
  sections = buildSections(barsPerSection);
  if (!sections.length) return 0;
  index = 0;
  beginPreview();
  return sections.length;
}

export function isWalking() { return phase !== 'idle'; }
export function currentSection() { return sections[index] || null; }

export function stopSectionWalk() {
  release();
  phase = 'idle';
  emit('sections:end');
}

// ── The three beats of a section ─────────────────────────────────────────────

function release() {
  listeners.forEach(off => off());
  listeners = [];
}

function beginPreview() {
  release();
  phase = 'preview';
  const section = sections[index];
  const range = rangeFor(section);
  emit('sections:preview', { ...section, index, total: sections.length });

  playRange(range.startMs, range.endMs + range.tailMs);
  // Registered after playRange, which stops whatever was running and would
  // otherwise trip this listener with its own transport:stop
  listeners = [on('transport:stop', () => {
    release();
    // Reaching the end is the preview finishing; anything earlier is the player
    // stopping it, and that should end the walk rather than march on
    if (state.transport.currentTime >= range.endMs) beginWalk();
    else stopSectionWalk();
  })];
}

function beginWalk() {
  release();
  phase = 'walking';
  const section = sections[index];
  update('transport.currentTime', rangeFor(section).startMs);
  emit('sections:walk', { ...section, index, total: sections.length });

  if (!startLearn(section)) { advanceSection(); return; }
  listeners = [
    on('learn:complete', () => {
      release();
      phase = 'asking';
      emit('sections:done', {
        ...sections[index],
        index,
        total: sections.length,
        last: index === sections.length - 1,
      });
    }),
    // Learn ends either way. Finishing emits learn:complete first, which
    // releases both of these, so this only fires when the walk was cut short.
    on('transport:stop', () => stopSectionWalk()),
  ];
}

function rangeFor({ startBar, endBar }) {
  const { tempo, timeSignature } = state.composition;
  return barRangeMs(startBar, endBar, tempo, timeSignature);
}

// ── What the player chose ────────────────────────────────────────────────────

export function repeatSection() {
  if (phase !== 'asking') return;
  beginPreview();
}

export function advanceSection() {
  if (index >= sections.length - 1) {
    const total = sections.length;
    stopSectionWalk();
    emit('sections:complete', { total });
    return;
  }
  index += 1;
  beginPreview();
}

// Training takes the transport over, so the walk steps aside rather than
// competing for it. Its bars are handed back for the caller to train.
export function handOverForTraining() {
  const section = sections[index];
  release();
  phase = 'idle';
  stopLearn();
  stop();
  return section;
}
