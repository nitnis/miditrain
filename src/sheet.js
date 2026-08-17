// VexFlow 4.x sheet music renderer (grand staff)
import { state } from './state.js';
import { quantizeNotes, groupByMeasure, groupIntoChords, fillWithRests, findBestDuration, splitAcrossBarlines } from './quantizer.js';
import { detectChordRuns, spellPitchClass } from './chords.js';
import { isRightHand } from './hands.js';

function VF() { return window.Vex?.Flow; }

// MIDI note → VexFlow "note/octave" string, spelled for the key.
//
// A note may carry its own spelling, for when whoever made it knows better
// than the key does: the seventh degree of A harmonic minor is a raised G, and
// no amount of looking at C major will work that out from the pitch alone.
function midiToVexKey(midi, keySignature, forced) {
  const spelling = forced
    ? { name: forced, letter: forced[0].toUpperCase(), accidental: forced.slice(1) }
    : spellPitchClass(midi % 12, keySignature);
  let octave = Math.floor(midi / 12) - 1;
  // C-flat belongs to the octave above the pitch it sounds, B-sharp the one
  // below — without this they would be written a whole octave out of place
  if (spelling.letter === 'C' && spelling.accidental === 'b') octave += 1;
  else if (spelling.letter === 'B' && spelling.accidental === '#') octave -= 1;
  return `${spelling.name.toLowerCase()}/${octave}`;
}

// Split a rest duration into clean note values (no dotted for simplicity)
function splitDurationToNoteValues(beats) {
  const VALUES = [4, 2, 1, 0.5, 0.25, 0.125];
  const parts = [];
  let rem = beats;
  while (rem > 0.05) {
    const v = VALUES.find(val => val <= rem + 0.01);
    if (!v) break;
    parts.push(v);
    rem -= v;
  }
  return parts;
}

let container = null;
let renderer = null;
let svgCtx = null;

// Chord label positions for HTML overlay: [{ label, pitches, x, y }]
let _chordOverlayData = [];
export function getChordOverlayData() { return _chordOverlayData; }

// Staff position (diatonic index) of each clef's top line: treble F5, bass A3
const TOP_LINE_DIA = { treble: 5 * 7 + 3, bass: 3 * 7 + 5 };

// Per-stave geometry in SVG user units, for pointer → pitch lookups
let _staveGeom = [];
export function getStaveGeometry() { return _staveGeom; }

function recordStaveGeom(stave, clef, measure) {
  const topLineY = stave.getYForLine(0);
  const spacing = stave.getYForLine(1) - topLineY;
  if (!spacing) return;
  _staveGeom.push({
    clef,
    measure,
    x: stave.getX(),
    w: stave.getWidth(),
    y: stave.getY(),
    // Where notes actually begin, past any clef and key signature — a click
    // maps to time across this span, not the whole stave
    noteStartX: stave.getNoteStartX(),
    noteEndX: stave.getX() + stave.getWidth() - 10,
    topLineY,
    spacing,
    topLineDia: TOP_LINE_DIA[clef],
  });
}

export function initSheet(el) {
  container = el;
  el.innerHTML = '';
}

export function renderSheet(notes, composition, currentTimeMs = null) {
  _chordOverlayData = [];
  _staveGeom = [];
  if (!container || !window.Vex) return;

  const {
    Renderer, Stave, StaveNote, Voice, Formatter,
    Accidental, StaveConnector, Beam,
  } = VF();

  const { tempo, timeSignature, keySignature } = composition;
  const beatsPerMeasure = timeSignature.numerator * (4 / timeSignature.denominator);

  const quantized = quantizeNotes(notes, tempo, timeSignature, state.ui.quantize);
  // A note is written as one piece per bar it spans, tied together
  const segments = splitAcrossBarlines(quantized, beatsPerMeasure);
  const { measures } = groupByMeasure(segments, timeSignature);

  // Where each written piece ended up, so the ties can be drawn once every
  // measure has been laid out and has real positions
  const segmentPlacement = new Map();

  // Keep drawing measures far enough to hold the step cursor, so stepping past
  // the last recorded note still has somewhere to show
  const stepping = state.transport.mode === 'step-recording';
  const cursorBeat = state.transport.currentTime / ((60 / tempo) * 1000);
  const cursorMeasure = stepping ? Math.floor(cursorBeat / beatsPerMeasure + 1e-6) : 0;
  const totalMeasures = Math.max(measures.size, 4, cursorMeasure + 1);

  // Layout
  const cw = container.clientWidth || 900;
  const MEASURES_PER_LINE = Math.max(2, Math.floor((cw - 60) / 280));
  const STAVE_W = Math.floor((cw - 40) / MEASURES_PER_LINE);
  const TREBLE_Y = 55;
  const BASS_OFFSET = 115; // pixels below treble stave top
  const SYSTEM_H = 220;    // pixels per system (treble + bass + gap)
  const MX = 10;

  const numLines = Math.ceil(totalMeasures / MEASURES_PER_LINE);
  const totalH = numLines * SYSTEM_H + 60;

  container.innerHTML = '';
  renderer = new Renderer(container, Renderer.Backends.SVG);
  renderer.resize(cw, totalH);
  svgCtx = renderer.getContext();

  for (let m = 0; m < totalMeasures; m++) {
    const line = Math.floor(m / MEASURES_PER_LINE);
    const col  = m % MEASURES_PER_LINE;
    const x = MX + col * STAVE_W;
    const tY = TREBLE_Y + line * SYSTEM_H;
    const bY = tY + BASS_OFFSET;
    const isFirst = m === 0;
    const isFirstInLine = col === 0;

    const trebleStave = new Stave(x, tY, STAVE_W);
    const bassStave   = new Stave(x, bY, STAVE_W);

    if (isFirstInLine) {
      trebleStave.addClef('treble');
      bassStave.addClef('bass');
    }
    if (isFirst) {
      trebleStave.addKeySignature(keySignature);
      bassStave.addKeySignature(keySignature);
      trebleStave.addTimeSignature(`${timeSignature.numerator}/${timeSignature.denominator}`);
      bassStave.addTimeSignature(`${timeSignature.numerator}/${timeSignature.denominator}`);
    }

    trebleStave.setContext(svgCtx).draw();
    bassStave.setContext(svgCtx).draw();

    recordStaveGeom(trebleStave, 'treble', m);
    recordStaveGeom(bassStave, 'bass', m);

    // Brace + connectors
    try {
      if (isFirstInLine) {
        new StaveConnector(trebleStave, bassStave).setType('singleLeft').setContext(svgCtx).draw();
      }
      if (isFirst) {
        new StaveConnector(trebleStave, bassStave).setType('brace').setContext(svgCtx).draw();
      }
      new StaveConnector(trebleStave, bassStave).setType('singleRight').setContext(svgCtx).draw();
    } catch (_) {}

    const measureNotes = measures.get(m) || [];
    const trebleNotes  = measureNotes.filter(n => isRightHand(n));
    const bassNotes    = measureNotes.filter(n => !isRightHand(n));

    const trebleTicks = buildTickables(trebleNotes, beatsPerMeasure, 'treble', keySignature, segmentPlacement, line);
    const bassTicks   = buildTickables(bassNotes,   beatsPerMeasure, 'bass',   keySignature, segmentPlacement, line);

    const beatPositions = drawSystem(
      [{ tickables: trebleTicks, stave: trebleStave, clef: 'treble' },
       { tickables: bassTicks,   stave: bassStave,   clef: 'bass' }],
      timeSignature, Formatter, Voice, Accidental, Beam, keySignature
    );

    // Chord labels
    if (measureNotes.length > 0) {
      drawChordLabels(measureNotes, trebleStave, beatsPerMeasure, keySignature, beatPositions);
    }

    // Step cursor takes the place of the playhead while step recording. The
    // playhead itself is an overlay rather than part of the drawing — see
    // movePlayhead.
    if (stepping) {
      drawStepCursor(cursorBeat, m, trebleStave, bassStave, beatsPerMeasure, beatPositions);
    }
  }

  drawTies(segments, segmentPlacement);
  drawSlurs(notes, segmentPlacement);

  playheadBeatsPerMeasure = beatsPerMeasure;
  playheadBeatMs = (60 / tempo) * 1000;
  movePlayhead(stepping ? null : currentTimeMs);
}

// ── Playhead ─────────────────────────────────────────────────────────────────
// A DOM element over the score rather than a line inside it. Drawn into the
// SVG it could only move by laying the whole score out again — which, on a
// piece of any length, costs hundreds of milliseconds and stalls playback.

let playheadEl = null;
let playheadBeatsPerMeasure = 4;
let playheadBeatMs = 500;

export function movePlayhead(currentTimeMs) {
  if (!container) return;
  if (!playheadEl) {
    playheadEl = document.createElement('div');
    playheadEl.id = 'sheet-playhead';
    playheadEl.className = 'sheet-playhead hidden';
    container.parentElement.appendChild(playheadEl);
  }
  if (currentTimeMs === null || !_staveGeom.length) {
    playheadEl.classList.add('hidden');
    return;
  }

  const currentBeat = currentTimeMs / playheadBeatMs;
  const measure = Math.floor(currentBeat / playheadBeatsPerMeasure);
  const treble = _staveGeom.find(g => g.measure === measure && g.clef === 'treble');
  const bass = _staveGeom.find(g => g.measure === measure && g.clef === 'bass');
  if (!treble || !bass) { playheadEl.classList.add('hidden'); return; }

  const beatFrac = (currentBeat - measure * playheadBeatsPerMeasure) / playheadBeatsPerMeasure;
  const x = treble.noteStartX + beatFrac * (treble.noteEndX - treble.noteStartX);
  const top = treble.y - 8;
  const height = (bass.y + 95) - top;

  // The container is padded and scrolls; the geometry is in SVG coordinates
  const pageTop = top + container.offsetTop;
  playheadEl.style.transform = `translate(${x + container.offsetLeft}px, ${pageTop}px)`;
  playheadEl.style.height = `${height}px`;
  playheadEl.classList.remove('hidden');
  followPlayhead(pageTop, height);
}

// ── Following the music ──────────────────────────────────────────────────────
// A score longer than the window is most of them, and a playhead you have to
// chase is no use at all. The systems stack down the page, so following means
// scrolling to the one being played — and only when it has left a comfortable
// band, or every frame would re-issue a scroll and the smoothing would never
// arrive anywhere.

const FOLLOW_MARGIN = 20;     // how close to the edge counts as "about to go"
const HANDBACK_MS = 2500;     // a deliberate look elsewhere is left alone
let followSuspendedUntil = 0;
let followTarget = null;
let followBoundTo = null;

// Only gestures count as the player taking over. Listening for `scroll` would
// catch this module's own scrolling and hand control back to nobody.
function watchForManualScroll(box) {
  if (followBoundTo === box) return;
  followBoundTo = box;
  const takeOver = () => { followSuspendedUntil = performance.now() + HANDBACK_MS; };
  box.addEventListener('wheel', takeOver, { passive: true });
  box.addEventListener('touchmove', takeOver, { passive: true });
}

function followPlayhead(pageTop, height) {
  const box = container.parentElement;
  if (!box) return;
  watchForManualScroll(box);

  const slack = box.scrollHeight - box.clientHeight;
  if (slack <= 0) return;
  if (performance.now() < followSuspendedUntil) return;

  const above = pageTop < box.scrollTop + FOLLOW_MARGIN;
  const below = pageTop + height > box.scrollTop + box.clientHeight - FOLLOW_MARGIN;
  if (!above && !below) { followTarget = null; return; }

  // A third of the way down, so the system after this one is already in sight
  // by the time the music reaches it
  const target = Math.max(0, Math.min(slack, pageTop - (box.clientHeight - height) / 3));
  // Mid-animation the scroll position is still short of the target, so compare
  // against what was asked for rather than where the box currently is
  if (followTarget !== null && Math.abs(target - followTarget) < 4) return;
  followTarget = target;
  box.scrollTo({ top: target, behavior: 'smooth' });
}

// ── Loop marker ──────────────────────────────────────────────────────────────
// The bars a loop covers, struck through in highlighter so the range is
// visible where the music is rather than only as two numbers in the toolbar.
// An overlay for the same reason the playhead is one: it changes far more often
// than the layout does, and re-laying out a long piece to move it costs
// hundreds of milliseconds.

let loopLayer = null;

// `startBar`/`endBar` are 1-based and endBar is inclusive, the same as
// everywhere else that names a stretch of bars. Pass null to clear.
export function markLoopRange(startBar, endBar) {
  if (!container) return;
  if (!loopLayer) {
    loopLayer = document.createElement('div');
    loopLayer.className = 'sheet-loop-layer';
    container.parentElement.appendChild(loopLayer);
  }
  loopLayer.replaceChildren();
  if (!startBar || !endBar || !_staveGeom.length) return;

  // One band per bar. Bars on the same system abut exactly, so they read as a
  // single stroke; a range that wraps to the next system breaks where the
  // music does, which is what a pen would have done too.
  let first = null;
  let last = null;
  for (let measure = startBar - 1; measure <= endBar - 1; measure++) {
    const treble = _staveGeom.find(g => g.measure === measure && g.clef === 'treble');
    const bass = _staveGeom.find(g => g.measure === measure && g.clef === 'bass');
    if (!treble || !bass) continue;
    const top = treble.y - 8;
    const height = (bass.y + 95) - top;
    const band = document.createElement('div');
    band.className = 'sheet-loop-band';
    band.style.transform =
      `translate(${treble.x + container.offsetLeft}px, ${top + container.offsetTop}px)`;
    band.style.width = `${treble.w}px`;
    band.style.height = `${height}px`;
    loopLayer.appendChild(band);
    const box = { x: treble.x, right: treble.x + treble.w, top, height };
    if (!first) first = box;
    last = box;
  }

  // A stroke you can take hold of by either end. The range is the thing being
  // worked on and the score is where it means something, so it is adjusted
  // there rather than only in two number fields at the top of the window.
  if (first) addLoopHandle('start', first.x, first.top, first.height);
  if (last) addLoopHandle('end', last.right, last.top, last.height);
}

const HANDLE_W = 12;

function addLoopHandle(edge, x, top, height) {
  const handle = document.createElement('div');
  handle.className = 'sheet-loop-handle';
  handle.id = `loop-handle-${edge}`;
  handle.dataset.edge = edge;
  handle.title = edge === 'start' ? 'Drag to move the start of the loop' : 'Drag to move the end of the loop';
  handle.style.transform =
    `translate(${x - HANDLE_W / 2 + container.offsetLeft}px, ${top + container.offsetTop}px)`;
  handle.style.width = `${HANDLE_W}px`;
  handle.style.height = `${height}px`;
  loopLayer.appendChild(handle);
}

// Which bar a point on the page is over, 1-based. The nearest one rather than
// only a direct hit, so dragging an edge past the end of a system still lands
// somewhere sensible instead of stalling.
export function barAtPoint(clientX, clientY) {
  if (!container || !_staveGeom.length) return null;
  const scroller = container.parentElement;
  const box = scroller.getBoundingClientRect();
  const px = clientX - box.left + scroller.scrollLeft - container.offsetLeft;
  const py = clientY - box.top + scroller.scrollTop - container.offsetTop;

  let best = null;
  let bestScore = Infinity;
  for (const g of _staveGeom) {
    if (g.clef !== 'treble') continue;
    const bass = _staveGeom.find(o => o.measure === g.measure && o.clef === 'bass');
    const top = g.y - 8;
    const bottom = (bass ? bass.y : g.y) + 95;
    const dy = py < top ? top - py : (py > bottom ? py - bottom : 0);
    const dx = px < g.x ? g.x - px : (px > g.x + g.w ? px - (g.x + g.w) : 0);
    // Which system the pointer is on settles it before which bar across it —
    // otherwise a drag drifting vertically snaps to the wrong line of music
    const score = dy * 1000 + dx;
    if (score < bestScore) { bestScore = score; best = g; }
  }
  return best ? best.measure + 1 : null;
}

// ── Slurs ────────────────────────────────────────────────────────────────────
// A slur marks notes played without separation. That is exactly what overlap
// in the raw timing means, so it is read from there — quantizing snaps each
// duration to the grid and erases the overlap, so this cannot wait until after.

const ATTACK_TOLERANCE_MS = 30; // notes struck together
// Legato writing overlaps by at least 40ms at ordinary grids, while notes a
// player merely failed to separate cleanly overlap by less than this
const OVERLAP_MIN_MS = 20;

function groupAttacks(notes) {
  const attacks = [];
  for (const note of [...notes].sort((a, b) => a.startTime - b.startTime)) {
    const last = attacks[attacks.length - 1];
    if (last && note.startTime - last.startTime <= ATTACK_TOLERANCE_MS) last.notes.push(note);
    else attacks.push({ startTime: note.startTime, notes: [note] });
  }
  return attacks;
}

// Maximal runs of two or more attacks where each sounds into the next
function findSlurRuns(notes) {
  const attacks = groupAttacks(notes);
  const runs = [];
  let run = null;

  for (let i = 0; i < attacks.length - 1; i++) {
    const current = attacks[i];
    const next = attacks[i + 1];
    const soundsUntil = Math.max(...current.notes.map(n => n.startTime + n.duration));

    if (soundsUntil - next.startTime > OVERLAP_MIN_MS) {
      if (!run) { run = [current]; runs.push(run); }
      run.push(next);
    } else {
      run = null;
    }
  }
  return runs;
}

// The last written piece of a note, which is where a slur ending on it lands
function lastPieceOf(noteId, placement) {
  let found = null;
  for (let i = 0; ; i++) {
    const piece = placement.get(`${noteId}:${i}`);
    if (!piece) return found;
    found = piece;
  }
}

function drawSlurs(rawNotes, placement) {
  const { Curve } = VF();
  if (!Curve || !rawNotes.length) return;

  // Each stave carries its own slurs, and a run is only meaningful within one
  for (const clefNotes of [rawNotes.filter(n => isRightHand(n)), rawNotes.filter(n => !isRightHand(n))]) {
    for (const run of findSlurRuns(clefNotes)) {
      const placed = run
        .map(attack => {
          const id = attack.notes[0].id;
          return { head: placement.get(`${id}:0`), tail: lastPieceOf(id, placement) };
        })
        .filter(p => p.head && p.tail);

      // A run crossing a system break becomes one slur per line rather than a
      // curve stretched between two systems
      let segment = [];
      const flush = () => {
        if (segment.length >= 2) {
          try {
            new Curve(segment[0].head.note, segment[segment.length - 1].tail.note, {})
              .setContext(svgCtx).draw();
          } catch (e) {
            console.warn('Slur draw:', e.message);
          }
        }
        segment = [];
      };

      for (const p of placed) {
        if (segment.length && p.head.line !== segment[0].head.line) flush();
        segment.push(p);
      }
      flush();
    }
  }
}

// Ties are drawn last: they need both ends to already have laid-out positions.
function drawTies(segments, placement) {
  const { StaveTie } = VF();
  if (!StaveTie) return;

  // One tie per pair of notes, carrying every notehead that continues
  const pairs = new Map();

  for (const seg of segments) {
    if (!seg.tiedToNext) continue;
    const from = placement.get(`${seg.id}:${seg.segmentIndex}`);
    const to   = placement.get(`${seg.id}:${seg.segmentIndex + 1}`);
    if (!from || !to) continue;

    const key = `${from.line}:${to.line}:${from.note.getAttribute('id')}:${to.note.getAttribute('id')}`;
    if (!pairs.has(key)) pairs.set(key, { from, to, firstIndices: [], lastIndices: [] });
    const pair = pairs.get(key);
    pair.firstIndices.push(from.keyIndex);
    pair.lastIndices.push(to.keyIndex);
  }

  for (const { from, to, firstIndices, lastIndices } of pairs.values()) {
    try {
      if (from.line === to.line) {
        new StaveTie({
          first_note: from.note, last_note: to.note,
          first_indices: firstIndices, last_indices: lastIndices,
        }).setContext(svgCtx).draw();
      } else {
        // Across a system break the tie is drawn as two halves: out to the end
        // of one line, and in from the start of the next
        new StaveTie({
          first_note: from.note, last_note: null,
          first_indices: firstIndices, last_indices: firstIndices,
        }).setContext(svgCtx).draw();
        new StaveTie({
          first_note: null, last_note: to.note,
          first_indices: lastIndices, last_indices: lastIndices,
        }).setContext(svgCtx).draw();
      }
    } catch (e) {
      console.warn('Tie draw:', e.message);
    }
  }
}

function buildTickables(staveNotes, beatsPerMeasure, clef, keySignature, segmentPlacement, line) {
  const { StaveNote } = VF();
  const chordGroups = groupIntoChords(staveNotes);
  const filled = fillWithRests(chordGroups, beatsPerMeasure);
  const tickables = [];

  for (const item of filled) {
    if (item.isRest) {
      // Split rest into clean note values
      const parts = splitDurationToNoteValues(item.durationBeats);
      for (const beats of parts) {
        const { vexDuration } = findBestDuration(beats);
        const restKey = clef === 'bass' ? 'd/3' : 'b/4';
        try {
          tickables.push(new StaveNote({ keys: [restKey], duration: vexDuration + 'r', clef }));
        } catch (_) {
          try { tickables.push(new StaveNote({ keys: ['b/4'], duration: 'qr' })); } catch (__) {}
        }
      }
    } else {
      // Sorted by pitch so a key's index is stable — ties address noteheads
      // by index into this array
      const group = [...item.group].sort((a, b) => a.pitch - b.pitch);
      const keys = group.map(n => midiToVexKey(n.pitch, keySignature, n.spelling));
      const { vexDuration } = findBestDuration(group[0].durationBeats);
      try {
        const note = new StaveNote({ keys, duration: vexDuration, clef });
        // The 'd' suffix already carries the tick count; the dot itself is a
        // modifier and has to be attached to be drawn
        if (vexDuration.includes('d')) VF().Dot.buildAndAttach([note], { all: true });
        tickables.push(note);

        if (segmentPlacement) {
          group.forEach((seg, keyIndex) => {
            segmentPlacement.set(`${seg.id}:${seg.segmentIndex}`, { note, keyIndex, line });
          });
        }
      } catch (e) {
        console.warn('StaveNote error:', keys, vexDuration, e.message);
      }
    }
  }
  return tickables;
}

// Both staves of a measure must be formatted by one Formatter. Formatting them
// separately spaces each stave across the full width on its own tickable count,
// so a beat carried by only one clef lands at a different x than the same beat
// on the other clef and the measure reads as having more beats than it does.
function drawSystem(parts, timeSignature, Formatter, Voice, Accidental, Beam, key) {
  const active = parts.filter(p => p.tickables.length);
  if (!active.length) return [];

  try {
    for (const part of active) {
      part.voice = new Voice({
        num_beats: timeSignature.numerator,
        beat_value: timeSignature.denominator,
      }).setMode(Voice.Mode.SOFT);
      part.voice.addTickables(part.tickables);
    }

    const voices = active.map(p => p.voice);
    Accidental.applyAccidentals(voices, key);

    // Every stave in the system shares an x range, so measure it once
    const { stave } = active[0];
    const noteStartX = stave.getNoteStartX();
    const noteEndX   = stave.getX() + stave.getWidth() - 10;
    const availW = Math.max(80, noteEndX - noteStartX);
    new Formatter().joinVoices(voices).format(voices, availW);

    for (const part of active) {
      part.voice.draw(svgCtx, part.stave);

      // Beam non-rest notes in groups of 8th/16th
      const nonRest = part.tickables.filter(t => {
        try { return !t.isRest(); } catch (_) { return true; }
      });
      Beam.generateBeams(nonRest).forEach(b => b.setContext(svgCtx).draw());
    }

    // Where each beat actually landed, so the step cursor can sit on a real
    // tickable instead of a linear guess — VexFlow does not space time evenly
    const quarter = VF().RESOLUTION / 4;
    const positions = [];
    let beat = 0;
    for (const t of active[0].tickables) {
      positions.push({ beat, x: t.getAbsoluteX() });
      beat += t.getTicks().value() / quarter;
    }
    return positions;
  } catch (e) {
    console.warn('System draw:', e.message);
    return [];
  }
}

function drawChordLabels(measureNotes, trebleStave, beatsPerMeasure, keySignature, beatPositions) {
  const chordGroups = groupIntoChords(measureNotes);
  const noteStartX = trebleStave.getNoteStartX();
  const noteEndX   = trebleStave.getX() + trebleStave.getWidth() - 10;
  const availW = noteEndX - noteStartX;
  const svgEl = container.querySelector('svg');
  const svgRect = svgEl ? svgEl.getBoundingClientRect() : null;
  const containerRect = container.getBoundingClientRect();

  // One event per attack, so a run of them can be tested as a single chord.
  // The tail of a tie is the same note still sounding, not a new attack.
  const events = chordGroups
    .map(g => ({
      beat: g[0].beatInMeasure,
      pitches: g.filter(n => !n.tiedFromPrev).map(n => n.pitch),
    }))
    .filter(e => e.pitches.length);

  const svgY = trebleStave.getY() - 4;
  const offsetX = svgRect ? (svgRect.left - containerRect.left) : 0;
  const offsetY = svgRect ? (svgRect.top  - containerRect.top)  : 0;

  for (const run of detectChordRuns(events, keySignature, beatsPerMeasure)) {
    // Sit over the actual note column where one exists, since VexFlow does not
    // space time evenly; otherwise fall back to a linear estimate
    const hit = beatPositions && beatPositions.find(p => p.beat >= run.beat - 1e-6);
    const svgX = hit ? hit.x : noteStartX + (run.beat / beatsPerMeasure) * availW;

    _chordOverlayData.push({
      label: run.label,
      pitches: run.pitches,
      arpeggiated: run.arpeggiated,
      x: svgX + offsetX,
      y: svgY + offsetY,
    });
  }
}

// Where the next step-recorded note will land. Distinct from the playhead so
// it is obvious the score is waiting for input rather than playing back.
function drawStepCursor(cursorBeat, measureIdx, trebleStave, bassStave, beatsPerMeasure, beatPositions) {
  const mIdx = Math.floor(cursorBeat / beatsPerMeasure + 1e-6);
  if (mIdx !== measureIdx) return;

  const inMeasure = cursorBeat - mIdx * beatsPerMeasure;
  const noteStartX = trebleStave.getNoteStartX();
  const noteEndX   = trebleStave.getX() + trebleStave.getWidth() - 10;

  // Sit on the tickable holding this beat; fall back to a linear estimate
  let x = noteStartX + (inMeasure / beatsPerMeasure) * (noteEndX - noteStartX);
  const hit = beatPositions && beatPositions.find(p => p.beat >= inMeasure - 1e-6);
  if (hit) x = hit.x;

  const top = trebleStave.getY() - 16;
  const bottom = bassStave.getYForLine(4) + 10;

  try {
    svgCtx.save();
    svgCtx.setStrokeStyle('rgba(91,192,235,0.95)');
    svgCtx.setLineWidth(2);
    svgCtx.beginPath();
    svgCtx.moveTo(x, top + 7);
    svgCtx.lineTo(x, bottom);
    svgCtx.stroke();
    // Solid tab at the top so the cursor reads as an insertion point
    svgCtx.setFillStyle('rgba(91,192,235,0.95)');
    svgCtx.fillRect(x - 6, top, 12, 7);
    svgCtx.restore();
  } catch (_) {}
}

