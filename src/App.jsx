import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { getSupabaseClient, isSupabaseConfigured } from './lib/supabaseClient'

const RETENTION_MINUTES = 30
const RETENTION_MS = RETENTION_MINUTES * 60 * 1000
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000
const TEXT_TABLE = 'clipboard_messages'
const FILE_TABLE = 'shared_files'
const FILE_BUCKET =
  import.meta.env.VITE_SUPABASE_FILES_BUCKET || 'device-bridge-files'
const ROOM_STORAGE_KEY = 'device-bridge-room-secret'

function getExpiryIso() {
  return new Date(Date.now() - RETENTION_MS).toISOString()
}

function formatBytes(value) {
  if (!value) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function getRemainingMs(createdAt, now) {
  const started = new Date(createdAt).getTime()
  return Math.max(0, RETENTION_MS - (now - started))
}

function formatRemaining(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function formatDate(value) {
  return new Date(value).toLocaleString()
}

function getFileIconName(mimeType) {
  if (!mimeType) return 'description'
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'movie'
  if (mimeType.startsWith('audio/')) return 'audio_file'
  if (mimeType.startsWith('application/pdf')) return 'picture_as_pdf'
  if (mimeType.startsWith('application/zip') || mimeType.startsWith('application/x-rar')) return 'folder_zip'
  if (mimeType.includes('sheet') || mimeType.includes('excel')) return 'table_chart'
  if (mimeType.includes('document') || mimeType.includes('word')) return 'description'
  return 'description'
}

async function sha256Hex(value) {
  const encoder = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function fingerprint(hash) {
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`
}

function App() {
  const [roomCodeInput, setRoomCodeInput] = useState('')
  const [roomCodeHash, setRoomCodeHash] = useState('')
  const [roomHint, setRoomHint] = useState('')
  const [textInput, setTextInput] = useState('')
  const [latestText, setLatestText] = useState(null)
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState({ text: false, file: false, room: false })
  const [downloadingFileId, setDownloadingFileId] = useState(null)
  const [draggingFile, setDraggingFile] = useState(false)
  const [copiedTextId, setCopiedTextId] = useState(null)
  const [clock, setClock] = useState(Date.now())
  const noticeTimerRef = useRef(null)
  const copyTimerRef = useRef(null)

  const supabase = useMemo(() => getSupabaseClient(), [])
  const hasActiveRoom = Boolean(roomCodeHash)

  useEffect(() => {
    const stored = localStorage.getItem(ROOM_STORAGE_KEY)
    const value = stored?.trim()
    if (value && value.length >= 6) {
      sha256Hex(value).then((nextHash) => {
        setRoomCodeHash(nextHash)
        setRoomHint(fingerprint(nextHash))
      })
    }
  }, [])

  const showNotice = useCallback((message) => {
    setNotice(message)

    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current)
    }

    noticeTimerRef.current = window.setTimeout(() => {
      setNotice('')
    }, 3000)
  }, [])

  const fetchLatestText = useCallback(async () => {
    if (!supabase) {
      return
    }

    const { data, error } = await supabase.rpc('get_latest_clipboard_message', {
      p_room_code_hash: roomCodeHash,
    })

    if (error) {
      console.error('Failed to load latest text:', error)
      return
    }

    const row = Array.isArray(data) ? data[0] : data
    const expiry = getExpiryIso()
    const createdAt = row?.created_at
    const notExpired = createdAt && String(createdAt) >= expiry
    setLatestText(row && notExpired ? row : null)
  }, [roomCodeHash, supabase])

  const fetchActiveFiles = useCallback(async () => {
    if (!supabase) {
      return
    }

    const { data, error } = await supabase.rpc('get_shared_files', {
      p_room_code_hash: roomCodeHash,
    })

    if (error) {
      console.error('Failed to load files:', error)
      return
    }

    setFiles(Array.isArray(data) ? data : [])
  }, [roomCodeHash, supabase])

  const cleanupExpiredData = useCallback(async () => {
    if (!supabase) {
      return
    }

    const { data: staleFiles, error: staleFilesError } = await supabase.rpc('get_expired_shared_files', {
      p_room_code_hash: roomCodeHash,
    })

    if (staleFilesError) {
      console.error('Failed to query expired files:', staleFilesError)
    }

    const list = Array.isArray(staleFiles) ? staleFiles : []
    if (list.length > 0) {
      const stalePaths = list.map((file) => file.storage_path)
      const { error: removeStorageError } = await supabase.storage
        .from(FILE_BUCKET)
        .remove(stalePaths)
      if (removeStorageError) {
        console.warn('Failed to remove some expired storage objects:', removeStorageError)
      }
    }

    await supabase.rpc('cleanup_expired_clipboard_messages', {
      p_room_code_hash: roomCodeHash,
    })
    await supabase.rpc('cleanup_expired_shared_files', {
      p_room_code_hash: roomCodeHash,
    })
  }, [roomCodeHash, supabase])

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setClock(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(timerId)
    }
  }, [])

  useEffect(() => {
    if (!supabase) {
      setLatestText(null)
      setFiles([])
      setLoading(false)
      return
    }

    let isActive = true

    const bootstrap = async () => {
      await cleanupExpiredData()
      await Promise.all([fetchLatestText(), fetchActiveFiles()])

      if (isActive) {
        setLoading(false)
      }
    }

    void bootstrap()

    const textChannel = supabase
      .channel(`clipboard-text-realtime-${roomCodeHash.slice(0, 8)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: TEXT_TABLE },
        () => {
          void fetchLatestText()
        },
      )
      .subscribe()

    const fileChannel = supabase
      .channel(`clipboard-files-realtime-${roomCodeHash.slice(0, 8)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: FILE_TABLE },
        () => {
          void fetchActiveFiles()
        },
      )
      .subscribe()

    const cleanupTimerId = window.setInterval(() => {
      void cleanupExpiredData()
    }, CLEANUP_INTERVAL_MS)

    return () => {
      isActive = false
      window.clearInterval(cleanupTimerId)
      supabase.removeChannel(textChannel)
      supabase.removeChannel(fileChannel)

      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current)
      }
    }
  }, [cleanupExpiredData, fetchActiveFiles, fetchLatestText, roomCodeHash, supabase])

  const joinRoom = async (event) => {
    event.preventDefault()

    const value = roomCodeInput.trim()

    if (value.length < 6) {
      showNotice('Use at least 6 characters for the secret code.')
      return
    }

    setBusy((current) => ({ ...current, room: true }))

    try {
      const nextHash = await sha256Hex(value)
      setRoomCodeHash(nextHash)
      setRoomHint(fingerprint(nextHash))
      setRoomCodeInput('')
      localStorage.setItem(ROOM_STORAGE_KEY, value)
      showNotice('Room unlocked. Use this same code on your other device.')
    } catch (error) {
      console.error('Failed to hash room code:', error)
      showNotice('Could not process code. Try again.')
    }

    setBusy((current) => ({ ...current, room: false }))
  }

  const lockRoom = () => {
    localStorage.removeItem(ROOM_STORAGE_KEY)
    setRoomCodeHash('')
    setRoomHint('')
    setTextInput('')
    setLatestText(null)
    setFiles([])
    setLoading(false)
  }

  const submitText = async (event) => {
    event.preventDefault()

    if (!supabase) {
      return
    }

    const value = textInput.trim()

    if (!value) {
      showNotice('Type something first.')
      return
    }

    setBusy((current) => ({ ...current, text: true }))

    const { error } = await supabase.rpc('insert_clipboard_message', {
      p_room_code_hash: roomCodeHash,
      p_content: value,
    })

    if (error) {
      console.error('Failed to send text:', error)
      showNotice('Text sync failed. Check Supabase setup.')
    } else {
      setTextInput('')
      showNotice('Text synced to every open page.')
      await fetchLatestText()
      await cleanupExpiredData()
    }

    setBusy((current) => ({ ...current, text: false }))
  }

  const uploadFile = async (event) => {
    if (!supabase) {
      return
    }

    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    if (file.size > 25 * 1024 * 1024) {
      showNotice('Max file size is 25 MB.')
      event.target.value = ''
      return
    }

    setBusy((current) => ({ ...current, file: true }))

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-')
    const storagePath = `${roomCodeHash}/${Date.now()}-${crypto.randomUUID()}-${safeName}`

    const { error: uploadError } = await supabase.storage
      .from(FILE_BUCKET)
      .upload(storagePath, file, {
        cacheControl: '60',
        upsert: false,
        contentType: file.type || 'application/octet-stream',
      })

    if (uploadError) {
      console.error('File upload failed:', uploadError)
      showNotice('Upload failed. Confirm bucket and policies.')
      setBusy((current) => ({ ...current, file: false }))
      event.target.value = ''
      return
    }

    const { error: metadataError } = await supabase.rpc('insert_shared_file', {
      p_room_code_hash: roomCodeHash,
      p_file_name: file.name,
      p_storage_path: storagePath,
      p_mime_type: file.type || null,
      p_file_size: file.size,
    })

    if (metadataError) {
      await supabase.storage.from(FILE_BUCKET).remove([storagePath])
      console.error('Failed to store file metadata:', metadataError)
      showNotice('Upload failed while saving metadata.')
      setBusy((current) => ({ ...current, file: false }))
      event.target.value = ''
      return
    }

    showNotice('File shared successfully.')
    setBusy((current) => ({ ...current, file: false }))
    event.target.value = ''
    await fetchActiveFiles()
    await cleanupExpiredData()
  }

  const downloadFile = async (file) => {
    if (!supabase) {
      return
    }

    setDownloadingFileId(file.id)

    const { data, error } = await supabase.storage
      .from(FILE_BUCKET)
      .createSignedUrl(file.storage_path, 60, { download: file.file_name })

    if (error || !data?.signedUrl) {
      console.error('Signed URL creation failed:', error)
      showNotice('Download failed. Check storage policies.')
      setDownloadingFileId(null)
      return
    }

    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
    setDownloadingFileId(null)
  }

  const latestTextTimeLeft = useMemo(() => {
    if (!latestText?.created_at) {
      return null
    }

    return formatRemaining(getRemainingMs(latestText.created_at, clock))
  }, [clock, latestText])

  const copyTextToClipboard = async () => {
    if (!latestText?.content) return

    try {
      await navigator.clipboard.writeText(latestText.content)
      setCopiedTextId(latestText.id)

      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current)
      }

      copyTimerRef.current = window.setTimeout(() => {
        setCopiedTextId(null)
      }, 2000)

      showNotice('Copied to clipboard!')
    } catch (error) {
      console.error('Copy failed:', error)
      showNotice('Failed to copy. Try manually selecting.')
    }
  }

  const handleFileDragOver = (event) => {
    event.preventDefault()
    event.stopPropagation()
    setDraggingFile(true)
  }

  const handleFileDragLeave = (event) => {
    event.preventDefault()
    event.stopPropagation()
    setDraggingFile(false)
  }

  const handleFileDrop = async (event) => {
    event.preventDefault()
    event.stopPropagation()
    setDraggingFile(false)

    const files = event.dataTransfer.files
    if (files.length > 0) {
      const fileInput = document.getElementById('file-upload')
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(files[0])
      fileInput.files = dataTransfer.files
      await uploadFile({ target: { files: dataTransfer.files } })
    }
  }

  if (!isSupabaseConfigured) {
    return (
      <main className="app-shell">
        <section className="panel config-panel">
          <span className="material-symbols-outlined md-40 config-icon" aria-hidden>cloud_off</span>
          <h1>Device Bridge</h1>
          <p>
            Add your Supabase credentials in <code>.env</code> to start realtime
            sync.
          </p>
          <ul>
            <li>
              <code>VITE_SUPABASE_URL</code>
            </li>
            <li>
              <code>VITE_SUPABASE_ANON_KEY</code>
            </li>
            <li>
              <code>VITE_SUPABASE_FILES_BUCKET</code> (optional)
            </li>
          </ul>
        </section>
      </main>
    )
  }

  if (!hasActiveRoom) {
    return (
      <div className="enter-page">
        <main className="app-shell enter-page-shell">
          <section className="panel hero hero-standalone enter-card">
            <div className="enter-card-brand">
              <span className="enter-logo" aria-hidden>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="28" height="28">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </span>
              <h1 className="enter-title">Device Bridge</h1>
              <p className="enter-subtitle">Sync clipboard & files across your devices</p>
            </div>
            <form className="room-form enter-form" onSubmit={joinRoom}>
              <label className="enter-label" htmlFor="secret-code">
                Secret code
              </label>
              <div className="input-with-icon">
                <span className="input-icon enter-input-icon" aria-hidden>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
                    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                  </svg>
                </span>
                <input
                  id="secret-code"
                  className="room-input enter-input"
                  type="password"
                  value={roomCodeInput}
                  onChange={(event) => setRoomCodeInput(event.target.value)}
                  placeholder="Enter secret code"
                  autoComplete="off"
                />
              </div>
              <button type="submit" className="btn-primary enter-btn" disabled={busy.room}>
                {busy.room ? (
                  <>
                    <span className="enter-btn-icon spin" aria-hidden>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
                        <path d="M23 4v6h-6M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                      </svg>
                    </span>
                    Entering...
                  </>
                ) : (
                  <>
                    <span className="enter-btn-icon" aria-hidden>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
                        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                        <polyline points="10 17 15 12 10 7" />
                        <line x1="15" y1="12" x2="3" y2="12" />
                      </svg>
                    </span>
                    Enter
                  </>
                )}
              </button>
            </form>
            <p className="enter-hint">
              Code is hashed — it’s never stored. Room expires after 30 minutes.
            </p>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="app-layout">
      <header className="app-bar">
        <div className="app-bar-brand">
          <span className="app-bar-logo" aria-hidden>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="26" height="26">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </span>
          <span className="app-bar-title">Device Bridge</span>
        </div>
        <div className="app-bar-actions">
          <span className="room-badge">
            <span className="room-badge-icon" aria-hidden>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
            {roomHint}
          </span>
          <button type="button" className="btn-ghost btn-lock" onClick={lockRoom} title="Leave room">
            <span className="btn-ghost-icon" aria-hidden>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </span>
            Leave
          </button>
        </div>
      </header>

      <main className="app-shell">
        <p className="app-intro">
          <span className="app-intro-dot" aria-hidden />
          New text and files appear instantly. Everything expires after {RETENTION_MINUTES} minutes.
        </p>

      <section className="content-grid">
        <article className="panel card-text">
          <h2>
            <span className="material-symbols-outlined section-icon" aria-hidden>description</span>
            Share Text
          </h2>
          <form onSubmit={submitText} className="stack">
            <div className="textarea-wrapper">
              <textarea
                value={textInput}
                onChange={(event) => setTextInput(event.target.value)}
                placeholder="Paste text here and hit sync..."
                rows={6}
              />
              <span className="char-count">{textInput.length} chars</span>
            </div>
            <button type="submit" className="btn-primary" disabled={busy.text || loading}>
              {busy.text ? (
                <>
                  <span className="material-symbols-outlined btn-icon spin" aria-hidden>sync</span>
                  Syncing...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined btn-icon" aria-hidden>sync</span>
                  Sync Text
                </>
              )}
            </button>
          </form>

          <div className="result-box">
            <div className="result-head">
              <span className="result-head-label">
                <strong>Expires in</strong>
                {latestTextTimeLeft ? (
                  <span className="result-expiry">
                    <span className="material-symbols-outlined md-16" aria-hidden>schedule</span>
                    {latestTextTimeLeft}
                  </span>
                ) : (
                  <span className="result-expiry">—</span>
                )}
              </span>
              {latestText?.content ? (
                <button
                  type="button"
                  className="copy-btn"
                  onClick={copyTextToClipboard}
                >
                  {copiedTextId === latestText.id ? (
                    <>
                      <span className="material-symbols-outlined md-16" aria-hidden>done</span>
                      Copied
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined md-16" aria-hidden>content_copy</span>
                      Copy
                    </>
                  )}
                </button>
              ) : null}
            </div>
            <p>
              {latestText?.content ||
                'No text available yet. Sync from any device to see it here.'}
            </p>
            {latestText?.created_at ? (
              <div className="result-footer">
                <small>Updated {formatDate(latestText.created_at)}</small>
              </div>
            ) : null}
          </div>
        </article>

        <article className="panel card-files">
          <h2>
            <span className="material-symbols-outlined section-icon" aria-hidden>upload_file</span>
            Share Files
          </h2>
          <div
            className={`file-upload-zone ${draggingFile ? 'dragging' : ''}`}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
          >
            <label
              className={`file-picker ${busy.file || loading ? 'disabled' : ''}`}
              htmlFor="file-upload"
            >
              {busy.file ? (
                <>
                  <span className="material-symbols-outlined btn-icon spin" aria-hidden>sync</span>
                  Uploading...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined btn-icon" aria-hidden>upload_file</span>
                  Choose or drag a file
                </>
              )}
            </label>
            <input
              id="file-upload"
              type="file"
              onChange={uploadFile}
              disabled={busy.file || loading}
            />
          </div>

          <div className="file-list">
            {files.length === 0 ? (
              <p className="empty-state">
                <span className="material-symbols-outlined empty-icon" aria-hidden>description</span>
                No files yet. Upload one from any device.
              </p>
            ) : (
              files.map((file) => {
                return (
                  <article key={file.id} className="file-card">
                    <div className="file-info">
                      <span className="file-icon material-symbols-outlined md-32" aria-hidden>
                        {getFileIconName(file.mime_type)}
                      </span>
                      <div className="file-meta">
                        <h3>{file.file_name}</h3>
                        <p>
                          {formatBytes(file.file_size)}
                          {file.mime_type ? ` • ${file.mime_type}` : ''}
                        </p>
                        <small>
                          <span className="material-symbols-outlined md-14" aria-hidden>schedule</span>
                          Expires in {formatRemaining(getRemainingMs(file.created_at, clock))}
                        </small>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="file-action"
                      onClick={() => {
                        void downloadFile(file)
                      }}
                      disabled={downloadingFileId === file.id}
                    >
                      {downloadingFileId === file.id ? (
                        <>
                          <span className="material-symbols-outlined btn-icon spin" aria-hidden>hourglass_empty</span>
                          Downloading...
                        </>
                      ) : (
                        <>
                          <span className="material-symbols-outlined btn-icon" aria-hidden>download</span>
                          Download
                        </>
                      )}
                    </button>
                  </article>
                )
              })
            )}
          </div>
        </article>
      </section>

      {notice ? <aside className="notice">{notice}</aside> : null}
      </main>
    </div>
  )
}

export default App
