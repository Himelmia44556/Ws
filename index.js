const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const TelegramBot = require("node-telegram-bot-api");
const P = require("pino");
const fs = require("fs-extra");

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.log("❌ BOT_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const activeLogins = new Map();
const waitingForNumber = new Map();

/* ================= START ================= */

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`🤖 WhatsApp Checker Bot

/login - Login with QR
/pair - Login with 8 digit code
/logout - Logout
/cancel - Cancel process`
  );
});

/* ================= CANCEL ================= */

bot.onText(/\/cancel/, async (msg) => {
  const userId = msg.from.id;

  waitingForNumber.delete(userId);

  if (!activeLogins.has(userId)) {
    return bot.sendMessage(msg.chat.id, "No active process.");
  }

  const sessionPath = `sessions/${userId}`;

  try {
    activeLogins.get(userId).sock.ws.close();
  } catch {}

  activeLogins.delete(userId);
  await fs.remove(sessionPath);

  bot.sendMessage(msg.chat.id, "❌ Process cancelled.");
});

/* ================= LOGOUT ================= */

bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  if (!(await fs.pathExists(credsPath))) {
    return bot.sendMessage(msg.chat.id, "❌ No linked WhatsApp account found.");
  }

  await fs.remove(sessionPath);
  bot.sendMessage(msg.chat.id, "✅ Logged out successfully.");
});

/* ================= QR LOGIN ================= */

bot.onText(/\/login/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  if (activeLogins.has(userId))
    return bot.sendMessage(msg.chat.id, "⚠️ Process already running.");

  if (await fs.pathExists(credsPath))
    return bot.sendMessage(msg.chat.id, "✅ Already logged in.");

  await fs.ensureDir(sessionPath);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  activeLogins.set(userId, { sock });

  let qrSent = false;
  let loginSuccess = false;

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr && !qrSent) {
      qrSent = true;

      const qrImage = await require("qrcode").toBuffer(qr);

      await bot.sendPhoto(msg.chat.id, qrImage, {
        caption: "📱 Scan QR within 2 minutes.\n/cancel"
      });

      setTimeout(async () => {
        if (!loginSuccess && activeLogins.has(userId)) {
          sock.ws.close();
          activeLogins.delete(userId);
          await fs.remove(sessionPath);
          bot.sendMessage(msg.chat.id, "⏰ QR expired.");
        }
      }, 120000);
    }

    if (connection === "open") {
      loginSuccess = true;
      activeLogins.delete(userId);
      bot.sendMessage(msg.chat.id, "✅ WhatsApp linked successfully.");
    }

    if (connection === "close") {
      const loggedOut =
        lastDisconnect?.error?.output?.statusCode ===
        DisconnectReason.loggedOut;

      if (!loginSuccess || loggedOut) {
        activeLogins.delete(userId);
        await fs.remove(sessionPath);
      }
    }
  });
});

/* ================= PAIR LOGIN (8 DIGIT CODE) ================= */

bot.onText(/\/pair/, async (msg) => {
  const userId = msg.from.id;

  if (activeLogins.has(userId))
    return bot.sendMessage(msg.chat.id, "⚠️ Process already running.");

  waitingForNumber.set(userId, true);

  bot.sendMessage(
    msg.chat.id,
    "📱 Send your WhatsApp number with country code.\nExample: 8801XXXXXXXXX"
  );
});

/* ================= RECEIVE NUMBER ================= */

bot.on("message", async (msg) => {
  const userId = msg.from.id;

  if (!waitingForNumber.has(userId)) return;
  if (!msg.text) return;

  waitingForNumber.delete(userId);

  const phoneNumber = msg.text.replace(/[^0-9]/g, "");
  const sessionPath = `sessions/${userId}`;

  await fs.ensureDir(sessionPath);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  activeLogins.set(userId, { sock });

  let loginSuccess = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      loginSuccess = true;
      activeLogins.delete(userId);
      bot.sendMessage(msg.chat.id, "✅ WhatsApp linked successfully.");
    }

    if (connection === "close") {
      const loggedOut =
        lastDisconnect?.error?.output?.statusCode ===
        DisconnectReason.loggedOut;

      if (!loginSuccess || loggedOut) {
        activeLogins.delete(userId);
        await fs.remove(sessionPath);
      }
    }
  });

  try {
    const code = await sock.requestPairingCode(phoneNumber);

    await bot.sendMessage(
      msg.chat.id,
      `🔐 Your Pairing Code:\n\n*${code}*\n\nEnter this in WhatsApp → Linked Devices → Link with phone number\n\nValid for 2 minutes.`,
      { parse_mode: "Markdown" }
    );

    setTimeout(async () => {
      if (!loginSuccess && activeLogins.has(userId)) {
        sock.ws.close();
        activeLogins.delete(userId);
        await fs.remove(sessionPath);
        bot.sendMessage(msg.chat.id, "⏰ Pairing code expired.");
      }
    }, 120000);

  } catch (err) {
    activeLogins.delete(userId);
    await fs.remove(sessionPath);
    bot.sendMessage(msg.chat.id, "❌ Failed to generate pairing code.");
  }
});

console.log("🚀 Bot started...");