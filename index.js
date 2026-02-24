const {
  default: makeWASocket,
  useMultiFileAuthState,
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
`🤖 Welcome

/login - Login WhatsApp (QR)
/pair - Login via phone number
/logout - Logout
/cancel - Cancel login`
  );
});

/* ================= CANCEL ================= */

bot.onText(/\/cancel/, async (msg) => {
  const userId = msg.from.id;

  if (!activeLogins.has(userId)) {
    return bot.sendMessage(msg.chat.id, "❌ No active login process.");
  }

  const { sock } = activeLogins.get(userId);
  const sessionPath = `sessions/${userId}`;

  try {
    if (sock) {
      await sock.logout().catch(() => {});
      sock.ws.close();
    }
  } catch {}

  activeLogins.delete(userId);
  await fs.remove(sessionPath);

  bot.sendMessage(msg.chat.id, "❌ Login process cancelled.");
});

/* ================= LOGOUT ================= */

bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  if (!(await fs.pathExists(credsPath))) {
    return bot.sendMessage(
      msg.chat.id,
      "❌ No linked WhatsApp account found."
    );
  }

  const { state } = await useMultiFileAuthState(sessionPath);

  // 🔎 CHECK IF REALLY LINKED
  if (!state.creds.registered) {
    await fs.remove(sessionPath);
    activeLogins.delete(userId);
    return bot.sendMessage(
      msg.chat.id,
      "❌ WhatsApp was not fully linked."
    );
  }

  try {
    const version = [2, 2413, 1];

    const sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: "silent" })
    });

    await sock.logout().catch(() => {});
    sock.ws.close();
  } catch {}

  await fs.remove(sessionPath);
  activeLogins.delete(userId);

  bot.sendMessage(msg.chat.id, "✅ WhatsApp logged out successfully.");
});

/* ================= LOGIN (QR METHOD) ================= */

bot.onText(/\/login/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  if (activeLogins.has(userId)) {
    return bot.sendMessage(msg.chat.id, "⚠️ Login already in progress.");
  }

  if (await fs.pathExists(credsPath)) {
    return bot.sendMessage(msg.chat.id, "✅ Already logged in.");
  }

  await fs.ensureDir(sessionPath);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const version = [2, 2413, 1];

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

      const qrImage = await qrcode.toBuffer(qr);

      await bot.sendPhoto(msg.chat.id, qrImage, {
        caption: "📱 Scan within 2 minutes."
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

/* ================= PAIR VIA NUMBER ================= */

bot.onText(/\/pair/, async (msg) => {
  const userId = msg.from.id;
  const sessionPath = `sessions/${userId}`;
  const credsPath = `${sessionPath}/creds.json`;

  if (activeLogins.has(userId)) {
    return bot.sendMessage(msg.chat.id, "⚠️ Login already in progress.");
  }

  if (await fs.pathExists(credsPath)) {
    return bot.sendMessage(msg.chat.id, "✅ Already logged in.");
  }

  bot.sendMessage(
    msg.chat.id,
    "📱 Send your WhatsApp number with country code.\nExample: 8801XXXXXXXXX"
  );

  bot.once("message", async (numberMsg) => {
    if (numberMsg.chat.id !== msg.chat.id) return;

    const phoneNumber = numberMsg.text.replace(/[^0-9]/g, "");

    if (!phoneNumber || phoneNumber.length < 8) {
      return bot.sendMessage(msg.chat.id, "❌ Invalid number.");
    }

    await fs.ensureDir(sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const version = [2, 2413, 1];

    const sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: "silent" })
    });

    sock.ev.on("creds.update", saveCreds);
    activeLogins.set(userId, { sock });

    let loginSuccess = false;

    sock.ev.once("connection.update", async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);

        await bot.sendMessage(
          msg.chat.id,
`🔢 Your Pairing Code:

${code}

⏳ Expires in 2 minutes

Open WhatsApp:
Linked Devices → Link a Device → Link with phone number`
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
        await fs.remove(sessionPath);
        activeLogins.delete(userId);
        bot.sendMessage(msg.chat.id, "❌ Failed to generate pairing code.");
      }
    });

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
  });
});

console.log("🚀 Bot started...");