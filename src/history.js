// Undo/redo over the composition's notes.
//
// Snapshot-based rather than a command log: every edit path in the app already
// ends in `transport:noteschanged`, so one listener covers editing, step
// recording, recording and Clear All without each having to remember to
// register an inverse operation. Compositions are small enough that copying
// the note list is cheaper than the bookkeeping a command log would need.
import { state, update, emit, on } from './state.js';

const MAX_ENTRIES = 100;
// Long enough that a drag or a fast chord lands as one entry, short enough
// that consecutive edits stay separate
const COALESCE_MS = 250;

let stack = [{ tempo: 120, notes: [] }];
let index = 0;
let applying = false;   // suppress capture while restoring a snapshot
let pending = null;

// The tempo rides along with the notes: changing it rescales every note time,
// so a snapshot of the notes alone would restore old timings under a new
// tempo and land the music off the beat.
function snapshot() {
  return {
    tempo: state.composition.tempo,
    notes: state.composition.notes.map(n => ({ ...n })),
  };
}

function matchesCurrentEntry(snap) {
  const entry = stack[index];
  if (entry.tempo !== snap.tempo) return false;
  if (entry.notes.length !== snap.notes.length) return false;
  for (let i = 0; i < snap.notes.length; i++) {
    const a = entry.notes[i], b = snap.notes[i];
    if (a.id !== b.id || a.pitch !== b.pitch || a.startTime !== b.startTime ||
        a.duration !== b.duration || a.velocity !== b.velocity) return false;
  }
  return true;
}

function status() {
  return { canUndo: canUndo(), canRedo: canRedo() };
}

export function canUndo() { return index > 0; }
export function canRedo() { return index < stack.length - 1; }

function capture() {
  clearTimeout(pending);
  pending = null;

  const snap = snapshot();
  if (matchesCurrentEntry(snap)) return;

  stack = stack.slice(0, index + 1);
  stack.push(snap);
  if (stack.length > MAX_ENTRIES) stack.shift();
  index = stack.length - 1;
  emit('history:changed', status());
}

function schedule() {
  clearTimeout(pending);
  pending = setTimeout(capture, COALESCE_MS);
}

function apply(snap) {
  applying = true;
  state.composition.notes = snap.notes.map(n => ({ ...n }));
  update('composition.tempo', snap.tempo);

  // Selections can outlive the notes they point at
  const live = new Set(state.composition.notes.map(n => n.id));
  for (const id of state.ui.editorSelectedNotes) {
    if (!live.has(id)) state.ui.editorSelectedNotes.delete(id);
  }

  emit('transport:noteschanged', state.composition.notes);
  emit('editor:selection', state.ui.editorSelectedNotes);
  applying = false;
  emit('history:changed', status());
}

export function undo() {
  // Commit anything still coalescing, or the edit being undone was never
  // recorded and undo would skip past it to the previous one
  if (pending) capture();
  if (!canUndo()) return false;
  index--;
  apply(stack[index]);
  return true;
}

export function redo() {
  if (pending) capture();
  if (!canRedo()) return false;
  index++;
  apply(stack[index]);
  return true;
}

// Start again from whatever is loaded — a new or opened composition has no
// history worth keeping
export function resetHistory() {
  clearTimeout(pending);
  pending = null;
  stack = [snapshot()];
  index = 0;
  emit('history:changed', status());
}

export function initHistory() {
  resetHistory();

  on('transport:noteschanged', () => {
    if (applying) return;
    // A whole take is one entry, taken when recording stops
    if (state.transport.mode === 'recording') return;
    schedule();
  });

  // Catches the end of a recording take; a no-op otherwise, since an
  // unchanged note list never produces an entry
  on('transport:stop', () => {
    if (!applying) schedule();
  });
}
