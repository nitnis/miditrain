// A hand drawn on the keyboard, instead of a number written on the key.
//
// A digit tells you which finger. It does not tell you what the rest of the
// hand is doing, and the rest of the hand is most of the instruction — where it
// sits, which way it is facing, and above all when the thumb has to go under.
// "Play this with 1" and "tuck your thumb under your third finger onto this
// note" are the same digit and completely different advice, and the second one
// is the thing that has to be learned.
//
// ── What is known and what is guessed ────────────────────────────────────────
// Only the fingers actually playing have a key of their own. The other three or
// four are somewhere, and where is a guess: the hand is fitted through the
// fingers that are anchored and the rest are spaced out along it. That is
// honest enough for the purpose — the shape says "your hand is about here,
// facing this way" — and it is drawn faintly, with only the playing fingers
// solid, so the guessed part does not read as instruction.

const TAU = Math.PI * 2;

// A hand at rest covers about one white key per finger
const DEFAULT_SPACING = 1.0;
// How far a finger can be pushed from where the fit puts it before the shape
// stops looking like a hand
const MAX_SPREAD = 2.6;

const COLORS = {
  right: { skin: 'rgba(61,139,253,0.30)', edge: 'rgba(125,180,255,0.85)', live: '#9ecbff' },
  left:  { skin: 'rgba(244,114,182,0.30)', edge: 'rgba(255,163,209,0.85)', live: '#ffc2e0' },
};

// ── Fitting a hand through the notes it is playing ───────────────────────────
// Finger f sits at x = base + step * (f - 1), with step negative for the left
// hand because its little finger is the low one. Two or more anchors give both
// numbers by least squares; one anchor fixes the base and leaves the step at
// what a relaxed hand measures.
function fitHand(anchors, hand, whiteWidth, centreOf) {
  const points = [];
  for (const [finger, pitch] of anchors) {
    const x = centreOf(pitch);
    if (x != null) points.push({ f: finger - 1, x });
  }
  if (!points.length) return null;

  const nominal = whiteWidth * DEFAULT_SPACING * (hand === 'left' ? -1 : 1);
  if (points.length === 1) {
    return { base: points[0].x - nominal * points[0].f, step: nominal };
  }

  const n = points.length;
  const sf = points.reduce((s, p) => s + p.f, 0);
  const sx = points.reduce((s, p) => s + p.x, 0);
  const sff = points.reduce((s, p) => s + p.f * p.f, 0);
  const sfx = points.reduce((s, p) => s + p.f * p.x, 0);
  const denom = n * sff - sf * sf;
  if (!denom) return { base: sx / n - nominal * (sf / n), step: nominal };

  let step = (n * sfx - sf * sx) / denom;
  // A chord of neighbouring keys would otherwise squash the hand to nothing,
  // and one spanning a tenth would stretch it past anything a hand does
  const lo = whiteWidth * 0.45, hi = whiteWidth * MAX_SPREAD;
  const sign = hand === 'left' ? -1 : 1;
  step = sign * Math.min(hi, Math.max(lo, Math.abs(step)));
  const base = (sx - step * sf) / n;
  return { base, step };
}

// ── The animated part ────────────────────────────────────────────────────────
// Each hand keeps where it is actually drawn and eases towards where it should
// be, so a fingering that jumps an octave reads as the hand travelling rather
// than teleporting.

const EASE = 0.22;
const drawn = new Map();  // hand → { x: [5], settled }

function easeTowards(hand, targets) {
  let state = drawn.get(hand);
  if (!state || !state.settled) {
    state = { x: targets.slice(), settled: true };
    drawn.set(hand, state);
    return state.x;
  }
  for (let i = 0; i < 5; i++) {
    const gap = targets[i] - state.x[i];
    // Snap rather than crawl the last pixel, and never lag a big leap so far
    // behind that the hand is drawn where no note is
    state.x[i] += Math.abs(gap) < 0.6 ? gap : gap * EASE;
  }
  return state.x;
}

export function forgetHands() {
  drawn.clear();
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function fingerTip(x, geo) {
  const key = geo.keyAt(x);
  const onBlack = key && !key.isWhite;
  return { y: onBlack ? geo.blackDepth : geo.whiteDepth, onBlack };
}

function palmBox(xs, hand, geo) {
  // The palm spans the four fingers; the thumb hangs off its near side
  const knuckles = xs.slice(1);
  const left = Math.min(...knuckles);
  const right = Math.max(...knuckles);
  const pad = geo.whiteWidth * 0.35;
  return {
    x0: left - pad, x1: right + pad,
    y0: geo.height * 0.05, y1: geo.height * 0.30,
    thumbSide: hand === 'left' ? right + pad : left - pad,
  };
}

function drawFinger(ctx, fromX, fromY, toX, toY, width, color, dashed) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  if (dashed) ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  // A finger bends; a straight line reads as a stick
  ctx.quadraticCurveTo(fromX + (toX - fromX) * 0.35, fromY + (toY - fromY) * 0.75, toX, toY);
  ctx.stroke();
  ctx.restore();
}

function drawTip(ctx, x, y, r, color, live, edge) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = live ? color : 'rgba(255,255,255,0.10)';
  ctx.fill();
  ctx.lineWidth = live ? 2 : 1;
  ctx.strokeStyle = live ? color : edge;
  ctx.stroke();
}

// The crossing, which is the thing the numbers could never show. Going up, the
// thumb travels beneath the hand and comes out the far side; coming down, the
// third or fourth finger lifts over the top of it. Drawn as an arc from where
// the hand was to where the crossing finger lands — under the knuckles for a
// thumb, over the top of them for a finger.
function drawCrossing(ctx, crossing, xs, geo, color, phase) {
  // Where the hand came from, not where the fit has since put that finger. The
  // hand has already moved on by the time the thumb lands, so reading the pivot
  // out of the current shape draws the arc a couple of keys past the note it
  // actually left.
  const pivotX = crossing.fromX;
  const toX = xs[crossing.finger - 1];
  if (pivotX == null || toX == null) return;

  const under = crossing.kind === 'thumbUnder';
  const midX = (pivotX + toX) / 2;

  ctx.save();
  // Seen from above, the near edge of the keys is the bottom of the picture, so
  // a thumb travelling under the hand travels downwards. Only the thumb gets a
  // path drawn: it disappears behind the palm and needs one to explain where it
  // went. A finger crossing over is already drawn lying across the thumb, and
  // an arc for it would have to peak above the palm — which, on a keyboard this
  // short, is off the top of the picture.
  if (under) {
    const endY = geo.whiteDepth - 8;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.setLineDash([5, 4]);
    ctx.lineDashOffset = -phase * 9;
    ctx.beginPath();
    ctx.moveTo(pivotX, geo.height * 0.42);
    ctx.quadraticCurveTo(midX, geo.height * 0.99, toX, endY);
    ctx.stroke();
    ctx.setLineDash([]);

    // An arrowhead at the landing, so which way it travels is not left to be
    // worked out from a curve a single key wide
    const dir = Math.sign(toX - pivotX) || 1;
    ctx.beginPath();
    ctx.moveTo(toX + dir * 4, endY);
    ctx.lineTo(toX - dir * 3, endY - 4.5);
    ctx.lineTo(toX - dir * 3, endY + 4.5);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Two adjacent keys leave a curve barely wider than one, which on its own is
  // not enough to tell a crossing from a smudge. It happens rarely enough that
  // naming it costs nothing.
  const label = under ? 'under' : 'over';
  const size = Math.max(7, Math.min(10, geo.whiteWidth * 0.38));
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  // Out at the edge the arc reaches for rather than across the hand, which on a
  // keyboard this short is entirely fingers
  ctx.textBaseline = under ? 'bottom' : 'top';
  const labelY = under ? geo.height - 3 : 2;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(6,10,24,0.85)';
  ctx.lineJoin = 'round';
  // Set back at the note the hand is leaving rather than the one it lands on,
  // which for two adjacent keys is the only room there is to not sit on the
  // fingertip that just arrived
  const labelX = pivotX - Math.sign(toX - pivotX) * geo.whiteWidth * 0.5;
  ctx.strokeText(label, labelX, labelY);
  ctx.fillStyle = color;
  ctx.fillText(label, labelX, labelY);
  ctx.restore();
}

// One hand. `plan` is { hand, anchors: Map<finger,pitch>, live: Set<finger>,
// crossing: { kind, finger, fromPitch } | null }
function drawHand(ctx, plan, geo, phase) {
  const fit = fitHand(plan.anchors, plan.hand, geo.whiteWidth, geo.centreOf);
  if (!fit) return;

  const targets = [];
  for (let f = 1; f <= 5; f++) {
    const anchored = plan.anchors.get(f);
    const x = anchored != null ? geo.centreOf(anchored) : fit.base + fit.step * (f - 1);
    targets.push(Math.max(-20, Math.min(geo.width + 20, x)));
  }
  const xs = easeTowards(plan.hand, targets);

  const skin = COLORS[plan.hand] || COLORS.right;
  const palm = palmBox(xs, plan.hand, geo);
  const crossing = plan.crossing
    ? { ...plan.crossing, fromX: geo.centreOf(plan.crossing.fromPitch) }
    : null;
  const thumbUnder = crossing && crossing.kind === 'thumbUnder';
  const fingerOver = crossing && crossing.kind === 'fingerOver';

  ctx.save();

  // The thumb goes down first when it is passing under, so the palm is painted
  // over its base and it really does disappear beneath the hand
  // The thumb comes off the side of the hand, not the end of it, and is thicker
  // and shorter than the fingers. Drawn like a fifth finger it reads as one,
  // and then nothing about the picture says which way round the hand is.
  const drawThumb = () => {
    const tip = fingerTip(xs[0], geo);
    drawFinger(ctx, palm.thumbSide, palm.y0 + (palm.y1 - palm.y0) * 0.62,
               xs[0], tip.y - 3, geo.whiteWidth * 0.52, skin.edge, false);
  };
  if (thumbUnder) drawThumb();

  // Palm
  ctx.beginPath();
  ctx.roundRect(palm.x0, palm.y0, palm.x1 - palm.x0, palm.y1 - palm.y0,
                Math.min(10, (palm.y1 - palm.y0) / 2));
  ctx.fillStyle = skin.skin;
  ctx.fill();
  ctx.strokeStyle = skin.edge;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  if (!thumbUnder) drawThumb();

  // Fingers 2..5. Each leaves the palm above its own key rather than from the
  // middle of it — knuckles are spread across the back of a hand, and fanning
  // four fingers out of one point makes it something other than a hand.
  const palmMid = (palm.x0 + palm.x1) / 2;
  for (let f = 2; f <= 5; f++) {
    if (fingerOver && f === crossing.finger) continue;   // drawn last, on top
    const tip = fingerTip(xs[f - 1], geo);
    drawFinger(ctx, xs[f - 1] * 0.78 + palmMid * 0.22, palm.y1 - 2,
               xs[f - 1], tip.y - 3, geo.whiteWidth * 0.34, skin.edge, false);
  }

  // ...and the one crossing over, drawn above the palm so it reads as over
  if (fingerOver) {
    const f = crossing.finger;
    const tip = fingerTip(xs[f - 1], geo);
    drawFinger(ctx, palm.thumbSide, palm.y0 + 2, xs[f - 1], tip.y - 3,
               geo.whiteWidth * 0.34, skin.live, false);
  }

  // Before the fingertips, so the tip that lands stays on top of the path that
  // brought it there rather than being buried under the label
  if (crossing) drawCrossing(ctx, crossing, xs, geo, skin.live, phase);

  // Fingertips: solid on the keys actually being played, hollow on the rest
  for (let f = 1; f <= 5; f++) {
    const live = plan.live.has(f);
    const tip = fingerTip(xs[f - 1], geo);
    drawTip(ctx, xs[f - 1], tip.y, live ? geo.whiteWidth * 0.30 : geo.whiteWidth * 0.20,
            skin.live, live, skin.edge);
    if (live) {
      ctx.fillStyle = '#0b1020';
      ctx.font = `700 ${Math.max(8, Math.round(geo.whiteWidth * 0.5))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(f), xs[f - 1], tip.y + 0.5);
    }
  }

  ctx.restore();
}

export function drawHands(ctx, plans, geo, nowMs) {
  const phase = (nowMs % 900) / 900;
  for (const plan of plans) {
    if (plan && plan.anchors.size) drawHand(ctx, plan, geo, phase);
  }
}
