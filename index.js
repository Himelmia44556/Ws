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

const activeProcesses = new Map();
const waitingForNumber = new Map();

/* ================= START ================= */

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`🤖 WhatsApp Login Bot

/login  - Login with QR
/pair   - Login with Pair Code
/logout - Logout
/cancel - Cancel process`
  );
});

/* ================= CANCEL ================= */

bot.onText(/\/cancel/, async (msg) => {
  const userId = msg.from.id;

  if (activeProcesses.has(userId)) {
    try { activeProcesses.get(userId).sock.ws.close(); } catch {}
    await fs.remove(`sessions/${userId}`);
    activeProcesses.delete(userId);
  }

  waitingForNumber.delete(userId);

  bot.sendMessage(msg.chat.id, "❌ Process cancelled.");
});

/* ================= LOGOUT ================= */

bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  if (!(await fs.pathExists(credsPath))) {
    return bot.sendMessage(msg.chat.id, "❌ No active WhatsApp session.");
  }

  await fs.remove(sessionPath);
  bot.sendMessage(msg.chat.id, "✅ Logged out successfully.");
});

/* ================= LOGIN QR ================= */

bot.onText(/\/login/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  if (activeProcesses.has(userId))
    return bot.sendMessage(msg.chat.id, "⚠️ Process already running.");

  if (await fs.pathExists(credsPath))
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

  activeProcesses.set(userId, { sock });

  let qrSent = false;
  let connected = false;

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr && !qrSent) {
      qrSent = true;

      const qrImage = await qrcode.toBuffer(qr);

      await bot.sendPhoto(msg.chat.id, qrImage, {
        caption: "📱 Scan QR within 2 minutes.\nUse /cancel to stop."
      });

      setTimeout(async () => {
        if (!connected && activeProcesses.has(userId)) {
          try { sock.ws.close(); } catch {}
          await fs.remove(sessionPath);
          activeProcesses.delete(userId);
          bot.sendMessage(msg.chat.id, "⏰ QR expired.");
        }
      }, 120000);
    }

    if (connection === "open") {
      connected = true;
      activeProcesses.delete(userId);
      bot.sendMessage(msg.chat.id, "✅ WhatsApp linked successfully.");
    }

    if (connection === "close") {
      const loggedOut =
        lastDisconnect?.error?.output?.statusCode ===
        DisconnectReason.loggedOut;

      if (!connected || loggedOut) {
        await fs.remove(sessionPath);
        activeProcesses.delete(userId);
      }
    }
  });
});

/* ================= PAIR ================= */

bot.onText(/\/pair/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  if (activeProcesses.has(userId))
    return bot.sendMessage(msg.chat.id, "⚠️ Process already running.");

  if (await fs.pathExists(credsPath))
    return bot.sendMessage(msg.chat.id, "✅ Already logged in.");

  waitingForNumber.set(userId, true);

  bot.sendMessage(
    msg.chat.id,
    "📞 Send your WhatsApp number with country code.\nExample: 88017XXXXXXXX"
  );
});

/* ================= RECEIVE NUMBER ================= */

bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const text = msg.text;

  if (!waitingForNumber.has(userId)) return;
  if (!text || text.startsWith("/")) return;

  waitingForNumber.delete(userId);

  const phoneNumber = text.replace(/[^0-9]/g, "");

  if (phoneNumber.length < 10)
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

  activeProcesses.set(userId, { sock });

  let codeSent = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "connecting" && !codeSent) {
      codeSent = true;
      try {
        const code = await sock.requestPairingCode(phoneNumber);

        await bot.sendMessage(
          msg.chat.id,
          `🔢 Pairing Code:\n\n*${code}*\n\nEnter in WhatsApp > Linked Devices.`,
          { parse_mode: "Markdown" }
        );
      } catch {
        await fs.remove(sessionPath);
        activeProcesses.delete(userId);
        return bot.sendMessage(msg.chat.id, "❌ Failed to generate pairing code.");
      }
    }

    if (connection === "open") {
      activeProcesses.delete(userId);
      bot.sendMessage(msg.chat.id, "✅ WhatsApp linked successfully.");
    }

    if (connection === "close") {
      const loggedOut =
        lastDisconnect?.error?.output?.statusCode ===
        DisconnectReason.loggedOut;

      if (loggedOut) {
        await fs.remove(sessionPath);
        activeProcesses.delete(userId);
      }
    }
  });
});

console.log("🚀 Bot started...");
