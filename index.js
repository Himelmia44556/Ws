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
const waitingForNumber = new Map();

/* ================= START ================= */

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`🤖 WhatsApp Checker Bot

/login  - Login with QR
/pair   - Login with 8 digit code
/logout - Logout
/cancel - Cancel process`
  );
});

/* ================= CANCEL ================= */

bot.onText(/\/cancel/, async (msg) => {
  const userId = msg.from.id;

  waitingForNumber.delete(userId);

  if (!activeLogins.has(userId))
    return bot.sendMessage(msg.chat.id, "No active process.");

  const { sock, sessionPath } = activeLogins.get(userId);

  try { sock.ws.close(); } catch {}

  activeLogins.delete(userId);
  await fs.remove(sessionPath);

  bot.sendMessage(msg.chat.id, "❌ Process cancelled.");
});

/* ================= LOGOUT ================= */

bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  if (!(await fs.pathExists(credsPath)))
    return bot.sendMessage(msg.chat.id, "❌ No linked account found.");

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

  await startConnection(msg, userId, sessionPath, "qr");
});

/* ================= PAIR COMMAND ================= */

bot.onText(/\/pair/, (msg) => {
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

  await startConnection(msg, userId, sessionPath, "pair", phoneNumber);
});

/* ================= CONNECTION FUNCTION ================= */

async function startConnection(msg, userId, sessionPath, mode, phoneNumber = null) {

  await fs.ensureDir(sessionPath);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  activeLogins.set(userId, { sock, sessionPath });

  let loginSuccess = false;
  let codeSent = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    /* ===== QR MODE ===== */
    if (mode === "qr" && qr && !codeSent) {
      codeSent = true;

      const qrImage = await qrcode.toBuffer(qr);

      await bot.sendPhoto(msg.chat.id, qrImage, {
        caption: "📱 Scan within 2 minutes.\n/cancel"
      });
    }

    /* ===== PAIR MODE (FIXED) ===== */
    if (mode === "pair" && connection === "connecting" && !codeSent) {
      try {
        codeSent = true;

        const code = await sock.requestPairingCode(phoneNumber);

        await bot.sendMessage(
          msg.chat.id,
          `🔐 Pairing Code:\n\n*${code}*\n\nWhatsApp → Linked Devices → Link with phone number\n\nValid 2 minutes.`,
          { parse_mode: "Markdown" }
        );
      } catch (err) {
        activeLogins.delete(userId);
        await fs.remove(sessionPath);
        return bot.sendMessage(msg.chat.id, "❌ Failed to generate pairing code.");
      }
    }

    /* ===== SUCCESS ===== */
    if (connection === "open") {
      loginSuccess = true;
      activeLogins.delete(userId);
      bot.sendMessage(msg.chat.id, "✅ WhatsApp linked successfully.");
    }

    /* ===== CLOSED ===== */
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

  /* ===== TIMEOUT ===== */
  setTimeout(async () => {
    if (!loginSuccess && activeLogins.has(userId)) {
      try { sock.ws.close(); } catch {}
      activeLogins.delete(userId);
      await fs.remove(sessionPath);
      bot.sendMessage(msg.chat.id, "⏰ Session expired.");
    }
  }, 120000);
}

console.log("🚀 Bot started...");