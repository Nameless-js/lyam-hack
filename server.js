const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { suggest, matchAnswer, telegram } = require('./integrations')
const telegramLinks = require('./telegram-links')

const seed = require('./seed.json')
const types = [...new Set(seed.map(item => item.type)), 'Просьба', 'Вопрос']
const categories = [...new Set(seed.map(item => item.category))].sort((a, b) => a.localeCompare(b, 'ru'))
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
`)
const insert = db.prepare('INSERT INTO cases (id, data) VALUES (?, ?)')
const update = db.prepare('UPDATE cases SET data = ? WHERE id = ?')
const select = db.prepare('SELECT data FROM cases WHERE id = ?')
const list = db.prepare('SELECT data FROM cases ORDER BY id DESC')
const maxId = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM cases')
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
const insertDefaultAnswer = db.prepare('INSERT OR IGNORE INTO knowledge (case_id, event_index, question, answer) VALUES (0, ?, ?, ?)')
const defaultAnswers = [
  ['Где посмотреть статус моего обращения?', 'Откройте нужный чат в разделе «Мои обращения». Текущий статус указан в шапке переписки, а решение появится в разделе «Итог».'],
  ['Как ответить на запрос уточнения?', 'Откройте чат нужного обращения, напишите уточнение в поле сообщения и нажмите «Отправить». Карточка вернётся на рассмотрение.'],
  ['Как подать новое обращение?', 'Войдите в профиль сотрудника и нажмите «Новое обращение». Выберите тип и категорию, опишите ситуацию и нажмите «Подать обращение».'],
]
defaultAnswers.forEach(([question, answer], index) => insertDefaultAnswer.run(index, question, answer))
const kind = type => ({ 'Проблема': 'Жалоба', 'Предложение': 'Рекомендация' }[type] || type)
let ownerChat = process.env.TELEGRAM_CHAT_ID || db.prepare('SELECT chat_id FROM telegram_owner WHERE id = 1').get()?.chat_id
const ownerCode = telegramLinks.enabled && !ownerChat ? 'owner_' + randomUUID() : null
function audit(user, action, id = null, incoming = false) {
  const actor = user?.name || 'Гость'
  insertAudit.run(stamp(), actor, action, id, Number(incoming))
  telegram(actor + ' · ' + action + (id ? ' · ' + caseNumber(id) : ''), ownerChat)
  if (incoming) telegramLinks.notifySubscribers(action + ' · ' + caseNumber(id), ownerChat)
}

async function answerQuestion(item) {
  const answers = recentAnswers.all()
  if (item.type !== 'Вопрос' || !answers.length || !process.env.GEMINI_API_KEY) return
  try {
    const answer = await matchAnswer(item.description, answers)
    if (!answer) return
    const current = JSON.parse(select.get(item.id).data)
    if (current.status !== 'Новое' || current.owner || current.history.length !== 1) return
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

const canRead = (user, item) => user.role === 'admin' || item.author === user.id || item.owner === user.id
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
async function body(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 32768) fail(413, 'Слишком большой запрос.')
    chunks.push(chunk)
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
function pick(value, options, message) {
  if (!options.includes(value)) fail(400, message)
  return value
}
function view(item) {
  return {
    ...item, number: caseNumber(item.id), authorName: getProfileName(item.author),
    ownerName: getProfileName(item.owner), department: profileById.get(item.author).department,
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
    case 'comment': {
      const text = required(data.text, 'Введите комментарий (до 4000 символов).')
      record(item, actor, 'Комментарий', text)
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
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const route = url.pathname
    if (req.method === 'GET' && assets[route]) {
      const [name, mime] = assets[route]
      res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-cache' })
      if (route === '/') audit(userFrom(req), 'Открыл сайт')
      return res.end(fs.readFileSync(path.join(__dirname, 'public', name)))
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
      return send(res, 200, list.all().map(row => JSON.parse(row.data)).filter(item => canRead(user, item)).map(view))
    }
    if (req.method === 'POST' && route === '/api/cases') {
      if (user.role !== 'author') fail(403, 'Подать обращение может сотрудник.')
      const data = await body(req)
      const created = stamp()
      const item = {
        id: maxId.get().id,
        type: pick(data.type, types, 'Выберите тип.'),
        category: pick(data.category, categories, 'Выберите категорию.'),
        priority: pick(data.priority, priorities, 'Выберите приоритет.'),
        description: required(data.description, 'Опишите обращение (до 4000 символов).'),
        author: user.id, owner: null, status: 'Новое', task: '', result: '',
        created, firstResponse: null, due: stamp(Date.now() + 4 * day), history: [],
      }
      record(item, user.name, 'Подано обращение', '', created)
      insert.run(item.id, JSON.stringify(item))
      audit(user, 'Новое обращение · ' + kind(item.type) + ' · ' + item.category, item.id, true)
      void answerQuestion(item)
      return send(res, 201, view(item))
    }
    const extra = route.match(/^\/api\/cases\/(\d+)\/(open|suggest|knowledge)$/)
    if (req.method === 'POST' && extra) {
      const row = select.get(Number(extra[1]))
      const item = row && JSON.parse(row.data)
      if (!item || !canRead(user, item)) fail(404, 'Обращение не найдено.')
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
        const result = await suggest({
          type: kind(item.type), category: item.category, description: item.description,
          messages: item.history.slice(-8).filter(event => event.text).map(event => ({ action: event.label, text: event.text.slice(0, 1500) })),
          candidates,
        })
        const owner = candidates.find(candidate => candidate.id === result.owner) || null
        audit(user, 'Запросил рекомендацию Gemini', item.id)
        return send(res, 200, { owner, reply: result.reply, task: result.task, reason: result.reason })
      } catch (error) {
        fail(502, error.message)
      }
    }
    const match = route.match(/^\/api\/cases\/(\d+)$/)
    if (req.method === 'POST' && match) {
      const data = await body(req)
      const row = select.get(Number(match[1]))
      const item = row && JSON.parse(row.data)
      if (!item || !canRead(user, item)) fail(404, 'Обращение не найдено.')
      edit(user, item, data)
      update.run(JSON.stringify(item), item.id)
      audit(user, { assign: 'Назначил исполнителя', status: 'Статус · ' + item.status, comment: 'Отправил сообщение' }[data.action], item.id)
      return send(res, 200, view(item))
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
