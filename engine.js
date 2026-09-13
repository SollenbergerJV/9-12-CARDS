/* ============================================================
   GIN RUMMY ENGINE  —  pure logic, no DOM.
   Shared by the artifact and by the node test harness.
   ============================================================ */

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT = {
  S: { g: '♠', c: 'b', n: 'Spades' },
  H: { g: '♥', c: 'r', n: 'Hearts' },
  D: { g: '♦', c: 'r', n: 'Diamonds' },
  C: { g: '♣', c: 'b', n: 'Clubs' }
};
const RL = [null, 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 1; r <= 13; r++) d.push({ r: r, s: s, id: r + s });
  return d;
}
function val(c) { return c.r > 10 ? 10 : c.r; }
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function cardName(c) { return RL[c.r] + ' of ' + SUIT[c.s].n; }
function cardShort(c) { return RL[c.r] + SUIT[c.s].g; }
function handValue(cards) { return cards.reduce(function (a, c) { return a + val(c); }, 0); }

/* ---------- meld enumeration ---------- */
function combos(arr, k) {
  const out = [];
  (function rec(st, cur) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = st; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
  })(0, []);
  return out;
}

function enumerateMelds(cards) {
  const melds = [];
  const idx = new Map();
  cards.forEach(function (c, i) { idx.set(c.id, i); });
  const seenRun = new Set();
  function mk(type, cs, hiAce) {
    let mask = 0, v = 0;
    for (const c of cs) { mask |= (1 << idx.get(c.id)); v += val(c); }
    if (type === 'run') {
      if (seenRun.has(mask)) return;     // the same window found in both ace readings
      seenRun.add(mask);
    }
    melds.push({ type: type, cards: cs.slice(), mask: mask, value: v, hiAce: !!hiAce });
  }
  for (let r = 1; r <= 13; r++) {
    const g = cards.filter(function (c) { return c.r === r; });
    if (g.length >= 3) {
      combos(g, 3).forEach(function (cs) { mk('set', cs); });
      if (g.length === 4) mk('set', g);
    }
  }
  /* The ace plays at either end of a run — A-2-3 and Q-K-A both count — but a
     run never wraps through it, so K-A-2 is nothing. Reading the suit twice,
     once with the ace low and once with it high, gives exactly that. */
  for (const s of SUITS) {
    const suited = cards.filter(function (c) { return c.s === s; });
    if (suited.length < 3) continue;
    [false, true].forEach(function (hiAce) {
      const g = suited.slice().sort(function (a, b) { return runValue({ hiAce: hiAce }, a) - runValue({ hiAce: hiAce }, b); });
      const v = g.map(function (c) { return runValue({ hiAce: hiAce }, c); });
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 2; j < g.length; j++) {
          let ok = true;
          for (let k = i; k < j; k++) if (v[k + 1] !== v[k] + 1) { ok = false; break; }
          if (ok) mk('run', g.slice(i, j + 1), hiAce); else break;
        }
      }
    });
  }
  return melds;
}

/* An ace counts 14 in a run that is built up to it, 1 otherwise. */
function runValue(m, c) { return (m.hiAce && c.r === 1) ? 14 : c.r; }
function sortedRun(m) {
  return m.cards.slice().sort(function (a, b) { return runValue(m, a) - runValue(m, b); });
}
function runBounds(m) {
  let lo = 99, hi = -1;
  for (const c of m.cards) { const v = runValue(m, c); if (v < lo) lo = v; if (v > hi) hi = v; }
  return { lo: lo, hi: hi };
}

/* Best (lowest-deadwood) way to lay the hand down. */
function bestArrangement(cards) {
  const melds = enumerateMelds(cards);
  const memo = new Map();
  function rec(i, mask) {
    if (i >= melds.length) return { score: 0, combo: [] };
    const key = i + ':' + mask;
    const hit = memo.get(key);
    if (hit) return hit;
    let res = rec(i + 1, mask);
    const m = melds[i];
    if ((m.mask & mask) === 0) {
      const sub = rec(i + 1, mask | m.mask);
      if (sub.score + m.value > res.score) res = { score: sub.score + m.value, combo: [m].concat(sub.combo) };
    }
    memo.set(key, res);
    return res;
  }
  const r = rec(0, 0);
  let used = 0;
  for (const m of r.combo) used |= m.mask;
  const dead = [];
  cards.forEach(function (c, i) { if (!(used & (1 << i))) dead.push(c); });
  dead.sort(function (a, b) { return val(b) - val(a) || a.r - b.r; });
  return {
    melds: r.combo.map(function (m) { return { type: m.type, cards: m.cards.slice(), hiAce: !!m.hiAce }; }),
    deadwood: dead,
    dv: handValue(dead)
  };
}

/* ---------- lay-offs ---------- */
function canExtend(m, c) {
  if (m.type === 'set') return m.cards.length < 4 && c.r === m.cards[0].r;
  if (c.s !== m.cards[0].s) return false;
  const b = runBounds(m);
  // an ace offered to a run can be worth 1 at the bottom or 14 at the top
  const cand = c.r === 1 ? [1, 14] : [c.r];
  return cand.some(function (v) { return v === b.lo - 1 || v === b.hi + 1; });
}

/* melds is mutated (cards appended) — pass a copy if you need the originals. */
function doLayoffs(deadwood, melds) {
  const rem = deadwood.slice();
  const laid = [];
  let go = true;
  while (go) {
    go = false;
    rem.sort(function (a, b) { return val(b) - val(a); });
    for (let i = 0; i < rem.length; i++) {
      const c = rem[i];
      let placed = false;
      for (let mi = 0; mi < melds.length; mi++) {
        if (canExtend(melds[mi], c)) {
          const m = melds[mi];
          if (m.type === 'run' && c.r === 1 && runBounds(m).hi === 13) m.hiAce = true;
          m.cards.push(c);
          if (m.type === 'run') m.cards = sortedRun(m);
          laid.push({ card: c, meldIndex: mi });
          rem.splice(i, 1);
          placed = true;
          break;
        }
      }
      if (placed) { go = true; break; }
    }
  }
  return { laid: laid, rem: rem, dv: handValue(rem) };
}

function cloneMelds(ms) {
  return ms.map(function (m) { return { type: m.type, cards: m.cards.slice(), hiAce: !!m.hiAce }; });
}

/* ---------- scoring one hand ---------- */
/* knockerHand / oppHand are the 10-card hands AFTER the knocker's discard. */
function scoreHand(knockerHand, oppHand, isGin) {
  const kArr = bestArrangement(knockerHand);
  const oArr = bestArrangement(oppHand);
  const knockerMelds = cloneMelds(kArr.melds);
  let lay = { laid: [], rem: oArr.deadwood.slice(), dv: oArr.dv };
  if (!isGin) lay = doLayoffs(oArr.deadwood, knockerMelds);
  const K = kArr.dv, D = lay.dv;
  let winner, points, reason;
  if (isGin) { winner = 'knocker'; points = D + 25; reason = 'gin'; }
  else if (D > K) { winner = 'knocker'; points = D - K; reason = 'knock'; }
  else { winner = 'opponent'; points = (K - D) + 25; reason = 'undercut'; }
  return {
    winner: winner, points: points, reason: reason,
    knockerDeadwood: K, oppDeadwood: D, oppDeadwoodBefore: oArr.dv,
    knockerMelds: knockerMelds, knockerBase: kArr.melds,
    knockerDead: kArr.deadwood,
    oppMelds: oArr.melds, oppDead: lay.rem, laidOff: lay.laid
  };
}

/* ---------- hand quality heuristic (for the computer player) ---------- */
function potential(deadwood) {
  let p = 0;
  for (let i = 0; i < deadwood.length; i++) {
    for (let j = i + 1; j < deadwood.length; j++) {
      const a = deadwood[i], b = deadwood[j];
      if (a.r === b.r) p += 3.2;
      else if (a.s === b.s) {
        // measure the gap with the ace read whichever way is closer
        let d = Math.abs(a.r - b.r);
        if (a.r === 1 || b.r === 1) d = Math.min(d, Math.abs((a.r === 1 ? 14 : a.r) - (b.r === 1 ? 14 : b.r)));
        if (d === 1) p += 3.0;
        else if (d === 2) p += 1.4;
      }
    }
  }
  return p;
}

/* lower is better */
function handQuality(cards, potWeight) {
  const arr = bestArrangement(cards);
  return arr.dv - potential(arr.deadwood) * (potWeight === undefined ? 0.6 : potWeight);
}

/* Best discard from an 11-card hand. Returns {card, dv, quality} */
function bestDiscard(cards, opts) {
  opts = opts || {};
  const potWeight = opts.potWeight === undefined ? 0.6 : opts.potWeight;
  const forbidId = opts.forbidId || null;
  const danger = opts.danger || null; // function(card) -> penalty
  let best = null;
  for (let i = 0; i < cards.length; i++) {
    if (forbidId && cards[i].id === forbidId) continue;
    const rest = cards.slice(0, i).concat(cards.slice(i + 1));
    const arr = bestArrangement(rest);
    let q = arr.dv - potential(arr.deadwood) * potWeight;
    if (danger) q += danger(cards[i]);
    if (!best || q < best.quality - 1e-9) best = { card: cards[i], dv: arr.dv, quality: q };
  }
  return best;
}

/* ============================================================
   GAME STATE MACHINE
   Every rule lives here so the UI and the test harness agree.
   ============================================================ */

function GinGame(opts) {
  opts = opts || {};
  this.names = opts.names || ['You', 'Opponent'];
  this.target = opts.target === undefined ? 100 : opts.target; // 0 = single hand
  this.dealer = opts.dealer || 0;
  this.scores = [0, 0];
  this.history = [];
  this.handNo = 0;
  this.matchOver = false;
  this.matchWinner = null;
  this.startHand();
}

GinGame.prototype.nonDealer = function () { return 1 - this.dealer; };
GinGame.prototype.topDiscard = function () {
  return this.discard.length ? this.discard[this.discard.length - 1] : null;
};

/* The lead player is dealt ELEVEN and opens by throwing one away. There is no
   turned-up card and no round of passing on it: the deal itself decides who
   goes first, which is how this table has always played it. */
GinGame.prototype.startHand = function () {
  const deck = shuffle(makeDeck());
  this.hands = [[], []];
  const nd = this.nonDealer();
  for (let i = 0; i < 10; i++) {
    this.hands[nd].push(deck.pop());
    this.hands[this.dealer].push(deck.pop());
  }
  this.hands[nd].push(deck.pop());          // the eleventh card
  this.discard = [];                        // nothing is turned up
  this.stock = deck;
  this.phase = 'discard';                   // the lead throws before anyone draws
  this.turn = nd;
  this.mustStock = false;
  this.takenFromDiscardId = null;
  this.drewFrom = null;
  this.lastDrawn = null;
  this.result = null;
  this.handNo++;
  this.log = [];
  return this;
};

GinGame.prototype.canDraw = function (p, source) {
  if (this.phase !== 'draw' || this.turn !== p) return false;
  if (source === 'discard') return !this.mustStock && this.discard.length > 0;
  return this.stock.length > 0;
};

GinGame.prototype.draw = function (p, source) {
  if (!this.canDraw(p, source)) throw new Error('draw: not allowed (' + source + ')');
  let c;
  if (source === 'discard') { c = this.discard.pop(); this.takenFromDiscardId = c.id; }
  else { c = this.stock.pop(); this.takenFromDiscardId = null; }
  this.hands[p].push(c);
  this.lastDrawn = c;
  this.drewFrom = source;
  this.phase = 'discard';
  return c;
};

/* Deadwood the player would hold if they discarded cardId. */
GinGame.prototype.deadwoodAfter = function (p, cardId) {
  const rest = this.hands[p].filter(function (c) { return c.id !== cardId; });
  return bestArrangement(rest).dv;
};

GinGame.prototype.canDiscard = function (p, cardId) {
  if (this.phase !== 'discard' || this.turn !== p) return false;
  if (this.takenFromDiscardId && cardId === this.takenFromDiscardId) return false;
  return this.hands[p].some(function (c) { return c.id === cardId; });
};

GinGame.prototype.canKnock = function (p, cardId) {
  return this.canDiscard(p, cardId) && this.deadwoodAfter(p, cardId) <= 10;
};

GinGame.prototype.discardCard = function (p, cardId, knock) {
  if (!this.canDiscard(p, cardId)) throw new Error('discard: not allowed');
  if (knock && !this.canKnock(p, cardId)) throw new Error('knock: deadwood too high');
  const i = this.hands[p].findIndex(function (c) { return c.id === cardId; });
  const card = this.hands[p].splice(i, 1)[0];
  this.discard.push(card);
  this.takenFromDiscardId = null;
  this.mustStock = false;

  if (knock) {
    this.resolve(p, bestArrangement(this.hands[p]).dv === 0, card);
    return { ended: true };
  }
  if (this.stock.length <= 2) {
    this.endDead();
    return { ended: true, dead: true };
  }
  this.turn = 1 - p;
  this.phase = 'draw';
  return { ended: false };
};

GinGame.prototype.resolve = function (knocker, isGin, knockCard) {
  const opp = 1 - knocker;
  const s = scoreHand(this.hands[knocker], this.hands[opp], isGin);
  const winner = s.winner === 'knocker' ? knocker : opp;
  this.scores[winner] += s.points;
  this.result = {
    dead: false, knocker: knocker, opponent: opp, winner: winner,
    points: s.points, reason: s.reason, isGin: isGin, knockCard: knockCard,
    knockerDeadwood: s.knockerDeadwood, oppDeadwood: s.oppDeadwood,
    oppDeadwoodBefore: s.oppDeadwoodBefore,
    knockerMelds: s.knockerMelds, knockerBase: s.knockerBase, knockerDead: s.knockerDead,
    oppMelds: s.oppMelds, oppDead: s.oppDead, laidOff: s.laidOff,
    hands: [this.hands[0].slice(), this.hands[1].slice()],
    scores: this.scores.slice()
  };
  this.phase = 'ended';
  this.history.push(this.result);
  this.checkMatch();
};

GinGame.prototype.endDead = function () {
  this.result = {
    dead: true, winner: null, points: 0, reason: 'dead',
    hands: [this.hands[0].slice(), this.hands[1].slice()],
    scores: this.scores.slice()
  };
  this.phase = 'ended';
  this.history.push(this.result);
  this.checkMatch();
};

GinGame.prototype.checkMatch = function () {
  this.tiebreak = false;
  if (this.target === 0) {
    if (!this.result.dead) { this.matchOver = true; this.matchWinner = this.result.winner; }
    return;
  }
  if (this.scores[0] < this.target && this.scores[1] < this.target) return;
  /* Level on points is not a result. Rather than declare a match with no
     winner, keep dealing until one player is genuinely ahead. */
  if (this.scores[0] === this.scores[1]) { this.tiebreak = true; return; }
  this.matchOver = true;
  this.matchWinner = this.scores[0] > this.scores[1] ? 0 : 1;
};

GinGame.prototype.nextHand = function () {
  if (this.matchOver) return false;
  this.dealer = 1 - this.dealer;
  this.startHand();
  return true;
};

/* ============================================================
   COMPUTER PLAYER
   ============================================================ */

const AI_LEVELS = {
  easy:   { potWeight: 0.15, takeGain: 0.0, noise: 0.35, ginHunt: 0, safety: 0.0, patient: false },
  normal: { potWeight: 0.60, takeGain: 1.5, noise: 0.10, ginHunt: 2, safety: 0.6, patient: false },
  sharp:  { potWeight: 0.80, takeGain: 1.0, noise: 0.00, ginHunt: 0, safety: 0.3, patient: true }
};

function AI(level) {
  this.cfg = AI_LEVELS[level] || AI_LEVELS.normal;
  this.level = level || 'normal';
  this.oppWants = {}; // rank/suit signals gathered from what the opponent picks up
}

AI.prototype.noteOpponentTook = function (card) {
  this.oppWants['r' + card.r] = true;
  this.oppWants['s' + card.s + ':' + card.r] = true;
};

AI.prototype.dangerFn = function () {
  const w = this.oppWants, k = this.cfg.safety;
  if (!k) return null;
  return function (c) {
    let d = 0;
    if (w['r' + c.r]) d += 3 * k;
    for (let dr = -2; dr <= 2; dr++) {
      if (dr === 0) continue;
      if (w['s' + c.s + ':' + (c.r + dr)]) d += (Math.abs(dr) === 1 ? 2 : 0.8) * k;
    }
    return d;
  };
};

/* Should the computer take the face-up card? */
AI.prototype.wantsUpcard = function (hand, up) {
  const cur = handQuality(hand, this.cfg.potWeight);
  const withUp = hand.concat([up]);
  const best = bestDiscard(withUp, { potWeight: this.cfg.potWeight, forbidId: up.id });
  if (!best) return false;
  const gain = cur - best.quality;
  return gain >= this.cfg.takeGain - (Math.random() * this.cfg.noise * 4);
};

/* Which card to throw, and whether to knock. */
AI.prototype.chooseDiscard = function (game, p) {
  const hand = game.hands[p];
  const forbid = game.takenFromDiscardId;
  const opts = { potWeight: this.cfg.potWeight, forbidId: forbid, danger: this.dangerFn() };
  let pick = bestDiscard(hand, opts);
  if (!pick) pick = bestDiscard(hand, { potWeight: this.cfg.potWeight, forbidId: forbid });

  if (this.cfg.noise > 0 && Math.random() < this.cfg.noise) {
    const legal = hand.filter(function (c) { return !forbid || c.id !== forbid; });
    const alt = legal[Math.floor(Math.random() * legal.length)];
    if (alt) pick = { card: alt, dv: game.deadwoodAfter(p, alt.id) };
  }

  const dv = game.deadwoodAfter(p, pick.card.id);
  let knock;
  if (this.cfg.patient) {
    /* Knocking with 9 or 10 deadwood late in the hand invites an undercut,
       so the threshold tightens as the stock burns down — then opens again
       at the very end to avoid a dead hand. */
    const st = game.stock.length;
    const limit = st > 20 ? 10 : st > 12 ? 8 : st > 6 ? 6 : 10;
    knock = dv === 0 || dv <= limit;
  } else {
    knock = dv <= 10;
  }
  // optionally hold a very good hand for gin while there is plenty of stock left
  if (knock && dv > 0 && dv <= this.cfg.ginHunt && game.stock.length > 18) knock = false;
  return { cardId: pick.card.id, knock: knock, dv: dv };
};

if (typeof module !== 'undefined') {
  module.exports = {
    SUITS, SUIT, RL, makeDeck, val, shuffle, cardName, cardShort, handValue,
    enumerateMelds, bestArrangement, canExtend, doLayoffs, cloneMelds,
    scoreHand, bestDiscard, handQuality, potential, combos, GinGame, AI, AI_LEVELS,
    runValue, sortedRun, runBounds
  };
}
