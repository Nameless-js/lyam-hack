const { randomUUID } = require('node:crypto')
const { telegram, telegramApi } = require('./integrations')

const botName = process.env.TELEGRAM_BOT_USERNAME
const enabled = Boolean(process.env.TELEGRAM_BOT_TOKEN && /^[A-Za-z0-9_]+$/.test(botName || ''))
const subscriptions = new Map()
const pending = new Map()
const lifetime = 8 * 60 * 60 * 1000

function prune() {
  const now = Date.now()
  for (const [id, link] of pending) if (link.expires <= now) pending.delete(id)
  for (const [id, link] of subscriptions) if (link.expires <= now) subscriptions.delete(id)
}

function disconnect(id) {
  subscriptions.delete(id)
  for (const [code, link] of pending) if (link.id === id) pending.delete(code)
}

function startLink(id) {
  prune()
  disconnect(id)
  const code = randomUUID()
  pending.set(code, { id, expires: Date.now() + 5 * 60 * 1000 })
  return 'https://t.me/' + botName + '?start=' + code
}

function isConnected(id) {
  prune()
  return subscriptions.has(id)
}

function notifySubscribers(text, ownerChat) {
  prune()
  const chats = new Set([...subscriptions.values()].map(link => link.chatId))
  for (const chatId of chats) {
    if (String(chatId) !== ownerChat) telegram(text, chatId)
  }
}

async function pollTelegram(onOwnerStart) {
  if (!enabled) return
  let offset = 0
  while (true) {
    try {
      const updates = await telegramApi('getUpdates', { offset, timeout: 20, allowed_updates: ['message'] }, 25000)
      prune()
      for (const update of updates) {
        offset = update.update_id + 1
        const message = update.message
        if (message?.chat?.type !== 'private') continue
        const start = /^\/start(?:@([\w]+))?(?:\s+([\w-]+))?$/.exec((message.text || '').trim())
        if (!start || (start[1] && start[1].toLowerCase() !== botName.toLowerCase())) continue
        const code = start[2]
        if (!code) {
          telegram('Здравствуйте! Это бот SupCenter. После подключения сюда будут приходить уведомления о новых жалобах, предложениях и других обращениях сотрудников. Чтобы подключиться, откройте SupCenter, нажмите «Подключить уведомления» и перейдите по ссылке.', message.chat.id)
          continue
        }
        if (onOwnerStart(code, message.chat.id)) continue
        const link = pending.get(code)
        if (!link) {
          telegram('Ссылка истекла. Запросите новую на сайте.', message.chat.id)
          continue
        }
        pending.delete(code)
        subscriptions.set(link.id, { chatId: message.chat.id, expires: Date.now() + lifetime })
        telegram('Здравствуйте! Уведомления SupCenter подключены. Сюда будут приходить новые жалобы, предложения и другие обращения сотрудников. В каждом уведомлении будет полный текст обращения.', message.chat.id)
      }
    } catch (error) {
      console.error('Опрос Telegram: ' + error.message)
      await new Promise(resolve => setTimeout(resolve, 4000))
    }
  }
}

module.exports = { enabled, startLink, disconnect, isConnected, notifySubscribers, pollTelegram }
