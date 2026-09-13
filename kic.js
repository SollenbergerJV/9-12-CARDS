/* ============================================================
   KINGS IN THE CORNER — rules engine, no DOM.
   Slots 0-3 are the cross (N, E, S, W); 4-7 are the corners
   (NE, SE, SW, NW). A pile is stored bottom-first, so the last
   card is the exposed one you build on.
   ============================================================ */
/* Under Node this file is a module and has to ask for the engine. In a browser
   engine.js has already run as a plain script and its names are simply there.
   The work happens inside a function on purpose: a `var` at this level would be
   hoisted even though the branch is never taken, and would collide with the
   engine's own `const` of the same name — which breaks the page silently. */
if (typeof require !== 'undefined' && typeof SUIT === 'undefined') {
  (function () {
    const E_ = require('./engine.js');
    const wanted = ['SUIT', 'RL', 'SUITS', 'makeDeck', 'shuffle', 'val',
      'handValue', 'cardShort', 'cardName'];
    for (const k of wanted) globalThis[k] = E_[k];
  })();
}

const KIC_SLOTS = 8;
const KIC_NAMES = ['North', 'East', 'South', 'West', 'North-east', 'South-east', 'South-west', 'North-west'];
function kicIsCorner(i) { return i >= 4; }
function kicOpposite(a, b) { return SUIT[a.s].c !== SUIT[b.s].c; }
/* the only building rule there is: one lower, and the other colour */
function kicStacks(card, top) { return !!top && card.r === top.r - 1 && kicOpposite(card, top); }

function KicGame(opts) {
  opts = opts || {};
  this.names = opts.names || ['You', 'Opponent'];
  this.target = opts.target === undefined ? 100 : opts.target;  // 0 = a single round
  this.dealer = opts.dealer || 0;
  this.scores = [0, 0];
  this.history = [];
  this.roundNo = 0;
  this.matchOver = false;
  this.matchWinner = null;
  this.lowWins = true;          // penalty points: the lower total takes the match
  this.startRound();
}

KicGame.prototype.startRound = function () {
  const deck = shuffle(makeDeck());
  this.hands = [[], []];
  const nd = 1 - this.dealer;
  for (let i = 0; i < 7; i++) { this.hands[nd].push(deck.pop()); this.hands[this.dealer].push(deck.pop()); }
  this.piles = [];
  for (let i = 0; i < KIC_SLOTS; i++) this.piles.push([]);
  for (let i = 0; i < 4; i++) this.piles[i].push(deck.pop());   // the cross
  this.stock = deck;
  this.turn = nd;
  this.phase = 'play';
  this.result = null;
  this.roundNo++;
  this.beginTurn();
  return this;
};

/* Every turn opens with a compulsory draw, so the game just does it. */
KicGame.prototype.beginTurn = function () {
  this.playsThisTurn = 0;
  this.turnLog = [];          // everything played this turn, newest last
  this.drawn = null;
  if (this.stock.length) {
    const c = this.stock.pop();
    this.hands[this.turn].push(c);
    this.drawn = c;
  }
};

KicGame.prototype.topOf = function (i) { const p = this.piles[i]; return p.length ? p[p.length - 1] : null; };
KicGame.prototype.bottomOf = function (i) { const p = this.piles[i]; return p.length ? p[0] : null; };

/* Does this card fit this slot? Board geometry only — no turn, no phase. Asked
   both by the legality checks below and by hasAnyPlay, which has to be able to
   reason about the player whose turn it is not. */
KicGame.prototype._cardFits = function (card, slot) {
  if (slot < 0 || slot >= KIC_SLOTS) return false;
  if (!this.piles[slot].length) {
    // a corner only ever opens for a King; a vacated cross space takes anything
    return kicIsCorner(slot) ? card.r === 13 : true;
  }
  return kicStacks(card, this.topOf(slot));
};

KicGame.prototype._pileFits = function (from, to) {
  if (from === to || from < 0 || to < 0 || from >= KIC_SLOTS || to >= KIC_SLOTS) return false;
  if (!this.piles[from].length) return false;
  if (!this.piles[to].length) {
    /* A King turned up on the cross belongs in a corner, and takes whatever has
       been built on it along. That is the only move onto an empty space worth
       making — anything else is just shuffling, and corner-to-corner would let
       a King wander for ever. A King can never be anywhere but the bottom of
       its pile, since nothing outranks it. */
    return kicIsCorner(to) && !kicIsCorner(from) && this.piles[from][0].r === 13;
  }
  return kicStacks(this.piles[from][0], this.topOf(to));
};

KicGame.prototype.canPlayCard = function (p, cardId, slot) {
  if (this.phase !== 'play' || this.turn !== p) return false;
  const card = this.hands[p].find(function (c) { return c.id === cardId; });
  if (!card) return false;
  return this._cardFits(card, slot);
};

KicGame.prototype.playCard = function (p, cardId, slot) {
  if (!this.canPlayCard(p, cardId, slot)) throw new Error('illegal card play');
  const i = this.hands[p].findIndex(function (c) { return c.id === cardId; });
  const card = this.hands[p].splice(i, 1)[0];
  this.piles[slot].push(card);
  this.playsThisTurn++;
  this.turnLog.push({ type: 'card', cardId: card.id, slot: slot });
  if (this.hands[p].length === 0) this.finishRound(p);
  return card;
};

KicGame.prototype.canMovePile = function (p, from, to) {
  if (this.phase !== 'play' || this.turn !== p) return false;
  return this._pileFits(from, to);
};

KicGame.prototype.movePile = function (p, from, to) {
  if (!this.canMovePile(p, from, to)) throw new Error('illegal pile move');
  const moved = this.piles[from].length;
  this.piles[to] = this.piles[to].concat(this.piles[from]);
  this.piles[from] = [];
  this.playsThisTurn++;
  this.turnLog.push({ type: 'move', from: from, to: to, count: moved });
};

/* ---------- taking a play back ----------
   Nothing is committed until the turn is ended, so every play this turn can be
   unwound, newest first. The compulsory draw is not a play and stays put. */
KicGame.prototype.canUndo = function (p) {
  return this.phase === 'play' && this.turn === p && this.turnLog.length > 0;
};
KicGame.prototype.describeLastPlay = function () {
  if (!this.turnLog.length) return null;
  const a = this.turnLog[this.turnLog.length - 1];
  if (a.type === 'card') {
    const pile = this.piles[a.slot];
    return { type: 'card', card: pile[pile.length - 1], slot: a.slot };
  }
  return { type: 'move', from: a.from, to: a.to, count: a.count };
};
KicGame.prototype.undo = function (p) {
  if (!this.canUndo(p)) throw new Error('nothing to take back');
  const a = this.turnLog.pop();
  if (a.type === 'card') {
    const card = this.piles[a.slot].pop();
    this.hands[p].push(card);
  } else {
    const back = this.piles[a.to].splice(this.piles[a.to].length - a.count, a.count);
    this.piles[a.from] = back;
  }
  this.playsThisTurn--;
  return a;
};

KicGame.prototype.legalSlotsFor = function (p, cardId) {
  const out = [];
  for (let s = 0; s < KIC_SLOTS; s++) if (this.canPlayCard(p, cardId, s)) out.push(s);
  return out;
};
KicGame.prototype.legalMovesFrom = function (p, from) {
  const out = [];
  for (let t = 0; t < KIC_SLOTS; t++) if (this.canMovePile(p, from, t)) out.push(t);
  return out;
};
/* True when p could do something with the board as it stands. Deliberately
   turn-agnostic: a blocked round means neither player can move, so this has to
   answer for the player who is waiting as well as the one to act. */
KicGame.prototype.hasAnyPlay = function (p) {
  for (const c of this.hands[p]) {
    for (let s = 0; s < KIC_SLOTS; s++) if (this._cardFits(c, s)) return true;
  }
  for (let a = 0; a < KIC_SLOTS; a++) {
    for (let b = 0; b < KIC_SLOTS; b++) if (this._pileFits(a, b)) return true;
  }
  return false;
};

KicGame.prototype.endTurn = function (p) {
  if (this.phase !== 'play' || this.turn !== p) throw new Error('not your turn');
  this.turn = 1 - p;
  this.beginTurn();
  /* A round is blocked only when the deck is gone and the board genuinely
     admits no play for either player. Choosing not to play is not a block. */
  if (this.stock.length === 0 && !this.hasAnyPlay(0) && !this.hasAnyPlay(1)) {
    this.finishStalemate();
    return { ended: true, stalemate: true };
  }
  return { ended: false };
};

/* Going out costs you nothing; the other player eats what is left in hand. */
KicGame.prototype.finishRound = function (winner) {
  const loser = 1 - winner;
  const pts = handValue(this.hands[loser]);
  this.scores[loser] += pts;
  this.result = {
    stalemate: false, winner: winner, loser: loser, points: pts,
    penalties: winner === 0 ? [0, pts] : [pts, 0],
    hands: [this.hands[0].slice(), this.hands[1].slice()],
    scores: this.scores.slice()
  };
  this.phase = 'ended';
  this.history.push(this.result);
  this.checkMatch();
};

KicGame.prototype.finishStalemate = function () {
  const a = handValue(this.hands[0]), b = handValue(this.hands[1]);
  this.scores[0] += a; this.scores[1] += b;
  this.result = {
    stalemate: true, winner: null, points: 0, penalties: [a, b],
    hands: [this.hands[0].slice(), this.hands[1].slice()],
    scores: this.scores.slice()
  };
  this.phase = 'ended';
  this.history.push(this.result);
  this.checkMatch();
};

KicGame.prototype.checkMatch = function () {
  this.tiebreak = false;
  const done = this.target === 0 || this.scores[0] >= this.target || this.scores[1] >= this.target;
  if (!done) return;
  /* Level on penalties is not a result — a blocked round charges both players
     and can land them on the same total. Play a decider rather than end with
     no winner. */
  if (this.scores[0] === this.scores[1]) { this.tiebreak = true; return; }
  this.matchOver = true;
  this.matchWinner = this.scores[0] < this.scores[1] ? 0 : 1;
};

KicGame.prototype.nextRound = function () {
  if (this.matchOver) return false;
  this.dealer = 1 - this.dealer;
  this.startRound();
  return true;
};

/* ============================================================
   COMPUTER PLAYER
   ============================================================ */
const KIC_LEVELS = {
  easy:   { piles: false, random: 0.65, stop: 0.22, freeing: false },
  normal: { piles: true,  random: 0.35, stop: 0.00, freeing: false },
  sharp:  { piles: true,  random: 0.00, stop: 0.00, freeing: true }
};

function KicAI(level) {
  this.level = KIC_LEVELS[level] ? level : 'normal';
  this.cfg = KIC_LEVELS[this.level];
}

/* One action at a time, so the table can show each move on its own beat. */
KicAI.prototype.nextAction = function (g, p) {
  const cfg = this.cfg;
  const plays = [];
  for (const c of g.hands[p]) {
    for (let s = 0; s < KIC_SLOTS; s++) {
      if (g.canPlayCard(p, c.id, s)) plays.push({ type: 'card', cardId: c.id, slot: s, v: val(c), rank: c.r });
    }
  }
  const moves = [];
  if (cfg.piles) {
    for (let a = 0; a < KIC_SLOTS; a++) {
      for (let b = 0; b < KIC_SLOTS; b++) if (g.canMovePile(p, a, b)) moves.push({ type: 'move', from: a, to: b });
    }
  }
  if (!plays.length && !moves.length) return null;
  if (cfg.stop && Math.random() < cfg.stop) return null;

  // clearing a cross space first opens somewhere to dump a big card — the
  // combination that separates a good player from an adequate one
  if (moves.length) {
    if (cfg.freeing) {
      const freeing = moves.filter(function (m) { return m.from < 4; });
      if (freeing.length && g.hands[p].length) return freeing[0];
    }
    if (!plays.length) return moves[0];
  }
  if (!plays.length) return null;
  if (cfg.random && Math.random() < cfg.random) return plays[Math.floor(Math.random() * plays.length)];

  // shed the most expensive card available; a King heading for a corner is best of all
  plays.sort(function (x, y) {
    const kx = (x.rank === 13 && x.slot >= 4) ? 1 : 0, ky = (y.rank === 13 && y.slot >= 4) ? 1 : 0;
    return (ky - kx) || (y.v - x.v) || (x.slot - y.slot);
  });
  return plays[0];
};

if (typeof module !== 'undefined') {
  module.exports = { KicGame, KicAI, KIC_LEVELS, KIC_SLOTS, KIC_NAMES, kicStacks, kicIsCorner, kicOpposite };
}
