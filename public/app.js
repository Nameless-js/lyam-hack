const $ = id => document.getElementById(id)
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char])
const options = (values, selected, placeholder) => {
  const items = values.map(entry => typeof entry === 'string' ? { id: entry, name: entry } : entry)
  if (placeholder) items.unshift({ id: '', name: placeholder })
  return items.map(({ id, name }) => '<option value="' + escapeHtml(id) + '"' +
    (id === selected ? ' selected' : '') + '>' + escapeHtml(name) + '</option>').join('')
}
const dateFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Qyzylorda', dateStyle: 'short' })
const timeFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Qyzylorda', dateStyle: 'short', timeStyle: 'short' })
const roleNames = { admin: 'Координатор', author: 'Сотрудник', owner: 'Исполнитель' }
let config
let cases = []
let openId = null
const drafts = new Map()
const typeLabel = type => ({ 'Проблема': 'Жалоба', 'Предложение': 'Рекомендация' }[type] || type)
const initials = name => name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase()

async function api(route, data) {
  const response = await fetch('/api/' + route, data === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result
}
function notice(message, error = false) {
  $('notice').textContent = message
  $('notice').className = error ? 'error' : ''
  $('notice').hidden = !message
}
function showRole() {
  const { user } = config
  $('profile').innerHTML = options(config.profiles.map(profile => ({
    id: profile.id, name: profile.role === 'admin' ? 'Координатор' : roleNames[profile.role] + ' · ' + profile.name,
  })), user?.id ?? '', 'Выберите роль')
  $('profile').required = true
  $('heading').textContent = {
    author: 'Мои обращения', owner: 'Назначенные мне', admin: 'Входящие обращения',
  }[user?.role] || 'Обращения сотрудников'
  $('subtitle').textContent = user?.name || 'Выберите демо-профиль, чтобы открыть рабочее пространство.'
  $('new-case').hidden = user?.role !== 'author'
  $('workspace').hidden = !user
  $('stats-panel').hidden = user?.role !== 'admin'
  $('notifications').hidden = user?.role !== 'admin'
  $('moderation').hidden = user?.role !== 'admin'
  $('telegram').hidden = user?.role !== 'admin'
  $('department-filter').hidden = user?.role !== 'admin'
}
function draw() {
  if (!config.user) return
  const finished = cases.filter(item => config.statuses.slice(4).includes(item.status)).length
  const withResponse = cases.filter(item => item.firstResponse)
  const totalHours = withResponse.reduce((sum, item) =>
    sum + (Date.parse(item.firstResponse) - Date.parse(item.created)) / 3600000, 0)
  const metrics = [
    ['Всего обращений', cases.length],
    ['Без исполнителя', cases.filter(item => !item.owner && !config.statuses.slice(4).includes(item.status)).length],
    ['Завершены', finished + ' из ' + cases.length],
    ['Среднее время до реакции', withResponse.length ? (totalHours / withResponse.length).toFixed(1).replace('.', ',') + ' ч' : '—'],
  ]
  $('stats').innerHTML = metrics.map(([label, value]) => '<div class="stat"><strong>' + value +
    '</strong><span>' + label + '</span></div>').join('')
  const query = $('search').value.trim().toLowerCase()
  const status = $('status-filter').value
  const type = $('type-filter').value
  const category = $('category-filter').value
  const department = $('department-filter').value
  const visible = cases.filter(item =>
    (!query || [item.number, item.authorName, item.description, item.category, typeLabel(item.type)].join(' ').toLowerCase().includes(query)) &&
    (!type || item.type === type) &&
    (!status || item.status === status) && (!category || item.category === category) &&
    (!department || item.department === department) && (!$('late-filter').checked || item.overdue))
  $('count').textContent = visible.length + ' из ' + cases.length
  if (!visible.some(item => item.id === openId)) openId = visible[0]?.id ?? null
  $('cases').innerHTML = visible.map(item => `
    <button type="button" class="chat-row" data-case="${item.id}" aria-current="${item.id === openId}">
      <span class="avatar" aria-hidden="true">${escapeHtml(initials(item.authorName))}</span>
      <span class="row-body"><strong>${escapeHtml(item.authorName)}</strong>
        <span class="row-topic">${escapeHtml(item.category)}</span>
        <span class="row-meta">${escapeHtml(typeLabel(item.type))} · ${item.number}</span>
      </span>${item.status === 'Новое' ? '<span class="new-dot" title="Новое"></span>' : ''}
    </button>`).join('') || '<p class="empty muted">Обращений по этим условиям нет.</p>'
  renderChat()
}
async function refresh() {
  cases = config.user ? await api('cases') : []
  draw()
}
function modal(title, content) {
  $('dialog-content').innerHTML = '<div class="dialog-head"><h2>' + escapeHtml(title) +
    '</h2><button type="button" class="secondary" id="close-dialog" aria-label="Закрыть">×</button></div>' +
    '<p id="dialog-error" class="error" role="alert" hidden></p>' + content
  $('close-dialog').onclick = () => $('dialog').close()
  if (!$('dialog').open) $('dialog').showModal()
}
function showAction(item, action, suggestion = null) {
  const next = config.transitions[item.status]
  const ownerOptions = config.profiles.filter(profile => profile.role === 'owner')
  const dueDate = new Date(Date.parse(item.due) + 5 * 3600000).toISOString().slice(0, 10)
  const assignment = `
    <form class="action-form" data-action="assign">
      <div class="grid">
        <label>Исполнитель<select name="owner" required>${options(ownerOptions, suggestion?.owner ?? item.owner ?? '', 'Выберите исполнителя')}</select></label>
        <label>Срок<input type="date" name="due" value="${dueDate}" required></label>
      </div>
      <label>Поручение<textarea name="text" required maxlength="4000" rows="4">${escapeHtml(suggestion?.task ?? item.task)}</textarea></label>
      <button>Сохранить назначение</button>
    </form>`
  const status = `
    <form class="action-form" data-action="status">
      <label>Новый статус<select name="status" required>${options(next.filter(value => value !== 'В работе' || item.owner), '', 'Выберите статус')}</select></label>
      <label>Вопрос автору или итог рассмотрения<textarea name="text" maxlength="4000" rows="2"></textarea></label>
      <button>Обновить статус</button>
    </form>`
  modal(action === 'assign' ? 'Поручить обращение' : 'Изменить статус', action === 'assign' ? assignment : status)
}
function renderChat() {
  const item = cases.find(entry => entry.id === openId)
  if (!item) {
    $('chat').innerHTML = '<p class="chat-empty">Выберите обращение, чтобы открыть переписку.</p>'
    $('case-details').innerHTML = '<h2>Обращение</h2><p class="muted">Здесь будут детали выбранного чата.</p>'
    return
  }
  const active = !item.moderated && Boolean(config.transitions[item.status])
  const admin = config.user.role === 'admin'
  const staff = config.user.role !== 'author'
  const events = [{ actor: item.authorName, text: item.description, time: item.created, label: 'Исходное обращение' }, ...item.history.slice(1)]
  $('chat').innerHTML = `
    <header class="chat-head">
      <span class="avatar">${escapeHtml(initials(item.authorName))}</span>
      <div><h2>${escapeHtml(item.authorName)}</h2><p>${item.number} · ${escapeHtml(item.category)}</p></div>
      <span class="tag">${item.moderated ? 'На модерации' : escapeHtml(item.status)}</span>
    </header>
    <div class="messages">${events.map((event, index) => `
      <article class="message ${event.actor === item.authorName ? '' : 'staff-message'}">
        <div class="message-meta"><strong>${escapeHtml(event.actor)}</strong><span>${timeFormat.format(new Date(event.time))}</span></div>
        ${event.label !== 'Комментарий' ? '<small>' + escapeHtml(event.label) + '</small>' : ''}
        ${event.text ? '<p class="copy">' + escapeHtml(event.text) + '</p>' : ''}
        ${admin && event.actor === config.user.name && event.label === 'Комментарий' ? '<button type="button" class="save-answer" data-knowledge="' + index + '">Сохранить как общий ответ</button>' : ''}
      </article>`).join('')}</div>
    ${active ? `<form id="composer" class="composer">
      <div class="chat-actions">
        ${admin ? '<button class="ai-button" type="button" data-chat-action="suggest">✦ Рекомендация ИИ</button><button class="secondary" type="button" data-chat-action="assign">Поручить</button>' : ''}
        ${staff ? '<button class="secondary" type="button" data-chat-action="status">Изменить статус</button>' : ''}
      </div>
      <div class="compose-row"><textarea name="text" aria-label="Сообщение" placeholder="Написать сообщение…" maxlength="4000" required rows="2">${escapeHtml(drafts.get(item.id))}</textarea><button>Отправить</button></div>
    </form>` : '<div class="composer muted">' + (item.moderated ? 'Обращение ожидает проверки координатором.' : 'Обращение завершено') + '</div>'}`
  $('case-details').innerHTML = `
    <p class="eyebrow">КАРТОЧКА ${item.number}</p><h2>Об обращении</h2>
    <dl class="case-facts">
      <dt>Тип</dt><dd>${escapeHtml(typeLabel(item.type))}</dd>
      <dt>Подразделение</dt><dd>${escapeHtml(item.department)}</dd>
      <dt>Приоритет</dt><dd>${escapeHtml(item.priority)}</dd>
      <dt>Исполнитель</dt><dd>${escapeHtml(item.ownerName)}</dd>
      <dt>Срок</dt><dd class="${item.overdue ? 'late' : ''}">${dateFormat.format(new Date(item.due))}${item.overdue ? ' · Просрочено' : ''}</dd>
    </dl>
    ${item.task ? '<section class="box"><h3>Поручение</h3><p class="copy">' + escapeHtml(item.task) + '</p></section>' : ''}
    ${item.result ? '<section class="box"><h3>Итог</h3><p class="copy">' + escapeHtml(item.result) + '</p></section>' : ''}
    ${item.rating ? '<section class="box"><h3>Оценка компании</h3><strong>' + item.rating.score + ' из 5</strong>' +
      (item.rating.comment ? '<p class="copy">' + escapeHtml(item.rating.comment) + '</p>' : '') + '</section>' : ''}`
  const messages = $('chat').querySelector('.messages')
  messages.scrollTop = messages.scrollHeight
}
async function recommend(item) {
  modal('Рекомендация ИИ', '<p role="status">Gemini готовит рекомендацию…</p>')
  const pending = $('dialog-error')
  let result
  try {
    result = await api('cases/' + item.id + '/suggest', {})
  } catch (error) {
    if ($('dialog').open && pending === $('dialog-error')) modal('Рекомендация ИИ', '<p class="error">' + escapeHtml(error.message) + '</p>')
    return
  }
  if (!$('dialog').open || pending !== $('dialog-error')) return
  const { owner, reply, task, reason } = result
  modal('Рекомендация ИИ', `
    <p class="muted">Подготовлено Gemini. Проверьте перед отправкой.</p>
    <section class="box"><h3>Черновик ответа</h3><p class="copy">${escapeHtml(reply)}</p></section>
    <section class="box"><h3>Поручение</h3><p class="copy">${escapeHtml(task)}</p></section>
    <section class="box"><h3>Исполнитель</h3><p>${owner ? escapeHtml(owner.role) + ' · активных задач: ' + owner.active : 'Кандидат не предложен.'}</p><p class="copy">${escapeHtml(reason)}</p></section>
    <div class="chat-actions"><button type="button" id="use-reply">Вставить черновик</button><button type="button" class="secondary" id="use-task">Подготовить поручение</button></div>`)
  $('use-reply').onclick = () => {
    drafts.set(item.id, [drafts.get(item.id), reply].filter(Boolean).join('\n\n').slice(0, 4000))
    $('dialog').close()
    renderChat()
    $('composer').elements.text.focus()
  }
  $('use-task').onclick = () => showAction(item, 'assign', { owner: owner?.id, task })
}
function approveAnswer(item, index) {
  modal('Сохранить как общий ответ', `
    <p class="muted">Уберите детали конкретного случая. Gemini сможет использовать этот текст для будущих вопросов с тем же смыслом.</p>
    <form class="action-form" data-action="knowledge">
      <input type="hidden" name="index" value="${index}">
      <label>Общий вопрос<textarea name="question" required maxlength="4000" rows="3">${escapeHtml(item.description)}</textarea></label>
      <label>Утверждённый ответ<textarea name="answer" required maxlength="4000" rows="4">${escapeHtml(item.history[index].text)}</textarea></label>
      <button>Утвердить ответ</button>
    </form>`)
}
function newCase() {
  openId = null
  modal('Новое обращение', `
    <form class="action-form" data-action="create">
      <div class="grid">
        <label>Тип<select name="type">${options(config.types.map(type => ({ id: type, name: typeLabel(type) })))}</select></label>
        <label>Категория<select name="category" required>${options(config.categories, '', 'Выберите категорию')}</select></label>
      </div>
      <label>Приоритет<select name="priority">${options(config.priorities, 'Средний')}</select></label>
      <label>Описание<textarea name="description" required maxlength="4000" rows="5" placeholder="Что произошло или что предлагаете изменить?"></textarea></label>
      <button>Подать обращение</button>
    </form>`)
}
$('dialog').addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.target
  const button = form.querySelector('button')
  const action = form.dataset.action
  const caseId = openId
  const data = Object.fromEntries(new FormData(form))
  button.disabled = true
  try {
    if (action === 'knowledge') {
      await api('cases/' + caseId + '/knowledge', { ...data, index: Number(data.index) })
      $('dialog').close()
      notice('Общий ответ добавлен в базу знаний.')
      return
    }
    const item = action === 'create' ? await api('cases', data) :
      await api('cases/' + caseId, { ...data, action })
    openId = item.id
    if (action === 'create') resetFilters()
    await refresh()
    if ($('dialog').open) $('dialog').close()
    if (action === 'create' && item.type === 'Положительный отзыв') showRating(item.id)
    notice(item.moderated ? 'Обращение отправлено на модерацию.' :
      action === 'create' ? 'Обращение подано.' : 'Изменения сохранены.')
  } catch (error) {
    const errorBox = $('dialog-error')
    if ($('dialog').open && errorBox) {
      errorBox.textContent = error.message
      errorBox.hidden = false
    } else notice(error.message, true)
  } finally {
    button.disabled = false
  }
})
function showRating(caseId) {
  const form = $('rating-form')
  form.reset()
  form.dataset.caseId = caseId
  $('rating-error').hidden = true
  $('rating-card').hidden = false
  form.querySelector('input').focus({ preventScroll: true })
}
$('dismiss-rating').onclick = () => {
  $('rating-card').hidden = true
  $('new-case').focus({ preventScroll: true })
}
$('rating-form').addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.currentTarget
  const button = form.querySelector('button')
  const caseId = Number(form.dataset.caseId)
  const data = new FormData(form)
  button.disabled = true
  $('rating-error').hidden = true
  try {
    const { item, commentModerated } = await api('cases/' + caseId + '/rating', {
      score: Number(data.get('score')), comment: data.get('comment'),
    })
    if (Number(form.dataset.caseId) !== caseId) return
    $('rating-card').hidden = true
    cases = cases.map(entry => entry.id === item.id ? item : entry)
    draw()
    notice(commentModerated ? 'Оценка сохранена. Комментарий отправлен на модерацию.' : 'Спасибо! Оценка сохранена.')
  } catch (error) {
    if (Number(form.dataset.caseId) !== caseId) return
    $('rating-error').textContent = error.message
    $('rating-error').hidden = false
  } finally {
    button.disabled = false
  }
})
$('cases').addEventListener('click', event => {
  const button = event.target.closest('[data-case]')
  if (button) {
    openId = Number(button.dataset.case)
    void api('cases/' + openId + '/open', {}).catch(() => {})
    draw()
    $('cases').querySelector('[aria-current="true"]')?.focus()
  }
})
$('chat').addEventListener('click', event => {
  const knowledge = event.target.closest('[data-knowledge]')
  const item = cases.find(entry => entry.id === openId)
  if (knowledge) return approveAnswer(item, Number(knowledge.dataset.knowledge))
  const action = event.target.closest('[data-chat-action]')?.dataset.chatAction
  if (!action) return
  if (action === 'suggest') recommend(item)
  else showAction(item, action)
})
$('chat').addEventListener('input', event => {
  if (event.target.name === 'text') drafts.set(openId, event.target.value)
})
$('chat').addEventListener('submit', async event => {
  event.preventDefault()
  const id = openId
  const form = event.target
  const button = form.querySelector('button[type="submit"], .compose-row button')
  const field = form.elements.text
  const text = field.value
  button.disabled = true
  field.readOnly = true
  try {
    const item = await api('cases/' + id, { action: 'comment', text })
    notice(item.messageModerated ? 'Сообщение отправлено на модерацию.' : '')
    if (drafts.get(id) === text) drafts.delete(id)
    await refresh()
    if (openId === id) $('composer')?.elements.text.focus()
  } catch (error) {
    notice(error.message, true)
  } finally {
    button.disabled = false
    field.readOnly = false
  }
})
function resetFilters() {
  for (const id of ['search', 'type-filter', 'status-filter', 'category-filter', 'department-filter']) $(id).value = ''
  $('late-filter').checked = false
}
$('filters').addEventListener('input', draw)
$('new-case').onclick = newCase
$('refresh').onclick = async () => {
  try {
    await refresh()
    notice('Список обновлён.')
  } catch (error) {
    notice(error.message, true)
  }
}
const seenKey = 'kontur-inbox-seen'
async function checkInbox(show = false) {
  if (config?.user?.role !== 'admin') return
  const { events, unread } = await api('audit?after=' + (localStorage.getItem(seenKey) || 0))
  if (config?.user?.role !== 'admin') return
  $('unread').textContent = unread
  $('unread').hidden = !unread
  if (!show) return
  if (events.length) localStorage.setItem(seenKey, String(events[0].id))
  $('unread').hidden = true
  modal('Уведомления и журнал', '<div class="audit-list">' + (events.map(entry => `
    <article class="audit-entry ${entry.incoming ? 'audit-incoming' : ''}">
      <strong>${escapeHtml(entry.action)}</strong>
      <small>${escapeHtml(entry.actor)} · ${timeFormat.format(new Date(entry.time))}</small>
      ${entry.case_id ? '<button type="button" class="secondary" data-audit-case="' + entry.case_id + '">Открыть A-' + String(entry.case_id).padStart(3, '0') + '</button>' : ''}
    </article>`).join('') || '<p class="muted">Пока нет событий.</p>') + '</div>')
}
$('notifications').onclick = () => checkInbox(true).catch(error => notice(error.message, true))
async function showModeration() {
  const entries = await api('moderation')
  modal('Спам и нарушения', '<div class="audit-list">' + (entries.map(entry => `
    <article class="audit-entry">
      <strong>${escapeHtml(entry.reason)} · ${escapeHtml(entry.number)}</strong>
      <small>${escapeHtml(entry.author)} · ${timeFormat.format(new Date(entry.time))}</small>
      <p class="copy">${escapeHtml(entry.text)}</p>
      <button type="button" class="secondary" data-restore-case="${entry.caseId}" data-restore-id="${escapeHtml(entry.id)}">Вернуть ${entry.id === 'case' ? 'во входящие' : entry.kind === 'rating' ? 'к оценке' : 'в чат'}</button>
    </article>`).join('') || '<p class="muted">На проверке ничего нет.</p>') + '</div>')
}
$('moderation').onclick = () => showModeration().catch(error => notice(error.message, true))
$('dialog').addEventListener('click', async event => {
  const button = event.target.closest('[data-restore-case]')
  if (!button) return
  button.disabled = true
  try {
    await api('moderation/' + button.dataset.restoreCase, { id: button.dataset.restoreId })
    await refresh()
    if ($('dialog').open && button.isConnected) await showModeration()
  } catch (error) {
    notice(error.message, true)
    button.disabled = false
  }
})
async function checkTelegram() {
  if (config?.user?.role !== 'admin') return
  const status = await api('telegram')
  if (config?.user?.role === 'admin') {
    $('telegram').textContent = status.connected ? 'Telegram подключён' : 'Подключить Telegram'
  }
  return status
}
$('telegram').onclick = async () => {
  try {
    const status = await checkTelegram()
    if (!status.enabled) {
      modal('Telegram', '<p>Бот пока не настроен.</p>')
    } else if (status.connected) {
      modal('Telegram подключён', '<p>Бот присылает уведомления о новых обращениях.</p><button id="telegram-disconnect" type="button" class="secondary">Отключить</button>')
      $('telegram-disconnect').onclick = async () => {
        try {
          const response = await fetch('/api/telegram', { method: 'DELETE' })
          if (!response.ok) throw new Error('Не удалось отключить Telegram.')
          $('telegram').textContent = 'Подключить Telegram'
          $('dialog').close()
        } catch (error) {
          $('dialog-error').textContent = error.message
          $('dialog-error').hidden = false
        }
      }
    } else {
      const { url } = await api('telegram', {})
      modal('Подключить Telegram', '<p>Откройте бота и нажмите «Старт». Ссылка действует пять минут.</p><a href="' +
        escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">Открыть бота в Telegram</a>')
    }
  } catch (error) {
    notice(error.message, true)
  }
}
$('dialog').addEventListener('click', async event => {
  const id = Number(event.target.closest('[data-audit-case]')?.dataset.auditCase)
  if (!id) return
  $('dialog').close()
  resetFilters()
  openId = id
  void api('cases/' + id + '/open', {}).catch(() => {})
  await refresh().catch(error => notice(error.message, true))
})
setInterval(async () => {
  if (document.hidden || !config?.user) return
  void checkInbox().catch(() => {})
  void checkTelegram().catch(() => {})
  if ($('dialog').open || !$('tour').hidden || $('workspace').contains(document.activeElement)) return
  try {
    const profile = config.user.id
    const items = await api('cases')
    if (config.user.id !== profile || $('workspace').contains(document.activeElement) || $('dialog').open) return
    if (JSON.stringify(items) !== JSON.stringify(cases)) {
      cases = items
      draw()
    }
  } catch {
    // The refresh button reports connection errors on demand.
  }
}, 5000)

const steps = [
  ['#profile-form', 'Выберите роль', 'Сотрудник отправляет обращения, координатор разбирает входящие, исполнитель работает с назначенными задачами.'],
  ['#new-case', 'Подайте обращение', 'Выберите тип и категорию, затем опишите, что произошло или какое улучшение предлагаете.'],
  ['#filters', 'Найдите нужный чат', 'Используйте поиск по сотруднику или теме. Фильтр по типу оставит, например, только жалобы.'],
  ['.chat-head', 'Откройте переписку', 'В центре видны сообщения и история решений. Поле внизу отправляет сообщение участникам обращения.'],
  ['.chat-actions button', 'Действия координатора', 'Gemini предлагает черновик ответа и кандидата. Здесь же можно назначить исполнителя или поменять статус.'],
  ['#case-details', 'Посмотрите детали', 'Справа указаны исполнитель, срок, приоритет и итог работы.'],
  ['#notifications', 'Проверьте входящие', 'Счётчик показывает новые обращения. Внутри уведомлений также есть журнал действий по демо-профилям.'],
]
let tourSteps = []
let tourIndex = 0
let tourTarget
function finishTour() {
  tourTarget?.classList.remove('tour-highlight')
  $('tour').hidden = true
  $('instructions').focus()
}
function showStep() {
  tourTarget?.classList.remove('tour-highlight')
  const [selector, title, description] = tourSteps[tourIndex]
  tourTarget = document.querySelector(selector)
  tourTarget?.classList.add('tour-highlight')
  tourTarget?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' })
  $('tour').hidden = false
  $('tour').innerHTML = `<div class="tour-content">
    <p class="eyebrow">ШАГ ${tourIndex + 1} ИЗ ${tourSteps.length}</p><h2>${title}</h2><p>${description}</p>
    <div class="chat-actions"><button type="button" class="secondary" data-tour="close">Закрыть</button>
    ${tourIndex ? '<button type="button" class="secondary" data-tour="back">Назад</button>' : ''}
    <button type="button" data-tour="next">${tourIndex + 1 < tourSteps.length ? 'Далее' : 'Готово'}</button></div></div>`
  $('tour').querySelector('[data-tour="next"]').focus({ preventScroll: true })
}
$('instructions').onclick = () => {
  tourSteps = steps.filter(([selector]) => document.querySelector(selector)?.getClientRects().length)
  tourIndex = 0
  showStep()
}
$('tour').onclick = event => {
  const action = event.target.dataset.tour
  if (!action) return
  if (action === 'close' || (action === 'next' && tourIndex + 1 === tourSteps.length)) return finishTour()
  tourIndex += action === 'next' ? 1 : -1
  showStep()
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('tour').hidden) finishTour()
})
$('profile-form').addEventListener('submit', async event => {
  event.preventDefault()
  const button = event.target.querySelector('button')
  button.disabled = true
  try {
    config.user = await api('session', { profile: $('profile').value })
    $('rating-card').hidden = true
    delete $('rating-form').dataset.caseId
    resetFilters()
    drafts.clear()
    openId = null
    notice('')
    cases = []
    showRole()
    draw()
    await refresh()
    void checkInbox().catch(() => {})
  } catch (error) {
    notice(error.message, true)
  } finally {
    button.disabled = false
  }
})
async function init() {
  config = await api('config')
  $('type-filter').innerHTML = options(config.types.map(type => ({ id: type, name: typeLabel(type) })), '', 'Все типы обращений')
  $('status-filter').innerHTML = options(config.statuses, '', 'Все статусы')
  $('category-filter').innerHTML = options(config.categories, '', 'Все категории')
  $('department-filter').innerHTML = options(config.departments, '', 'Все подразделения')
  showRole()
  await refresh()
  void checkInbox().catch(() => {})
}
init().catch(error => notice(error.message, true))
