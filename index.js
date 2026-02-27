const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');

const TELEGRAM_TOKEN = "8739857066:AAFs5DzC4Mv93LJHBJEhSKzQVwrcKJlW6tc";

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const sessions = new Map();
const loginProcesses = new Map();

function deleteSessionFolder(userId) {
    const sessionPath = path.join('./sessions', `session-${userId}`);
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }
}

function startLogin(userId) {

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: userId.toString(),
            dataPath: './sessions'
        }),
        puppeteer: { headless: true }
    });

    let authenticated = false;

    client.on('qr', async (qr) => {

        const qrImage = await QRCode.toBuffer(qr);

        await bot.sendPhoto(userId, qrImage, {
            caption:
`🔐 ᴡʜᴀᴛꜱᴀᴘᴘ ʟᴏɢɪɴ ǫʀ

⏳ ᴘʟᴇᴀꜱᴇ ꜱᴄᴀɴ ᴡɪᴛʜɪɴ 1 ᴍɪɴᴜᴛᴇ.
❌ ᴜꜱᴇ /ᴄᴀɴᴄᴇʟ ᴛᴏ ꜱᴛᴏᴘ ʟᴏɢɪɴ.`
        });

        const timeout = setTimeout(async () => {
            if (!authenticated) {
                await client.destroy();
                deleteSessionFolder(userId);
                loginProcesses.delete(userId);

                bot.sendMessage(userId,
`⌛ ǫʀ ᴇxᴘɪʀᴇᴅ

ꜱᴇꜱꜱɪᴏɴ ᴀᴜᴛᴏᴍᴀᴛɪᴄᴀʟʟʏ ᴄᴀɴᴄᴇʟʟᴇᴅ.`);
            }
        }, 60 * 1000);

        loginProcesses.set(userId, { client, timeout });
    });

    client.on('authenticated', () => {
        authenticated = true;
    });

    client.on('ready', () => {

        authenticated = true;

        if (loginProcesses.has(userId)) {
            clearTimeout(loginProcesses.get(userId).timeout);
            loginProcesses.delete(userId);
        }

        sessions.set(userId, client);

        bot.sendMessage(userId,
`✅ ᴡʜᴀᴛꜱᴀᴘᴘ ʟɪɴᴋᴇᴅ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟʟʏ!

ʏᴏᴜʀ ᴀᴄᴄᴏᴜɴᴛ ɪꜱ ɴᴏᴡ ᴄᴏɴɴᴇᴄᴛᴇᴅ.`);
    });

    client.on('disconnected', () => {
        sessions.delete(userId);
        deleteSessionFolder(userId);

        bot.sendMessage(userId,
`⚠️ ᴡʜᴀᴛꜱᴀᴘᴘ ᴅɪꜱᴄᴏɴɴᴇᴄᴛᴇᴅ

ꜱᴇꜱꜱɪᴏɴ ʀᴇᴍᴏᴠᴇᴅ.`);
    });

    client.initialize();
}

//////////////////////////////////////////////////////
// /start
//////////////////////////////////////////////////////

bot.onText(/\/start/, (msg) => {

    const welcomeText =
`✨ ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ᴡʜᴀᴛꜱᴀᴘᴘ ʟᴏɢɪɴ ʙᴏᴛ

ꜱᴇᴄᴜʀᴇʟʏ ʟɪɴᴋ ʏᴏᴜʀ ᴡʜᴀᴛꜱᴀᴘᴘ ᴀᴄᴄᴏᴜɴᴛ.

━━━━━━━━━━━━━━━━━━
🔹 /ǫʀ — ʟᴏɢɪɴ ᴡʜᴀᴛꜱᴀᴘᴘ
🔹 /ʟᴏɢᴏᴜᴛ — ʟᴏɢᴏᴜᴛ ᴀᴄᴄᴏᴜɴᴛ
🔹 /ᴄᴀɴᴄᴇʟ — ᴄᴀɴᴄᴇʟ ʟᴏɢɪɴ
━━━━━━━━━━━━━━━━━━

⚠️ ᴇᴀᴄʜ ᴜꜱᴇʀ ᴄᴀɴ ʟɪɴᴋ ᴏɴʟʏ ᴏɴᴇ ᴀᴄᴄᴏᴜɴᴛ.`;

    bot.sendMessage(msg.chat.id, welcomeText);
});

//////////////////////////////////////////////////////
// /qr
//////////////////////////////////////////////////////

bot.onText(/\/qr/, (msg) => {

    const userId = msg.chat.id;

    if (sessions.has(userId)) {
        return bot.sendMessage(userId,
`⚠️ ᴀᴄᴄᴏᴜɴᴛ ᴀʟʀᴇᴀᴅʏ ʟɪɴᴋᴇᴅ

ʏᴏᴜ ᴄᴀɴɴᴏᴛ ʟɪɴᴋ ᴍᴜʟᴛɪᴘʟᴇ ᴀᴄᴄᴏᴜɴᴛꜱ.`);
    }

    if (loginProcesses.has(userId)) {
        return bot.sendMessage(userId,
`⏳ ʟᴏɢɪɴ ᴀʟʀᴇᴀᴅʏ ɪɴ ᴘʀᴏᴄᴇꜱꜱ

ꜱᴄᴀɴ ᴛʜᴇ ǫʀ ᴏʀ ᴜꜱᴇ /ᴄᴀɴᴄᴇʟ.`);
    }

    startLogin(userId);
});

//////////////////////////////////////////////////////
// /cancel
//////////////////////////////////////////////////////

bot.onText(/\/cancel/, async (msg) => {

    const userId = msg.chat.id;

    if (!loginProcesses.has(userId)) {
        return bot.sendMessage(userId,
`❌ ɴᴏ ᴀᴄᴛɪᴠᴇ ʟᴏɢɪɴ ᴘʀᴏᴄᴇꜱꜱ.`);
    }

    const { client, timeout } = loginProcesses.get(userId);

    clearTimeout(timeout);
    await client.destroy();
    deleteSessionFolder(userId);
    loginProcesses.delete(userId);

    bot.sendMessage(userId,
`❌ ʟᴏɢɪɴ ᴄᴀɴᴄᴇʟʟᴇᴅ

ꜱᴇꜱꜱɪᴏɴ ᴅᴇʟᴇᴛᴇᴅ.`);
});

//////////////////////////////////////////////////////
// /logout
//////////////////////////////////////////////////////

bot.onText(/\/logout/, async (msg) => {

    const userId = msg.chat.id;

    if (!sessions.has(userId)) {
        return bot.sendMessage(userId,
`❌ ɴᴏ ᴀᴄᴛɪᴠᴇ ᴡʜᴀᴛꜱᴀᴘᴘ ꜱᴇꜱꜱɪᴏɴ.`);
    }

    const client = sessions.get(userId);

    await client.logout();
    await client.destroy();

    deleteSessionFolder(userId);
    sessions.delete(userId);

    bot.sendMessage(userId,
`✅ ʟᴏɢɢᴇᴅ ᴏᴜᴛ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟʟʏ

ʏᴏᴜʀ ꜱᴇꜱꜱɪᴏɴ ʜᴀꜱ ʙᴇᴇɴ ʀᴇᴍᴏᴠᴇᴅ.`);
});