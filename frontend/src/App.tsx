import React, { useEffect, useRef, useState } from "react"
import { Camera, CircleStop, Copy, BrainCircuit, Mic, MonitorUp, Play, Send, ShieldCheck, Sparkles, Upload, Wifi, WifiOff } from "lucide-react"

type Transcript = { id: number; text: string; final: boolean; at: string }
type Screen = "setup" | "session" | "sessions"

type SessionTurn = {
  type: 'transcript' | 'answer' | 'solve'
  at: string
  question?: string    // what was asked / transcript text
  answer?: string      // AI suggested answer
  language?: string    // for solve turns
}

type SessionFile = {
  savedAt: string
  startedAt: string
  duration: string
  company: string | null
  role: string | null
  jobTitle: string | null
  hasResume: boolean
  hasJD: boolean
  turns: SessionTurn[]
}
const API = import.meta.env.VITE_API_URL || "http://localhost:8000"
const WS  = API.replace(/^http/, "ws")

function resampleTo16k(input: Float32Array, rate: number): Int16Array {
  if (rate === 16000) return f32ToI16(input)
  const ratio = rate / 16000
  const out = new Int16Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio, l = Math.floor(pos), r = Math.min(l+1, input.length-1)
    out[i] = Math.max(-1, Math.min(1, input[l]*(1-(pos-l)) + input[r]*(pos-l))) * 0x7fff
  }
  return out
}
function f32ToI16(input: Float32Array) {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) out[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff
  return out
}

/** Lightweight markdown renderer — handles bold headings, bullet lists, code fences, paragraphs */
function MarkdownAnswer({ text, color }: { text: string; color: string }) {
  const [codeCopied, setCodeCopied] = React.useState(false)
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let bulletBuffer: string[] = []
  let codeBuffer: string[] = []
  let inCodeBlock = false
  let codeLang = ''

  const flushBullets = () => {
    if (bulletBuffer.length === 0) return
    nodes.push(
      <ul key={nodes.length} className="md-list">
        {bulletBuffer.map((b, i) => <li key={i}>{renderInline(b)}</li>)}
      </ul>
    )
    bulletBuffer = []
  }

  const flushCode = () => {
    if (codeBuffer.length === 0) return
    const code = codeBuffer.join('\n')
    const idx = nodes.length
    nodes.push(
      <div key={idx} className="md-code-block">
        <div className="md-code-header">
          <span className="md-code-lang">{codeLang || 'code'}</span>
          <button
            className="md-code-copy"
            onClick={() => {
              const el = document.createElement('textarea')
              el.value = code; el.style.position = 'fixed'; el.style.opacity = '0'
              document.body.appendChild(el); el.focus(); el.select()
              document.execCommand('copy'); document.body.removeChild(el)
              setCodeCopied(true); setTimeout(() => setCodeCopied(false), 2000)
            }}
          >{codeCopied ? '✓ Copied' : 'Copy'}</button>
        </div>
        <pre className="md-code-pre"><code>{code}</code></pre>
      </div>
    )
    codeBuffer = []
    codeLang = ''
  }

  const renderInline = (line: string): React.ReactNode => {
    const parts = line.split(/\*\*([^*]+)\*\*/)
    return parts.map((part, i) => i % 2 === 1 ? <strong key={i}>{part}</strong> : part)
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    // Code fence open/close
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        flushBullets()
        inCodeBlock = true
        codeLang = line.slice(3).trim()
      } else {
        inCodeBlock = false
        flushCode()
      }
      continue
    }

    if (inCodeBlock) { codeBuffer.push(raw); continue }
    if (!line) { flushBullets(); continue }

    if (/^\*\*[^*]+\*\*\s*$/.test(line)) {
      flushBullets()
      nodes.push(<p key={nodes.length} className="md-heading">{line.replace(/\*\*/g, '').trim()}</p>)
      continue
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)/)
    if (bulletMatch) { bulletBuffer.push(bulletMatch[1]); continue }

    flushBullets()
    nodes.push(<p key={nodes.length} className="md-p">{renderInline(line)}</p>)
  }
  flushBullets()
  if (inCodeBlock) flushCode() // unclosed fence

  return <div className="md-answer">{nodes}</div>
}

/**
 * Returns true if a transcript segment looks like a question or instruction
 * worth sending to Bedrock. Filters out short filler utterances, greetings,
 * and sentences that are clearly statements rather than questions.
 */
function looksLikeQuestion(text: string): boolean {
  const t = text.trim()

  // Must be at least 3 words — "explain line 7" is 3 words and valid
  const wordCount = t.split(/\s+/).filter(Boolean).length
  if (wordCount < 3) return false

  const lower = t.toLowerCase()

  // Direct question mark
  if (t.endsWith('?')) return true

  // Code line reference — "explain line 7", "what does line 12 do", "why line 7-13"
  if (/\bline[s]?\s+\d/.test(lower)) return true
  if (/\blines?\s+\d+[-–]\d+/.test(lower)) return true

  // Must be at least 5 words for the other patterns (avoid "okay sure" etc.)
  if (wordCount < 5) return false

  // Starts with a question word
  const questionStarters = [
    'what', 'how', 'why', 'when', 'where', 'who', 'which', 'whose', 'whom',
    'can you', 'could you', 'would you', 'will you', 'do you', 'did you',
    'have you', 'are you', 'is there', 'tell me', 'explain', 'describe',
    'walk me', 'talk me', 'give me', 'show me', 'help me', 'define',
    "let's talk", 'can we', 'could we', 'suppose', 'imagine', 'if you',
    'what if', 'how would', 'how do', 'how does', 'how did', 'how can',
    'why do', 'why did', 'why would', 'why is', 'what is', 'what are',
    'what was', 'what were', 'what would', 'what do', 'what does',
  ]
  if (questionStarters.some(s => lower.startsWith(s))) return true

  // Contains interview-common instruction verbs mid-sentence
  const instructionPhrases = [
    'tell me about', 'walk me through', 'explain how', 'describe a time',
    'give an example', 'what experience', 'your approach to', 'how you',
    'have you ever', 'your thoughts on', 'design a', 'implement a',
    'solve this', 'write a', 'find the', 'difference between',
    // Code walkthrough follow-ups
    'explain your', 'explain the', 'explain that', 'explain this',
    'why did you', 'why did you use', 'what does this', 'what does that',
    'walk through', 'run through', 'break down',
  ]
  if (instructionPhrases.some(p => lower.includes(p))) return true

  return false
}

export default function App() {
  const copilot: any = window.copilot
  const isElectron = !!copilot
  const [screen, setScreen] = useState<Screen>("setup")
  const [resume, setResume] = useState("")
  const [jobDescription, setJobDescription] = useState("")
  const [uploadingContext, setUploadingContext] = useState<"resume"|"job_description"|null>(null)
  const [contextNotice, setContextNotice] = useState("")
  const [includeMic, setIncludeMic] = useState(true)
  const [includeShare, setIncludeShare] = useState(false)
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([])
  const [micDeviceId, setMicDeviceId] = useState("")
  const [callDeviceId, setCallDeviceId] = useState("")
  const [status, setStatus] = useState<"idle"|"connecting"|"live"|"error">("idle")
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [selected, setSelected] = useState("")
  const [answer, setAnswer] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState<'answer'|'code'|null>(null)
  const [myThoughts, setMyThoughts] = useState('')
  // Coding screenshot solver
  const [solveLanguage, setSolveLanguage] = useState("Python")
  const [solveBusy, setSolveBusy] = useState(false)
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null)
  // Session transcript recording
  const sessionTurnsRef  = useRef<SessionTurn[]>([])
  const sessionStartRef  = useRef<Date | null>(null)
  const [pastSessions, setPastSessions] = useState<Awaited<ReturnType<Window['copilot']['listSessions']>>>([])
  const [viewingSession, setViewingSession] = useState<SessionFile | null>(null)
  const [sessionSearch, setSessionSearch] = useState('')
  const historyRef = useRef<{question:string;answer:string}[]>([])
  const socketRef = useRef<WebSocket|null>(null)
  const contextRef = useRef<AudioContext|null>(null)
  const streamsRef = useRef<MediaStream[]>([])
  const processorRef = useRef<ScriptProcessorNode|null>(null)
  const sourceNodesRef = useRef<MediaStreamAudioSourceNode[]>([])
  const nextId = useRef(1)
  const stoppingRef = useRef(false)
  const autoAnswerTimer = useRef<ReturnType<typeof setTimeout>|null>(null)
  const transcriptEndRef = useRef<HTMLDivElement|null>(null)
  // Timer for session screen — MUST be declared here (before any conditional return)
  const elapsed = useRef(0)
  const [timer, setTimer] = useState('0:00')

  useEffect(() => () => { void stopCapture() }, [])

  async function refreshDevices() {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
    setInputDevices(devices)
    const bh = devices.find(d => /blackhole/i.test(d.label))
    setCallDeviceId(c => c && devices.some(d => d.deviceId === c) ? c : bh?.deviceId ?? "")
    if (bh) setIncludeShare(true)
  }
  useEffect(() => {
    void refreshDevices()
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices)
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices)
  }, [])

  // Load session count on startup so topbar button shows the right number
  useEffect(() => {
    if (!isElectron || !copilot.listSessions) return
    copilot.listSessions().then(setPastSessions).catch(() => {})
  }, [isElectron])
  useEffect(() => { transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" }) }, [transcripts])
  useEffect(() => {
    if (!selected.trim() || busy) return
    // Only auto-answer if it looks like a question or instruction.
    // Prevents firing on greetings, filler words, or background chatter.
    if (!looksLikeQuestion(selected)) return
    if (autoAnswerTimer.current) clearTimeout(autoAnswerTimer.current)
    autoAnswerTimer.current = setTimeout(() => { void askCopilot() }, 1500)
    return () => { if (autoAnswerTimer.current) clearTimeout(autoAnswerTimer.current) }
  }, [selected])

  async function uploadContextFile(contextType: "resume"|"job_description", file: File) {
    setContextNotice(""); setUploadingContext(contextType)
    try {
      const form = new FormData(); form.append("file", file); form.append("context_type", contextType)
      const res = await fetch(`${API}/api/context/file`, { method: "POST", body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || "Could not extract text.")
      const current = contextType === "resume" ? resume : jobDescription
      const limit = contextType === "resume" ? 20000 : 10000
      const sep = current.trim() ? "\n\n" : ""
      const imported = String(data.text).slice(0, Math.max(0, limit - current.length - sep.length))
      if (contextType === "resume") setResume(current ? `${current}${sep}${imported}` : imported)
      else setJobDescription(current ? `${current}${sep}${imported}` : imported)
      setContextNotice(`✓ ${file.name} imported${data.pages ? ` (${data.pages} pages)` : ""}`)
    } catch (err) { setContextNotice(err instanceof Error ? err.message : "Could not extract text.") }
    finally { setUploadingContext(null) }
  }

  async function startCapture() {
    stoppingRef.current = false; setError(""); setStatus("connecting")
    try {
      const streams: MediaStream[] = []
      if (includeMic) streams.push(await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micDeviceId ? { exact: micDeviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }))
      if (includeShare) {
        if (!callDeviceId) throw new Error("Choose a call audio device (e.g. BlackHole 2ch).")
        if (includeMic && callDeviceId === micDeviceId) throw new Error("Microphone and call audio are the same device.")
        streams.push(await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: callDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false }))
      }
      if (streams.length === 0) throw new Error("Select at least one audio source.")
      streamsRef.current = streams
      const socket = new WebSocket(`${WS}/ws/transcribe`)
      socket.binaryType = "arraybuffer"; socketRef.current = socket
      socket.onclose = ev => {
        // Only show an error if we didn't initiate the stop ourselves
        // AND there's a meaningful close reason (not a normal clean close)
        if (!stoppingRef.current && ev.code !== 1000 && ev.code !== 1001) {
          setStatus('idle')
          // Don't show error — just silently reset so user can start again
        }
      }
      await new Promise<void>((res, rej) => { socket.onopen = () => res(); socket.onerror = () => rej(new Error("Could not connect to backend.")) })
      socket.onerror = () => { setError("WebSocket error."); setStatus("error") }
      socket.onmessage = ev => {
        const msg = JSON.parse(ev.data)
        if (msg.type === "transcript") {
          const item: Transcript = { id: nextId.current++, text: msg.text, final: msg.is_final, at: new Date().toLocaleTimeString() }
          if (msg.is_final) { setTranscripts(p => [...p, item]); setSelected(msg.text) }
          else setTranscripts(p => { const c=[...p]; const last=c[c.length-1]; if(last&&!last.final) c[c.length-1]={...last,text:msg.text}; else c.push(item); return c })
        } else if (msg.type === "error") { stoppingRef.current=true; setError(msg.message); setStatus("error") }
      }
      const ctx = new AudioContext(); contextRef.current = ctx
      const proc = ctx.createScriptProcessor(4096,1,1); processorRef.current = proc
      const dest = ctx.createGain(); dest.gain.value=0; proc.connect(dest); dest.connect(ctx.destination)
      streams.forEach(s => { const src=ctx.createMediaStreamSource(s); src.connect(proc); sourceNodesRef.current.push(src) })
      proc.onaudioprocess = ev => { if(socket.readyState!==WebSocket.OPEN) return; socket.send(resampleTo16k(ev.inputBuffer.getChannelData(0),ctx.sampleRate).buffer as ArrayBuffer) }
      await ctx.resume(); setStatus("live"); setScreen("session")
      // Start recording session
      sessionStartRef.current = new Date()
      sessionTurnsRef.current = []
    } catch(err) { setError(err instanceof Error ? err.message : "Could not start."); setStatus("error") }
  }

  async function saveCurrentSession() {
    if (!isElectron || !copilot.saveSession) return
    if (sessionTurnsRef.current.length === 0) return
    const start = sessionStartRef.current
    const durationMs = start ? Date.now() - start.getTime() : 0
    const mins = Math.floor(durationMs / 60000)
    const secs = Math.floor((durationMs % 60000) / 1000)
    // Extract company and role from first lines of job description
    const jdLines = jobDescription.trim().split('\n').filter(Boolean)
    const company  = jdLines[0]?.slice(0, 60) || null
    const role     = jdLines[1]?.slice(0, 80) || null
    await copilot.saveSession({
      startedAt:      start?.toISOString() ?? new Date().toISOString(),
      duration:       `${mins}m ${secs}s`,
      durationSecs:   Math.floor(durationMs / 1000),
      company,
      role,
      jobTitle:       company || null,
      hasResume:      !!resume.trim(),
      hasJD:          !!jobDescription.trim(),
      turns:          sessionTurnsRef.current,
    })
  }

  async function stopCapture() {
    stoppingRef.current = true
    processorRef.current?.disconnect(); processorRef.current=null
    sourceNodesRef.current.forEach(n=>n.disconnect()); sourceNodesRef.current=[]
    if(contextRef.current){await contextRef.current.close().catch(()=>{}); contextRef.current=null}
    streamsRef.current.forEach(s=>s.getTracks().forEach(t=>t.stop())); streamsRef.current=[]
    const sock=socketRef.current
    if(sock?.readyState===WebSocket.OPEN) sock.send(JSON.stringify({type:"stop"}))
    else if(sock?.readyState===WebSocket.CONNECTING) sock.close()
    socketRef.current=null; setStatus("idle")
    // Auto-save session on stop
    await saveCurrentSession()
  }

  // Capture screen and solve the coding problem shown.
  // Uses getDisplayMedia() in the renderer — works on macOS 15 Sequoia
  // where desktopCapturer.getSources() is broken for ad-hoc signed apps.
  async function solveScreenshot(dataUrl?: string) {
    setSolveBusy(true)
    try {
      let blob: Blob

      if (dataUrl) {
        // Called from Cmd+H push — convert existing dataUrl
        const commaIdx = dataUrl.indexOf(",")
        const base64   = dataUrl.slice(commaIdx + 1)
        const binary   = atob(base64)
        const bytes    = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const mime = dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg"
        blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime })
      } else {
        // Capture via native screen picker — works on macOS 15
        setAnswer("Pick the window or screen to capture in the picker that opens…")
        let stream: MediaStream
        try {
          // useSystemPicker:true is set in main.js — macOS 15 uses native SCK picker
        // Constraints must match exactly what Electron expects
        stream = await navigator.mediaDevices.getDisplayMedia({
          audio: false,
          video: { width: 1920, height: 1200, frameRate: 1 },
        } as any)
        } catch (e: any) {
          setAnswer(`Screen picker cancelled or denied: ${e?.message ?? e}`)
          return
        }

        setAnswer("Capturing frame…")
        const video = document.createElement("video")
        video.srcObject = stream
        video.muted = true
        await video.play()
        await new Promise(res => setTimeout(res, 300))
        await new Promise(res => requestAnimationFrame(res))

        const canvas = document.createElement("canvas")
        canvas.width  = video.videoWidth  || 1280
        canvas.height = video.videoHeight || 800
        canvas.getContext("2d")!.drawImage(video, 0, 0)
        stream.getTracks().forEach(t => t.stop())

        blob = await new Promise<Blob>((res, rej) =>
          canvas.toBlob(b => b ? res(b) : rej(new Error("Canvas toBlob failed")), "image/jpeg", 0.92)
        )
      }

      setAnswer(`Sending ${Math.round(blob.size / 1024)}KB to Bedrock vision…`)
      const ext  = blob.type.includes("png") ? "png" : "jpeg"
      const file = new File([blob], `screenshot.${ext}`, { type: blob.type })
      const form = new FormData()
      form.append("image", file)
      form.append("language", solveLanguage)

      let apiRes: Response
      try { apiRes = await fetch(`${API}/api/solve`, { method: "POST", body: form }) }
      catch (e: any) { setAnswer(`Cannot reach backend: ${e?.message ?? e}`); return }

      const apiData = await apiRes.json().catch(() => ({}))
      if (!apiRes.ok) { setAnswer(`API error ${apiRes.status}: ${apiData?.detail ?? JSON.stringify(apiData)}`); return }
      if (!apiData.solution) { setAnswer(`No solution returned. Keys: ${JSON.stringify(Object.keys(apiData))}`); return }

      setAnswer(apiData.solution)

      // Record solve turn in session transcript
      sessionTurnsRef.current.push({ type: 'solve', at: new Date().toLocaleTimeString(), language: solveLanguage, answer: apiData.solution })
      // Extract the code block, add line numbers, and store alongside the full solution.
      const codeMatch = apiData.solution.match(/```(?:\w+)?\n?([\s\S]*?)```/)
      const numberedCode = codeMatch
        ? codeMatch[1].split('\n').map((l: string, i: number) => `${String(i + 1).padStart(3)}: ${l}`).join('\n')
        : null

      const historyAnswer = numberedCode
        ? `${apiData.solution}\n\n[Line-numbered code for reference:]\n\`\`\`\n${numberedCode}\n\`\`\``
        : apiData.solution

      historyRef.current = [
        ...historyRef.current,
        {
          question: `[Screenshot solve — ${solveLanguage}] A coding problem was shown on screen and I solved it.`,
          answer: historyAnswer,
        }
      ].slice(-10)
      // Pre-fill Q box so follow-ups like "walk me through" fire immediately
      setSelected('Walk me through your solution.')

    } catch (err: any) {
      setAnswer(`Error: ${err?.message ?? String(err)}`)
    } finally {
      setSolveBusy(false)
    }
  }

  // Cmd+H push from Electron main — auto-capture and solve
  useEffect(() => {
    if (!isElectron) return
    copilot.onScreenshot((payload: { dataUrl: string }) => {
      if (!payload?.dataUrl) return
      setScreenshotDataUrl(payload.dataUrl)
      void solveScreenshot(payload.dataUrl)
    })
    return () => { copilot.offScreenshot() }
  }, [isElectron, solveLanguage])


  async function askCopilot() {
    if(!selected.trim()) return
    setBusy(true); setAnswer("Thinking…"); const q=selected
    try {
      const res=await fetch(`${API}/api/answer`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({transcript:q,history:historyRef.current.slice(-10),resume:resume.trim()||null,job_description:jobDescription.trim()||null})})
      const data=await res.json()
      if(!res.ok) throw new Error(data.detail||"Bedrock request failed")
      setAnswer(data.answer)
      historyRef.current=[...historyRef.current,{question:q,answer:data.answer}].slice(-10)
      // Record this Q&A turn in the session transcript
      sessionTurnsRef.current.push({ type: 'answer', at: new Date().toLocaleTimeString(), question: q, answer: data.answer })
    } catch(err){setAnswer(err instanceof Error?err.message:"Unable to generate answer.")}
    finally{setBusy(false)}
  }

  const isLive = status === 'live'

  // Copy text to clipboard with visual feedback
  function copyText(text: string, type: 'answer'|'code') {
    const el = document.createElement('textarea')
    el.value = text
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.focus()
    el.select()
    document.execCommand('copy')
    document.body.removeChild(el)
    setCopied(type)
    setTimeout(() => setCopied(null), 2000)
  }

  // Extract just the code block from a solution (between ``` fences)
  function extractCode(text: string): string {
    const match = text.match(/```(?:\w+)?\n?([\s\S]*?)```/)
    return match ? match[1].trim() : text
  }

  // ── Manual text style controls ────────────────────────────────────────────
  const [textColor,  setTextColor]  = useState('#ffffff')
  const [fontSize,   setFontSize]   = useState(14)
  const [fontWeight, setFontWeight] = useState<'400'|'600'|'700'>('400')
  const [showTextSettings, setShowTextSettings] = useState(false)
  const answerAreaRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isLive) return
    elapsed.current = 0
    const id = setInterval(() => {
      elapsed.current += 1
      const m = Math.floor(elapsed.current / 60)
      const s = String(elapsed.current % 60).padStart(2, '0')
      setTimer(`${m}:${s}`)
    }, 1000)
    return () => clearInterval(id)
  }, [isLive])
  const WC = () => null // Native macOS traffic lights handle close/minimize (titleBarStyle:'hiddenInset')

  // ── SETUP SCREEN ──────────────────────────────────────────────────────────
  if (screen === "setup") return (
    <div className="setup-shell">
      <div className="setup-topbar">
        <WC/>
        <div className="setup-brand"><BrainCircuit size={18}/><span>InterviewCopilot</span></div>
        {/* Sessions button in topbar — always visible */}
        {isElectron && (
          <button className="topbar-sessions-btn" onClick={async () => {
            const list = await copilot.listSessions()
            setPastSessions(list)
            setScreen('sessions')
          }}>
            📋 Sessions{pastSessions.length > 0 ? ` (${pastSessions.length})` : ''}
          </button>
        )}
      </div>
      <div className="setup-body">
        <h1 className="setup-title">Set up your session</h1>
        <p className="setup-sub">Add context and pick your audio sources, then start.</p>

        <div className="setup-section">
          <div className="setup-section-label">INTERVIEW CONTEXT <span className="setup-optional">optional</span></div>
          <div className="setup-context-grid">
            <div className="setup-field">
              <div className="setup-field-header"><span>Your resume</span>
                <label className={`setup-upload-btn${uploadingContext?" disabled":""}`}>
                  <Upload size={12}/>{uploadingContext==="resume"?"Extracting…":"Upload PDF"}
                  <input type="file" accept=".pdf,.docx,.txt" disabled={!!uploadingContext} onChange={e=>{const f=e.target.files?.[0];if(f) void uploadContextFile("resume",f);e.currentTarget.value=""}}/>
                </label>
              </div>
              <textarea className="setup-textarea" placeholder="Paste your resume…" value={resume} onChange={e=>setResume(e.target.value)} rows={5}/>
              <span className="setup-char">{resume.length.toLocaleString()} / 20,000</span>
            </div>
            <div className="setup-field">
              <div className="setup-field-header"><span>Job description</span>
                <label className={`setup-upload-btn${uploadingContext?" disabled":""}`}>
                  <Upload size={12}/>{uploadingContext==="job_description"?"Extracting…":"Upload PDF"}
                  <input type="file" accept=".pdf,.docx,.txt" disabled={!!uploadingContext} onChange={e=>{const f=e.target.files?.[0];if(f) void uploadContextFile("job_description",f);e.currentTarget.value=""}}/>
                </label>
              </div>
              <textarea className="setup-textarea" placeholder="Paste the job description…" value={jobDescription} onChange={e=>setJobDescription(e.target.value)} rows={5}/>
              <span className="setup-char">{jobDescription.length.toLocaleString()} / 10,000</span>
            </div>
          </div>
          {contextNotice && <div className="setup-notice">{contextNotice}</div>}
        </div>

        <div className="setup-section">
          <div className="setup-section-label">AUDIO SOURCES</div>
          <div className="setup-audio-grid">
            <label className={`setup-audio-card${includeMic?" active":""}`}>
              <input type="checkbox" checked={includeMic} onChange={e=>setIncludeMic(e.target.checked)}/>
              <Mic size={20}/>
              <div className="setup-audio-info">
                <b>Microphone</b><small>Your voice</small>
                <select className="setup-select" value={micDeviceId} onClick={e=>e.stopPropagation()} onChange={e=>setMicDeviceId(e.target.value)}>
                  <option value="">System default</option>
                  {inputDevices.map(d=><option key={d.deviceId} value={d.deviceId}>{d.label||"Unnamed"}</option>)}
                </select>
              </div>
            </label>
            <label className={`setup-audio-card${includeShare?" active":""}`}>
              <input type="checkbox" checked={includeShare} onChange={e=>setIncludeShare(e.target.checked)}/>
              <MonitorUp size={20}/>
              <div className="setup-audio-info">
                <b>Call audio</b><small>Via BlackHole</small>
                <select className="setup-select" value={callDeviceId} onClick={e=>e.stopPropagation()} onChange={e=>setCallDeviceId(e.target.value)}>
                  <option value="">Choose device…</option>
                  {inputDevices.map(d=><option key={d.deviceId} value={d.deviceId}>{d.label||"Unnamed"}</option>)}
                </select>
              </div>
            </label>
          </div>
        </div>

        {error && <div className="setup-error">{error}</div>}
        <button className="setup-start-btn" onClick={startCapture} disabled={status==="connecting"}>
          <Play size={16} fill="currentColor"/>{status==="connecting"?"Connecting…":"Start session"}
        </button>
        <div className="setup-hint"><ShieldCheck size={12}/> Audio is streamed for transcription only — never stored.</div>
      </div>
    </div>
  )

  // ── SESSIONS SCREEN — Parakeet-style dashboard ────────────────────────────
  if (screen === 'sessions') {
    const filtered = pastSessions.filter(s => {
      if (!sessionSearch.trim()) return true
      const q = sessionSearch.toLowerCase()
      return (s.jobTitle || '').toLowerCase().includes(q) || s.filename.includes(q)
    })

    if (viewingSession) return (
      <div className="sessions-shell">
        <div className="sessions-topbar">
          <button className="sessions-back" onClick={() => setViewingSession(null)}>← Sessions</button>
          <div className="sessions-title">
            <span>{viewingSession.company || 'Session'}</span>
            {viewingSession.role && <span className="sessions-role">{viewingSession.role}</span>}
          </div>
          <span className="sessions-meta-pill">{viewingSession.duration} · {viewingSession.turns?.length ?? 0} turns</span>
        </div>
        <div className="sessions-transcript-body">
          {(viewingSession.turns || []).map((turn, i) => (
            <div key={i} className={`stc-card stc-${turn.type}`}>
              <div className="stc-card-header">
                <span className="stc-card-type">
                  {turn.type === 'answer' ? '🤖 AI Answer' : turn.type === 'solve' ? `💻 Code · ${turn.language}` : '🎙 Question'}
                </span>
                <span className="stc-card-time">{turn.at}</span>
              </div>
              {turn.question && <div className="stc-card-q">{turn.question}</div>}
              {turn.answer && <div className="stc-card-a"><MarkdownAnswer text={turn.answer} color="#111827"/></div>}
            </div>
          ))}
        </div>
      </div>
    )

    return (
      <div className="sessions-shell">
        <div className="sessions-topbar">
          <button className="sessions-back" onClick={() => setScreen('setup')}>← Back</button>
          <span className="sessions-title-text">Call Sessions</span>
          {isElectron && <button className="sessions-folder-btn" onClick={() => copilot.openSessionsFolder()}>Open folder ↗</button>}
        </div>

        <div className="sessions-body">
          {/* Search */}
          <div className="sessions-search-bar">
            <span className="sessions-search-icon">🔍</span>
            <input
              className="sessions-search-input"
              placeholder="Search by role or company…"
              value={sessionSearch}
              onChange={e => setSessionSearch(e.target.value)}
            />
          </div>

          {filtered.length === 0 ? (
            <div className="sessions-empty">
              {sessionSearch ? 'No sessions match your search.' : 'No sessions yet. Sessions save automatically when you end an interview.'}
            </div>
          ) : (
            <div className="sessions-grid">
              {filtered.map(s => {
                const date = s.savedAt ? new Date(s.savedAt) : null
                const dateStr = date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase() : '—'
                return (
                  <div key={s.filename} className="session-card">
                    <div className="sc-date">{dateStr}</div>
                    <div className="sc-company">{s.jobTitle || 'Interview Session'}</div>
                    <div className="sc-role">{s.filename.replace('.json','').replace(/_/g,' ')}</div>
                    <div className="sc-tags">
                      <span className="sc-tag">Interview</span>
                      {s.turnCount > 0 && <span className="sc-tag sc-tag-transcript">Transcript</span>}
                    </div>
                    <div className="sc-footer">
                      <span className="sc-status sc-ended">● Ended</span>
                      <span className="sc-duration">{s.duration || `${s.turnCount} turns`}</span>
                      <button className="sc-view-btn" onClick={async () => {
                        const r = await copilot.loadSession(s.filename)
                        if (r.success && r.data) setViewingSession(r.data as SessionFile)
                      }}>View transcript</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── SESSION SCREEN — Parakeet-style layout ────────────────────────────────
  return (
    <div className="session-shell">

      {/* Status bar — very top, draggable */}
      <div className={`session-statusbar${isLive ? '' : ' sess-stopped'}`}>
        <WC/>
        <span className="sess-timer">
          <span className="sess-live-dot"/>
          {isLive ? timer : 'Stopped'}
        </span>
        {isLive && <span className="sess-auto-badge">Auto Answer On</span>}
        <span className="sess-status-sep"/>
        {isLive
          ? <button className="sess-stop-btn" onClick={stopCapture}><CircleStop size={12}/> End</button>
          : <button className="sess-statusbar-btn" onClick={() => { setScreen('setup'); setTranscripts([]); setSelected(''); setAnswer(''); setError(''); setMyThoughts('') }}>← Setup</button>
        }
      </div>

      {/* Question strip — editable so user can fix wrong transcriptions */}
      <div className="session-question-bar">
        <span className="sess-q-label">Q</span>
        {selected
          ? <textarea
              className="sess-q-input"
              value={selected}
              onChange={e => setSelected(e.target.value)}
              rows={2}
              placeholder="Edit question if transcript was wrong…"
            />
          : <span className="sess-q-empty">{isLive ? 'Listening for a question…' : 'No question detected yet.'}</span>
        }
      </div>

      {/* Answer area — fills all remaining height, adaptive text color */}
      <div className="session-answer-area" ref={answerAreaRef}
        style={{ color: textColor, fontSize: fontSize, fontWeight: fontWeight }}>
        {busy
          ? <p className="sess-answer-thinking">Generating answer…</p>
          : answer
            ? <div className="sess-answer-text"><MarkdownAnswer text={answer} color={textColor}/></div>
            : <div className="sess-answer-placeholder">
                <Sparkles size={28}/>
                <p>{isLive ? 'Answer will appear here automatically.' : 'Start a session to get AI answers.'}</p>
              </div>
        }
      </div>

      {/* My Thoughts — scratchpad to jot down what you want to say */}
      <div className="my-thoughts-section">
        <div className="my-thoughts-header">
          <span className="my-thoughts-label">MY THOUGHTS</span>
          <span className="my-thoughts-hint">Jot down what you want to say before speaking</span>
          {myThoughts && (
            <button className="my-thoughts-copy" onClick={() => copyText(myThoughts, 'answer')} title="Copy thoughts">
              {copied === 'answer' ? '✓' : <Copy size={11}/>}
            </button>
          )}
        </div>
        <textarea
          className="my-thoughts-input"
          placeholder="Type your own notes, edits to the AI answer, or key points you want to hit…"
          value={myThoughts}
          onChange={e => setMyThoughts(e.target.value)}
          rows={3}
        />
      </div>

      {/* Action bar — bottom */}
      <div className="session-actionbar">
        <button className="sess-action-btn primary" onClick={askCopilot} disabled={!selected.trim() || busy}>
          <Send size={13}/>{busy ? 'Generating…' : 'Answer'}
        </button>

        {/* Screenshot solve — capture screen and solve coding problem */}
        <button
          className="sess-action-btn"
          title="Capture screen and solve coding problem (also Cmd+H)"
          onClick={() => solveScreenshot()}
          disabled={solveBusy}
          style={{gap:5}}
        >
          <Camera size={13}/>{solveBusy ? 'Solving…' : 'Solve'}
        </button>

        {/* Language picker for solve */}
        <select
          className="sess-lang-select"
          value={solveLanguage}
          onChange={e => setSolveLanguage(e.target.value)}
          title="Language for code solution"
        >
          {['Python','JavaScript','TypeScript','Java','C++','C#','Go','Kotlin','Swift','Ruby','Rust','SQL'].map(l =>
            <option key={l} value={l}>{l}</option>
          )}
        </select>

        <button className="sess-action-btn" onClick={() => { setAnswer(''); setSelected(''); setScreenshotDataUrl(null); setMyThoughts('') }}>
          Clear
        </button>
        {answer && (<>
          {/* Copy full answer */}
          <button
            className="sess-copy-btn"
            title="Copy full answer"
            onClick={() => copyText(answer, 'answer')}
            style={{ color: copied === 'answer' ? '#4ade80' : undefined, borderColor: copied === 'answer' ? 'rgba(74,222,128,0.4)' : undefined }}
          >
            {copied === 'answer' ? '✓' : <Copy size={14}/>}
          </button>
          {/* Copy just the code block */}
          {answer.includes('```') && (
            <button
              className="sess-action-btn"
              title="Copy code only"
              onClick={() => copyText(extractCode(answer), 'code')}
              style={{
                fontSize: 11,
                color: copied === 'code' ? '#4ade80' : 'rgba(255,255,255,0.7)',
                borderColor: copied === 'code' ? 'rgba(74,222,128,0.4)' : undefined,
                gap: 5,
              }}
            >
              <Copy size={12}/>
              {copied === 'code' ? 'Copied!' : 'Copy code'}
            </button>
          )}
        </>)}
        <span className="sess-spacer"/>

        {/* Text style button — Aa */}
        <div style={{position:'relative'}}>
          <button
            className="sess-action-btn"
            title="Text style"
            onClick={() => setShowTextSettings(s => !s)}
            style={{fontWeight:600, letterSpacing: '-.3px'}}
          >Aa</button>

          {showTextSettings && (
            <div className="text-settings-popover">
              {/* Color presets */}
              <div className="ts-row">
                <span className="ts-label">Color</span>
                <div className="ts-colors">
                  {['#ffffff','#000000','#111827','#f3f4f6','#fbbf24','#34d399','#60a5fa','#f87171','#c084fc'].map(c => (
                    <button
                      key={c}
                      className={`ts-color-swatch ${textColor === c ? 'active' : ''}`}
                      style={{background: c, border: textColor === c ? '2px solid rgba(255,255,255,0.9)' : '2px solid rgba(255,255,255,0.15)'}}
                      onClick={() => setTextColor(c)}
                    />
                  ))}
                  {/* Custom color picker */}
                  <label className="ts-color-picker-btn" title="Custom color">
                    <input type="color" value={textColor} onChange={e => setTextColor(e.target.value)} style={{opacity:0,position:'absolute',width:0,height:0}}/>
                    ✎
                  </label>
                </div>
              </div>

              {/* Font size */}
              <div className="ts-row">
                <span className="ts-label">Size</span>
                <div className="ts-size-btns">
                  {[11,13,15,17,20].map(s => (
                    <button
                      key={s}
                      className={`ts-size-btn ${fontSize === s ? 'active' : ''}`}
                      onClick={() => setFontSize(s)}
                    >{s}</button>
                  ))}
                </div>
              </div>

              {/* Font weight */}
              <div className="ts-row">
                <span className="ts-label">Style</span>
                <div className="ts-size-btns">
                  {(['400','600','700'] as const).map(w => (
                    <button
                      key={w}
                      className={`ts-size-btn ${fontWeight === w ? 'active' : ''}`}
                      style={{fontWeight: w}}
                      onClick={() => setFontWeight(w)}
                    >{{
                      '400': 'Normal',
                      '600': 'Semi',
                      '700': 'Bold'
                    }[w]}</button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <span style={{fontSize:11,color:'rgba(255,255,255,0.3)',display:'flex',alignItems:'center',gap:5}}>
          {isLive ? <><Wifi size={12}/> Live</> : <><WifiOff size={12}/> Offline</>}
        </span>
      </div>

      {error && <div className="session-error">{error}</div>}
    </div>
  )
}
