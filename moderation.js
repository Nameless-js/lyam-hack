const { moderate } = require('./integrations')

const attempts = new Map()
const duplicateWindow = 5 * 60 * 1000
const profanity = /(?<![а-я])(?:бля(?:ть|д[ьи])?|сука|мудак(?:и|ом)?|долбо[её]б[а-я]*|пизд[а-я]*|ху[йяеюё][а-я]*|еба(?:ть|ный|л[аи]?)|[её]бан[а-я]*)(?![а-я])/iu
const directInsult = /(?<![а-я])(?:ты|вы)\s+(?:просто\s+)?(?:идиот(?:ка|ы)?|дебил(?:ка|ы)?|тупица|тупицы|кретин(?:ка|ы)?|ничтожество)(?![а-я])/iu

async function review(author, text) {
  const now = Date.now()
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
  const recent = (attempts.get(author) || []).filter(attempt => now - attempt.time < duplicateWindow)
  const duplicate = normalized.length > 0 && recent.some(attempt => attempt.text === normalized)
  const frequent = recent.filter(attempt => now - attempt.time < 60000).length >= 5
  if (!frequent) attempts.set(author, [...recent, { time: now, text: normalized }])
  if (duplicate) return 'Повтор сообщения'
  if (frequent) return 'Слишком много отправок за минуту'
  const cleanText = text.normalize('NFKC')
  if (profanity.test(cleanText)) return 'Нецензурная лексика'
  if (directInsult.test(cleanText)) return 'Оскорбление'
  if (!process.env.GEMINI_API_KEY) return null
  try {
    return await moderate(text)
  } catch (error) {
    console.error('Модерация Gemini: ' + error.message)
    return null
  }
}

module.exports = { review }
