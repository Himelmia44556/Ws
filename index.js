const TelegramBot = require("node-telegram-bot-api")
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys")

const P = require("pino")
const QRCode = require("qrcode")
const fs = require("fs")

// 🔥 PUT YOUR BOT TOKEN HERE
const BOT_TOKEN = "8739857066:AAFs5DzC4Mv93LJHBJEhSKzQVwrcKJlW6tc"

const bot = new TelegramBot(BOT_TOKEN, { polling: true })

const sessions = new Map()
const loginProcess = new Map()

const small = (t) => t.toLowerCase()

// START
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    small(
`welcome to whatsapp login bot

/qr
/logout
/cancel`
    )
  )
})

// QR COMMAND
bot.onText(/\/qr/, async (msg) => {
  const id = msg.from.id

  if (sessions.has(id)) {
    return bot.sendMessage(id, small("you already logged in one account. logout first."))
  }

  if (loginProcess.has(id)) {
    return bot.sendMessage(id, small("already in login process."))
  }

  loginProcess.set(id, true)

  const sessionPath = `./sessions/${id}`

  if (!fs.existsSync("./sessions")) fs.mkdirSync("./sessions")

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" })
  })

  sock.ev.on("creds.update", saveCreds)

  let timeout

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update

    if (qr) {
      const qrImage = await QRCode.toBuffer(qr)

      await bot.sendPhoto(id, qrImage, {
        caption: small("scan this qr within 1 minute.")
      })

      timeout = setTimeout(async () => {
        loginProcess.delete(id)
        await sock.logout()
        fs.rmSync(sessionPath, { recursive: true, force: true })
        bot.sendMessage(id, small("qr expired. login cancelled."))
      }, 60000)
    }

    if (connection === "open") {
      clearTimeout(timeout)
      loginProcess.delete(id)
      sessions.set(id, sock)
      bot.sendMessage(id, small("login successful."))
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut

      if (!shouldReconnect) {
        sessions.delete(id)
        loginProcess.delete(id)
        fs.rmSync(sessionPath, { recursive: true, force: true })
      }
    }
  })
})

// CANCEL
bot.onText(/\/cancel/, async (msg) => {
  const id = msg.from.id

  if (!loginProcess.has(id)) {
    return bot.sendMessage(id, small("no active login process."))
  }

  loginProcess.delete(id)

  const sessionPath = `./sessions/${id}`
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true })
  }

  bot.sendMessage(id, small("login process cancelled."))
})

// LOGOUT
bot.onText(/\/logout/, async (msg) => {
  const id = msg.from.id

  if (!sessions.has(id)) {
    return bot.sendMessage(id, small("no active session found."))
  }

  const sock = sessions.get(id)
  await sock.logout()

  sessions.delete(id)

  const sessionPath = `./sessions/${id}`
  fs.rmSync(sessionPath, { recursive: true, force: true })

  bot.sendMessage(id, small("logged out successfully."))
})
