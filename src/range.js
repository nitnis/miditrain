// Which bars the app currently means by "the section".
//
// A loop range is how MidiTrain names a stretch of music: set it and press
// Play to loop it, arm training and it trains those bars, arm learn mode and it
// walks them. Each of those read the same three state fields for itself, which
// is how the section walk came to divide the whole piece while everything else
// was honouring the marked range.
import { state } from './state.js';
import { barRangeMs } from './quantizer.js';

// 1-based, endBar inclusive — or null when nothing is marked
export function loopBars() {
  const { loopEnabled, loopStartBar, loopEndBar } = state.transport;
  return loopEnabled ? { startBar: loopStartBar, endBar: loopEndBar } : null;
}

// The same stretch in milliseconds, for the code that works in time
export function loopRangeMs() {
  const bars = loopBars();
  if (!bars) return null;
  const { tempo, timeSignature } = state.composition;
  return barRangeMs(bars.startBar, bars.endBar, tempo, timeSignature);
}
