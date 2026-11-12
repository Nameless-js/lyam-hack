const language = ['ru', 'kk', 'en'].includes(localStorage.getItem('kontur-language'))
  ? localStorage.getItem('kontur-language') : 'ru'
const locale = { ru: 'ru-RU', kk: 'kk-KZ', en: 'en-GB' }[language]
const translations = new Map()
const counted = {
  en: { 'Показано чатов:': 'Chats shown:', Шаг: 'Step', из: 'of', ч: 'h', Открыть: 'Open',
    'активных задач:': 'active tasks:', 'Вернуть во входящие': 'Restore to inbox',
    'Вернуть в чат': 'Restore to chat', 'Вернуть к оценке': 'Restore to rating' },
  kk: { 'Показано чатов:': 'Көрсетілген чаттар:', Шаг: 'Қадам', из: '/', ч: 'сағ', Открыть: 'Ашу',
    'активных задач:': 'белсенді тапсырмалар:', 'Вернуть во входящие': 'Кіріс жәшігіне қайтару',
    'Вернуть в чат': 'Чатқа қайтару', 'Вернуть к оценке': 'Бағаға қайтару' },
}

function translate(value) {
  if (language === 'ru' || !value) return value
  const source = value.trim()
  const words = counted[language]
  let result = translations.get(source) || words[source]
  if (!result && source.includes(' · ')) {
    result = source.split(' · ').map(part => translate(part)).join(' · ')
  }
  if (!result && /^(?:(?:Показано чатов:|Шаг) )?\d+ из \d+$/.test(source)) {
    result = source.replace(/Показано чатов:|Шаг|из/g, term => words[term])
  }
  if (!result && /^\d+(?:[.,]\d+)? ч$/.test(source)) {
    result = source.replace(',', language === 'en' ? '.' : ',').replace(/ч$/, words.ч)
  }
  if (!result && /^(Карточка|Открыть) A-\d+$/.test(source)) {
    result = source.replace(/^(Карточка|Открыть)/, term => translate(term))
  }
  if (!result && /^активных задач: \d+$/.test(source)) {
    result = source.replace('активных задач:', words['активных задач:'])
  }
  if (!result && source.startsWith('· ')) result = '· ' + translate(source.slice(2))
  return result ? value.replace(source, result) : value
}

const translatedAttributes = ['title', 'placeholder', 'aria-label']
function localize(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    if (root.parentElement?.closest('script, style, textarea, [data-original-text]')) return
    const text = translate(root.data)
    if (text !== root.data) root.data = text
  } else if (root.nodeType === Node.ELEMENT_NODE) {
    if (root.closest('script, style, [data-original-text]')) return
    for (const name of translatedAttributes) {
      const old = root.getAttribute(name)
      const value = translate(old)
      if (value !== old) root.setAttribute(name, value)
    }
    for (const child of root.childNodes) localize(child)
  }
}

async function initializeLanguage() {
  document.documentElement.lang = language
  const selector = document.getElementById('site-language')
  selector.value = language
  selector.addEventListener('change', () => {
    localStorage.setItem('kontur-language', selector.value)
    location.reload()
  })
  if (language === 'ru') return
  const response = await fetch('/translations.txt')
  if (!response.ok) throw new Error('Could not load translations.')
  for (const line of (await response.text()).trim().split(/\r?\n/)) {
    const [source, english, kazakh] = line.split('|')
    translations.set(source, language === 'en' ? english : kazakh)
  }
  localize(document.documentElement)
  document.addEventListener('invalid', event => {
    const field = event.target
    if (field.validity?.valueMissing) {
      field.setCustomValidity(translate(field.matches('select, input[type=radio]') ? 'Выберите один вариант.' : 'Заполните это поле.'))
    }
  }, true)
  document.addEventListener('input', event => {
    const field = event.target
    if (field.matches('input[type=radio]')) {
      for (const input of field.form.elements[field.name]) input.setCustomValidity('')
    } else field.setCustomValidity?.('')
  })
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' || record.type === 'characterData') localize(record.target)
      else for (const node of record.addedNodes) localize(node)
    }
  }).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: translatedAttributes,
  })
}
