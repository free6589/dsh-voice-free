/**
 * dsh-voice-free 小接口：传一段录音，拿回文字。
 *
 * 给谁用：浏览器那个小麦克风在内网地址上被浏览器掐了，
 * 这个接口不走浏览器录音，你在外面录好 wav 发过来就行。
 *
 * 用法（大白话）：
 *   1. 先启动：node voice-api.mjs（默认只听本机 127.0.0.1:8095）
 *   2. 传文件：curl -F "audio=@录音.wav" http://127.0.0.1:8095/transcribe
 *   3. 拿回 JSON：{"ok":true,"text":"识别出的字","engine":"doubao"}
 *
 * 里面的识别还是走你那两个老命令（f9-doubao / f9-metaso），
 * 豆包不行等 3 秒重试 3 次，再不行自动换秘塔，都不行就报错。
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.VOICE_API_PORT || 8095)
const HOST = process.env.VOICE_API_HOST || '127.0.0.1'
const TOKEN = process.env.VOICE_API_TOKEN || ''
// 一次最多收 15MB，够 2 分钟 16k wav 用。
const MAX_BYTES = 15 * 1024 * 1024

function binOf(engine) {
  if (engine === 'doubao') {
    return process.env.DSH_VOICE_FREE_DOUBAO_BIN || join(homedir(), '.local/bin', 'f9-doubao')
  }
  return process.env.DSH_VOICE_FREE_METASO_BIN || join(homedir(), '.local/bin', 'f9-metaso')
}

function runOnce(engine, wavPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(binOf(engine), ['--transcribe', wavPath, '--no-inject'], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${engine} 识别超过 120 秒没返回`))
    }, 120_000)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c) => { out += c })
    child.stderr?.on('data', (c) => { err += c })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`启动 ${engine} 失败：${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let text = ''
      try {
        const raw = out.trim()
        if (raw === '') throw new Error('引擎没有输出任何内容')
        // CLI 有时会先打一行诊断 JSON 再打结果，认有 ok/text 的那块。
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          const s = raw.indexOf('{')
          const e = raw.lastIndexOf('}')
          parsed = JSON.parse(raw.slice(s, e + 1))
        }
        if (parsed && parsed.ok === false) {
          throw new Error(typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : `退出码 ${code}`)
        }
        text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
      } catch (e) {
        reject(new Error(`${engine} 输出看不懂：${e.message}（stderr: ${err.slice(0, 200)}）`))
        return
      }
      resolve({ text, raw: out.slice(0, 500) })
    })
  })
}

async function transcribeWithFallback(wavPath, primary = 'doubao') {
  const order = primary === 'metaso' ? ['metaso', 'doubao'] : ['doubao', 'metaso']
  let lastError
  for (const engine of order) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const { text } = await runOnce(engine, wavPath)
        return { text, engine, attempts: attempt }
      } catch (e) {
        lastError = e
        if (attempt < 4) await new Promise((r) => setTimeout(r, 3000))
      }
    }
  }
  throw lastError
}

/** 最小 multipart 解析：只认 name="audio" 的文件块。 */
function parseMultipart(body, boundary) {
  const sep = Buffer.from('--' + boundary)
  const parts = []
  let start = 0
  while (true) {
    const i = body.indexOf(sep, start)
    if (i < 0) break
    parts.push(i)
    start = i + sep.length
    if (start > body.length) break
  }
  for (let p = 0; p + 1 < parts.length; p += 1) {
    const head = body.slice(parts[p] + sep.length, parts[p + 1])
    const headerEnd = head.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd < 0) continue
    const header = head.slice(0, headerEnd).toString('latin1')
    if (!header.includes('name="audio"')) continue
    let data = head.slice(headerEnd + 4)
    // 去掉结尾的 \r\n
    if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) {
      data = data.slice(0, data.length - 2)
    }
    const m = header.match(/filename="([^"]*)"/)
    return { filename: m ? m[1] : 'rec.wav', data: Buffer.from(data) }
  }
  return null
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x')
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, service: 'dsh-voice-free', engines: ['doubao', 'metaso'] })
    return
  }
  if (req.method !== 'POST' || url.pathname !== '/transcribe') {
    json(res, 404, { ok: false, error: '只认 POST /transcribe，文件字段叫 audio' })
    return
  }
  if (TOKEN !== '') {
    const got = req.headers['x-voice-token'] || url.searchParams.get('token') || ''
    if (got !== TOKEN) {
      json(res, 401, { ok: false, error: '口令不对（x-voice-token 或 ?token=）' })
      return
    }
  }
  const ctype = req.headers['content-type'] || ''
  const m = ctype.match(/boundary=(.+)$/)
  if (!m) {
    json(res, 400, { ok: false, error: '请用 multipart 表单传文件，字段名 audio' })
    return
  }
  const chunks = []
  let size = 0
  let tooBig = false
  req.on('data', (c) => {
    size += c.length
    if (size > MAX_BYTES) { tooBig = true; return }
    chunks.push(c)
  })
  req.on('end', async () => {
    if (tooBig) {
      json(res, 413, { ok: false, error: '文件太大，最多 15MB' })
      return
    }
    const body = Buffer.concat(chunks)
    const file = parseMultipart(body, m[1])
    if (!file || file.data.length < 44) {
      json(res, 400, { ok: false, error: '没收到录音文件（字段名要是 audio）' })
      return
    }
    // 简单认一下 wav 头，不是 wav 也放行，让 CLI 去报错。
    const dir = join(tmpdir(), 'dsh-voice-free')
    await mkdir(dir, { recursive: true })
    const wavPath = join(dir, `api-${Date.now()}.wav`)
    await writeFile(wavPath, file.data)
    try {
      const primary = url.searchParams.get('primary') === 'metaso' ? 'metaso' : 'doubao'
      const { text, engine } = await transcribeWithFallback(wavPath, primary)
      await rm(wavPath, { force: true })
      json(res, 200, { ok: true, text, engine })
    } catch (e) {
      json(res, 502, {
        ok: false,
        error: '网络好像有问题，录音已保存，网好了点重试',
        detail: String(e?.message || e),
        recording: wavPath,
      })
    }
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[voice-api] 听着 http://${HOST}:${PORT}，POST /transcribe 传 audio 字段${TOKEN !== '' ? '（要口令）' : '（没设口令，内网用）'}`)
})
