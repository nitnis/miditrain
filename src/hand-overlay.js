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

// A hand is a hand in both cases; which one it is shows in the outline and in
// the colour of the finger that has landed, so the two are told apart the same
// way the falling notes tell them apart.
const SKIN = '#e6c9b4';
const SKIN_FINGER = '#d9b59c';
const COLORS = {
  right: { fill: SKIN, finger: SKIN_FINGER, edge: '#4f8fe0', live: '#3d8bfd' },
  left:  { fill: SKIN, finger: SKIN_FINGER, edge: '#e0679f', live: '#f472b6' },
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
//
// The hands come from where the player's hands come from: below the keyboard,
// wrists nearest, fingers reaching away onto the keys. Drawn the other way up —
// palm at the back of the keys, fingers reaching towards you — the picture is
// of somebody else's hands seen across the piano, which is not the view anyone
// learns from.
//
// The hand is opaque. A thumb passing under it disappears, which is what a
// thumb passing under a hand does; the dashed path it takes is drawn first so
// the palm covers the middle of it, and what matters is where the thumb comes
// out, which is on a key and in plain sight.

// Where a fingertip rests. Black keys are at the far side of the keyboard, so
// reaching one means reaching further away — a smaller y — than a white key,
// whose free front half is nearest the player.
function tipY(x, geo) {
  const key = geo.keyAt(x);
  return key && !key.isWhite ? geo.keyboardH * 0.44 : geo.keyboardH * 0.80;
}

function handShape(xs, hand, geo) {
  const knuckles = xs.slice(1);
  const left = Math.min(...knuckles);
  const right = Math.max(...knuckles);
  const pad = geo.whiteWidth * 0.42;
  const stage = geo.height - geo.keyboardH;
  return {
    x0: left - pad,
    x1: right + pad,
    // Back of the hand nearest the keys, wrist end nearest the player
    knuckleY: geo.keyboardH + stage * 0.20,
    wristY: geo.keyboardH + stage * 0.62,
    cuffY: geo.height,
    thumbSide: hand === 'left' ? right + pad : left - pad,
  };
}

// Outlined, then filled. A bare stroke of skin colour against a dark stage
// reads as a smear; the same stroke with an edge around it reads as a finger,
// and four of them beside each other read as a hand rather than a paw.
function drawFinger(ctx, fromX, fromY, toX, toY, width, color, edge) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  // A finger bends at the knuckle and straightens towards the tip
  ctx.quadraticCurveTo(fromX + (toX - fromX) * 0.55, fromY - (fromY - toY) * 0.45, toX, toY);
  ctx.strokeStyle = edge;
  ctx.lineWidth = width + 2.6;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

// The key a finger has landed on, marked on the key itself. The whole point of
// the picture is seeing the right finger on the right key, and a fingertip
// floating over a key is not the same as one resting on it.
function drawKeyLanding(ctx, x, geo, color) {
  const key = geo.keyAt(x);
  if (!key) return;
  const w = key.w * 0.74;
  const top = key.isWhite ? geo.keyboardH * 0.60 : geo.keyboardH * 0.30;
  const bottom = key.isWhite ? geo.keyboardH - 3 : geo.keyboardH * 0.62 - 3;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(key.x + (key.w - w) / 2, top, w, bottom - top, 4);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

function drawTip(ctx, x, y, r, live, skin) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = live ? skin.live : skin.fill;
  ctx.fill();
  ctx.lineWidth = live ? 2 : 1.2;
  ctx.strokeStyle = live ? skin.live : skin.edge;
  ctx.stroke();
}

// The crossing. Going up, the thumb travels under the hand and comes out the
// far side; coming down, a finger lifts over the top of it. There is room below
// the keys for a real curve now, so both get one — the thumb's dipping towards
// the player and passing behind the palm, the finger's rising over the back of
// the hand and drawn on top of it.
function drawCrossing(ctx, crossing, xs, geo, skin, phase) {
  // Where the hand came from, not where the fit has since put that finger: the
  // hand has already moved on by the time the crossing finger lands.
  const fromX = crossing.fromX;
  const toX = xs[crossing.finger - 1];
  if (fromX == null || toX == null) return;

  const under = crossing.kind === 'thumbUnder';
  const shape = handShape(xs, crossing.hand, geo);
  const midX = (fromX + toX) / 2;
  const startY = tipY(fromX, geo);
  const endY = tipY(toX, geo);
  const arcY = under ? shape.wristY + 6 : geo.keyboardH * 0.06;

  ctx.save();
  ctx.strokeStyle = skin.live;
  ctx.shadowColor = skin.live;
  ctx.shadowBlur = 7;
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.setLineDash([6, 5]);
  ctx.lineDashOffset = -phase * 11;
  ctx.beginPath();
  ctx.moveTo(fromX, startY);
  ctx.quadraticCurveTo(midX, arcY, toX, endY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawCrossingLabel(ctx, crossing, xs, geo, skin) {
  const fromX = crossing.fromX;
  const toX = xs[crossing.finger - 1];
  if (fromX == null || toX == null) return;
  const under = crossing.kind === 'thumbUnder';
  const size = Math.max(9, Math.min(13, geo.whiteWidth * 0.46));
  ctx.save();
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // Set back at the note being left rather than the one landed on, so it never
  // sits on the fingertip that has just arrived; and below the keys, where the
  // stage is empty and dark, rather than lost among the black keys
  const x = fromX - Math.sign(toX - fromX) * geo.whiteWidth * 1.1;
  const y = geo.keyboardH + 6;
  ctx.lineWidth = 3.5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(6,10,24,0.9)';
  const label = under ? 'thumb under' : 'over the thumb';
  ctx.strokeText(label, x, y);
  ctx.fillStyle = skin.live;
  ctx.fillText(label, x, y);
  ctx.restore();
}

// One hand. `plan` is { hand, anchors: Map<finger,pitch>, live: Set<finger>,
// crossing: { kind, finger, fromFinger, fromPitch } | null }
function drawHand(ctx, plan, geo, phase) {
  const fit = fitHand(plan.anchors, plan.hand, geo.whiteWidth, geo.centreOf);
  if (!fit) return;

  const targets = [];
  for (let f = 1; f <= 5; f++) {
    const anchored = plan.anchors.get(f);
    const x = anchored != null ? geo.centreOf(anchored) : fit.base + fit.step * (f - 1);
    targets.push(Math.max(-40, Math.min(geo.width + 40, x)));
  }
  const xs = easeTowards(plan.hand, targets);

  const skin = COLORS[plan.hand] || COLORS.right;
  const shape = handShape(xs, plan.hand, geo);
  const crossing = plan.crossing
    ? { ...plan.crossing, hand: plan.hand, fromX: geo.centreOf(plan.crossing.fromPitch) }
    : null;
  const fingerOver = crossing && crossing.kind === 'fingerOver';

  // The key each landed finger is resting on, marked first so the hand sits on
  // top of its own marks rather than the other way round
  for (let f = 1; f <= 5; f++) {
    if (plan.live.has(f)) drawKeyLanding(ctx, xs[f - 1], geo, skin.live);
  }

  // The travelling path goes down before the hand does, so the palm covers the
  // middle of it and the thumb really does disappear under the hand
  if (crossing) drawCrossing(ctx, crossing, xs, geo, skin, phase);

  ctx.save();

  // Wrist and forearm, running off the bottom of the picture
  const wristHalf = (shape.x1 - shape.x0) * 0.30;
  const wristMid = (shape.x0 + shape.x1) / 2;
  ctx.beginPath();
  ctx.moveTo(wristMid - wristHalf, shape.wristY);
  ctx.lineTo(wristMid + wristHalf, shape.wristY);
  ctx.lineTo(wristMid + wristHalf * 1.12, shape.cuffY);
  ctx.lineTo(wristMid - wristHalf * 1.12, shape.cuffY);
  ctx.closePath();
  ctx.fillStyle = skin.fill;
  ctx.fill();
  ctx.strokeStyle = skin.edge;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Fingers, from the back of the hand up onto their keys. Drawn before the
  // palm so their roots vanish into it.
  const palmMid = (shape.x0 + shape.x1) / 2;
  for (let f = 2; f <= 5; f++) {
    if (fingerOver && f === crossing.finger) continue;   // over the top, so last
    drawFinger(ctx, xs[f - 1] * 0.72 + palmMid * 0.28, shape.knuckleY + 4,
               xs[f - 1], tipY(xs[f - 1], geo), geo.whiteWidth * 0.36, skin.finger, skin.edge);
  }
  // The thumb comes off the side of the hand, thicker than a finger and rooted
  // further down it, which is most of what says which hand this is
  drawFinger(ctx, shape.thumbSide, shape.knuckleY + (shape.wristY - shape.knuckleY) * 0.62,
             xs[0], tipY(xs[0], geo), geo.whiteWidth * 0.62, skin.finger, skin.edge);

  // The back of the hand, over the roots of everything attached to it
  ctx.beginPath();
  ctx.roundRect(shape.x0, shape.knuckleY, shape.x1 - shape.x0, shape.wristY - shape.knuckleY,
                [geo.whiteWidth * 0.55, geo.whiteWidth * 0.55, geo.whiteWidth * 0.3, geo.whiteWidth * 0.3]);
  ctx.fillStyle = skin.fill;
  ctx.fill();
  ctx.strokeStyle = skin.edge;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // ...and the finger that crosses over it, which has to lie on top to read as
  // going over rather than through
  if (fingerOver) {
    drawFinger(ctx, shape.thumbSide, shape.knuckleY + 4,
               xs[crossing.finger - 1], tipY(xs[crossing.finger - 1], geo),
               geo.whiteWidth * 0.36, skin.finger, skin.live);
  }

  // Fingertips: solid where the finger has landed, faint where it is only
  // resting somewhere plausible
  for (let f = 1; f <= 5; f++) {
    const live = plan.live.has(f);
    const y = tipY(xs[f - 1], geo);
    drawTip(ctx, xs[f - 1], y, geo.whiteWidth * (live ? 0.32 : 0.24), live, skin);
    if (live) {
      ctx.fillStyle = '#0b1020';
      ctx.font = `700 ${Math.max(9, Math.round(geo.whiteWidth * 0.46))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(f), xs[f - 1], y + 0.5);
    }
  }
  ctx.restore();

  if (crossing) drawCrossingLabel(ctx, crossing, xs, geo, skin);
}

export function drawHands(ctx, plans, geo, nowMs) {
  const phase = (nowMs % 900) / 900;
  for (const plan of plans) {
    if (plan && plan.anchors.size) drawHand(ctx, plan, geo, phase);
  }
}
