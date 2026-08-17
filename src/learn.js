// Learn mode: walk the piece one attack at a time.
//
// The notes fall at tempo until the next one reaches the hit line, then
// everything freezes: the chord sounds once as a prompt, and the clock does
// not move again until exactly those keys have been played.
//
// This is much closer to step recording than to playback — an input-driven
// mode with its own clock — so it runs beside transport.js rather than through
// it, and cleans itself up when something else takes the transport, the same
// way the step recorder does.
//
// Set a cluster size and it walks in three passes instead of one. See below.
import { state, update, emit, on } from './state.js';
import { noteOn, noteOff, resumeAudioContext } from './audio.js';
import { barRangeMs } from './quantizer.js';
import { loopBars, loopRangeMs } from './range.js';
import { isPractised } from './hands.js';

// Notes struck this close together are one thing to play, so they are waited
// on together. Matches the tolerance the slur renderer uses for "same attack".
const CHORD_MS = 40;

// How long the prompt chord sounds if nothing interrupts it. It steps aside
// the moment the first correct key goes down, so this is only the ceiling.
const PROMPT_MIN_MS = 250;
const PROMPT_MAX_MS = 900;

let groups = [];        // [{ startMs, durationMs, pitches:Set, notes:[] }]
let index = -1;
let pending = new Set();  // pitches of the current group not currently held
// Notes struck since arriving at this group and still down. A chord counts as
// played when every one of its notes is held at the same moment, so this is
// emptied on arrival — a key left down from the previous group has to be
// released and struck again, which is what a repeated note asks for anyway.
let struck = new Set();
let prompting = [];       // pitches the prompt is holding down
let promptTimer = null;
let rafId = null;         // non-null only while the notes are falling
let perfStart = 0;
let posStart = 0;
let targetMs = 0;
let cleanupFns = [];

// Section practice. The loop range is already the app's way of naming a
// stretch of bars, so learn mode reads the same one — with loop on it repeats
// the section until you get through it without a wrong note, rather than
// looping forever the way playback does.
let sectionStartMs = 0;
let looping = false;
let pass = 1;
let slips = 0;          // wrong notes in the current pass

// ── Clusters ─────────────────────────────────────────────────────────────────
// Note by note teaches you where the keys are. It does not teach you the shape
// of a phrase, because you never play more than one thing at a time and never
// have to remember what came before. So a cluster — half a beat, a beat, a bar
// — is learned in three passes:
//
//   listen   the cluster plays itself, once, in time
//   guided   it comes round again in silence, one attack at a time, waiting;
//            the only sound is the player's own
//   memory   nothing falls and nothing is highlighted. Play it again from
//            memory. A wrong note and the cluster starts over from listen.
//
// The last pass is the one that does the work: it is the first time the player
// has to produce the phrase rather than react to it.

export const CLUSTERS = {
  off:      { name: 'Note by note' },
  halfBeat: { name: 'Half-beat clusters', beats: 0.5 },
  beat:     { name: 'One-beat clusters',  beats: 1 },
  twoBeats: { name: 'Two-beat clusters',  beats: 2 },
  bar:      { name: 'One-bar clusters',   bars: 1 },
  twoBars:  { name: 'Two-bar clusters',   bars: 2 },
};

let clusters = [];      // [{ from, to, startMs, endMs }] — indices into groups
let clusterIndex = 0;
let phase = 'walk';     // walk | listen | guided | memory
let listenAt = 0;       // the next group the listen pass has still to sound
let hinting = false;    // the memory pass is showing where to start
let holding = null;     // a message being read; input waits for it

// Long enough to read and to land, short enough not to be in the way
const GOOD_MS = 1000;
const ALMOST_MS = 1000;

export function clusterMs() {
  const choice = CLUSTERS[state.ui.learnCluster];
  if (!choice || !(choice.beats || choice.bars)) return 0;
  const { tempo, timeSignature } = state.composition;
  const beatMs = (60 / tempo) * 1000;
  const beatsPerBar = timeSignature.numerator * (4 / timeSignature.denominator);
  return (choice.bars ? choice.bars * beatsPerBar : choice.beats) * beatMs;
}

// Clusters sit on the metrical grid — a one-bar cluster is a bar, not the first
// bar's worth of notes wherever they happen to start. A window with nothing in
// it is not a cluster at all, so silence is skipped rather than sat through.
//
// The last one is the whole section, played the same three ways. Learning a
// passage a bar at a time and never once playing it through is how people end
// up able to play every bar of something and not the thing itself — the joins
// are the hard part, and nothing before this pass has asked for them.
function buildClusters() {
  const size = clusterMs();
  if (!size || !groups.length) return [];
  const out = [];
  let from = 0;
  while (from < groups.length) {
    const edge = (Math.floor(groups[from].startMs / size) + 1) * size;
    let to = from;
    while (to + 1 < groups.length && groups[to + 1].startMs < edge - 0.5) to += 1;
    out.push({ from, to, startMs: edge - size, endMs: edge });
    from = to + 1;
  }
  // Only worth doing when the section was actually broken up; one cluster and
  // the whole section are the same pass twice
  if (out.length > 1) {
    out.push({
      from: 0,
      to: groups.length - 1,
      startMs: out[0].startMs,
      endMs: out[out.length - 1].endMs,
      whole: true,
    });
  }
  return out;
}

// How many of them are pieces of the section rather than the section itself
function pieceCount() {
  return clusters.filter(c => !c.whole).length;
}

function cluster() { return clusters[clusterIndex] || null; }

// One entry per attack, in time order
export function groupAttacks(notes) {
  const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);
  const out = [];
  for (const note of sorted) {
    const last = out[out.length - 1];
    // Measured against the group's own start, so a run of notes 40ms apart
    // cannot chain into one arbitrarily wide chord
    if (last && note.startTime - last.startMs <= CHORD_MS) {
      last.pitches.add(note.pitch);
      last.notes.push(note);
      last.durationMs = Math.max(last.durationMs, note.duration);
    } else {
      out.push({
        startMs: note.startTime,
        durationMs: note.duration,
        pitches: new Set([note.pitch]),
        notes: [note],
      });
    }
  }
  return out;
}

// `bars` walks just that stretch and leaves the repeat-until-clean behaviour
// off — the section walk offers its own choice at the end of each one. With no
// bars given it falls back to the loop range, which is the standalone drill.
export function startLearn(bars = null) {
  if (state.transport.mode === 'learning') return false;

  const { tempo, timeSignature } = state.composition;
  const section = bars
    ? barRangeMs(bars.startBar, bars.endBar, tempo, timeSignature)
    : loopRangeMs();
  sectionStartMs = section ? section.startMs : 0;
  // Practising one hand walks only that hand's attacks — the other hand's
  // notes are not waited on and not prompted
  groups = groupAttacks(state.composition.notes.filter(isPractised))
    .filter(g => !section || (g.startMs >= section.startMs && g.startMs < section.endMs));
  if (!groups.length) return false;

  clusters = buildClusters();
  // Each cluster already repeats until it is right, so the repeat-until-clean
  // pass would be a loop around a loop
  looping = Boolean(section) && !bars && !clusters.length;
  phase = clusters.length ? 'listen' : 'walk';
  clusterIndex = 0;

  resumeAudioContext();
  releaseListeners();
  index = -1;
  pass = 1;
  slips = 0;
  struck.clear();
  update('transport.currentTime', sectionStartMs);
  update('transport.mode', 'learning');
  // Registered after the mode change, so entering the mode cannot trip the
  // listener that exists to notice something else leaving it
  cleanupFns = [
    on('midi:noteon', handleNoteOn),
    on('midi:noteoff', handleNoteOff),
    on('change:transport.mode', ({ value }) => { if (value !== 'learning') finish(false); }),
  ];
  emit('transport:learn', {
    total: groups.length,
    looping,
    startBar: bars ? bars.startBar : (looping ? loopBars().startBar : null),
    endBar: bars ? bars.endBar : (looping ? loopBars().endBar : null),
    walking: Boolean(bars),
    clusters: clusters.length,
  });
  if (clusters.length) beginCluster(0);
  else goTo(0);
  return true;
}

// ── The three passes ─────────────────────────────────────────────────────────

// The banner over the falling window. learn.js says what happened; the words
// are the interface's business.
function say(tone) {
  emit('learn:say', { tone: tone || null });
}

function hold(ms, then) {
  clearTimeout(holding);
  holding = setTimeout(() => { holding = null; then(); }, ms);
}

function announcePhase() {
  emit('learn:phase', {
    phase,
    cluster: clusterIndex,
    clusters: pieceCount(),
    whole: Boolean(cluster() && cluster().whole),
    // Nothing may be shown while it is being played from memory — not the
    // falling notes and not the chord being spelled out at the top of them
    blind: phase === 'memory',
  });
}

function beginCluster(k) {
  clearPrompt();
  clearTimeout(holding);
  holding = null;
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  clusterIndex = k;
  if (k >= clusters.length) { finish(true); return; }

  say(null);
  hinting = false;
  phase = 'listen';
  listenAt = clusters[k].from;
  index = clusters[k].from;
  pending.clear();
  struck.clear();
  posStart = clusters[k].startMs;
  targetMs = clusters[k].endMs;
  perfStart = performance.now();
  update('transport.currentTime', posStart);
  emit('transport:tick', posStart);
  announcePhase();
  announce();
  rafId = requestAnimationFrame(listen);
}

// The cluster plays itself through, in time, with the notes falling
function listen() {
  const t = posStart + (performance.now() - perfStart) * (state.transport.speed || 1);
  const here = cluster();
  if (!here) { rafId = null; return; }

  while (listenAt <= here.to && groups[listenAt].startMs <= t) {
    playPrompt(groups[listenAt]);
    listenAt += 1;
  }
  update('transport.currentTime', Math.min(t, targetMs));
  emit('transport:tick', Math.min(t, targetMs));

  if (t >= targetMs) { rafId = null; beginGuided(); return; }
  rafId = requestAnimationFrame(listen);
}

// Round again in silence, one attack at a time
function beginGuided() {
  phase = 'guided';
  index = cluster().from - 1;
  struck.clear();
  update('transport.currentTime', cluster().startMs);
  emit('transport:tick', cluster().startMs);
  announcePhase();
  goTo(cluster().from);
}

// Now without the guide — except for where to start. A phrase you cannot find
// the first note of is not a memory test, it is a guessing game, so the opening
// note or chord is lit and sounded once and everything after it is on you.
function beginMemory() {
  clearPrompt();
  phase = 'memory';
  say(cluster().whole ? 'memoryWhole' : 'memory');
  announcePhase();
  stepMemory(cluster().from);
  playPrompt(groups[cluster().from]);
}

function stepMemory(i) {
  index = i;
  hinting = i === cluster().from;
  struck.clear();
  pending = new Set(groups[i].pitches);
  announce();
}

export function stopLearn() {
  finish(false);
}

export function getLearnProgress() {
  if (!groups.length || index < 0) return null;
  return { done: index, total: groups.length, pending: [...pending], looping, pass, slips };
}

function releaseListeners() {
  cleanupFns.forEach(fn => fn());
  cleanupFns = [];
}

function finish(completed) {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  clearTimeout(holding);
  holding = null;
  hinting = false;
  say(null);
  clearPrompt();
  releaseListeners();
  pending.clear();
  // Whatever was being hidden for the memory pass comes back
  if (phase !== 'walk') { phase = 'walk'; emit('learn:phase', { phase, blind: false }); }
  emit('learn:waiting', { pitches: [], done: index, total: groups.length, looping, pass, slips });
  if (completed) {
    emit('learn:pass', { pass, slips, clean: slips === 0, total: groups.length });
    emit('learn:complete', { total: groups.length, passes: pass, looping, clusters: pieceCount() });
  }
  // Already out of the mode when something else stopped us — saying so twice
  // would bounce back through the mode listener
  if (state.transport.mode === 'learning') {
    update('transport.mode', 'stopped');
    emit('transport:stop');
  }
}

function goTo(i) {
  // End of the cluster hands over to playing it from memory
  if (phase === 'guided' && i > cluster().to) { beginMemory(); return; }

  // End of the section. Looping means going again until a pass is clean —
  // "correctly" can only mean without a wrong note, since learn mode will not
  // move past a note until the right one is played anyway.
  if (i >= groups.length) {
    if (looping && slips > 0) { restartPass(); return; }
    finish(true);
    return;
  }

  index = i;

  pending = new Set(groups[i].pitches);
  targetMs = groups[i].startMs;
  perfStart = performance.now();
  posStart = state.transport.currentTime;

  if (posStart >= targetMs) { arrive(); return; }
  rafId = requestAnimationFrame(fall);
}

// The only time the clock moves: between one attack and the next
function fall() {
  const t = posStart + (performance.now() - perfStart) * (state.transport.speed || 1);
  if (t >= targetMs) { arrive(); return; }
  update('transport.currentTime', t);
  emit('transport:tick', t);
  rafId = requestAnimationFrame(fall);
}

function arrive() {
  rafId = null;
  struck.clear();
  refreshPending();
  update('transport.currentTime', targetMs);
  emit('transport:tick', targetMs);
  // The guided pass is deliberately silent: the cluster has just been heard,
  // and the only sound now should be the player's own
  if (phase !== 'guided') playPrompt(groups[index]);
  announce();
}

function refreshPending() {
  pending = new Set([...groups[index].pitches].filter(p => !struck.has(p)));
}

function restartPass() {
  clearPrompt();
  emit('learn:pass', { pass, slips, clean: false, total: groups.length });
  pass += 1;
  slips = 0;
  index = -1;
  update('transport.currentTime', sectionStartMs);
  goTo(0);
}

function announce() {
  const here = cluster();
  emit('learn:waiting', {
    // Nothing is highlighted while it is being played from memory, and nothing
    // is highlighted while the cluster is playing itself either
    pitches: phase === 'listen' || (phase === 'memory' && !hinting) ? [] : [...pending],
    done: index,
    total: groups.length,
    looping,
    pass,
    slips,
    phase,
    cluster: here
      ? { index: clusterIndex, total: pieceCount(), from: here.from, to: here.to, whole: Boolean(here.whole) }
      : null,
  });
}

function playPrompt(group) {
  clearPrompt();
  for (const note of group.notes) {
    noteOn(note.pitch, note.velocity ?? 90);
    prompting.push(note.pitch);
  }
  const ms = Math.min(PROMPT_MAX_MS, Math.max(PROMPT_MIN_MS, group.durationMs));
  promptTimer = setTimeout(clearPrompt, ms);
}

function clearPrompt() {
  clearTimeout(promptTimer);
  promptTimer = null;
  for (const pitch of prompting) {
    // A pitch the player is holding is theirs now — the prompt and the live
    // monitor share one voice per pitch, so releasing it would cut their note
    if (!state.midi.activeNotes.has(pitch)) noteOff(pitch);
  }
  prompting = [];
}

function handleNoteOn({ pitch }) {
  // Input counts only at the wait, never while the notes are still falling and
  // never while a message is still being read
  if (state.transport.mode !== 'learning' || rafId !== null || holding) return;
  if (!groups[index]) return;

  if (!groups[index].pitches.has(pitch)) {
    slips += 1;
    emit('learn:wrong', { pitch, slips });
    // A wrong note from memory means it is not learned yet, so the cluster
    // goes back to being played to you — after long enough to read why
    if (phase === 'memory') {
      clearPrompt();
      hinting = false;
      announce();
      say('almost');
      const k = clusterIndex;
      hold(ALMOST_MS, () => beginCluster(k));
      return;
    }
    if (looping) announce();
    return;
  }

  clearPrompt(); // the prompt steps aside as soon as the player starts
  struck.add(pitch);
  refreshPending();
  emit('learn:hit', { pitch });
  // Together, not one at a time: the step only passes while every note of it
  // is down at once
  if (pending.size === 0) advance();
  else announce();
}

function advance() {
  if (phase !== 'memory') { goTo(index + 1); return; }
  if (index >= cluster().to) {
    clearPrompt();
    pending.clear();
    announce();
    say('good');
    const next = clusterIndex + 1;
    hold(GOOD_MS, () => beginCluster(next));
    return;
  }
  stepMemory(index + 1);
}

// Letting go of part of a chord un-plays it, so the highlight comes back and
// the step waits again rather than banking the notes already pressed
function handleNoteOff({ pitch }) {
  if (state.transport.mode !== 'learning' || rafId !== null || holding) return;
  if (!groups[index]) return;
  if (!struck.delete(pitch)) return;
  refreshPending();
  announce();
}
