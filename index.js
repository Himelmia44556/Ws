const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const TelegramBot = require("node-telegram-bot-api");
const P = require("pino");
const fs = require("fs-extra");
const qrcode = require("qrcode");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.log("❌ BOT_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const sessions = new Map();
const pairWait = new Map();

/* ================= START ================= */

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`🤖 WhatsApp Bot

/login  - QR Login
/pair   - Pair Code Login
/logout - Logout
/cancel - Cancel Process`
  );
});

/* ================= CANCEL ================= */

bot.onText(/\/cancel/, async (msg) => {
  const userId = msg.from.id;

  if (sessions.has(userId)) {
    try { sessions.get(userId).sock.end(); } catch {}
    await fs.remove(`sessions/${userId}`);
    sessions.delete(userId);
  }

  pairWait.delete(userId);

  bot.sendMessage(msg.chat.id, "❌ Process cancelled.");
});

/* ================= LOGOUT ================= */

bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  const path = `sessions/${userId}/creds.json`;

  if (!(await fs.pathExists(path))) {
    return bot.sendMessage(msg.chat.id, "❌ No active session.");
  }

  await fs.remove(`sessions/${userId}`);
  bot.sendMessage(msg.chat.id, "✅ Logged out successfully.");
});

/* ================= QR LOGIN ================= */

bot.onText(/\/login/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;

  if (sessions.has(userId))
    return bot.sendMessage(msg.chat.id, "⚠️ Process already running.");

  if (await fs.pathExists(`${sessionPath}/creds.json`))
    return bot.sendMessage(msg.chat.id, "✅ Already logged in.");

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
  sessions.set(userId, { sock });

  let qrSent = false;
  let connected = false;

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr && !qrSent) {
      qrSent = true;
      const image = await qrcode.toBuffer(qr);
      await bot.sendPhoto(msg.chat.id, image, {
        caption: "📱 Scan within 2 minutes.\nUse /cancel to stop."
      });

      setTimeout(async () => {
        if (!connected && sessions.has(userId)) {
          try { sock.end(); } catch {}
          await fs.remove(sessionPath);
          sessions.delete(userId);
          bot.sendMessage(msg.chat.id, "⏰ QR expired.");
        }
      }, 120000);
    }

    if (connection === "open") {
      connected = true;
      sessions.delete(userId);
      bot.sendMessage(msg.chat.id, "✅ WhatsApp linked successfully.");
    }

    if (connection === "close") {
      const loggedOut =
        lastDisconnect?.error?.output?.statusCode ===
        DisconnectReason.loggedOut;

      if (!connected || loggedOut) {
        await fs.remove(sessionPath);
        sessions.delete(userId);
      }
    }
  });
});

/* ================= PAIR SYSTEM ================= */

bot.onText(/\/pair/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;

  if (sessions.has(userId))
    return bot.sendMessage(msg.chat.id, "⚠️ Process already running.");

  if (await fs.pathExists(`${sessionPath}/creds.json`))
    return bot.sendMessage(msg.chat.id, "✅ Already logged in.");

  pairWait.set(userId, true);

  bot.sendMessage(
    msg.chat.id,
    "📞 Send your WhatsApp number with country code.\nExample: 88017XXXXXXXX"
  );
});

/* ================= RECEIVE NUMBER ================= */

bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const text = msg.text;

  if (!pairWait.has(userId)) return;
  if (!text || text.startsWith("/")) return;

  pairWait.delete(userId);

  const phone = text.replace(/[^0-9]/g, "");
  if (phone.length < 10)
    return bot.sendMessage(msg.chat.id, "❌ Invalid number format.");

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
  sessions.set(userId, { sock });

  let codeSent = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "connecting" && !codeSent) {
      codeSent = true;

      // wait small delay to avoid early Railway error
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phone);
          await bot.sendMessage(
            msg.chat.id,
            `🔢 Pair Code:\n\n*${code}*\n\nEnter in WhatsApp > Linked Devices.`,
            { parse_mode: "Markdown" }
          );
        } catch {
          await fs.remove(sessionPath);
          sessions.delete(userId);
          bot.sendMessage(msg.chat.id, "❌ Failed to generate pairing code.");
        }
      }, 4000);
    }

    if (connection === "open") {
      sessions.delete(userId);
      bot.sendMessage(msg.chat.id, "✅ WhatsApp linked successfully.");
    }

    if (connection === "close") {
      const loggedOut =
        lastDisconnect?.error?.output?.statusCode ===
        DisconnectReason.loggedOut;

      if (loggedOut) {
        await fs.remove(sessionPath);
        sessions.delete(userId);
      }
    }
  });
});

console.log("🚀 Bot started...");
