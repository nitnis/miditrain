// Is the piece on the stand being played with a swing?
//
// One question, asked in three places: the notation writes swung eighths
// straight and marks them, the metronome puts its offbeat click where a swung
// eighth actually lands, and the counting overlay lights the "&" in the same
// place. Answered here rather than in any one of them, so a player cannot hear
// a click that disagrees with what they are reading.
import { state } from './state.js';
import { detectSwing, subdivisionOffsets, swingOffbeat, SWING_AMOUNTS, DEFAULT_SWING } from './quantizer.js';

// The answer costs a pass over every note, and the metronome asks forty times a
// second. It only changes when the music or the setting does, and the notes
// arrive as a new array whenever the piece does, so identity is enough to tell.
let memo = { notes: null, tempo: null, quantize: null, setting: null, answer: false };

export function swinging() {
  const { composition, ui } = state;
  if (ui.swing === 'on') return true;
  if (ui.swing === 'off') return false;

  const { notes, tempo } = composition;
  if (memo.notes === notes && memo.tempo === tempo &&
      memo.quantize === ui.quantize && memo.setting === ui.swing) {
    return memo.answer;
  }
  const answer = detectSwing(notes, tempo, ui.quantize);
  memo = { notes, tempo, quantize: ui.quantize, setting: ui.swing, answer };
  return answer;
}

// How hard, as where the offbeat of a pair lands in its beat. Only meaningful
// while the piece is being swung at all, so the two are usually asked together.
export function swingAmount() {
  return swingOffbeat(state.ui.swingAmount);
}

// How it is named on the page and in the controls
export function swingNames() {
  return SWING_AMOUNTS[state.ui.swingAmount] || SWING_AMOUNTS[DEFAULT_SWING];
}

// What the notation and the click are both worked out from: 0 when the piece is
// straight, otherwise where the offbeat goes
export function swingWidth() {
  return swinging() ? swingAmount() : 0;
}

// Where the clicks of a beat fall, given how the piece is being played
export function beatOffsets(subs) {
  return subdivisionOffsets(subs, swingWidth());
}
