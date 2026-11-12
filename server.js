const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { suggest, matchAnswer, translateTexts, transcribeAudio, telegram } = require('./integrations')
const { readAttachments, sendAttachment, attachmentRequestBytes } = require('./attachments')
const { repeatGroups } = require('./repeats')
const telegramLinks = require('./telegram-links')
const { review } = require('./moderation')

const seed = require('./seed.json')
const types = [...new Set(seed.map(item => item.type)), 'Просьба', 'Вопрос', 'Другое']
const defaultCategory = 'Без категории'
const defaultPriority = 'Средний'
const categories = [defaultCategory, ...new Set(seed.map(item => item.category))].sort((a, b) => a.localeCompare(b, 'ru'))
const statuses = ['Новое', 'На рассмотрении', 'Ожидает уточнения', 'В работе', 'Реализовано', 'Отклонено', 'Закрыто']
const terminal = new Set(statuses.slice(4))
const priorities = ['Низкий', 'Средний', 'Высокий']
const authors = [...new Set(seed.map(item => item.author))]
const owners = [...new Set(seed.map(item => item.owner))]
const departmentByAuthor = ['Закупки', 'Проектирование', 'Бухгалтерия', 'Продажи', 'Проектный отдел', 'Проектный отдел', 'Администрация']
const departments = [...new Set(departmentByAuthor)]
const profiles = [
  { id: 'admin', name: 'Координатор', role: 'admin' },
  ...authors.map((name, i) => ({ id: 'author-' + i, name, role: 'author', department: departmentByAuthor[i] })),
  ...owners.map((name, i) => ({ id: 'owner-' + i, name, role: 'owner' })),
]
const profileById = new Map(profiles.map(profile => [profile.id, profile]))
const db = new DatabaseSync(process.env.DEMO_DB || path.join(__dirname, 'feedback.sqlite'))
db.exec(`
  CREATE TABLE IF NOT EXISTS cases (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, case_id INTEGER, incoming INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, event_index INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, UNIQUE(case_id, event_index));
  CREATE TABLE IF NOT EXISTS telegram_owner (id INTEGER PRIMARY KEY CHECK (id = 1), chat_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, case_id INTEGER NOT NULL, type TEXT NOT NULL, data BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS repeat_cache (language TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, groups TEXT, checked_at INTEGER NOT NULL);
`)
const findRepeatGroups = repeatGroups(db)
const insert = db.prepare('INSERT INTO cases (id, data) VALUES (?, ?)')
const update = db.prepare('UPDATE cases SET data = ? WHERE id = ?')
const select = db.prepare('SELECT data FROM cases WHERE id = ?')
const list = db.prepare('SELECT data FROM cases ORDER BY id DESC')
const maxId = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM cases')
const insertAttachment = db.prepare('INSERT INTO attachments (id, case_id, type, data) VALUES (?, ?, ?, ?)')
const selectAttachment = db.prepare('SELECT case_id, type, data FROM attachments WHERE id = ?')
const transcribing = new Set()
function saveCaseWithAttachments(item, files, isNew = false) {
  const save = () => isNew ? insert.run(item.id, JSON.stringify(item)) : update.run(JSON.stringify(item), item.id)
  if (!files.length) return save()
  db.exec('BEGIN')
  try {
    save()
    for (const { metadata, bytes } of files) insertAttachment.run(metadata.id, item.id, metadata.type, bytes)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
const day = 86400000
const stamp = (time = Date.now()) => new Date(time).toISOString()
const record = (item, actor, label, text, time = stamp()) => {
  item.history.push({ time, actor, label, text })
}
const getProfileName = id => profileById.get(id)?.name ?? '—'
const caseNumber = id => 'A-' + String(id).padStart(3, '0')
const insertAudit = db.prepare('INSERT INTO audit (time, actor, action, case_id, incoming) VALUES (?, ?, ?, ?, ?)')
const recentAudit = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 80')
const unreadAudit = db.prepare('SELECT COUNT(*) AS count FROM audit WHERE incoming = 1 AND id > ?')
const recentAnswers = db.prepare('SELECT id, question, answer FROM knowledge ORDER BY id DESC LIMIT 40')
const saveAnswer = db.prepare(`INSERT INTO knowledge (case_id, event_index, question, answer) VALUES (?, ?, ?, ?)
  ON CONFLICT(case_id, event_index) DO UPDATE SET question=excluded.question, answer=excluded.answer`)
const insertDefaultAnswer = db.prepare(`INSERT INTO knowledge (case_id, event_index, question, answer) VALUES (0, ?, ?, ?)
  ON CONFLICT(case_id, event_index) DO UPDATE SET question=excluded.question, answer=excluded.answer
  WHERE knowledge.question <> excluded.question OR knowledge.answer <> excluded.answer`)
const defaultAnswers = [
  ['Где посмотреть статус моего обращения?', 'Откройте нужный чат в разделе «Мои обращения». Текущий статус указан в шапке переписки, а решение появится в разделе «Итог».'],
  ['Как ответить на запрос уточнения?', 'Откройте чат нужного обращения, напишите уточнение в поле сообщения и нажмите «Отправить». Карточка вернётся на рассмотрение.'],
  ['Как подать новое обращение?', 'Войдите в профиль сотрудника и нажмите «Новое обращение». Выберите тип, опишите ситуацию и нажмите «Подать обращение».'],
]
defaultAnswers.forEach(([question, answer], index) => insertDefaultAnswer.run(index, question, answer))
const kind = type => ({ 'Проблема': 'Жалоба', 'Предложение': 'Рекомендация' }[type] || type)
const anonymousName = 'Анонимный сотрудник'
function caseActor(item, profileId) {
  return item.anonymous && profileId === item.author ? anonymousName : getProfileName(profileId)
}
let ownerChat = process.env.TELEGRAM_CHAT_ID || db.prepare('SELECT chat_id FROM telegram_owner WHERE id = 1').get()?.chat_id
const ownerCode = telegramLinks.enabled && !ownerChat ? 'owner_' + randomUUID() : null
function audit(user, action, id = null, description = '') {
  const row = id && user?.role === 'author' ? select.get(id) : null
  const actor = row ? caseActor(JSON.parse(row.data), user.id) : user?.name || 'Гость'
  insertAudit.run(stamp(), actor, action, id, Number(Boolean(description)))
  const header = action + (id ? ' · ' + caseNumber(id) : '')
  const message = description ? header + '\n\n' + description : header
  telegram(actor + ' · ' + message, ownerChat)
  if (description) telegramLinks.notifySubscribers(message, ownerChat)
}

async function answerQuestion(item) {
  const answers = recentAnswers.all()
  if (item.type !== 'Вопрос' || !answers.length || !process.env.GEMINI_API_KEY) return
  try {
    const answer = await matchAnswer(item.description, answers)
    if (!answer) return
    const current = JSON.parse(select.get(item.id).data)
    if (current.deleted || current.status !== 'Новое' || current.owner || current.history.length !== 1) return
    current.result = answer.answer
    current.status = 'Закрыто'
    current.firstResponse = stamp()
    record(current, 'База знаний', 'Автоответ · утверждено координатором', answer.answer, current.firstResponse)
    update.run(JSON.stringify(current), current.id)
    audit({ name: 'База знаний' }, 'Отправлен автоответ', current.id)
  } catch (error) {
    console.error('Автоответ: ' + error.message)
  }
}

if (maxId.get().id === 1) {
  const now = Date.now()
  db.exec('BEGIN')
  try {
    seed.forEach((entry, index) => {
      const id = index + 1
      const created = stamp(now - (1 + index % 7) * day)
      const firstResponse = entry.status === 'Новое' ? null : stamp(Date.parse(created) + (2 + index % 10) * 3600000)
      const done = terminal.has(entry.status)
      const item = {
        id, type: entry.type, category: entry.category, priority: entry.priority, status: entry.status,
        description: entry.description, author: 'author-' + authors.indexOf(entry.author),
        owner: entry.status === 'Новое' ? null : 'owner-' + owners.indexOf(entry.owner),
        created, firstResponse, due: stamp(Date.parse(created) + 4 * day),
        task: done || !firstResponse ? '' : entry.next,
        result: done ? entry.next : '', history: [],
      }
      record(item, entry.author, 'Подано обращение', '', created)
      if (firstResponse) record(item, 'Координатор', entry.status, done ? item.result : item.task, firstResponse)
      insert.run(id, JSON.stringify(item))
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const canRead = (user, item) => !item.deleted && (user.role === 'admin' || item.author === user.id || item.owner === user.id)
const sessions = new Map()
const userFrom = req => {
  const token = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([\w-]+)/)?.[1]
  return profileById.get(sessions.get(token))
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(data))
}
function fail(status, message) {
  throw Object.assign(new Error(message), { status })
}
async function readBytes(req, limit) {
  if (Number(req.headers['content-length']) > limit) fail(413, 'Слишком большой запрос.')
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) fail(413, 'Слишком большой запрос.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
async function body(req, limit = 32768) {
  const bytes = await readBytes(req, limit)
  try {
    const data = JSON.parse(bytes.toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
    return data
  } catch {
    fail(400, 'Некорректный запрос.')
  }
}
function required(value, message) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4000) fail(400, message)
  return value.trim()
}
function commentText(value, attachments) {
  if (attachments.length && typeof value === 'string' && !value.trim()) return ''
  return required(value, 'Введите комментарий (до 4000 символов).')
}
function pick(value, options, message) {
  if (!options.includes(value)) fail(400, message)
  return value
}
function canRateResolution(item) {
  return !item.moderationReason && item.type !== 'Положительный отзыв' && Boolean(item.result) &&
    ['Реализовано', 'Закрыто'].includes(item.status)
}
function view(item, user) {
  const { heldMessages, moderationReason, ...visible } = item
  const authorName = getProfileName(item.author)
  const hideAuthor = item.anonymous && item.author !== user.id
  const hideContent = moderationReason && user.role === 'admin'
  return {
    ...visible,
    description: hideContent ? '' : item.description,
    attachments: hideContent ? [] : item.attachments,
    canRateResolution: item.author === user.id && canRateResolution(item) && !item.resolutionRating,
    moderationNotices: user.role === 'admin' ? (heldMessages || []).map(({ time }) => ({ time })) : [],
    author: hideAuthor ? null : item.author,
    authorName: hideAuthor ? anonymousName : authorName,
    history: hideAuthor ? item.history.map(event => event.actor === authorName ? { ...event, actor: anonymousName } : event) : item.history,
    moderated: Boolean(moderationReason), number: caseNumber(item.id),
    ownerName: getProfileName(item.owner), department: item.anonymous ? null : profileById.get(item.author).department,
    overdue: !terminal.has(item.status) && Date.parse(item.due) < Date.now(),
  }
}

const transitions = {
  'Новое': ['На рассмотрении', 'Ожидает уточнения', 'В работе', 'Отклонено'],
  'На рассмотрении': ['Ожидает уточнения', 'В работе', 'Реализовано', 'Отклонено', 'Закрыто'],
  'Ожидает уточнения': ['На рассмотрении', 'В работе', 'Отклонено'],
  'В работе': ['Ожидает уточнения', 'Реализовано', 'Отклонено', 'Закрыто'],
}
function edit(user, item, data) {
  if (terminal.has(item.status)) fail(409, 'Обращение уже завершено.')
  const staff = user.role !== 'author'
  const actor = user.name
  switch (data.action) {
    case 'assign': {
      if (user.role !== 'admin') fail(403, 'Назначить исполнителя может координатор.')
      if (profileById.get(data.owner)?.role !== 'owner') fail(400, 'Выберите исполнителя.')
      const task = required(data.text, 'Опишите поручение (до 4000 символов).')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data.due) || !Number.isFinite(Date.parse(data.due))) {
        fail(400, 'Укажите срок.')
      }
      item.owner = data.owner
      item.task = task
      item.due = stamp(Date.parse(data.due + 'T23:59:59+05:00'))
      item.status = 'В работе'
      record(item, actor, 'Назначено · ' + getProfileName(item.owner), task)
      break
    }
    case 'status': {
      if (!staff) fail(403, 'Изменить статус может координатор или исполнитель.')
      const status = pick(data.status, transitions[item.status] || [], 'Недопустимый переход статуса.')
      if (status === 'В работе' && !item.owner) fail(400, 'Сначала назначьте исполнителя.')
      const text = terminal.has(status) || status === 'Ожидает уточнения'
        ? required(data.text, 'Укажите итог, причину отказа или вопрос автору.')
        : ''
      item.status = status
      if (terminal.has(status)) item.result = text
      record(item, actor, status, text)
      break
    }
    case 'priority': {
      if (user.role !== 'admin') fail(403, 'Изменить приоритет может координатор.')
      item.priority = pick(data.priority, priorities, 'Выберите приоритет.')
      record(item, actor, 'Приоритет изменён · ' + item.priority, '')
      break
    }
    case 'comment': {
      const attachments = data.attachments || []
      const text = commentText(data.text, attachments)
      record(item, actor, 'Комментарий', text)
      if (attachments.length) item.history.at(-1).attachments = attachments
      if (!staff && item.status === 'Ожидает уточнения') {
        item.status = 'На рассмотрении'
        record(item, 'Система', 'На рассмотрении', 'Автор ответил на запрос уточнения.')
      }
      break
    }
    default: fail(400, 'Неизвестное действие.')
  }
  if (staff && !item.firstResponse) item.firstResponse = stamp()
}

const assets = {
  '/': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
  '/motion-14.12.0.js': ['motion-14.12.0.js', 'text/javascript'],
  '/i18n.js': ['i18n.js', 'text/javascript'],
  '/analytics.js': ['analytics.js', 'text/javascript'],
  '/repeats.js': ['repeats.js', 'text/javascript'],
  '/media-input.js': ['media-input.js', 'text/javascript'],
  '/translations.txt': ['translations.txt', 'text/plain'],
  '/hero.webp': ['hero.webp', 'image/webp'],
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const route = url.pathname
    if (req.method === 'GET' && route === '/supcenter-promo.mp4') {
      const file = path.join(__dirname, 'public', 'supcenter-promo.mp4')
      const size = fs.statSync(file).size
      const range = req.headers.range
      const match = range?.match(/^bytes=(\d*)-(\d*)$/)
      const start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0, size - Number(match[2])) : 0
      const end = match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
      if (range && (!match || !(match[1] || match[2]) || start > end)) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + size })
        return res.end()
      }
      const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 }
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      res.writeHead(range ? 206 : 200, headers)
      const stream = fs.createReadStream(file, { start, end })
      res.on('close', () => stream.destroy())
      stream.on('error', error => res.destroy(error))
      return stream.pipe(res)
    }
    if (req.method === 'GET' && (route === '/pdfmake.js' || route === '/pdfmake-fonts.js')) {
      const file = path.join(__dirname, 'node_modules', 'pdfmake', 'build',
        route === '/pdfmake.js' ? 'pdfmake.min.js' : 'vfs_fonts.js')
      if (!fs.existsSync(file)) fail(503, 'Не удалось подготовить PDF.')
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
      return res.end(fs.readFileSync(file))
    }
    if (req.method === 'GET' && assets[route]) {
      const [name, mime] = assets[route]
      res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-cache' })
      if (route === '/') audit(userFrom(req), 'Открыл сайт')
      return res.end(fs.readFileSync(path.join(__dirname, 'public', name)))
    }
    if (req.method === 'DELETE' && route === '/api/session') {
      const token = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([\w-]+)/)?.[1]
      sessions.delete(token)
      return send(res, 200, null, { 'Set-Cookie': 'sid=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/' })
    }
    if (req.method === 'POST' && route === '/api/session') {
      const data = await body(req)
      const profile = profileById.get(data.profile)
      if (!profile) fail(400, 'Выберите тестовую роль.')
      const oldToken = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([\w-]+)/)?.[1]
      sessions.delete(oldToken)
      const token = randomUUID()
      sessions.set(token, profile.id)
      audit(profile, 'Вошёл в демо-профиль')
      return send(res, 200, profile, { 'Set-Cookie': 'sid=' + token + '; HttpOnly; SameSite=Strict; Path=/' })
    }
    const user = userFrom(req)
    if (req.method === 'GET' && route === '/api/config') {
      return send(res, 200, { user, profiles, types, categories, statuses, priorities, departments, transitions })
    }
    if (!user) fail(401, 'Выберите демо-профиль.')
    if (route === '/api/repeats' && req.method === 'GET') {
      if (user.role !== 'admin') fail(403, 'Раздел доступен координатору.')
      const language = url.searchParams.get('language') || 'ru'
      if (!['ru', 'kk', 'en'].includes(language)) fail(400, 'Некорректный запрос.')
      const complaints = list.all().map(row => JSON.parse(row.data))
        .filter(item => !item.deleted && !item.moderationReason && item.type === 'Проблема')
      return send(res, 200, findRepeatGroups(complaints, language))
    }
    if (route === '/api/transcribe' && req.method === 'POST') {
      const type = req.headers['content-type']?.split(';')[0]
      if (!['audio/webm', 'audio/ogg', 'audio/mp4'].includes(type)) fail(400, 'Формат записи не поддерживается.')
      if (transcribing.has(user.id)) fail(409, 'Дождитесь окончания расшифровки.')
      transcribing.add(user.id)
      try {
        const bytes = await readBytes(req, 4 * 1024 * 1024)
        if (!bytes.length) fail(400, 'Запись пуста.')
        const text = await transcribeAudio(bytes, type === 'audio/mp4' ? 'audio/m4a' : type)
        if (!text) fail(422, 'В записи не удалось распознать речь.')
        return send(res, 200, { text })
      } catch (error) {
        if (error.status) throw error
        console.error('Расшифровка Gemini: ' + error.message)
        fail(502, 'Не удалось расшифровать запись.')
      } finally {
        transcribing.delete(user.id)
      }
    }
    const attachment = route.match(/^\/api\/attachments\/([a-f0-9-]{36})$/)
    if (attachment && ['GET', 'HEAD'].includes(req.method)) {
      const file = selectAttachment.get(attachment[1])
      const row = file && select.get(file.case_id)
      const item = row && JSON.parse(row.data)
      if (!item || !canRead(user, item) || (user.role !== 'admin' &&
          item.heldMessages?.some(message => message.attachments?.some(entry => entry.id === attachment[1])))) {
        fail(404, 'Вложение не найдено.')
      }
      return sendAttachment(req, res, file.type, file.data)
    }
    if (route === '/api/moderation' && req.method === 'GET') {
      if (user.role !== 'admin') fail(403, 'Раздел доступен координатору.')
      const entries = list.all().flatMap(row => {
        const item = JSON.parse(row.data)
        if (item.deleted) return []
        const held = item.heldMessages || []
        const content = item.moderationReason
          ? [{ id: 'case', text: item.description, attachments: item.attachments, reason: item.moderationReason, author: item.author, time: item.created }, ...held]
          : held
        const replies = item.history.filter(event => event.label === 'Ответ по модерации')
        return content.map(entry => ({ ...entry, replies, caseId: item.id, number: caseNumber(item.id), author: caseActor(item, entry.author) }))
      })
      return send(res, 200, entries.sort((a, b) => b.time.localeCompare(a.time)))
    }
    const moderation = route.match(/^\/api\/moderation\/(\d+)$/)
    if (moderation && req.method === 'POST') {
      if (user.role !== 'admin') fail(403, 'Раздел доступен координатору.')
      const { id, action = 'restore', text } = await body(req)
      const row = select.get(Number(moderation[1]))
      if (!row) fail(404, 'Обращение не найдено.')
      const item = JSON.parse(row.data)
      if (item.deleted) fail(404, 'Обращение не найдено.')
      const message = item.heldMessages?.find(entry => entry.id === id)
      if (!(id === 'case' && item.moderationReason) && !message) fail(404, 'Сообщение уже обработано.')
      if (action === 'reply') {
        const reply = required(text, 'Введите комментарий (до 4000 символов).')
        record(item, user.name, 'Ответ по модерации', reply)
        if (!item.firstResponse) item.firstResponse = stamp()
        update.run(JSON.stringify(item), item.id)
        audit(user, 'Ответил по модерации', item.id)
        return send(res, 200, { ok: true })
      }
      if (action === 'delete') {
        item.deleted = true
        update.run(JSON.stringify(item), item.id)
        audit(user, 'Удалил чат из спама', item.id)
        return send(res, 200, { ok: true })
      }
      if (action !== 'restore') fail(400, 'Неизвестное действие.')
      if (id === 'case' && item.moderationReason) {
        delete item.moderationReason
        update.run(JSON.stringify(item), item.id)
        audit(user, 'Возвращено из спама · ' + kind(item.type) + ' · ' + item.category, item.id, item.description)
      } else {
        const author = profileById.get(message.author)
        if (message.kind === 'rating' || message.kind === 'resolutionRating') item[message.kind].comment = message.text
        else if (terminal.has(item.status)) {
          record(item, author.name, 'Комментарий', message.text)
          if (message.attachments?.length) item.history.at(-1).attachments = message.attachments
        } else edit(author, item, { action: 'comment', text: message.text, attachments: message.attachments })
        item.heldMessages = item.heldMessages.filter(entry => entry.id !== id)
        update.run(JSON.stringify(item), item.id)
        audit(user, 'Восстановил сообщение', item.id)
      }
      return send(res, 200, { ok: true })
    }
    if (route === '/api/telegram' && ['GET', 'POST', 'DELETE'].includes(req.method)) {
      if (user.role !== 'admin') fail(403, 'Подключение доступно координатору.')
      const binding = (req.headers.cookie || '').match(/(?:^|;\s*)telegram_binding=([\w-]+)/)?.[1]
      if (req.method === 'GET') {
        return send(res, 200, { enabled: telegramLinks.enabled, connected: telegramLinks.isConnected(binding) })
      }
      if (req.method === 'DELETE') {
        telegramLinks.disconnect(binding)
        return send(res, 200, { connected: false })
      }
      if (!telegramLinks.enabled) fail(503, 'Telegram пока не настроен.')
      const id = binding || randomUUID()
      return send(res, 200, { url: telegramLinks.startLink(id) }, {
        'Set-Cookie': 'telegram_binding=' + id + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800',
      })
    }
    if (req.method === 'GET' && route === '/api/audit') {
      if (user.role !== 'admin') fail(403, 'Журнал доступен координатору.')
      const after = Math.max(0, Number.parseInt(url.searchParams.get('after'), 10) || 0)
      return send(res, 200, { events: recentAudit.all(), unread: unreadAudit.get(after).count })
    }
    if (req.method === 'GET' && route === '/api/cases') {
      return send(res, 200, list.all().map(row => JSON.parse(row.data))
        .filter(item => canRead(user, item) &&
          (!item.moderationReason || item.author === user.id || user.role === 'admin')).map(item => view(item, user)))
    }
    if (req.method === 'POST' && route === '/api/cases') {
      if (user.role !== 'author') fail(403, 'Подать обращение может сотрудник.')
      const data = await body(req, attachmentRequestBytes)
      const files = readAttachments(data.attachments, fail)
      if (data.anonymous !== undefined && typeof data.anonymous !== 'boolean') fail(400, 'Некорректный запрос.')
      const created = stamp()
      const item = {
        type: pick(data.type, types, 'Выберите тип.'),
        category: pick(data.category ?? defaultCategory, categories, 'Выберите категорию.'),
        priority: pick(data.priority ?? defaultPriority, priorities, 'Выберите приоритет.'),
        description: required(data.description, 'Опишите обращение (до 4000 символов).'),
        attachments: files.map(file => file.metadata),
        anonymous: data.anonymous === true,
        author: user.id, owner: null, status: 'Новое', task: '', result: '',
        created, firstResponse: null, due: stamp(Date.now() + 4 * day), history: [],
      }
      const reason = await review(user.id, item.description)
      item.id = maxId.get().id
      if (reason) item.moderationReason = reason
      record(item, user.name, 'Подано обращение', '', created)
      saveCaseWithAttachments(item, files, true)
      if (reason) audit(user, 'Обращение отфильтровано', item.id)
      else {
        audit(user, 'Новое обращение · ' + kind(item.type) + ' · ' + item.category, item.id, item.description)
        void answerQuestion(item)
      }
      return send(res, 201, view(item, user))
    }
    const extra = route.match(/^\/api\/cases\/(\d+)\/(open|suggest|knowledge|rating|translate)$/)
    if (req.method === 'POST' && extra) {
      const row = select.get(Number(extra[1]))
      const item = row && JSON.parse(row.data)
      if (!item || !canRead(user, item) ||
          (item.moderationReason && item.author !== user.id && !['translate', 'open'].includes(extra[2]))) fail(404, 'Обращение не найдено.')
      if (extra[2] === 'translate') {
        const { language, texts } = await body(req)
        const available = new Set([item.description, item.task, item.result, item.rating?.comment, item.resolutionRating?.comment,
          ...item.history.map(event => event.text)])
        if (user.role === 'admin') for (const message of item.heldMessages || []) available.add(message.text)
        if (!['ru', 'kk', 'en'].includes(language) || !Array.isArray(texts) || !texts.length || texts.length > 12 ||
            texts.some(value => typeof value !== 'string' || !available.has(value)) ||
            texts.reduce((size, value) => size + value.length, 0) > 6000) fail(400, 'Некорректный запрос.')
        try {
          return send(res, 200, { texts: await translateTexts(texts, language) })
        } catch (error) {
          console.error('Перевод Gemini: ' + error.message)
          fail(502, 'Перевод пока недоступен.')
        }
      }
      if (extra[2] === 'rating') {
        const { score, comment = '', kind: ratingKind = 'rating' } = await body(req)
        if (!['rating', 'resolutionRating'].includes(ratingKind)) fail(400, 'Некорректный запрос.')
        const resolution = ratingKind === 'resolutionRating'
        if (item.author !== user.id || (resolution ? !canRateResolution(item) : item.type !== 'Положительный отзыв')) {
          fail(403, resolution ? 'Оценка решения доступна автору после завершения обращения.' : 'Оценка доступна автору отзыва.')
        }
        if (item[ratingKind]) fail(409, 'Оценка уже сохранена.')
        if (!Number.isInteger(score) || score < 1 || score > 5) fail(400, 'Выберите оценку от 1 до 5.')
        if (typeof comment !== 'string' || comment.length > 1000) fail(400, 'Комментарий должен быть не длиннее 1000 символов.')
        const message = comment.trim()
        const reason = message ? await review(user.id, message) : null
        const current = JSON.parse(select.get(item.id).data)
        if (!canRead(user, current)) fail(404, 'Обращение не найдено.')
        if (current[ratingKind]) fail(409, 'Оценка уже сохранена.')
        current[ratingKind] = { score, comment: reason ? '' : message }
        if (reason) {
          current.heldMessages = [...(current.heldMessages || []), {
            id: randomUUID(), kind: ratingKind, text: message, reason, author: user.id, time: stamp(),
          }]
        }
        update.run(JSON.stringify(current), current.id)
        audit(user, reason ? 'Оставил оценку · комментарий на модерации' :
          resolution ? 'Оценил решение обращения' : 'Оставил оценку компании', current.id)
        return send(res, 201, { item: view(current, user), commentModerated: Boolean(reason) })
      }
      if (extra[2] === 'open') {
        audit(user, 'Открыл чат', item.id)
        return send(res, 200, { ok: true })
      }
      if (user.role !== 'admin') fail(403, 'Действие доступно координатору.')
      if (extra[2] === 'knowledge') {
        const data = await body(req)
        const event = item.history[data.index]
        if (!Number.isInteger(data.index) || event?.actor !== user.name || event.label !== 'Комментарий') {
          fail(400, 'Выберите сообщение координатора.')
        }
        const question = required(data.question, 'Укажите общий вопрос.')
        const answer = required(data.answer, 'Укажите общий ответ.')
        saveAnswer.run(item.id, data.index, question, answer)
        audit(user, 'Утвердил общий ответ', item.id)
        return send(res, 200, { ok: true })
      }
      const all = list.all().map(entry => JSON.parse(entry.data))
      const candidates = profiles.filter(profile => profile.role === 'owner').map(profile => ({
        id: profile.id, role: profile.name,
        active: all.filter(entry => entry.owner === profile.id && !terminal.has(entry.status)).length,
        topics: [...new Set(seed.filter(entry => entry.owner === profile.name).map(entry => entry.category))],
      }))
      try {
        const { language } = await body(req)
        const result = await suggest({
          type: kind(item.type), category: item.category, description: item.description,
          messages: item.history.slice(-8).filter(event => event.text).map(event => ({ action: event.label, text: event.text.slice(0, 1500) })),
          candidates,
        }, language)
        const owner = candidates.find(candidate => candidate.id === result.owner) || null
        audit(user, 'Запросил рекомендацию Gemini', item.id)
        return send(res, 200, { owner, reply: result.reply, task: result.task, reason: result.reason })
      } catch (error) {
        console.error('Gemini: ' + error.message)
        fail(502, 'Не удалось получить ответ Gemini.')
      }
    }
    const match = route.match(/^\/api\/cases\/(\d+)$/)
    if (req.method === 'POST' && match) {
      const data = await body(req, attachmentRequestBytes)
      const row = select.get(Number(match[1]))
      let item = row && JSON.parse(row.data)
      if (!item || !canRead(user, item)) fail(404, 'Обращение не найдено.')
      if (item.moderationReason) fail(409, 'Обращение ожидает модерации.')
      const files = data.action === 'comment' ? readAttachments(data.attachments, fail) : []
      data.attachments = files.map(file => file.metadata)
      if (data.action === 'comment' && !terminal.has(item.status)) {
        const message = commentText(data.text, data.attachments)
        const reason = message ? await review(user.id, message) : null
        item = JSON.parse(select.get(item.id).data)
        if (!canRead(user, item)) fail(404, 'Обращение не найдено.')
        if (terminal.has(item.status)) fail(409, 'Обращение уже завершено.')
        if (reason) {
          item.heldMessages = [...(item.heldMessages || []), { id: randomUUID(), text: message, attachments: data.attachments, reason, author: user.id, time: stamp() }]
          saveCaseWithAttachments(item, files)
          audit(user, 'Сообщение отфильтровано', item.id)
          return send(res, 202, { ...view(item, user), messageModerated: true })
        }
      }
      edit(user, item, data)
      saveCaseWithAttachments(item, files)
      audit(user, { assign: 'Назначил исполнителя', status: 'Статус · ' + item.status,
        priority: 'Приоритет изменён · ' + item.priority, comment: 'Отправил сообщение' }[data.action], item.id)
      return send(res, 200, view(item, user))
    }
    fail(404, 'Страница не найдена.')
  } catch (error) {
    if (!error.status) console.error(error)
    send(res, error.status || 500, { error: error.status ? error.message : 'Внутренняя ошибка.' })
  }
})
const port = Number(process.env.PORT || 3000)
server.listen(port, '127.0.0.1', () => {
  console.log('http://127.0.0.1:' + server.address().port)
  if (ownerCode) console.log('Привязка журнала: https://t.me/' + process.env.TELEGRAM_BOT_USERNAME + '?start=' + ownerCode)
  void telegramLinks.pollTelegram((code, chatId) => {
    if (ownerChat || code !== ownerCode) return false
    db.prepare('INSERT INTO telegram_owner (id, chat_id) VALUES (1, ?)').run(String(chatId))
    ownerChat = String(chatId)
    telegram('Журнал действий подключён.', ownerChat)
    return true
  })
})
