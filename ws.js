'use strict';
/* ============================================================
   A small WebSocket server (RFC 6455), no dependencies.

   The whole app deliberately installs nothing: `node server/index.js`
   and it runs. That means no npm install to fail on a host, no
   package to go stale, and nothing to keep up to date. The protocol
   surface we need is small — text frames, ping/pong, close — so
   carrying it here costs less than carrying a dependency.
   ============================================================ */
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MAX_MESSAGE = 512 * 1024;   // an SDP offer is a few KB; this is generous

function accept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/* ---------- outgoing frames ---------- */
function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeUInt32BE(Math.floor(len / 4294967296), 2);
    head.writeUInt32BE(len >>> 0, 6);
  }
  head[0] = 0x80 | opcode;          // FIN + opcode; the server never fragments
  return Buffer.concat([head, payload]);
}

/* ---------- one connection ---------- */
function Conn(socket, req) {
  this.socket = socket;
  this.req = req;
  this.open = true;
  this.buf = Buffer.alloc(0);
  this.fragOp = 0;
  this.frags = [];
  this.fragLen = 0;
  this.alive = true;
  this.handlers = { message: [], close: [] };
  this.data = {};                   // whatever the app wants to hang off it
}

Conn.prototype.on = function (evt, fn) {
  if (this.handlers[evt]) this.handlers[evt].push(fn);
  return this;
};
Conn.prototype.emit = function (evt, arg) {
  for (const fn of this.handlers[evt].slice()) {
    try { fn(arg); } catch (e) { console.error('handler error on ' + evt + ':', e); }
  }
};

Conn.prototype.sendRaw = function (opcode, payload) {
  if (!this.open) return false;
  try { this.socket.write(frame(opcode, payload)); return true; }
  catch (e) { this.destroy(); return false; }
};
Conn.prototype.send = function (obj) {
  return this.sendRaw(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
};
Conn.prototype.ping = function () { return this.sendRaw(0x9, Buffer.alloc(0)); };

Conn.prototype.close = function (code, reason) {
  if (!this.open) return;
  const r = Buffer.from(reason || '', 'utf8');
  const b = Buffer.alloc(2 + r.length);
  b.writeUInt16BE(code || 1000, 0);
  r.copy(b, 2);
  this.sendRaw(0x8, b);
  this.open = false;
  const s = this.socket;
  setTimeout(function () { try { s.end(); } catch (e) {} }, 20);
  this.emit('close');
};

Conn.prototype.destroy = function () {
  if (!this.open) return;
  this.open = false;
  try { this.socket.destroy(); } catch (e) {}
  this.emit('close');
};

/* Pull as many whole frames out of the buffer as have arrived. TCP hands us
   arbitrary slices, so every length check has to be defensive. */
Conn.prototype.feed = function (chunk) {
  this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
  for (;;) {
    const b = this.buf;
    if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0;
    const rsv = b[0] & 0x70;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (rsv) return this.fail(1002, 'reserved bits set');
    if (!masked) return this.fail(1002, 'client frames must be masked');

    if (len === 126) {
      if (b.length < off + 2) return;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return;
      const hi = b.readUInt32BE(off), lo = b.readUInt32BE(off + 4);
      if (hi !== 0) return this.fail(1009, 'frame too large');
      len = lo; off += 8;
    }
    if (len > MAX_MESSAGE) return this.fail(1009, 'frame too large');
    if (b.length < off + 4 + len) return;          // mask key + payload

    const mask = b.slice(off, off + 4); off += 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = b[off + i] ^ mask[i & 3];
    this.buf = b.slice(off + len);

    if (op === 0x8) { this.open = false; this.sendRaw(0x8, payload.slice(0, 2)); try { this.socket.end(); } catch (e) {} this.emit('close'); return; }
    if (op === 0x9) { this.sendRaw(0xA, payload); continue; }   // ping -> pong
    if (op === 0xA) { this.alive = true; continue; }            // pong

    if (op === 0x1 || op === 0x2) {
      if (this.frags.length) return this.fail(1002, 'interleaved message');
      if (fin) { this.deliver(op, payload); continue; }
      this.fragOp = op; this.frags = [payload]; this.fragLen = len;
      continue;
    }
    if (op === 0x0) {
      if (!this.frags.length) return this.fail(1002, 'continuation without start');
      this.fragLen += len;
      if (this.fragLen > MAX_MESSAGE) return this.fail(1009, 'message too large');
      this.frags.push(payload);
      if (fin) {
        const whole = Buffer.concat(this.frags, this.fragLen);
        const o = this.fragOp;
        this.frags = []; this.fragLen = 0; this.fragOp = 0;
        this.deliver(o, whole);
      }
      continue;
    }
    return this.fail(1002, 'bad opcode');
  }
};

Conn.prototype.deliver = function (op, payload) {
  if (op !== 0x1) return;                       // this app speaks JSON only
  let msg;
  try { msg = JSON.parse(payload.toString('utf8')); }
  catch (e) { return; }                         // ignore junk rather than drop the player
  if (msg && typeof msg === 'object') this.emit('message', msg);
};

Conn.prototype.fail = function (code, why) {
  this.close(code, why);
};

/* ---------- the server ---------- */
function attach(httpServer, onConnection) {
  const conns = new Set();

  httpServer.on('upgrade', function (req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    const ver = req.headers['sec-websocket-version'];
    const up = String(req.headers.upgrade || '').toLowerCase();
    if (up !== 'websocket' || !key || String(ver) !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      try { socket.destroy(); } catch (e) {}
      return;
    }
    socket.setNoDelay(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept(key) + '\r\n\r\n'
    );

    const c = new Conn(socket, req);
    conns.add(c);
    if (head && head.length) c.feed(head);
    socket.on('data', function (d) { c.feed(d); });
    socket.on('error', function () { c.destroy(); });
    socket.on('close', function () {
      if (c.open) { c.open = false; c.emit('close'); }
      conns.delete(c);
    });
    c.on('close', function () { conns.delete(c); });

    onConnection(c);
  });

  /* Idle connections get culled by proxies and by phones going to sleep. A
     ping every 25s keeps the line warm and, more usefully, tells us within
     50s that somebody's connection died without a clean close. */
  const beat = setInterval(function () {
    for (const c of conns) {
      if (!c.open) { conns.delete(c); continue; }
      if (!c.alive) { c.destroy(); continue; }
      c.alive = false;
      c.ping();
    }
  }, 25000);
  if (beat.unref) beat.unref();

  return { conns: conns, stop: function () { clearInterval(beat); } };
}

module.exports = { attach: attach, Conn: Conn, frame: frame, accept: accept };
