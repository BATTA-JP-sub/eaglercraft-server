const express = require('express')
const http = require('http')
const WebSocket = require('ws')
const mineflayer = require('mineflayer')

// ===== 設定（環境変数で変更可能）=====
const MC_WS_URL = process.env.MC_WS_URL || 'wss://mc.lampnetwork.net'
// GitHub Pagesなど別ドメインのフロントから使う場合だけ設定（例: https://あなたのID.github.io）
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''
const CHAT_INTERVAL_MS = 1500 // 連続送信の最短間隔（スパム防止）
const MAX_CHAT_LENGTH = 256
// ====================================

const app = express()
app.use(express.static('public'))
app.get('/health', (_, res) => res.send('ok'))

const server = http.createServer(app)
const wss = new WebSocket.Server({
  server,
  verifyClient: ({ origin }) => !ALLOWED_ORIGIN || origin === ALLOWED_ORIGIN,
})

wss.on('connection', (ui) => {
  let bot = null
  let lastChatAt = 0

  const send = (type, text) => {
    if (ui.readyState === WebSocket.OPEN) ui.send(JSON.stringify({ type, text }))
  }

  const startBot = (username, auth) => {
    send('status', '接続中...')
    bot = mineflayer.createBot({
      username,
      auth, // 'microsoft' or 'offline'
      // パスワードは扱わず、Microsoftのデバイスコード認証を画面に表示する
      onMsaCode: (data) =>
        send('auth', `${data.verification_uri} を開いて、コード ${data.user_code} を入力してください`),
      // wss:// 経由で接続する
      connect: (client) => {
        const ws = new WebSocket(MC_WS_URL)
        const stream = WebSocket.createWebSocketStream(ws)
        stream.on('error', (e) => client.emit('error', e))
        client.setSocket(stream)
        client.emit('connect')
      },
    })

    bot.once('spawn', () => send('status', 'ログイン完了'))
    bot.on('message', (m) => send('chat', m.toString()))
    bot.on('kicked', (reason) => send('error', 'kicked: ' + reason))
    bot.on('error', (e) => send('error', String(e)))
    bot.on('end', () => {
      send('status', '切断されました')
      bot = null
    })
  }

  ui.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.type === 'login') {
      if (bot) return send('error', 'すでに接続中です')
      const username = String(msg.username || '').trim().slice(0, 64)
      if (!username) return send('error', 'ユーザー名を入力してください')
      const auth = msg.auth === 'offline' ? 'offline' : 'microsoft'
      startBot(username, auth)
    }

    if (msg.type === 'chat') {
      if (!bot) return send('error', '先にログインしてください')
      const text = String(msg.text || '').trim().slice(0, MAX_CHAT_LENGTH)
      if (!text) return
      const now = Date.now()
      if (now - lastChatAt < CHAT_INTERVAL_MS) return send('error', '送信が早すぎます')
      lastChatAt = now
      bot.chat(text)
    }

    if (msg.type === 'logout' && bot) {
      bot.quit()
    }
  })

  ui.on('close', () => {
    if (bot) bot.quit()
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`http://localhost:${PORT}`))
