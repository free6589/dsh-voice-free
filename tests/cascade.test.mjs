/**
 * host.mjs 的行为自测：用两个假 CLI 顶替 f9-doubao / f9-metaso，真跑一遍
 * 「重试 → 切备选 → 保留录音 / 删临时文件」的全链路。
 *
 * 为什么值得写：验收里最容易骗自己的几条（3 秒间隔、最多 3 次重试、失败时 wav
 * 还在、成功时 wav 没了、CLI 参数带 --transcribe --no-inject）都不是静态读代码
 * 能看准的。假 CLI 只改「命令行里发生什么」，走的是 host.mjs 真正的 spawn 路径。
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  defaultPrimary,
  parseCliJson,
  PROVIDER_DOUBAO,
  PROVIDER_METASO,
  recordingDirectory,
  wavSeconds,
} from '../host.mjs'

const FAILED_HINT = '网络好像有问题，录音已保存，网好了点重试'

/** 16k 单声道 PCM16 的规范 wav（官方 gate 放行的正是这种）。 */
function makeWave(seconds) {
  const samples = Math.round(16000 * seconds)
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)      // PCM
  view.setUint16(22, 1, true)      // mono
  view.setUint32(24, 16000, true)  // sample rate
  view.setUint32(28, 32000, true)  // byte rate
  view.setUint16(32, 2, true)      // block align
  view.setUint16(34, 16, true)     // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples * 2, true)
  return bytes
}

/**
 * 造一个假 CLI：前 failTimes 次回 ok:false（等于「网不通」），之后回一条带 text 的 JSON。
 * 它同时记录「每次收到的完整参数」和「$2 指向的 wav 当时是否存在」。
 */
async function fakeCli(directory, name, { failTimes = 0, text = '', engine = '', sleepSeconds = 0 } = {}) {
  const counter = join(directory, `${name}.count`)
  const argsLog = join(directory, `${name}.args`)
  const waveSeen = join(directory, `${name}.wav-seen`)
  const script = join(directory, name)
  await writeFile(script, `#!/bin/sh
printf '%s\\n' "$1|$2|$3" >> '${argsLog}'
[ -f "$2" ] && printf 'yes' > '${waveSeen}'
n=0
[ -f '${counter}' ] && n=$(cat '${counter}')
n=$((n+1))
printf '%s' "$n" > '${counter}'
${sleepSeconds > 0 ? `sleep ${sleepSeconds}` : ':'}
if [ "$n" -le ${failTimes} ]; then
  printf '{"ok": false, "error": "假的网络故障", "error_kind": "network"}\\n'
  printf 'fake-cli: simulated failure\\n' >&2
  exit 1
fi
printf '{"ok": true, "text": "${text}", "engine": "${engine}", "elapsed": 0.01}\\n'
exit 0
`, 'utf8')
  await chmod(script, 0o755)
  return {
    script,
    calls: async () => {
      if (!existsSync(counter)) return 0
      return Number((await readFile(counter, 'utf8')).trim() || 0)
    },
    args: async () => {
      if (!existsSync(argsLog)) return []
      return (await readFile(argsLog, 'utf8')).split('\n').filter((line) => line !== '')
    },
    waveSeen: async () => existsSync(waveSeen),
  }
}

/** 极简 ctx：只实现 apply() 真正用到的 effect / speechToText.register / logger。 */
function makeContext() {
  const providers = new Map()
  const logs = []
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    speechToText: {
      register(provider) {
        if (providers.has(provider.info.id)) throw new Error(`duplicate ${provider.info.id}`)
        providers.set(provider.info.id, provider)
        return async () => providers.delete(provider.info.id)
      },
    },
    disposers: [],
    effect(fn) {
      this.disposers.push(fn())
    },
  }
  return { ctx, providers, logs }
}

function mount(config) {
  const { ctx, providers, logs } = makeContext()
  apply(ctx, config)
  return { providers, logs, ctx }
}

async function clearRecordings() {
  await rm(recordingDirectory(), { recursive: true, force: true })
}

const results = []
async function scenario(title, run) {
  const started = Date.now()
  await clearRecordings()
  try {
    await run()
    results.push({ title, ok: true, ms: Date.now() - started })
    console.log(`PASS  ${title}  (${Date.now() - started} ms)`)
  } catch (error) {
    results.push({ title, ok: false, ms: Date.now() - started, error })
    console.log(`FAIL  ${title}\n      ${error && error.message}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'voice-free-test-'))

// 1) 主力重试用的是真·3 秒节奏：前两次失败，第三次成功，应恰好 3 次调用、耗时 ≥ 6 秒。
await scenario('doubao 失败两次后成功：3 秒间隔重试、成功即删临时 wav', async () => {
  delete process.env.DSH_VOICE_FREE_RETRY_DELAY_MS
  delete process.env.DSH_VOICE_FREE_RETRIES
  const cli = await fakeCli(root, 'doubao-a', { failTimes: 2, text: '你好世界', engine: 'doubao-ime' })
  process.env.DSH_VOICE_FREE_DOUBAO_BIN = cli.script
  process.env.DSH_VOICE_FREE_METASO_BIN = join(root, 'metaso-unused')
  const { providers } = mount({ primary: 'doubao' })
  const provider = providers.get(PROVIDER_DOUBAO)
  assert.equal(provider.info.id, 'doubao')
  assert.equal(provider.info.location, 'cloud')
  assert.ok(provider.info.languages.includes('auto'))
  assert.equal(provider.preparation, undefined, 'provider 不该带 preparation（不下载模型）')

  const began = Date.now()
  const transcript = await provider.transcribe({ audio: makeWave(1), language: 'auto' }, new AbortController().signal)
  const elapsed = Date.now() - began
  assert.equal(transcript.text, '你好世界')
  assert.ok(Math.abs(transcript.audioSeconds - 1) < 0.01, `audioSeconds 应≈1，实际 ${transcript.audioSeconds}`)
  assert.ok(transcript.inferenceSeconds > 0)
  assert.equal(await cli.calls(), 3, '首次 + 2 次重试')
  assert.ok(elapsed >= 5900, `两次 3 秒间隔应 ≥ 5.9s，实际 ${elapsed}ms`)
  assert.equal(await cli.waveSeen(), true, 'CLI 运行时 wav 必须已落盘')
  const args = await cli.args()
  assert.equal(args.length, 3)
  for (const line of args) {
    const [first, second, third] = line.split('|')
    assert.equal(first, '--transcribe')
    assert.ok(second.endsWith('.wav'), `第二个参数应是 wav 路径，实际 ${second}`)
    assert.equal(third, '--no-inject')
  }
  assert.equal(existsSync(args[0].split('|')[1]), false, '成功后临时 wav 必须删除')
})

// 2) 豆包 4 次全挂 → 自动切秘塔；temp 文件成功后照样删。
await scenario('doubao 用尽 4 次仍失败 → 自动切 metaso 并返回其 text', async () => {
  process.env.DSH_VOICE_FREE_RETRY_DELAY_MS = '20'
  const doubao = await fakeCli(root, 'doubao-b', { failTimes: 99 })
  const metaso = await fakeCli(root, 'metaso-b', { text: '秘塔听出来的字', engine: 'metaso-echo' })
  process.env.DSH_VOICE_FREE_DOUBAO_BIN = doubao.script
  process.env.DSH_VOICE_FREE_METASO_BIN = metaso.script
  const { providers } = mount({ primary: 'doubao' })
  const transcript = await providers.get(PROVIDER_DOUBAO)
    .transcribe({ audio: makeWave(0.5), language: 'auto' }, new AbortController().signal)
  assert.equal(transcript.text, '秘塔听出来的字')
  assert.equal(await doubao.calls(), 4, 'doubao 首次 + 3 次重试')
  assert.equal(await metaso.calls(), 1, '切到秘塔后第一次就成功')
  const wavPath = (await metaso.args())[0].split('|')[1]
  assert.equal(existsSync(wavPath), false, '成功后临时 wav 必须删除')
})

// 3) 两家全挂：保留 wav + 原样中文提示。
await scenario('全失败保留 wav 并抛「网络好像有问题，录音已保存，网好了点重试」', async () => {
  process.env.DSH_VOICE_FREE_RETRY_DELAY_MS = '20'
  const doubao = await fakeCli(root, 'doubao-c', { failTimes: 99 })
  const metaso = await fakeCli(root, 'metaso-c', { failTimes: 99 })
  process.env.DSH_VOICE_FREE_DOUBAO_BIN = doubao.script
  process.env.DSH_VOICE_FREE_METASO_BIN = metaso.script
  const { providers } = mount({ primary: 'doubao' })
  const error = await providers.get(PROVIDER_DOUBAO)
    .transcribe({ audio: makeWave(0.5), language: 'auto' }, new AbortController().signal)
    .then(() => undefined, (failure) => failure)
  assert.ok(error instanceof Error, '应当 reject')
  assert.equal(error.message, FAILED_HINT)
  assert.equal(await doubao.calls(), 4)
  assert.equal(await metaso.calls(), 4, '备用引擎也走自己的 4 次')
  assert.ok(typeof error.recordingPath === 'string' && existsSync(error.recordingPath),
    '失败时录音必须还在，用户才能「网好了点重试」')
  assert.equal(existsSync(error.recordingPath), true)
})

// 4) 取消：识别卡在半路时掐断，临时文件不留在盘上。
await scenario('取消（AbortSignal）时清理临时 wav 并 reject', async () => {
  process.env.DSH_VOICE_FREE_RETRY_DELAY_MS = '20'
  const doubao = await fakeCli(root, 'doubao-d', { sleepSeconds: 5, text: '不该等到我' })
  process.env.DSH_VOICE_FREE_DOUBAO_BIN = doubao.script
  process.env.DSH_VOICE_FREE_METASO_BIN = join(root, 'metaso-unused')
  const { providers } = mount({ primary: 'doubao' })
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error('用户取消')), 150)
  const error = await providers.get(PROVIDER_DOUBAO)
    .transcribe({ audio: makeWave(0.2), language: 'auto' }, controller.signal)
    .then(() => undefined, (failure) => failure)
  assert.ok(error instanceof Error, '应当 reject')
  assert.match(error.message, /取消/)
  const leftovers = existsSync(recordingDirectory()) ? await readdir(recordingDirectory()) : []
  assert.deepEqual(leftovers, [], '取消后不应留下 wav')
})

// 5a) 主力改成秘塔：兜底链跟着换边（metaso 连跪 → 豆包接住）。
await scenario('primary=metaso 时兜底链换边：metaso→doubao', async () => {
  process.env.DSH_VOICE_FREE_RETRY_DELAY_MS = '20'
  const doubao = await fakeCli(root, 'doubao-e', { text: '豆包兜底', engine: 'doubao-ime' })
  const metaso = await fakeCli(root, 'metaso-e', { failTimes: 99 })
  process.env.DSH_VOICE_FREE_DOUBAO_BIN = doubao.script
  process.env.DSH_VOICE_FREE_METASO_BIN = metaso.script
  const { providers } = mount({ primary: 'metaso' })
  const transcript = await providers.get(PROVIDER_METASO)
    .transcribe({ audio: makeWave(0.3), language: 'auto' }, new AbortController().signal)
  assert.equal(transcript.text, '豆包兜底')
  assert.equal(await metaso.calls(), 4, 'metaso 首次 + 3 次重试')
  assert.equal(await doubao.calls(), 1, '兜底只打一次就成')
})

// 5b) 同一配置下 doubao 退回单引擎：失败也不跨到 metaso。
await scenario('primary=metaso 时 doubao 单引擎，失败不跨家', async () => {
  process.env.DSH_VOICE_FREE_RETRY_DELAY_MS = '20'
  const doubao = await fakeCli(root, 'doubao-e2', { failTimes: 99 })
  const metaso = await fakeCli(root, 'metaso-e2', { text: '不该被调用' })
  process.env.DSH_VOICE_FREE_DOUBAO_BIN = doubao.script
  process.env.DSH_VOICE_FREE_METASO_BIN = metaso.script
  const { providers } = mount({ primary: 'metaso' })
  const error = await providers.get(PROVIDER_DOUBAO)
    .transcribe({ audio: makeWave(0.3), language: 'auto' }, new AbortController().signal)
    .then(() => undefined, (failure) => failure)
  assert.equal(error.message, FAILED_HINT, '非主力引擎不跨家，失败即提示')
  assert.equal(await metaso.calls(), 0, '豆包没有备用链，不该去打扰秘塔')
  assert.ok(existsSync(error.recordingPath), '失败录音仍然保留')
})

// 6) 默认主力是豆包；非法 primary 立刻中文拒绝。
await scenario('默认主力 doubao；非法 primary 抛中文错', async () => {
  assert.equal(defaultPrimary, 'doubao')
  const doubao = await fakeCli(root, 'doubao-f', { failTimes: 99 })
  const metaso = await fakeCli(root, 'metaso-f', { text: '默认主力也是豆包', engine: 'metaso-echo' })
  process.env.DSH_VOICE_FREE_DOUBAO_BIN = doubao.script
  process.env.DSH_VOICE_FREE_METASO_BIN = metaso.script
  process.env.DSH_VOICE_FREE_RETRY_DELAY_MS = '20'
  const { providers } = mount({})
  const transcript = await providers.get(PROVIDER_DOUBAO)
    .transcribe({ audio: makeWave(0.3), language: 'auto' }, new AbortController().signal)
  assert.equal(transcript.text, '默认主力也是豆包', '不写 primary 时豆包带兜底链')
  assert.throws(() => mount({ primary: 'sensevoice' }), /primary 只能是 doubao 或 metaso/)
})

// 7) 纯函数：混杂日志的 stdout、非 wav 字节。
await scenario('parseCliJson 容错与 wavSeconds 校验', async () => {
  assert.deepEqual(parseCliJson('log: warming up\n{"ok": true, "text": "嗯"}\n').text, '嗯')
  assert.throws(() => parseCliJson('完全没有 JSON'), /不是 JSON/)
  assert.throws(() => wavSeconds(new Uint8Array(10)), /不是规范的 wav/)
  assert.ok(Math.abs(wavSeconds(makeWave(2)) - 2) < 0.001)
})

await rm(root, { recursive: true, force: true })
await clearRecordings()

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 场景通过`)
if (failed.length > 0) process.exitCode = 1
