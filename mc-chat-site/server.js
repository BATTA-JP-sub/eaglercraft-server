const express = require('express')
const http = require('http')
const dns = require('dns').promises
const net = require('net')
const WebSocket = require('ws')
const mineflayer = require('mineflayer')

// ===== 設定（環境変数で変更可能）=====
// 画面でサーバーを指定しなかった場合の接続先
const DEFAULT_SERVER = process.env.MC_WS_URL || 'wss://mc.lampnetwork.net'
// GitHub Pagesなど別ドメインのフロントから使う場合だけ設定（例: https://あなたのID.github.io）
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''
// 接続できるサーバーを限定したい場合だけ設定（例: mc.lampnetwork.net,example.com）。空なら制限なし
const ALLOWED_SERVERS = (process.env.ALLOWED_SERVERS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
const CHAT_INTERVAL_MS = 1500 // 連続送信の最短間隔（スパム防止）
const MAX_CHAT_LENGTH = 256
// ====================================

// 内部ネットワークへの接続（踏み台悪用）を防ぐためのチェック
const isPrivateIp = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    )
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase()
    if (v.startsWith('::ffff:')) {
      const rest = v.slice(7)
      return rest.includes('.') ? isPrivateIp(rest) : true
    }
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')
  }
  return true
}

// 入力を解釈して接続先を決める
//  - wss://... / ws://...  → WebSocket経由（kind: 'ws'）
//  - host[:port]           → 普通のJava版（TCP）（kind: 'tcp'）
const parseTarget = async (input) => {
  let target
  if (/^wss?:\/\//i.test(input)) {
    let u
    try {
      u = new URL(input)
    } catch {
      throw new Error('サーバーURLの形式が正しくありません')
    }
    target = { kind: 'ws', url: u.toString(), host: u.hostname.replace(/^\[|\]$/g, '').toLowerCase() }
  } else {
    const m = input.replace(/^(tcp|mc|minecraft):\/\//i, '').match(/^([^:/\s]+)(?::(\d{1,5}))?\/?$/)
    if (!m) throw new Error('サーバーの形式が正しくありません（例: wss://example.com や mc.example.com:25565）')
    const port = m[2] ? Number(m[2]) : 25565
    if (port < 1 || port > 65535) throw new Error('ポート番号が正しくありません')
    target = { kind: 'tcp', host: m[1].toLowerCase(), port }
  }

  if (ALLOWED_SERVERS.length && !ALLOWED_SERVERS.includes(target.host)) {
    throw new Error('このサーバーには接続できません（許可リスト外）')
  }
  let addrs
  try {
    addrs = net.isIP(target.host) ? [{ address: target.host }] : await dns.lookup(target.host, { all: true })
  } catch {
    throw new Error('サーバーのアドレスを解決できませんでした')
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('このサーバーには接続できません')
  }
  return target
}

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
  let connecting = false
  let lastChatAt = 0
  let heartbeat = null
 
  const send = (type, text) => {
    if (ui.readyState === WebSocket.OPEN) ui.send(JSON.stringify({ type, text }))
  }

  const startBot = (username, auth, target, version) => {
    send('status', `接続中... (${target.kind === 'ws' ? target.url : target.host + ':' + target.port})`)

    const options = {
      username,
      auth, // 'microsoft' or 'offline'
      // パスワードは扱わず、Microsoftのデバイスコード認証を画面に表示する
      onMsaCode: (data) =>
        send('auth', `${data.verification_uri} を開いて、コード ${data.user_code} を入力してください`),
    }
    if (version) options.version = version

    if (target.kind === 'ws') {
      // wss:// 経由で接続する
      options.connect = (client) => {
        const ws = new WebSocket(target.url)
        const stream = WebSocket.createWebSocketStream(ws)
        stream.on('error', (e) => client.emit('error', e))
        client.setSocket(stream)
        client.emit('connect')
      }
    } else {
      // 普通のJava版（TCP）で接続する
      options.host = target.host
      options.port = target.port
    }

    bot = mineflayer.createBot(options)

    bot.once('spawn', () => {
      send('status', 'ログイン完了')
      // 切断の原因を調べるための生存確認（5秒おき）
      heartbeat = setInterval(() => {
        if (!bot) return
        send('status', `生存確認 (${new Date().toLocaleTimeString('ja-JP')})`)
      }, 10000)
    })
    bot.on('message', (m) => send('chat', m.toString()))
    bot.on('kicked', (reason) => send('error', 'kicked: ' + reason))
    bot.on('error', (e) => send('error', String(e)))
    bot.on('end', (reason) => {
      send('status', '切断されました: ' + reason)
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      bot = null
    })
  }

  ui.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.type === 'login') {
      if (bot || connecting) return send('error', 'すでに接続中です')
      const username = String(msg.username || '').trim().slice(0, 64)
      if (!username) return send('error', 'ユーザー名を入力してください')
      const auth = msg.auth === 'offline' ? 'offline' : 'microsoft'
      const serverInput = String(msg.server || '').trim() || DEFAULT_SERVER
      const version = String(msg.version || '').trim().slice(0, 16)

      connecting = true
      try {
        const target = await parseTarget(serverInput)
        if (ui.readyState === WebSocket.OPEN) startBot(username, auth, target, version)
      } catch (e) {
        send('error', e.message)
      } finally {
        connecting = false
      }
    }

    if (msg.type === 'chat') {
      if (!bot) return send('error', '先にログインしてください')
      const text = String(msg.text || '').trim().slice(0, MAX_CHAT_LENGTH)
      if (!text) return
      bot.chat(text)
      send('sent', text)
    }

    if (msg.type === 'logout' && bot) {
      bot.quit()
    }
  })

  ui.on('close', () => {
    if (heartbeat) clearInterval(heartbeat)
    if (bot) bot.quit()
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`http://localhost:${PORT}`))
