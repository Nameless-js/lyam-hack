let repeatsLoading = false
let repeatRefresh

async function loadRepeatedProblems() {
  if (repeatsLoading || $('repeats').hidden) return
  clearTimeout(repeatRefresh)
  repeatsLoading = true
  const profile = config.user
  try {
    const result = await api('repeats?language=' + language)
    if ($('repeats').hidden || config.user !== profile) return
    renderRepeatGroups(result)
    if (result.pending) repeatRefresh = setTimeout(loadRepeatedProblems, 2500)
  } catch (error) {
    if (!$('repeats').hidden) $('repeat-groups').textContent = error.message
  } finally {
    repeatsLoading = false
  }
}

function renderRepeatGroups({ groups, pending }) {
  const panel = $('repeat-groups')
  const expanded = new Set([...panel.querySelectorAll('details[open]')].map(details => details.dataset.repeatCase))
  const byId = new Map(cases.map(item => [item.id, item]))
  const sections = groups.map(group => {
    const items = group.ids.map(id => byId.get(id)).filter(Boolean)
    if (items.length < 2) return ''
    return `<section class="analytics-panel repeat-group">
      <h2 class="analytics-panel-heading"><span class="role-icon">${icon('details')}</span>${escapeHtml(group.title)}<span class="analytics-result-count">· ${items.length}</span></h2>
      <div class="request-card-list">
      ${items.map(item => `<details class="analytics-request" data-repeat-case="${item.id}" ${expanded.has(String(item.id)) ? 'open' : ''}>
        <summary>
          <span class="analytics-request-identity"><span class="analytics-request-number">${item.number}</span>
            <span class="analytics-request-category">${escapeHtml(item.category)}</span></span>
          <span class="analytics-request-status">
            <span class="tag" data-tone="${statusTones[item.status] || 'neutral'}">${escapeHtml(item.status)}</span>
            <span class="repeat-priority" data-priority="${priorityCode[item.priority] || ''}">${escapeHtml([priorityCode[item.priority], item.priority].filter(Boolean).join(' · '))}</span>
          </span>
          <span class="analytics-request-chevron">${icon('down')}</span>
        </summary>
        <div class="analytics-request-preview">
          <p class="copy">${contentText(item.description, item.id)}</p>
          <section class="repeat-decision" data-resolved="${Boolean(item.result)}"><h3>${icon('check')} Принятое решение</h3>
            <p class="copy">${item.result ? contentText(item.result, item.id) : 'Решение ещё не зафиксировано.'}</p>
          </section>
          <button type="button" class="secondary" data-repeat-open="${item.id}">${icon('brand')} Открыть переписку ${icon('arrow')}</button>
        </div>
      </details>`).join('')}</div>
    </section>`
  }).filter(Boolean)
  panel.innerHTML = (pending ? '<p class="muted" role="status">Проверяем, какие проблемы повторяются…</p>' : '') +
    (sections.join('') || (!pending ? '<p class="muted">Повторяющиеся проблемы пока не найдены.</p>' : ''))
  for (const details of panel.querySelectorAll('details[open]')) translateContent(details)
}

document.getElementById('repeat-groups').addEventListener('toggle', event => {
  if (event.target.matches('details[data-repeat-case]') && event.target.open) translateContent(event.target)
}, true)
document.getElementById('repeat-groups').addEventListener('click', event => {
  const button = event.target.closest('[data-repeat-open]')
  if (button) openCoordinatorCase(Number(button.dataset.repeatOpen))
})
