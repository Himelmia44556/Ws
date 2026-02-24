const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const TelegramBot = require("node-telegram-bot-api");
const qrcode = require("qrcode");
const P = require("pino");
const fs = require("fs-extra");

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.log("❌ BOT_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const activeLogins = new Map();
const pairingUsers = new Map();

/* ================= START ================= */

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`🤖 Welcome To Whatsapp Checker Bot

/login - Login with QR
/pair - Login with Pair Code
/logout - Logout
/cancel - Cancel process`
  );
});

/* ================= CANCEL ================= */

bot.onText(/\/cancel/, async (msg) => {
  const userId = msg.from.id;

  if (activeLogins.has(userId)) {
    try { activeLogins.get(userId).sock.ws.close(); } catch {}
    activeLogins.delete(userId);
    await fs.remove(`sessions/${userId}`);
  }

  pairingUsers.delete(userId);

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

/* ================= LOGIN (QR) ================= */

bot.onText(/\/login/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  if (activeLogins.has(userId)) {
    return bot.sendMessage(msg.chat.id, "⚠️ Process already running.");
  }

  if (await fs.pathExists(credsPath)) {
    return bot.sendMessage(msg.chat.id, "✅ Already logged in.");
  }

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

  activeLogins.set(userId, { sock });

  let qrSent = false;
  let loginSuccess = false;

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr && !qrSent) {
      qrSent = true;

      const qrImage = await qrcode.toBuffer(qr);

      await bot.sendPhoto(msg.chat.id, qrImage, {
        caption: "📱 Scan within 2 minutes.\nUse /cancel to stop."
      });

      setTimeout(async () => {
        if (!loginSuccess && activeLogins.has(userId)) {
          try { sock.ws.close(); } catch {}
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

/* ================= PAIR SYSTEM ================= */

bot.onText(/\/pair/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  if (activeLogins.has(userId)) {
    return bot.sendMessage(msg.chat.id, "⚠️ Process already running.");
  }

  if (await fs.pathExists(credsPath)) {
    return bot.sendMessage(msg.chat.id, "✅ Already logged in.");
  }

  pairingUsers.set(userId, true);

  bot.sendMessage(
    msg.chat.id,
    "📞 Send your WhatsApp number with country code.\nExample: 8801XXXXXXXXX"
  );
});

/* ================= NUMBER RECEIVE ================= */

bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const text = msg.text;

  if (!pairingUsers.has(userId)) return;
  if (!text || text.startsWith("/")) return;

  pairingUsers.delete(userId);

  const phoneNumber = text.replace(/[^0-9]/g, "");

  if (phoneNumber.length < 10) {
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

  activeLogins.set(userId, { sock });

  try {
    const code = await sock.requestPairingCode(phoneNumber);

    await bot.sendMessage(
      msg.chat.id,
      `🔢 Your Pair Code:\n\n*${code}*\n\nEnter this in WhatsApp > Linked Devices.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    activeLogins.delete(userId);
    await fs.remove(sessionPath);
    return bot.sendMessage(msg.chat.id, "❌ Failed to generate pairing code.");
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      activeLogins.delete(userId);
      bot.sendMessage(msg.chat.id, "✅ WhatsApp linked successfully.");
    }

    if (connection === "close") {
      const loggedOut =
        lastDisconnect?.error?.output?.statusCode ===
        DisconnectReason.loggedOut;

      if (loggedOut) {
        activeLogins.delete(userId);
        await fs.remove(sessionPath);
      }
    }
  });
});

console.log("🚀 Bot started...");
