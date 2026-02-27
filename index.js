require("dotenv").config();

const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const TelegramBot = require("node-telegram-bot-api");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const P = require("pino");

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const sessions = new Map();
const loginProcesses = new Map();

//////////////////////////////////////////////////////

async function startLogin(userId) {

    if (sessions.has(userId))
        return bot.sendMessage(userId, "⚠️ ᴀʟʀᴇᴀᴅʏ ʟɪɴᴋᴇᴅ.");

    if (loginProcesses.has(userId))
        return bot.sendMessage(userId, "⏳ ʟᴏɢɪɴ ɪɴ ᴘʀᴏᴄᴇꜱꜱ.");

    const sessionPath = path.join(__dirname, "sessions", userId.toString());
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
        auth: state,
        logger: P({ level: "silent" })
    });

    loginProcesses.set(userId, sock);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {

        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            const qrImage = await QRCode.toBuffer(qr);

            await bot.sendPhoto(userId, qrImage, {
                caption: "🔐 ꜱᴄᴀɴ ᴡɪᴛʜɪɴ 1 ᴍɪɴᴜᴛᴇ.\n❌ /cancel ᴛᴏ ꜱᴛᴏᴘ."
            });

            // 1 minute timeout
            setTimeout(async () => {
                if (loginProcesses.has(userId)) {
                    await sock.logout();
                    loginProcesses.delete(userId);
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                    bot.sendMessage(userId, "⌛ ǫʀ ᴇxᴘɪʀᴇᴅ.");
                }
            }, 60000);
        }

        if (connection === "open") {
            loginProcesses.delete(userId);
            sessions.set(userId, sock);
            bot.sendMessage(userId, "✅ ʟɪɴᴋᴇᴅ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟʟʏ.");
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

            if (!shouldReconnect) {
                sessions.delete(userId);
                fs.rmSync(sessionPath, { recursive: true, force: true });
                bot.sendMessage(userId, "⚠️ ᴅɪꜱᴄᴏɴɴᴇᴄᴛᴇᴅ.");
            }
        }
    });
}

//////////////////////////////////////////////////////

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
`✨ ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ᴡʜᴀᴛꜱᴀᴘᴘ ʟᴏɢɪɴ ʙᴏᴛ

/qr — ʟᴏɢɪɴ
/logout — ʟᴏɢᴏᴜᴛ
/cancel — ᴄᴀɴᴄᴇʟ`
    );
});

bot.onText(/\/qr/, (msg) => {
    startLogin(msg.chat.id);
});

bot.onText(/\/cancel/, async (msg) => {

    const userId = msg.chat.id;

    if (!loginProcesses.has(userId))
        return bot.sendMessage(userId, "❌ ɴᴏ ʟᴏɢɪɴ ᴘʀᴏᴄᴇꜱꜱ.");

    const sock = loginProcesses.get(userId);
    await sock.logout();

    const sessionPath = path.join(__dirname, "sessions", userId.toString());
    fs.rmSync(sessionPath, { recursive: true, force: true });

    loginProcesses.delete(userId);

    bot.sendMessage(userId, "❌ ʟᴏɢɪɴ ᴄᴀɴᴄᴇʟʟᴇᴅ.");
});

bot.onText(/\/logout/, async (msg) => {

    const userId = msg.chat.id;

    if (!sessions.has(userId))
        return bot.sendMessage(userId, "❌ ɴᴏ ᴀᴄᴛɪᴠᴇ ꜱᴇꜱꜱɪᴏɴ.");

    const sock = sessions.get(userId);
    await sock.logout();

    const sessionPath = path.join(__dirname, "sessions", userId.toString());
    fs.rmSync(sessionPath, { recursive: true, force: true });

    sessions.delete(userId);

    bot.sendMessage(userId, "✅ ʟᴏɢᴏᴜᴛ ꜱᴜᴄᴄᴇꜱꜱ.");
});
