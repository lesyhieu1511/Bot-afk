'use strict';

const mc = require('minecraft-protocol');
const config = require('./config');

const { HOST, PORT, USE_LOGIN, USERNAME, PASSWORD, PING_INTERVAL, REJOIN_DELAY, LOGIN_DELAY } = config;

if (!HOST || HOST === 'YOUR_SERVER_IP') throw new Error('Please configure HOST in config.js');
if (USE_LOGIN && (!PASSWORD || PASSWORD === 'YOUR_EASYAUTH_PASSWORD')) throw new Error('Please configure PASSWORD in config.js or set USE_LOGIN=false');

let client = null;
let state = 'OFFLINE';
let rejoinTimer = null;
let loginTimer = null;
let loginSent = false;
const onlinePlayers = new Set();

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function scheduleJoin() {
  if (state !== 'OFFLINE' || rejoinTimer) return;
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    if (state === 'OFFLINE') connectBot();
  }, REJOIN_DELAY);
  log(`Server reachable/starting. Bot will connect in ${REJOIN_DELAY / 1000}s.`);
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

function uuidKey(value) {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (typeof value === 'object' && value.toString) return value.toString();
  return String(value);
}

function checkPlayers() {
  if (state !== 'ONLINE') return;
  const count = onlinePlayers.size;
  log(`[PLAYERS] tab-list=${count}: ${Array.from(onlinePlayers).join(', ') || 'none'}`);
  if (count > 1) disconnectBot(`player list contains ${count} players`);
}

function handlePlayPacket(name, data) {
  if (name === 'keep_alive') {
    const id = data?.keepAliveId ?? data?.id;
    if (id !== undefined) { try { client.write('keep_alive', { id }); } catch (_) {} }
    return;
  }

  if (name === 'player_info_update') {
    const players = Array.isArray(data?.players) ? data.players : [];
    for (const entry of players) {
      const id = uuidKey(entry?.uuid ?? entry?.profileId ?? entry?.profile_id);
      if (id) onlinePlayers.add(id);
    }
    checkPlayers();
    return;
  }

  if (name === 'player_info_remove') {
    const players = Array.isArray(data?.players) ? data.players : [];
    for (const id of players) onlinePlayers.delete(uuidKey(id));
    return;
  }

  if (USE_LOGIN && !loginSent && (name === 'system_chat' || name === 'player_chat' || name === 'disguised_chat' || name === 'overlay')) {
    let text = '';
    try {
      if (typeof data === 'string') text = data;
      else text = JSON.stringify(data);
    } catch (_) {}
    text = text.toLowerCase();
    if (text.includes('/login') || text.includes('login') || text.includes('đăng nhập') || text.includes('mat khau') || text.includes('mật khẩu')) sendLogin();
  }
}

function connectBot() {
  if (state !== 'OFFLINE') return;
  state = 'CONNECTING';
  loginSent = false;
  onlinePlayers.clear();
  log(`Connecting as ${USERNAME} to ${HOST}:${PORT}...`);

  let newClient;
  try {
    newClient = mc.createClient({
      host: HOST,
      port: PORT,
      username: USERNAME,
      auth: 'offline',
      version: '26.2',
      // Explicit 26.2 Client Information values. The 26.2 serializer
      // expects particleStatus as the protocol enum string, not a number.
      clientSettings: {
        locale: 'en_us',
        viewDistance: 10,
        chatFlags: 0,
        chatColors: true,
        skinParts: 127,
        mainHand: 1,
        enableTextFiltering: false,
        enableServerListing: true,
        particleStatus: 'all'
      }
    });
  } catch (error) {
    state = 'OFFLINE';
    log(`CONNECT ERROR: ${error.message}`);
    return;
  }
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

  newClient.on('error', error => {
    log(`ERROR: ${error.message}`);
  });

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
    onlinePlayers.clear();
    if (state !== 'KICKED' && state !== 'DISCONNECTING') state = 'OFFLINE';
    if (state === 'DISCONNECTING') state = 'OFFLINE';
    log(`Connection ended (${state}).`);
  });
}

function controllerTick() {
  if (state === 'KICKED') return;

  if (state === 'OFFLINE') {
    if (!rejoinTimer) scheduleJoin();
    return;
  }
}

log(`AFK controller started for ${HOST}:${PORT}`);
log(`Minecraft 26.2 protocol client enabled; login=${USE_LOGIN}; interval=${PING_INTERVAL}ms`);
log('Server-list ping disabled for control flow; using direct game connection + player list detection.');
controllerTick();
setInterval(controllerTick, PING_INTERVAL);

process.on('SIGINT', () => {
  cancelJoin();
  if (loginTimer) clearTimeout(loginTimer);
  if (client) { try { client.end('controller stopped'); } catch (_) {} }
  process.exit(0);
});
