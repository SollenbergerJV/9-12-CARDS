'use strict';
/* ============================================================
   Rooms, seats and the authoritative match.

   The server owns the deck. Clients never hold the other player's
   cards — not hidden in the page, not in memory — because a view is
   built per seat with the opponent's hand replaced by blanks. That
   removes cheating as a category rather than as a policy, and it
   means the two clients can never disagree about the state.
   ============================================================ */
/* shared/ when the folders survived the upload, right here when they did not */
function rules(name) {
  try { return require('../shared/' + name); }
  catch (e) { return require('./' + name); }
}
const { GinGame } = rules('engine.js');
const { KicGame } = rules('kic.js');

/* No 0/O/1/I/5/S — codes get read aloud down a phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ2346789';
const CODE_LEN = 5;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;   // an abandoned room evaporates
const GRACE_MS = 2 * 60 * 1000;            // how long a dropped player keeps their seat

function randInt(n) {
  const b = require('crypto').randomBytes(4).readUInt32BE(0);
  return b % n;
}
function token() { return require('crypto').randomBytes(16).toString('hex'); }

function Rooms() {
  this.byCode = new Map();
  this.bySeat = new Map();
}

Rooms.prototype.newCode = function () {
  for (let attempt = 0; attempt < 500; attempt++) {
    let c = '';
    for (let i = 0; i < CODE_LEN; i++) c += ALPHABET[randInt(ALPHABET.length)];
    if (!this.byCode.has(c)) return c;
  }
  throw new Error('could not mint a room code');
};

Rooms.prototype.create = function (opts) {
  const code = this.newCode();
  const room = {
    code: code,
    game: opts.game === 'kic' ? 'kic' : 'gin',
    target: Number.isFinite(opts.target) ? opts.target : 100,
    seats: [null, null],
    G: null,
    started: false,
    touched: Date.now(),
    chat: []
  };
  this.byCode.set(code, room);
  return room;
};

Rooms.prototype.sit = function (room, name, seatIdx) {
  const t = token();
  room.seats[seatIdx] = {
    token: t, name: name, conn: null, connected: false,
    droppedAt: 0, idx: seatIdx, room: room
  };
  this.bySeat.set(t, room.seats[seatIdx]);
  room.touched = Date.now();
  return room.seats[seatIdx];
};

Rooms.prototype.get = function (code) {
  return this.byCode.get(String(code || '').toUpperCase().trim()) || null;
};
Rooms.prototype.seat = function (t) { return this.bySeat.get(t) || null; };

Rooms.prototype.destroy = function (room) {
  for (const s of room.seats) if (s) this.bySeat.delete(s.token);
  this.byCode.delete(room.code);
};

/* Rooms nobody has touched in hours, and rooms where both players walked
   away past the grace period, are cleared out. */
Rooms.prototype.sweep = function () {
  const now = Date.now();
  for (const room of Array.from(this.byCode.values())) {
    if (now - room.touched > ROOM_IDLE_MS) { this.destroy(room); continue; }
    const live = room.seats.filter(function (s) { return s && (s.connected || now - s.droppedAt < GRACE_MS); });
    if (room.started && live.length === 0) this.destroy(room);
  }
};

/* ---------- starting the match ---------- */
function startMatch(room) {
  const names = [
    room.seats[0] ? room.seats[0].name : 'Player 1',
    room.seats[1] ? room.seats[1].name : 'Player 2'
  ];
  const opts = { names: names, target: room.target, dealer: 0 };
  room.G = room.game === 'kic' ? new KicGame(opts) : new GinGame(opts);
  room.started = true;
  room.touched = Date.now();
}

/* ---------- the per-seat view ----------
   Same field names the local game uses, so the table code renders a served
   state and a local one with no branching. The opponent's cards become
   blanks that still count, which is all the table ever asks of them. */
function blanks(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ hidden: true, id: 'x' + i, r: 0, s: 'S' });
  return out;
}

function viewFor(room, p) {
  const G = room.G;
  if (!G) return null;
  const them = 1 - p;
  const revealed = !!(G.result);          // at the end of a hand both hands are shown

  const hands = [];
  hands[p] = G.hands[p].map(function (c) { return { r: c.r, s: c.s, id: c.id }; });
  hands[them] = revealed
    ? G.hands[them].map(function (c) { return { r: c.r, s: c.s, id: c.id }; })
    : blanks(G.hands[them].length);

  const base = {
    kind: room.game,
    you: p,
    names: G.names.slice(),
    scores: G.scores.slice(),
    target: G.target,
    dealer: G.dealer,
    turn: G.turn,
    phase: G.phase,
    hands: hands,
    handCounts: [G.hands[0].length, G.hands[1].length],
    stockCount: G.stock.length,
    matchOver: G.matchOver,
    matchWinner: G.matchWinner,
    tiebreak: !!G.tiebreak,
    result: G.result || null,
    history: G.history.slice(-12)
  };

  if (room.game === 'gin') {
    base.handNo = G.handNo;
    base.discard = G.discard.slice();
    base.mustStock = G.mustStock;
    base.takenFromDiscardId = G.turn === p ? G.takenFromDiscardId : null;
    base.drewFrom = G.drewFrom;                       // public: which pile they took from
    base.lastDrawn = G.turn === p ? G.lastDrawn : null;
  } else {
    base.roundNo = G.roundNo;
    base.piles = G.piles.map(function (pile) { return pile.slice(); });
    base.playsThisTurn = G.turn === p ? G.playsThisTurn : 0;
    base.turnLog = G.turn === p ? G.turnLog.slice() : [];
    base.drawn = G.turn === p ? G.drawn : null;
    base.drewACard = !!G.drawn;                       // public: they did take from stock
  }
  return base;
}

/* ---------- applying an action ----------
   Every one of these is a rules call that throws when it is not allowed, so
   an edited client gets an error back and the table is left untouched. */
function applyGin(G, p, a) {
  switch (a.do) {
    case 'draw':       G.draw(p, a.source === 'discard' ? 'discard' : 'stock'); return;
    case 'discard':    G.discardCard(p, a.cardId, !!a.knock); return;
    default: throw new Error('unknown action');
  }
}
function applyKic(G, p, a) {
  switch (a.do) {
    case 'play':  G.playCard(p, a.cardId, a.slot | 0); return;
    case 'move':  G.movePile(p, a.from | 0, a.to | 0); return;
    case 'undo':  G.undo(p); return;
    case 'end':   G.endTurn(p); return;
    default: throw new Error('unknown action');
  }
}

function applyAction(room, p, a) {
  const G = room.G;
  if (!G) throw new Error('the match has not started');
  if (G.matchOver) throw new Error('the match is over');
  if (a.do === 'next') {
    // either player may deal the next hand; whoever asks second is a no-op
    if (!G.result) return;
    if (room.game === 'kic') G.nextRound(); else G.nextHand();
    return;
  }
  if (G.result) throw new Error('the hand is over');
  if (G.turn !== p) throw new Error('not your turn');
  if (room.game === 'kic') applyKic(G, p, a); else applyGin(G, p, a);
}

module.exports = {
  Rooms: Rooms, startMatch: startMatch, viewFor: viewFor, applyAction: applyAction,
  GRACE_MS: GRACE_MS, ALPHABET: ALPHABET, CODE_LEN: CODE_LEN
};
