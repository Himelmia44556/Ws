const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const TelegramBot = require("node-telegram-bot-api");
const qrcode = require("qrcode");
const P = require("pino");
const fs = require("fs-extra");

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.log("❌ BOT_TOKEN missing in Railway Variables");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const activeSessions = new Map(); // prevent spam

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
`Welcome To Ws Checker Bot

/login - Login with QR
/pair - Login with Pairing Code
/logout - Logout
/cancel - Cancel current process`);
});

bot.onText(/\/cancel/, (msg) => {
  const userId = msg.from.id;
  if (activeSessions.has(userId)) {
    activeSessions.get(userId).cancelled = true;
    activeSessions.delete(userId);
    bot.sendMessage(msg.chat.id, "❌ Process cancelled.");
  } else {
    bot.sendMessage(msg.chat.id, "No active process.");
  }
});

bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;

  if (await fs.pathExists(sessionPath)) {
    await fs.remove(sessionPath);
    bot.sendMessage(msg.chat.id, "✅ Logged out successfully.");
  } else {
    bot.sendMessage(msg.chat.id, "No linked account found.");
  }
});

bot.onText(/\/login/, async (msg) => {
  const userId = msg.from.id;
  if (activeSessions.has(userId)) {
    return bot.sendMessage(msg.chat.id, "⚠️ Login already running.");
  }

  activeSessions.set(userId, { cancelled: false });

  const sessionPath = `sessions/${userId}`;
  await fs.ensureDir(sessionPath);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    browser: ["Mac OS", "Safari", "10.15.7"]
  });

  sock.ev.on("creds.update", saveCreds);

  let qrSent = false;

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr && !qrSent) {
      qrSent = true;
      const qrImage = await qrcode.toBuffer(qr);
      await bot.sendPhoto(msg.chat.id, qrImage, {
        caption: "Scan this QR within 2 minutes."
      });

      setTimeout(() => {
        if (activeSessions.has(userId)) {
          activeSessions.delete(userId);
          sock.ws.close();
          bot.sendMessage(msg.chat.id, "⏰ QR expired.");
        }
      }, 120000);
    }

    if (connection === "open") {
      activeSessions.delete(userId);
      bot.sendMessage(msg.chat.id, "✅ WhatsApp linked successfully.");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("Reconnecting...");
      }
    }
  });
});

bot.onText(/\/pair/, async (msg) => {
  const userId = msg.from.id;

  if (activeSessions.has(userId)) {
    return bot.sendMessage(msg.chat.id, "⚠️ Pairing already running.");
  }

  activeSessions.set(userId, { cancelled: false });

  bot.sendMessage(msg.chat.id, "Send your WhatsApp number with country code.\nExample: 8801XXXXXXXXX");

  bot.once("message", async (numberMsg) => {
    const number = numberMsg.text;

    if (!number.match(/^[0-9]+$/)) {
      activeSessions.delete(userId);
      return bot.sendMessage(msg.chat.id, "❌ Invalid number.");
    }

    const sessionPath = `sessions/${userId}`;
    await fs.ensureDir(sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: "silent" }),
      browser: ["Mac OS", "Safari", "10.15.7"]
    });

    sock.ev.on("creds.update", saveCreds);

    setTimeout(() => {
      if (activeSessions.has(userId)) {
        activeSessions.delete(userId);
        sock.ws.close();
        bot.sendMessage(msg.chat.id, "⏰ Pairing expired.");
      }
    }, 120000);

    sock.ev.on("connection.update", async (update) => {
      if (update.connection === "connecting") {
        try {
          const code = await sock.requestPairingCode(number);
          bot.sendMessage(msg.chat.id, `🔐 Pairing Code:\n${code}`);
        } catch (err) {
          activeSessions.delete(userId);
          bot.sendMessage(msg.chat.id, "❌ Failed to generate pairing code.");
        }
      }

      if (update.connection === "open") {
        activeSessions.delete(userId);
        bot.sendMessage(msg.chat.id, "✅ WhatsApp linked successfully.");
      }
    });
  });
});

console.log("🚀 Bot running...");