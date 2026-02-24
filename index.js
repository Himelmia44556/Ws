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
  console.log("BOT_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const activeSessions = new Map();
const waitingNumbers = new Map();

/* ================= START ================= */

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`🤖 WhatsApp Bot

/login  - Login with QR
/pair   - Login with 8 digit code
/logout - Logout
/cancel - Cancel process`
  );
});

/* ================= CANCEL ================= */

bot.onText(/\/cancel/, async (msg) => {
  const id = msg.from.id;

  waitingNumbers.delete(id);

  if (!activeSessions.has(id))
    return bot.sendMessage(msg.chat.id, "No active process.");

  const { sock, path } = activeSessions.get(id);

  try { sock.end(); } catch {}

  activeSessions.delete(id);
  await fs.remove(path);

  bot.sendMessage(msg.chat.id, "❌ Cancelled.");
});

/* ================= LOGOUT ================= */

bot.onText(/\/logout/, async (msg) => {
  const id = msg.from.id;
  const path = `sessions/${id}`;

  if (!(await fs.pathExists(`${path}/creds.json`)))
    return bot.sendMessage(msg.chat.id, "No linked account.");

  await fs.remove(path);
  bot.sendMessage(msg.chat.id, "✅ Logged out.");
});

/* ================= QR LOGIN ================= */

bot.onText(/\/login/, async (msg) => {
  const id = msg.from.id;

  if (activeSessions.has(id))
    return bot.sendMessage(msg.chat.id, "Process already running.");

  startConnection(msg, id, "qr");
});

/* ================= PAIR COMMAND ================= */

bot.onText(/\/pair/, (msg) => {
  const id = msg.from.id;

  if (activeSessions.has(id))
    return bot.sendMessage(msg.chat.id, "Process already running.");

  waitingNumbers.set(id, true);
  bot.sendMessage(msg.chat.id, "Send number with country code.\nExample: 8801XXXXXXXXX");
});

/* ================= RECEIVE NUMBER ================= */

bot.on("message", async (msg) => {
  const id = msg.from.id;
  if (!waitingNumbers.has(id)) return;
  if (!msg.text) return;

  waitingNumbers.delete(id);

  const number = msg.text.replace(/[^0-9]/g, "");

  if (number.length < 8)
    return bot.sendMessage(msg.chat.id, "Invalid number format.");

  startConnection(msg, id, "pair", number);
});

/* ================= MAIN FUNCTION ================= */

async function startConnection(msg, id, mode, number = null) {

  const path = `sessions/${id}`;
  await fs.ensureDir(path);

  const { state, saveCreds } = await useMultiFileAuthState(path);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  sock.ev.on("creds.update", saveCreds);

  activeSessions.set(id, { sock, path });

  let success = false;

  /* ===== PAIR MODE ===== */
  if (mode === "pair") {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(number);

        await bot.sendMessage(
          msg.chat.id,
          `🔐 Pair Code:\n\n*${code}*\n\nWhatsApp → Linked Devices → Link with phone number\n\nValid 2 minutes.`,
          { parse_mode: "Markdown" }
        );

      } catch (err) {
        activeSessions.delete(id);
        await fs.remove(path);
        bot.sendMessage(msg.chat.id, "❌ Failed to generate pairing code.");
      }
    }, 4000);
  }

  /* ===== EVENTS ===== */

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (mode === "qr" && qr) {
      const qrImage = await qrcode.toBuffer(qr);
      await bot.sendPhoto(msg.chat.id, qrImage, {
        caption: "Scan within 2 minutes."
      });
    }

    if (connection === "open") {
      success = true;
      activeSessions.delete(id);
      bot.sendMessage(msg.chat.id, "✅ WhatsApp linked successfully.");
    }

    if (connection === "close") {
      const loggedOut =
        lastDisconnect?.error?.output?.statusCode ===
        DisconnectReason.loggedOut;

      if (!success || loggedOut) {
        activeSessions.delete(id);
        await fs.remove(path);
      }
    }
  });

  /* ===== TIMEOUT ===== */

  setTimeout(async () => {
    if (!success && activeSessions.has(id)) {
      try { sock.end(); } catch {}
      activeSessions.delete(id);
      await fs.remove(path);
      bot.sendMessage(msg.chat.id, "⏰ Session expired.");
    }
  }, 120000);
}

console.log("🚀 Bot running...");
