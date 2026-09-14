'use strict';

const net = require('net');
const mineflayer = require('mineflayer');

const HOST = process.env.MC_HOST;
const PORT = Number(process.env.MC_PORT || 25565);
const USERNAME = process.env.BOT_USERNAME || 'AFK_Bot';
const PASSWORD = process.env.BOT_PASSWORD;
const PING_INTERVAL = Number(process.env.PING_INTERVAL || 5000);
const REJOIN_DELAY = Number(process.env.REJOIN_DELAY || 15000);
const LOGIN_DELAY = Number(process.env.LOGIN_DELAY || 2000);
const PROTOCOL = 776; // Minecraft 26.2

if (!HOST) throw new Error('Missing MC_HOST');
if (!PASSWORD) throw new Error('Missing BOT_PASSWORD');

let bot = null;
let state = 'OFFLINE'; // OFFLINE, CONNECTING, ONLINE, DISCONNECTING, KICKED
let rejoinTimer = null;
let pingInProgress = false;
let loginSent = false;
let pingBaseline = null;
let loginTimer = null;

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

// Real Minecraft Server List Ping. A TCP connect alone is NOT enough because
// it cannot tell us whether the server has zero or more players.
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
        writeVarInt(0x00),
        writeVarInt(PROTOCOL),
        writeString(HOST),
        Buffer.from([(PORT >>> 8) & 0xff, PORT & 0xff]),
        writeVarInt(1)
      ]);
      const statusRequest = Buffer.from([0x00]);
      socket.write(packet(handshake));
      socket.write(packet(statusRequest));
    });

    socket.on('data', chunk => {
      chunks.push(chunk);
      total += chunk.length;
      const data = Buffer.concat(chunks, total);
      try {
        const status = parseStatusPacket(data);
        if (status?.players && typeof status.players.online === 'number') {
          finish({
            online: status.players.online,
            max: status.players.max,
            version: status.version?.name || null
          });
        }
      } catch (_) {
        // Wait for the complete status packet.
      }
    });

    socket.on('timeout', () => finish(null));
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

function realPlayersFromBot() {
  if (!bot || !bot.players) return 0;
  return Object.values(bot.players).filter(player =>
    player?.username && player.username.toLowerCase() !== USERNAME.toLowerCase()
  ).length;
}

function disconnectBot(reason) {
  if (!bot || (state !== 'ONLINE' && state !== 'CONNECTING')) return;
  state = 'DISCONNECTING';
  log(`Real player detected -> disconnecting bot (${reason}).`);
  try { bot.quit(reason); } catch (_) {}
}

function scheduleJoin() {
  if (state !== 'OFFLINE' || rejoinTimer) return;
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    if (state === 'OFFLINE') connectBot();
  }, REJOIN_DELAY);
  log(`No real players. Bot will connect in ${REJOIN_DELAY / 1000}s.`);
}

function sendLogin() {
  if (loginSent || !bot || state !== 'ONLINE') return;
  loginSent = true;
  bot.chat(`/login ${PASSWORD}`);
  log('EasyAuth login command sent.');
}

function connectBot() {
  if (state !== 'OFFLINE') return;

  state = 'CONNECTING';
  loginSent = false;
  pingBaseline = null;
  log(`Connecting as ${USERNAME}...`);

  const newBot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    auth: 'offline',
    version: '26.2',
    viewDistance: 'tiny',
    physicsEnabled: false,
    chat: 'commandsOnly',
    enableServerListing: false,
    defaultChatPatterns: false
  });

  bot = newBot;

  newBot.once('spawn', () => {
    if (bot !== newBot) return;
    state = 'ONLINE';
    log('Bot online. Standing completely still.');
    loginTimer = setTimeout(() => sendLogin(), LOGIN_DELAY);

    if (realPlayersFromBot() > 0) {
      disconnectBot('player already online');
    }
  });

  newBot.on('playerJoined', player => {
    if (player?.username && player.username.toLowerCase() !== USERNAME.toLowerCase()) {
      log(`Real player joined: ${player.username}`);
      disconnectBot(`player ${player.username} joined`);
    }
  });

  newBot.on('messagestr', message => {
    const text = String(message).toLowerCase();
    if (!loginSent && (text.includes('/login') || text.includes('login') || text.includes('đăng nhập') || text.includes('mat khau') || text.includes('mật khẩu'))) {
      sendLogin();
    }
  });

  newBot.on('kicked', reason => {
    const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
    log(`KICKED: ${text}`);
    state = 'KICKED';
    if (loginTimer) clearTimeout(loginTimer);
    if (rejoinTimer) clearTimeout(rejoinTimer);
    loginTimer = null;
    rejoinTimer = null;
  });

  newBot.on('error', error => log(`ERROR: ${error.message}`));

  newBot.on('end', () => {
    if (bot === newBot) bot = null;
    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = null;
    if (state !== 'KICKED') state = 'OFFLINE';
    log(`Connection ended${state === 'OFFLINE' ? '' : ` (${state})`}.`);
  });
}

async function controllerTick() {
  if (state === 'KICKED' || pingInProgress) return;

  if (state === 'ONLINE' && realPlayersFromBot() > 0) {
    disconnectBot('player list');
    return;
  }

  pingInProgress = true;
  const status = await pingServer();
  pingInProgress = false;

  if (!status) {
    log('[PING] no valid status response.');
    return;
  }

  log(`[PING] players=${status.online}/${status.max}${status.version ? ` version=${status.version}` : ''}`);

  if (state === 'OFFLINE') {
    if (status.online === 0) {
      scheduleJoin();
    } else if (rejoinTimer) {
      clearTimeout(rejoinTimer);
      rejoinTimer = null;
    }
    return;
  }

  if (state === 'ONLINE') {
    if (pingBaseline === null) pingBaseline = status.online;
    else if (status.online > pingBaseline) disconnectBot(`status count ${status.online} > baseline ${pingBaseline}`);
  }
}

log(`AFK controller started for ${HOST}:${PORT}`);
log(`Minecraft 26.2 status ping enabled; interval=${PING_INTERVAL}ms`);
controllerTick();
setInterval(controllerTick, PING_INTERVAL);

process.on('SIGINT', () => {
  if (rejoinTimer) clearTimeout(rejoinTimer);
  if (loginTimer) clearTimeout(loginTimer);
  if (bot) {
    try { bot.quit('controller stopped'); } catch (_) {}
  }
  process.exit(0);
});
