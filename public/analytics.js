const chartColors = ['#2159c5', '#07836f', '#a55a0d', '#743dcc', '#bc4069', '#3e7a9d']
const percentFormat = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
const averageFormat = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
let pdfLibrary
let selectedRequestType
let selectedRequestStatus
const expandedAnalyticsRequests = new Set()
const expandedRatingGroups = new Set()
const requestStatus = item => item.moderated ? 'На модерации' : item.status

function analyticsData() {
  const closedStatuses = new Set(config.statuses.slice(4))
  const countBy = (getValue, values) => {
    const counts = new Map(values.map(value => [value, 0]))
    for (const item of cases) {
      const value = getValue(item)
      counts.set(value, (counts.get(value) || 0) + 1)
    }
    return [...counts].map(([label, count]) => ({ label, count }))
  }
  const completed = cases.filter(item => closedStatuses.has(item.status)).length
  return {
    total: cases.length,
    types: countBy(item => item.type, config.types).map((item, index) => ({
      ...item, type: item.label, label: translate(typeLabel(item.label)), color: chartColors[index % chartColors.length],
    })).filter(item => item.count),
    statuses: countBy(requestStatus, config.statuses).map(item => ({ ...item, status: item.label, label: translate(item.label) })),
    metrics: [
      ['Всего обращений', cases.length],
      ['Открытые обращения', cases.length - completed],
      ['Завершены', completed],
      ['Просроченные', cases.filter(item => item.overdue).length],
    ].map(([label, count]) => ({ label: translate(label), count })),
  }
}

function showAnalyticsPage() {
  const user = config?.user
  const open = user?.role === 'admin' && location.hash === '#analytics'
  const repeats = user?.role === 'admin' && location.hash === '#repeats'
  $('analytics').hidden = !open
  $('repeats').hidden = !repeats
  $('workspace-intro').hidden = open || repeats || !user
  $('workspace').hidden = open || repeats || !user
  $('stats-panel').hidden = open || repeats || user?.role !== 'admin'
  if (open) drawAnalytics()
  if (repeats) void loadRepeatedProblems()
  if (!open && !repeats && user && ['#analytics', '#repeats'].includes(location.hash)) {
    history.replaceState(null, '', location.pathname + location.search)
  }
}

window.addEventListener('hashchange', () => {
  if (!config) return
  showAnalyticsPage()
  if (!$('analytics').hidden) $('analytics-heading').focus({ preventScroll: true })
  if (!$('repeats').hidden) $('repeats-heading').focus({ preventScroll: true })
})

function drawAnalytics() {
  const { total, types, statuses, metrics } = analyticsData()
  const rows = items => items.map(item => `
    <li><button type="button" class="chart-status" data-analytics-status="${escapeHtml(item.status)}"
      aria-pressed="${selectedRequestStatus === item.status}" ${item.count ? '' : 'disabled'}>
      <span>${escapeHtml(item.label)}</span><strong>${item.count}</strong>
      <span class="chart-percent">${percentFormat.format(total ? item.count / total : 0)}</span>
    </button></li>`).join('')
  const legend = types.map((item, index) => `
    <li><button type="button" class="chart-sector" data-sector="${index}" aria-pressed="false">
      <span class="chart-key" style="--chart-color:${item.color}"></span>
      <span>${escapeHtml(item.label)}</span><strong>${item.count}</strong>
      <span class="chart-percent">${percentFormat.format(item.count / total)}</span>
    </button></li>`).join('')
  $('analytics-content').innerHTML = `
    <section id="analytics-stats" class="stats analytics-stats" aria-label="Сводка">${metrics.map((item, index) => `
      <div class="stat analytics-stat" data-tone="${['blue', 'violet', 'green', 'amber'][index]}">
        <div><span>${escapeHtml(item.label)}</span><strong>${item.count}</strong></div>
        <span class="role-icon">${icon(['inbox', 'brand', 'check', 'bell'][index])}</span>
      </div>`).join('')}</section>
    <div class="analytics-panels">
      <section class="analytics-panel">
        <h2 id="analytics-type-heading" class="analytics-panel-heading"><span class="role-icon">${icon('inbox')}</span>Обращения по типам</h2>
        ${total ? '<div class="analytics-chart"><div class="chart-pie"><canvas aria-hidden="true"></canvas>' +
          '<div class="chart-tooltip" role="status" hidden></div></div><ul class="chart-list chart-legend">' + legend + '</ul></div>' :
          '<p class="muted">Пока нет обращений для анализа.</p>'}
      </section>
      <section class="analytics-panel"><h2 id="analytics-status-heading" class="analytics-panel-heading">
        <span class="role-icon">${icon('check')}</span><button type="button" class="analytics-section-toggle" data-analytics-status=""
        aria-pressed="${selectedRequestStatus === null}">Обращения по статусам ${icon('down')}</button></h2>
        <ul class="chart-list chart-legend">${rows(statuses)}</ul></section>
    </div>
    <section id="analytics-requests" class="analytics-panel analytics-followup" hidden></section>
    <div id="analytics-ratings" class="analytics-panels analytics-followup">
      ${ratingPanel('Оценка компании', 'rating')}
      ${ratingPanel('Оценка решения', 'resolutionRating')}
    </div>`
  if (total) mountPie(types, total)
  drawAnalyticsRequests()
  for (const group of $('analytics-ratings').querySelectorAll('.analytics-all-ratings:not([hidden])')) translateContent(group)
}

function ratingPanel(title, key) {
  const rated = cases.filter(item => !item.moderated && item[key])
  const count = rated.length
  const average = count ? averageFormat.format(rated.reduce((sum, item) => sum + item[key].score, 0) / count) : '—'
  const distribution = Array.from({ length: 5 }, (_, index) => {
    const score = 5 - index
    const votes = rated.filter(item => item[key].score === score).length
    return `<li><span>${score} ★</span><progress max="${count || 1}" value="${votes}" aria-label="${score} из 5"></progress><strong>${votes}</strong></li>`
  }).join('')
  const low = rated.filter(item => item[key].score <= 2)
  const expanded = expandedRatingGroups.has(key)
  const rows = items => items.map(item => `<li>
    <button type="button" class="secondary" data-analytics-case="${item.id}">${item.number}</button>
    <span>${item[key].score} ★</span>
    <span class="copy">${item[key].comment ? contentText(item[key].comment, item.id) : 'Без комментария'}</span>
  </li>`).join('')
  return `<section class="analytics-panel"><h2 class="analytics-panel-heading">
    <span class="role-icon">${icon('spark')}</span><button type="button" class="analytics-section-toggle" data-rating-toggle="${key}"
      aria-controls="all-${key}" aria-expanded="${expanded}">${title} ${icon('down')}</button></h2>
    <div class="analytics-rating-score"><strong>${average} / 5</strong><span>${count} · Число оценок</span></div>
    <ul class="chart-list analytics-rating-bars">${distribution}</ul>
    <div class="analytics-all-ratings" id="all-${key}" ${expanded ? '' : 'hidden'}>
      <h3>Все оценки</h3><ul class="chart-list">${rows(rated) || '<li>Оценок пока нет.</li>'}</ul>
    </div>
    <details class="analytics-low-ratings"><summary>1–2 звезды · ${low.length}</summary>
      <ul class="chart-list">${rows(low) || '<li>Оценок в 1–2 звезды пока нет.</li>'}</ul>
    </details></section>`
}

function drawAnalyticsRequests() {
  const panel = $('analytics-requests')
  const items = cases.filter(item => selectedRequestStatus === null ||
    (selectedRequestStatus === undefined ? item.type === selectedRequestType : requestStatus(item) === selectedRequestStatus))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue))
  const title = selectedRequestStatus === null ? 'Все обращения' : selectedRequestStatus ?? typeLabel(selectedRequestType)
  panel.hidden = !items.length
  panel.innerHTML = items.length ? `
    <h2 class="analytics-panel-heading"><span class="role-icon">${icon('details')}</span>${escapeHtml(title)}<span class="analytics-result-count">· ${items.length}</span></h2>
    <div class="request-card-list">${items.map(item => `
      <details class="analytics-request" data-preview-case="${item.id}" ${expandedAnalyticsRequests.has(String(item.id)) ? 'open' : ''}>
        <summary>
          <span class="analytics-request-identity">
            <span class="analytics-request-number">${item.number}</span>
            <span class="analytics-request-category">${escapeHtml(item.category)}</span>
          </span>
          <span class="analytics-request-status">
            <span class="tag" data-tone="${item.moderated ? 'amber' : statusTones[item.status] || 'neutral'}">${escapeHtml(requestStatus(item))}</span>
            ${item.overdue ? '<span class="analytics-overdue">Просрочено</span>' : ''}
          </span>
          <span class="analytics-request-chevron">${icon('down')}</span>
        </summary>
        <div class="analytics-request-preview">
          <div class="analytics-preview-meta"><strong>${escapeHtml(item.authorName)}</strong><span>${dateFormat.format(new Date(item.created))}</span></div>
          <p class="copy">${item.moderated ? 'Обращение с нарушениями перемещено в спам.' : contentText(item.description, item.id)}</p>
          <button type="button" class="secondary" data-analytics-case="${item.id}">${icon('brand')} Открыть переписку ${icon('arrow')}</button>
        </div>
      </details>`).join('')}</div>` : ''
  for (const preview of panel.querySelectorAll('.analytics-request[open]')) translateContent(preview)
}

document.getElementById('analytics-content').addEventListener('toggle', event => {
  const preview = event.target
  if (preview.matches('.analytics-low-ratings') && preview.open && preview.isConnected) translateContent(preview)
  if (!preview.matches('.analytics-request') || !preview.isConnected) return
  if (preview.open) {
    expandedAnalyticsRequests.add(preview.dataset.previewCase)
    translateContent(preview)
  } else expandedAnalyticsRequests.delete(preview.dataset.previewCase)
}, true)

document.getElementById('analytics-content').addEventListener('click', event => {
  const statusButton = event.target.closest('[data-analytics-status]')
  const ratingButton = event.target.closest('[data-rating-toggle]')
  if (statusButton) {
    const status = statusButton.dataset.analyticsStatus || null
    selectedRequestType = undefined
    selectedRequestStatus = selectedRequestStatus === status ? undefined : status
    drawAnalytics()
    if (selectedRequestStatus !== undefined) scrollToAnalyticsRequests()
    return
  }
  if (ratingButton) {
    const key = ratingButton.dataset.ratingToggle
    const list = $('all-' + key)
    list.hidden = !list.hidden
    ratingButton.setAttribute('aria-expanded', String(!list.hidden))
    if (list.hidden) expandedRatingGroups.delete(key)
    else {
      expandedRatingGroups.add(key)
      translateContent(list)
    }
    return
  }
  const button = event.target.closest('[data-analytics-case]')
  if (button) openCoordinatorCase(Number(button.dataset.analyticsCase))
})
function openCoordinatorCase(id) {
  if (config?.user?.role !== 'admin') return
  openId = id
  resetFilters()
  location.hash = 'main'
  showAnalyticsPage()
  draw()
  showPane('chat', true)
  $('chat-heading')?.focus({ preventScroll: true })
}
function scrollToAnalyticsRequests() {
  const panel = $('analytics-requests')
  panel.scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' })
  animateUi(panel, { opacity: [.6, 1], y: [10, 0] }, { duration: .32 })
}

function mountPie(items, total) {
  const chart = document.querySelector('.chart-pie')
  const canvas = chart.querySelector('canvas')
  const tooltip = chart.querySelector('.chart-tooltip')
  const buttons = [...document.querySelectorAll('.chart-sector')]
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const width = 280
  const height = 226
  const centerX = width / 2
  const centerY = 92
  const radius = 106
  const tilt = .64
  const depth = 25
  const turn = Math.PI * 2
  const startAngle = -Math.PI / 2
  const density = Math.max(2, window.devicePixelRatio || 1)
  canvas.width = width * density
  canvas.height = height * density
  ctx.scale(density, density)

  let angle = startAngle
  const sectors = items.map(item => {
    const start = angle
    angle += turn * item.count / total
    const channels = item.color.slice(1).match(/../g).map(channel => Math.round(parseInt(channel, 16) * .69))
    return { ...item, side: 'rgb(' + channels.join(',') + ')', start, end: angle, middle: (start + angle) / 2, offset: 0 }
  })
  let active = -1
  let pinned = -1
  let frame

  function paintSector(sector, layer) {
    const x = centerX + Math.cos(sector.middle) * sector.offset
    const y = centerY + Math.sin(sector.middle) * sector.offset * tilt + layer
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.ellipse(x, y, radius, radius * tilt, 0, sector.start, sector.end)
    ctx.closePath()
    ctx.fillStyle = layer ? sector.side : sector.color
    ctx.fill()
  }
  function paint() {
    frame = null
    if (!canvas.isConnected) return
    let moving = false
    for (const [index, sector] of sectors.entries()) {
      const target = index === active ? 10 : 0
      const remaining = target - sector.offset
      if (Math.abs(remaining) > .15 && !reducedMotion.matches) {
        sector.offset += remaining * .23
        moving = true
      } else sector.offset = target
    }
    ctx.clearRect(0, 0, width, height)
    for (let layer = depth; layer >= 1; layer--) {
      for (const sector of sectors) paintSector(sector, layer)
    }
    for (const sector of sectors) paintSector(sector, 0)
    if (moving) frame = requestAnimationFrame(paint)
  }
  function select(index) {
    if (active === index) return
    active = index
    const item = items[index]
    tooltip.hidden = !item
    if (item) tooltip.textContent = item.label + ' · ' + item.count + ' · ' + percentFormat.format(item.count / total)
    buttons.forEach((button, i) => button.classList.toggle('active', i === index))
    if (!frame) frame = requestAnimationFrame(paint)
  }
  function sectorAt(event) {
    const rect = canvas.getBoundingClientRect()
    const x = (event.clientX - rect.left) * width / rect.width - centerX
    const y = (event.clientY - rect.top) * height / rect.height - centerY
    for (let layer = 0; layer <= depth; layer++) {
      const ellipseY = (y - layer) / tilt
      if (Math.hypot(x, ellipseY) > radius) continue
      const bearing = (Math.atan2(ellipseY, x) - startAngle + turn) % turn + startAngle
      return sectors.findIndex(sector => bearing >= sector.start && bearing < sector.end)
    }
    return -1
  }
  canvas.addEventListener('pointermove', event => {
    if (event.pointerType !== 'touch') {
      const index = sectorAt(event)
      select(index === -1 ? pinned : index)
    }
  })
  canvas.addEventListener('pointerleave', () => select(pinned))
  function togglePinned(index) {
    pinned = pinned === index ? -1 : index
    selectedRequestType = items[pinned]?.type
    if (selectedRequestStatus !== undefined) {
      selectedRequestStatus = undefined
      document.querySelectorAll('[data-analytics-status][aria-pressed="true"]')
        .forEach(button => button.setAttribute('aria-pressed', 'false'))
    }
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === pinned)))
    select(pinned)
    drawAnalyticsRequests()
    if (pinned >= 0) scrollToAnalyticsRequests()
  }
  canvas.addEventListener('click', event => togglePinned(sectorAt(event)))
  buttons.forEach((button, index) => {
    button.addEventListener('pointerenter', () => select(index))
    button.addEventListener('pointerleave', () => select(pinned))
    button.addEventListener('focus', () => select(index))
    button.addEventListener('blur', () => select(pinned))
    button.addEventListener('click', () => togglePinned(index))
  })
  pinned = items.findIndex(item => item.type === selectedRequestType)
  if (pinned >= 0) {
    buttons[pinned].setAttribute('aria-pressed', 'true')
    select(pinned)
  } else paint()
}

function loadPdfScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.onload = resolve
    script.onerror = () => {
      script.remove()
      reject(new Error('Не удалось подготовить PDF.'))
    }
    document.head.append(script)
  })
}

function pdfPie(items, total) {
  const radius = 77
  const center = radius + 1
  let start = -Math.PI / 2
  return items.map(item => {
    const sweep = 2 * Math.PI * item.count / total
    const steps = Math.max(2, Math.ceil(sweep * 25))
    const points = [{ x: center, y: center }]
    for (let step = 0; step <= steps; step++) {
      const angle = start + sweep * step / steps
      points.push({ x: center + Math.cos(angle) * radius, y: center + Math.sin(angle) * radius })
    }
    start += sweep
    return { type: 'polyline', points, closePath: true, color: item.color, lineWidth: 0 }
  })
}

function reportDefinition(data, generated) {
  const table = (title, rows) => ({
    layout: 'lightHorizontalLines',
    table: {
      headerRows: 1, widths: ['*', 38, 46],
      body: [
        [title, translate('Всего'), '%'].map(text => ({ text, bold: true })),
        ...rows.map(item => [item.label, String(item.count), percentFormat.format(data.total ? item.count / data.total : 0)]),
      ],
    },
  })
  const title = translate('Отчёт по обращениям')
  return {
    info: { title },
    pageSize: 'A4',
    pageMargins: [39, 40, 39, 38],
    defaultStyle: { fontSize: 10, color: '#18243b' },
    content: [
      { text: title, fontSize: 26, bold: true },
      { text: dateFormat.format(generated), color: '#52627a', margin: [0, 5, 0, 20] },
      { columns: data.metrics.map(item => ({
        stack: [{ text: String(item.count), fontSize: 24, bold: true }, { text: item.label }],
      })), columnGap: 12, margin: [0, 0, 0, 24] },
      { text: translate('Обращения по типам'), fontSize: 16, bold: true, margin: [0, 0, 0, 9] },
      data.total ? {
        columns: [{ width: 165, canvas: pdfPie(data.types, data.total) },
          { ...table(translate('Тип'), data.types.map(item => ({ ...item, label: { text: item.label, color: item.color } }))), width: '*' }],
        columnGap: 15,
      } : { text: translate('Пока нет обращений для анализа.') },
      { text: translate('Обращения по статусам'), fontSize: 16, bold: true, margin: [0, 23, 0, 9] },
      table(translate('Статус'), data.statuses),
    ],
  }
}

document.getElementById('download-report').addEventListener('click', async event => {
  if (config?.user?.role !== 'admin') return
  const button = event.currentTarget
  button.disabled = true
  try {
    if (!pdfLibrary) pdfLibrary = loadPdfScript('/pdfmake.js').then(() => loadPdfScript('/pdfmake-fonts.js'))
    await pdfLibrary
    if (config.user.role !== 'admin') return
    const generated = new Date()
    const report = window.pdfMake.createPdf(reportDefinition(analyticsData(), generated))
    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Не удалось подготовить PDF.')), 15000)
      report.download('kontur-analytics-' + generated.toISOString().slice(0, 10) + '.pdf', () => {
        window.clearTimeout(timeout)
        resolve()
      })
    })
  } catch {
    pdfLibrary = null
    notice('Не удалось подготовить PDF.', true)
  } finally {
    button.disabled = false
  }
})
