// Interactive note editor for the piano roll canvas
import { state, emit } from './state.js';
import { seekTo } from './transport.js';

// Layout info shared with renderPianoRoll (set each render)
let _layout = { msPerPx: 1, minPitch: 21, noteH: 10, h: 0, w: 0, leftMargin: 0, gridX: 0 };
let _noteRects = []; // [{ id, x, y, w, h }] — set each render

export function setEditorLayout(layout, noteRects) {
  _layout = layout;
  _noteRects = noteRects;
}

let canvas = null;
let dragState = null; // { type: 'move'|'resize', ids: Set, noteId, startX, startY, origNotes: Map<id, note> }

export function initNoteEditor(canvasEl) {
  canvas = canvasEl;
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseUp);
  // Editing shortcuts live in the shortcut registry, not here
}

function getPos(e) {
  const r = canvas.getBoundingClientRect();
  const scaleX = canvas.width / r.width;
  const scaleY = canvas.height / r.height;
  return { x: (e.clientX - r.left) * scaleX, y: (e.clientY - r.top) * scaleY };
}

function hitTest(x, y) {
  // Last element = topmost (drawn last)
  for (let i = _noteRects.length - 1; i >= 0; i--) {
    const r = _noteRects[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  return null;
}

function isResizeHandle(x, rect) {
  return x >= rect.x + rect.w - 8;
}

function onMouseDown(e) {
  const pos = getPos(e);

  // Clicks inside the piano key strip don't interact with notes
  if (pos.x < _layout.leftMargin) return;

  const hit = hitTest(pos.x, pos.y);

  if (!hit) {
    clearSelection();
    // Empty grid: move the playhead to where the click landed
    if (state.transport.mode !== 'step-recording') {
      seekTo(Math.max(0, (pos.x - _layout.gridX) * _layout.msPerPx));
    }
    return;
  }

  // Multi-select with shift
  if (e.shiftKey) {
    const sel = state.ui.editorSelectedNotes;
    if (sel.has(hit.id)) sel.delete(hit.id);
    else sel.add(hit.id);
    emit('editor:selection', sel);
  } else {
    if (!state.ui.editorSelectedNotes.has(hit.id)) {
      state.ui.editorSelectedNotes.clear();
      state.ui.editorSelectedNotes.add(hit.id);
      emit('editor:selection', state.ui.editorSelectedNotes);
    }
  }

  const type = isResizeHandle(pos.x, hit) ? 'resize' : 'move';
  const origNotes = new Map();
  for (const id of state.ui.editorSelectedNotes) {
    const n = state.composition.notes.find(n => n.id === id);
    if (n) origNotes.set(id, { ...n });
  }

  dragState = { type, noteId: hit.id, startX: pos.x, startY: pos.y, origNotes };
  canvas.style.cursor = type === 'resize' ? 'ew-resize' : 'grabbing';
  e.preventDefault();
}

function onMouseMove(e) {
  const pos = getPos(e);

  if (!dragState) {
    const hit = hitTest(pos.x, pos.y);
    canvas.style.cursor = hit
      ? (isResizeHandle(pos.x, hit) ? 'ew-resize' : 'grab')
      : 'default';
    return;
  }

  const dx = pos.x - dragState.startX;
  const dy = pos.y - dragState.startY;

  if (dragState.type === 'move') {
    const dTime = dx * _layout.msPerPx;
    const dPitch = -Math.round(dy / _layout.noteH);
    for (const [id, orig] of dragState.origNotes) {
      const note = state.composition.notes.find(n => n.id === id);
      if (!note) continue;
      note.startTime = Math.max(0, orig.startTime + dTime);
      note.pitch = Math.max(21, Math.min(108, orig.pitch + dPitch));
    }
  } else if (dragState.type === 'resize') {
    const note = state.composition.notes.find(n => n.id === dragState.noteId);
    const orig = dragState.origNotes.get(dragState.noteId);
    if (note && orig) {
      note.duration = Math.max(50, orig.duration + dx * _layout.msPerPx);
    }
  }

  emit('transport:noteschanged', state.composition.notes);
}

function onMouseUp() {
  if (dragState) {
    dragState = null;
    canvas.style.cursor = 'default';
    emit('transport:noteschanged', state.composition.notes);
  }
}

export function clearSelection() {
  state.ui.editorSelectedNotes.clear();
  emit('editor:selection', state.ui.editorSelectedNotes);
}

export function getSelectedIds() {
  return state.ui.editorSelectedNotes;
}
