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
const dateFormat = new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Qyzylorda', dateStyle: 'short' })
const timeFormat = new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Qyzylorda', dateStyle: 'short', timeStyle: 'short' })
const roleNames = { admin: 'Координатор', author: 'Сотрудник', owner: 'Исполнитель' }
let config
let cases = []
let openId = null
const drafts = new Map()
const pendingMessages = new Set()
const promptedRatings = new Set()
let redrawChatAfterTour = false
const typeLabel = type => ({ 'Проблема': 'Жалоба', 'Предложение': 'Рекомендация' }[type] || type)
const priorityCode = { Высокий: 'P1', Средний: 'P2', Низкий: 'P3' }
const initials = name => translate(name).split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase()
const icon = name => '<svg class="icon" aria-hidden="true"><use href="#icon-' + name + '"/></svg>'
const statusTones = {
  'Новое': 'blue', 'На рассмотрении': 'blue', 'В работе': 'blue',
  'Ожидает уточнения': 'amber', 'Реализовано': 'green', 'Отклонено': 'red',
}
const mobileWorkspace = matchMedia('(max-width: 700px)')
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const tour = $('tour')
const motionEase = [.22, 1, .36, 1]

function animateUi(target, keyframes, options) {
  if (target == null || reducedMotion.matches) return
  return window.Motion?.animate(target, keyframes, { duration: .28, ease: motionEase, ...options })
}

function showPane(pane, scroll = false) {
  const workspace = $('workspace')
  workspace.dataset.pane = pane
  if (pane === 'chat') {
    const messages = $('chat').querySelector('.messages')
    if (messages) messages.scrollTop = messages.scrollHeight
    maybePromptRating(cases.find(item => item.id === openId))
  }
  if (scroll && mobileWorkspace.matches) workspace.scrollIntoView({ block: 'nearest' })
}

async function api(route, data) {
  const response = await fetch('/api/' + route, data === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос.')
  return result
}
const contentTranslations = new Map()
function contentText(text, caseId) {
  const translated = translate(text)
  if (language === 'ru' || translated !== text) return escapeHtml(translated)
  return '<span data-content-case="' + caseId + '" data-original-text="' + escapeHtml(text) + '">' +
    escapeHtml(translate('Переводится…')) + '</span>'
}
function translateContent(root) {
  const groups = new Map()
  const elements = root.querySelectorAll('[data-content-case]')
  for (const element of elements) {
    const id = element.dataset.contentCase
    const text = element.dataset.originalText
    if (contentTranslations.has(id + ':' + text)) continue
    if (!groups.has(id)) groups.set(id, new Set())
    groups.get(id).add(text)
  }
  for (const [id, texts] of groups) {
    let batch = []
    let size = 0
    const request = () => {
      const originals = batch
      const response = api('cases/' + id + '/translate', { language, texts: originals }).catch(() => null)
      originals.forEach((text, index) => {
        contentTranslations.set(id + ':' + text, response.then(result => result?.texts[index]))
      })
      batch = []
      size = 0
    }
    for (const text of texts) {
      if (batch.length === 12 || size + text.length > 6000) request()
      batch.push(text)
      size += text.length
    }
    if (batch.length) request()
  }
  for (const element of elements) {
    const original = element.dataset.originalText
    contentTranslations.get(element.dataset.contentCase + ':' + original)?.then(result => {
      if (!element.isConnected) return
      element.textContent = result || translate('Перевод пока недоступен.')
      if (!result) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'secondary translation-original'
        button.textContent = translate('Показать оригинал')
        button.onclick = () => { element.textContent = original }
        element.append(' ', button)
      }
    })
  }
}
function notice(message, error = false) {
  const banner = $('notice')
  const changed = banner.textContent !== message || banner.hidden
  banner.textContent = message
  banner.className = error ? 'error' : ''
  banner.hidden = !message
  if (message && changed) animateUi(banner, { opacity: [0, 1], y: [-6, 0] })
  scheduleTourPosition()
}
function showRole() {
  const { user } = config
  const previousRole = $('role-label').textContent
  const previousSubtitle = $('subtitle').textContent
  setProfile(user)
  $('profile-trigger').disabled = false
  $(user ? 'profile-slot' : 'welcome-profile').append($('profile-form'))
  $('profile-submit-label').textContent = user ? 'Сменить' : 'Войти'
  $('profile-slot').hidden = !user
  $('back-to-welcome').hidden = !user
  $('welcome').hidden = Boolean(user)
  $('workspace-intro').hidden = !user
  $('role-label').textContent = roleNames[user?.role] || ''
  $('heading').textContent = {
    author: 'Мои обращения', owner: 'Назначенные мне', admin: 'Входящие обращения',
  }[user?.role] || 'Обращения сотрудников'
  $('subtitle').textContent = user?.role === 'admin' ? 'Обращения всех подразделений' : user?.name || ''
  $('new-case').hidden = user?.role !== 'author'
  $('workspace').hidden = !user
  $('stats-panel').hidden = user?.role !== 'admin'
  $('notifications').hidden = user?.role !== 'admin'
  $('moderation').hidden = user?.role !== 'admin'
  $('telegram').hidden = user?.role !== 'admin'
  $('open-analytics').hidden = user?.role !== 'admin'
  $('open-repeats').hidden = user?.role !== 'admin'
  $('department-filter').hidden = user?.role !== 'admin'
  showAnalyticsPage()
  if (user && previousRole && (previousRole !== $('role-label').textContent || previousSubtitle !== $('subtitle').textContent)) {
    animateUi($('heading').parentElement, { opacity: [.35, 1], y: [7, 0] }, { duration: .34 })
  }
}
function draw() {
  if (!config.user) return
  if (!$('analytics').hidden) drawAnalytics()
  if (!$('repeats').hidden) void loadRepeatedProblems()
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
  const previousMetrics = Array.from($('stats').querySelectorAll('strong'), metric => metric.textContent)
  $('stats').innerHTML = metrics.map(([label, value]) => '<div class="stat"><span>' + label +
    '</span><strong>' + value + '</strong></div>').join('')
  if (!$('stats-panel').hidden && $('stats-panel').open && previousMetrics.length) {
    $('stats').querySelectorAll('strong').forEach((metric, index) => {
      if (metric.textContent !== previousMetrics[index]) animateUi(metric, { opacity: [.45, 1], y: [4, 0] })
    })
  }
  const query = $('search').value.trim().toLowerCase()
  const status = $('status-filter').value
  const type = $('type-filter').value
  const category = $('category-filter').value
  const department = $('department-filter').value
  const ownQueue = config.user.role === 'author'
  const visible = cases.filter(item =>
    (!query || [item.number, item.authorName, item.description, item.category, typeLabel(item.type)].map(translate).join(' ').toLowerCase().includes(query)) &&
    (!type || item.type === type) &&
    (!status || item.status === status) && (!category || item.category === category) &&
    (!department || item.department === department) && (!$('late-filter').checked || item.overdue))
  $('count').textContent = visible.length === cases.length ? String(cases.length) : visible.length + ' из ' + cases.length
  $('count').setAttribute('aria-label', 'Показано чатов: ' + visible.length + ' из ' + cases.length)
  if (!visible.some(item => item.id === openId)) openId = visible[0]?.id ?? null
  if (!openId) showPane('list')
  $('cases').innerHTML = visible.map(item => `
    <button type="button" class="chat-row" data-case="${item.id}" aria-current="${item.id === openId}">
      <span class="avatar" aria-hidden="true">${escapeHtml(initials(ownQueue ? item.category : item.authorName))}</span>
      <span class="row-body"><strong>${escapeHtml(ownQueue ? item.category : item.authorName)}</strong>
        <span class="row-topic">${escapeHtml(ownQueue ? (item.moderated ? 'На модерации' : item.status) : item.category)}</span>
        <span class="row-meta">${escapeHtml(typeLabel(item.type))} · ${item.number}${item.priority === 'Высокий' ? ' · P1' : ''}</span>
      </span>${item.status === 'Новое' ? '<span class="new-dot" title="Новое"></span>' : ''}
    </button>`).join('') || '<p class="empty muted">' +
      (cases.length ? 'Обращений по этим условиям нет.' : 'Здесь появятся обращения.') + '</p>'
  renderChat()
}
async function refresh() {
  cases = config.user ? await api('cases') : []
  draw()
}
function modal(title, content, variant = '') {
  $('dialog').dataset.variant = variant
  const marker = variant === 'moderation' ? '<span class="role-icon">' + icon('shield') + '</span>' : ''
  $('dialog-content').innerHTML = '<div class="dialog-head"><h2 id="dialog-title">' + marker + escapeHtml(title) +
    '</h2><button type="button" class="secondary" id="close-dialog" aria-label="Закрыть">×</button></div>' +
    '<p id="dialog-error" class="error" role="alert" hidden></p>' + content
  $('close-dialog').onclick = () => $('dialog').close()
  if (!$('dialog').open) $('dialog').showModal()
  else $('close-dialog').focus()
  animateUi($('dialog-content'), { opacity: [.35, 1], y: [8, 0] }, { duration: .32 })
}
function showAction(item, action, suggestion = null) {
  if (action === 'priority') {
    const choices = [...config.priorities].reverse().map(priority => ({
      id: priority, name: priorityCode[priority] + ' · ' + priority,
    }))
    modal('Изменить приоритет', `<form class="action-form" data-action="priority">
      <label>Приоритет<select name="priority">${options(choices, item.priority)}</select></label>
      <button>Сохранить приоритет</button>
    </form>`)
    return
  }
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
  const chat = $('chat')
  const item = cases.find(entry => entry.id === openId)
  if (!item) {
    delete chat.dataset.caseId
    $('chat').innerHTML = '<div class="chat-empty"><span class="role-icon">' + icon('brand') +
      '</span><h2>Переписка</h2><p>Выберите обращение из списка.</p></div>'
    $('case-details').innerHTML = '<h2>Обращение</h2><p class="muted">Здесь будут детали выбранного чата.</p>'
    return
  }
  const active = !item.moderated && Boolean(config.transitions[item.status])
  const admin = config.user.role === 'admin'
  const staff = config.user.role !== 'author'
  const chatTitle = staff ? item.authorName : item.category
  const sameChat = chat.dataset.caseId === String(item.id)
  const previousMessages = sameChat ? chat.querySelector('.messages').childElementCount : 0
  const previousStatus = sameChat ? chat.querySelector('.tag').textContent : ''
  const sending = pendingMessages.has(config.user.id + ':' + item.id)
  const spamNotice = (time, label) => ({ actor: 'Система', label, time })
  const original = admin && item.moderated
    ? spamNotice(item.created, 'Обращение с нарушениями перемещено в спам.')
    : { actor: item.authorName, text: item.description, time: item.created, label: 'Исходное обращение', attachments: item.attachments }
  const events = [original, ...item.history.slice(1)].map((event, index) => ({ ...event, index }))
  for (const { time } of item.moderationNotices || []) {
    events.push(spamNotice(time, 'Сообщение с нарушениями перемещено в спам.'))
  }
  events.sort((a, b) => a.time.localeCompare(b.time))
  chat.dataset.caseId = item.id
  chat.innerHTML = `
    <nav class="mobile-nav" aria-label="Навигация по обращению">
      <button type="button" class="quiet" data-pane-target="list">${icon('back')} Все чаты</button>
      <button type="button" class="quiet" data-pane-target="details">${icon('details')} Карточка</button>
    </nav>
    <header class="chat-head">
      <span class="avatar" aria-hidden="true">${escapeHtml(initials(chatTitle))}</span>
      <div><h2 id="chat-heading" tabindex="-1">${escapeHtml(chatTitle)}</h2><p>${item.number} · ${escapeHtml(staff ? item.category : typeLabel(item.type))}</p></div>
      <span class="tag" data-tone="${item.moderated ? 'amber' : statusTones[item.status] || 'neutral'}">${item.moderated ? 'На модерации' : escapeHtml(item.status)}</span>
    </header>
    <div class="messages">${events.map(event => `
      <article class="message ${event.actor === config.user.name ? 'own-message' : ''}">
        <div class="message-meta"><strong>${event.actor === config.user.name ? 'Вы' : escapeHtml(event.actor)}</strong><span>${timeFormat.format(new Date(event.time))}</span></div>
        ${event.label !== 'Комментарий' ? '<small>' + escapeHtml(event.label) + '</small>' : ''}
        ${event.text ? '<p class="copy">' + contentText(event.text, item.id) + '</p>' : ''}
        ${renderAttachments(event.attachments)}
        ${admin && event.actor === config.user.name && event.label === 'Комментарий' ? '<button type="button" class="save-answer" data-knowledge="' + event.index + '">Сохранить как общий ответ</button>' : ''}
      </article>`).join('')}</div>
    ${active ? `<form id="composer" class="composer" data-case-id="${item.id}">
      ${staff ? `<div class="chat-actions">
        ${admin ? '<button class="ai-button" type="button" data-chat-action="suggest">' + icon('spark') + ' Рекомендация ИИ</button><button class="secondary" type="button" data-chat-action="assign">Поручить</button>' : ''}
        <button class="secondary" type="button" data-chat-action="status">Изменить статус</button>
        ${admin ? '<button class="secondary" type="button" data-chat-action="priority">Изменить приоритет</button>' : ''}
      </div>` : ''}
      <div class="composer-media-feedback">${mediaFeedback()}</div>
      <div class="compose-row">
        <textarea name="text" aria-label="Сообщение" placeholder="Написать сообщение…" maxlength="4000" required rows="2">${escapeHtml(drafts.get(item.id))}</textarea>
        ${mediaButtons()}
        <button type="submit" aria-label="Отправить сообщение" title="Отправить сообщение">${icon('send')}<span class="send-spinner" aria-hidden="true"></span></button>
      </div>
      <span class="sr-only" role="status" data-send-status></span>
    </form>` : '<div class="composer muted">' + (item.moderated
      ? admin ? '<button type="button" class="secondary" data-chat-action="moderation">Открыть спам</button>' : 'Обращение ожидает проверки координатором.'
      : 'Обращение завершено') + '</div>'}`
  $('case-details').innerHTML = `
    <nav class="mobile-nav" aria-label="Навигация по карточке">
      <button type="button" class="quiet" data-pane-target="chat">${icon('back')} К переписке</button>
    </nav>
    <div class="details-head"><span class="details-icon">${icon('details')}</span><div><p class="eyebrow">Карточка ${item.number}</p><h2 id="details-heading" tabindex="-1">Об обращении</h2></div></div>
    <dl class="case-facts">
      <div><dt>Тип</dt><dd>${escapeHtml(typeLabel(item.type))}</dd></div>
      ${item.anonymous ? '<div><dt>Автор</dt><dd>Анонимный сотрудник</dd></div>' :
        '<div><dt>Подразделение</dt><dd>' + escapeHtml(item.department) + '</dd></div>'}
      <div><dt>Приоритет</dt><dd>${escapeHtml([priorityCode[item.priority], item.priority].filter(Boolean).join(' · '))}</dd></div>
      <div><dt>Исполнитель</dt><dd>${escapeHtml(item.ownerName)}</dd></div>
      <div><dt>Срок</dt><dd class="${item.overdue ? 'late' : ''}">${dateFormat.format(new Date(item.due))}${item.overdue ? ' · Просрочено' : ''}</dd></div>
    </dl>
    ${item.task ? '<section class="box"><h3>Поручение</h3><p class="copy">' + contentText(item.task, item.id) + '</p></section>' : ''}
    ${item.result ? '<section class="box"><h3>Итог</h3><p class="copy">' + contentText(item.result, item.id) + '</p></section>' : ''}
    ${ratingSummary(item, 'Оценка компании', item.rating)}
    ${ratingSummary(item, 'Оценка решения', item.resolutionRating)}
    ${item.canRateResolution ? '<button type="button" class="secondary" id="rate-resolution">Оценить решение</button>' : ''}`
  if (item.canRateResolution) $('rate-resolution').onclick = () => showRating(item.id, 'resolutionRating')
  translateContent(chat)
  translateContent($('case-details'))
  if (active && attachmentDrafts.has(String(item.id))) showFiles($('composer'), attachmentDrafts.get(String(item.id)))
  maybePromptRating(item)
  const messages = $('chat').querySelector('.messages')
  messages.scrollTop = messages.scrollHeight
  if (sending && active) setSending($('composer'), true)
  if (sameChat && events.length > previousMessages) {
    const added = Array.from(messages.children).slice(Math.max(previousMessages, events.length - 4))
    added.forEach((message, index) => {
      animateUi(message, { opacity: [0, 1], y: [16, 0], scale: [.985, 1] },
        { delay: index * .055, duration: .36 })
    })
  }
  const status = chat.querySelector('.tag')
  if (sameChat && previousStatus !== status.textContent) {
    animateUi(status, { opacity: [.5, 1], scale: [.92, 1] })
  }
}

function setSending(form, sending) {
  const button = form.querySelector('button[type="submit"]')
  button.disabled = sending
  button.setAttribute('aria-busy', String(sending))
  form.elements.text.readOnly = sending
  form.querySelector('[data-send-status]').textContent = sending ? 'Сообщение отправляется' : ''
}
async function recommend(item) {
  modal('Рекомендация ИИ', '<p role="status">Gemini готовит рекомендацию…</p>')
  const pending = $('dialog-error')
  let result
  try {
    result = await api('cases/' + item.id + '/suggest', { language })
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
  modal('Новое обращение', `
    <form class="action-form new-case-form" data-action="create">
      <div class="grid">
      <label>Тип<select name="type">${options(config.types.map(type => ({ id: type, name: typeLabel(type) })))}</select></label>
      <label>Как отправить<select name="anonymous">
        <option value="false">От моего имени</option>
        <option value="true">Анонимно</option>
      </select></label>
      </div>
      <label>Описание<textarea name="description" required maxlength="4000" rows="5" placeholder="Что произошло или что предлагаете изменить?"></textarea></label>
      <div class="new-case-footer">
        ${mediaControls()}
        <button type="submit">Подать обращение ${icon('arrow')}</button>
      </div>
    </form>`)
}
$('dialog').addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.target
  const button = form.querySelector('button[type="submit"]') || form.querySelector('button')
  const action = form.dataset.action
  const caseId = openId
  const data = Object.fromEntries(new FormData(form))
  if (action === 'create' && mediaWorking(form)) {
    mediaStatus(form, 'Дождитесь окончания расшифровки.')
    return
  }
  button.disabled = true
  try {
    if (action === 'moderation') {
      await api('moderation/' + data.caseId, { id: data.id, action: data.operation, text: data.text })
      await refresh()
      if ($('dialog').open) await showModeration()
      notice(data.operation === 'reply' ? 'Ответ отправлен автору.' : 'Чат удалён.')
      return
    }
    if (action === 'knowledge') {
      await api('cases/' + caseId + '/knowledge', { ...data, index: Number(data.index) })
      $('dialog').close()
      notice('Общий ответ добавлен в базу знаний.')
      return
    }
    const item = action === 'create' ? await api('cases', { ...data, anonymous: data.anonymous === 'true', attachments: await encodeFiles(form) }) :
      await api('cases/' + caseId, { ...data, action })
    openId = item.id
    if (action === 'create') resetFilters()
    await refresh()
    if ($('dialog').open) $('dialog').close()
    if (action === 'create') showPane('chat', true)
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
function ratingSummary(item, title, rating) {
  if (!rating) return ''
  return '<section class="box"><h3>' + title + '</h3><strong>' + rating.score + ' из 5</strong>' +
    (rating.comment ? '<p class="copy">' + contentText(rating.comment, item.id) + '</p>' : '') + '</section>'
}
function maybePromptRating(item) {
  if (!item?.canRateResolution || promptedRatings.has(item.id) || !$('rating-card').hidden ||
      $('dialog').open || tour.open || (mobileWorkspace.matches && $('workspace').dataset.pane !== 'chat')) return
  promptedRatings.add(item.id)
  showRating(item.id, 'resolutionRating')
}
function showRating(caseId, kind = 'rating') {
  const form = $('rating-form')
  form.reset()
  form.dataset.caseId = caseId
  form.dataset.kind = kind
  $('rating-title').textContent = kind === 'resolutionRating' ? 'Вам помогли?' : 'Вам нравится наша компания?'
  $('rating-comment').placeholder = kind === 'resolutionRating' ? 'Что помогло или что ещё нужно решить?' : 'Что вам нравится или что можно улучшить?'
  $('rating-error').hidden = true
  $('rating-card').hidden = false
  animateUi($('rating-card'), { opacity: [0, 1], y: [14, 0], scale: [.985, 1] }, { duration: .38 })
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
      kind: form.dataset.kind, score: Number(data.get('score')), comment: data.get('comment'),
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
    const previousId = openId
    openId = Number(button.dataset.case)
    void api('cases/' + openId + '/open', {}).catch(() => {})
    draw()
    showPane('chat', true)
    if (mobileWorkspace.matches) {
      $('chat-heading').focus({ preventScroll: true })
    } else {
      $('cases').querySelector('[aria-current="true"]')?.focus()
      if (openId !== previousId) {
        animateUi($('chat').querySelector('.messages'), { opacity: [.45, 1], y: [5, 0] })
        animateUi($('case-details').querySelector('.details-head'), { opacity: [.5, 1], x: [5, 0] })
      }
    }
  }
})
$('workspace').addEventListener('click', event => {
  const target = event.target.closest('[data-pane-target]')?.dataset.paneTarget
  if (!target) return
  showPane(target, true)
  if (target === 'list') {
    const selected = $('cases').querySelector('[aria-current="true"]') || $('queue-heading')
    selected.focus({ preventScroll: true })
  } else {
    $(target === 'chat' ? 'chat-heading' : 'details-heading').focus({ preventScroll: true })
  }
})
$('chat').addEventListener('click', event => {
  const knowledge = event.target.closest('[data-knowledge]')
  const item = cases.find(entry => entry.id === openId)
  if (knowledge) return approveAnswer(item, Number(knowledge.dataset.knowledge))
  const action = event.target.closest('[data-chat-action]')?.dataset.chatAction
  if (!action) return
  if (action === 'suggest') recommend(item)
  else if (action === 'moderation') showModeration().catch(error => notice(error.message, true))
  else showAction(item, action)
})
$('chat').addEventListener('input', event => {
  if (event.target.name === 'text') drafts.set(openId, event.target.value)
})
$('chat').addEventListener('submit', async event => {
  event.preventDefault()
  const id = openId
  const user = config.user
  const key = user.id + ':' + id
  if (pendingMessages.has(key)) return
  const form = event.target
  if (mediaWorking(form)) {
    mediaStatus(form, 'Дождитесь окончания расшифровки.')
    return
  }
  const text = form.elements.text.value
  pendingMessages.add(key)
  setSending(form, true)
  const plane = form.querySelector('button[type="submit"] .icon')
  const launch = animateUi(plane, { x: [0, 7], y: [0, -7] }, { duration: .19 })
  try {
    const attachments = await encodeFiles(form)
    if (config.user !== user) return
    const item = await api('cases/' + id, { action: 'comment', text, attachments })
    if (config.user !== user) return
    attachmentDrafts.delete(String(id))
    notice(item.messageModerated ? 'Сообщение отправлено на модерацию.' : '')
    if (drafts.get(id) === text) drafts.delete(id)
    pendingMessages.delete(key)
    cases = cases.map(entry => entry.id === id ? item : entry)
    if (tour.open) {
      redrawChatAfterTour = true
      return
    }
    const returnFocus = openId === id && (form.contains(document.activeElement) || document.activeElement === document.body)
    draw()
    if (returnFocus && !$('dialog').open) $('composer')?.elements.text.focus({ preventScroll: true })
  } catch (error) {
    if (config.user === user) notice(error.message, true)
  } finally {
    pendingMessages.delete(key)
    launch?.stop()
    plane.style.transform = ''
    if (config.user.id === user.id && openId === id && $('composer')) setSending($('composer'), false)
  }
})
function resetFilters() {
  for (const id of ['search', 'type-filter', 'status-filter', 'category-filter', 'department-filter']) $(id).value = ''
  $('late-filter').checked = false
}
$('filters').addEventListener('input', () => {
  const list = $('cases')
  const previous = list.textContent
  draw()
  if (list.textContent !== previous) animateUi(list, { opacity: [.55, 1], y: [4, 0] }, { duration: .22 })
})
$('stats-panel').addEventListener('toggle', () => {
  if ($('stats-panel').open && !$('stats-panel').hidden) animateUi($('stats'), { opacity: [.25, 1], y: [-5, 0] })
})
document.querySelector('.extra-filters').addEventListener('toggle', event => {
  if (event.target.open) animateUi(event.target.querySelectorAll('select:not([hidden]), .checkbox'),
    { opacity: [.25, 1], y: [-4, 0] }, { duration: .26 })
})
$('new-case').onclick = newCase
$('refresh').onclick = async () => {
  $('refresh').disabled = true
  try {
    await refresh()
    notice('Список обновлён.')
  } catch (error) {
    notice(error.message, true)
  } finally {
    $('refresh').disabled = false
  }
}
const seenKey = 'kontur-inbox-seen'
async function checkInbox(show = false) {
  if (config?.user?.role !== 'admin') return
  const { events, unread } = await api('audit?after=' + (localStorage.getItem(seenKey) || 0))
  if (config?.user?.role !== 'admin') return
  const changed = $('unread').textContent !== String(unread) || $('unread').hidden
  $('unread').textContent = unread
  $('unread').hidden = !unread
  if (unread && changed && !show && !tour.open) {
    animateUi($('unread'), { scale: [.7, 1.14, 1], opacity: [.4, 1, 1] }, { duration: .35 })
  }
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
  modal('Спам и нарушения', '<div class="moderation-list">' + (entries.map((entry, index) => `
    <details class="moderation-entry" ${index === 0 ? 'open' : ''}>
      <summary>
        <span class="moderation-entry-id">${escapeHtml(entry.number)}</span>
        <span class="moderation-reason">${escapeHtml(entry.reason)}</span>
        <span class="analytics-request-chevron">${icon('down')}</span>
      </summary>
      <div class="moderation-body">
      <small class="muted">${escapeHtml(entry.author)} · ${timeFormat.format(new Date(entry.time))}</small>
      <p class="copy">${contentText(entry.text, entry.caseId)}</p>
      ${renderAttachments(entry.attachments)}
      ${entry.replies.map(reply => '<p class="copy"><strong>Ответ по модерации</strong> · ' + contentText(reply.text, entry.caseId) + '</p>').join('')}
      <div class="chat-actions" data-moderation-case="${entry.caseId}" data-moderation-id="${escapeHtml(entry.id)}">
        <button type="button" data-moderation-action="reply">${icon('brand')} Ответить автору</button>
        <button type="button" class="secondary" data-moderation-action="restore">${icon('back')} Вернуть ${entry.id === 'case' ? 'во входящие' : entry.kind ? 'к оценке' : 'в чат'}</button>
        <button type="button" class="secondary" data-moderation-action="delete">Удалить чат</button>
      </div>
      </div>
    </details>`).join('') || '<p class="moderation-empty muted">' + icon('check') + ' На проверке ничего нет.</p>') + '</div>', 'moderation')
  for (const entry of $('dialog').querySelectorAll('.moderation-entry[open]')) translateContent(entry)
}
$('dialog').addEventListener('toggle', event => {
  if (event.target.matches('.moderation-entry') && event.target.open) translateContent(event.target)
}, true)
$('moderation').onclick = () => showModeration().catch(error => notice(error.message, true))
$('dialog').addEventListener('click', async event => {
  const button = event.target.closest('[data-moderation-action]')
  if (!button) return
  const { moderationAction: action } = button.dataset
  const { moderationCase: caseId, moderationId: id } = button.parentElement.dataset
  if (action !== 'restore') {
    const reply = action === 'reply'
    modal(reply ? 'Ответить автору' : 'Удалить чат', `
      <form class="action-form" data-action="moderation">
        <input type="hidden" name="caseId" value="${escapeHtml(caseId)}">
        <input type="hidden" name="id" value="${escapeHtml(id)}">
        <input type="hidden" name="operation" value="${action}">
        ${reply ? '<label>Сообщение<textarea name="text" required maxlength="4000" rows="4"></textarea></label>' :
          '<p>Весь чат исчезнет у автора, координатора и исполнителя.</p>'}
        <button type="submit" ${reply ? '' : 'class="moderation-delete"'}>${reply ? 'Отправить сообщение' : 'Удалить чат'}</button>
        <button type="button" class="secondary" id="moderation-back">Назад</button>
      </form>`, 'moderation')
    $('moderation-back').onclick = () => showModeration().catch(error => notice(error.message, true))
    return
  }
  button.disabled = true
  try {
    await api('moderation/' + caseId, { id })
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
    $('telegram-label').textContent = status.connected ? 'Уведомления подключены' : 'Подключить уведомления'
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
          $('telegram-label').textContent = 'Подключить уведомления'
          $('dialog').close()
        } catch (error) {
          $('dialog-error').textContent = error.message
          $('dialog-error').hidden = false
        }
      }
    } else {
      const { url } = await api('telegram', {})
      modal('Подключить уведомления', '<p>Откройте бота и нажмите «Старт». Ссылка действует пять минут.</p><a href="' +
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
  if (openId) showPane('chat', true)
})
setInterval(async () => {
  if (document.hidden || !config?.user) return
  void checkInbox().catch(() => {})
  void checkTelegram().catch(() => {})
  if ($('dialog').open || analyticsDrilldown.open || profilePicker.open || tour.open || pendingMessages.size || activeRecording ||
      ($('composer') && mediaWorking($('composer')))) return
  const focused = () => $('workspace').contains(document.activeElement)
  if (focused() && config.user.role !== 'author') return
  try {
    const profile = config.user.id
    const items = await api('cases')
    if (config.user?.id !== profile || $('dialog').open || analyticsDrilldown.open || profilePicker.open || tour.open || pendingMessages.size) return
    const previous = cases.find(item => item.id === openId)
    const current = items.find(item => item.id === openId)
    if (focused() && !(config.user.role === 'author' && current?.canRateResolution && !previous?.canRateResolution)) return
    if (JSON.stringify(items) !== JSON.stringify(cases)) {
      cases = items
      draw()
    }
  } catch {
    // The refresh button reports connection errors on demand.
  }
}, 5000)

const languageStep = ['#site-language', 'Выберите язык сайта', 'Можно переключаться между русским, казахским и английским.']
const chatStep = ['.chat-head', 'Откройте переписку', 'В чате видны сообщения и история решений. Поле внизу отправляет сообщение участникам обращения.', 'chat']
const detailsStep = ['.details-head', 'Посмотрите детали', 'В карточке указаны исполнитель, срок, приоритет и итог работы.', 'details']
const guides = {
  guest: {
    title: 'Инструкция',
    steps: [
      ['#profile-form', 'Выберите роль', 'Сотрудник отправляет обращения, координатор разбирает входящие, исполнитель работает с назначенными задачами.'],
      languageStep,
    ],
  },
  author: {
    title: 'Инструкция для сотрудника',
    steps: [
      ['#new-case', 'Подайте обращение', 'Выберите тип и опишите ситуацию. Для темы, которой нет в списке, выберите «Другое».'],
      ['#new-case', 'Выберите способ отправки', 'В форме можно отправить обращение от своего имени или анонимно. При анонимной подаче имя и подразделение скрыты, а ответы доступны в вашем чате.'],
      ['#new-case', 'Добавьте голос, фото или видео', 'Нажмите «Записать голос», чтобы получить редактируемый текст. Через «Фото или видео» можно добавить до трёх файлов общим размером до 12 МБ.'],
      ['#new-case', 'Задайте простой вопрос', 'Выберите тип «Вопрос». Если в базе знаний есть подходящий утверждённый ответ, он появится в чате автоматически.'],
      ['#new-case', 'Оцените компанию', 'После отправки положительного отзыва в углу появится окно. Выберите от 1 до 5 звёзд и при желании добавьте комментарий.'],
      ['#search', 'Найдите своё обращение', 'Ищите по теме или номеру. Фильтры помогут найти нужный тип или статус.', 'list'],
      chatStep,
      detailsStep,
      ['.details-head', 'Оцените решение', 'После выполнения обращения ответьте на вопрос «Вам помогли?». Поставьте от 1 до 5 звёзд и при желании напишите, что ещё нужно решить.', 'details'],
      languageStep,
    ],
  },
  admin: {
    title: 'Инструкция для координатора',
    steps: [
      ['#search', 'Найдите нужный чат', 'Ищите по сотруднику, теме или номеру обращения. Фильтр по типу поможет найти, например, только жалобы.', 'list'],
      ['.chat-head', 'Разберите обращение', 'В чате видны сообщения и история. У анонимных обращений имя и подразделение автора скрыты.', 'chat'],
      ['[data-chat-action="suggest"]', 'Используйте рекомендацию ИИ', 'Gemini предлагает черновик ответа, поручение и исполнителя. Проверьте предложение перед отправкой.', 'chat'],
      ['[data-chat-action="assign"]', 'Назначьте исполнителя', 'Нажмите «Поручить», выберите исполнителя и укажите срок. Кнопка «Изменить статус» позволяет запросить уточнение или зафиксировать итог.', 'chat'],
      ['[data-chat-action="priority"]', 'Укажите приоритет', 'Выберите P1 для срочного обращения, P2 для обычного или P3 для низкого приоритета.', 'chat'],
      ['.chat-head', 'Сохраните ответ в базу знаний', 'Под своим сообщением нажмите «Сохранить как общий ответ». Утверждённый ответ можно использовать для похожих вопросов.', 'chat'],
      ['#notifications', 'Проверьте входящие', 'Счётчик показывает новые обращения. Внутри уведомлений также есть журнал действий по демо-профилям.'],
      ['#moderation', 'Проверьте спам', 'В разделе «Спам и нарушения» можно прочитать исходный текст, ответить автору, вернуть сообщение или удалить чат.'],
      ['#telegram', 'Подключите Telegram', 'Откройте бота по ссылке и нажмите «Старт». В Telegram будут приходить новые обращения с полным текстом.'],
      ['#open-analytics', 'Откройте аналитику', 'Здесь можно проверить просрочки, открыть обращения по типу или статусу, посмотреть оценки и скачать отчёт.'],
      ['#open-repeats', 'Найдите повторяющиеся проблемы', 'Откройте вкладку, чтобы увидеть похожие жалобы и решения, сохранённые по каждой из них.'],
      ['.details-head', 'Посмотрите оценку компании', 'Оценка и комментарий сотрудника появятся в карточке положительного отзыва.', 'details'],
      languageStep,
    ],
  },
  owner: {
    title: 'Инструкция для исполнителя',
    steps: [
      ['#search', 'Найдите назначенное обращение', 'Используйте поиск и фильтры, чтобы найти нужное поручение.', 'list'],
      detailsStep,
      chatStep,
      ['[data-chat-action="status"]', 'Обновите статус работы', 'Запросите уточнение у автора или укажите итог, когда работа завершена.', 'chat'],
      languageStep,
    ],
  },
}
const analyticsGuide = [
  ['#analytics-stats', 'Оцените нагрузку', 'Сводка показывает общее число обращений, сколько из них открыты, завершены или просрочены.'],
  ['#analytics-type-heading', 'Изучите диаграмму', 'Нажмите на сектор диаграммы или строку в легенде, чтобы открыть список обращений этого типа. Нажмите на обращение, чтобы прочитать текст.'],
  ['#analytics-status-heading', 'Отфильтруйте по статусу', 'Нажмите на статус, чтобы увидеть соответствующие обращения. Заголовок «Обращения по статусам» откроет весь список.'],
  ['[data-rating-toggle="rating"]', 'Проверьте оценки', 'Нажмите на заголовок оценки компании или решения, чтобы увидеть все звёзды и комментарии. Раздел «1–2 звезды» показывает низкие оценки.'],
  ['#download-report', 'Скачайте отчёт', 'PDF содержит круговую диаграмму, общие показатели и разбивку по статусам на выбранном языке.'],
]
const repeatGuide = [
  ['#repeat-groups', 'Найдите повторяющиеся проблемы', 'Откройте группу и раскройте обращение, чтобы прочитать жалобу и принятое решение.'],
]
let tourSteps = []
let tourIndex = 0
let tourTarget
let tourOrigin
let tourFrame
let tourLayout
let tourFlight
let tourClosing = false
const tourCard = $('tour-card')
const tourGlass = $('tour-glass')

function measureTour() {
  const width = tour.clientWidth
  const height = tour.clientHeight
  const rect = tourTarget.getBoundingClientRect()
  const header = document.querySelector('.top')
  const stickyTop = getComputedStyle(header).position === 'sticky' && !header.contains(tourTarget)
    ? header.getBoundingClientRect().bottom : 0
  const left = Math.max(0, Math.floor(rect.left - 7))
  const right = Math.min(width, Math.ceil(rect.right + 7))
  const top = Math.max(stickyTop, Math.floor(rect.top - 7))
  const bottom = Math.min(height, Math.ceil(rect.bottom + 7))
  const cardWidth = tourCard.offsetWidth
  const cardHeight = tourCard.offsetHeight
  const gap = 16
  const centerX = (left + right - cardWidth) / 2
  const centerY = (top + bottom - cardHeight) / 2
  const candidates = [[centerX, bottom + gap], [centerX, top - cardHeight - gap],
    [right + gap, centerY], [left - cardWidth - gap, centerY]]
  const positions = candidates.map(([x, y]) => {
    x = Math.max(gap, Math.min(x, width - cardWidth - gap))
    y = Math.max(gap, Math.min(y, height - cardHeight - gap))
    const overlap = Math.max(0, Math.min(right, x + cardWidth) - Math.max(left, x)) *
      Math.max(0, Math.min(bottom, y + cardHeight) - Math.max(top, y))
    return { x, y, overlap }
  })
  const { x, y } = positions.sort((a, b) => a.overlap - b.overlap)[0]
  return { width, height, left, right, top, bottom, x, y }
}

function paintTour(layout) {
  tourLayout = layout
  const { width, height, left, right, top, bottom, x, y } = layout
  const radius = Math.min(13, (right - left) / 2, (bottom - top) / 2)
  const outer = `M0 0 H${width} V${height} H0 Z`
  const opening = radius > 0 ? `M${left + radius} ${top} H${right - radius}
    Q${right} ${top} ${right} ${top + radius} V${bottom - radius}
    Q${right} ${bottom} ${right - radius} ${bottom} H${left + radius}
    Q${left} ${bottom} ${left} ${bottom - radius} V${top + radius}
    Q${left} ${top} ${left + radius} ${top} Z` : ''
  tourGlass.style.clipPath = `path(evenodd, "${outer} ${opening.replace(/\s+/g, ' ')}")`
  tourCard.style.transform = `translate3d(${x}px, ${y}px, 0)`
}

function moveTour(previousScroll) {
  const endScroll = window.scrollY
  const destination = measureTour()
  const origin = tourLayout
  if (!origin || reducedMotion.matches || !window.Motion) {
    paintTour(destination)
    return
  }
  // Measure at the final scroll position, then move the page and the cutout together.
  window.scrollTo({ top: previousScroll, behavior: 'instant' })
  const startScroll = window.scrollY
  tourFlight = animateUi(0, 1, {
    duration: .54,
    ease: [.4, 0, .22, 1],
    onUpdate(progress) {
      const mix = (from, to) => from + (to - from) * progress
      if (startScroll !== endScroll) window.scrollTo({ top: mix(startScroll, endScroll), behavior: 'instant' })
      paintTour({
        width: destination.width, height: destination.height,
        left: mix(origin.left, destination.left), right: mix(origin.right, destination.right),
        top: mix(origin.top, destination.top), bottom: mix(origin.bottom, destination.bottom),
        x: mix(origin.x, destination.x), y: mix(origin.y, destination.y),
      })
    },
    onComplete() {
      tourFlight = null
      if (startScroll !== endScroll) window.scrollTo({ top: endScroll, behavior: 'instant' })
      paintTour(measureTour())
    },
  })
}

function scheduleTourPosition() {
  if (!tour.open || tourClosing || tourFlight || tourFrame) return
  tourFrame = requestAnimationFrame(() => {
    tourFrame = null
    if (tour.open && !tourClosing && !tourFlight) paintTour(measureTour())
  })
}

async function finishTour() {
  if (tourClosing) return
  tourClosing = true
  tourFlight?.stop()
  tourFlight = null
  const fade = animateUi([tourCard, tourGlass], { opacity: 0 }, { duration: .17, ease: 'easeIn' })
  if (fade) await fade
  tour.close()
  tourCard.style.opacity = ''
  tourGlass.style.opacity = ''
  tourLayout = null
  tourClosing = false
  if (redrawChatAfterTour) {
    redrawChatAfterTour = false
    draw()
  }
  showPane(tourOrigin.pane)
  window.scrollTo({ top: tourOrigin.scroll, behavior: 'instant' })
  $('instructions').focus({ preventScroll: true })
}
function showStep(direction = 1) {
  tourFlight?.stop()
  tourFlight = null
  const opening = !tour.open
  const [selector, title, description, pane] = tourSteps[tourIndex]
  if (pane && mobileWorkspace.matches) showPane(pane)
  tourTarget = document.querySelector(selector)
  $('tour-counter').textContent = `Шаг ${tourIndex + 1} из ${tourSteps.length}`
  Array.from($('tour-progress').children).forEach((segment, index) => {
    segment.classList.toggle('filled', index <= tourIndex)
  })
  $('tour-title').textContent = title
  $('tour-description').textContent = description
  $('tour-next').textContent = tourIndex + 1 < tourSteps.length ? 'Далее' : 'Готово'
  tour.querySelector('[data-tour="back"]').hidden = tourIndex === 0
  if (opening) tour.showModal()
  const previousScroll = window.scrollY
  tourTarget.scrollIntoView({ behavior: 'instant', block: 'nearest' })
  moveTour(previousScroll)
  if (opening) animateUi([tourGlass, tourCard], { opacity: [0, 1] }, { duration: .25 })
  animateUi(tour.querySelector('.tour-copy'), { opacity: [.35, 1], y: [direction * 7, 0] },
    { duration: .34, delay: opening ? 0 : .09 })
  tour.querySelector('[data-tour="next"]').focus({ preventScroll: true })
}
$('instructions').onclick = () => {
  tourOrigin = { pane: $('workspace').dataset.pane, scroll: window.scrollY }
  const guide = guides[config?.user?.role || 'guest']
  $('tour-role').textContent = guide.title
  $('tour-page-note').hidden = Boolean(config?.user)
  const steps = !$('repeats').hidden ? repeatGuide : $('analytics').hidden ? guide.steps : analyticsGuide
  tourSteps = steps.filter(([selector, , , pane]) => {
    const target = document.querySelector(selector)
    return target && (pane ? !$('workspace').hidden : target.getClientRects().length)
  })
  if (!tourSteps.length) return
  $('tour-progress').innerHTML = '<span></span>'.repeat(tourSteps.length)
  tourIndex = 0
  showStep()
}
tour.onclick = event => {
  if (tourClosing) return
  const action = event.target.closest('[data-tour]')?.dataset.tour
  if (!action) return
  if (action === 'close' || (action === 'next' && tourIndex + 1 === tourSteps.length)) return finishTour()
  const direction = action === 'next' ? 1 : -1
  tourIndex += direction
  showStep(direction)
}
tour.addEventListener('cancel', event => {
  event.preventDefault()
  finishTour()
})
window.addEventListener('scroll', scheduleTourPosition, { capture: true, passive: true })
window.addEventListener('resize', () => {
  if (!tour.open || tourClosing) return
  tourFlight?.stop()
  tourFlight = null
  const pane = tourSteps[tourIndex][3]
  if (pane && mobileWorkspace.matches) showPane(pane)
  tourTarget.scrollIntoView({ behavior: 'instant', block: 'nearest' })
  scheduleTourPosition()
})
const profilePicker = $('profile-picker')
let profileRole = ''

function setProfile(profile) {
  $('profile').value = profile?.id || ''
  $('profile-trigger-label').textContent = profile?.name || 'Выберите профиль'
}

function drawProfileOptions() {
  const selected = $('profile').value
  const query = $('profile-search').value.trim().toLocaleLowerCase(locale)
  $('profile-roles').querySelectorAll('button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.profileRole === profileRole))
  })
  const groups = Object.entries(roleNames).map(([role, label]) => {
    if (profileRole && role !== profileRole) return ''
    const profiles = config.profiles.filter(profile => profile.role === role &&
      [profile.name, profile.department, label].map(translate).join(' ').toLocaleLowerCase(locale).includes(query))
    if (!profiles.length) return ''
    const heading = !profileRole && profiles[0].name !== label ? '<h3>' + label + '</h3>' : ''
    return '<div class="profile-group">' + heading + profiles.map(profile => `
      <button type="button" class="profile-option" data-profile-id="${escapeHtml(profile.id)}" aria-current="${profile.id === selected}">
        <span class="avatar" data-role-tone="${role}" aria-hidden="true">${escapeHtml(initials(profile.name))}</span>
        <span class="profile-option-text"><strong>${escapeHtml(profile.name)}</strong>
          ${profile.department ? '<small>' + escapeHtml(profile.department) + '</small>' : ''}</span>
        <span class="profile-option-check">${icon('tick')}</span>
      </button>`).join('') + '</div>'
  }).join('')
  $('profile-options').innerHTML = groups || '<p class="profile-empty" role="status">Подходящих профилей нет.</p>'
  $('profile-options').scrollTop = 0
}

function openProfilePicker(role = '') {
  if (!config || profilePicker.open) return
  profileRole = role
  $('profile-search').value = ''
  drawProfileOptions()
  profilePicker.showModal()
  $('profile-options').querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  if (!mobileWorkspace.matches) $('profile-search').focus({ preventScroll: true })
  animateUi(profilePicker, { opacity: [0, 1], y: [10, 0], scale: [.985, 1] }, { duration: .32 })
}

$('profile-trigger').onclick = () => openProfilePicker()
$('close-profile-picker').onclick = () => profilePicker.close()
$('profile-search').addEventListener('input', drawProfileOptions)
$('profile-roles').addEventListener('click', event => {
  const button = event.target.closest('[data-profile-role]')
  if (!button) return
  profileRole = button.dataset.profileRole
  drawProfileOptions()
})
$('profile-options').addEventListener('click', event => {
  const button = event.target.closest('[data-profile-id]')
  if (!button) return
  const profile = config.profiles.find(entry => entry.id === button.dataset.profileId)
  if (!profile) return
  profilePicker.close()
  if (config.user) {
    if (profile.id !== config.user.id) void switchProfile(profile.id)
    return
  }
  setProfile(profile)
  $('profile-submit-label').textContent = 'Подтвердите вход'
  $('profile-form').querySelector('button[type="submit"]').focus({ preventScroll: true })
})
profilePicker.addEventListener('keydown', event => {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(event.key)) return
  const rows = Array.from($('profile-options').querySelectorAll('button'))
  if (!rows.length) return
  const current = rows.indexOf(event.target)
  if (current < 0 && (event.target !== $('profile-search') || !event.key.startsWith('Arrow'))) return
  event.preventDefault()
  const index = {
    ArrowDown: Math.min(current + 1, rows.length - 1),
    ArrowUp: current < 0 ? rows.length - 1 : current - 1,
    Home: 0,
    End: rows.length - 1,
  }[event.key]
  const target = rows[index] || $('profile-search')
  target.focus()
})
$('welcome').addEventListener('click', event => {
  const role = event.target.closest('[data-role]')?.dataset.role
  if (role) openProfilePicker(role)
})
$('profile-form').addEventListener('submit', event => {
  event.preventDefault()
  const profileId = $('profile').value
  if (config?.user || !profileId) return openProfilePicker()
  void switchProfile(profileId)
})
const serviceVideo = $('service-video')
$('about-service').onclick = () => {
  serviceVideo.showModal()
  animateUi(serviceVideo, { opacity: [0, 1], y: [10, 0], scale: [.985, 1] }, { duration: .32 })
}
$('close-service-video').onclick = () => serviceVideo.close()
serviceVideo.addEventListener('click', event => {
  if (event.target === serviceVideo) serviceVideo.close()
})
serviceVideo.addEventListener('close', () => serviceVideo.querySelector('video').pause())

$('back-to-welcome').onclick = async () => {
  if (!$('analytics').hidden || !$('repeats').hidden) {
    location.hash = 'main'
    return
  }
  const button = $('back-to-welcome')
  button.disabled = true
  try {
    const response = await fetch('/api/session', { method: 'DELETE' })
    if (!response.ok) throw new Error('Не удалось вернуться на главную.')
    location.assign('/')
  } catch (error) {
    notice(error.message, true)
    button.disabled = false
  }
}
async function switchProfile(profileId) {
  const button = $('profile-form').querySelector('button[type="submit"]')
  if (button.disabled) return
  button.disabled = true
  $('profile-trigger').disabled = true
  try {
    config.user = await api('session', { profile: profileId })
    $('rating-card').hidden = true
    delete $('rating-form').dataset.caseId
    resetFilters()
    drafts.clear()
    attachmentDrafts.clear()
    openId = null
    showPane('list')
    notice('')
    cases = []
    showRole()
    draw()
    $('heading').focus()
    await refresh()
    void checkInbox().catch(() => {})
    void checkTelegram().catch(() => {})
  } catch (error) {
    notice(error.message, true)
  } finally {
    button.disabled = false
    $('profile-trigger').disabled = false
  }
}
async function init() {
  await initializeLanguage()
  if (!reducedMotion.matches) {
    const intro = $('brand-intro')
    intro.addEventListener('animationend', event => {
      if (event.target === intro) intro.hidden = true
    })
    intro.hidden = false
  }
  config = await api('config')
  $('type-filter').innerHTML = options(config.types.map(type => ({ id: type, name: typeLabel(type) })), '', 'Все типы обращений')
  $('status-filter').innerHTML = options(config.statuses, '', 'Все статусы')
  $('category-filter').innerHTML = options(config.categories, '', 'Все категории')
  $('department-filter').innerHTML = options(config.departments, '', 'Все подразделения')
  showRole()
  await refresh()
  void checkInbox().catch(() => {})
  void checkTelegram().catch(() => {})
}
init().catch(error => notice(error.message, true))
