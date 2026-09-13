'use strict';
/* ============================================================
   Online play: the lobby controls, the waiting room, the video
   window and the chat. This file owns everything that only exists
   when there is a real person on the other end; the two table
   screens stay the same code they always were.
   ============================================================ */

let ONLINE = false;          // are we in a served game right now
let MYSEAT = 0;
let ROOM = null;
let PEER_HERE = false;
let LAST_KIND = 'gin';
let chatOpen = false, unread = 0;
let strip = null, stripTimer = null;

/* ---------- the strip that reports the connection ---------- */
function showStrip(text, cls, ms) {
  const s = $('#linkStrip');
  if (!s) return;
  /* While the offer is up it owns that strip of screen. Passing notices are
     dropped rather than stacked; anything permanent still gets through. */
  const offering = !$('#callOffer').hidden;
  if (offering && ms) return;
  clearTimeout(stripTimer);
  if (!text) { s.hidden = true; return; }
  s.textContent = text;
  s.className = 'linkstrip' + (cls ? ' ' + cls : '');
  s.hidden = false;
  if (ms) stripTimer = setTimeout(function () { s.hidden = true; }, ms);
}

/* ---------- lobby ---------- */
function paintOnlineLobby() {
  const online = S.mode === 'online';
  const f = $('#onlineField');
  if (f) f.hidden = !online;
  const d = $('#diffField');
  if (d) d.hidden = online || S.mode !== 'ai';
  // the second name box belongs to the other person when they are real
  const n1 = $('#n1');
  if (n1) n1.disabled = online;
  const start = $('#startBtn');
  if (start) start.hidden = online;
}

function joinCodeFromURL() {
  try {
    const u = new URL(location.href);
    const c = (u.searchParams.get('join') || u.searchParams.get('code') || '').toUpperCase().trim();
    return /^[A-Z0-9]{5}$/.test(c) ? c : null;
  } catch (e) { return null; }
}

function wireOnlineLobby() {
  const host = $('#hostBtn'), join = $('#joinBtn'), codeIn = $('#joinCode');

  if (host) host.onclick = function () {
    ONLINE = true;
    LAST_KIND = S.game;
    NET.create(S.game, S.target, ($('#n0').value || 'Player').trim());
    showRoomScreen(null);
  };

  function doJoin() {
    const c = (codeIn.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
    if (c.length !== 5) { $('#onlineHint').textContent = 'A code is five characters. Check it and try again.'; return; }
    ONLINE = true;
    NET.join(c, ($('#n0').value || 'Player').trim());
    $('#onlineHint').textContent = 'Joining…';
  }
  if (join) join.onclick = doJoin;
  if (codeIn) {
    codeIn.addEventListener('input', function () {
      const v = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (v !== codeIn.value) codeIn.value = v;
    });
    codeIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doJoin(); } });
  }

  const pre = joinCodeFromURL();
  if (pre && codeIn) {
    S.mode = 'online'; saveSettings();
    codeIn.value = pre;
    $('#onlineHint').textContent = 'Put your name in above, then press Join.';
  }
}

/* ---------- waiting room ---------- */
function showRoomScreen(code) {
  showScreen('room');
  $('#roomCode').textContent = code || '·····';
  const wait = $('#roomWait');
  if (wait) wait.hidden = false;
}

function inviteLink(code) {
  return location.origin + location.pathname + '?join=' + code;
}

async function copyText(text, btn, done) {
  let okCopy = false;
  try { await navigator.clipboard.writeText(text); okCopy = true; }
  catch (e) {
    // clipboard access is refused in plenty of places; select it instead
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-999px';
      document.body.appendChild(ta); ta.select();
      okCopy = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e2) { okCopy = false; }
  }
  if (btn) {
    const was = btn.textContent;
    btn.textContent = okCopy ? (done || 'Copied') : 'Copy failed — select it by hand';
    setTimeout(function () { btn.textContent = was; }, 1800);
  }
}

function wireRoomScreen() {
  $('#copyCode').onclick = function () { copyText($('#roomCode').textContent.trim(), this, 'Code copied'); };
  $('#copyLink').onclick = function () { copyText(inviteLink($('#roomCode').textContent.trim()), this, 'Link copied'); };
  $('#roomCancel').onclick = function () {
    NET.leave();
    ONLINE = false; ROOM = null; PEER_HERE = false;
    showScreen('lobby');
  };
}

/* ---------- chat ---------- */
function addChatLine(line) {
  const log = $('#chatLog');
  if (!log) return;
  const d = el('div', 'chatline' + (line.sys ? ' sys' : (line.from === MYSEAT ? ' mine' : '')));
  if (line.sys) d.textContent = line.text;
  else d.innerHTML = '<span class="who">' + esc(line.name || '') + '</span>' + esc(line.text);
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 120) log.removeChild(log.firstChild);
}
function sysLine(text) { addChatLine({ sys: true, text: text }); }

function setChat(open) {
  chatOpen = open;
  $('#chatDock').hidden = !open;
  if (open) {
    unread = 0;
    markChatDot();
    const i = $('#chatInput');
    if (i) setTimeout(function () { i.focus(); }, 30);
  }
}
function markChatDot() {
  for (const id of ['#chatDot', '#kChatDot']) {
    const d = $(id);
    if (d) d.hidden = unread === 0;
  }
}

function wireChat() {
  $('#chatClose').onclick = function () { setChat(false); };
  $('#chatForm').onsubmit = function (e) {
    e.preventDefault();
    const i = $('#chatInput');
    const t = i.value.trim();
    if (!t) return;
    NET.chat(t);
    i.value = '';
  };
  for (const id of ['#btnChat', '#kChat']) {
    const b = $(id);
    if (b) b.onclick = function () { setChat(!chatOpen); };
  }
}

/* ---------- the floating video window ---------- */
const CALL = { on: false, placed: false, offered: false, receiving: false };

/* ---------- the offer to switch the camera on ----------
   Video used to be reachable only through an unlabelled button, which is the
   same as not shipping it. It now announces itself once, when there is
   actually somebody on the other end to see. */
function showCallOffer(text, yesLabel) {
  const box = $('#callOffer');
  if (!box) return;
  $('#callOfferText').textContent = text;
  $('#callOfferYes').textContent = yesLabel || 'Turn on my camera';
  box.hidden = false;
  const app = $('#app');
  if (app) app.classList.add('offering');
}
function hideCallOffer() {
  const box = $('#callOffer');
  if (box) box.hidden = true;
  const app = $('#app');
  if (app) app.classList.remove('offering');
}
function maybeOfferCall() {
  if (!ONLINE || CALL.on || CALL.offered) return;
  if (!PEER_HERE) return;
  if (!MEDIA.supported() || !MEDIA.secureEnough()) return;
  CALL.offered = true;
  showCallOffer(nameOf(1 - MYSEAT) + ' is here. See and hear each other?');
}

function setCallNote(text) {
  const n = $('#callNote');
  if (!n) return;
  n.textContent = text || '';
  n.hidden = !text;
}

function showCallDock(show) {
  const d = $('#callDock');
  if (!d) return;
  const who = $('#callWho');
  if (who && ONLINE) who.textContent = nameOf(1 - MYSEAT) || 'Opponent';
  d.hidden = !show;
  if (show && !CALL.placed) {
    // park it top-right, clear of the score bar
    const w = d.offsetWidth || 176;
    d.style.left = Math.max(8, window.innerWidth - w - 12) + 'px';
    d.style.top = '64px';
    CALL.placed = true;
  }
}

function markCallRunning(on) {
  for (const id of ['#callDot', '#kCallDot']) {
    const d = $(id);
    if (d) d.hidden = !on;
  }
}

function refreshCallButtons() {
  const mic = $('#micBtn'), cam = $('#camBtn');
  if (mic) {
    const off = MEDIA.has('audio') && !MEDIA.enabled('audio');
    mic.setAttribute('aria-pressed', off ? 'true' : 'false');
    mic.textContent = off ? 'Muted' : 'Mic';
    mic.disabled = !MEDIA.has('audio');
  }
  if (cam) {
    const off = MEDIA.has('video') && !MEDIA.enabled('video');
    cam.setAttribute('aria-pressed', off ? 'true' : 'false');
    cam.textContent = MEDIA.has('video') ? (off ? 'Cam off' : 'Cam') : 'No cam';
    cam.disabled = !MEDIA.has('video');
  }
  const join = $('#joinCallBtn');
  const noCamera = CALL.receiving && !MEDIA.hasLocal();
  if (join) join.hidden = !noCamera;
  // muting a microphone you are not sending is meaningless, so those go away
  if (mic) mic.hidden = noCamera;
  if (cam) cam.hidden = noCamera;
  markCallRunning(CALL.on || CALL.receiving);
}

async function startCall() {
  hideCallOffer();
  if (CALL.on && MEDIA.hasLocal()) { showCallDock(true); return; }
  if (!MEDIA.supported()) { showStrip('This browser cannot do video calls.', 'bad', 5000); return; }
  if (!MEDIA.secureEnough()) {
    showStrip('Video needs a secure (https) address — it will work once the game is on its real web address.', 'bad', 7000);
    return;
  }
  CALL.on = true;
  showCallDock(true);
  setCallNote('Asking for your camera…');
  try {
    /* Seat 0 is the polite one: if both sides open the call at the same
       instant, one has to give way or neither connection completes. */
    await MEDIA.start({ video: true, audio: true });
    setCallNote(MEDIA.isConnected() ? '' : 'Connecting…');
  } catch (e) {
    CALL.on = false;
    setCallNote('');
    showCallDock(false);
    showStrip(e.message, 'bad', 7000);
  }
  refreshCallButtons();
}

function stopCall() {
  MEDIA.stop(false);
  CALL.on = false; CALL.receiving = false;
  hideCallOffer();
  showCallDock(false);
  refreshCallButtons();
}

/* Autoplay with sound is blocked unless the page has been interacted with.
   Rather than leave a silent picture, say so and let a tap fix it. */
function nudgePlay(video) {
  if (!video) return;
  const p = video.play();
  if (p && p.catch) {
    p.catch(function () {
      setCallNote('Tap here to hear ' + nameOf(1 - MYSEAT));
      const note = $('#callNote');
      if (note) note.onclick = function () {
        video.play().then(function () { setCallNote(''); note.onclick = null; }).catch(function () {});
      };
    });
  }
}

function wireCall() {
  for (const id of ['#btnCall', '#kCall']) {
    const b = $(id);
    if (b) b.onclick = function () {
      if (CALL.on || CALL.receiving) showCallDock($('#callDock').hidden);
      else startCall();
    };
  }
  $('#callOfferYes').onclick = function () { startCall(); };
  $('#callOfferNo').onclick = function () { hideCallOffer(); };
  $('#joinCallBtn').onclick = function () { startCall(); };
  $('#hangBtn').onclick = stopCall;
  $('#micBtn').onclick = function () { MEDIA.setTrack('audio', !MEDIA.enabled('audio')); refreshCallButtons(); };
  $('#camBtn').onclick = function () { MEDIA.setTrack('video', !MEDIA.enabled('video')); refreshCallButtons(); };
  $('#callMin').onclick = function () {
    const d = $('#callDock');
    d.classList.toggle('min');
    $('#callMin').textContent = d.classList.contains('min') ? '+' : '–';
  };

  /* dragging, by pointer so a finger and a mouse behave identically */
  const dock = $('#callDock'), grip = $('#callGrip');
  let dx = 0, dy = 0, dragging = false;
  grip.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.callmin')) return;
    dragging = true;
    dock.classList.add('dragging');
    const r = dock.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    const w = dock.offsetWidth, h = dock.offsetHeight;
    // keep a grabbable sliver on screen however hard it is flung
    const x = Math.min(Math.max(e.clientX - dx, 6 - w + 46), window.innerWidth - 46);
    const y = Math.min(Math.max(e.clientY - dy, 4), window.innerHeight - 34);
    dock.style.left = x + 'px'; dock.style.top = y + 'px';
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    dock.classList.remove('dragging');
    try { grip.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  MEDIA.on('local', function (stream) {
    const v = $('#localVid');
    if (v) {
      v.srcObject = stream || null;
      // an empty preview is just a grey hole; show it only once it has a picture
      v.classList.toggle('on', !!(stream && stream.getVideoTracks().length));
    }
    refreshCallButtons();
  });
  MEDIA.on('stream', function (stream) {
    const v = $('#remoteVid');
    if (v) v.srcObject = stream || null;
    if (stream) {
      /* This fires whether or not we ever pressed the button — their offer is
         answered automatically. Before, the picture arrived and was thrown
         away behind a hidden panel. Now it goes on screen. */
      CALL.receiving = true;
      hideCallOffer();
      showCallDock(true);
      setCallNote('');
      nudgePlay(v);
      if (!MEDIA.hasLocal()) {
        $('#callWho').textContent = nameOf(1 - MYSEAT);
        sysLine(nameOf(1 - MYSEAT) + ' turned their camera on.');
      }
    } else {
      CALL.receiving = false;
    }
    refreshCallButtons();
  });
  MEDIA.on('state', function (s) {
    if (s.state === 'connecting') setCallNote('Connecting…');
    else if (s.state === 'live') setCallNote('');
    else if (s.state === 'failed') { setCallNote(s.detail); showStrip(s.detail, 'bad', 8000); }
    else if (s.state === 'dropped') setCallNote('Reconnecting…');
    else if (s.state === 'audio-only') { setCallNote(s.detail); showStrip(s.detail, '', 5000); }
    else if (s.state === 'receiving') setCallNote('');
    else if (s.state === 'ended') {
      CALL.on = false; CALL.receiving = false;
      showCallDock(false); hideCallOffer();
      sysLine('The video call ended.');
    }
    refreshCallButtons();
  });
}

/* ---------- reacting to the server ---------- */
function onlineTableChrome(on) {
  for (const id of ['#btnCall', '#btnChat', '#kCall', '#kChat']) {
    const b = $(id);
    if (b) b.hidden = !on;
  }
  const app = $('#app');
  if (app) app.classList.toggle('online', !!on);
  if (!on) { setChat(false); showCallDock(false); hideCallOffer(); CALL.offered = false; }
}

function wireNet() {
  NET.on('room', function (m) {
    ROOM = m.info;
    MYSEAT = m.you;
    const both = m.info.names[0] && m.info.names[1];
    if (!both) {
      showRoomScreen(m.info.code);
      return;
    }
    PEER_HERE = m.info.connected[1 - MYSEAT];
  });

  NET.on('state', function (v) {
    MYSEAT = v.you;
    onlineTableChrome(true);
    LAST_KIND = v.kind;
    MEDIA.setPolite(MYSEAT === 0);
    if (v.kind === 'kic') kApplyServerState(v);
    else applyServerState(v);
    if (v.names && v.names[0] && v.names[1]) { PEER_HERE = true; maybeOfferCall(); }
  });

  NET.on('error', function (m) {
    if (m.code === 'no_room' || m.code === 'full' || m.code === 'no_seat') {
      ONLINE = false;
      NET.clearSeat();
      showScreen('lobby');
      const h = $('#onlineHint');
      if (h) h.textContent = m.msg;
      showStrip(m.msg, 'bad', 6000);
      return;
    }
    // an illegal move is nearly always the table and the server disagreeing
    showStrip(m.msg, 'bad', 3500);
  });

  NET.on('chat', function (m) {
    addChatLine(m);
    if (!chatOpen && m.from !== MYSEAT) { unread++; markChatDot(); sfx.tap(); }
  });

  NET.on('signal', function (m) { MEDIA.handleSignal(m.data); });

  NET.on('peer', function (m) {
    if (m.joined) {
      sysLine(m.name + ' joined.');
      showStrip(m.name + ' is here. Dealing.', 'good', 2600);
      PEER_HERE = true;
      maybeOfferCall();
    } else if (m.gone) {
      PEER_HERE = false;
      sysLine(m.name + ' dropped out.');
      showStrip(m.name + ' lost their connection. Their seat is held for two minutes.', '', 0);
    } else if (m.back) {
      PEER_HERE = true;
      sysLine(m.name + ' is back.');
      showStrip(m.name + ' is back.', 'good', 2600);
    } else if (m.left) {
      PEER_HERE = false;
      hideCallOffer();
      sysLine(m.name + ' left the game.');
      showStrip(m.name + ' left the game.', 'bad', 0);
    }
  });

  NET.on('status', function (s) {
    if (!ONLINE) return;
    if (s.state === 'open') {
      if (PEER_HERE || !ROOM) showStrip('', '', 0);
    } else if (s.state === 'connecting') showStrip('Connecting…', '', 0);
    else if (s.state === 'reconnecting') showStrip('Connection lost — trying to get back in…', 'bad', 0);
  });

  NET.on('kicked', function (m) {
    ONLINE = false;
    onlineTableChrome(false);
    showScreen('lobby');
    showStrip(m.why, 'bad', 8000);
  });
}

/* ---------- boot ---------- */
function initOnline() {
  wireOnlineLobby();
  wireRoomScreen();
  wireChat();
  wireCall();
  wireNet();
  paintOnlineLobby();

  /* A refresh mid-hand should drop you back at the table, not the lobby. */
  if (NET.savedSeat() && !joinCodeFromURL()) {
    ONLINE = true;
    NET.resume();
  }
}
