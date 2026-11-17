import './style.css'
import Peer, { type DataConnection } from 'peerjs'

// Fixed namespace on the public PeerJS broker so four-digit codes can't clash
// with anyone else's. Not a secret (it ships in the bundle).
const PREFIX = 'drop-7c1e4b2a-9f3d-4e81-b6a5-2d0c8f13e947-'

const CHUNK_SIZE = 64 * 1024
const MAX_BUFFERED = 1024 * 1024

type Msg =
    | { t: 'accept' }
    | { t: 'decline' }
    | { t: 'text'; body: string }
    | { t: 'file-start'; id: string; name: string; size: number; mime: string }
    | { t: 'file-chunk'; id: string; data: ArrayBuffer }
    | { t: 'file-end'; id: string }

type Direction = 'in' | 'out'

type Tone = 'idle' | 'busy' | 'live' | 'error'

type FileRow = {
    progress(ratio: number): void
    done(blob?: Blob): void
    fail(): void
}

type IncomingFile = {
    name: string
    size: number
    mime: string
    parts: ArrayBuffer[]
    received: number
    row: FileRow
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const ui = {
    status: $('status'),
    mark: $('mark'),
    myCode: $('my-code'),
    lobby: $('lobby'),
    request: $('request'),
    session: $('session'),
    connectForm: $<HTMLFormElement>('connect-form'),
    codeInput: $<HTMLInputElement>('code-input'),
    connectBtn: $<HTMLButtonElement>('connect-btn'),
    acceptBtn: $<HTMLButtonElement>('accept-btn'),
    declineBtn: $<HTMLButtonElement>('decline-btn'),
    textForm: $<HTMLFormElement>('text-form'),
    textInput: $<HTMLTextAreaElement>('text-input'),
    fileInput: $<HTMLInputElement>('file-input'),
    disconnectBtn: $<HTMLButtonElement>('disconnect-btn'),
    feed: $<HTMLUListElement>('feed'),
    viewer: $<HTMLDialogElement>('viewer'),
    viewerTitle: $('viewer-title'),
    viewerGutter: $('viewer-gutter'),
    viewerCode: $('viewer-code'),
    viewerStats: $('viewer-stats'),
    viewerCopy: $<HTMLButtonElement>('viewer-copy'),
}

let peer: Peer
let conn: DataConnection | null = null
let pending: DataConnection | null = null
let retries = 0
const incoming = new Map<string, IncomingFile>()

// ---------- Helpers

const setStatus = (text: string, tone: Tone = 'idle') => {
    ui.status.textContent = text
    ui.status.dataset.tone = tone
}

// Restart an element's CSS animation (removing and re-adding the class isn't enough without a reflow)
function replay(el: HTMLElement) {
    el.style.animation = 'none'
    void el.offsetWidth
    el.style.animation = ''
}

const randomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0')

const time = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function formatBytes(n: number) {
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024
        i++
    }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
}

function whenOpen(c: DataConnection, fn: () => void) {
    if (c.open) fn()
    else c.on('open', fn)
}

function showSession(on: boolean) {
    ui.lobby.hidden = on
    ui.session.hidden = !on
    ui.disconnectBtn.hidden = !on
}

// ---------- Peer / signalling

function startPeer() {
    const code = randomCode()
    peer = new Peer(PREFIX + code, {
        // STUN only: PeerJS's default public TURN servers are often down
        config: {
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }],
        },
    })

    peer.on('open', () => {
        retries = 0
        // Each digit rolls up into place, odometer style
        ui.myCode.replaceChildren(
            ...[...code].map((d, i) => {
                const span = document.createElement('span')
                span.className = 'inline-block animate-roll'
                span.style.animationDelay = `${i * 70}ms`
                span.textContent = d
                return span
            }),
        )
        setStatus('Ready')
    })

    // Someone typed our code
    peer.on('connection', (c) => {
        if (conn || pending) {
            whenOpen(c, () => {
                c.send({ t: 'decline' } satisfies Msg)
                setTimeout(() => c.close(), 200)
            })
            return
        }
        pending = c
        ui.request.hidden = false
        c.on('close', () => {
            if (pending === c) {
                pending = null
                ui.request.hidden = true
            }
        })
    })

    peer.on('error', (err) => {
        switch (err.type) {
            case 'unavailable-id': // code already taken on the broker, roll a new one
                peer.destroy()
                startPeer()
                break
            case 'peer-unavailable':
                conn?.close()
                conn = null
                ui.connectBtn.disabled = false
                setStatus('No device on that code', 'error')
                break
            default:
                console.error(err)
                setStatus(`Error: ${err.type}`, 'error')
        }
    })

    // Lost the broker: back off instead of hammering it in a loop
    peer.on('disconnected', () => {
        if (peer.destroyed) return
        setStatus('Reconnecting…', 'busy')
        const delay = Math.min(1000 * 2 ** retries++, 15000)
        setTimeout(() => {
            if (!peer.destroyed && peer.disconnected) peer.reconnect()
        }, delay)
    })
}

// Free the code on the broker straight away when the tab closes or reloads
window.addEventListener('beforeunload', () => peer?.destroy())

// ---------- Connection lifecycle

function attach(c: DataConnection, accepted: boolean) {
    conn = c
    ui.connectBtn.disabled = true
    let live = accepted
    if (live) enterSession()

    c.on('data', (raw) => {
        const msg = raw as Msg
        if (!live) {
            if (msg.t === 'accept') {
                live = true
                enterSession()
            } else if (msg.t === 'decline') {
                setStatus('Request declined', 'error')
                c.close()
            }
            return
        }
        handle(msg)
    })

    c.on('close', () => {
        if (conn !== c) return
        conn = null
        ui.connectBtn.disabled = false
        incoming.clear()
        showSession(false)
        if (live) setStatus('Disconnected')
    })

    c.on('error', (err) => {
        console.error(err)
        setStatus('Connection error', 'error')
    })
}

function enterSession() {
    showSession(true)
    setStatus('Connected', 'live')
    ui.textInput.focus()
}

function handle(msg: Msg) {
    switch (msg.t) {
        case 'text':
            addText('in', msg.body)
            replay(ui.mark)
            break
        case 'file-start':
            incoming.set(msg.id, {
                name: msg.name,
                size: msg.size,
                mime: msg.mime,
                parts: [],
                received: 0,
                row: addFile('in', msg.name, msg.size),
            })
            break
        case 'file-chunk': {
            const f = incoming.get(msg.id)
            if (!f) return
            f.parts.push(msg.data)
            f.received += msg.data.byteLength
            f.row.progress(f.size ? f.received / f.size : 1)
            break
        }
        case 'file-end': {
            const f = incoming.get(msg.id)
            if (!f) return
            incoming.delete(msg.id)
            replay(ui.mark)
            f.row.done(new Blob(f.parts, { type: f.mime || 'application/octet-stream' }))
            break
        }
    }
}

// ---------- Sending

function sendText(body: string) {
    if (!conn || !body.trim()) return
    conn.send({ t: 'text', body } satisfies Msg)
    addText('out', body)
}

async function waitForBuffer(c: DataConnection) {
    while (c.dataChannel.bufferedAmount > MAX_BUFFERED) {
        await new Promise((r) => setTimeout(r, 20))
    }
}

async function sendFile(file: File) {
    const c = conn
    if (!c) return
    const id = crypto.randomUUID()
    const row = addFile('out', file.name, file.size)

    c.send({ t: 'file-start', id, name: file.name, size: file.size, mime: file.type } satisfies Msg)

    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        if (conn !== c) return row.fail()
        await waitForBuffer(c)
        const data = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()
        c.send({ t: 'file-chunk', id, data } satisfies Msg)
        row.progress(Math.min(1, (offset + CHUNK_SIZE) / file.size))
    }

    c.send({ t: 'file-end', id } satisfies Msg)
    row.done()
}

async function sendFiles(files: File[]) {
    for (const f of files) await sendFile(f)
}

// ---------- Feed rendering

const itemClass = (dir: Direction) =>
    `grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-1.5 py-4 sm:grid-cols-[7rem_1fr_auto] ${dir === 'in' ? 'animate-arrive' : 'animate-drop-in'}`

const actionClass = 'btn btn-sm btn-secondary animate-pop'

function meta(dir: Direction, when: string) {
    const div = document.createElement('div')
    div.className = 'col-span-2 flex gap-2 text-small sm:col-span-1 sm:flex-col sm:gap-0'
    const label = document.createElement('span')
    label.className =
        dir === 'in'
            ? 'flex items-center gap-1.5 font-semibold before:size-1.5 before:rounded-full before:bg-live'
            : 'text-muted'
    label.textContent = dir === 'in' ? 'Received' : 'Sent'
    const at = document.createElement('span')
    at.className = 'text-muted tabular-nums'
    at.textContent = when
    div.append(label, at)
    return div
}

function copyOnClick(btn: HTMLButtonElement, text: () => string) {
    btn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(text())
        btn.textContent = 'Copied'
        replay(btn)
        setTimeout(() => (btn.textContent = 'Copy'), 1200)
    })
}

// Long or multi-line text gets a View button that opens it full screen
const isLong = (body: string) => body.includes('\n') || body.length > 120

function addText(dir: Direction, body: string) {
    const li = document.createElement('li')
    li.className = itemClass(dir)
    const when = time()

    const pre = document.createElement('pre')
    pre.className = 'max-h-72 min-w-0 overflow-auto font-mono text-small whitespace-pre-wrap wrap-anywhere'
    pre.textContent = body

    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = actionClass
    copy.textContent = 'Copy'
    copyOnClick(copy, () => body)

    const actions = document.createElement('div')
    actions.className = 'flex flex-col gap-2'
    actions.append(copy)
    if (isLong(body)) {
        const view = document.createElement('button')
        view.type = 'button'
        view.className = actionClass
        view.textContent = 'View'
        view.addEventListener('click', () => openViewer(dir, when, body))
        actions.append(view)
    }

    li.append(meta(dir, when), pre, actions)
    ui.feed.prepend(li)
}

function addFile(dir: Direction, name: string, size: number): FileRow {
    const li = document.createElement('li')
    li.className = itemClass(dir)

    const body = document.createElement('div')
    body.className = 'flex min-w-0 flex-col gap-2'

    const label = document.createElement('p')
    label.className = 'font-medium wrap-anywhere'
    label.textContent = name

    const bytes = document.createElement('span')
    bytes.className = 'ml-2 font-normal text-muted tabular-nums'
    bytes.textContent = formatBytes(size)

    const bar = document.createElement('div')
    bar.className = 'h-0.5 w-full bg-rule'
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-label', name)
    const fill = document.createElement('div')
    fill.className = `h-full motion-safe:transition-[width] ${dir === 'in' ? 'bg-live' : 'bg-ink'}`
    fill.style.width = '0%'
    bar.append(fill)

    body.append(label, bar)
    li.append(meta(dir, time()), body)
    ui.feed.prepend(li)
    label.append(bytes)

    return {
        progress(ratio) {
            const pct = Math.round(ratio * 100)
            fill.style.width = `${pct}%`
            bar.setAttribute('aria-valuenow', String(pct))
        },
        done(blob) {
            bar.remove()
            if (!blob) return
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = name
            a.textContent = 'Download'
            a.className = actionClass
            li.append(a)
        },
        fail() {
            bar.remove()
            label.classList.add('text-danger')
            bytes.className = 'ml-2 font-normal'
            bytes.textContent = 'Failed'
        },
    }
}

// ---------- Viewer: full-screen, editor-style read of one text item

let viewing = ''

function openViewer(dir: Direction, when: string, body: string) {
    const lines = body.split('\n')
    viewing = body
    ui.viewerTitle.textContent = `${dir === 'in' ? 'Received' : 'Sent'} at ${when}`
    ui.viewerGutter.textContent = lines.map((_, i) => i + 1).join('\n')
    ui.viewerCode.textContent = body
    const stats = `${lines.length} ${lines.length === 1 ? 'line' : 'lines'} · ${formatBytes(new Blob([body]).size)}`
    ui.viewerStats.textContent = stats
    ui.viewer.showModal()
    ui.viewer.querySelector<HTMLElement>('[data-scroll]')?.scrollTo(0, 0)
    void highlight(body, stats)
}

// Shown as plain text first, then highlighted once highlight.js has loaded.
// It's a separate chunk fetched on first use, so the main page never pays for it.
async function highlight(body: string, stats: string) {
    if (body.length > 200_000) return // auto-detection gets slow; plain text is fine
    const { default: hljs } = await import('highlight.js/lib/common')
    const result = hljs.highlightAuto(body)
    // Low relevance means prose or a guess; leave it plain rather than colour it wrongly
    if (viewing !== body || !result.language || result.relevance < 5) return
    ui.viewerCode.innerHTML = result.value // hljs escapes the source text
    ui.viewerStats.textContent = `${hljs.getLanguage(result.language)?.name ?? result.language} · ${stats}`
}

copyOnClick(ui.viewerCopy, () => viewing)

// ---------- UI events

ui.codeInput.addEventListener('input', () => {
    ui.codeInput.value = ui.codeInput.value.replace(/\D/g, '').slice(0, 4)
})

ui.connectForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const code = ui.codeInput.value
    if (!/^\d{4}$/.test(code) || conn) return
    setStatus('Waiting for accept…', 'busy')
    attach(peer.connect(PREFIX + code, { reliable: true }), false)
})

ui.acceptBtn.addEventListener('click', () => {
    const c = pending
    if (!c) return
    pending = null
    ui.request.hidden = true
    whenOpen(c, () => {
        c.send({ t: 'accept' } satisfies Msg)
        attach(c, true)
    })
})

ui.declineBtn.addEventListener('click', () => {
    const c = pending
    if (!c) return
    pending = null
    ui.request.hidden = true
    whenOpen(c, () => {
        c.send({ t: 'decline' } satisfies Msg)
        setTimeout(() => c.close(), 200)
    })
})

ui.textForm.addEventListener('submit', (e) => {
    e.preventDefault()
    sendText(ui.textInput.value)
    ui.textInput.value = ''
})

ui.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        ui.textForm.requestSubmit()
    }
})

ui.fileInput.addEventListener('change', () => {
    const files = [...(ui.fileInput.files ?? [])]
    ui.fileInput.value = ''
    void sendFiles(files)
})

// dragenter/leave fire for every child element, so count to know when the drag leaves the page
let drags = 0
const setDragging = (on: boolean) => ui.session.toggleAttribute('data-dragging', on)
document.addEventListener('dragenter', () => {
    if (++drags === 1 && conn) setDragging(true)
})
document.addEventListener('dragleave', () => {
    if (--drags === 0) setDragging(false)
})
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
    e.preventDefault()
    drags = 0
    setDragging(false)
    if (!conn) return
    void sendFiles([...(e.dataTransfer?.files ?? [])])
})

ui.disconnectBtn.addEventListener('click', () => conn?.close())

startPeer()