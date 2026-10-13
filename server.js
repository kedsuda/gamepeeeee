// Ghost Maze server: static files + LAN multiplayer room over WebSocket.
//   node server.js  →  http://localhost:8080  (friends on the same Wi-Fi use the LAN address printed below)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = +process.env.PORT || 8080;
const root = __dirname;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

// ===================== minimal WebSocket (RFC 6455, text frames only) =====================
function wsSend(sock, str) {
  if (!sock.writable) return;
  const p = Buffer.from(str);
  let h;
  if (p.length < 126) h = Buffer.from([0x81, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  sock.write(Buffer.concat([h, p]));
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/ws' || !key) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  const player = onConnect(sock);
  let buf = Buffer.alloc(0), frag = null;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) break;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskAt = off;
      if (masked) off += 4;
      if (buf.length < off + len) break;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i & 3)];
      buf = buf.subarray(off + len);
      if (op === 8) { sock.end(Buffer.from([0x88, 0])); return; }
      if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 1) frag = payload;
      else if (op === 0 && frag) frag = Buffer.concat([frag, payload]);
      else continue;
      if (fin) {
        const text = frag.toString();
        frag = null;
        let msg;
        try { msg = JSON.parse(text); } catch { continue; }
        try { onMessage(player, msg); } catch (e) { console.error(e); }
      }
    }
  });
  const bye = () => onClose(player);
  sock.on('close', bye);
  sock.on('error', bye);
});

// ===================== game room =====================
const CHAR_HP = { allmight: 160, commando: 120, tuxedo: 110 };
const GHOST_HP = 150;
const GAME_MS = 5 * 60 * 1000;   // round length
const ROULETTE_MS = 5500;        // role-reveal animation before the round starts
const RELEASE_MS = 6000;         // runners' head start
const BANISH_MS = 4000;          // a defeated ghost is out for this long
const RUNNER_INVULN_MS = 700;
const HEART_HP = 35;

const players = new Map();
let nextId = 1, hostId = null, game = null;
const settings = { ghosts: 1 };

const num = (v, lim) => Math.max(-lim, Math.min(lim, +v || 0));
const validChar = (c) => (c in CHAR_HP ? c : 'allmight');

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function send(p, msg) { wsSend(p.sock, JSON.stringify(msg)); }
function broadcast(msg, except) {
  const s = JSON.stringify(msg);
  for (const p of players.values()) if (p !== except && p.name) wsSend(p.sock, s);
}
function sendLobby() {
  broadcast({
    t: 'lobby', hostId, settings, inGame: !!game, ips: lanIPs(), port: PORT,
    players: [...players.values()].filter((p) => p.name).map((p) => ({ id: p.id, name: p.name, char: p.char, playing: !!(game && p.role) })),
  });
}

function onConnect(sock) {
  const p = { id: nextId++, sock, name: '', char: 'allmight', role: null, hp: 0, maxHp: 0, invulnUntil: 0, banished: false };
  players.set(p.id, p);
  return p;
}

function onClose(p) {
  if (!players.has(p.id)) return;
  players.delete(p.id);
  if (hostId === p.id) hostId = [...players.values()].find((q) => q.name)?.id ?? null;
  broadcast({ t: 'leave', id: p.id });
  if (game) checkEnd();
  sendLobby();
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function startGame() {
  const list = shuffle([...players.values()].filter((p) => p.name));
  if (list.length < 2 || game) return;
  const nGhosts = Math.max(1, Math.min(list.length - 1, settings.ghosts | 0));
  list.forEach((p, i) => {
    p.role = i < nGhosts ? 'ghost' : 'runner';
    p.maxHp = p.role === 'ghost' ? GHOST_HP : CHAR_HP[p.char];
    p.hp = p.maxHp; p.invulnUntil = 0; p.banished = false;
  });
  const now = Date.now();
  game = {
    keys: new Set(), hearts: new Set(), keysGot: 0, open: false, startAt: now + ROULETTE_MS,
    timer: setTimeout(() => endGame('ghosts', 'หมดเวลา! ผู้หนีออกจากเขาวงกตไม่ทัน'), ROULETTE_MS + GAME_MS),
  };
  broadcast({
    t: 'start', seed: (Math.random() * 2 ** 31) | 0, variant: (Math.random() * 8) | 0,
    players: list.map((p) => ({ id: p.id, name: p.name, char: p.char, role: p.role, hp: p.hp, maxHp: p.maxHp })),
    startIn: ROULETTE_MS, releaseIn: ROULETTE_MS + RELEASE_MS, endIn: ROULETTE_MS + GAME_MS,
  });
  sendLobby();
}

function endGame(winner, reason) {
  if (!game) return;
  clearTimeout(game.timer);
  game = null;
  for (const p of players.values()) p.role = null;
  broadcast({ t: 'end', winner, reason });
  sendLobby();
}

function checkEnd() {
  if (!game) return;
  const inGame = [...players.values()].filter((p) => p.role);
  if (!inGame.some((p) => p.role === 'runner')) endGame('ghosts', 'ผีจับผู้หนีได้ครบทุกคน!');
  else if (!inGame.some((p) => p.role === 'ghost')) endGame('runners', 'ผีออกจากเกมไปหมดแล้ว');
}

function onHit(p, m) {
  if (!game || !p.role || Date.now() < game.startAt) return;
  const tg = players.get(m.target);
  if (!tg || !tg.role || tg.role === p.role || tg.banished) return;
  const now = Date.now();
  if (tg.role === 'runner') {
    if (now < tg.invulnUntil) return;
    tg.invulnUntil = now + RUNNER_INVULN_MS;
  }
  const dmg = Math.max(0, num(m.dmg, 200));
  tg.hp = Math.max(0, tg.hp - dmg);
  broadcast({ t: 'hp', id: tg.id, hp: tg.hp, dmg, kx: num(m.kx, 40), kz: num(m.kz, 40), stun: Math.max(0, num(m.stun, 1.5)), from: p.id });
  if (tg.hp > 0) return;
  if (tg.role === 'runner') {
    // caught runners join the ghosts
    tg.role = 'ghost'; tg.maxHp = GHOST_HP; tg.hp = GHOST_HP;
    broadcast({ t: 'role', id: tg.id, role: 'ghost', hp: tg.hp, maxHp: tg.maxHp, by: p.id });
    checkEnd();
  } else {
    tg.banished = true;
    broadcast({ t: 'banish', id: tg.id, by: p.id, ms: BANISH_MS });
    const g = game;
    setTimeout(() => {
      if (game !== g || !players.has(tg.id) || tg.role !== 'ghost') return;
      tg.banished = false; tg.hp = tg.maxHp;
      broadcast({ t: 'unbanish', id: tg.id, hp: tg.hp });
    }, BANISH_MS);
  }
}

function onMessage(p, m) {
  switch (m.t) {
    case 'hello':
      p.name = String(m.name || '').trim().slice(0, 16) || `ผู้เล่น ${p.id}`;
      p.char = validChar(m.char);
      if (hostId == null) hostId = p.id;
      send(p, { t: 'welcome', id: p.id });
      sendLobby();
      break;
    case 'char':
      p.char = validChar(m.char);
      sendLobby();
      break;
    case 'settings':
      if (p.id !== hostId) return;
      settings.ghosts = Math.max(1, Math.min(8, m.ghosts | 0));
      sendLobby();
      break;
    case 'start':
      if (p.id === hostId) startGame();
      break;
    case 'st':
      if (game && p.role) broadcast({ t: 'st', id: p.id, x: m.x, z: m.z, y: m.y, m: m.m, d: m.d, ph: m.ph }, p);
      break;
    case 'fx':
      if (game && p.role) broadcast({ ...m, t: 'fx', id: p.id }, p);
      break;
    case 'hit':
      onHit(p, m);
      break;
    case 'heal':
      if (!game || p.role !== 'runner') return;
      p.hp = Math.min(p.maxHp, p.hp + Math.max(0, num(m.amt, 25)));
      broadcast({ t: 'hp', id: p.id, hp: p.hp, dmg: 0 });
      break;
    case 'pick': {
      if (!game || p.role !== 'runner') return;
      const idx = m.idx | 0;
      if (m.kind === 'key') {
        if (idx < 0 || idx > 2 || game.keys.has(idx)) return;
        game.keys.add(idx); game.keysGot++;
        if (game.keysGot >= 3) game.open = true;
        broadcast({ t: 'pick', kind: 'key', idx, by: p.id, keysGot: game.keysGot });
      } else if (m.kind === 'heart') {
        if (idx < 0 || idx > 20 || game.hearts.has(idx)) return;
        game.hearts.add(idx);
        p.hp = Math.min(p.maxHp, p.hp + HEART_HP);
        broadcast({ t: 'pick', kind: 'heart', idx, by: p.id });
        broadcast({ t: 'hp', id: p.id, hp: p.hp, dmg: 0 });
      }
      break;
    }
    case 'exit':
      if (game && game.open && p.role === 'runner') endGame('runners', `${p.name} หนีออกจากเขาวงกตสำเร็จ!`);
      break;
  }
}

server.listen(PORT, () => {
  console.log(`Ghost Maze running at http://localhost:${PORT}`);
  const ips = lanIPs();
  if (ips.length) console.log(`Friends on the same Wi-Fi can join at: ${ips.map((ip) => `http://${ip}:${PORT}`).join('  or  ')}`);
});
