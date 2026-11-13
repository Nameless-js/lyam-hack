let repeatsLoading = false
let repeatRefresh
let repeatGroupsByIndex = []

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
  repeatGroupsByIndex = groups
  const panel = $('repeat-groups')
  const expanded = new Set([...panel.querySelectorAll('details[open]')].map(details => details.dataset.repeatCase))
  const byId = new Map(cases.map(item => [item.id, item]))
  const sections = groups.map((group, index) => {
    const items = group.ids.map(id => byId.get(id)).filter(Boolean)
    if (items.length < 2) return ''
    const eligible = items.filter(item => !item.sharedCaseId && !item.moderated && !config.statuses.slice(4).includes(item.status))
    return `<section class="analytics-panel repeat-group">
      <h2 class="analytics-panel-heading"><span class="role-icon">${icon('details')}</span>${escapeHtml(group.title)}<span class="analytics-result-count">· ${items.length}</span></h2>
      ${group.confirmed ? '<p class="muted">Общее дело</p>' : eligible.length >= 2
        ? '<button type="button" class="secondary" data-repeat-merge="' + index + '">Объединить в одно дело</button>' : ''}
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
  const merge = event.target.closest('[data-repeat-merge]')
  if (merge) showRepeatMerge(repeatGroupsByIndex[Number(merge.dataset.repeatMerge)])
})

function showRepeatMerge(group) {
  const ids = new Set(group.ids)
  const items = cases.filter(item => ids.has(item.id) && !item.sharedCaseId && !item.moderated &&
    !config.statuses.slice(4).includes(item.status))
  if (items.length < 2) return
  const owners = config.profiles.filter(profile => profile.role === 'owner')
  modal('Объединить в одно дело', `
    <p>Общий итог появится в чате каждого автора. Переписки останутся отдельными.</p>
    <form class="action-form" data-action="merge-repeats">
      <label>Название общего дела<input name="title" value="${escapeHtml(group.title)}" required maxlength="180"></label>
      <fieldset class="repeat-selection"><legend>Обращения</legend>
        ${items.map(item => `<label><input type="checkbox" name="ids" value="${item.id}" checked>
          <span><strong>${item.number}</strong> · ${escapeHtml(item.description.slice(0, 110))}</span></label>`).join('')}
      </fieldset>
      <div class="grid">
        <label>Исполнитель<select name="owner" required>${options(owners, '', 'Выберите исполнителя')}</select></label>
        <label>Срок<input type="date" name="due" required></label>
      </div>
      <label>Поручение<textarea name="text" required maxlength="4000" rows="3"></textarea></label>
      <button type="submit">Объединить и поручить</button>
    </form>`)
}
