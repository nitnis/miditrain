// VexFlow 4.x sheet music renderer (grand staff)
import { state } from './state.js';
import { quantizeNotes, groupByMeasure, groupIntoChords, fillWithRests, findBestDuration, splitAcrossBarlines } from './quantizer.js';
import { detectChordRuns, keyUsesFlats } from './chords.js';

function VF() { return window.Vex?.Flow; }

// MIDI note → VexFlow "note/octave" string
const NOTE_SHARP = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const NOTE_FLAT  = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];

function midiToVexKey(midi, useFlats) {
  const names = useFlats ? NOTE_FLAT : NOTE_SHARP;
  return `${names[midi % 12]}/${Math.floor(midi / 12) - 1}`;
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

function recordStaveGeom(stave, clef) {
  const topLineY = stave.getYForLine(0);
  const spacing = stave.getYForLine(1) - topLineY;
  if (!spacing) return;
  _staveGeom.push({
    clef,
    x: stave.getX(),
    w: stave.getWidth(),
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
  const useFlats = keyUsesFlats(keySignature);
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

    recordStaveGeom(trebleStave, 'treble');
    recordStaveGeom(bassStave, 'bass');

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
    const trebleNotes  = measureNotes.filter(n => n.pitch >= 60);
    const bassNotes    = measureNotes.filter(n => n.pitch <  60);

    const trebleTicks = buildTickables(trebleNotes, beatsPerMeasure, 'treble', useFlats, segmentPlacement, line);
    const bassTicks   = buildTickables(bassNotes,   beatsPerMeasure, 'bass',   useFlats, segmentPlacement, line);

    const beatPositions = drawSystem(
      [{ tickables: trebleTicks, stave: trebleStave, clef: 'treble' },
       { tickables: bassTicks,   stave: bassStave,   clef: 'bass' }],
      timeSignature, Formatter, Voice, Accidental, Beam, keySignature
    );

    // Chord labels
    if (measureNotes.length > 0) {
      drawChordLabels(measureNotes, trebleStave, beatsPerMeasure, useFlats, beatPositions);
    }

    // Step cursor takes the place of the playhead while step recording
    if (stepping) {
      drawStepCursor(cursorBeat, m, trebleStave, bassStave, beatsPerMeasure, beatPositions);
    } else if (currentTimeMs !== null) {
      drawPlayhead(currentTimeMs, m, trebleStave, bassStave, tempo, beatsPerMeasure);
    }
  }

  drawTies(segments, segmentPlacement);
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

function buildTickables(staveNotes, beatsPerMeasure, clef, useFlats, segmentPlacement, line) {
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
      const keys = group.map(n => midiToVexKey(n.pitch, useFlats));
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

function drawChordLabels(measureNotes, trebleStave, beatsPerMeasure, useFlats, beatPositions) {
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

  for (const run of detectChordRuns(events, useFlats, beatsPerMeasure)) {
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

function drawPlayhead(currentTimeMs, measureIdx, trebleStave, bassStave, tempo, beatsPerMeasure) {
  const beatMs = (60 / tempo) * 1000;
  const currentBeat = currentTimeMs / beatMs;
  const mIdx = Math.floor(currentBeat / beatsPerMeasure);
  if (mIdx !== measureIdx) return;

  const beatFrac = (currentBeat - mIdx * beatsPerMeasure) / beatsPerMeasure;
  const noteStartX = trebleStave.getNoteStartX();
  const noteEndX   = trebleStave.getX() + trebleStave.getWidth() - 10;
  const x = noteStartX + beatFrac * (noteEndX - noteStartX);

  try {
    svgCtx.save();
    svgCtx.beginPath();
    svgCtx.setStrokeStyle('rgba(233, 69, 96, 0.8)');
    svgCtx.setLineWidth(2);
    svgCtx.moveTo(x, trebleStave.getY() - 8);
    svgCtx.lineTo(x, bassStave.getY() + 95);
    svgCtx.stroke();
    svgCtx.restore();
  } catch (_) {}
}
