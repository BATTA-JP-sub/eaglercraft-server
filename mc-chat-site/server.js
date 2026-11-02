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
  // スポーン地点（プレイヤー座標）の定義
const spawnPos = { x: 0.0, y: 64.0, z: 0.0 };
const lookAngle = { yaw: 0.0, pitch: 0.0 };
const onGround = true;

// 1. CPacketPlayer (位置・向きの更新なし、接地フラグのみ)
const cPacketPlayer = {
    onGround: onGround
};

// 2. CPacketPlayerPosition (位置のみ)
const cPacketPlayerPosition = {
    x: spawnPos.x,
    y: spawnPos.y,
    z: spawnPos.z,
    onGround: onGround
};

// 3. CPacketPlayerLook (向きのみ)
const cPacketPlayerLook = {
    yaw: lookAngle.yaw,
    pitch: lookAngle.pitch,
    onGround: onGround
};

// 4. CPacketPlayerPosLook (位置と向きの両方)
const cPacketPlayerPosLook = {
    x: spawnPos.x,
    y: spawnPos.y,
    z: spawnPos.z,
    yaw: lookAngle.yaw,
    pitch: lookAngle.pitch,
    onGround: onGround
};

// 5. CPacketAnimation (腕を振るモーション)
const cPacketAnimation = {
    hand: 0 // 0: 主流手 (Main Hand), 1: 利き手ではない方 (Off Hand)
};

// 6. CPacketUseEntity (実体に対するインタラクト/攻撃)
const cPacketUseEntity = {
    target: 1234, // ターゲットとなるEntityのID
    type: 0,      // 0: インタラクト, 1: 攻撃, 2: 指定位置にインタラクト
    // mouseX: 0.0, mouseY: 0.0, mouseZ: 0.0, // typeが2の場合のみ必要
    hand: 0
};

// 7. CPacketPlayerDigging (ブロックの採掘/破壊状態の変更)
const cPacketPlayerDigging = {
    status: 0, // 0: 掘り始め, 1: 掘りキャンセル, 2: 掘り完了, 3: アイテムドロップなど
    location: { x: 0, y: 63, z: 0 },
    face: 1    // 1: 上面 (Top)
};

// 8. CPacketTryUseItemOnBlock (ブロックに対してアイテムを使用する/右クリック)
const cPacketTryUseItemOnBlock = {
    location: { x: 0, y: 63, z: 0 },
    face: 1,   // 1: 上面 (Top)
    hand: 0,   // 0: Main Hand
    cursorX: 0.5,
    cursorY: 0.5,
    cursorZ: 0.5
};

// 9. CPacketChatMessage (チャットメッセージの送信)
const cPacketChatMessage = {
    message: "Hello world!"
};

// 10. CPacketClientStatus (クライアントの状態変更。リスポーンや実績画面の要求)
const cPacketClientStatus = {
    action: 0 // 0: パフォーマンス/リスポーン要求, 1: 統計情報の要求
};

// 11. CPacketClickWindow (インベントリ内をクリック)
const cPacketClickWindow = {
    windowId: 0,     // 0: プレイヤーのインベントリ
    slot: 36,        // スロット番号
    button: 0,       // 0: 左クリック, 1: 右クリック
    mode: 0,         // 0: 通常クリック
    id: 1,           // トランザクションID（連番）
    item: { blockId: -1 } // クリックしたアイテム（-1は空）
};

// 12. CPacketCloseWindow (インベントリ画面を閉じる)
const cPacketCloseWindow = {
    windowId: 0
};

// 13. CPacketHeldItemChange (スロットの切り替え)
const cPacketHeldItemChange = {
    slotId: 0 // 0〜8 (ホットバーのスロット)
};

/**
 * 仮想的なパケット送信関数
 * 使用するライブラリ（mineflayerや独自クライアント）の送信メソッドに置き換えてください。
 */
function sendPacket(packetName, data) {
    // 例: client.write(packetName, data);
    console.log(`[送信成功] パケット名: ${packetName}`, JSON.stringify(data));
}

// まとめて送信を実行
function sendAllPackets() {
    sendPacket('teleport_confirm', { teleportId: 1 }); // 通常、移動前にはテレポート確定が必要な場合がある
    sendPacket('position', cPacketPlayerPosition);
    sendPacket('look', cPacketPlayerLook);
    sendPacket('position_look', cPacketPlayerPosLook);
    sendPacket('arm_animation', cPacketAnimation);
    sendPacket('use_entity', cPacketUseEntity);
    sendPacket('block_dig', cPacketPlayerDigging);
    sendPacket('block_place', cPacketTryUseItemOnBlock);
    sendPacket('chat', cPacketChatMessage);
    sendPacket('client_command', cPacketClientStatus);
    sendPacket('window_click', cPacketClickWindow);
    sendPacket('close_window', cPacketCloseWindow);
    sendPacket('held_item_slot', cPacketHeldItemChange);
}

// 実行
sendAllPackets();


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
