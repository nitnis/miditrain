// Falling notes canvas + 88-key piano keyboard display
import { state } from './state.js';

// Piano layout constants
const MIDI_MIN = 21; // A0
const MIDI_MAX = 108; // C8
const TOTAL_KEYS = MIDI_MAX - MIDI_MIN + 1;

// Which MIDI pitch classes are white keys
const IS_WHITE = [true, false, true, false, true, true, false, true, false, true, false, true];
// C, C#, D, D#, E, F, F#, G, G#, A, A#, B

// Pitch-class colors for falling notes
const PC_COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#e91e63',
  '#ff5722', '#00bcd4', '#8bc34a', '#ff9800',
];

let fallingCanvas = null;
let kbCanvas = null;
let kbCtx = null;
let fallingCtx = null;
let keyLayout = []; // { midi, x, w, isWhite }
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
  window.addEventListener('resize', resizePiano);
  startAnimation();
}

function resizePiano() {
  const container = kbCanvas.parentElement;
  const w = container.clientWidth;
  const kbH = 120;

  kbCanvas.width = w;
  kbCanvas.height = kbH;
  fallingCanvas.width = w;
  fallingCanvas.height = fallingCanvas.parentElement.clientHeight;

  buildKeyLayout(w, kbH);
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
}

function getKeyX(midi) {
  const key = keyLayout.find(k => k.midi === midi);
  if (!key) return null;
  return key.x + key.w / 2;
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

const LOOKAHEAD_MS = 2500; // how many ms of notes are shown above the keyboard

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

  const pixelsPerMs = ch / LOOKAHEAD_MS;

  // Draw notes in window [currentTime - pastWindow, currentTime + LOOKAHEAD_MS]
  const pastWindow = 300; // show recently played notes briefly
  const windowStart = currentTimeMs - pastWindow;
  const windowEnd = currentTimeMs + LOOKAHEAD_MS;

  const visibleNotes = notes.filter(n =>
    n.startTime < windowEnd && (n.startTime + n.duration) > windowStart
  );

  for (const note of visibleNotes) {
    const keyInfo = keyLayout.find(k => k.midi === note.pitch);
    if (!keyInfo) continue;

    // Y position: note bottom = where it lands at startTime
    // At currentTime, the bottom of the note is at y = ch - (note.startTime - currentTimeMs)*pixelsPerMs
    const noteBottomY = ch - (note.startTime - currentTimeMs) * pixelsPerMs;
    const noteTopY = noteBottomY - note.duration * pixelsPerMs;
    const visibleTop = Math.max(0, noteTopY);
    const visibleBottom = Math.min(ch, noteBottomY);

    if (visibleBottom < 0 || visibleTop > ch) continue;

    // Color based on accuracy in train mode
    let color;
    if (trainMode && accuracyResults) {
      const result = accuracyResults.find(r => r.noteId === note.id);
      if (result) {
        color = result.hit ? '#2ecc71' : '#e74c3c';
      } else if (note.startTime < currentTimeMs) {
        color = '#e67e22'; // missed (past, not hit)
      } else {
        color = getNoteColor(note.pitch, 0.85);
      }
    } else {
      const isActive = note.startTime <= currentTimeMs && note.startTime + note.duration >= currentTimeMs;
      color = getNoteColor(note.pitch, isActive ? 1 : 0.8);
    }

    const x = keyInfo.x;
    const w = Math.max(keyInfo.w - 2, 4);
    const noteH = Math.max(6, visibleBottom - visibleTop);

    // Glow effect
    fallingCtx.shadowColor = color;
    fallingCtx.shadowBlur = 8;
    fallingCtx.fillStyle = color;
    fallingCtx.beginPath();
    fallingCtx.roundRect(x + 1, visibleTop, w - 2, noteH, 3);
    fallingCtx.fill();
    fallingCtx.shadowBlur = 0;

    // Highlight top edge
    fallingCtx.fillStyle = 'rgba(255,255,255,0.3)';
    fallingCtx.fillRect(x + 2, visibleTop, w - 4, 2);
  }

  // Draw active notes "glow" at the hit line
  for (const midi of state.midi.activeNotes) {
    const keyInfo = keyLayout.find(k => k.midi === midi);
    if (!keyInfo) continue;
    const x = keyInfo.x + keyInfo.w / 2;
    const grad2 = fallingCtx.createRadialGradient(x, ch, 0, x, ch, 40);
    grad2.addColorStop(0, getNoteColor(midi, 0.7));
    grad2.addColorStop(1, 'transparent');
    fallingCtx.fillStyle = grad2;
    fallingCtx.fillRect(keyInfo.x - 5, ch - 50, keyInfo.w + 10, 50);
  }
}

function startAnimation() {
  function frame() {
    const notes = state.composition.notes;
    const comp = state.composition;
    const t = state.transport.currentTime;
    const active = state.midi.activeNotes;

    drawFallingNotes(notes, comp, t, null, state.ui.trainMode);
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

export function renderPianoRoll(canvas, notes, currentTimeMs) {
  if (!canvas || !notes) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth;
  const h = canvas.height = canvas.offsetHeight;
  if (!w || !h) return;

  ctx.fillStyle = '#0a0a15';
  ctx.fillRect(0, 0, w, h);

  if (!notes.length) {
    ctx.fillStyle = '#3a3a5c';
    ctx.font = '14px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('No notes recorded yet', w / 2, h / 2);
    return;
  }

  // Range of visible MIDI pitches
  const minPitch = Math.max(21, Math.min(...notes.map(n => n.pitch)) - 4);
  const maxPitch = Math.min(108, Math.max(...notes.map(n => n.pitch)) + 4);
  const pitchRange = maxPitch - minPitch + 1;
  const noteH = Math.max(4, h / pitchRange);

  // Time range
  const maxTime = Math.max(...notes.map(n => n.startTime + n.duration), currentTimeMs + 2000);
  const msPerPx = maxTime / w;

  // Draw octave guides
  for (let p = minPitch; p <= maxPitch; p++) {
    if (p % 12 === 0) { // C notes
      const y = h - (p - minPitch + 1) * noteH;
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    // Black key background
    if (!IS_WHITE[p % 12]) {
      const y = h - (p - minPitch + 1) * noteH;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, y, w, noteH);
    }
  }

  // Draw notes
  for (const note of notes) {
    const x = note.startTime / msPerPx;
    const noteW = Math.max(2, note.duration / msPerPx);
    const y = h - (note.pitch - minPitch + 1) * noteH;
    ctx.fillStyle = getNoteColor(note.pitch, 0.9);
    ctx.beginPath();
    ctx.roundRect(x, y + 1, noteW, noteH - 2, 2);
    ctx.fill();
  }

  // Playhead
  const px = currentTimeMs / msPerPx;
  ctx.strokeStyle = 'rgba(233,69,96,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, h);
  ctx.stroke();

  // Pitch labels on left
  ctx.fillStyle = 'rgba(200,200,220,0.7)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  for (let p = minPitch; p <= maxPitch; p++) {
    if (p % 12 === 0) {
      const y = h - (p - minPitch) * noteH;
      const oct = Math.floor(p / 12) - 1;
      ctx.fillText(`C${oct}`, 2, y - 2);
    }
  }
}
