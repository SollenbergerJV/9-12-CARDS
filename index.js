'use strict';
/* ============================================================
   Gin & Corners — the server.

   Two jobs, and deliberately no more: hand out the web app, and sit
   between two players as the referee. Video and voice do not pass
   through here; the server only introduces the two browsers to each
   other and then gets out of the way, so picture quality does not
   depend on this machine and a bigger host buys nothing.
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const ws = require('./ws.js');
const R = require('./rooms.js');

/* Bumped whenever the app changes. It is shown in Look & sound and served at
   /version, so there is a way to answer "did my update actually go live?"
   without guessing from behaviour. */
const VERSION = '1.4.0';

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, '..');

/* ---------- where the files actually are ----------
   Uploading through a browser file-picker flattens folders: every file lands
   in one pile with no directories at all. That is a perfectly ordinary thing
   for a person to end up with, and refusing to run is a poor answer to it.
   So the layout is detected rather than assumed. */
const FLAT = !fs.existsSync(path.join(ROOT, 'public', 'index.html'));
const PUBLIC = FLAT ? __dirname : path.join(ROOT, 'public');
const SHARED = FLAT ? __dirname : path.join(ROOT, 'shared');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/* ---------- static files ---------- */
function serve(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { return end(res, 400, 'bad request'); }
  let p = decodeURIComponent(url.pathname);

  if (p === '/healthz') return end(res, 200, 'ok');
  if (p === '/version') return end(res, 200, VERSION);
  if (p === '/ice.json') return iceConfig(res);
  if (p === '/') p = '/index.html';

  let base = PUBLIC, rel = p;
  if (FLAT) {
    /* Everything sits together, so /shared/engine.js, /icons/icon.svg and
       /app.css all resolve to the same folder by name alone. Taking only the
       basename also disposes of any attempt to climb out of it. */
    rel = '/' + path.basename(p);
  } else if (p.startsWith('/shared/')) {
    base = SHARED; rel = p.slice('/shared'.length);
  }

  // resolve, then confirm the result is still inside the folder we meant
  const file = path.normalize(path.join(base, rel));
  if (file !== base && !file.startsWith(base + path.sep)) return end(res, 403, 'forbidden');

  fs.stat(file, function (serr, st) {
    if (serr || !st.isFile()) {
      /* An installed app can be launched at a deep link; hand it the shell
         and let the page sort itself out rather than showing a 404. */
      if (!path.extname(file)) {
        return fs.readFile(path.join(PUBLIC, 'index.html'), function (e2, shell) {
          if (e2) return end(res, 404, 'not found');
          res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
          res.end(shell);
        });
      }
      return end(res, 404, 'not found');
    }

    const ext = path.extname(file).toLowerCase();
    const tag = '"' + st.size.toString(16) + '-' + st.mtimeMs.toString(16) + '"';

    /* Everything that makes up the app is revalidated on every visit. The
       previous version let the browser hold the code for an hour, which meant
       a deploy could go out and a player still be running yesterday's app with
       no way to tell — the worst kind of wrong, because nothing looks broken.
       An ETag keeps that cheap: unchanged files come back as an empty 304. */
    const code = ext === '.html' || ext === '.js' || ext === '.css' || ext === '.webmanifest';
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'ETag': tag,
      'Cache-Control': code ? 'no-cache' : 'public, max-age=86400'
    };

    if (req.headers['if-none-match'] === tag) {
      res.writeHead(304, headers);
      return res.end();
    }

    fs.readFile(file, function (err, buf) {
      if (err) return end(res, 404, 'not found');
      res.writeHead(200, headers);
      res.end(buf);
    });
  });
}
/* Two browsers usually find each other with STUN alone. Two that sit behind
   strict carrier NAT — a phone on mobile data is the common case — cannot,
   and need a relay in the middle. A relay is not free to run, so none is
   assumed: set TURN_URL / TURN_USER / TURN_PASS and the app will use one. */
function iceConfig(res) {
  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];
  if (process.env.TURN_URL) {
    const entry = { urls: process.env.TURN_URL.split(',').map(function (s) { return s.trim(); }).filter(Boolean) };
    if (process.env.TURN_USER) entry.username = process.env.TURN_USER;
    if (process.env.TURN_PASS) entry.credential = process.env.TURN_PASS;
    servers.push(entry);
  }
  res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({ iceServers: servers, hasRelay: !!process.env.TURN_URL }));
}

function end(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const server = http.createServer(serve);
const rooms = new R.Rooms();

/* ---------- talking to a seat ---------- */
function push(seat) {
  if (!seat || !seat.conn || !seat.conn.open) return;
  const v = R.viewFor(seat.room, seat.idx);
  if (v) seat.conn.send({ t: 'state', v: v });
}
function pushBoth(room) { for (const s of room.seats) push(s); }

function peerOf(seat) {
  return seat.room.seats[1 - seat.idx] || null;
}
function tell(seat, msg) {
  if (seat && seat.conn && seat.conn.open) seat.conn.send(msg);
}
function roomInfo(room) {
  return {
    code: room.code, game: room.game, target: room.target,
    names: [room.seats[0] ? room.seats[0].name : null, room.seats[1] ? room.seats[1].name : null],
    connected: [!!(room.seats[0] && room.seats[0].connected), !!(room.seats[1] && room.seats[1].connected)],
    started: room.started
  };
}
function announce(room) {
  for (const s of room.seats) {
    if (!s) continue;                      // the second chair is empty until someone joins
    tell(s, { t: 'room', info: roomInfo(room), you: s.idx, seat: s.token });
  }
}

function cleanName(n) {
  n = String(n === undefined || n === null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, 18);
  return n || 'Player';
}

function bindSeat(conn, seat) {
  if (seat.conn && seat.conn !== conn && seat.conn.open) {
    // the same seat opened somewhere else; the newest window wins
    seat.conn.send({ t: 'kicked', why: 'You opened this game in another window.' });
    seat.conn.close(4000, 'seat reclaimed');
  }
  conn.data.seat = seat;
  seat.conn = conn;
  seat.connected = true;
  seat.droppedAt = 0;
  seat.room.touched = Date.now();
}

ws.attach(server, function (conn) {
  conn.on('message', function (m) {
    const seat = conn.data.seat;
    const room = seat ? seat.room : null;
    try {
      switch (m.t) {

        case 'create': {
          const r = rooms.create({ game: m.game, target: Number(m.target) });
          const s = rooms.sit(r, cleanName(m.name), 0);
          bindSeat(conn, s);
          announce(r);
          return;
        }

        case 'join': {
          const r = rooms.get(m.code);
          if (!r) return conn.send({ t: 'error', code: 'no_room', msg: 'No game with that code. Codes expire a few hours after the game ends.' });
          if (r.seats[1]) return conn.send({ t: 'error', code: 'full', msg: 'That game already has two players.' });
          const s = rooms.sit(r, cleanName(m.name), 1);
          bindSeat(conn, s);
          R.startMatch(r);
          announce(r);
          pushBoth(r);
          tell(r.seats[0], { t: 'peer', joined: true, name: s.name });
          return;
        }

        /* Reconnecting: a refresh, a phone waking up, a dropped wifi. The seat
           token was kept by the browser, so the player drops straight back into
           the same hand rather than losing it. */
        case 'resume': {
          const s = rooms.seat(m.seat);
          if (!s) return conn.send({ t: 'error', code: 'no_seat', msg: 'That game is no longer running.' });
          bindSeat(conn, s);
          announce(s.room);
          push(s);
          tell(peerOf(s), { t: 'peer', back: true, name: s.name });
          return;
        }

        case 'action': {
          if (!seat) return;
          try {
            R.applyAction(room, seat.idx, m);
            room.touched = Date.now();
          } catch (e) {
            conn.send({ t: 'error', code: 'illegal', msg: e.message });
          }
          pushBoth(room);
          return;
        }

        case 'rematch': {
          if (!seat || !room.G) return;
          if (!room.G.matchOver) return;
          R.startMatch(room);
          pushBoth(room);
          return;
        }

        case 'chat': {
          if (!seat) return;
          const text = String(m.text || '').slice(0, 400).trim();
          if (!text) return;
          const line = { t: 'chat', from: seat.idx, name: seat.name, text: text, ts: Date.now() };
          room.chat.push(line);
          if (room.chat.length > 60) room.chat.shift();
          for (const s of room.seats) tell(s, line);
          room.touched = Date.now();
          return;
        }

        /* WebRTC setup passes through untouched. The server never sees or
           carries the picture and sound themselves — only the introductions. */
        case 'signal': {
          if (!seat) return;
          const other = peerOf(seat);
          if (other) tell(other, { t: 'signal', from: seat.idx, data: m.data });
          return;
        }

        case 'leave': {
          if (!seat) return;
          const other = peerOf(seat);
          tell(other, { t: 'peer', left: true, name: seat.name });
          rooms.destroy(room);
          conn.data.seat = null;
          return;
        }

        default: return;
      }
    } catch (e) {
      console.error('message error:', e);
      conn.send({ t: 'error', code: 'server', msg: 'Something went wrong at the server.' });
    }
  });

  conn.on('close', function () {
    const seat = conn.data.seat;
    if (!seat || seat.conn !== conn) return;
    seat.connected = false;
    seat.droppedAt = Date.now();
    const other = peerOf(seat);
    tell(other, { t: 'peer', gone: true, name: seat.name, graceMs: R.GRACE_MS });
    if (other) tell(other, { t: 'room', info: roomInfo(seat.room), you: other.idx, seat: other.token });
  });
});

setInterval(function () { rooms.sweep(); }, 60 * 1000).unref();

server.listen(PORT, function () {
  console.log('Gin & Corners ' + VERSION + ' listening on port ' + PORT +
    (FLAT ? ' (files are all in one folder — that is fine)' : ''));
});

module.exports = { server: server, rooms: rooms, VERSION: VERSION };
