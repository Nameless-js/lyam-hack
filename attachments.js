const { randomUUID } = require('node:crypto')

const maxAttachmentBytes = 12 * 1024 * 1024
const attachmentRequestBytes = Math.ceil(maxAttachmentBytes * 4 / 3) + 32768
const fileTypes = {
  'image/jpeg': data => data.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
  'image/png': data => data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'image/webp': data => data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP',
  'image/gif': data => /^GIF8[79]a$/.test(data.toString('ascii', 0, 6)),
  'video/mp4': data => data.toString('ascii', 4, 8) === 'ftyp',
  'video/quicktime': data => data.toString('ascii', 4, 8) === 'ftyp',
  'video/webm': data => data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])),
}

function readAttachments(input, fail) {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > 3) fail(400, 'Можно прикрепить не больше трёх файлов.')
  let size = 0
  return input.map(file => {
    const type = file?.type
    if (!Object.hasOwn(fileTypes, type) || typeof file.data !== 'string' || typeof file.name !== 'string') {
      fail(400, 'Прикрепите фото или видео поддерживаемого формата.')
    }
    const bytes = Buffer.from(file.data, 'base64')
    size += bytes.length
    if (size > maxAttachmentBytes) fail(413, 'Общий размер вложений не должен превышать 12 МБ.')
    if (!fileTypes[type](bytes)) fail(400, 'Прикрепите фото или видео поддерживаемого формата.')
    return { metadata: { id: randomUUID(), type, name: file.name.trim().slice(0, 180) }, bytes }
  })
}

function sendAttachment(req, res, type, data) {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const headers = {
    'Content-Type': type, 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, no-cache', 'Accept-Ranges': 'bytes',
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
  if (range) {
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1
    if (start > end || start >= bytes.length) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + bytes.length })
      return res.end()
    }
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + bytes.length
    headers['Content-Length'] = end - start + 1
    res.writeHead(206, headers)
    return res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1))
  }
  res.writeHead(200, { ...headers, 'Content-Length': bytes.length })
  return res.end(req.method === 'HEAD' ? undefined : bytes)
}

module.exports = { readAttachments, sendAttachment, attachmentRequestBytes }
