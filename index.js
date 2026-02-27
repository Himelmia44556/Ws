const TelegramBot = require("node-telegram-bot-api");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const P = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");

const BOT_TOKEN = "8739857066:AAFs5DzC4Mv93LJHBJEhSKzQVwrcKJlW6tc";

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const sessions = new Map();
const loginProcess = new Map();

// start command
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ᴡʜᴀᴛsᴀᴘᴘ ʟᴏɢɪɴ ʙᴏᴛ

/qr
/logout
/cancel`
  );
});

// qr command
bot.onText(/\/qr/, async (msg) => {
  const id = msg.from.id;

  if (sessions.has(id)) {
    return bot.sendMessage(id, "ʏᴏᴜ ᴀʟʀᴇᴀᴅʏ ʟᴏɢɢᴇᴅ ɪɴ. ʟᴏɢᴏᴜᴛ ғɪʀsᴛ.");
  }

  if (loginProcess.has(id)) {
    return bot.sendMessage(id, "ᴀʟʀᴇᴀᴅʏ ɪɴ ʟᴏɢɪɴ ᴘʀᴏᴄᴇss.");
  }

  loginProcess.set(id, true);

  const sessionPath = `./sessions/${id}`;

  if (!fs.existsSync("./sessions")) {
    fs.mkdirSync("./sessions");
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["ubuntu", "chrome", "20.0.04"],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    defaultQueryTimeoutMs: 0
  });

  sock.ev.on("creds.update", saveCreds);

  let timeout;

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      try {
        const qrImage = await QRCode.toBuffer(qr);

        await bot.sendPhoto(id, qrImage, {
          caption: "sᴄᴀɴ ᴛʜɪs ǫʀ ᴡɪᴛʜɪɴ 1 ᴍɪɴᴜᴛᴇ."
        });

        timeout = setTimeout(async () => {
          loginProcess.delete(id);
          try { await sock.logout(); } catch {}
          fs.rmSync(sessionPath, { recursive: true, force: true });
          bot.sendMessage(id, "ǫʀ ᴇxᴘɪʀᴇᴅ. ʟᴏɢɪɴ ᴄᴀɴᴄᴇʟʟᴇᴅ.");
        }, 60000);

      } catch (err) {
        console.log("qr error:", err);
        bot.sendMessage(id, "ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇɴᴇʀᴀᴛᴇ ǫʀ.");
      }
    }

    if (connection === "open") {
      clearTimeout(timeout);
      loginProcess.delete(id);
      sessions.set(id, sock);
      bot.sendMessage(id, "ʟᴏɢɪɴ sᴜᴄᴄᴇssғᴜʟ.");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("connection closed unexpectedly.");
        loginProcess.delete(id);
      } else {
        sessions.delete(id);
        loginProcess.delete(id);
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
    }
  });
});

// cancel command
bot.onText(/\/cancel/, (msg) => {
  const id = msg.from.id;

  if (!loginProcess.has(id)) {
    return bot.sendMessage(id, "ɴᴏ ᴀᴄᴛɪᴠᴇ ʟᴏɢɪɴ ᴘʀᴏᴄᴇss.");
  }

  loginProcess.delete(id);

  const sessionPath = `./sessions/${id}`;
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }

  bot.sendMessage(id, "ʟᴏɢɪɴ ᴘʀᴏᴄᴇss ᴄᴀɴᴄᴇʟʟᴇᴅ.");
});

// logout command
bot.onText(/\/logout/, async (msg) => {
  const id = msg.from.id;

  if (!sessions.has(id)) {
    return bot.sendMessage(id, "ɴᴏ ᴀᴄᴛɪᴠᴇ sᴇssɪᴏɴ ғᴏᴜɴᴅ.");
  }

  const sock = sessions.get(id);

  try {
    await sock.logout();
  } catch {}

  sessions.delete(id);

  const sessionPath = `./sessions/${id}`;
  fs.rmSync(sessionPath, { recursive: true, force: true });

  bot.sendMessage(id, "ʟᴏɢɢᴇᴅ ᴏᴜᴛ sᴜᴄᴄᴇssғᴜʟʟʏ.");
});

// prevent railway sleep
setInterval(() => {}, 10000);
