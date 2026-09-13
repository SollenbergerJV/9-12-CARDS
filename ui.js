/* ============================================================
   UI LAYER
   ============================================================ */
const $ = function (s) { return document.querySelector(s); };
const el = function (tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };

/* ---------- settings ---------- */
const LS = 'ginco.v1';
function loadSettings() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } }
const S = Object.assign({
  skin: 'felt', theme: 'auto', size: 'comfy', sound: true, sortMode: 'auto', pace: 'deliberate', game: 'gin',
  mode: 'ai', diff: 'normal', target: 100, names: ['You', 'Opponent']
}, loadSettings());
function saveSettings() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) { } }
function applyChrome() {
  const r = document.documentElement;
  r.setAttribute('data-skin', S.skin);
  if (S.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.theme);
  r.setAttribute('data-size', S.size);
}
applyChrome();

/* ---------- sound ---------- */
let actx = null;
function ac() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = false; } }
  return actx || null;
}
function tone(f, dur, type, vol, delay) {
  if (!S.sound) return;
  const a = ac(); if (!a) return;
  const t = a.currentTime + (delay || 0);
  const o = a.createOscillator(), g = a.createGain();
  o.type = type || 'sine'; o.frequency.setValueAtTime(f, t);
  o.connect(g); g.connect(a.destination);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol || 0.12, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t); o.stop(t + dur + 0.03);
}
function swish(delay, vol) {
  if (!S.sound) return;
  const a = ac(); if (!a) return;
  const t = a.currentTime + (delay || 0), len = 0.09;
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * len), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2100; f.Q.value = 0.8;
  const g = a.createGain(); g.gain.value = vol || 0.16;
  src.connect(f); f.connect(g); g.connect(a.destination);
  src.start(t);
}
const sfx = {
  deal: function () { for (let i = 0; i < 6; i++) swish(i * 0.075, 0.11); },
  draw: function () { swish(0, 0.15); tone(560, 0.07, 'triangle', 0.07); },
  discard: function () { swish(0, 0.15); tone(330, 0.11, 'triangle', 0.09); },
  knock: function () { tone(200, 0.1, 'square', 0.09); tone(160, 0.16, 'square', 0.09, 0.1); },
  win: function () {[523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.3, 'sine', 0.11, i * 0.085); }); },
  lose: function () {[440, 370, 294].forEach(function (f, i) { tone(f, 0.32, 'sine', 0.09, i * 0.1); }); },
  tap: function () { tone(720, 0.045, 'sine', 0.05); }
};

/* ---------- card rendering ---------- */
function cardNode(c, extraCls) {
  const meta = SUIT[c.s];
  const n = el('div', 'card ' + (meta.c === 'r' ? 'red' : 'black') + (extraCls ? ' ' + extraCls : ''));
  n.dataset.id = c.id;
  const centre = c.r > 10 ? '<b>' + RL[c.r] + '</b>' : '<i>' + meta.g + '</i>';
  n.innerHTML =
    '<span class="band"></span>' +
    '<span class="ci"><b>' + RL[c.r] + '</b><i>' + meta.g + '</i></span>' +
    '<span class="mid">' + centre + '</span>';
  n.setAttribute('aria-label', cardName(c));
  return n;
}
function backNode(cls) { return el('div', 'card back' + (cls ? ' ' + cls : '')); }
function miniNode(c, extra) {
  const meta = SUIT[c.s];
  return '<span class="minicard ' + (meta.c === 'r' ? 'red' : '') + ' ' + (extra || '') + '">' +
    RL[c.r] + '<i>' + meta.g + '</i></span>';
}

/* ============================================================
   GAME GLUE
   ============================================================ */
let G = null, bots = [null, null], viewer = 0, sel = null, order = [[], []], botTimer = null;
let lastDiscardTop = null;
let freshId = null;   // the card the human player just drew
let lastTapId = null, lastTapAt = 0;
const DOUBLE_TAP_MS = 500;
let lastDraw = [null, null];
let botIntent = null;      // what the computer is about to do, shown before it does it

/* The computer plays in visible beats so you can see which pile it takes from. */
const PACE = { slower: 1.6, deliberate: 1.0, brisk: 0.62 };
function beat(base) { return Math.round(base * (PACE[S.pace] || 1)); }
let lastPillHTML = null;

function isBot(p) { return !ONLINE && !!bots[p]; }
function nameOf(p) { return G ? (G.names[p] || (p === 0 ? 'You' : 'Opponent')) : ''; }
/* Use whatever name the player typed. Left blank, it is already "You". */
function youLabel(p) { return nameOf(p); }

/* With auto-sort on (the default) the hand regroups itself into melds after
   every draw and every discard, so the player never has to tidy it by hand. */
function applySort(p) {
  if (S.sortMode === 'manual') {
    /* Hands off — the order is the player's own. The one exception is a fresh
       hand, which has no order yet: that gets tidied into melds once, as a
       starting point to rearrange from. */
    if (!order[p] || !order[p].length) autoArrange(p);
    return;
  }
  if (S.sortMode === 'auto') autoArrange(p); else sortBy(p, S.sortMode);
}
function onAdd(p, card) {
  order[p].push(card.id);
  applySort(p);
  if (!isBot(p)) freshId = card.id;
}
function onRemove(p, id) {
  const i = order[p].indexOf(id);
  if (i >= 0) order[p].splice(i, 1);
  applySort(p);
  if (freshId === id) freshId = null;
}

/* Where a player drew from is public information and matters a lot in Gin —
   taking the pile tells the table exactly what you needed. */
function recordDraw(p, src, card) {
  lastDraw[p] = { src: src, card: card };
}
function noteTook(p, card) { const b = bots[1 - p]; if (b) b.noteOpponentTook(card); }

function sortBy(p, how) {
  const hand = G.hands[p].slice();
  if (how === 'rank') hand.sort(function (a, b) { return a.r - b.r || SUITS.indexOf(a.s) - SUITS.indexOf(b.s); });
  else hand.sort(function (a, b) { return SUITS.indexOf(a.s) - SUITS.indexOf(b.s) || a.r - b.r; });
  order[p] = hand.map(function (c) { return c.id; });
}
function autoArrange(p) {
  const a = bestArrangement(G.hands[p]);
  const ids = [];
  a.melds.forEach(function (m) {
    const cs = m.type === 'run'
      ? sortedRun(m)
      : m.cards.slice().sort(function (x, y) { return SUITS.indexOf(x.s) - SUITS.indexOf(y.s); });
    cs.forEach(function (c) { ids.push(c.id); });
  });
  a.deadwood.slice().sort(function (x, y) { return val(y) - val(x); }).forEach(function (c) { ids.push(c.id); });
  order[p] = ids;
}
function orderedHand(p) {
  const byId = {};
  G.hands[p].forEach(function (c) { byId[c.id] = c; });
  const out = [];
  order[p].forEach(function (id) { if (byId[id]) { out.push(byId[id]); delete byId[id]; } });
  G.hands[p].forEach(function (c) { if (byId[c.id]) out.push(c); });
  order[p] = out.map(function (c) { return c.id; });
  return out;
}

/* ============================================================
   ARRANGING A HAND BY HAND

   Cards overlap and can wrap to two rows, so reordering by moving
   the real card under the finger would make the row jump about. The
   dragged card is instead lifted out as a floating copy that follows
   the pointer, while the original stays in the row as a placeholder
   and slides between its neighbours. What you drop is exactly what
   you were shown.

   A drag and a tap start identically, so nothing is a drag until the
   pointer has travelled far enough to mean it — below that it is a
   tap, and selecting and double-tapping keep working untouched.
   ============================================================ */
const DRAG_SLOP = 8;          // px of travel before a press becomes a drag
let dragJustEnded = 0;        // suppresses the click that follows a drag

function draggedRecently() { return Date.now() - dragJustEnded < 320; }

function wireHandDrag(box, commit) {
  if (!box || box.dataset.dragWired === '1') return;
  box.dataset.dragWired = '1';

  let card = null, ghost = null, startX = 0, startY = 0, live = false, pid = null, captured = false;

  function cardsInFlow() {
    return Array.prototype.slice.call(box.querySelectorAll('.card'));
  }

  function begin(e) {
    live = true;
    /* Capture only NOW, not on the press. A captured pointer sends its click
       to the capture target instead of the card, which would quietly kill
       tap-to-select and double-tap-to-throw for every card in the hand. */
    try { box.setPointerCapture(e.pointerId); captured = true; } catch (err) {}
    const r = card.getBoundingClientRect();
    ghost = card.cloneNode(true);
    ghost.className = card.className + ' draghost';
    ghost.style.width = r.width + 'px';
    ghost.style.height = r.height + 'px';
    ghost.style.left = r.left + 'px';
    ghost.style.top = r.top + 'px';
    ghost.style.margin = '0';
    document.body.appendChild(ghost);
    card.classList.add('dragfrom');
    document.body.classList.add('dragging-card');
    if (S.sound) sfx.tap();
    move(e);
  }

  function move(e) {
    if (!ghost) return;
    const r = card.getBoundingClientRect();
    ghost.style.transform = 'translate(' + (e.clientX - startX) + 'px,' + (e.clientY - startY) + 'px)';

    /* Where would it land? Whichever card's middle the pointer is nearest,
       on whichever row the pointer is over. */
    const others = cardsInFlow().filter(function (n) { return n !== card; });
    if (!others.length) return;
    let best = null, bestD = Infinity;
    for (const n of others) {
      const b = n.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const dy = Math.abs(e.clientY - cy);
      const d = Math.abs(e.clientX - cx) + (dy > b.height * 0.7 ? 4000 : 0) + dy * 0.15;
      if (d < bestD) { bestD = d; best = n; }
    }
    if (!best) return;
    const b = best.getBoundingClientRect();
    const after = e.clientX > b.left + b.width / 2;
    const ref = after ? best.nextSibling : best;
    if (ref !== card && best.parentNode) {
      if (after) best.parentNode.insertBefore(card, best.nextSibling);
      else best.parentNode.insertBefore(card, best);
    }
  }

  function finish() {
    if (ghost) { ghost.remove(); ghost = null; }
    if (card) card.classList.remove('dragfrom');
    document.body.classList.remove('dragging-card');
    if (live) {
      dragJustEnded = Date.now();
      const ids = cardsInFlow().map(function (n) { return n.dataset.id; }).filter(Boolean);
      if (ids.length) commit(ids);
    }
    card = null; live = false; pid = null; captured = false;
  }

  box.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    const n = e.target.closest ? e.target.closest('.card') : null;
    if (!n || !box.contains(n) || !n.dataset.id) return;
    card = n; startX = e.clientX; startY = e.clientY; live = false; pid = e.pointerId; captured = false;
  });

  box.addEventListener('pointermove', function (e) {
    if (!card || e.pointerId !== pid) return;
    if (!live) {
      if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < DRAG_SLOP) return;
      begin(e);
      return;
    }
    e.preventDefault();
    move(e);
  });

  box.addEventListener('pointerup', function (e) {
    if (!card || e.pointerId !== pid) return;
    if (captured) { try { box.releasePointerCapture(e.pointerId); } catch (err) {} }
    finish();
  });
  box.addEventListener('pointercancel', function () { finish(); });
}

/* Rearranging by hand IS choosing manual order, so the first drag switches
   the setting. Leaving it on Auto would re-sort the cards a moment later and
   look like the app had ignored you. */
function commitHandOrder(p, ids, repaint) {
  order[p] = ids.slice();
  if (S.sortMode !== 'manual') { S.sortMode = 'manual'; saveSettings(); paintSorts(); }
  sfx.discard();
  repaint();
}

/* ---------- a served state ----------
   The server sends the same field names the local game uses, with the other
   player's cards blanked out. Putting the engine's prototype back on it means
   the table code cannot tell the difference: every read-only rule it asks
   about — what may be discarded, what a knock would cost — is answered from
   our own cards, which we do have. */
function hydrateView(v, proto) {
  const g = Object.create(proto);
  for (const k in v) g[k] = v[k];
  g.stock = new Array(v.stockCount || 0).fill(null);   // a count, not the cards
  return g;
}

let prevView = null;

function applyServerState(v) {
  const prev = prevView && prevView.kind === 'gin' ? prevView : null;
  const them = 1 - v.you;
  const prevTop = (prev && prev.discard && prev.discard.length)
    ? prev.discard[prev.discard.length - 1] : null;

  /* Which card just arrived in our hand, so it can carry the fresh ring. */
  let gained = null;
  if (prev && prev.you === v.you) {
    const had = {};
    prev.hands[v.you].forEach(function (c) { had[c.id] = 1; });
    v.hands[v.you].forEach(function (c) { if (!had[c.id]) gained = c; });
  }

  /* Where the opponent drew from is public and matters enormously in Gin,
     so it is reconstructed from the change between two snapshots rather
     than trusted from a single field. */
  let draw = null;
  if (prev && prev.turn === them) {
    if (prev.phase !== 'discard' && v.phase === 'discard' && v.turn === them) {
      draw = (v.drewFrom === 'discard')
        ? { src: 'discard', card: prevTop } : { src: 'stock', card: null };
    }
  }

  const newHand = !prev || prev.handNo !== v.handNo;
  G = hydrateView(v, GinGame.prototype);
  bots = [null, null];
  viewer = v.you;

  if (newHand) {
    sel = null; freshId = null; lastTapId = null;
    order = [[], []]; lastDraw = [null, null];
    botIntent = null; lastPillHTML = null; lastDiscardTop = null;
    closeOverlay();
  }
  if (draw) lastDraw[them] = draw;
  if (gained) freshId = gained.id;
  if (sel && !G.hands[viewer].some(function (c) { return c.id === sel; })) sel = null;

  applySort(viewer);
  if (screenName !== 'table') showScreen('table');
  render(newHand);
  if (newHand) sfx.deal();

  prevView = v;
  if (v.result) {
    if (v.result.dead) sfx.tap();
    else if (v.result.winner === viewer) sfx.win();
    else sfx.lose();
    setTimeout(openSummary, 560);
  }
}

/* ---------- match lifecycle ---------- */
function startMatch() {
  clearTimeout(botTimer);
  G = new GinGame({ names: S.names.slice(), target: S.target, dealer: S.mode === 'ai' ? 1 : 0 });
  bots = [null, null];
  if (S.mode === 'ai') bots[1] = new AI(S.diff);
  beginHand();
}
function beginHand() {
  sel = null;
  freshId = null;
  lastTapId = null;
  order = [[], []];
  lastDraw = [null, null];
  botIntent = null;
  lastPillHTML = null;
  applySort(0); applySort(1);
  viewer = S.mode === 'pnp' ? G.turn : 0;
  showScreen('table');
  render(true);
  sfx.deal();
  if (S.mode === 'pnp') {
    showHandoff(G.turn, 'Hand ' + G.handNo + ' — you lead');
  } else {
    afterState();
  }
}
function afterState() {
  if (!G) return;
  if (G.phase === 'ended') {
    clearTimeout(botTimer);
    if (G.result.dead) sfx.tap();
    else if (G.result.winner === 0 || S.mode === 'pnp') sfx.win();
    else sfx.lose();
    setTimeout(openSummary, 560);
    return;
  }
  if (S.mode === 'pnp') {
    if (G.turn !== viewer) showHandoff(G.turn);
    return;
  }
  if (isBot(G.turn)) scheduleBot();
}
function scheduleBot(delay) {
  clearTimeout(botTimer);
  botTimer = setTimeout(botAct, delay === undefined ? beat(900) : delay);
}

/* One beat per call. A draw takes two: first the computer shows which pile it
   is reaching for and holds there, then it actually takes the card. */
function botAct() {
  if (!G || G.phase === 'ended') return;
  const p = G.turn;
  if (!isBot(p)) return;
  const bot = bots[p];

  if (G.phase === 'draw') {
    const up = G.topDiscard();
    if (!botIntent) {
      const src = (G.canDraw(p, 'discard') && up && bot.wantsUpcard(G.hands[p], up)) ? 'discard' : 'stock';
      botIntent = { src: src, card: src === 'stock' ? null : up };
      render();
      scheduleBot(beat(1000));
      return;
    }
    const src = botIntent.src;
    botIntent = null;
    if (src === 'discard') {
      G.draw(p, 'discard'); onAdd(p, up); recordDraw(p, 'discard', up); noteTook(p, up); sfx.draw();
    } else {
      const c = G.draw(p, 'stock'); onAdd(p, c); recordDraw(p, 'stock', null); sfx.draw();
    }
    render();
    if (G.phase !== 'ended' && isBot(G.turn)) scheduleBot(beat(950)); else afterState();
    return;
  }

  if (G.phase === 'discard') {
    const d = bot.chooseDiscard(G, p);
    onRemove(p, d.cardId);
    if (d.knock) sfx.knock(); else sfx.discard();
    G.discardCard(p, d.cardId, d.knock);
    render();
    if (G.phase !== 'ended' && isBot(G.turn)) scheduleBot(beat(950)); else afterState();
  }
}

/* ---------- human moves ---------- */
function humanDraw(src) {
  if (ONLINE) { NET.act({ do: 'draw', source: src }); sfx.draw(); return; }
  const p = G.turn, up = G.topDiscard();
  const c = G.draw(p, src); onAdd(p, c);
  recordDraw(p, src, src === 'discard' ? up : null);
  if (src === 'discard') noteTook(p, up);
  sfx.draw(); sel = null;
  render(); afterState();
}
function humanDiscard(knock) {
  const p = G.turn;
  if (!sel || !G.canDiscard(p, sel)) return;
  if (knock && !G.canKnock(p, sel)) return;
  if (ONLINE) {
    NET.act({ do: 'discard', cardId: sel, knock: !!knock });
    if (knock) sfx.knock(); else sfx.discard();
    sel = null; lastTapId = null;
    return;
  }
  const id = sel; sel = null;
  onRemove(p, id);
  if (knock) sfx.knock(); else sfx.discard();
  G.discardCard(p, id, knock);
  freshId = null;
  lastTapId = null;
  render(); afterState();
}

/* ============================================================
   RENDER
   ============================================================ */
function render(dealing) {
  if (!G) return;
  renderScore();
  renderOpp(dealing);
  renderPiles();
  renderHand(dealing);
  renderActions();
  renderMsg();
  requestAnimationFrame(fitHand);
}

function renderScore() {
  const box = $('#scoreboard');
  const me = viewer, them = 1 - viewer;
  function side(p) {
    const lead = G.scores[p] > G.scores[1 - p];
    return '<div class="sb' + (lead ? ' lead' : '') + (G.turn === p && G.phase !== 'ended' ? ' act' : '') + '">' +
      '<span class="dot"></span><span class="nm">' + esc(youLabel(p)) + '</span>' +
      '<span class="pts">' + G.scores[p] + '</span></div>';
  }
  box.innerHTML = side(me) + '<span class="sbsep">vs</span>' + side(them) +
    '<span class="target-chip">' + (G.target ? 'to ' + G.target : 'one hand') + '</span>';
}

function renderOpp(dealing) {
  const them = 1 - viewer;
  const initial = (nameOf(them) || '?').trim().charAt(0).toUpperCase() || '?';
  $('#oppSeat').innerHTML =
    '<span class="av">' + esc(initial) + '</span>' +
    '<span><b>' + esc(youLabel(them)) + '</b> · ' + G.hands[them].length + ' cards</span>';
  const box = $('#oppHand');
  box.innerHTML = '';
  box.className = 'opphand' + (dealing ? ' dealing' : '');
  for (let i = 0; i < G.hands[them].length; i++) {
    const n = backNode('mini');
    n.style.setProperty('--i', i);
    box.appendChild(n);
  }
  if (dealing) setTimeout(function () { box.classList.remove('dealing'); }, 900);
  renderOppInfo(them);
}

/* Tells you where the opponent's last card came from, and keeps a running
   list of the cards you have watched them take off the pile. */
function renderOppInfo(them) {
  const box = $('#oppInfo');
  let html = '';
  if (botIntent && G.turn === them) {
    // said before it happens, while the pile itself is glowing
    html = botIntent.src === 'discard'
      ? '<span class="drawpill pile">Reaching for the <b>' + esc(cardShort(botIntent.card)) + '</b> on the pile…</span>'
      : botIntent.src === 'pass'
        ? '<span class="drawpill">Passing on the ' + esc(cardShort(botIntent.card)) + '…</span>'
        : '<span class="drawpill">Reaching for the deck…</span>';
  } else {
    const ld = lastDraw[them];
    if (ld) {
      html = ld.src === 'discard'
        ? '<span class="drawpill pile">Took the <b>' + esc(cardShort(ld.card)) + '</b> off the pile</span>'
        : ld.src === 'pass'
          ? '<span class="drawpill">Passed on the ' + esc(cardShort(ld.card)) + '</span>'
          : '<span class="drawpill">Drew from the deck</span>';
    }
  }
  if (html !== lastPillHTML) {
    box.innerHTML = html;
    const tag = box.querySelector('.drawpill');
    if (tag) tag.classList.add('flash');
    lastPillHTML = html;
  }
}

function renderPiles() {
  const me = viewer;
  const myTurn = G.turn === me && !isBot(me) && G.phase !== 'ended';

  /* stock */
  const sp = $('#stockPile');
  sp.innerHTML = '';
  sp.className = 'pilebox';
  if (G.stock.length) {
    for (let i = Math.min(3, G.stock.length - 1); i > 0; i--) {
      const gh = el('div', 'stackghost');
      gh.style.cssText = 'inset:' + (-i * 2) + 'px ' + (-i * 2) + 'px ' + (i * 2) + 'px ' + (i * 2) + 'px';
      sp.appendChild(gh);
    }
    sp.appendChild(backNode());
  } else {
    sp.appendChild(el('div', 'empty-pile', 'empty'));
  }
  const canStock = myTurn && G.phase === 'draw' && G.canDraw(me, 'stock');
  if (canStock) { sp.classList.add('clickable'); sp.onclick = function () { humanDraw('stock'); }; }
  else sp.onclick = null;
  if (botIntent && botIntent.src === 'stock') sp.classList.add('hot');
  $('#stockCount').textContent = G.stock.length + ' card' + (G.stock.length === 1 ? '' : 's') + ' left';

  /* discard */
  const dp = $('#discardPile');
  dp.innerHTML = '';
  dp.className = 'pilebox';
  const top = G.topDiscard();
  if (top) {
    const n = cardNode(top);
    if (top.id !== lastDiscardTop) n.classList.add('popin');  // only animate a genuinely new card
    lastDiscardTop = top.id;
    dp.appendChild(n);
  } else {
    lastDiscardTop = null;
    dp.appendChild(el('div', 'empty-pile', 'empty'));
  }
  const canTake = myTurn && G.phase === 'draw' && G.canDraw(me, 'discard');
  if (canTake) {
    dp.classList.add('clickable');
    dp.onclick = function () { humanDraw('discard'); };
  } else dp.onclick = null;
  if (botIntent && (botIntent.src === 'discard' || botIntent.src === 'pass')) dp.classList.add('hot');
  $('#discardNote').textContent = !G.discard.length ? 'nothing thrown yet' :
    (G.discard.length > 1 ? G.discard.length + ' in the pile' : '');
}

function renderHand(dealing) {
  const me = viewer;
  const hand = orderedHand(me);
  const arr = bestArrangement(G.hands[me]);
  const groupOf = {}, deadOf = {};
  arr.melds.forEach(function (m, i) { m.cards.forEach(function (c) { groupOf[c.id] = (i % 4) + 1; }); });
  arr.deadwood.forEach(function (c) { deadOf[c.id] = val(c); });

  const selectable = G.phase === 'discard' && G.turn === me && !isBot(me);
  const box = $('#myHand');
  box.innerHTML = '';
  box.className = 'hand' + (dealing ? ' dealing' : '');
  handNodes = [];

  hand.forEach(function (c, i) {
    let cls = '';
    if (groupOf[c.id]) cls += ' g' + groupOf[c.id];
    if (c.id === freshId && G.turn === me && G.phase === 'discard') cls += ' fresh';
    if (sel === c.id) cls += ' sel';
    const blocked = selectable && !G.canDiscard(me, c.id);
    if (blocked) cls += ' ghost';
    if (selectable && !blocked) cls += ' tappable';
    const n = cardNode(c, cls.trim());
    n.style.setProperty('--i', i);
    if (deadOf[c.id] !== undefined) {
      const b = el('span', 'dwv', String(deadOf[c.id]));
      n.appendChild(b);
    }
    if (blocked) n.title = 'You just took this from the pile — it has to stay this turn.';
    if (selectable && !blocked) {
      n.onclick = function () {
        if (draggedRecently()) return;      // that was a rearrange, not a tap
        const now = Date.now();
        const isDouble = (lastTapId === c.id) && (now - lastTapAt < DOUBLE_TAP_MS);
        lastTapId = c.id;
        lastTapAt = now;
        if (isDouble) {
          lastTapId = null;
          sel = c.id;
          /* A double-tap must never cost the player a legal knock, so on those
             cards it asks which they meant instead of throwing the card. */
          if (G.canKnock(me, c.id)) { render(); askKnockOrDiscard(c); }
          else humanDiscard(false);
          return;
        }
        sel = (sel === c.id) ? null : c.id;
        sfx.tap();
        render();
      };
    }
    handNodes.push(n);
  });
  layoutHand();
  wireHandDrag(box, function (ids) { commitHandOrder(viewer, ids, render); });
  if (dealing) setTimeout(function () { box.classList.remove('dealing'); }, 900);

}

/* Fan the hand so every card keeps a tappable edge. Overlap first; if the
   visible sliver of a card would drop below a comfortable thumb target,
   break the hand into two rows rather than shaving the cards to slivers. */
let handNodes = [];
const MAX_OVERLAP = 0.52;  // most of a card that may hide behind its neighbour
const MIN_SLIVER = 40;     // px of each card that must stay tappable

function layoutHand() {
  const box = $('#myHand');
  if (!box) return;
  const n = handNodes.length;
  box.innerHTML = '';
  if (!n) return;

  const rootCS = getComputedStyle(document.documentElement);
  const prefW = parseFloat(rootCS.getPropertyValue('--cw')) || 84;
  const prefH = parseFloat(rootCS.getPropertyValue('--ch')) || 120;
  const ratio = prefH / prefW;
  const avail = Math.max(160, box.clientWidth - 6);

  const availH = handHeightBudget();
  function plan(rows) {
    const per = Math.ceil(n / rows);
    const span = 1 + (per - 1) * (1 - MAX_OVERLAP);
    const byWidth = Math.floor(avail / span);
    const byHeight = Math.floor(((availH - (rows - 1) * 6) / rows) / ratio);
    const cw = Math.max(40, Math.min(prefW, byWidth, byHeight));
    const need = per > 1 ? Math.max(0, Math.ceil((per * cw - avail) / (per - 1))) : 0;
    const ov = Math.min(Math.round(cw * MAX_OVERLAP), need);
    return { rows: rows, per: per, cw: cw, ov: ov, sliver: cw - ov };
  }

  // balance how big a card is against how much of it stays tappable
  const score = function (x) { return Math.min(x.sliver, MIN_SLIVER) * x.cw; };
  let p = plan(1);
  if (n > 6) { const p2 = plan(2); if (score(p2) > score(p)) p = p2; }

  if (p.cw < prefW - 0.5) {
    box.style.setProperty('--cw', p.cw + 'px');
    box.style.setProperty('--ch', Math.round(p.cw * ratio) + 'px');
  } else {
    box.style.removeProperty('--cw');
    box.style.removeProperty('--ch');
  }
  box.style.setProperty('--ov', p.ov + 'px');

  const perRow = Math.ceil(n / p.rows);
  for (let r = 0; r < p.rows; r++) {
    const row = el('div', 'handrow');
    for (let i = r * perRow; i < Math.min(n, (r + 1) * perRow); i++) row.appendChild(handNodes[i]);
    if (row.children.length) box.appendChild(row);
  }
}
/* How much vertical room the hand may use, once the fixed furniture of the
   table has taken its share. Keeps the whole game on one screen. */
function handHeightBudget() {
  const table = document.querySelector('.table');
  if (!table || table.hidden) return 9999;
  const h = function (sel) { const e = document.querySelector(sel); return e ? e.offsetHeight : 0; };
  /* Measure the status line as it actually rendered. Assuming a height for it
     is what let a wrapped message overflow the middle and land on top of the
     hand — the one thing this budget exists to prevent. */
  const centreMin = (h('.piles') || 140) + Math.max(20, h('#tableMsg')) + 14;
  const CHROME = 34 + 48;   // hand padding, the gaps around it, and the 48px
                            // that lowers the piles (see .center)
  const budget = table.clientHeight - h('.topbar') - h('.oppzone') - h('.handmeta') - h('.actions') - centreMin - CHROME;
  return Math.max(96, budget);
}
function fitHand() { layoutHand(); }
window.addEventListener('resize', function () { requestAnimationFrame(layoutHand); });
/* A status line that wraps onto a second line is a change in the height of
   the table's furniture just as much as a resize is, and the hand has to be
   re-measured for it. Without this the extra line comes out of the hand's
   space without the hand knowing. */
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(function () { requestAnimationFrame(layoutHand); })
    .observe(document.getElementById('tableMsg'));
}

function renderActions() {
  const box = $('#actions');
  box.innerHTML = '';
  const me = viewer;
  function add(label, fn, cls) {
    const b = el('button', 'btn ' + (cls || ''), label);
    b.onclick = fn;
    box.appendChild(b);
    return b;
  }
  if (G.phase === 'ended') { add('See how the hand ended', openSummary, 'primary'); return; }
  if (G.turn !== me || isBot(me)) {
    box.appendChild(el('div', 'thinking', '<i></i><i></i><i></i>'));
    return;
  }
  const top = G.topDiscard();
  if (G.phase === 'draw') {
    add('Draw from the deck', function () { humanDraw('stock'); }, 'primary');
    if (G.canDraw(me, 'discard') && top) add('Take the ' + cardShort(top), function () { humanDraw('discard'); });
  } else if (G.phase === 'discard') {
    if (!sel) {
      box.appendChild(el('div', 'hint', 'Tap a card to pick it — or double-tap to throw it straight away'));
      return;
    }
    const c = G.hands[me].find(function (x) { return x.id === sel; });
    const dv = G.deadwoodAfter(me, sel);
    add('Discard ' + cardShort(c), function () { humanDiscard(false); }, dv <= 10 ? '' : 'primary');
    if (G.canKnock(me, sel)) {
      add(dv === 0 ? 'Go Gin!' : 'Knock with ' + dv, function () { humanDiscard(true); }, 'primary');
    }
  }
}

function renderMsg() {
  const me = viewer, them = 1 - viewer;
  const box = $('#tableMsg');
  /* One short line, and only when it says something. The explanatory second
     line was repeating what the buttons and the cards already show, and on a
     phone it wrapped to three lines and pushed into the hand below. */
  let main = '';
  if (G.phase === 'ended') {
    main = 'Hand over';
  } else if (ONLINE && G.turn !== me) {
    main = PEER_HERE ? 'Waiting for ' + youLabel(them) : youLabel(them) + ' has dropped out';
  } else if (G.turn !== me || isBot(me)) {
    if (botIntent) {
      main = botIntent.src === 'stock' ? youLabel(them) + ' is going to the deck'
        : youLabel(them) + ' wants the ' + cardShort(botIntent.card);
    } else {
      main = youLabel(them) + ' is thinking…';
    }
  } else if (G.phase === 'draw') {
    main = 'Your turn — draw a card';
  } else if (G.phase === 'discard') {
    main = G.discard.length === 0 ? 'You lead — throw one card away' : 'Throw one card away';
  }
  box.textContent = main;
}


/* ============================================================
   SCREENS + OVERLAYS
   ============================================================ */
let screenName = 'lobby';
function showScreen(name) {
  screenName = name;
  $('#screen-lobby').hidden = name !== 'lobby';
  $('#screen-table').hidden = name !== 'table';
  $('#screen-kic').hidden = name !== 'kic';
  const room = $('#screen-room');
  if (room) room.hidden = name !== 'room';
}
function closeOverlay() { $('#overlays').innerHTML = ''; }
function sheet(title, bodyHTML, footHTML, opts) {
  opts = opts || {};
  const wrap = el('div', 'scrim');
  wrap.innerHTML =
    '<div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
    '<div class="sheet-hd"><h2>' + esc(title) + '</h2>' +
    (opts.noClose ? '' : '<button class="closex" data-close aria-label="Close">✕</button>') + '</div>' +
    '<div class="sheet-bd">' + bodyHTML + '</div>' +
    (footHTML ? '<div class="sheet-ft">' + footHTML + '</div>' : '') +
    '</div>';
  if (!opts.noClose) {
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap || e.target.hasAttribute('data-close')) closeOverlay();
    });
  }
  $('#overlays').innerHTML = '';
  $('#overlays').appendChild(wrap);
  return wrap;
}

/* A double-tap on a card that could legally knock asks first, so nobody
   throws away a winning hand with a stray tap. */
function askKnockOrDiscard(c) {
  const dv = G.deadwoodAfter(viewer, c.id);
  const body = '<p class="footnote">Throwing the ' + esc(cardShort(c)) + ' leaves you holding ' +
    (dv === 0 ? '<b>no deadwood at all — that is Gin</b>.' : '<b>' + dv + ' deadwood</b>, low enough to knock.') +
    ' Knocking ends the hand and scores you the difference. Discarding plainly plays on.</p>';
  const wrap = sheet('You can knock with this', body,
    '<button class="btn" id="ckDiscard">Just discard</button>' +
    '<button class="btn primary" id="ckKnock">' + (dv === 0 ? 'Go Gin!' : 'Knock with ' + dv) + '</button>');
  wrap.querySelector('#ckDiscard').onclick = function () { closeOverlay(); humanDiscard(false); };
  wrap.querySelector('#ckKnock').onclick = function () { closeOverlay(); humanDiscard(true); };
}

/* ---------- pass-and-play hand-off ---------- */
function showHandoff(p, headline) {
  const wrap = el('div', 'handoff');
  wrap.innerHTML =
    '<div class="who">' + esc(nameOf(p)) + '</div>' +
    '<p>' + esc(headline || 'Your turn. Hand the device over before tapping — the other hand is face-down until you do.') + '</p>' +
    '<button class="btn primary big" id="hoGo">I\'m ready</button>';
  $('#overlays').innerHTML = '';
  $('#overlays').appendChild(wrap);
  wrap.querySelector('#hoGo').onclick = function () {
    viewer = p; sel = null;
    closeOverlay();
    sfx.tap();
    render();
  };
  wrap.querySelector('#hoGo').focus();
}

/* ---------- hand summary ---------- */
function meldHTML(melds, laidIds) {
  if (!melds.length) return '<div class="meldrow"><span class="mlabel">No melds</span></div>';
  return melds.map(function (m, i) {
    const cs = m.type === 'run' ? sortedRun(m) : m.cards.slice();
    const label = m.type === 'run' ? 'Run' : 'Set';
    return '<div class="meldrow"><span class="mlabel">' + label + '</span>' +
      cs.map(function (c) {
        return miniNode(c, 'b' + ((i % 4) + 1) + (laidIds && laidIds[c.id] ? ' laid' : ''));
      }).join('') + '</div>';
  }).join('');
}
function deadHTML(cards) {
  if (!cards.length) return '<div class="meldrow"><span class="mlabel">Deadwood — none</span></div>';
  return '<div class="meldrow"><span class="mlabel">Deadwood ' + handValue(cards) + '</span>' +
    cards.map(function (c) { return miniNode(c); }).join('') + '</div>';
}

function openSummary() {
  const r = G.result;
  let body = '', foot = '';
  if (r.dead) {
    body = '<div class="verdict"><div class="big">Nobody knocked</div>' +
      '<div class="why">The deck ran down to its last two cards, so this hand is a wash. No points either way.</div></div>';
  } else {
    const k = r.knocker, o = r.opponent, w = r.winner;
    const laidIds = {};
    r.laidOff.forEach(function (l) { laidIds[l.card.id] = true; });
    let head, why, math;
    if (r.reason === 'gin') {
      head = youLabel(k) + ' went Gin';
      why = 'A hand with no deadwood at all. No lay-offs allowed against Gin.';
      math = youLabel(o) + '’s deadwood ' + r.oppDeadwood + '  +  25 Gin bonus  =  ' + r.points;
    } else if (r.reason === 'knock') {
      head = youLabel(k) + ' knocked with ' + r.knockerDeadwood;
      why = r.laidOff.length
        ? youLabel(o) + ' laid off ' + r.laidOff.length + ' card' + (r.laidOff.length === 1 ? '' : 's') +
          ' (green outline), dropping from ' + r.oppDeadwoodBefore + ' to ' + r.oppDeadwood + '.'
        : 'Nothing could be laid off on the knocker’s melds.';
      math = youLabel(o) + ' ' + r.oppDeadwood + '  −  ' + youLabel(k) + ' ' + r.knockerDeadwood + '  =  ' + r.points;
    } else {
      head = youLabel(o) + ' undercut the knock';
      why = youLabel(k) + ' knocked with ' + r.knockerDeadwood + ', but ' + youLabel(o) +
        ' came in at ' + r.oppDeadwood + (r.oppDeadwood === r.knockerDeadwood ? ' — a tie goes to the defender.' : '.');
      math = youLabel(k) + ' ' + r.knockerDeadwood + '  −  ' + youLabel(o) + ' ' + r.oppDeadwood +
        '  =  ' + (r.knockerDeadwood - r.oppDeadwood) + '  +  25 undercut  =  ' + r.points;
    }
    body =
      '<div class="verdict">' +
      '<div class="big">' + esc(head) + '</div>' +
      '<div class="pts">+' + r.points + ' to ' + esc(youLabel(w)) + '</div>' +
      '<div class="why">' + esc(why) + '</div>' +
      '</div>' +
      '<div class="mathline">' + esc(math) + '</div>' +
      '<div class="reveal">' +
      '<div class="rev-side"><h4>' + esc(youLabel(k)) + ' — the knocker <span>' + r.knockerDeadwood + ' deadwood</span></h4>' +
      meldHTML(r.knockerMelds, laidIds) + deadHTML(r.knockerDead) + '</div>' +
      '<div class="rev-side"><h4>' + esc(youLabel(o)) + ' — defending <span>' + r.oppDeadwood + ' deadwood</span></h4>' +
      meldHTML(r.oppMelds, null) + deadHTML(r.oppDead) + '</div>' +
      '</div>';
  }

  /* running score + history */
  if (G.tiebreak) {
    body += '<div class="mathline">Level at ' + G.scores[0] + ' each. One more hand decides it.</div>';
  }
  body += '<div class="rev-side"><h4>Match <span>' + G.scores[0] + ' – ' + G.scores[1] + '</span></h4><div class="histlist">' +
    G.history.map(function (h, i) {
      const line = h.dead ? 'no score' : '+' + h.points + ' ' + youLabel(h.winner) +
        (h.reason === 'gin' ? ' (gin)' : h.reason === 'undercut' ? ' (undercut)' : '');
      return '<div class="histrow"><span>Hand ' + (i + 1) + '</span><span>' + esc(line) + '</span></div>';
    }).join('') + '</div></div>';

  if (G.matchOver) {
    foot = '<button class="btn primary" id="sumEnd">Final score</button>';
  } else {
    foot = '<button class="btn" id="sumQuit">Back to setup</button>' +
      '<button class="btn primary" id="sumNext">' + (G.tiebreak ? 'Deal the decider' : 'Deal the next hand') + '</button>';
  }
  const wrap = sheet(r.dead ? 'A dead hand' : 'How the hand scored', body, foot, { noClose: true });
  const nx = wrap.querySelector('#sumNext');
  if (nx) nx.onclick = function () {
    closeOverlay();
    if (ONLINE) { NET.act({ do: 'next' }); return; }
    G.nextHand(); beginHand();
  };
  const en = wrap.querySelector('#sumEnd');
  if (en) en.onclick = function () { closeOverlay(); openGameOver(); };
  const qz = wrap.querySelector('#sumQuit');
  if (qz) qz.onclick = function () { leaveTable(); };
}

/* Leaving is the same act in every mode: stop anything running, tell the
   server if there is one, and go back to the setup screen. */
function leaveTable() {
  clearTimeout(botTimer);
  if (typeof kTimer !== 'undefined') clearTimeout(kTimer);
  closeOverlay();
  if (ONLINE) {
    NET.leave();
    ONLINE = false;
    prevView = null;
    if (typeof kPrevView !== 'undefined') kPrevView = null;
    onlineTableChrome(false);
    if (typeof MEDIA !== 'undefined' && MEDIA.isRunning()) stopCall();
    showStrip('', '', 0);
  }
  G = null;
  if (typeof KG !== 'undefined') KG = null;
  showScreen('lobby');
}

function openGameOver() {
  const w = G.matchWinner;
  const head = youLabel(w) + ' takes the match';
  const body =
    '<div class="verdict"><div class="big">' + esc(head) + '</div>' +
    '<div class="pts">' + G.scores[0] + ' – ' + G.scores[1] + '</div>' +
    '<div class="why">' + esc(G.handNo) + ' hand' + (G.handNo === 1 ? '' : 's') + ' played' +
    (G.target ? ', first to ' + G.target : '') + '.</div></div>' +
    '<div class="histlist">' + G.history.map(function (h, i) {
      const line = h.dead ? 'no score' : '+' + h.points + ' ' + youLabel(h.winner);
      return '<div class="histrow"><span>Hand ' + (i + 1) + '</span><span>' + esc(line) + '</span></div>';
    }).join('') + '</div>';
  const wrap = sheet('Match over', body,
    '<button class="btn" id="goLobby">Back to setup</button><button class="btn primary" id="goAgain">Play again</button>',
    { noClose: true });
  wrap.querySelector('#goAgain').onclick = function () {
    closeOverlay();
    if (ONLINE) { NET.rematch(); return; }
    startMatch();
  };
  wrap.querySelector('#goLobby').onclick = function () { leaveTable(); };
}

/* ---------- settings ---------- */
function openSettings() {
  const body =
    '<div class="settings-grid">' +
    '<div class="field"><label>Table style</label><div class="seg" data-set="skin">' +
    '<button data-v="felt">Felt</button><button data-v="slate">Slate</button></div></div>' +
    '<div class="field"><label>Brightness</label><div class="seg" data-set="theme">' +
    '<button data-v="light">Light</button><button data-v="auto">Auto</button><button data-v="dark">Dark</button></div></div>' +
    '<div class="field"><label>Card size</label><div class="seg" data-set="size">' +
    '<button data-v="cozy">Cozy</button><button data-v="comfy">Comfortable</button><button data-v="large">Large</button></div></div>' +
    '<div class="field"><label>How fast the computer plays</label><div class="seg" data-set="pace">' +
    '<button data-v="slower">Slower</button><button data-v="deliberate">Deliberate</button><button data-v="brisk">Brisk</button></div></div>' +
    '<div class="field"><label>Sound</label><div class="seg" data-set="sound">' +
    '<button data-v="on">On</button><button data-v="off">Off</button></div></div>' +
    '<div class="legend">' +
    '<span><i style="background:var(--m1)"></i>Melds are colour-banded</span>' +
    '<span><i style="background:var(--ink-dim)"></i>Small number = deadwood value</span>' +
    '<span><i style="background:var(--accent)"></i>Ringed pile = where the computer is reaching</span>' +
    '</div>' +
    '<p class="footnote">Everything here is remembered on this device, not on the server. To play someone else, pick <b>Online</b> on the setup screen — one of you starts a game and reads the code to the other.</p>' +
    '<p class="footnote" id="verLine">Version <b id="verNum">checking…</b></p>' +
    '</div>';
  const wrap = sheet('Look & sound', body, '<button class="btn primary" data-close>Done</button>');

  /* Which version is actually running? Asked of the server rather than baked
     into the page, so a stale cached page cannot lie about being current. */
  const vn = wrap.querySelector('#verNum');
  if (vn) {
    fetch('/version', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (v) {
        if (!v) { vn.textContent = 'unknown'; return; }
        vn.textContent = v.trim();
        const built = document.documentElement.getAttribute('data-app-version');
        if (built && built !== v.trim()) {
          vn.textContent = v.trim() + ' on the server, ' + built + ' in this window';
          const line = wrap.querySelector('#verLine');
          if (line) line.innerHTML += ' — <b>close and reopen the app</b> to pick up the new one.';
        }
      })
      .catch(function () { vn.textContent = 'offline'; });
  }

  function paint() {
    wrap.querySelectorAll('.seg[data-set]').forEach(function (seg) {
      const key = seg.getAttribute('data-set');
      const cur = key === 'sound' ? (S.sound ? 'on' : 'off') : S[key];
      seg.querySelectorAll('button').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === cur));
      });
    });
  }
  wrap.querySelectorAll('.seg[data-set] button').forEach(function (b) {
    b.onclick = function () {
      const key = b.parentNode.getAttribute('data-set');
      const v = b.getAttribute('data-v');
      if (key === 'sound') S.sound = (v === 'on'); else S[key] = v;
      saveSettings(); applyChrome(); paint();
      if (key === 'sound' && S.sound) sfx.tap();
      if (G) render();
      if (KG) kRender();
    };
  });
  paint();
}

/* ---------- rules ---------- */
function ginRulesHTML() {
  return '<div class="rules">' +
    '<section>' +
    '<h3>The point of the game</h3>' +
    '<p>Get the cards in your hand into <b>melds</b> — and get rid of everything that isn’t in one. Whatever is left over is your <b>deadwood</b>, and deadwood is what costs you points.</p>' +
    '<p><b>A meld is either:</b></p>' +
    '<ul><li>a <b>set</b> — three or four of the same rank (7♠ 7♥ 7♦)</li>' +
    '<li>a <b>run</b> — three or more in sequence in the same suit (4♣ 5♣ 6♣)</li></ul>' +
    '<p>The ace plays at <b>either end</b> of a run: A-2-3 counts, and so does Q-K-A. What it will not do is wrap around — K-A-2 is nothing. However it is used, an ace is still only worth 1 point.</p>' +
    '</section>' +

    '<section><h3>What cards are worth</h3>' +
    '<table class="valtable">' +
    '<tr><td>Ace</td><td>1</td></tr>' +
    '<tr><td>2 through 10</td><td>face value</td></tr>' +
    '<tr><td>Jack, Queen, King</td><td>10 each</td></tr></table>' +
    '<p>Your deadwood number is shown above your hand at all times, and the small grey number on a card is what that card would cost you.</p>' +
    '</section>' +

    '<section><h3>A turn</h3>' +
    '<ol><li><b>Draw</b> one card — the top of the deck, or the top of the discard pile.</li>' +
    '<li><b>Throw</b> one card away, face up on the discard pile.</li></ol>' +
    '<p>One catch: if you took a card off the discard pile, you can’t throw that same card away on the same turn. The app greys it out for you.</p>' +
    '<p><b>Watch where they draw from.</b> Before the computer takes a card it rings the pile it is reaching for and holds there long enough for you to see it, and the line under its cards then says what it took — <i>Drew from the deck</i>, or <i>Took the 4♣ off the pile</i>. Taking the pile tells you what it is collecting, so it is worth a look before you throw. You can change how fast it plays under <b>Look &amp; sound</b>.</p>' +
    '<p><b>Two ways to throw a card.</b> Tap it once and the app tells you what your deadwood becomes, then offers <b>Discard</b> and — when it is legal — <b>Knock</b>. Or simply <b>double-tap</b> the card to throw it straight away. If a double-tap would throw away a legal knock, the app stops and asks which you meant.</p>' +
    '<p><b>Your hand tidies itself.</b> After every draw the cards regroup so melds sit together, and the card you just picked up is the one with the gold ring. Prefer to sort it yourself? Tap <b>Rank</b> or <b>Suit</b> above your hand and it will keep that order instead.</p>' +
    '<p><b>Or arrange it by hand.</b> Drag any card sideways to move it, and the hand stays exactly as you leave it — the setting above switches to <b>Mine</b> on its own the first time you do. New cards join the right-hand end, and each new deal starts tidied into melds for you to adjust from. A short tap still picks a card up to throw; only a proper drag moves it.</p>' +
    '<p><b>The deal.</b> Whoever leads is dealt <b>eleven</b> cards and everyone else ten. The lead opens the hand by throwing one card away — no card is turned up, and there is nothing to pass on. After that every turn is draw-then-throw as above. The deal alternates, so the lead changes each hand.</p>' +
    '</section>' +

    '<section><h3>Knocking</h3>' +
    '<p>The moment your deadwood is <b>10 or less</b>, you may end the hand: instead of a plain discard, you <b>knock</b>. The Knock button appears on its own whenever it is legal.</p>' +
    '<p><b>Gin</b> is a knock with zero deadwood — every card melded. It pays a 25-point bonus.</p>' +
    '</section>' +

    '<section><h3>Lay-offs</h3>' +
    '<p>After a knock (but never after Gin), the defender may push their own leftover cards onto the knocker’s melds — an 8♥ onto a 9♥-10♥-J♥ run, a fourth 7 onto three 7s. That shrinks the defender’s deadwood, which is exactly what they want.</p>' +
    '<p>The app finds every legal lay-off for you and shows them outlined in green on the scoring screen.</p>' +
    '</section>' +

    '<section><h3>Scoring the hand</h3>' +
    '<ul>' +
    '<li><b>Knocker wins</b> when the defender’s deadwood is higher: the knocker scores the difference.</li>' +
    '<li><b>Gin</b> scores the defender’s deadwood plus <b>25</b>.</li>' +
    '<li><b>Undercut</b> — if the defender ends up equal or lower, they score the difference plus <b>25</b> instead. A tie goes to the defender, so knocking with 10 late in a hand is a real gamble.</li>' +
    '</ul>' +
    '<p>If the deck runs down to its last two cards without a knock, the hand is dead and nobody scores.</p>' +
    '</section>' +

    '<section><h3>Winning the match</h3>' +
    '<p>Scores carry over from hand to hand. First past the target you chose — 100 by default — takes the match. Or pick One hand in the lobby to settle it in a single deal.</p>' +
    '<p>If you both land on the <i>same</i> total, the match does not stop there — you play a decider until one of you is clear.</p>' +
    '</section>' +
    '</div>';
}

function openRules(which) {
  const g = which || (KG ? 'kic' : (G ? 'gin' : S.game));
  const body =
    '<div class="seg" id="rulesSeg">' +
    '<button data-v="gin" aria-pressed="' + (g === 'gin') + '">Gin Rummy</button>' +
    '<button data-v="kic" aria-pressed="' + (g === 'kic') + '">Kings in the Corner</button>' +
    '</div>' + (g === 'kic' ? kRulesHTML() : ginRulesHTML());
  const wrap = sheet('How to play', body, '<button class="btn primary" data-close>Got it</button>');
  wrap.querySelectorAll('#rulesSeg button').forEach(function (b) {
    b.onclick = function () { openRules(b.getAttribute('data-v')); };
  });
}

/* ============================================================
   LOBBY WIRING
   ============================================================ */
const TARGETS = { gin: [0, 100, 150, 200], kic: [0, 50, 100, 150] };
function paintLobby() {
  function seg(id, cur) {
    document.querySelectorAll('#' + id + ' button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === String(cur)));
    });
  }
  const kic = S.game === 'kic';
  $('#pickGin').setAttribute('aria-pressed', String(!kic));
  $('#pickKings').setAttribute('aria-pressed', String(kic));

  const list = TARGETS[S.game];
  if (list.indexOf(S.target) < 0) S.target = 100;
  const seg2 = $('#targetSeg');
  seg2.innerHTML = list.map(function (v) {
    const label = v === 0 ? (kic ? 'One round' : 'One hand') : 'To ' + v;
    return '<button data-v="' + v + '">' + label + '</button>';
  }).join('');
  seg2.querySelectorAll('button').forEach(function (b) {
    b.onclick = function () { S.target = parseInt(b.getAttribute('data-v'), 10); saveSettings(); paintLobby(); sfx.tap(); };
  });
  $('#lenLabel').textContent = kic ? 'Play until someone reaches' : 'Match length';
  $('#startBtn').textContent = kic ? 'Deal the first round' : 'Deal the first hand';
  $('#lenNote').hidden = !kic;

  seg('modeSeg', S.mode);
  seg('diffSeg', S.diff);
  seg('targetSeg', S.target);
  $('#diffField').hidden = S.mode !== 'ai';
  $('#n0').value = S.names[0] === 'You' ? '' : S.names[0];
  $('#n1').value = (S.names[1] === 'Opponent' || S.names[1] === 'Computer') ? '' : S.names[1];
  $('#n0').placeholder = S.mode === 'pnp' ? 'Player one' : (S.mode === 'online' ? 'Your name' : 'You');
  $('#n1').placeholder = S.mode === 'pnp' ? 'Player two'
    : (S.mode === 'online' ? 'They type their own' : 'Computer');
  if (typeof paintOnlineLobby === 'function') paintOnlineLobby();
}
document.querySelectorAll('#modeSeg button').forEach(function (b) {
  b.onclick = function () { S.mode = b.getAttribute('data-v'); saveSettings(); paintLobby(); sfx.tap(); };
});
document.querySelectorAll('#diffSeg button').forEach(function (b) {
  b.onclick = function () { S.diff = b.getAttribute('data-v'); saveSettings(); paintLobby(); sfx.tap(); };
});
$('#startBtn').onclick = function () {
  const a = $('#n0').value.trim(), b = $('#n1').value.trim();
  S.names = [a || (S.mode === 'pnp' ? 'Player one' : 'You'), b || (S.mode === 'pnp' ? 'Player two' : 'Computer')];
  saveSettings();
  ac();
  if (S.game === 'kic') kStartMatch(); else startMatch();
};
$('#lobbyRules').onclick = openRules;
$('#lobbySettings').onclick = openSettings;
$('#btnRules').onclick = openRules;
$('#btnSettings').onclick = openSettings;
$('#btnBack').onclick = function () {
  if (!G || G.matchOver || (G.handNo === 1 && G.history.length === 0 && G.stock.length > 28)) {
    leaveTable(); return;
  }
  const note = ONLINE
    ? '<p class="footnote">This ends the game for both of you, and the code stops working.</p>'
    : '<p class="footnote">The score so far will be lost. Nothing is saved between matches yet.</p>';
  const wrap = sheet('Leave this match?', note,
    '<button class="btn" data-close>Keep playing</button><button class="btn primary" id="qYes">Leave</button>');
  wrap.querySelector('#qYes').onclick = function () { leaveTable(); };
};
function paintSorts() {
  [['#sortAuto', 'auto'], ['#sortRank', 'rank'], ['#sortSuit', 'suit'], ['#sortManual', 'manual']].forEach(function (pair) {
    const b = $(pair[0]);
    if (b) b.setAttribute('aria-pressed', String(S.sortMode === pair[1]));
  });
  const k = $('#kSortManual');
  if (k) k.setAttribute('aria-pressed', String(S.sortMode === 'manual'));
  for (const id of ['#kSortRank', '#kSortSuit']) {
    const b = $(id);
    if (b) b.setAttribute('aria-pressed', String(S.sortMode === (id === '#kSortRank' ? 'rank' : 'suit')));
  }
}
[['#sortAuto', 'auto'], ['#sortRank', 'rank'], ['#sortSuit', 'suit'], ['#sortManual', 'manual']].forEach(function (pair) {
  const b = $(pair[0]);
  if (!b) return;
  b.onclick = function () {
    /* Switching TO manual keeps whatever is on screen — otherwise choosing it
       would shuffle the hand, which is the opposite of what it promises. */
    const keep = pair[1] === 'manual' && G ? orderedHand(viewer).map(function (c) { return c.id; }) : null;
    S.sortMode = pair[1];
    saveSettings(); paintSorts();
    if (G) {
      if (keep) order[viewer] = keep; else applySort(viewer);
      render();
    }
    if (KG) { if (pair[1] !== 'manual') kSort(kViewer); kRender(); }
    sfx.tap();
  };
});
paintSorts();
$('#pickGin').onclick = function () { S.game = 'gin'; saveSettings(); paintLobby(); sfx.tap(); };
$('#pickKings').onclick = function () { S.game = 'kic'; saveSettings(); paintLobby(); sfx.tap(); };

/* ---- Kings table chrome ---- */
$('#kRules').onclick = function () { openRules('kic'); };
$('#kSettings').onclick = openSettings;
[['#kSortRank', 'rank'], ['#kSortSuit', 'suit'], ['#kSortManual', 'manual']].forEach(function (pair) {
  const b = $(pair[0]);
  if (!b) return;
  b.onclick = function () {
    const keep = pair[1] === 'manual' && KG ? kOrdered(kViewer).map(function (c) { return c.id; }) : null;
    S.sortMode = pair[1];
    saveSettings(); paintSorts();
    if (KG) {
      if (keep) kOrder[kViewer] = keep; else kSort(kViewer);
      kRender();
    }
    if (G) { if (pair[1] !== 'manual') applySort(viewer); render(); }
    sfx.tap();
  };
});
$('#kBack').onclick = function () {
  if (!KG || KG.matchOver || (KG.roundNo === 1 && KG.history.length === 0 && KG.stock.length > 36)) {
    KG = null; leaveTable(); return;
  }
  const note = ONLINE
    ? '<p class="footnote">This ends the game for both of you, and the code stops working.</p>'
    : '<p class="footnote">The score so far will be lost. Nothing is saved between matches yet.</p>';
  const wrap = sheet('Leave this match?', note,
    '<button class="btn" data-close>Keep playing</button><button class="btn primary" id="kqYes">Leave</button>');
  wrap.querySelector('#kqYes').onclick = function () { KG = null; leaveTable(); };
};

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    const s = document.querySelector('.scrim');
    if (s && !s.querySelector('[data-close]')) return;
    if (s) closeOverlay();
  }
});

paintLobby();

/* small read-only hook, handy when checking behaviour from the console */
window.kicState = function () {
  if (!KG) return null;
  return {
    phase: KG.phase, turn: KG.turn, viewer: kViewer, scores: KG.scores.slice(),
    stock: KG.stock.length, hand: KG.hands[kViewer].length, over: KG.matchOver,
    selCard: kSelCard, selPile: kSelPile,
    canUndo: KG.canUndo(kViewer), plays: KG.playsThisTurn,
    piles: KG.piles.map(function (p) { return p.length; }),
    tops: KG.piles.map(function (p) { return p.length ? p[p.length - 1].id : null; }),
    bottoms: KG.piles.map(function (p) { return p.length ? p[0].id : null; }),
    legal: (KG.phase === 'play' && KG.turn === kViewer && kSelCard)
      ? KG.legalSlotsFor(kViewer, kSelCard) : []
  };
};
window.ginState = function () {
  if (!G) return null;
  const knockable = (G.phase === 'discard' && G.turn === viewer && !isBot(viewer))
    ? G.hands[viewer].filter(function (c) { return G.canKnock(viewer, c.id); }).map(function (c) { return c.id; })
    : [];
  return {
    phase: G.phase, turn: G.turn, viewer: viewer, selected: sel,
    scores: G.scores.slice(), stock: G.stock.length, discard: G.discard.length,
    over: G.matchOver, knockable: knockable
  };
};
