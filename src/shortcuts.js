// Keyboard shortcut registry: one place that owns what the keys do, so the
// help panel and the dispatcher cannot disagree about the current bindings.
//
// An action carries a group as well as a scope predicate. The scope decides
// whether it fires; the group decides whether two actions can share a key —
// Backspace means "delete the last step" while stepping and "delete the
// selected notes" in the editor, and those never apply at the same time.

const STORAGE_KEY = 'miditrain.shortcuts';

let actions = [];
let overrides = {};
let captureCallback = null;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch { /* storage full or blocked; bindings stay for this session */ }
}

export function bindingsFor(action) {
  const id = typeof action === 'string' ? action : action.id;
  const def = actions.find(a => a.id === id);
  return overrides[id] || (def ? def.defaultBindings : []);
}

export function isCustomised(id) {
  return Boolean(overrides[id]);
}

function sameBinding(a, b) {
  return a.code === b.code && !!a.shift === !!b.shift && !!a.mod === !!b.mod;
}

function matches(e, binding) {
  return e.code === binding.code
    && e.shiftKey === !!binding.shift
    && (e.ctrlKey || e.metaKey) === !!binding.mod
    && !e.altKey;
}

// Editable fields own their own keys
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' ||
         el.isContentEditable;
}

export function bindingFromEvent(e) {
  return {
    code: e.code,
    shift: e.shiftKey,
    mod: e.ctrlKey || e.metaKey,
  };
}

const KEY_NAMES = {
  Space: 'Space', Period: '.', NumpadDecimal: 'Num .', Comma: ',',
  Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
  Backspace: '⌫', Delete: 'Del', Enter: '↵', Escape: 'Esc', Tab: 'Tab',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
};

function keyName(code) {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

export function formatBinding(binding) {
  if (!binding) return '—';
  const parts = [];
  if (binding.mod) parts.push(isMac ? '⌘' : 'Ctrl');
  if (binding.shift) parts.push(isMac ? '⇧' : 'Shift');
  parts.push(keyName(binding.code));
  return parts.join(isMac ? '' : '+');
}

// A key is free unless something that can be active at the same time already
// holds it. Two actions in the same group collide, and two global ones collide.
// A context action sharing a key with a global one is not a collision: the
// context is matched first and deliberately shadows it — Space retries while
// the results are up, and drives the transport everywhere else.
export function findConflict(actionId, binding) {
  const target = actions.find(a => a.id === actionId);
  if (!target) return null;
  return actions.find(a =>
    a.id !== actionId &&
    a.group === target.group &&
    bindingsFor(a).some(b => sameBinding(b, binding))
  ) || null;
}

export function setBinding(actionId, binding) {
  overrides[actionId] = [binding];
  save();
}

export function resetBinding(actionId) {
  delete overrides[actionId];
  save();
}

export function resetAllBindings() {
  overrides = {};
  save();
}

export function getActions() {
  return actions;
}

// While the help panel is listening for a new key, that key must not also fire
// the action it is being assigned to
export function startCapture(callback) { captureCallback = callback; }
export function cancelCapture() { captureCallback = null; }

function dispatch(e) {
  if (captureCallback) {
    if (e.code === 'Escape') {
      const cb = captureCallback;
      captureCallback = null;
      cb(null);
    } else if (!['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
                 'MetaLeft', 'MetaRight', 'AltLeft', 'AltRight'].includes(e.code)) {
      const cb = captureCallback;
      captureCallback = null;
      cb(bindingFromEvent(e));
    }
    e.preventDefault();
    return;
  }

  if (isTypingTarget(e.target)) return;

  for (const action of actions) {
    if (!bindingsFor(action).some(b => matches(e, b))) continue;
    if (action.scope && !action.scope()) continue;
    e.preventDefault();
    action.run(e);
    return;
  }
}

export function initShortcuts(actionDefs) {
  actions = actionDefs;
  overrides = load();
  // Drop overrides for actions that no longer exist
  for (const id of Object.keys(overrides)) {
    if (!actions.some(a => a.id === id)) delete overrides[id];
  }
  document.addEventListener('keydown', dispatch);
}
