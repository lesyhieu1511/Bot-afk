'use strict';

const net = require('net');
const mc = require('minecraft-protocol');
const config = require('./config');

const { HOST, PORT, USE_LOGIN, USERNAME, PASSWORD, PING_INTERVAL, REJOIN_DELAY, LOGIN_DELAY } = config;
const PROTOCOL = 776; // Minecraft 26.2

if (!HOST || HOST === 'YOUR_SERVER_IP') throw new Error('Please configure HOST in config.js');
if (USE_LOGIN && (!PASSWORD || PASSWORD === 'YOUR_EASYAUTH_PASSWORD')) throw new Error('Please configure PASSWORD in config.js or set USE_LOGIN=false');

let client = null;
let state = 'OFFLINE';
let rejoinTimer = null;
let pingInProgress = false;
let loginTimer = null;
let loginSent = false;
let pingBaseline = null;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let temp = v & 0x7f;
    v >>>= 7;
    if (v !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function writeString(value) {
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

function packet(payload) {
  return Buffer.concat([writeVarInt(payload.length), payload]);
}

function readVarInt(buffer, offset = 0) {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (offset >= buffer.length) return null;
    const byte = buffer[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  return null;
}

function parseStatusPacket(buffer) {
  const length = readVarInt(buffer);
  if (!length || buffer.length < length.offset + length.value) return null;
  const packetStart = length.offset;
  const packetEnd = packetStart + length.value;
  const packetId = readVarInt(buffer, packetStart);
  if (!packetId || packetId.value !== 0) return null;
  const jsonLength = readVarInt(buffer, packetId.offset);
  if (!jsonLength) return null;
  const start = jsonLength.offset;
  const end = start + jsonLength.value;
  if (end > packetEnd) return null;
  return JSON.parse(buffer.subarray(start, end).toString('utf8'));
}

function pingServer(timeout = 3000) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.on('connect', () => {
      const handshake = Buffer.concat([
        writeVarInt(0x00), writeVarInt(PROTOCOL), writeString(HOST),
        Buffer.from([(PORT >>> 8) & 0xff, PORT & 0xff]), writeVarInt(1)
      ]);
      socket.write(packet(handshake));
      socket.write(packet(Buffer.from([0x00])));
    });
    socket.on('data', chunk => {
      chunks.push(chunk);
      total += chunk.length;
      try {
        const status = parseStatusPacket(Buffer.concat(chunks, total));
        if (status?.players && typeof status.players.online === 'number') {
          finish({ online: status.players.online, max: status.players.max, version: status.version?.name || null });
        }
      } catch (_) {}
    });
    socket.on('timeout', () => finish(null));
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

function scheduleJoin() {
  if (state !== 'OFFLINE' || rejoinTimer) return;
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    if (state === 'OFFLINE') connectBot();
  }, REJOIN_DELAY);
  log(`No real players. Bot will connect in ${REJOIN_DELAY / 1000}s.`);
}

function cancelJoin() {
  if (rejoinTimer) clearTimeout(rejoinTimer);
  rejoinTimer = null;
}

function disconnectBot(reason) {
  if (!client || (state !== 'ONLINE' && state !== 'CONNECTING')) return;
  state = 'DISCONNECTING';
  log(`Real player detected -> disconnecting bot (${reason}).`);
  try { client.end('real player online'); } catch (_) {}
}

function sendLogin() {
  if (!USE_LOGIN || loginSent || !client || state !== 'ONLINE') return;
  loginSent = true;
  try {
    if (typeof client.chat === 'function') client.chat(`/login ${PASSWORD}`);
    else client.write('chat_command', { command: `login ${PASSWORD}` });
    log('EasyAuth login command sent.');
  } catch (error) {
    log(`LOGIN ERROR: ${error.message}`);
  }
}

function textFromPacket(data) {
  if (!data) return '';
  try {
    if (typeof data === 'string') return data;
    if (data.message) return JSON.stringify(data.message);
    if (data.content) return String(data.content);
    if (data.text) return String(data.text);
    return JSON.stringify(data);
  } catch (_) { return ''; }
}

function handlePlayPacket(name, data) {
  if (name === 'keep_alive') {
    const id = data?.keepAliveId ?? data?.id;
    if (id !== undefined) { try { client.write('keep_alive', { id }); } catch (_) {} }
    return;
  }
  if (USE_LOGIN && !loginSent && (name === 'system_chat' || name === 'player_chat' || name === 'disguised_chat' || name === 'overlay')) {
    const text = textFromPacket(data).toLowerCase();
    if (text.includes('/login') || text.includes('login') || text.includes('đăng nhập') || text.includes('mat khau') || text.includes('mật khẩu')) sendLogin();
  }
}

function connectBot() {
  if (state !== 'OFFLINE') return;
  state = 'CONNECTING';
  loginSent = false;
  pingBaseline = null;
  log(`Connecting as ${USERNAME}...`);

  const newClient = mc.createClient({ host: HOST, port: PORT, username: USERNAME, auth: 'offline', version: '26.2' });
  client = newClient;

  newClient.on('login', () => {
    if (client !== newClient) return;
    if (state === 'CONNECTING') {
      state = 'ONLINE';
      log(`Bot online. Standing completely still.${USE_LOGIN ? ' EasyAuth login enabled.' : ' Login disabled.'}`);
      if (USE_LOGIN) loginTimer = setTimeout(sendLogin, LOGIN_DELAY);
    }
  });

  newClient.on('packet', (data, meta) => {
    if (client !== newClient || !meta) return;
    handlePlayPacket(meta.name, data);
  });
  newClient.on('error', error => log(`ERROR: ${error.message}`));
  newClient.on('kick_disconnect', reason => {
    log(`KICKED: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
    state = 'KICKED';
    cancelJoin();
    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = null;
  });
  newClient.on('end', () => {
    if (client === newClient) client = null;
    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = null;
    if (state !== 'KICKED') state = 'OFFLINE';
    log(`Connection ended${state === 'OFFLINE' ? '' : ` (${state})`}.`);
  });
}

async function controllerTick() {
  if (state === 'KICKED' || pingInProgress) return;
  pingInProgress = true;
  const status = await pingServer();
  pingInProgress = false;
  if (!status) { log('[PING] no valid status response.'); return; }
  log(`[PING] players=${status.online}/${status.max}${status.version ? ` version=${status.version}` : ''}`);
  if (state === 'OFFLINE') {
    if (status.online === 0) scheduleJoin();
    else cancelJoin();
    return;
  }
  if (state === 'ONLINE') {
    if (pingBaseline === null) pingBaseline = status.online;
    else if (status.online > pingBaseline) disconnectBot(`status count ${status.online} > baseline ${pingBaseline}`);
  }
}

log(`AFK controller started for ${HOST}:${PORT}`);
log(`Minecraft 26.2 protocol client enabled; login=${USE_LOGIN}; interval=${PING_INTERVAL}ms`);
controllerTick();
setInterval(controllerTick, PING_INTERVAL);

process.on('SIGINT', () => {
  cancelJoin();
  if (loginTimer) clearTimeout(loginTimer);
  if (client) { try { client.end('controller stopped'); } catch (_) {} }
  process.exit(0);
});
