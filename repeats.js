const { createHash } = require('node:crypto')
const { groupComplaints } = require('./integrations')

const stopWords = new Set('который которые которая когда чтобы нужно можно хочу снова очень часто после перед этом этом если наше наши вашей the that this with from have need about again please үшін және бірақ керек немесе қайта'.split(' '))
function words(text) {
  return new Set((text.toLowerCase().replaceAll('ё', 'е').match(/[\p{L}]{4,}/gu) || [])
    .filter(word => !stopWords.has(word)).map(word => word.slice(0, 5)))
}

function groupByWords(items) {
  const candidates = items.map(item => ({ ...item, tokens: words(item.description) }))
  const used = new Set()
  const groups = []
  for (const item of candidates) {
    if (used.has(item.id)) continue
    const matches = candidates.filter(other => {
      if (other.id === item.id || used.has(other.id)) return false
      const shared = [...item.tokens].filter(word => other.tokens.has(word)).length
      const union = item.tokens.size + other.tokens.size - shared
      return shared >= 2 && shared / union >= .48
    })
    if (!matches.length) continue
    const ids = [item.id, ...matches.map(match => match.id)]
    ids.forEach(id => used.add(id))
    groups.push({ title: item.category === 'Без категории' ? 'Похожие формулировки' : item.category, ids })
  }
  return groups
}

function repeatGroups(db) {
  const cached = db.prepare('SELECT fingerprint, groups, checked_at FROM repeat_cache WHERE language = ?')
  const save = db.prepare(`INSERT INTO repeat_cache (language, fingerprint, groups, checked_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(language) DO UPDATE SET fingerprint=excluded.fingerprint, groups=excluded.groups, checked_at=excluded.checked_at`)
  const pending = new Set()
  return function find(items, language) {
    const local = groupByWords(items)
    if (items.length < 2 || !process.env.GEMINI_API_KEY) return { groups: local, pending: false }
    const input = items.slice(0, 50).map(({ id, description }) => ({ id, description: description.slice(0, 1000) }))
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const row = cached.get(language)
    if (row?.fingerprint === fingerprint && (row.groups !== null || Date.now() - row.checked_at < 300000)) {
      const semantic = row.groups === null ? [] : JSON.parse(row.groups)
      const assigned = new Set(semantic.flatMap(group => group.ids))
      return { groups: [...semantic, ...local.filter(group => group.ids.every(id => !assigned.has(id)))], pending: false }
    }
    if (!pending.has(language)) {
      pending.add(language)
      const allowed = new Set(input.map(item => item.id))
      groupComplaints(input, language).then(groups => {
        const seen = new Set()
        const valid = []
        for (const group of groups) {
          if (typeof group?.title !== 'string' || !group.title.trim() || !Array.isArray(group.ids)) continue
          const ids = [...new Set(group.ids)].filter(id => allowed.has(id) && !seen.has(id))
          if (ids.length < 2) continue
          ids.forEach(id => seen.add(id))
          valid.push({ title: group.title.trim().slice(0, 180), ids })
        }
        save.run(language, fingerprint, JSON.stringify(valid), Date.now())
      }).catch(error => {
        console.error('Повторяющиеся проблемы: ' + error.message)
        save.run(language, fingerprint, null, Date.now())
      }).finally(() => pending.delete(language))
    }
    return { groups: local, pending: true }
  }
}

module.exports = { repeatGroups }
