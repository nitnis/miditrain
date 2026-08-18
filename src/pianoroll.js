// Falling notes canvas + 88-key piano keyboard display
import { state, on } from './state.js';
import { getAccuracyResults } from './accuracy.js';
import { setEditorLayout } from './note-editor.js';
import { handOf, isPractised, practiceHand } from './hands.js';
import { detectChord } from './chords.js';
import { subdivision } from './metronome.js';

// Piano layout constants
const MIDI_MIN = 21; // A0
const MIDI_MAX = 108; // C8
const TOTAL_KEYS = MIDI_MAX - MIDI_MIN + 1;

// Which MIDI pitch classes are white keys
const IS_WHITE = [true, false, true, false, true, true, false, true, false, true, false, true];
// C, C#, D, D#, E, F, F#, G, G#, A, A#, B

// Pitch-class colors, used by the piano roll grid
const PC_COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#e91e63',
  '#ff5722', '#00bcd4', '#8bc34a', '#ff9800',
];

// Falling notes are coloured by hand first — that is the thing you need to
// know while sight-reading them — and by white or black key within it. The
// right hand keeps the blue and deep purple it has always had; the left takes
// a warm pair, far enough from the greens and yellows that grade a hit.
const HAND_COLORS = {
  right: { white: '#3d8bfd', black: '#7c3aed' },
  left:  { white: '#f472b6', black: '#db2777' },
};
// Grades colour the note as it falls
const GRADE_COLORS = { perfect: '#2ecc71', good: '#2ecc71', almost: '#f1c40f' };
// Black-key notes are drawn narrower still, so the two rows read apart
const BLACK_NOTE_WIDTH = 0.72;

let fallingCanvas = null;
let kbCanvas = null;
let kbCtx = null;
let fallingCtx = null;
let keyLayout = []; // { midi, x, w, isWhite }
let keyMap = new Map(); // midi → keyInfo, built once for O(1) lookup
let animFrameId = null;

export function initPianoRoll(fallingEl, keyboardEl) {
  fallingCanvas = fallingEl;
  fallingCtx = fallingCanvas.getContext('2d');

  // Build keyboard in the keyboard container
  kbCanvas = document.createElement('canvas');
  keyboardEl.innerHTML = '';
  keyboardEl.appendChild(kbCanvas);
  kbCtx = kbCanvas.getContext('2d');

  resizePiano();
  // The piano section is user-resizable, so watch the containers themselves
  // rather than only the window.
  const ro = new ResizeObserver(resizePiano);
  ro.observe(fallingCanvas.parentElement);
  ro.observe(keyboardEl);
  // A held chord name outlives the notes that earned it, so it has to go when
  // they do
  on('transport:noteschanged', resetChordLabel);
  startAnimation();
}

function resizePiano() {
  const kbBox = kbCanvas.parentElement;
  const fallBox = fallingCanvas.parentElement;
  const w = kbBox.clientWidth;
  const kbH = kbBox.clientHeight;
  if (!w || !kbH) return;

  if (kbCanvas.width !== w || kbCanvas.height !== kbH) {
    kbCanvas.width = w;
    kbCanvas.height = kbH;
    buildKeyLayout(w, kbH);
  }
  fallingCanvas.width = fallBox.clientWidth;
  fallingCanvas.height = fallBox.clientHeight;

  drawKeyboard();
}

function buildKeyLayout(totalWidth, height) {
  // Count white keys from MIDI_MIN to MIDI_MAX
  let whiteCount = 0;
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (IS_WHITE[m % 12]) whiteCount++;
  }

  const wkW = totalWidth / whiteCount;
  const bkW = wkW * 0.6;
  const wkH = height;
  const bkH = height * 0.62;

  keyLayout = [];
  let wIdx = 0;

  // First pass: white keys
  const whiteXs = {};
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (IS_WHITE[m % 12]) {
      whiteXs[m] = wIdx * wkW;
      wIdx++;
    }
  }

  // Second pass: all keys with positions
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (IS_WHITE[m % 12]) {
      keyLayout.push({ midi: m, x: whiteXs[m], w: wkW, h: wkH, isWhite: true });
    } else {
      // Black key: center between surrounding white keys
      const prevWhite = m - 1;
      const x = whiteXs[prevWhite] + wkW - bkW / 2;
      keyLayout.push({ midi: m, x, w: bkW, h: bkH, isWhite: false });
    }
  }
  keyMap = new Map(keyLayout.map(k => [k.midi, k]));
}

export function drawKeyboard(activeNotes = null) {
  if (!kbCtx || !keyLayout.length) return;
  const w = kbCanvas.width;
  const h = kbCanvas.height;
  kbCtx.clearRect(0, 0, w, h);

  // Draw white keys first
  for (const key of keyLayout) {
    if (!key.isWhite) continue;
    const active = activeNotes && activeNotes.has(key.midi);
    kbCtx.fillStyle = active ? '#aee' : '#fff';
    kbCtx.strokeStyle = '#444';
    kbCtx.lineWidth = 1;
    kbCtx.fillRect(key.x, 0, key.w - 1, key.h - 1);
    kbCtx.strokeRect(key.x, 0, key.w - 1, key.h - 1);
  }

  // Draw black keys on top
  for (const key of keyLayout) {
    if (key.isWhite) continue;
    const active = activeNotes && activeNotes.has(key.midi);
    kbCtx.fillStyle = active ? '#556' : '#222';
    kbCtx.fillRect(key.x, 0, key.w, key.h);

    if (active) {
      kbCtx.fillStyle = 'rgba(100,200,200,0.5)';
      kbCtx.fillRect(key.x, 0, key.w, key.h);
    }
  }

  if (waitingPitches.size) {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
    for (const midi of waitingPitches) {
      const key = keyMap.get(midi);
      if (key) drawWaitingKey(kbCtx, key, pulse);
    }
  }

  drawFingerings();

  if (effects.length) drawEffects(performance.now());
}

// ── Fingering ────────────────────────────────────────────────────────────────
// Which finger to use, written on the key it belongs to. On the keyboard rather
// than on the falling note, because the number is an instruction to the hand
// and the hand is looking at the keys.
//
// Only the notes at the playhead — the ones being played or waited for. A
// column of numbers stretching up the window would be the fingering of music
// that has not arrived yet, which is exactly the reading-ahead that practising
// a scale is meant to make unnecessary.

const FINGER_ON_WHITE = '#1b3a5c';
const FINGER_ON_BLACK = '#e8f2ff';
const FINGER_HALO = 'rgba(255,255,255,0.9)';

// Rebuilt each frame by drawFallingNotes, which runs first and already has both
// the notes and the time to pick them out with
let fingerByPitch = new Map();

// How far ahead of the playhead a note still counts as "here". Learn mode holds
// the transport a hair short of the note it is waiting on, so an exact test
// would show nothing at the moment the number is most wanted.
const FINGER_LEAD_MS = 120;

function collectFingerings(notes, currentTimeMs) {
  fingerByPitch = new Map();
  // The memory pass is asking for the phrase back without showing it. A
  // fingering on the keys would be the answer written out.
  if (blind || !state.ui.showFingering) return;

  for (const note of notes) {
    if (!note.finger) continue;
    const sounding = note.startTime <= currentTimeMs &&
                     note.startTime + note.duration > currentTimeMs;
    const imminent = note.startTime > currentTimeMs &&
                     note.startTime - currentTimeMs <= FINGER_LEAD_MS;
    const wanted = waitingPitches.has(note.pitch) &&
                   Math.abs(note.startTime - currentTimeMs) <= FINGER_LEAD_MS;
    if (sounding || imminent || wanted) fingerByPitch.set(note.pitch, note.finger);
  }
}

function drawFingerings() {
  if (!fingerByPitch.size) return;

  for (const [midi, finger] of fingerByPitch) {
    const key = keyMap.get(midi);
    if (!key) continue;

    const size = Math.max(9, Math.min(18, Math.round(key.w * (key.isWhite ? 0.62 : 0.78))));
    const cx = key.x + key.w / 2;
    // Low on a white key, where nothing else is drawn and the hand can see it
    // past its own fingers; just above the tip of a black one
    const cy = key.isWhite ? key.h - size * 0.85 : key.h - size * 0.75;

    kbCtx.save();
    kbCtx.font = `600 ${size}px system-ui, sans-serif`;
    kbCtx.textAlign = 'center';
    kbCtx.textBaseline = 'middle';
    // A rim in the key's own colour, so the digit reads over the pulsing
    // amber of a waiting key as well as over the plain one
    kbCtx.lineWidth = Math.max(2, size * 0.22);
    kbCtx.strokeStyle = key.isWhite ? FINGER_HALO : 'rgba(0,0,0,0.85)';
    kbCtx.lineJoin = 'round';
    kbCtx.strokeText(String(finger), cx, cy);
    kbCtx.fillStyle = key.isWhite ? FINGER_ON_WHITE : FINGER_ON_BLACK;
    kbCtx.fillText(String(finger), cx, cy);
    kbCtx.restore();
  }
}

// ── Key effects ──────────────────────────────────────────────────────────────
// Short-lived marks drawn over the keyboard so feedback lands where the hand
// is, rather than only on the falling note that has already gone past.

const EFFECT_MS = { perfect: 620, wrong: 700, good: 380 };
let effects = []; // { midi, kind, born }

// ── Learn-mode targets ───────────────────────────────────────────────────────
// The keys the piece is currently waiting on. Marked on the keyboard and at
// the hit line, so the player is told what to press rather than left to work
// it out from a note that has stopped moving.

let waitingPitches = new Set();

export function setWaitingPitches(pitches) {
  waitingPitches = new Set(pitches || []);
}

// ── Blind ────────────────────────────────────────────────────────────────────
// Learn mode's memory pass asks for a phrase back without showing it, so the
// window keeps its keyboard and its beat and gives away nothing else: no
// falling notes, and no chord named at the top of them either.

let blind = false;

export function setFallingBlind(hidden) {
  blind = Boolean(hidden);
}

// The note picked as one end of a loop, ringed so the choice is visible before
// the other end is chosen
let pickedNoteId = null;

export function setLoopPick(noteId) {
  pickedNoteId = noteId || null;
}

const WAIT_COLOR = '#f5b301';
const LOOP_PICK_COLOR = '#ffd166';

function drawWaitingKey(ctx, key, pulse) {
  ctx.save();
  ctx.globalAlpha = 0.45 + 0.35 * pulse;
  ctx.fillStyle = WAIT_COLOR;
  ctx.fillRect(key.x, key.isWhite ? key.h * 0.55 : 0, key.w - (key.isWhite ? 1 : 0), key.isWhite ? key.h * 0.45 : key.h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = WAIT_COLOR;
  ctx.lineWidth = 2;
  ctx.strokeRect(key.x + 1, 1, key.w - 2, key.h - 2);
  ctx.restore();
}

export function spawnKeyEffect(midi, kind) {
  effects.push({ midi, kind, born: performance.now() });
  // Bounded so a held-down wrong note cannot pile up unboundedly
  if (effects.length > 60) effects.splice(0, effects.length - 60);
}

export function clearKeyEffects() {
  effects = [];
}

function drawEffects(now) {
  effects = effects.filter(fx => now - fx.born < (EFFECT_MS[fx.kind] || 400));

  for (const fx of effects) {
    const key = keyMap.get(fx.midi);
    if (!key) continue;
    const life = (now - fx.born) / (EFFECT_MS[fx.kind] || 400);
    const cx = key.x + key.w / 2;

    if (fx.kind === 'perfect') drawFirework(cx, key, life);
    else if (fx.kind === 'wrong') drawSmoke(cx, key, life);
    else if (fx.kind === 'good') drawGoodFlash(key, life);
  }
}

// A ring of sparks thrown from the key
const SPARKS = 9;
function drawFirework(cx, key, life) {
  const cy = key.h * 0.35;
  const reach = 6 + life * 26;
  const fade = 1 - life;

  kbCtx.save();
  kbCtx.globalAlpha = Math.max(0, fade);
  kbCtx.fillStyle = '#3ee87a';
  kbCtx.shadowColor = '#3ee87a';
  kbCtx.shadowBlur = 8;
  for (let i = 0; i < SPARKS; i++) {
    const angle = (i / SPARKS) * Math.PI * 2 - Math.PI / 2;
    const r = Math.max(1.2, 3 * fade);
    kbCtx.beginPath();
    kbCtx.arc(cx + Math.cos(angle) * reach, cy + Math.sin(angle) * reach * 0.8, r, 0, Math.PI * 2);
    kbCtx.fill();
  }
  kbCtx.shadowBlur = 0;
  kbCtx.globalAlpha = Math.max(0, fade * 0.5);
  kbCtx.fillStyle = '#eaffea';
  kbCtx.beginPath();
  kbCtx.arc(cx, cy, Math.max(1, 6 * fade), 0, Math.PI * 2);
  kbCtx.fill();
  kbCtx.restore();
}

// Grey puffs drifting up off a key that should not have been played
const PUFFS = 4;
function drawSmoke(cx, key, life) {
  kbCtx.save();
  kbCtx.globalAlpha = Math.max(0, 0.55 * (1 - life));
  kbCtx.fillStyle = '#9aa0ad';
  for (let i = 0; i < PUFFS; i++) {
    const t = life + i * 0.16;
    if (t > 1) continue;
    const drift = Math.sin((i * 1.7) + life * 4) * 5;
    kbCtx.beginPath();
    kbCtx.arc(cx + drift, key.h * 0.5 - t * 34, 4 + t * 9, 0, Math.PI * 2);
    kbCtx.fill();
  }
  kbCtx.restore();
}

function drawGoodFlash(key, life) {
  kbCtx.save();
  kbCtx.globalAlpha = Math.max(0, 0.5 * (1 - life));
  kbCtx.fillStyle = '#2ecc71';
  kbCtx.fillRect(key.x, 0, key.w - (key.isWhite ? 1 : 0), key.h);
  kbCtx.restore();
}

function getKeyX(midi) {
  const key = keyMap.get(midi);
  if (!key) return null;
  return key.x + key.w / 2;
}

function handColor(hand, midi) {
  const pair = HAND_COLORS[hand];
  return IS_WHITE[midi % 12] ? pair.white : pair.black;
}

function fallingColor(note) {
  return handColor(handOf(note), note.pitch);
}

// A key being held has no note behind it to ask, so it falls back to register
function keyColor(midi) {
  return handColor(midi >= 60 ? 'right' : 'left', midi);
}

function getNoteColor(midi, alpha = 1) {
  const pc = midi % 12;
  const hex = PC_COLORS[pc];
  // Convert hex to rgba
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// How much music is shown above the keyboard — beats, not seconds.
//
// A fixed number of milliseconds meant the notes crossed the window at the
// same speed whatever the tempo: setting 60 BPM to work something out gave you
// half as many notes rushing past just as fast, when the whole point of slowing
// down is to have longer to see each one coming. Five beats is what 2500ms was
// at 120 BPM, so nothing moves at the tempo the app starts on, and every other
// tempo now behaves the way it reads.
const LOOKAHEAD_BEATS = 5;
// Guards, not policy: a window under a second is unreadable and one over ten
// leaves the notes hanging motionless at the top.
const MIN_LOOKAHEAD_MS = 1000;
const MAX_LOOKAHEAD_MS = 10000;

function lookaheadMs() {
  const tempo = state.composition.tempo || 120;
  const beatMs = 60000 / tempo;
  return Math.max(MIN_LOOKAHEAD_MS, Math.min(MAX_LOOKAHEAD_MS, LOOKAHEAD_BEATS * beatMs));
}

// Which note is under a point on the falling window. Picking the ends of a
// loop means pointing at the music itself, so the hit test has to agree with
// the drawing exactly — same lookahead, same key positions, same widths.
export function noteAtFallingPoint(px, py, notes, currentTimeMs) {
  if (!fallingCanvas || !keyLayout.length) return null;
  const ch = fallingCanvas.height;
  const pixelsPerMs = ch / lookaheadMs();
  let best = null;
  for (const note of notes) {
    const keyInfo = keyMap.get(note.pitch);
    if (!keyInfo) continue;
    const bottom = ch - (note.startTime - currentTimeMs) * pixelsPerMs;
    const top = bottom - note.duration * pixelsPerMs;
    if (py < top - HIT_SLOP || py > bottom + HIT_SLOP) continue;
    const isBlack = !IS_WHITE[note.pitch % 12];
    const fullW = Math.max(keyInfo.w - 2, 4);
    const w = isBlack ? Math.max(4, fullW * BLACK_NOTE_WIDTH) : fullW;
    const x = keyInfo.x + (fullW - w) / 2;
    if (px < x - HIT_SLOP || px > x + w + HIT_SLOP) continue;
    // Black keys are drawn over white ones, so they win where they overlap
    if (!best || (isBlack && !best.black)) best = { note, black: isBlack };
  }
  return best ? best.note : null;
}

const HIT_SLOP = 3;   // a note is a few pixels wide; a fingertip is not

// What a pixel of the falling window is worth in time. Scrubbing asks, so that
// dragging the view moves the music by exactly as much as it was dragged
// instead of by some second, invented rate.
export function fallingMsPerPixel() {
  const h = fallingCanvas ? fallingCanvas.height : 0;
  return h > 0 ? lookaheadMs() / h : 0;
}

export function drawFallingNotes(notes, composition, currentTimeMs, accuracyResults = null, trainMode = false) {
  if (!fallingCtx || !keyLayout.length) return;

  const cw = fallingCanvas.width;
  const ch = fallingCanvas.height;
  fallingCtx.clearRect(0, 0, cw, ch);

  // Dark background gradient
  const grad = fallingCtx.createLinearGradient(0, 0, 0, ch);
  grad.addColorStop(0, '#0a0a15');
  grad.addColorStop(1, '#1a1a2e');
  fallingCtx.fillStyle = grad;
  fallingCtx.fillRect(0, 0, cw, ch);

  // Guide lines (subtle vertical lines at each white key)
  fallingCtx.strokeStyle = 'rgba(255,255,255,0.03)';
  fallingCtx.lineWidth = 1;
  for (const key of keyLayout) {
    if (key.isWhite) {
      fallingCtx.beginPath();
      fallingCtx.moveTo(key.x, 0);
      fallingCtx.lineTo(key.x, ch);
      fallingCtx.stroke();
    }
  }

  // "Hit line" at the bottom (where notes should be played)
  fallingCtx.strokeStyle = 'rgba(255,255,255,0.15)';
  fallingCtx.lineWidth = 2;
  fallingCtx.beginPath();
  fallingCtx.moveTo(0, ch - 4);
  fallingCtx.lineTo(cw, ch - 4);
  fallingCtx.stroke();

  const lookahead = lookaheadMs();
  const pixelsPerMs = ch / lookahead;

  // Draw notes in window [currentTime - pastWindow, currentTime + lookahead]
  const pastWindow = 300; // show recently played notes briefly
  const windowStart = currentTimeMs - pastWindow;
  const windowEnd = currentTimeMs + lookahead;

  const dimOthers = (state.ui.trainMode || state.ui.learnMode) && practiceHand() !== 'both';

  // Picked out here rather than in drawKeyboard: this runs first in the frame
  // and is already holding the notes and the time that decide it
  collectFingerings(notes, currentTimeMs);

  const visibleNotes = blind ? [] : notes.filter(n =>
    n.startTime < windowEnd && (n.startTime + n.duration) > windowStart
  );

  for (const note of visibleNotes) {
    const keyInfo = keyMap.get(note.pitch);
    if (!keyInfo) continue;

    // Y position: note bottom = where it lands at startTime
    // At currentTime, the bottom of the note is at y = ch - (note.startTime - currentTimeMs)*pixelsPerMs
    const noteBottomY = ch - (note.startTime - currentTimeMs) * pixelsPerMs;
    const noteTopY = noteBottomY - note.duration * pixelsPerMs;
    const visibleTop = Math.max(0, noteTopY);
    const visibleBottom = Math.min(ch, noteBottomY);

    if (visibleBottom < 0 || visibleTop > ch) continue;

    // Graded notes recolour as they are played; a miss keeps its own colour so
    // the eye is drawn to what did happen rather than what did not
    let color = fallingColor(note);
    if (trainMode && accuracyResults) {
      const result = accuracyResults.find(r => r.noteId === note.id);
      if (result && GRADE_COLORS[result.grade]) color = GRADE_COLORS[result.grade];
    }

    // Practising one hand: the other one is still drawn, because you need to
    // see what you are playing against, but faintly enough to be background
    fallingCtx.globalAlpha = dimOthers && !isPractised(note) ? 0.25 : 1;

    const isBlack = !IS_WHITE[note.pitch % 12];
    const fullW = Math.max(keyInfo.w - 2, 4);
    const w = isBlack ? Math.max(4, fullW * BLACK_NOTE_WIDTH) : fullW;
    const x = keyInfo.x + (fullW - w) / 2;
    const noteH = Math.max(6, visibleBottom - visibleTop);

    // Glow effect
    fallingCtx.shadowColor = color;
    fallingCtx.shadowBlur = 8;
    fallingCtx.fillStyle = color;
    fallingCtx.beginPath();
    fallingCtx.roundRect(x + 1, visibleTop, Math.max(2, w - 2), noteH, 3);
    fallingCtx.fill();
    fallingCtx.shadowBlur = 0;

    // Highlight top edge
    fallingCtx.fillStyle = 'rgba(255,255,255,0.3)';
    fallingCtx.fillRect(x + 2, visibleTop, Math.max(1, w - 4), 2);

    if (note.id === pickedNoteId) {
      fallingCtx.strokeStyle = LOOP_PICK_COLOR;
      fallingCtx.lineWidth = 2;
      fallingCtx.shadowColor = LOOP_PICK_COLOR;
      fallingCtx.shadowBlur = 10;
      fallingCtx.beginPath();
      fallingCtx.roundRect(x - 1, visibleTop - 2, Math.max(4, w), noteH + 4, 4);
      fallingCtx.stroke();
      fallingCtx.shadowBlur = 0;
    }
  }
  fallingCtx.globalAlpha = 1;

  // Keys the piece is waiting on: a pulsing column down to the hit line, so
  // the frozen note reads as "play this" rather than as a stall
  if (waitingPitches.size) {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
    for (const midi of waitingPitches) {
      const keyInfo = keyMap.get(midi);
      if (!keyInfo) continue;
      const band = fallingCtx.createLinearGradient(0, ch - 90, 0, ch);
      band.addColorStop(0, 'transparent');
      band.addColorStop(1, WAIT_COLOR);
      fallingCtx.globalAlpha = 0.25 + 0.35 * pulse;
      fallingCtx.fillStyle = band;
      fallingCtx.fillRect(keyInfo.x, ch - 90, keyInfo.w, 90);
      fallingCtx.globalAlpha = 1;
    }
  }

  // Draw active notes "glow" at the hit line
  for (const midi of state.midi.activeNotes) {
    const keyInfo = keyMap.get(midi);
    if (!keyInfo) continue;
    const x = keyInfo.x + keyInfo.w / 2;
    const grad2 = fallingCtx.createRadialGradient(x, ch, 0, x, ch, 40);
    grad2.addColorStop(0, keyColor(midi));
    grad2.addColorStop(1, 'transparent');
    fallingCtx.fillStyle = grad2;
    fallingCtx.fillRect(keyInfo.x - 5, ch - 50, keyInfo.w + 10, 50);
  }

  // Overlays last, so nothing falling is drawn over them
  drawChordName(notes, composition, currentTimeMs, cw, ch);
  drawMetronome(composition, currentTimeMs, cw, ch);
}

// ── Current chord ────────────────────────────────────────────────────────────
// What is sounding, named at the top of the window. Large enough to read at a
// glance from the keyboard, faint enough that the notes still show through it.
//
// It holds until something replaces it. A chord does not stop being the
// harmony the moment the keys are released — a melody or a rest over the same
// chord is still that chord — and a name that blinked out between every voicing
// was unreadable.

let chordCache = { key: '', label: null };
let heldChord = { label: null, since: 0 };

function currentChordLabel(notes, currentTimeMs, keySignature) {
  const pitches = [];
  for (const note of notes) {
    if (note.startTime <= currentTimeMs && note.startTime + note.duration > currentTimeMs) {
      pitches.push(note.pitch);
    }
  }
  pitches.sort((a, b) => a - b);
  // Naming a chord is not free, and the sounding set changes far less often
  // than this is drawn
  const key = `${pitches.join(',')}|${keySignature}`;
  if (key !== chordCache.key) {
    chordCache = { key, label: pitches.length >= 2 ? detectChord(pitches, keySignature) : null };
  }

  // Rewinding past the point a name was earned takes the name back with it
  if (currentTimeMs < heldChord.since) heldChord = { label: null, since: 0 };
  if (chordCache.label) heldChord = { label: chordCache.label, since: currentTimeMs };
  return heldChord.label;
}

// Forget the held name when the notes behind it have gone
function resetChordLabel() {
  chordCache = { key: '', label: null };
  heldChord = { label: null, since: 0 };
}

function drawChordName(notes, composition, currentTimeMs, cw, ch) {
  if (!state.ui.showChordOverlay || blind) return;
  const label = currentChordLabel(notes, currentTimeMs, composition.keySignature);
  if (!label) return;

  // Sized to the window: readable from the keyboard in a tall one, and not
  // swallowing a short one
  const size = Math.max(30, Math.min(60, Math.round(ch * 0.3)));
  fallingCtx.save();
  fallingCtx.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
  fallingCtx.textAlign = 'center';
  fallingCtx.textBaseline = 'top';
  fallingCtx.globalAlpha = 0.72;
  fallingCtx.shadowColor = 'rgba(0,0,0,0.85)';
  fallingCtx.shadowBlur = 12;
  fallingCtx.fillStyle = '#8ad4f5';
  fallingCtx.fillText(label, cw / 2, 8);
  fallingCtx.restore();
}

// ── Metronome ────────────────────────────────────────────────────────────────
// A level crossing, because a crossing signal is the one blinking light
// everybody can already read: two lamps taking turns, one per beat, both of
// them together on the downbeat so the bar line is unmistakable. Under the
// crossbuck sit two rows: a pip per beat, saying where in the bar you are, and
// — when the beat is set to divide — a bar per click, filling through the beat.
//
// It counts the same composition-time ticks the audible metronome does, so
// what you see and what you hear cannot disagree — but it is its own switch,
// because a beat worth watching is not always one worth listening to.

const LAMP_ON = '#ff3b30';
const BUCK_CLEARANCE = 4; // the crossbuck sits above the lamps, not across them
const LAMP_OFF = 'rgba(90,26,26,0.75)';

function drawMetronome(composition, currentTimeMs, cw, ch) {
  if (!state.ui.showBeatOverlay) return;

  const { tempo, timeSignature } = composition;
  const beatsPerBar = Math.max(1, timeSignature.numerator);
  const subs = subdivision();
  const beatMs = (60 / tempo) * 1000;

  // Standing dark between takes rather than counting a bar nobody is playing
  const running = state.transport.mode !== 'stopped';
  const beatPos = running ? currentTimeMs / beatMs : 0;
  const beat = Math.floor(beatPos);
  const beatIndex = ((beat % beatsPerBar) + beatsPerBar) % beatsPerBar;
  const intoBeat = running ? beatPos - beat : 0;

  // Panel geometry, scaled to the window so a tall one gets a big signal and a
  // short one still fits
  const s = Math.max(0.85, Math.min(1.6, ch / 170));
  const lampR = 11 * s;
  const gap = 34 * s;
  const pad = 10 * s;
  const buckH = 22 * s;
  const pipH = 9 * s;
  const subH = subs > 1 ? 9 * s : 0;
  const width = gap + lampR * 2 + pad * 2 + 16 * s;
  const height = pad * 2 + buckH + lampR * 2 + pipH + subH + BUCK_CLEARANCE * s;
  const x = cw - width - 12;
  const y = 10;

  fallingCtx.save();
  fallingCtx.fillStyle = 'rgba(13,13,26,0.6)';
  fallingCtx.strokeStyle = 'rgba(120,120,168,0.35)';
  fallingCtx.lineWidth = 1;
  fallingCtx.beginPath();
  fallingCtx.roundRect(x, y, width, height, 10 * s);
  fallingCtx.fill();
  fallingCtx.stroke();

  const midX = x + width / 2;
  drawCrossbuck(midX, y + pad + buckH / 2, buckH, s);

  // The lamps alternate beat by beat, and the downbeat lights both. They swell
  // on the attack so the eye catches the beat landing, not a lamp merely on.
  const lampY = y + pad + buckH + BUCK_CLEARANCE * s + lampR;
  const swell = running ? Math.max(0, 1 - intoBeat * 3) : 0;
  const burn = 0.6 + 0.4 * swell;
  const litLeft = running && (beatIndex === 0 || beat % 2 === 0);
  const litRight = running && (beatIndex === 0 || beat % 2 === 1);
  drawLamp(midX - gap / 2, lampY, lampR, litLeft ? burn : 0, s);
  drawLamp(midX + gap / 2, lampY, lampR, litRight ? burn : 0, s);

  // Where in the bar, under the lamps
  const pipY = y + pad + buckH + BUCK_CLEARANCE * s + lampR * 2 + pipH / 2;
  const pipGap = Math.min(13 * s, (width - pad * 2) / beatsPerBar);
  for (let b = 0; b < beatsPerBar; b++) {
    const px = midX + (b - (beatsPerBar - 1) / 2) * pipGap;
    const on = running && b === beatIndex;
    fallingCtx.beginPath();
    fallingCtx.arc(px, pipY, (on ? 3.2 : 2.2) * s, 0, Math.PI * 2);
    fallingCtx.fillStyle = on
      ? (b === 0 ? '#f5b301' : 'rgba(240,240,255,0.9)')
      : 'rgba(140,140,180,0.4)';
    fallingCtx.fill();
  }

  // The divisions of the beat get their own row rather than sharing the lamps:
  // one bar per click, filling left to right through the beat. Sharing meant a
  // brightness wobble nobody could see under a lamp already burning red.
  if (subs > 1) {
    const subIndex = Math.min(subs - 1, Math.floor(intoBeat * subs));
    const rowW = width - pad * 2;
    const slot = rowW / subs;
    const barW = Math.max(3 * s, slot - 3 * s);
    const subY = pipY + pipH / 2 + 2 * s;
    for (let i = 0; i < subs; i++) {
      const sx = x + pad + i * slot + (slot - barW) / 2;
      const on = running && i === subIndex;
      // The first click of the beat is the beat itself, so it is coloured like
      // one; the rest are the lighter ticks between
      fallingCtx.fillStyle = on
        ? (i === 0 ? '#ffd166' : '#7fe3ff')
        : 'rgba(140,140,180,0.3)';
      fallingCtx.fillRect(sx, subY, barW, (on ? 4 : 2.5) * s);
    }
  }
  fallingCtx.restore();
}

// The crossed boards, white with the black edge they have in the real thing
function drawCrossbuck(cx, cy, size, s) {
  const arm = size * 0.78;
  fallingCtx.save();
  fallingCtx.lineCap = 'round';
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const dx = Math.cos(angle) * arm;
    const dy = Math.sin(angle) * arm;
    fallingCtx.beginPath();
    fallingCtx.moveTo(cx - dx, cy - dy);
    fallingCtx.lineTo(cx + dx, cy + dy);
    fallingCtx.strokeStyle = 'rgba(0,0,0,0.55)';
    fallingCtx.lineWidth = 7 * s;
    fallingCtx.stroke();
    fallingCtx.strokeStyle = 'rgba(240,240,245,0.82)';
    fallingCtx.lineWidth = 4.5 * s;
    fallingCtx.stroke();
  }
  fallingCtx.restore();
}

// `lit` is 0 for dark, otherwise how hard it is burning right now
function drawLamp(cx, cy, r, lit, s) {
  fallingCtx.save();
  // Housing, so an unlit lamp still reads as a lamp
  fallingCtx.beginPath();
  fallingCtx.arc(cx, cy, r + 2.5 * s, 0, Math.PI * 2);
  fallingCtx.fillStyle = 'rgba(20,20,30,0.9)';
  fallingCtx.fill();
  fallingCtx.strokeStyle = 'rgba(150,150,180,0.45)';
  fallingCtx.lineWidth = 1.5 * s;
  fallingCtx.stroke();

  fallingCtx.beginPath();
  fallingCtx.arc(cx, cy, r, 0, Math.PI * 2);
  if (lit > 0) {
    const glow = fallingCtx.createRadialGradient(cx, cy - r * 0.25, r * 0.15, cx, cy, r);
    glow.addColorStop(0, '#fff1ef');
    glow.addColorStop(0.45, LAMP_ON);
    glow.addColorStop(1, '#8f1108');
    fallingCtx.fillStyle = glow;
    fallingCtx.shadowColor = LAMP_ON;
    fallingCtx.shadowBlur = (10 + 14 * lit) * s;
    fallingCtx.globalAlpha = 0.55 + 0.45 * lit;
  } else {
    fallingCtx.fillStyle = LAMP_OFF;
  }
  fallingCtx.fill();
  fallingCtx.restore();
}

function startAnimation() {
  function frame() {
    const notes = state.composition.notes;
    const comp = state.composition;
    const t = state.transport.currentTime;
    const active = state.midi.activeNotes;

    const accuracyResults = state.ui.trainMode ? getAccuracyResults() : null;
    drawFallingNotes(notes, comp, t, accuracyResults, state.ui.trainMode);
    drawKeyboard(active);

    animFrameId = requestAnimationFrame(frame);
  }
  if (animFrameId) cancelAnimationFrame(animFrameId);
  animFrameId = requestAnimationFrame(frame);
}

export function stopAnimation() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  animFrameId = null;
}

// ── Piano Roll (time × pitch grid view) ──────────────────────────────────────

const PIANO_KEY_WIDTH = 56; // px reserved for the vertical mini-piano strip
const ROLL_GUTTER = 16; // px of breathing room between the key strip and time 0
const MIN_ROW_H = 9; // px — below this a pitch row is too thin to read as a key

// Draws a keyboard seen from above: white keys form one continuous field,
// black keys are overlaid at partial width, exactly like a DAW's key strip.
function drawVerticalPiano(ctx, minPitch, maxPitch, noteH, h, pitchesWithNotes) {
  const pw = PIANO_KEY_WIDTH;
  const blackW = Math.round(pw * 0.62);
  const rowY = (p) => h - (p - minPitch + 1) * noteH; // top edge of p's row
  const topY = rowY(maxPitch);
  const totalH = (maxPitch - minPitch + 1) * noteH;

  // 1. Continuous white field — the black-key rows keep white to the right of
  //    the black key, which is what makes the strip read as a keyboard.
  ctx.fillStyle = '#e9e9f2';
  ctx.fillRect(0, topY, pw, totalH);

  // 2. Tint white keys that carry notes
  for (let p = minPitch; p <= maxPitch; p++) {
    if (!IS_WHITE[p % 12] || !pitchesWithNotes.has(p)) continue;
    ctx.fillStyle = '#8fd8d8';
    ctx.fillRect(0, rowY(p), pw, noteH);
  }

  // 3. Seams between white keys: full width where two white keys touch
  //    (E|F, B|C), otherwise a short seam through the intervening black row.
  ctx.strokeStyle = 'rgba(0,0,0,0.30)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let p = minPitch; p <= maxPitch; p++) {
    if (IS_WHITE[p % 12]) {
      if (p + 1 <= maxPitch && IS_WHITE[(p + 1) % 12]) {
        const y = Math.round(rowY(p)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(pw, y);
      }
    } else {
      const y = Math.round(rowY(p) + noteH / 2) + 0.5;
      ctx.moveTo(blackW, y);
      ctx.lineTo(pw, y);
    }
  }
  ctx.stroke();

  // 4. Black keys on top
  for (let p = minPitch; p <= maxPitch; p++) {
    if (IS_WHITE[p % 12]) continue;
    const y = rowY(p);
    ctx.fillStyle = pitchesWithNotes.has(p) ? '#2e8b8b' : '#1b1b26';
    ctx.fillRect(0, y, blackW, noteH);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(0, y, blackW, 1);
  }

  // 5. Right edge of the strip
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(pw - 1, topY, 1, totalH);

  // 6. Octave labels on C rows, only when the row can fit the text
  if (noteH >= 8) {
    ctx.fillStyle = '#4a4a60';
    ctx.font = `${Math.min(10, noteH - 2)}px system-ui, monospace`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let p = minPitch; p <= maxPitch; p++) {
      if (p % 12 !== 0) continue;
      ctx.fillText(`C${Math.floor(p / 12) - 1}`, pw - 4, rowY(p) + noteH / 2);
    }
    ctx.textBaseline = 'alphabetic';
  }
}

export function renderPianoRoll(canvas, notes, currentTimeMs) {
  if (!canvas || !notes) return;
  const ctx = canvas.getContext('2d');
  const LEFT = PIANO_KEY_WIDTH;

  // Pitch window: the recorded range with a little headroom, or a sensible
  // default octave span (C2–C6) when nothing has been recorded yet.
  const minPitch = notes.length
    ? Math.max(21, notes.reduce((m, n) => Math.min(m, n.pitch), 108) - 4)
    : 36;
  const maxPitch = notes.length
    ? Math.min(108, notes.reduce((m, n) => Math.max(m, n.pitch), 21) + 4)
    : 84;
  const pitchRange = maxPitch - minPitch + 1;

  // Grow the canvas past the viewport rather than squashing rows into it —
  // #roll-scroll then scrolls vertically, as a DAW piano roll does.
  const viewH = canvas.parentElement ? canvas.parentElement.clientHeight : 0;
  const h = Math.max(viewH, pitchRange * MIN_ROW_H);
  canvas.style.height = h + 'px';
  canvas.height = h;
  const w = canvas.width = canvas.offsetWidth;
  if (!w || !h) return;

  // Time 0 starts past a gutter so the earliest notes never sit flush against
  // the key strip.
  const GRID_X = LEFT + ROLL_GUTTER;
  const rollW = w - GRID_X; // width of the time-axis area
  const noteH = h / pitchRange;

  ctx.fillStyle = '#0a0a15';
  ctx.fillRect(0, 0, w, h);

  if (!notes.length) {
    ctx.fillStyle = '#3a3a5c';
    ctx.font = '14px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('No notes recorded yet', GRID_X + rollW / 2, h / 2);
    drawVerticalPiano(ctx, minPitch, maxPitch, noteH, h, new Set());
    setEditorLayout({ msPerPx: 1, minPitch, noteH, h, w, leftMargin: LEFT, gridX: LEFT + ROLL_GUTTER }, []);
    return;
  }

  const maxTime = Math.max(notes.reduce((m, n) => Math.max(m, n.startTime + n.duration), 0), currentTimeMs + 2000);
  const msPerPx = maxTime / rollW;

  // Everything time-based is clipped to the right of the key strip, so no note
  // or playhead can ever paint into the piano.
  ctx.save();
  ctx.beginPath();
  ctx.rect(LEFT, 0, w - LEFT, h);
  ctx.clip();

  // Grid guides
  for (let p = minPitch; p <= maxPitch; p++) {
    const y = h - (p - minPitch + 1) * noteH;
    if (p % 12 === 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(LEFT, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    if (!IS_WHITE[p % 12]) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(LEFT, y, w - LEFT, noteH);
    }
  }

  // Step-record cursor
  if (state.transport.mode === 'step-recording') {
    const cx = GRID_X + state.transport.currentTime / msPerPx;
    ctx.fillStyle = 'rgba(91,192,235,0.15)';
    ctx.fillRect(cx, 0, w - cx, h);
    ctx.strokeStyle = 'rgba(91,192,235,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
  }

  // Build note rects for editor hit-testing
  const noteRects = [];
  const sel = state.ui.editorSelectedNotes;
  const pitchesWithNotes = new Set(notes.map(n => n.pitch));

  for (const note of notes) {
    const x = GRID_X + note.startTime / msPerPx;
    const nw = Math.max(2, note.duration / msPerPx);
    const y = h - (note.pitch - minPitch + 1) * noteH;
    const isSelected = sel.has(note.id);

    ctx.fillStyle = isSelected
      ? 'rgba(255,255,255,0.9)'
      : getNoteColor(note.pitch, 0.9);
    ctx.shadowColor = isSelected ? '#fff' : getNoteColor(note.pitch, 0.5);
    ctx.shadowBlur = isSelected ? 6 : 0;
    ctx.beginPath();
    ctx.roundRect(x, y + 1, nw, noteH - 2, 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Resize handle hint on selected notes
    if (isSelected && nw > 10) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(x + nw - 5, y + 1, 4, noteH - 2);
    }

    noteRects.push({ id: note.id, x, y: y + 1, w: nw, h: noteH - 2 });
  }

  // Playhead
  const px = GRID_X + currentTimeMs / msPerPx;
  ctx.strokeStyle = 'rgba(233,69,96,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, h);
  ctx.stroke();

  ctx.restore();

  // The key strip owns the left margin outright
  drawVerticalPiano(ctx, minPitch, maxPitch, noteH, h, pitchesWithNotes);

  setEditorLayout({ msPerPx, minPitch, noteH, h, w, leftMargin: LEFT, gridX: GRID_X }, noteRects);
}
