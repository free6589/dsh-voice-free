/**
 * dsh-voice-free — 把 DSH 的语音输入接到现成的 `f9-doubao` / `f9-metaso` CLI。
 *
 * 这两个 CLI 里已经有真正的识别逻辑（豆包输入法匿名后端、秘塔回响 ASR），本插件只做
 * 三件事：实现 `speechToText` 的 SpeechProvider、把录音落成临时 wav 交给 CLI、按
 * 「主力失败→等 3 秒重试→切备选」的节奏兜底。不导入任何模型、不做本地推理，也不碰
 * F9/F10 的键位绑定——那是 CLI 自己的事（`--transcribe` 只识别、不上屏）。
 *
 * 身份与切换：注册两个 provider，id 分别是 `doubao` 与 `metaso`。DSH 语音设置里的
 * 「识别服务」下拉读的就是 `speechToText` 的名单，选中哪个就把
 * `speech-to-text.defaultProvider` 写成哪个；`cordis.patch.yml` 把默认值钉成
 * `doubao`，所以开箱即豆包主力。本插件自己的 `primary` 配置只决定「谁带兜底链」：
 * 主力引擎连跪后自动落到另一个引擎，备用引擎自己不跨家。
 */

import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** 插件名；cordis Loader 用它定位 profile 里的插件条目。 */
export const name = 'voice-free'
/** 只依赖识别注册表：provider 是往里注册的，不需要 subprocess/settings 服务。 */
export const inject = ['speechToText']

export const PROVIDER_DOUBAO = 'doubao'
export const PROVIDER_METASO = 'metaso'
/** 默认主力：豆包（`cordis.patch.yml` 的 defaultProvider 也钉这个值）。 */
export const defaultPrimary = PROVIDER_DOUBAO

/** 首次失败之后的额外重试次数；「等 3 秒重试最多 3 次」= 最多 4 次调用。 */
const RETRIES = 3
/** 两次尝试之间的静默时长。 */
const RETRY_DELAY_MS = 3000

/**
 * 重试节奏允许 env 覆盖：自测要用 20ms 跑全链，线上默认值保持 3s×3。
 * 放 env 而不是配置项，是因为这是排障旋钮，不该占用户设置面板。
 */
function retryDelayMs() {
  const raw = Number(process.env.DSH_VOICE_FREE_RETRY_DELAY_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : RETRY_DELAY_MS
}

function retries() {
  const raw = Number(process.env.DSH_VOICE_FREE_RETRIES)
  return Number.isInteger(raw) && raw >= 0 ? raw : RETRIES
}
/** 单次 CLI 调用的墙上时间上限；f9 自己的 --max-seconds 默认 120s，这里给足还不至于挂死。 */
const ATTEMPT_TIMEOUT_MS = 120_000
/** 全部引擎都失败时的用户可见提示（同时是验收口径，别改）。 */
const FAILED_HINT = '网络好像有问题，录音已保存，网好了点重试'
/**
 * 语言提示。两个引擎都是中文自动识别，`auto` 是官方默认值；`en` 只是为了让用户在旧
 * profile 里残留的 en 选择不至于被注册表直接拒掉（识别质量按引擎实际能力）。
 */
const LANGUAGES = ['auto', 'zh', 'en']

/** CLI 位置：默认取 ~/.local/bin 的软包装，允许用环境变量指到别处（测试/换机用）。 */
function binOf(engineId) {
  if (engineId === PROVIDER_DOUBAO) {
    return process.env.DSH_VOICE_FREE_DOUBAO_BIN || join(homedir(), '.local/bin', 'f9-doubao')
  }
  return process.env.DSH_VOICE_FREE_METASO_BIN || join(homedir(), '.local/bin', 'f9-metaso')
}

const engineName = {
  [PROVIDER_DOUBAO]: '豆包',
  [PROVIDER_METASO]: '秘塔',
}

/**
 * 校验插件配置里唯一的一项：主力引擎。
 * 非法的值不静默放行，直接抛中文错——省得用户以为切了其实没切。
 */
function primaryEngine(value) {
  if (value === undefined || value === null) return defaultPrimary
  if (value === PROVIDER_DOUBAO || value === PROVIDER_METASO) return value
  throw new Error(`voice-free: 配置项 primary 只能是 doubao 或 metaso，收到 ${JSON.stringify(value)}`)
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function isAbort(error, signal) {
  if (signal?.aborted) return true
  return error instanceof Error && error.name === 'AbortError'
}

/** 可被 signal 打断的休眠：取消时不必再等满 3 秒。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('语音识别已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('语音识别已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 录音落在系统临时目录下的固定子目录：失败时用户能按日志里的路径找到它。 */
export function recordingDirectory() {
  return join(tmpdir(), 'dsh-voice-free')
}

function stamp(now = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    + `-${pad(now.getMilliseconds(), 3)}`
}

/**
 * 官方注册表在 provider 之前已经用 `validateWave` 卡过 16k/单声道/PCM16，这里只做
 * 「把字节原样落地」这步。写入后再读头确认，避免把非规范 wav 递给 CLI 换回一坨
 * 看不懂的 Python 栈。
 */
async function writeRecording(audio) {
  const directory = recordingDirectory()
  await mkdir(directory, { recursive: true })
  const path = join(directory, `rec-${stamp()}.wav`)
  await writeFile(path, audio)
  return path
}

/** 成功或取消都要抹掉录音；失败路径刻意不删（见 transcribeWith）。 */
async function discard(path, logger) {
  try {
    await rm(path, { force: true })
  } catch (error) {
    logger?.warn?.(`voice-free: 删除临时录音失败（${path}）：${messageOf(error)}`)
  }
}

/**
 * 解析 RIFF 头，拿到 data 段时长。
 * 为什么不写死 44：浏览器/DSH 生成的 wav 可能带 LIST/fact 块，data 段不在 44 字节处，
 * 拿文件长度硬减会算错 audioSeconds（Transcript 里这个数字会显示给用户）。
 */
export function wavSeconds(audio) {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  const ascii = (offset) => String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
  if (audio.byteLength < 44 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') {
    throw new Error('录音不是规范的 wav 文件，没法交给识别引擎')
  }
  let byteRate = 0
  let dataBytes = 0
  let offset = 12
  while (offset + 8 <= audio.byteLength) {
    const id = ascii(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && body + 12 <= audio.byteLength) byteRate = view.getUint32(body + 8, true)
    if (id === 'data') {
      dataBytes = Math.min(size, Math.max(0, audio.byteLength - body))
      break
    }
    offset = body + size + (size % 2)
  }
  if (byteRate <= 0 || dataBytes <= 0) throw new Error('录音 wav 里没有可用的音频数据')
  return dataBytes / byteRate
}

/** CLI 会把日志混进 stdout 的情形兜一层：先整体 JSON.parse，再退到最后一个 {...} 块。 */
export function parseCliJson(stdout) {
  const text = stdout.trim()
  if (text === '') throw new Error('识别引擎没有输出任何内容')
  const candidates = [text]
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  let withoutKeys
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') {
        // 认「有 ok / text 的那一块」：CLI 有时会先打一行诊断 JSON 再打结果。
        if ('ok' in parsed || 'text' in parsed) return parsed
        withoutKeys ??= parsed
      }
    } catch {
      // 换下一个候选
    }
  }
  if (withoutKeys !== undefined) return withoutKeys
  throw new Error('识别引擎的输出不是 JSON，没法取 text')
}

/**
 * 跑一次 CLI。`--transcribe` 只管识别、`--no-inject` 保证绝不上屏——两个都必须在，
 * 否则 CLI 会按「录音并打字」的老路径走，把文字甩进用户当前窗口。
 */
function runEngine(engineId, wavPath, signal) {
  return new Promise((resolve, reject) => {
    const bin = binOf(engineId)
    const label = engineName[engineId] ?? engineId
    let child
    try {
      child = spawn(bin, ['--transcribe', wavPath, '--no-inject'], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new Error(`无法启动 ${label} 识别命令（${bin}）：${messageOf(error)}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle(value)
    }
    const onAbort = () => {
      child.kill('SIGTERM')
      finish(reject, signal?.reason instanceof Error ? signal.reason : new Error('语音识别已取消'))
    }
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(reject, new Error(`${label} 识别超过 ${Math.round(ATTEMPT_TIMEOUT_MS / 1000)} 秒没返回`))
    }, ATTEMPT_TIMEOUT_MS)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      finish(reject, new Error(`无法启动 ${label} 识别命令（${bin}）：${messageOf(error)}`))
    })
    child.on('close', (code) => {
      if (settled) return
      finish(resolve, { code: code ?? 0, stdout, stderr })
    })
  })
}

/**
 * 单引擎识别：失败等 3 秒再来，最多 3 次重试。
 * 空 text 算「这次没听到话」而不是失败——换引擎也不会凭空多出字来，交给 UI 显示没听清。
 * 返回的是这一成功尝试自己的耗时，重试等待不算进 inferenceSeconds。
 */
async function recogniseOnce(engineId, wavPath, signal, logger) {
  const label = engineName[engineId] ?? engineId
  const attempts = retries() + 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('语音识别已取消')
    const attemptStarted = Date.now()
    try {
      const { code, stdout, stderr } = await runEngine(engineId, wavPath, signal)
      const json = parseCliJson(stdout)
      if (json.ok === false) {
        throw new Error(typeof json.error === 'string' && json.error !== '' ? json.error : `退出码 ${code}`)
      }
      const text = typeof json.text === 'string' ? json.text.trim() : ''
      if (text === '' && stderr.trim() !== '') logger?.info?.(`voice-free: ${label} 未识别到语音`)
      return { text, elapsedMs: Date.now() - attemptStarted }
    } catch (error) {
      if (isAbort(error, signal)) throw error
      logger?.warn?.(`voice-free: ${label} 第 ${attempt}/${attempts} 次识别失败：${messageOf(error)}`)
      if (attempt < attempts) await sleep(retryDelayMs(), signal)
    }
  }
  throw new Error(`${engineName[engineId] ?? engineId} 连续 ${attempts} 次识别失败`)
}

/**
 * 按链条依次尝试引擎。链条长度 1 = 备用引擎（不跨家），长度 2 = 主力引擎（带兜底）。
 * 全链失败时不删录音：网络回来还能手动重跑同一个 wav，这是那句提示的承诺。
 */
async function transcribeWith(chain, input, signal, logger) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('语音识别已取消')
  const audioSeconds = wavSeconds(input.audio)
  const wavPath = await writeRecording(input.audio)
  let firstFailure
  for (const [index, engineId] of chain.entries()) {
    try {
      const { text, elapsedMs } = await recogniseOnce(engineId, wavPath, signal, logger)
      await discard(wavPath, logger)
      return { text, audioSeconds, inferenceSeconds: elapsedMs / 1000 }
    } catch (error) {
      if (isAbort(error, signal)) {
        await discard(wavPath, logger)
        throw error
      }
      firstFailure ??= error
      const next = chain[index + 1]
      logger?.warn?.(`voice-free: ${engineName[engineId] ?? engineId} 用尽重试${next === undefined
        ? '，没有可用备用引擎' : `，改试 ${engineName[next] ?? next}`}`)
    }
  }
  const detail = messageOf(firstFailure)
  logger?.error?.(`voice-free: 全部识别失败，录音保留在 ${wavPath}（${detail}）`)
  const failure = new Error(FAILED_HINT, { cause: firstFailure })
  failure.recordingPath = wavPath
  throw failure
}

function makeProvider(engineId, chain, ctx) {
  return {
    info: {
      id: engineId,
      name: engineName[engineId] ?? engineId,
      // 音频要发到厂商的云接口，不是本机推理。
      location: 'cloud',
      languages: LANGUAGES,
    },
    transcribe: async (input, signal) => await transcribeWith(chain, input, signal, ctx.logger),
  }
}

/**
 * 注册两个 provider。谁当主力谁带兜底链：默认 doubao=[doubao, metaso]、metaso=[metaso]，
 * 把 primary 配成 metaso 则对调。注册用 `ctx.effect` 托管，插件卸载时一起撤掉。
 */
export function apply(ctx, config) {
  const primary = primaryEngine(config?.primary)
  const fallback = primary === PROVIDER_DOUBAO ? PROVIDER_METASO : PROVIDER_DOUBAO
  const chains = {
    [primary]: [primary, fallback],
    [fallback]: [fallback],
  }
  ctx.effect(() => {
    const disposers = [PROVIDER_DOUBAO, PROVIDER_METASO].map((engineId) => ctx.speechToText.register(
      makeProvider(engineId, chains[engineId], ctx)))
    return async () => {
      for (const dispose of disposers) await dispose()
    }
  })
  const delay = retryDelayMs()
  const delayText = delay >= 1000 ? `${Math.round(delay / 100) / 10} 秒` : `${delay} 毫秒`
  ctx.logger?.info?.(`voice-free: 已注册 doubao/metaso；主力 ${primary} 失败后每隔 ${delayText}重试，最多 ${retries()} 次，再切 ${fallback}`)
}
