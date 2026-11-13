let improvementPosts = []
let improvementRequest = 0

async function loadImprovements() {
  const request = ++improvementRequest
  const profile = config.user
  const feed = $('improvement-feed')
  $('publish-improvement').hidden = profile.role !== 'admin'
  try {
    const posts = await api('improvements')
    if (request !== improvementRequest || config.user !== profile || $('improvements').hidden) return
    improvementPosts = posts
    feed.innerHTML = posts.map((post, index) => `
      <button type="button" class="improvement-card" style="--entry-delay:${Math.min(index, 6) * 45}ms" data-improvement="${post.id}" aria-haspopup="dialog">
        <span class="role-icon">${icon('check')}</span>
        <span class="improvement-date">${dateFormat.format(new Date(post.created))}</span>
        <strong>${escapeHtml(post.title)}</strong>
        ${post.id < 0 ? '<span class="improvement-demo">Демо-публикация</span>' : ''}
        <span class="improvement-excerpt">${escapeHtml(post.summary)}</span>
        <span class="improvement-card-foot"><span>${post.count ? '★ ' + averageFormat.format(post.average) + ' · ' + post.count : 'Пока без оценок'}</span>
        <span>${icon('brand')} ${post.comments.length} ${icon('arrow')}</span></span>
      </button>`).join('') || '<p class="analytics-panel">Пока нет опубликованных изменений.</p>'
  } catch (error) {
    if (request === improvementRequest && config.user === profile) feed.textContent = error.message
  }
}

function showImprovement(post) {
  modal('Лента', `
    <article class="improvement-detail">
      <header class="improvement-story">
        <div class="improvement-story-meta"><span class="role-icon">${icon('check')}</span><time class="improvement-date" datetime="${post.created}">${dateFormat.format(new Date(post.created))}</time>
          ${post.count ? '<span class="improvement-score">★ ' + averageFormat.format(post.average) + ' / 5</span>' : ''}</div>
        <h3>${escapeHtml(post.title)}</h3>
        <p class="copy improvement-summary">${escapeHtml(post.summary)}</p>
      </header>
      <div class="improvement-comments">
        <h4><span>Комментарии</span> · ${post.comments.length}</h4>
        ${post.comments.map(entry => `<div class="improvement-comment"><strong>★ ${entry.score} / 5</strong><p class="copy">${escapeHtml(entry.comment)}</p></div>`).join('') || '<p class="muted">Комментариев пока нет.</p>'}
      </div>
      <form class="action-form" data-action="improvement-feedback" data-improvement-id="${post.id}">
        <fieldset class="improvement-rating"><legend>Ваша оценка</legend>
          ${[1, 2, 3, 4, 5].map(score => `<label data-score="${score}"><input type="radio" name="score" value="${score}" required ${post.mine?.score === score ? 'checked' : ''}><span aria-hidden="true">★</span><span class="sr-only">${score} / 5</span></label>`).join('')}
        </fieldset>
        <label>Комментарий<textarea name="comment" maxlength="1000" rows="2">${escapeHtml(post.mine?.comment || '')}</textarea></label>
        <button type="submit">${icon('tick')} Сохранить оценку</button>
      </form>
    </article>`, 'improvement-story')
}

document.getElementById('improvement-feed').addEventListener('click', event => {
  const button = event.target.closest('[data-improvement]')
  const post = improvementPosts.find(item => item.id === Number(button?.dataset.improvement))
  if (post) showImprovement(post)
})

document.getElementById('publish-improvement').onclick = () => {
  const completed = cases.filter(item => !item.moderated && item.result && config.statuses.slice(4).includes(item.status))
  if (!completed.length) {
    modal('Опубликовать изменение', '<p>Пока нет завершённых обращений с итогом.</p>')
    return
  }
  modal('Опубликовать изменение', `
    <p>Перескажите итог своими словами. Уберите имена, контакты и детали, по которым можно узнать автора.</p>
    <form class="action-form" data-action="publish-improvement">
      <label>Заголовок<input name="title" required maxlength="120"></label>
      <label>Описание изменения<textarea name="summary" required rows="4" maxlength="4000"></textarea></label>
      <fieldset class="repeat-selection improvement-sources"><legend>Связанные обращения</legend>
        ${completed.map(item => `<label><input type="checkbox" name="ids" value="${item.id}">
          <span><strong>${item.number}</strong> · ${escapeHtml(item.category)}<small>${escapeHtml(item.result)}</small></span>
        </label>`).join('')}
      </fieldset>
      <button type="submit">Опубликовать</button>
    </form>`, 'improvement')
}
