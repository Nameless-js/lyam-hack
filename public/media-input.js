const attachmentTypes = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime'
const formAttachments = new WeakMap()
const attachmentDrafts = new Map()
const previewUrls = new Map()
let activeRecording

function mediaControls() {
  return `<div class="media-tools">
    ${mediaButtons()}
    ${mediaFeedback()}
  </div>`
}

function mediaButtons() {
  return `
    <input type="file" accept="${attachmentTypes}" multiple data-media-files hidden>
    <button type="button" class="secondary media-icon-button" data-media-action="attach" aria-label="Фото или видео" title="Фото или видео">${icon('camera')}</button>
    <button type="button" class="secondary media-icon-button" data-media-action="voice" aria-label="Записать голос" title="Записать голос">${icon('mic')}</button>`
}

function mediaFeedback() {
  return `
    <span data-media-status role="status"></span>
    <ul data-media-preview hidden></ul>`
}

function mediaStatus(form, text) {
  form.querySelector('[data-media-status]').textContent = text
}

function showFiles(form, files) {
  formAttachments.set(form, files)
  if (form.id === 'composer') {
    form.elements.text.required = !files.length
    if (files.length) attachmentDrafts.set(form.dataset.caseId, files)
    else attachmentDrafts.delete(form.dataset.caseId)
  }
  const list = form.querySelector('[data-media-preview]')
  for (const url of previewUrls.get(list) || []) URL.revokeObjectURL(url)
  const urls = []
  list.hidden = !files.length
  list.innerHTML = files.map((file, index) => {
    let preview = icon('play')
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file)
      urls.push(url)
      preview = '<img src="' + url + '" alt="">'
    }
    return '<li><span class="media-draft-thumb">' + preview + '</span><span class="media-draft-name" data-original-text>' +
      escapeHtml(file.name) + '</span><button type="button" class="secondary" data-remove-file="' + index +
      '" aria-label="Убрать вложение" title="Убрать вложение">×</button></li>'
  }).join('')
  if (urls.length) previewUrls.set(list, urls)
  else previewUrls.delete(list)
}

function mediaWorking(form) {
  return activeRecording?.form === form || Boolean(form.querySelector('[data-media-action="voice"]')?.disabled)
}

async function encodeFiles(form) {
  return Promise.all((formAttachments.get(form) || []).map(async file => ({
    name: file.name, type: file.type,
    data: await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('Не удалось прочитать вложение.'))
      reader.onload = () => resolve(reader.result.split(',')[1])
      reader.readAsDataURL(file)
    }),
  })))
}

function renderAttachments(files = []) {
  if (!files.length) return ''
  return '<div class="message-attachments">' + files.map(file => {
    const url = '/api/attachments/' + encodeURIComponent(file.id)
    const name = escapeHtml(file.name)
    const photo = file.type.startsWith('image/')
    const preview = photo
      ? '<img src="' + url + '" alt="" loading="lazy">'
      : '<video src="' + url + '" muted playsinline preload="metadata" aria-hidden="true"></video>'
    const label = photo ? 'Открыть фото' : 'Открыть видео'
    return '<figure><button type="button" class="media-tile" data-view-attachment="' + escapeHtml(file.id) +
      '" data-media-photo="' + photo + '" data-media-name="' + name + '" aria-label="' + label + '" title="' + label + '">' +
      preview + '<span class="media-tile-icon">' + icon(photo ? 'expand' : 'play') + '</span></button>' +
      '<figcaption data-original-text>' + name + '</figcaption></figure>'
  }).join('') + '</div>'
}

function setVoiceButton(button, recording) {
  const label = recording ? 'Остановить запись' : 'Записать голос'
  button.dataset.recording = String(recording)
  button.setAttribute('aria-label', label)
  button.title = label
  button.innerHTML = icon(recording ? 'stop' : 'mic')
}

function formVisible(form) {
  return form.isConnected && (!form.closest('dialog') || form.closest('dialog').open)
}

async function recordVoice(form, button) {
  if (activeRecording?.form === form) {
    button.disabled = true
    if (activeRecording.recorder.state === 'recording') activeRecording.recorder.stop()
    return
  }
  if (activeRecording) return
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    mediaStatus(form, 'Запись голоса недоступна в этом браузере.')
    return
  }
  let stream
  button.disabled = true
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (!formVisible(form) || activeRecording) {
      stream.getTracks().forEach(track => track.stop())
      return
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(type => MediaRecorder.isTypeSupported(type))
    if (!mimeType) throw new Error('Формат записи не поддерживается.')
    const recorder = new MediaRecorder(stream, { mimeType })
    const chunks = []
    const recording = { form, recorder, stream }
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
    recorder.onerror = () => {
      recording.failed = true
      mediaStatus(form, 'Не удалось записать голос.')
    }
    recorder.onstop = async () => {
      clearTimeout(recording.timer)
      stream.getTracks().forEach(track => track.stop())
      if (activeRecording === recording) activeRecording = null
      button.disabled = true
      setVoiceButton(button, false)
      try {
        if (recording.failed || !formVisible(form)) return
        mediaStatus(form, 'Расшифровываем запись…')
        const type = recorder.mimeType.split(';')[0]
        const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': type },
          body: new Blob(chunks, { type }) })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Не удалось расшифровать запись.')
        if (!formVisible(form)) return
        const field = form.querySelector('textarea')
        const combined = [field.value, result.text].filter(Boolean).join('\n')
        field.value = combined.slice(0, field.maxLength)
        field.dispatchEvent(new Event('input', { bubbles: true }))
        field.focus()
        mediaStatus(form, combined.length > field.maxLength ? 'Текст сокращён до допустимой длины.' : 'Текст можно отредактировать перед отправкой.')
      } catch (error) {
        if (formVisible(form)) mediaStatus(form, error.message)
      } finally {
        button.disabled = false
      }
    }
    recorder.start()
    activeRecording = recording
    recording.timer = setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop()
    }, 60000)
    setVoiceButton(button, true)
    mediaStatus(form, 'Идёт запись, до 60 секунд.')
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop())
    mediaStatus(form, error.name === 'NotAllowedError' ? 'Разрешите доступ к микрофону.' : 'Не удалось записать голос.')
  } finally {
    button.disabled = false
  }
}

document.addEventListener('click', event => {
  const preview = event.target.closest('[data-view-attachment]')
  if (preview) {
    showMediaViewer(preview)
    return
  }
  const button = event.target.closest('[data-media-action], [data-remove-file]')
  if (!button) return
  const form = button.form
  if (button.dataset.mediaAction === 'attach') form.querySelector('[data-media-files]').click()
  else if (button.dataset.mediaAction === 'voice') void recordVoice(form, button)
  else {
    const files = (formAttachments.get(form) || []).filter((file, index) => index !== Number(button.dataset.removeFile))
    showFiles(form, files)
    mediaStatus(form, '')
  }
})

const mediaViewer = document.getElementById('media-viewer')
function showMediaViewer(button) {
  const url = '/api/attachments/' + encodeURIComponent(button.dataset.viewAttachment)
  const name = button.dataset.mediaName
  const photo = button.dataset.mediaPhoto === 'true'
  const media = document.createElement(photo ? 'img' : 'video')
  media.src = url
  if (photo) media.alt = name
  else {
    media.controls = true
    media.playsInline = true
  }
  document.getElementById('media-viewer-title').textContent = name
  const download = document.getElementById('media-viewer-download')
  download.href = url
  download.download = name
  document.getElementById('media-viewer-body').replaceChildren(media)
  if (!mediaViewer.open) mediaViewer.showModal()
  animateUi(mediaViewer, { opacity: [0, 1], scale: [.97, 1] }, { duration: .27 })
}
document.getElementById('media-viewer-close').onclick = () => mediaViewer.close()
mediaViewer.addEventListener('click', event => {
  if (event.target === mediaViewer) mediaViewer.close()
})
mediaViewer.addEventListener('close', () => {
  document.getElementById('media-viewer-body').replaceChildren()
})
document.addEventListener('change', event => {
  const input = event.target
  if (!input.matches('[data-media-files]')) return
  const files = [...(formAttachments.get(input.form) || []), ...input.files]
  input.value = ''
  if (files.length > 3) return mediaStatus(input.form, 'Можно прикрепить не больше трёх файлов.')
  if (files.some(file => !attachmentTypes.split(',').includes(file.type))) {
    return mediaStatus(input.form, 'Прикрепите фото или видео поддерживаемого формата.')
  }
  if (files.reduce((total, file) => total + file.size, 0) > 12 * 1024 * 1024) {
    return mediaStatus(input.form, 'Общий размер вложений не должен превышать 12 МБ.')
  }
  showFiles(input.form, files)
  mediaStatus(input.form, '')
})

new MutationObserver(() => {
  for (const [list, urls] of previewUrls) {
    if (list.isConnected) continue
    urls.forEach(url => URL.revokeObjectURL(url))
    previewUrls.delete(list)
  }
  const recording = activeRecording
  if (recording && !formVisible(recording.form) && recording.recorder.state === 'recording') {
    recording.recorder.stop()
    recording.stream.getTracks().forEach(track => track.stop())
  }
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] })
