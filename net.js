'use strict';
/* ============================================================
   The connection to the table.

   One socket carries everything: moves, chat, and the introductions
   that let the two browsers open a video call directly to each other.
   It reconnects on its own, because phones sleep and wifi drops, and
   losing the connection should never mean losing the hand.
   ============================================================ */
const NET = (function () {
  const SEAT_KEY = 'ginco.seat.v1';
  let sock = null;
  let wantOpen = false;
  let backoff = 400;
  let retryTimer = null;
  let sentHello = null;          // what to say once the socket opens
  let sawRoom = false;

  const on = {
    room: [], state: [], error: [], chat: [], signal: [], peer: [],
    status: [], kicked: []
  };
  function emit(evt, arg) {
    for (const fn of on[evt] || []) { try { fn(arg); } catch (e) { console.error(e); } }
  }
  function listen(evt, fn) { (on[evt] = on[evt] || []).push(fn); return api; }

  function url() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host;
  }

  function setStatus(s, detail) { emit('status', { state: s, detail: detail || '' }); }

  function open() {
    if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;
    wantOpen = true;
    setStatus(sawRoom ? 'reconnecting' : 'connecting');
    let s;
    try { s = new WebSocket(url()); } catch (e) { return retry(); }
    sock = s;

    s.onopen = function () {
      backoff = 400;
      setStatus('open');
      if (sentHello) send(sentHello);
    };
    s.onmessage = function (ev) {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'room') {
        sawRoom = true;
        if (m.seat) { api.seat = m.seat; store(m.seat); sentHello = { t: 'resume', seat: m.seat }; }
        api.you = m.you;
        api.info = m.info;
        emit('room', m);
      } else if (m.t === 'state') { emit('state', m.v); }
      else if (m.t === 'error') { emit('error', m); }
      else if (m.t === 'chat') { emit('chat', m); }
      else if (m.t === 'signal') { emit('signal', m); }
      else if (m.t === 'peer') { emit('peer', m); }
      else if (m.t === 'kicked') {
        // another window took the seat; do not fight it by reconnecting
        wantOpen = false; sentHello = null; clearSeat();
        emit('kicked', m);
      }
    };
    s.onclose = function () { if (wantOpen) retry(); else setStatus('closed'); };
    s.onerror = function () { /* onclose always follows; handle it there */ };
  }

  function retry() {
    setStatus('reconnecting');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, backoff);
    backoff = Math.min(backoff * 1.7, 8000);
  }

  function send(o) {
    if (sock && sock.readyState === 1) { sock.send(JSON.stringify(o)); return true; }
    return false;
  }

  function store(t) { try { localStorage.setItem(SEAT_KEY, t); } catch (e) {} }
  function savedSeat() { try { return localStorage.getItem(SEAT_KEY) || null; } catch (e) { return null; } }
  function clearSeat() { try { localStorage.removeItem(SEAT_KEY); } catch (e) {} }

  const api = {
    seat: null, you: 0, info: null,

    on: listen,

    create: function (game, target, name) {
      sentHello = { t: 'create', game: game, target: target, name: name };
      sawRoom = false;
      open(); send(sentHello);
    },
    join: function (code, name) {
      sentHello = { t: 'join', code: code, name: name };
      sawRoom = false;
      open(); send(sentHello);
    },
    resume: function (seat) {
      sentHello = { t: 'resume', seat: seat || savedSeat() };
      if (!sentHello.seat) return false;
      sawRoom = false;
      open(); send(sentHello);
      return true;
    },
    act: function (a) { a.t = 'action'; return send(a); },
    chat: function (text) { return send({ t: 'chat', text: text }); },
    signal: function (data) { return send({ t: 'signal', data: data }); },
    rematch: function () { return send({ t: 'rematch' }); },
    leave: function () {
      send({ t: 'leave' });
      wantOpen = false; sentHello = null; clearSeat();
      api.seat = null; api.info = null; sawRoom = false;
      clearTimeout(retryTimer);
      if (sock) { try { sock.close(); } catch (e) {} }
      sock = null;
    },
    savedSeat: savedSeat,
    clearSeat: clearSeat,
    isOpen: function () { return !!sock && sock.readyState === 1; }
  };
  return api;
})();
