# Minecraft 26.2 AFK Bot

Minimal Mineflayer controller for a Fabric 26.2 server.

## Behavior

- Server List Ping every 5 seconds.
- When the server has 0 players, wait 15 seconds and connect the bot.
- While connected, player join events are checked directly.
- A real player joining causes the bot to leave.
- When the last real player leaves, the controller can connect again.
- A kick stops the controller; it does not reconnect after a kick.
- EasyAuth login is sent automatically.
- The bot does not intentionally move or rotate.

## Requirements

- Node.js 22+
- Minecraft Java 26.2 server
- Offline authentication on the server, if using `auth: offline`

## Environment variables

```text
MC_HOST=your.server.example
MC_PORT=25565
BOT_USERNAME=AFK_Bot
BOT_PASSWORD=your_easyauth_password
PING_INTERVAL=5000
REJOIN_DELAY=15000
LOGIN_DELAY=2000
```

Do not commit the real password to GitHub.

## Run

```bash
npm install
npm start
```
