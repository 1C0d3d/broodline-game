import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'

const PROTOCOL_VERSION = 1
const MAX_PLAYERS = 4
const MAX_GUESTS = MAX_PLAYERS - 1
const MAX_ROOMS = 16
const MAX_CONNECTIONS = 64
const RECONNECT_GRACE_MS = 60_000
const WS_PATH = '/broodline/ws'
const host = '0.0.0.0'
const requestedPort = Number.parseInt(process.env.BROODLINE_PORT ?? '8080', 10)
const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65_535 ? requestedPort : 8080
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDirectory, 'game')
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const mime = {
  '.css': 'text/css; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

/** @type {Map<string, any>} */
const rooms = new Map()
/** @type {WeakMap<import('ws').WebSocket, any>} */
const clients = new WeakMap()

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeSequence(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
}

function isJsonValue(value, depth = 0) {
  if (depth > 12) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 2_048 && value.every((entry) => isJsonValue(entry, depth + 1))
  if (!isRecord(value) || Object.keys(value).length > 512) return false
  return Object.values(value).every((entry) => isJsonValue(entry, depth + 1))
}

function normalizeName(value) {
  if (typeof value !== 'string') return 'OPERATIVE'
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16)
  return normalized || 'OPERATIVE'
}

function normalizeBuildId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 80) : ''
}

function normalizeRoomCode(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) : ''
}

function roomCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = randomBytes(6)
    let code = ''
    for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length]
    if (!rooms.has(code)) return code
  }
  throw new Error('Could not allocate a LAN room code')
}

function resumeToken() {
  return randomBytes(24).toString('base64url')
}

function send(socket, message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  const encoded = JSON.stringify(message)
  if (encoded.length > 256 * 1024) return false
  socket.send(encoded)
  return true
}

function sendError(socket, code, message, fatal = false) {
  send(socket, {
    v: PROTOCOL_VERSION,
    type: 'error',
    error: { code, message, fatal },
  })
}

function publicPlayer(participant) {
  return {
    id: participant.id,
    name: participant.name,
    role: participant.role,
    slot: participant.slot,
    ready: participant.ready,
    connected: participant.connected,
  }
}

function publicRoom(room) {
  return {
    roomCode: room.code,
    sessionId: room.sessionId,
    maxPlayers: MAX_PLAYERS,
    status: room.status,
    settings: room.settings,
    players: [publicPlayer(room.host), ...[...room.guests.values()].sort((a, b) => a.slot - b.slot).map(publicPlayer)],
  }
}

function broadcastRoom(room) {
  const message = { v: PROTOCOL_VERSION, type: 'room-state', room: publicRoom(room) }
  send(room.host.socket, message)
  for (const guest of room.guests.values()) send(guest.socket, message)
}

function identityFor(room, participant, resumed) {
  return {
    roomCode: room.code,
    sessionId: room.sessionId,
    playerId: participant.id,
    resumeToken: participant.resumeToken,
    resumed,
    room: publicRoom(room),
  }
}

function roomForMeta(meta) {
  return meta.roomCode ? rooms.get(meta.roomCode) : undefined
}

function assignClient(meta, room, participant) {
  meta.role = participant.role
  meta.roomCode = room.code
  meta.playerId = participant.id
  meta.name = participant.name
  meta.buildId = room.buildId
  meta.resumeToken = participant.resumeToken
}

function makeRoom(socket, meta, message) {
  if (meta.roomCode) {
    sendError(socket, 'ALREADY_IN_ROOM', 'This browser is already attached to a room.', true)
    return
  }
  if (rooms.size >= MAX_ROOMS) {
    sendError(socket, 'HOST_CAPACITY', 'This host PC has reached its room limit.', true)
    return
  }
  const buildId = normalizeBuildId(message.buildId)
  if (!buildId) {
    sendError(socket, 'INVALID_BUILD', 'The game build identifier is missing.', true)
    return
  }
  const code = roomCode()
  const participant = {
    id: 'host',
    name: normalizeName(message.name),
    role: 'host',
    slot: 0,
    ready: true,
    connected: true,
    socket,
    resumeToken: resumeToken(),
  }
  const room = {
    code,
    sessionId: randomUUID(),
    buildId,
    host: participant,
    guests: new Map(),
    status: 'lobby',
    settings: {},
    createdAt: Date.now(),
  }
  rooms.set(code, room)
  assignClient(meta, room, participant)
  send(socket, { v: PROTOCOL_VERSION, type: 'room-created', identity: identityFor(room, participant, false) })
  broadcastRoom(room)
  console.log(`[LAN] Room ${code} created by ${participant.name}`)
}

function nextGuestSlot(room) {
  const occupied = new Set([...room.guests.values()].map((guest) => guest.slot))
  for (let slot = 1; slot < MAX_PLAYERS; slot += 1) if (!occupied.has(slot)) return slot
  return -1
}

function joinRoom(socket, meta, message) {
  if (meta.roomCode) {
    sendError(socket, 'ALREADY_IN_ROOM', 'This browser is already attached to a room.', true)
    return
  }
  const code = normalizeRoomCode(message.roomCode)
  const room = rooms.get(code)
  if (!room) {
    sendError(socket, 'ROOM_NOT_FOUND', 'No active BROODLINE room uses that code.', true)
    return
  }
  const buildId = normalizeBuildId(message.buildId)
  if (!buildId || buildId !== room.buildId) {
    sendError(socket, 'BUILD_MISMATCH', 'Every operative must run the same BROODLINE build.', true)
    return
  }

  const suppliedToken = typeof message.resumeToken === 'string' ? message.resumeToken.slice(0, 160) : ''
  const resumedGuest = suppliedToken
    ? [...room.guests.values()].find((guest) => guest.resumeToken === suppliedToken)
    : undefined

  if (resumedGuest) {
    if (resumedGuest.removalTimer) clearTimeout(resumedGuest.removalTimer)
    resumedGuest.removalTimer = null
    if (resumedGuest.socket && resumedGuest.socket !== socket && resumedGuest.socket.readyState === WebSocket.OPEN) {
      const previousMeta = clients.get(resumedGuest.socket)
      if (previousMeta) previousMeta.roomCode = null
      resumedGuest.socket.close(4001, 'Session resumed elsewhere')
    }
    resumedGuest.socket = socket
    resumedGuest.connected = true
    resumedGuest.disconnectedAt = 0
    resumedGuest.name = normalizeName(message.name)
    assignClient(meta, room, resumedGuest)
    send(socket, { v: PROTOCOL_VERSION, type: 'room-joined', identity: identityFor(room, resumedGuest, true) })
    send(room.host.socket, { v: PROTOCOL_VERSION, type: 'peer-joined', player: publicPlayer(resumedGuest), resumed: true })
    broadcastRoom(room)
    console.log(`[LAN] ${resumedGuest.name} reconnected to ${code}`)
    return
  }

  if (room.guests.size >= MAX_GUESTS) {
    sendError(socket, 'ROOM_FULL', 'That room already has four reserved player slots.', true)
    return
  }
  if (room.status === 'ended') {
    sendError(socket, 'ROOM_ENDED', 'That BROODLINE run has ended.', true)
    return
  }

  const slot = nextGuestSlot(room)
  if (slot < 0) {
    sendError(socket, 'ROOM_FULL', 'No guest slot is available.', true)
    return
  }
  const participant = {
    id: `p-${randomBytes(4).toString('hex')}`,
    name: normalizeName(message.name),
    role: 'guest',
    slot,
    ready: false,
    connected: true,
    socket,
    resumeToken: resumeToken(),
    disconnectedAt: 0,
    removalTimer: null,
  }
  room.guests.set(participant.id, participant)
  assignClient(meta, room, participant)
  send(socket, { v: PROTOCOL_VERSION, type: 'room-joined', identity: identityFor(room, participant, false) })
  send(room.host.socket, { v: PROTOCOL_VERSION, type: 'peer-joined', player: publicPlayer(participant), resumed: false })
  broadcastRoom(room)
  console.log(`[LAN] ${participant.name} joined ${code}`)
}

function relayInput(socket, meta, message) {
  if (meta.role !== 'guest') {
    sendError(socket, 'HOST_CANNOT_SEND_INPUT', 'Only guests send relayed input packets.')
    return
  }
  const room = roomForMeta(meta)
  if (!room || !isSafeSequence(message.seq) || !validPlayerInput(message.input)) {
    sendError(socket, 'INVALID_INPUT', 'The guest input packet was rejected.')
    return
  }
  if (room.host.socket.bufferedAmount > 512 * 1024) return
  send(room.host.socket, {
    v: PROTOCOL_VERSION,
    type: 'guest-input',
    playerId: meta.playerId,
    seq: message.seq,
    input: message.input,
  })
}

function validPlayerInput(input) {
  if (!isRecord(input) || !isSafeSequence(input.inputSeq) || !isSafeSequence(input.clientTick)) return false
  if (!['pistol', 'carbine', 'scatter'].includes(input.weapon)) return false
  const finite = ['moveX', 'moveZ', 'yaw', 'pitch']
  const booleans = ['sprint', 'fireHeld', 'interactHeld', 'selfReviveHeld']
  const sequences = ['firePressSeq', 'reloadSeq', 'interactPressSeq', 'useMedkitSeq']
  if (!finite.every((key) => typeof input[key] === 'number' && Number.isFinite(input[key]))) return false
  if (Math.hypot(input.moveX, input.moveZ) > 1.01 || Math.abs(input.yaw) > Math.PI + 0.01 || Math.abs(input.pitch) > Math.PI / 2 + 0.01) return false
  return booleans.every((key) => typeof input[key] === 'boolean') && sequences.every((key) => isSafeSequence(input[key]))
}

function relaySnapshot(socket, meta, message) {
  if (meta.role !== 'host') {
    sendError(socket, 'NOT_HOST', 'Only the host may publish authoritative snapshots.')
    return
  }
  const room = roomForMeta(meta)
  if (!room || !isSafeSequence(message.seq) || !isSafeSequence(message.tick) || typeof message.sentAt !== 'number' || !Number.isFinite(message.sentAt)) {
    sendError(socket, 'INVALID_SNAPSHOT', 'The authoritative snapshot envelope was rejected.')
    return
  }
  if (!isJsonValue(message.snapshot)) {
    sendError(socket, 'INVALID_SNAPSHOT', 'The authoritative snapshot must contain bounded JSON data.')
    return
  }
  const relay = {
    v: PROTOCOL_VERSION,
    type: 'host-snapshot',
    seq: message.seq,
    tick: message.tick,
    sentAt: message.sentAt,
    snapshot: message.snapshot,
  }
  for (const guest of room.guests.values()) {
    if (guest.connected && guest.socket?.bufferedAmount <= 512 * 1024) send(guest.socket, relay)
  }
}

function relayHostEvent(socket, meta, message) {
  if (meta.role !== 'host') {
    sendError(socket, 'NOT_HOST', 'Only the host may broadcast world events.')
    return
  }
  const room = roomForMeta(meta)
  if (!room || !isSafeSequence(message.seq) || !isJsonValue(message.event)) {
    sendError(socket, 'INVALID_EVENT', 'The host event was rejected.')
    return
  }
  const relay = { v: PROTOCOL_VERSION, type: 'host-event', seq: message.seq, event: message.event }
  for (const guest of room.guests.values()) if (guest.connected) send(guest.socket, relay)
}

function updateReady(socket, meta, message) {
  const room = roomForMeta(meta)
  if (!room || typeof message.ready !== 'boolean') {
    sendError(socket, 'INVALID_READY_STATE', 'The ready state was rejected.')
    return
  }
  const participant = meta.role === 'host' ? room.host : room.guests.get(meta.playerId)
  if (!participant) return
  participant.ready = message.ready
  broadcastRoom(room)
}

function updateRoom(socket, meta, message) {
  if (meta.role !== 'host') {
    sendError(socket, 'NOT_HOST', 'Only the host may change room settings.')
    return
  }
  const room = roomForMeta(meta)
  if (!room) return
  if (message.status !== undefined) {
    if (!['lobby', 'playing', 'ended'].includes(message.status)) {
      sendError(socket, 'INVALID_ROOM_STATUS', 'The room status was rejected.')
      return
    }
    room.status = message.status
  }
  if (message.settings !== undefined) {
    if (!isRecord(message.settings) || !isJsonValue(message.settings)) {
      sendError(socket, 'INVALID_ROOM_SETTINGS', 'Room settings must be bounded JSON data.')
      return
    }
    room.settings = JSON.parse(JSON.stringify(message.settings))
  }
  broadcastRoom(room)
}

function removeGuest(room, guest, reason, temporary) {
  if (temporary) {
    guest.connected = false
    guest.socket = null
    guest.disconnectedAt = Date.now()
    send(room.host.socket, {
      v: PROTOCOL_VERSION,
      type: 'peer-left',
      playerId: guest.id,
      name: guest.name,
      temporary: true,
      reason,
    })
    broadcastRoom(room)
    guest.removalTimer = setTimeout(() => {
      if (guest.connected || !room.guests.has(guest.id)) return
      room.guests.delete(guest.id)
      send(room.host.socket, {
        v: PROTOCOL_VERSION,
        type: 'peer-left',
        playerId: guest.id,
        name: guest.name,
        temporary: false,
        reason: 'RECONNECT WINDOW EXPIRED',
      })
      broadcastRoom(room)
      console.log(`[LAN] ${guest.name} expired from ${room.code}`)
    }, RECONNECT_GRACE_MS)
    return
  }

  if (guest.removalTimer) clearTimeout(guest.removalTimer)
  room.guests.delete(guest.id)
  send(room.host.socket, {
    v: PROTOCOL_VERSION,
    type: 'peer-left',
    playerId: guest.id,
    name: guest.name,
    temporary: false,
    reason,
  })
  broadcastRoom(room)
}

function endRoom(room, reason, skipSocket = null) {
  if (!rooms.has(room.code)) return
  rooms.delete(room.code)
  room.status = 'ended'
  for (const guest of room.guests.values()) {
    if (guest.removalTimer) clearTimeout(guest.removalTimer)
    if (guest.socket && guest.socket !== skipSocket) {
      const guestMeta = clients.get(guest.socket)
      if (guestMeta) guestMeta.roomCode = null
      send(guest.socket, { v: PROTOCOL_VERSION, type: 'room-closed', reason })
      guest.socket.close(1001, reason.slice(0, 120))
    }
  }
  if (room.host.socket && room.host.socket !== skipSocket) {
    const hostMeta = clients.get(room.host.socket)
    if (hostMeta) hostMeta.roomCode = null
  }
  console.log(`[LAN] Room ${room.code} ended: ${reason}`)
}

function leave(socket, meta, reason, intentional) {
  const room = roomForMeta(meta)
  if (!room) return
  meta.roomCode = null
  if (meta.role === 'host') {
    endRoom(room, intentional ? 'HOST ENDED SESSION' : 'HOST DISCONNECTED', socket)
    return
  }
  const guest = room.guests.get(meta.playerId)
  if (guest) removeGuest(room, guest, reason || 'GUEST DISCONNECTED', !intentional)
}

function handleMessage(socket, meta, raw) {
  if (typeof raw !== 'string' || raw.length > 256 * 1024) {
    sendError(socket, 'MESSAGE_TOO_LARGE', 'The network message exceeded the safety limit.', true)
    socket.close(1009, 'Message too large')
    return
  }
  const now = Date.now()
  if (now - meta.rateStartedAt >= 1_000) {
    meta.rateStartedAt = now
    meta.rateCount = 0
  }
  meta.rateCount += 1
  if (meta.rateCount > 180) {
    sendError(socket, 'RATE_LIMIT', 'Too many network messages were sent.', true)
    socket.close(1008, 'Rate limit')
    return
  }

  let message
  try {
    message = JSON.parse(raw)
  } catch {
    sendError(socket, 'INVALID_JSON', 'The network message was not valid JSON.')
    return
  }
  if (!isRecord(message) || message.v !== PROTOCOL_VERSION || typeof message.type !== 'string') {
    sendError(socket, 'PROTOCOL_MISMATCH', 'Unsupported BROODLINE LAN protocol.', true)
    socket.close(1002, 'Protocol mismatch')
    return
  }

  if (message.type === 'create-room') makeRoom(socket, meta, message)
  else if (message.type === 'join-room') joinRoom(socket, meta, message)
  else if (message.type === 'input') relayInput(socket, meta, message)
  else if (message.type === 'snapshot') relaySnapshot(socket, meta, message)
  else if (message.type === 'host-event') relayHostEvent(socket, meta, message)
  else if (message.type === 'set-ready') updateReady(socket, meta, message)
  else if (message.type === 'update-room') updateRoom(socket, meta, message)
  else if (message.type === 'ping') {
    if (!isSafeSequence(message.nonce) || typeof message.clientTime !== 'number' || !Number.isFinite(message.clientTime)) return
    send(socket, {
      v: PROTOCOL_VERSION,
      type: 'pong',
      nonce: message.nonce,
      clientTime: message.clientTime,
      serverTime: Date.now(),
    })
  } else if (message.type === 'leave') {
    meta.intentionalLeave = true
    leave(socket, meta, typeof message.reason === 'string' ? message.reason.slice(0, 120) : 'LEFT SESSION', true)
    socket.close(1000, 'Left session')
  } else {
    sendError(socket, 'UNKNOWN_MESSAGE', `Unknown message type: ${message.type}`)
  }
}

function lanAddresses() {
  const addresses = new Set()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const ipv4 = entry.family === 'IPv4' || entry.family === 4
      if (ipv4 && !entry.internal) addresses.add(entry.address)
    }
  }
  return [...addresses]
}

function sessionInfo() {
  const lanUrls = lanAddresses().map((address) => `http://${address}:${port}/`)
  return {
    name: 'BROODLINE LAN',
    protocol: PROTOCOL_VERSION,
    maxPlayers: MAX_PLAYERS,
    reconnectGraceMs: RECONNECT_GRACE_MS,
    localUrl: `http://127.0.0.1:${port}/`,
    lanUrls,
    webSocketPath: WS_PATH,
    webSocketUrls: lanAddresses().map((address) => `ws://${address}:${port}${WS_PATH}`),
    activeRooms: rooms.size,
  }
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value, null, 2)
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname === '/broodline/session') {
      writeJson(response, 200, sessionInfo())
      return
    }
    if (url.pathname === '/broodline/health') {
      writeJson(response, 200, { ok: true, protocol: PROTOCOL_VERSION, rooms: rooms.size })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Method not allowed')
      return
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const file = resolve(root, relative)
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end('Forbidden')
      return
    }
    const body = await readFile(file)
    response.writeHead(200, {
      'Cache-Control': relative === 'index.html' ? 'no-cache' : 'public, max-age=3600',
      'Content-Type': mime[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.byteLength,
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('BROODLINE asset not found')
  }
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false })

server.on('upgrade', (request, socket, head) => {
  let pathname = ''
  try {
    pathname = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname
  } catch {
    socket.destroy()
    return
  }
  if (pathname !== WS_PATH) {
    socket.destroy()
    return
  }
  const origin = request.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.host) {
        socket.destroy()
        return
      }
    } catch {
      socket.destroy()
      return
    }
  }
  if (wss.clients.size >= MAX_CONNECTIONS) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (webSocket) => wss.emit('connection', webSocket, request))
})

wss.on('connection', (socket) => {
  const meta = {
    role: null,
    roomCode: null,
    playerId: null,
    name: '',
    buildId: '',
    resumeToken: '',
    rateStartedAt: Date.now(),
    rateCount: 0,
    alive: true,
    intentionalLeave: false,
  }
  clients.set(socket, meta)
  socket.on('pong', () => { meta.alive = true })
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      sendError(socket, 'BINARY_UNSUPPORTED', 'BROODLINE LAN accepts text JSON messages only.', true)
      socket.close(1003, 'Binary unsupported')
      return
    }
    handleMessage(socket, meta, data.toString('utf8'))
  })
  socket.on('close', (_code, reason) => {
    leave(socket, meta, reason.toString('utf8').slice(0, 120), meta.intentionalLeave)
  })
  socket.on('error', () => {
    // The close handler owns room cleanup.
  })
})

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    const meta = clients.get(socket)
    if (!meta) continue
    if (!meta.alive) {
      socket.terminate()
      continue
    }
    meta.alive = false
    socket.ping()
  }
}, 15_000)

wss.on('close', () => clearInterval(heartbeat))

server.on('error', (error) => {
  console.error(`BROODLINE LAN server failed: ${error.message}`)
  process.exitCode = 1
})

server.listen(port, host, () => {
  console.log('BROODLINE LAN is online.')
  console.log(`Host game: http://127.0.0.1:${port}/`)
  const addresses = lanAddresses()
  if (addresses.length === 0) {
    console.log('No LAN address was detected. Check that Wi-Fi or Ethernet is connected.')
  } else {
    console.log('Teammates on the same network can open:')
    for (const address of addresses) console.log(`  http://${address}:${port}/`)
  }
  console.log('Keep this window open while hosting. Press Ctrl+C to stop.')
})

function shutdown() {
  for (const room of rooms.values()) endRoom(room, 'HOST SERVER STOPPED')
  clearInterval(heartbeat)
  wss.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1_500).unref()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
