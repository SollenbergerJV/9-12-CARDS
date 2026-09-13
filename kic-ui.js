/* ============================================================
   KINGS IN THE CORNER — screen
   The board is a 3x3: the cross on the arms, corners for Kings,
   the deck in the middle.
   ============================================================ */

/* grid order, row by row: NW N NE / W deck E / SW S SE */
const KGRID = [7, 0, 4, 3, -1, 1, 6, 2, 5];

let KG = null;                 // the KicGame
let kBots = [null, null];
let kViewer = 0;
let kSelCard = null;           // id of the card picked up from hand
let kSelPile = null;           // slot index picked up as a pile to move
let kOrder = [[], []];
let kTimer = null;
let kFreshId = null;           // the card drawn at the start of this turn
let kLastNote = '';            // what the opponent last did
let kFlash = null;             // { slot, kind } transient board feedback
let kNodes = [];

function kIsBot(p) { return !ONLINE && !!kBots[p]; }
function kName(p) { return KG ? (KG.names[p] || (p === 0 ? 'You' : 'Opponent')) : ''; }

/* Ace is the low card, so it sorts first — the same way round as Gin does. */
function kSort(p) {
  if (S.sortMode === 'manual') {
    // the order belongs to the player; only a fresh hand gets an opening tidy
    if (kOrder[p] && kOrder[p].length) return;
    const start = KG.hands[p].slice().sort(function (a, b) { return a.r - b.r || SUITS.indexOf(a.s) - SUITS.indexOf(b.s); });
    kOrder[p] = start.map(function (c) { return c.id; });
    return;
  }
  const hand = KG.hands[p].slice();
  if (S.sortMode === 'suit') hand.sort(function (a, b) { return SUITS.indexOf(a.s) - SUITS.indexOf(b.s) || a.r - b.r; });
  else hand.sort(function (a, b) { return a.r - b.r || SUITS.indexOf(a.s) - SUITS.indexOf(b.s); });
  kOrder[p] = hand.map(function (c) { return c.id; });
}
function kOrdered(p) {
  const by = {};
  KG.hands[p].forEach(function (c) { by[c.id] = c; });
  const out = [];
  kOrder[p].forEach(function (id) { if (by[id]) { out.push(by[id]); delete by[id]; } });
  KG.hands[p].forEach(function (c) { if (by[c.id]) out.push(c); });
  kOrder[p] = out.map(function (c) { return c.id; });
  return out;
}

/* ---------- a served state ----------
   Same idea as the Gin table: the snapshot gets the engine's prototype back,
   so every question the board asks about legality is answered locally from
   the piles (which are public) and our own hand (which we hold). */
let kPrevView = null;

/* What did the other player just do? Worked out by comparing two snapshots,
   because the server sends state rather than a commentary. */
function kNoteFromDiff(prev, v, them) {
  if (!prev) return null;
  const before = prev.piles.map(function (x) { return x.length; });
  const after = v.piles.map(function (x) { return x.length; });
  let emptied = -1, grew = -1, growth = 0;
  for (let i = 0; i < after.length; i++) {
    if (before[i] > 0 && after[i] === 0) emptied = i;
    if (after[i] > before[i]) { grew = i; growth = after[i] - before[i]; }
  }
  if (emptied >= 0 && grew >= 0 && growth === before[emptied]) {
    return kName(them) + ' moved the ' + KIC_NAMES[emptied] + ' pile onto ' + KIC_NAMES[grew];
  }
  if (grew >= 0 && growth === 1 && v.handCounts[them] < prev.handCounts[them]) {
    const card = v.piles[grew][v.piles[grew].length - 1];
    return kName(them) + ' played the ' + cardShort(card) + ' to ' + KIC_NAMES[grew];
  }
  return null;
}

function kApplyServerState(v) {
  const prev = kPrevView && kPrevView.kind === 'kic' ? kPrevView : null;
  const them = 1 - v.you;
  const newRound = !prev || prev.roundNo !== v.roundNo;
  const note = newRound ? null : kNoteFromDiff(prev, v, them);

  KG = hydrateView(v, KicGame.prototype);
  kBots = [null, null];
  kViewer = v.you;

  if (newRound) {
    kSelCard = null; kSelPile = null; kFlash = null; kLastNote = '';
    kOrder = [[], []];
    closeOverlay();
  } else if (note) {
    kLastNote = note;
  }
  if (v.turn === v.you && v.drawn) kFreshId = v.drawn.id;
  if (v.turn !== v.you) kFreshId = null;
  if (kSelCard && !KG.hands[kViewer].some(function (c) { return c.id === kSelCard; })) kSelCard = null;

  kSort(kViewer);
  if (screenName !== 'kic') showScreen('kic');
  kRender(newRound);
  if (newRound) sfx.deal();

  kPrevView = v;
  if (v.result) {
    if (v.result.stalemate) sfx.tap();
    else if (v.result.winner === kViewer) sfx.win();
    else sfx.lose();
    setTimeout(kSummary, 620);
  }
}

/* ---------- lifecycle ---------- */
function kStartMatch() {
  clearTimeout(kTimer);
  KG = new KicGame({ names: S.names.slice(), target: S.target, dealer: S.mode === 'ai' ? 1 : 0 });
  kBots = [null, null];
  if (S.mode === 'ai') kBots[1] = new KicAI(S.diff);
  kBeginRound();
}
function kBeginRound() {
  kSelCard = null; kSelPile = null; kFlash = null; kLastNote = '';
  kOrder = [[], []];
  kSort(0); kSort(1);
  kViewer = S.mode === 'pnp' ? KG.turn : 0;
  kFreshId = KG.drawn ? KG.drawn.id : null;
  showScreen('kic');
  kRender(true);
  sfx.deal();
  if (S.mode === 'pnp') kHandoff(KG.turn, 'Round ' + KG.roundNo + ' — you lead');
  else kAfter();
}
function kAfter() {
  if (!KG) return;
  if (KG.phase === 'ended') {
    clearTimeout(kTimer);
    if (KG.result.stalemate) sfx.tap();
    else if (KG.result.winner === 0 || S.mode === 'pnp') sfx.win();
    else sfx.lose();
    setTimeout(kSummary, 620);
    return;
  }
  if (S.mode === 'pnp') { if (KG.turn !== kViewer) kHandoff(KG.turn); return; }
  if (kIsBot(KG.turn)) kSchedule(beat(900));
}
function kHandoff(p, headline) {
  const wrap = el('div', 'handoff');
  wrap.innerHTML =
    '<div class="who">' + esc(kName(p)) + '</div>' +
    '<p>' + esc(headline || 'Your turn. Hand the device over before tapping — the other hand stays face-down until you do.') + '</p>' +
    '<button class="btn primary big" id="khGo">I\'m ready</button>';
  $('#overlays').innerHTML = '';
  $('#overlays').appendChild(wrap);
  wrap.querySelector('#khGo').onclick = function () {
    kViewer = p; kSelCard = null; kSelPile = null;
    kFreshId = KG.drawn ? KG.drawn.id : null;
    closeOverlay(); sfx.tap(); kRender();
  };
  wrap.querySelector('#khGo').focus();
}

/* ---------- the computer, one visible move at a time ---------- */
function kSchedule(delay) {
  clearTimeout(kTimer);
  kTimer = setTimeout(kBotStep, delay === undefined ? beat(900) : delay);
}
function kBotStep() {
  if (!KG || KG.phase !== 'play') return;
  const p = KG.turn;
  if (!kIsBot(p)) return;
  const act = kBots[p].nextAction(KG, p);
  if (!act) {
    KG.endTurn(p);
    kFreshId = KG.drawn ? KG.drawn.id : null;   // your freshly drawn card
    kSort(KG.turn === kViewer ? kViewer : KG.turn);
    kRender();
    kAfter();
    return;
  }
  if (act.type === 'card') {
    const card = KG.hands[p].find(function (c) { return c.id === act.cardId; });
    kLastNote = kName(p) + ' played the ' + cardShort(card) + ' to ' + KIC_NAMES[act.slot];
    KG.playCard(p, act.cardId, act.slot);
    kOrder[p] = kOrder[p].filter(function (id) { return id !== act.cardId; });
    kFlash = { slot: act.slot, kind: 'landed' };
    sfx.discard();
  } else {
    kLastNote = kName(p) + ' moved the ' + KIC_NAMES[act.from] + ' pile onto ' + KIC_NAMES[act.to];
    KG.movePile(p, act.from, act.to);
    kFlash = { slot: act.to, kind: 'landed' };
    sfx.draw();
  }
  kRender();
  if (KG.phase !== 'play') { kAfter(); return; }
  kSchedule(beat(900));
}

/* ---------- what the player does ---------- */
function kTapCard(id) {
  if (draggedRecently()) return;          // that was a rearrange, not a tap
  if (KG.phase !== 'play' || KG.turn !== kViewer || kIsBot(kViewer)) return;
  kSelPile = null;
  kSelCard = (kSelCard === id) ? null : id;
  kFlash = null;
  sfx.tap();
  kRender();
}
function kTapSlot(slot) {
  if (KG.phase !== 'play' || KG.turn !== kViewer || kIsBot(kViewer)) return;
  const p = kViewer;

  if (kSelCard) {
    if (KG.canPlayCard(p, kSelCard, slot)) {
      if (ONLINE) {
        NET.act({ do: 'play', cardId: kSelCard, slot: slot });
        kSelCard = null; kFlash = { slot: slot, kind: 'landed' }; sfx.discard();
        return;
      }
      KG.playCard(p, kSelCard, slot);
      kOrder[p] = kOrder[p].filter(function (id) { return id !== kSelCard; });
      if (kFreshId === kSelCard) kFreshId = null;
      kSelCard = null;
      kFlash = { slot: slot, kind: 'landed' };
      sfx.discard();
      kRender();
      if (KG.phase !== 'play') kAfter();
    } else {
      const c = KG.hands[p].find(function (x) { return x.id === kSelCard; });
      kFlash = { slot: slot, kind: 'refuse', why: 'The ' + cardShort(c) + ' will not go there.' };
      kRender();
    }
    return;
  }

  if (kSelPile !== null) {
    if (kSelPile === slot) { kSelPile = null; sfx.tap(); kRender(); return; }
    if (KG.canMovePile(p, kSelPile, slot)) {
      if (ONLINE) {
        NET.act({ do: 'move', from: kSelPile, to: slot });
        kSelPile = null; kFlash = { slot: slot, kind: 'landed' }; sfx.draw();
        return;
      }
      KG.movePile(p, kSelPile, slot);
      kSelPile = null;
      kFlash = { slot: slot, kind: 'landed' };
      sfx.draw();
      kRender();
    } else {
      kFlash = { slot: slot, kind: 'refuse', why: 'That pile will not go there.' };
      kRender();
    }
    return;
  }

  if (KG.piles[slot].length) { kSelPile = slot; sfx.tap(); kFlash = null; kRender(); }
}
/* Nothing is committed until the turn is ended, so plays come back one at a time. */
function kUndoPlay() {
  if (!KG || !KG.canUndo(kViewer) || kIsBot(kViewer)) return;
  const d = KG.describeLastPlay();
  if (ONLINE) {
    NET.act({ do: 'undo' });
    kSelCard = null; kSelPile = null;
    kFlash = d ? { slot: d.type === 'card' ? d.slot : d.from, kind: 'landed' } : null;
    sfx.draw();
    return;
  }
  KG.undo(kViewer);
  kSelCard = null; kSelPile = null;
  kFlash = d ? { slot: d.type === 'card' ? d.slot : d.from, kind: 'landed' } : null;
  kSort(kViewer);
  sfx.draw();
  kRender();
}
function kEndTurn() {
  if (KG.phase !== 'play' || KG.turn !== kViewer || kIsBot(kViewer)) return;
  kSelCard = null; kSelPile = null; kFlash = null;
  kLastNote = '';
  if (ONLINE) { NET.act({ do: 'end' }); sfx.tap(); return; }
  const r = KG.endTurn(kViewer);
  kFreshId = null;
  sfx.tap();
  kRender();
  if (r.ended) { kAfter(); return; }
  kAfter();
}

/* ---------- drawing the table ---------- */
function kRender(dealing) {
  if (!KG) return;
  kRenderScore();
  kRenderOpp(dealing);
  kRenderBoard();
  kRenderHand(dealing);
  kRenderActions();
  kRenderMsg();
  requestAnimationFrame(kFit);
}

function kRenderScore() {
  const me = kViewer, them = 1 - kViewer;
  function side(p) {
    const lead = KG.scores[p] < KG.scores[1 - p];   // low score is the good score here
    return '<div class="sb' + (lead ? ' lead' : '') + (KG.turn === p && KG.phase !== 'ended' ? ' act' : '') + '">' +
      '<span class="dot"></span><span class="nm">' + esc(kName(p)) + '</span>' +
      '<span class="pts">' + KG.scores[p] + '</span></div>';
  }
  // the suffix is the first thing to go when the bar is narrow
  const roomy = window.innerWidth >= 440;
  const chip = KG.target
    ? ('out at ' + KG.target + (roomy ? ' · low wins' : ''))
    : 'one round';
  $('#kScore').innerHTML = side(me) + '<span class="sbsep">vs</span>' + side(them) +
    '<span class="target-chip">' + chip + '</span>';
}

function kRenderOpp(dealing) {
  const them = 1 - kViewer;
  const initial = (kName(them) || '?').trim().charAt(0).toUpperCase() || '?';
  $('#kOppSeat').innerHTML = '<span class="av">' + esc(initial) + '</span>' +
    '<span><b>' + esc(kName(them)) + '</b> · ' + KG.hands[them].length + ' cards</span>';
  const box = $('#kOppHand');
  box.innerHTML = '';
  box.className = 'opphand' + (dealing ? ' dealing' : '');
  const show = Math.min(KG.hands[them].length, 12);
  for (let i = 0; i < show; i++) { const nn = backNode('mini'); nn.style.setProperty('--i', i); box.appendChild(nn); }
  if (dealing) setTimeout(function () { box.classList.remove('dealing'); }, 900);

}

function kRenderBoard() {
  const board = $('#kBoard');
  board.innerHTML = '';
  const mine = KG.phase === 'play' && KG.turn === kViewer && !kIsBot(kViewer);

  KGRID.forEach(function (slot) {
    if (slot === -1) {
      const d = el('div', 'kdeck');
      if (KG.stock.length) {
        d.appendChild(backNode());
        d.appendChild(el('span', 'kleft', String(KG.stock.length)));
      } else {
        d.appendChild(el('div', 'kempty', 'DECK<br>OUT'));
      }
      board.appendChild(d);
      return;
    }
    const cell = el('div', 'kslot');
    cell.dataset.slot = String(slot);
    const pile = KG.piles[slot];
    if (!pile.length) {
      cell.appendChild(el('div', 'kempty', kicIsCorner(slot) ? 'K' : ''));
    } else {
      const depth = Math.min(pile.length - 1, 3);
      for (let d = depth; d > 0; d--) {
        const u = el('div', 'under');
        u.style.cssText = 'inset:' + (-d * 3) + 'px ' + (-d * 3) + 'px ' + (d * 3) + 'px ' + (d * 3) + 'px';
        cell.appendChild(u);
      }
      cell.appendChild(cardNode(pile[pile.length - 1]));
      if (pile.length > 1) {
        const base = pile[0];
        cell.appendChild(el('div', 'kbase' + (SUIT[base.s].c === 'r' ? ' red' : ''),
          'on ' + RL[base.r] + SUIT[base.s].g));
      }
    }
    if (kSelPile === slot) cell.classList.add('picked');
    if (kFlash && kFlash.slot === slot) cell.classList.add(kFlash.kind === 'refuse' ? 'refuse' : 'landed');
    if (mine) {
      cell.classList.add('pickable');
      cell.onclick = function () { kTapSlot(slot); };
    }
    board.appendChild(cell);
  });
}

function kRenderHand(dealing) {
  const me = kViewer;
  const hand = kOrdered(me);
  const mine = KG.phase === 'play' && KG.turn === me && !kIsBot(me);
  const box = $('#kHand');
  box.innerHTML = '';
  box.className = 'hand' + (dealing ? ' dealing' : '');
  kNodes = [];
  hand.forEach(function (c, i) {
    let cls = '';
    if (c.id === kSelCard) cls += ' sel';
    if (c.id === kFreshId && mine) cls += ' fresh';
    if (mine) cls += ' tappable';
    const nn = cardNode(c, cls.trim());
    nn.style.setProperty('--i', i);
    if (mine) nn.onclick = function () { kTapCard(c.id); };
    kNodes.push(nn);
  });
  kLayoutHand();
  if (dealing) setTimeout(function () { box.classList.remove('dealing'); }, 900);
}

function kRenderActions() {
  const box = $('#kActions');
  box.innerHTML = '';
  if (KG.phase === 'ended') {
    const b = el('button', 'btn primary', 'See how the round ended');
    b.onclick = kSummary; box.appendChild(b);
    return;
  }
  if (KG.turn !== kViewer || kIsBot(kViewer)) {
    box.appendChild(el('div', 'thinking', '<i></i><i></i><i></i>'));
    return;
  }
  if (kSelCard || kSelPile !== null) {
    const c = el('button', 'btn', 'Cancel');
    c.onclick = function () { kSelCard = null; kSelPile = null; kFlash = null; sfx.tap(); kRender(); };
    box.appendChild(c);
  }
  if (KG.canUndo(kViewer)) {
    const d = KG.describeLastPlay();
    const label = d && d.type === 'card' ? 'Undo ' + cardShort(d.card) : 'Undo the move';
    const u = el('button', 'btn', label);
    u.onclick = kUndoPlay;
    box.appendChild(u);
  }
  const e = el('button', 'btn primary', 'End my turn');
  e.onclick = kEndTurn;
  box.appendChild(e);
}

function kRenderMsg() {
  const me = kViewer, them = 1 - kViewer;
  const box = $('#kMsg');
  let main = '', sub = '';
  if (KG.phase === 'ended') {
    main = 'Round over';
  } else if (ONLINE && KG.turn !== me) {
    if (!PEER_HERE) {
      main = kName(them) + ' has dropped out';
      sub = 'Their seat is held for a couple of minutes. Play carries on if they get back.';
    } else {
      main = 'Waiting for ' + kName(them);
      sub = kLastNote || 'It is their turn.';
    }
  } else if (KG.turn !== me || kIsBot(me)) {
    main = kName(them) + ' is playing…';
    sub = kLastNote || 'Watch the board.';
  } else if (kFlash && kFlash.kind === 'refuse') {
    main = kFlash.why;
    sub = 'Build down in the other colour. Kings open an empty corner.';
  } else if (kSelCard) {
    const c = KG.hands[me].find(function (x) { return x.id === kSelCard; });
    main = 'Holding the ' + cardShort(c);
    sub = 'Tap a pile to lay it down, or tap the card again to put it back.';
  } else if (kSelPile !== null) {
    const base = KG.piles[kSelPile][0];
    main = 'Holding the ' + KIC_NAMES[kSelPile] + ' pile — it sits on the ' + cardShort(base);
    /* A King outranks everything, so its pile has exactly one destination. */
    sub = (base.r === 13 && !kicIsCorner(kSelPile))
      ? 'Tap an empty corner — that is where this King belongs.'
      : 'It moves onto any pile showing one higher in the other colour.';
  } else {
    main = 'Your turn';
    if (KG.canUndo(me)) {
      sub = 'Nothing counts until you end the turn — Undo puts a card back in your hand.';
    } else {
      sub = (KG.drawn && kFreshId)
        ? 'You drew the ' + cardShort(KG.hands[me].find(function (x) { return x.id === kFreshId; }) || KG.drawn) + '. Play what you like, then end your turn.'
        : 'Play what you can, then end your turn.';
    }
  }
  box.innerHTML = esc(main) + (sub ? '<span class="sub">' + esc(sub) + '</span>' : '');
}

/* ---------- sizing: board and hand share what is left ---------- */
function kFit() {
  const table = $('#screen-kic');
  if (!table || table.hidden) return;
  /* Measure inside this screen: a bare '.topbar' finds the hidden Gin one
     and reports zero, which quietly hands the board too much room. */
  const h = function (sel) { const e = table.querySelector(sel); return e ? e.offsetHeight : 0; };
  const rootCS = getComputedStyle(document.documentElement);
  const prefW = parseFloat(rootCS.getPropertyValue('--cw')) || 72;
  const prefH = parseFloat(rootCS.getPropertyValue('--ch')) || 103;
  const ratio = prefH / prefW;

  const CHROME = 46 + 36;   // youzone padding, the gaps around the hand, and
                            // the 36px that lowers the board (see .kwrap)
  // measure the status line as it actually rendered rather than guessing at it
  const MSG = Math.max(42, h('#kMsg')) + 10;
  const room = table.clientHeight - h('.topbar') - h('.oppzone') - h('.handmeta') - h('.actions') - CHROME;
  const forCards = Math.max(150, room - MSG);
  const handH = Math.max(54, Math.min(prefH, Math.floor(forCards * 0.30)));
  const boardH = Math.max(108, forCards - handH);

  const wrapW = ($('#kBoard').parentNode.clientWidth || table.clientWidth) - 8;
  const gap = 6;
  const bw = Math.max(30, Math.floor(Math.min((wrapW - 2 * gap) / 3, ((boardH - 2 * gap) / 3) / ratio)));
  const board = $('#kBoard');
  board.style.setProperty('--bw', bw + 'px');
  board.style.setProperty('--bh', Math.round(bw * ratio) + 'px');
  board.style.setProperty('--bgap', gap + 'px');

  kLayoutHand(Math.floor(handH / ratio));
}

/* The board was sized once per render and never again, so anything that
   changed the room available without redrawing — turning the phone, the
   browser bar sliding away, or the status line simply wrapping onto another
   line — left the board at its old size and pushed the bottom of the middle
   band down over the hand. Both of those now re-fit. */
window.addEventListener('resize', function () { requestAnimationFrame(kFit); });
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(function () { requestAnimationFrame(kFit); })
    .observe(document.getElementById('kMsg'));
}

function kLayoutHand(maxCw) {
  const box = $('#kHand');
  if (!box) return;
  const n = kNodes.length;
  box.innerHTML = '';
  if (!n) return;
  const rootCS = getComputedStyle(document.documentElement);
  const prefW = parseFloat(rootCS.getPropertyValue('--cw')) || 72;
  const prefH = parseFloat(rootCS.getPropertyValue('--ch')) || 103;
  const ratio = prefH / prefW;
  const avail = Math.max(160, box.clientWidth - 6);
  const cap = Math.min(prefW, maxCw || prefW);
  const span = 1 + (n - 1) * (1 - 0.52);
  const cw = Math.max(38, Math.min(cap, Math.floor(avail / span)));
  const need = n > 1 ? Math.max(0, Math.ceil((n * cw - avail) / (n - 1))) : 0;
  box.style.setProperty('--cw', cw + 'px');
  box.style.setProperty('--ch', Math.round(cw * ratio) + 'px');
  box.style.setProperty('--ov', Math.min(Math.round(cw * 0.52), need) + 'px');
  const row = el('div', 'handrow');
  kNodes.forEach(function (nd) { row.appendChild(nd); });
  box.appendChild(row);
  wireHandDrag(box, function (ids) {
    kOrder[kViewer] = ids.slice();
    if (S.sortMode !== 'manual') { S.sortMode = 'manual'; saveSettings(); paintSorts(); }
    sfx.discard();
    kRender();
  });
}

/* ---------- how the round scored ---------- */
function kSummary() {
  const r = KG.result;
  let body, foot;
  if (r.stalemate) {
    body = '<div class="verdict"><div class="big">Nobody could move</div>' +
      '<div class="why">The deck ran out and neither of you had a legal play, so you each carry what you were left holding.</div></div>' +
      '<div class="mathline">' + esc(kName(0)) + ' +' + r.penalties[0] + '   ·   ' + esc(kName(1)) + ' +' + r.penalties[1] + '</div>';
  } else {
    const w = r.winner, l = r.loser;
    body = '<div class="verdict">' +
      '<div class="big">' + esc(kName(w)) + ' went out</div>' +
      '<div class="pts">' + esc(kName(l)) + ' +' + r.points + '</div>' +
      '<div class="why">Emptying your hand costs you nothing. ' + esc(kName(l)) +
      ' is charged for every card still held — and the <b>lower</b> total wins the match.</div></div>' +
      '<div class="rev-side"><h4>' + esc(kName(l)) + ' was left holding <span>' + r.points + ' points</span></h4>' +
      '<div class="meldrow">' + (r.hands[l].length
        ? r.hands[l].slice().sort(function (a, b) { return a.r - b.r || SUITS.indexOf(a.s) - SUITS.indexOf(b.s); }).map(function (c) { return miniNode(c); }).join('')
        : 'nothing') + '</div></div>';
  }
  if (KG.tiebreak) {
    body += '<div class="mathline">Level at ' + KG.scores[0] + ' each. One more round decides it.</div>';
  }
  body += '<div class="rev-side"><h4>Match <span>' + KG.scores[0] + ' – ' + KG.scores[1] + '</span></h4><div class="histlist">' +
    KG.history.map(function (hh, i) {
      const line = hh.stalemate
        ? 'no move: +' + hh.penalties[0] + ' / +' + hh.penalties[1]
        : kName(hh.winner) + ' out · ' + kName(hh.loser) + ' +' + hh.points;
      return '<div class="histrow"><span>Round ' + (i + 1) + '</span><span>' + esc(line) + '</span></div>';
    }).join('') + '</div></div>';

  foot = KG.matchOver
    ? '<button class="btn primary" id="kSumEnd">Final score</button>'
    : '<button class="btn" id="kSumQuit">Back to setup</button><button class="btn primary" id="kSumNext">' +
      (KG.tiebreak ? 'Deal the decider' : 'Deal the next round') + '</button>';
  const wrap = sheet(r.stalemate ? 'A blocked round' : 'How the round scored', body, foot, { noClose: true });
  const nx = wrap.querySelector('#kSumNext');
  if (nx) nx.onclick = function () {
    closeOverlay();
    if (ONLINE) { NET.act({ do: 'next' }); return; }
    KG.nextRound(); kBeginRound();
  };
  const qz = wrap.querySelector('#kSumQuit');
  if (qz) qz.onclick = function () { KG = null; leaveTable(); };
  const en = wrap.querySelector('#kSumEnd');
  if (en) en.onclick = function () { closeOverlay(); kGameOver(); };
}

function kGameOver() {
  const w = KG.matchWinner;
  const head = kName(w) + ' takes the match';
  const body = '<div class="verdict"><div class="big">' + esc(head) + '</div>' +
    '<div class="pts">' + KG.scores[0] + ' – ' + KG.scores[1] + '</div>' +
    '<div class="why">Lowest total wins. ' + KG.roundNo + ' round' + (KG.roundNo === 1 ? '' : 's') + ' played.</div></div>' +
    '<div class="histlist">' + KG.history.map(function (hh, i) {
      const line = hh.stalemate ? 'blocked' : kName(hh.winner) + ' out · ' + kName(hh.loser) + ' +' + hh.points;
      return '<div class="histrow"><span>Round ' + (i + 1) + '</span><span>' + esc(line) + '</span></div>';
    }).join('') + '</div>';
  const wrap = sheet('Match over', body,
    '<button class="btn" id="kGoLobby">Back to setup</button><button class="btn primary" id="kGoAgain">Play again</button>',
    { noClose: true });
  wrap.querySelector('#kGoAgain').onclick = function () {
    closeOverlay();
    if (ONLINE) { NET.rematch(); return; }
    kStartMatch();
  };
  wrap.querySelector('#kGoLobby').onclick = function () { KG = null; leaveTable(); };
}

/* ---------- rules ---------- */
function kRulesHTML() {
  return '<div class="rules">' +
    '<section><h3>The point of the game</h3>' +
    '<p>Get rid of every card in your hand. Whoever empties their hand first ends the round and scores nothing; the other player is <b>charged</b> for every card still in their hand. Those charges pile up, and the player with the <b>lowest</b> total at the end wins.</p>' +
    '<table class="valtable">' +
    '<tr><td>Ace</td><td>1</td></tr>' +
    '<tr><td>2 through 10</td><td>face value</td></tr>' +
    '<tr><td>Jack, Queen, King</td><td>10 each</td></tr></table>' +
    '<p>So getting stuck with a King hurts ten times as much as an Ace. The number beside your hand is what you would be charged right now.</p>' +
    '<p><b>Arranging your hand.</b> <b>Rank</b> and <b>Suit</b> sort it for you. Drag a card sideways and it goes where you put it, switching to <b>Mine</b> so it stays that way.</p>' +
    '<p><b>The Ace is the low card.</b> A red Ace goes on a black 2 and a black Ace on a red 2 — and once an Ace is down, that pile is finished, because nothing is lower. An Ace can never open a corner; only a King does that.</p>' +
    '</section>' +

    '<section><h3>The table</h3>' +
    '<p>Four cards are turned up in a cross — north, east, south and west. The four corners start empty and are <b>reserved for Kings</b>. The deck sits in the middle.</p>' +
    '</section>' +

    '<section><h3>A turn</h3>' +
    '<p>You draw one card automatically, then play as much or as little as you like, then tap <b>End my turn</b>.</p>' +
    '<p><b>Changed your mind?</b> Nothing is committed until you end the turn. <b>Undo</b> puts the last card you played back in your hand, or slides a moved pile back where it came from, and you can keep tapping it until the board is exactly as you found it. The card you drew at the start stays — that draw is compulsory, not a play.</p>' +
    '<p><b>Laying a card down.</b> Tap a card in your hand, then tap a pile. It goes down only if it is <b>one lower and the other colour</b> than the card showing on that pile — a red 7 onto a black 8, say. If it will not go, the pile shakes its head and the card stays with you.</p>' +
    '<p><b>Kings.</b> A King can never go on top of anything, because nothing outranks it. It goes into an empty corner instead, marked <b>K</b>, and starts a fresh pile there.</p>' +
    '<p><b>A King turned up on the cross</b> is not stuck. Tap it to pick up its pile, then tap an empty corner — the King moves there and takes anything built on it along, freeing the arm it came from.</p>' +
    '<p><b>Moving a whole pile.</b> Tap a pile with nothing held to pick it up, then tap another pile. The whole stack moves if the card at the <i>bottom</i> of it fits on the destination — one lower, other colour, the same rule as a single card. That clears a space.</p>' +
    '<p><b>Reading a pile.</b> The card you can see is the top one — the one you build on. The dark band across its foot — <b>on 9♥</b> — names the card at the <i>bottom</i> of the stack, and that is the card that has to fit somewhere if you want to move the whole pile. A single-card pile has no band: what you see is both top and bottom.</p>' +
    '<p><b>A cleared arm of the cross</b> will then take <b>any</b> card from your hand — which is how you unload an expensive one. A cleared corner still wants a King.</p>' +
    '</section>' +

    '<section><h3>Ending a round</h3>' +
    '<p>The moment somebody plays their last card the round is over. If the deck runs out and neither player can move, the round is blocked and you are both charged for what you hold.</p>' +
    '</section>' +

    '<section><h3>Winning</h3>' +
    '<p>Charges carry from round to round. As soon as someone reaches the limit you chose, the match stops and the player with the <b>fewer</b> points wins it. Pick <b>One round</b> in the lobby to settle it in a single deal instead.</p>' +
    '<p>If you both arrive on the <i>same</i> total, that is not a result — the match keeps going and you play a decider until one of you is genuinely ahead.</p>' +
    '</section>' +
    '</div>';
}
