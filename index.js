const mineflayer = require('mineflayer');

const HOST = process.env.MC_HOST;
const PORT = Number(process.env.MC_PORT || 25565);
const USERNAME = process.env.BOT_USERNAME || 'AFK_Bot';
const PASSWORD = process.env.BOT_PASSWORD;
const PING_INTERVAL = Number(process.env.PING_INTERVAL || 5000);
const REJOIN_DELAY = Number(process.env.REJOIN_DELAY || 15000);

if (!HOST) throw new Error('Missing MC_HOST');
if (!PASSWORD) throw new Error('Missing BOT_PASSWORD');

let bot = null;
let state = 'OFFLINE'; // OFFLINE, CONNECTING, ONLINE, KICKED
let rejoinTimer = null;
let intentionalDisconnect = false;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function realPlayersFromBot() {
  if (!bot || !bot.players) return 0;
  return Object.keys(bot.players).filter(name => name !== USERNAME).length;
}

function disconnectBot(reason = 'real player detected') {
  if (!bot || (state !== 'ONLINE' && state !== 'CONNECTING')) return;
  intentionalDisconnect = true;
  state = 'OFFLINE';
  log(`Disconnecting bot: ${reason}`);
  try { bot.quit(reason); } catch (_) {}
  bot = null;
}

function scheduleJoin() {
  if (state !== 'OFFLINE' || rejoinTimer) return;
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    if (state === 'OFFLINE') connectBot();
  }, REJOIN_DELAY);
  log(`No real player detected. Bot will connect in ${REJOIN_DELAY / 1000}s.`);
}

function connectBot() {
  if (state !== 'OFFLINE') return;

  state = 'CONNECTING';
  intentionalDisconnect = false;
  log(`Connecting to ${HOST}:${PORT} as ${USERNAME}...`);

  const newBot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    auth: 'offline',
    version: '26.2'
  });

  bot = newBot;

  newBot.once('spawn', () => {
    if (bot !== newBot) return;
    state = 'ONLINE';
    log('Bot spawned. Standing still.');
  });

  newBot.on('playerJoined', player => {
    if (player && player.username !== USERNAME) {
      log(`Real player joined: ${player.username}`);
      disconnectBot(`player ${player.username} joined`);
    }
  });

  newBot.on('playerLeft', () => {
    // Player list is checked by the next join/leave cycle and ping controller.
  });

  newBot.on('messagestr', message => {
    const text = String(message);
    if (/\\/login\\b/i.test(text) || /login/i.test(text) && /password|mật khẩu|mat khau/i.test(text)) {
      log('EasyAuth login prompt detected.');
      newBot.chat(`/login ${PASSWORD}`);
    }
  });

  newBot.on('kicked', reason => {
    log(`KICKED: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
    state = 'KICKED';
    bot = null;
    if (rejoinTimer) {
      clearTimeout(rejoinTimer);
      rejoinTimer = null;
    }
  });

  newBot.on('error', error => {
    log(`ERROR: ${error.message}`);
  });

  newBot.on('end', () => {
    if (bot === newBot) bot = null;
    if (state !== 'KICKED') state = 'OFFLINE';
    log(`Connection ended${intentionalDisconnect ? ' (intentional)' : ''}.`);
  });
}

// Lightweight status query using the Minecraft protocol through a temporary
// Mineflayer connection is intentionally avoided: the live bot connection is
// authoritative while online. When offline, we use a TCP/status probe below.
// This keeps the controller simple and avoids creating duplicate player sessions.
const net = require('net');

function pingServer(timeout = 2500) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

async function controllerTick() {
  if (state === 'KICKED') return;

  if (state === 'ONLINE' && realPlayersFromBot() > 0) {
    disconnectBot('real player present');
    return;
  }

  const reachable = await pingServer();

  if (!reachable) {
    if (state === 'OFFLINE') {
      // The server may be starting/suspended. Try a real connection after delay.
      scheduleJoin();
    }
    return;
  }

  if (state === 'OFFLINE') {
    scheduleJoin();
  }
}

log(`AFK controller started. Ping interval: ${PING_INTERVAL}ms`);
controllerTick();
setInterval(controllerTick, PING_INTERVAL);

process.on('SIGINT', () => {
  if (rejoinTimer) clearTimeout(rejoinTimer);
  if (bot) {
    try { bot.quit('controller stopped'); } catch (_) {}
  }
  process.exit(0);
});
