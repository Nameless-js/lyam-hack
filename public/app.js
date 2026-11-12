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
const pendingMessages = new Set()
let redrawChatAfterTour = false
const typeLabel = type => ({ 'Проблема': 'Жалоба', 'Предложение': 'Рекомендация' }[type] || type)
const initials = name => name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase()
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
  }
  if (scroll && mobileWorkspace.matches) workspace.scrollIntoView({ block: 'nearest' })
}

async function api(route, data) {
  const response = await fetch('/api/' + route, data === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result
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
  $('department-filter').hidden = user?.role !== 'admin'
  if (user && previousRole && (previousRole !== $('role-label').textContent || previousSubtitle !== $('subtitle').textContent)) {
    animateUi($('heading').parentElement, { opacity: [.35, 1], y: [7, 0] }, { duration: .34 })
  }
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
  const visible = cases.filter(item =>
    (!query || [item.number, item.authorName, item.description, item.category, typeLabel(item.type)].join(' ').toLowerCase().includes(query)) &&
    (!type || item.type === type) &&
    (!status || item.status === status) && (!category || item.category === category) &&
    (!department || item.department === department) && (!$('late-filter').checked || item.overdue))
  $('count').textContent = visible.length === cases.length ? String(cases.length) : visible.length + ' из ' + cases.length
  $('count').setAttribute('aria-label', 'Показано чатов: ' + visible.length + ' из ' + cases.length)
  if (!visible.some(item => item.id === openId)) openId = visible[0]?.id ?? null
  if (!openId) showPane('list')
  $('cases').innerHTML = visible.map(item => `
    <button type="button" class="chat-row" data-case="${item.id}" aria-current="${item.id === openId}">
      <span class="avatar" aria-hidden="true">${escapeHtml(initials(item.authorName))}</span>
      <span class="row-body"><strong>${escapeHtml(item.authorName)}</strong>
        <span class="row-topic">${escapeHtml(item.category)}</span>
        <span class="row-meta">${escapeHtml(typeLabel(item.type))} · ${item.number}</span>
      </span>${item.status === 'Новое' ? '<span class="new-dot" title="Новое"></span>' : ''}
    </button>`).join('') || '<p class="empty muted">' +
      (cases.length ? 'Обращений по этим условиям нет.' : 'Здесь появятся обращения.') + '</p>'
  renderChat()
}
async function refresh() {
  cases = config.user ? await api('cases') : []
  draw()
}
function modal(title, content) {
  $('dialog-content').innerHTML = '<div class="dialog-head"><h2 id="dialog-title">' + escapeHtml(title) +
    '</h2><button type="button" class="secondary" id="close-dialog" aria-label="Закрыть">×</button></div>' +
    '<p id="dialog-error" class="error" role="alert" hidden></p>' + content
  $('close-dialog').onclick = () => $('dialog').close()
  if (!$('dialog').open) $('dialog').showModal()
  else $('close-dialog').focus()
  animateUi($('dialog-content'), { opacity: [.35, 1], y: [8, 0] }, { duration: .32 })
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
  const sameChat = chat.dataset.caseId === String(item.id)
  const previousMessages = sameChat ? chat.querySelector('.messages').childElementCount : 0
  const previousStatus = sameChat ? chat.querySelector('.tag').textContent : ''
  const sending = pendingMessages.has(config.user.id + ':' + item.id)
  const events = [{ actor: item.authorName, text: item.description, time: item.created, label: 'Исходное обращение' }, ...item.history.slice(1)]
  chat.dataset.caseId = item.id
  chat.innerHTML = `
    <nav class="mobile-nav" aria-label="Навигация по обращению">
      <button type="button" class="quiet" data-pane-target="list">${icon('back')} Все чаты</button>
      <button type="button" class="quiet" data-pane-target="details">${icon('details')} Карточка</button>
    </nav>
    <header class="chat-head">
      <span class="avatar" aria-hidden="true">${escapeHtml(initials(item.authorName))}</span>
      <div><h2 id="chat-heading" tabindex="-1">${escapeHtml(item.authorName)}</h2><p>${item.number} · ${escapeHtml(item.category)}</p></div>
      <span class="tag" data-tone="${item.moderated ? 'amber' : statusTones[item.status] || 'neutral'}">${item.moderated ? 'На модерации' : escapeHtml(item.status)}</span>
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
        ${admin ? '<button class="ai-button" type="button" data-chat-action="suggest">' + icon('spark') + ' Рекомендация ИИ</button><button class="secondary" type="button" data-chat-action="assign">Поручить</button>' : ''}
        ${staff ? '<button class="secondary" type="button" data-chat-action="status">Изменить статус</button>' : ''}
      </div>
      <div class="compose-row">
        <textarea name="text" aria-label="Сообщение" placeholder="Написать сообщение…" maxlength="4000" required rows="2">${escapeHtml(drafts.get(item.id))}</textarea>
        <button type="submit" aria-label="Отправить сообщение" title="Отправить сообщение">${icon('send')}<span class="send-spinner" aria-hidden="true"></span></button>
      </div>
      <span class="sr-only" role="status" data-send-status></span>
    </form>` : '<div class="composer muted">' + (item.moderated ? 'Обращение ожидает проверки координатором.' : 'Обращение завершено') + '</div>'}`
  $('case-details').innerHTML = `
    <nav class="mobile-nav" aria-label="Навигация по карточке">
      <button type="button" class="quiet" data-pane-target="chat">${icon('back')} К переписке</button>
    </nav>
    <div class="details-head"><span class="details-icon">${icon('details')}</span><div><p class="eyebrow">Карточка ${item.number}</p><h2 id="details-heading" tabindex="-1">Об обращении</h2></div></div>
    <dl class="case-facts">
      <div><dt>Тип</dt><dd>${escapeHtml(typeLabel(item.type))}</dd></div>
      <div><dt>Подразделение</dt><dd>${escapeHtml(item.department)}</dd></div>
      <div><dt>Приоритет</dt><dd>${escapeHtml(item.priority)}</dd></div>
      <div><dt>Исполнитель</dt><dd>${escapeHtml(item.ownerName)}</dd></div>
      <div><dt>Срок</dt><dd class="${item.overdue ? 'late' : ''}">${dateFormat.format(new Date(item.due))}${item.overdue ? ' · Просрочено' : ''}</dd></div>
    </dl>
    ${item.task ? '<section class="box"><h3>Поручение</h3><p class="copy">' + escapeHtml(item.task) + '</p></section>' : ''}
    ${item.result ? '<section class="box"><h3>Итог</h3><p class="copy">' + escapeHtml(item.result) + '</p></section>' : ''}
    ${item.rating ? '<section class="box"><h3>Оценка компании</h3><strong>' + item.rating.score + ' из 5</strong>' +
      (item.rating.comment ? '<p class="copy">' + escapeHtml(item.rating.comment) + '</p>' : '') + '</section>' : ''}`
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
function showRating(caseId) {
  const form = $('rating-form')
  form.reset()
  form.dataset.caseId = caseId
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
  const text = form.elements.text.value
  pendingMessages.add(key)
  setSending(form, true)
  const plane = form.querySelector('.compose-row .icon')
  const launch = animateUi(plane, { x: [0, 7], y: [0, -7] }, { duration: .19 })
  try {
    const item = await api('cases/' + id, { action: 'comment', text })
    if (config.user !== user) return
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
    $('telegram-label').textContent = status.connected ? 'Telegram подключён' : 'Подключить Telegram'
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
          $('telegram-label').textContent = 'Подключить Telegram'
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
  if (openId) showPane('chat', true)
})
setInterval(async () => {
  if (document.hidden || !config?.user) return
  void checkInbox().catch(() => {})
  void checkTelegram().catch(() => {})
  if ($('dialog').open || profilePicker.open || tour.open || pendingMessages.size || $('workspace').contains(document.activeElement)) return
  try {
    const profile = config.user.id
    const items = await api('cases')
    if (config.user.id !== profile || $('workspace').contains(document.activeElement) || $('dialog').open || profilePicker.open || tour.open || pendingMessages.size) return
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
  ['#search', 'Найдите нужный чат', 'Ищите по сотруднику, теме или номеру обращения. Фильтр по типу поможет найти, например, только жалобы.', 'list'],
  ['.chat-head', 'Откройте переписку', 'В чате видны сообщения и история решений. Поле внизу отправляет сообщение участникам обращения.', 'chat'],
  ['[data-chat-action="suggest"]', 'Действия координатора', 'Gemini предлагает черновик ответа и кандидата. Здесь же можно назначить исполнителя или поменять статус.', 'chat'],
  ['.details-head', 'Посмотрите детали', 'В карточке указаны исполнитель, срок, приоритет и итог работы.', 'details'],
  ['#notifications', 'Проверьте входящие', 'Счётчик показывает новые обращения. Внутри уведомлений также есть журнал действий по демо-профилям.'],
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
  tourSteps = steps.filter(([selector, , , pane]) => {
    const target = document.querySelector(selector)
    return target && (pane ? !$('workspace').hidden : target.getClientRects().length)
  })
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
  const query = $('profile-search').value.trim().toLocaleLowerCase('ru')
  $('profile-roles').querySelectorAll('button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.profileRole === profileRole))
  })
  const groups = Object.entries(roleNames).map(([role, label]) => {
    if (profileRole && role !== profileRole) return ''
    const profiles = config.profiles.filter(profile => profile.role === role &&
      [profile.name, profile.department, label].join(' ').toLocaleLowerCase('ru').includes(query))
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
  setProfile(profile)
  profilePicker.close()
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
$('profile-form').addEventListener('submit', async event => {
  event.preventDefault()
  if (!$('profile').value) return openProfilePicker()
  const button = event.target.querySelector('button[type="submit"]')
  button.disabled = true
  $('profile-trigger').disabled = true
  try {
    config.user = await api('session', { profile: $('profile').value })
    $('rating-card').hidden = true
    delete $('rating-form').dataset.caseId
    resetFilters()
    drafts.clear()
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
  void checkTelegram().catch(() => {})
}
init().catch(error => notice(error.message, true))
