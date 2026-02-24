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

/* ================= START ================= */

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`🤖 Welcome To Whatsapp Checker Bot 

/login - Login WhatsApp
/logout - Logout
/cancel - Cancel login`
  );
});

/* ================= CANCEL ================= */

bot.onText(/\/cancel/, async (msg) => {
  const userId = msg.from.id;

  if (!activeLogins.has(userId)) {
    return bot.sendMessage(msg.chat.id, "No active login.");
  }

  const sessionPath = `sessions/${userId}`;

  activeLogins.get(userId).sock.ws.close();
  activeLogins.delete(userId);
  await fs.remove(sessionPath);

  bot.sendMessage(msg.chat.id, "❌ Login cancelled.");
});

/* ================= LOGOUT (FIXED) ================= */

bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  // Only logout if real credentials exist
  if (!(await fs.pathExists(credsPath))) {
    return bot.sendMessage(
      msg.chat.id,
      "❌ No linked WhatsApp account found."
    );
  }

  await fs.remove(sessionPath);
  bot.sendMessage(msg.chat.id, "✅ Logged out successfully.");
});

/* ================= LOGIN ================= */

bot.onText(/\/login/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  if (activeLogins.has(userId)) {
    return bot.sendMessage(msg.chat.id, "⚠️ Login already in progress.");
  }

  // If already logged in
  if (await fs.pathExists(credsPath)) {
    return bot.sendMessage(msg.chat.id, "✅ Already logged in.");
  }

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

    /* ---- QR SEND ONCE ---- */
    if (qr && !qrSent) {
      qrSent = true;

      const qrImage = await qrcode.toBuffer(qr);

      await bot.sendPhoto(msg.chat.id, qrImage, {
        caption: "📱 Scan within 2 minutes. /cancel"
      });

      // Timeout 2 minutes
      setTimeout(async () => {
        if (!loginSuccess && activeLogins.has(userId)) {
          sock.ws.close();
          activeLogins.delete(userId);
          await fs.remove(sessionPath);
          bot.sendMessage(msg.chat.id, "⏰ QR expired.");
        }
      }, 120000);
    }

    /* ---- SUCCESS ---- */
    if (connection === "open") {
      loginSuccess = true;
      activeLogins.delete(userId);
      bot.sendMessage(msg.chat.id, "✅ WhatsApp linked successfully.");
    }

    /* ---- CLOSE BEFORE SUCCESS ---- */
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

console.log("🚀 Bot started...");