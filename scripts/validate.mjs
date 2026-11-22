#!/usr/bin/env node
/**
 * 仓库自检：零依赖，纯 node 运行（node scripts/validate.mjs，或 node scripts/validate.mjs --strict）。
 *
 * 检查的是这个仓库自己的契约，不是 DSH 安装本身：
 *   - package.json：ESM、MIT、零运行时依赖、描述里点明 doubao / metaso 两个后端；
 *   - cordis.patch.yml：只保留语音输入必需的四行，且不得出现 SenseVoice 本地模型行；
 *   - .gitignore：录音中间产物、F9 状态目录、账号 json 必须被忽略；
 *   - LICENSE：MIT 正文；
 *   - host.mjs：存在时过 node --check，并检查插件导出约定。
 *
 * 骨架阶段 host.mjs 还没写，缺失只记 PENDING；加 --strict（发版前/CI 用）时 PENDING 也算失败。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const STRICT = process.argv.includes('--strict')

/**
 * 本插件注册的 provider.info.id（主机半里一个引擎一个）。`defaultProvider` 必须是其中之一，
 * 否则 speech-to-text 加载时会因为「默认 provider 未注册」直接 throw。
 */
const PROVIDER_IDS = ['doubao', 'metaso']
/** 补丁里允许出现的行名；多一行就意味着顺手塞了别的东西。 */
const ALLOWED_ROWS = new Set([
  '@deepseek-ai/dsh-experimental-speech-to-text',
  './host.mjs',
  '@deepseek-ai/dsh-experimental-api-speech-to-text',
  '@deepseek-ai/dsh-experimental-client-ui-voice-input',
])

const errors = []
const warnings = []
const pending = []
const fail = message => errors.push(message)
const warn = message => warnings.push(message)
const defer = message => pending.push(message)
const path = file => join(ROOT, file)
const has = file => existsSync(path(file))
const read = file => readFileSync(path(file), 'utf8')
const text = (value, pattern) => typeof value === 'string' && pattern.test(value)

// ---------------------------------------------------------------- package.json
if (!has('package.json')) {
  fail('package.json: 缺失')
} else {
  let pkg
  try {
    pkg = JSON.parse(read('package.json'))
  } catch (error) {
    fail(`package.json: 不是合法 JSON（${error.message}）`)
  }
  if (pkg) {
    if (!text(pkg.name, /^[a-z0-9][a-z0-9._-]*$/)) fail('package.json: name 必须是合法的 npm 包名')
    if (!text(pkg.version, /^\d+\.\d+\.\d+/)) fail('package.json: version 必须是 semver')
    if (pkg.license !== 'MIT') fail('package.json: license 必须是 MIT')
    if (pkg.type !== 'module') fail('package.json: type 必须是 module')
    if (!text(pkg.description, /doubao/i)) fail('package.json: description 必须写明 doubao 后端')
    if (!text(pkg.description, /metaso/i)) fail('package.json: description 必须写明 metaso 后端')
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const value = pkg[field]
      if (value && Object.keys(value).length > 0) fail(`package.json: ${field} 必须为空（零依赖，git 安装免构建）`)
    }
    if (typeof pkg.main !== 'string') fail('package.json: main 必须指向宿主半')
    if (pkg.exports?.['.'] !== pkg.main) fail('package.json: exports["."] 必须等于 main')
    if (pkg.exports?.['./package.json'] !== './package.json') fail('package.json: exports["./package.json"] 必须保留给解析器')
    if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package.json: dsh.bundle.patch 必须是 ./cordis.patch.yml')
    if (typeof pkg.main === 'string' && !has(pkg.main)) defer(`package.json: main 指向的 ${pkg.main} 尚未创建（provider 实现属后续步骤）`)
  }
}

// ------------------------------------------------------------- cordis.patch.yml
if (!has('cordis.patch.yml')) {
  fail('cordis.patch.yml: 缺失')
} else {
  const patch = read('cordis.patch.yml')
  if (!/^-\s*insert:\s*$/m.test(patch)) fail('cordis.patch.yml: 顶层必须是单个 - insert: 列表')

  // 只认「- id:」开头、紧随其后的同级 name:，缩进比 id 深一层的才属于该行。
  const rows = []
  let open = null
  for (const line of patch.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const idMatch = /^-\s*id:\s*(.+)$/.exec(trimmed)
    if (idMatch) {
      open = { id: idMatch[1].trim(), name: undefined, indent }
      rows.push(open)
      continue
    }
    const nameMatch = /^name:\s*(.+)$/.exec(trimmed)
    if (nameMatch && open && indent > open.indent && open.name === undefined) {
      open.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '')
      continue
    }
    if (open && indent <= open.indent) open = null
  }

  if (rows.length === 0) fail('cordis.patch.yml: insert 列表里解析不到任何行')
  for (const row of rows) {
    if (!row.name) {
      fail(`cordis.patch.yml: 行 ${row.id} 缺少 name`)
      continue
    }
    if (!ALLOWED_ROWS.has(row.name)) fail(`cordis.patch.yml: 多余的行 ${row.id} → ${row.name}（语音输入只需要四行）`)
    if (/sensevoice/i.test(row.name)) fail(`cordis.patch.yml: 不得包含 SenseVoice 本地模型行（${row.name}）`)
    if (row.name.startsWith('./') && !has(row.name)) defer(`cordis.patch.yml: 本地行 ${row.name} 尚未创建（provider 实现属后续步骤）`)
  }

  const byId = id => rows.find(row => row.id === id)
  const service = byId('speech-to-text')
  if (!service) fail('cordis.patch.yml: 缺少 speech-to-text 服务行')
  else if (service.name !== '@deepseek-ai/dsh-experimental-speech-to-text') fail('cordis.patch.yml: speech-to-text 行必须挂官方语音服务包')

  if (!rows.some(row => row.name === './host.mjs')) fail('cordis.patch.yml: 缺少本插件宿主半（./host.mjs）')
  if (!rows.some(row => row.name === '@deepseek-ai/dsh-experimental-api-speech-to-text')) fail('cordis.patch.yml: 缺少 api-speech-to-text 远程桥行')
  if (!rows.some(row => row.name === '@deepseek-ai/dsh-experimental-client-ui-voice-input')) fail('cordis.patch.yml: 缺少 ui-voice-input 麦克风 UI 行')

  const defaultProvider = /defaultProvider:\s*['"]?([A-Za-z0-9._-]+)['"]?/.exec(patch)
  if (!defaultProvider) fail('cordis.patch.yml: speech-to-text 必须显式写 defaultProvider')
  else if (!PROVIDER_IDS.includes(defaultProvider[1])) {
    fail(`cordis.patch.yml: defaultProvider 必须是 ${PROVIDER_IDS.join(' / ')} 之一，实际是 ${defaultProvider[1]}`)
  }

  // 兜底链的头必须等于界面默认值：否则下拉框里选中的「主力」和真正带兜底链的引擎不是同一家。
  const primary = /^\s*primary:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/m.exec(patch)
  if (primary && defaultProvider && primary[1] !== defaultProvider[1]) {
    fail(`cordis.patch.yml: primary(${primary[1]}) 与 defaultProvider(${defaultProvider[1]}) 不一致`)
  }

  // SenseVoice 那套组合的特征：本地模型后端行、模型目录配置、下载源。
  if (/dataRoot\s*:/.test(patch)) fail('cordis.patch.yml: 不得出现 SenseVoice 的 dataRoot 模型目录配置')
  if (/^\s*-\s*id:\s*speech-to-text-sensevoice\s*$/m.test(patch)) fail('cordis.patch.yml: 不得出现 speech-to-text-sensevoice 行')
}

// -------------------------------------------------------------------- .gitignore
if (!has('.gitignore')) {
  fail('.gitignore: 缺失')
} else {
  const lines = read('.gitignore')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  for (const required of ['node_modules/', '*.wav', '*.pcm', '.f9-state/']) {
    if (!lines.includes(required)) fail(`.gitignore: 缺少规则 ${required}`)
  }
  if (!lines.some(line => /accounts?\.json|\*account\*\.json/i.test(line))) {
    fail('.gitignore: 缺少账号 json 规则（accounts.json / *account*.json）')
  }
}

// ----------------------------------------------------------------------- LICENSE
if (!has('LICENSE')) {
  fail('LICENSE: 缺失')
} else {
  const license = read('LICENSE')
  if (!license.startsWith('MIT License')) fail('LICENSE: 必须以 "MIT License" 开头')
  if (!license.includes('Permission is hereby granted, free of charge')) fail('LICENSE: 缺少 MIT 授权段')
  if (!license.includes('THE SOFTWARE IS PROVIDED "AS IS"')) fail('LICENSE: 缺少 MIT 免责段')
}

// ------------------------------------------------------------------------ host.mjs
const pkgMain = has('package.json') ? (() => { try { return JSON.parse(read('package.json')).main } catch { return undefined } })() : undefined
if (typeof pkgMain === 'string' && has(pkgMain)) {
  try {
    execFileSync(process.execPath, ['--check', path(pkgMain)], { stdio: 'pipe' })
  } catch (error) {
    fail(`${pkgMain}: 语法检查失败（${String(error.stderr ?? error.message).trim().split('\n')[0]}）`)
  }
  const host = read(pkgMain)
  if (!/export\s+const\s+name\s*=/.test(host)) fail(`${pkgMain}: 必须导出裸名 name（cordis 插件约定）`)
  if (!/export\s+const\s+inject\s*=\s*\[[^\]]*speechToText/.test(host)) fail(`${pkgMain}: inject 必须包含 speechToText`)
  for (const id of PROVIDER_IDS) {
    if (!host.includes(`'${id}'`) && !host.includes(`"${id}"`)) {
      warn(`${pkgMain}: 没出现 provider id 字面量 ${id}，确认它真的注册了这个引擎`)
    }
  }
}

// ------------------------------------------------------------------------- 汇总
for (const message of warnings) console.warn(`  ~ ${message}`)
for (const message of pending) console.warn(`  · PENDING ${message}`)

if (errors.length > 0) {
  console.error('validate: FAIL')
  for (const message of errors) console.error(`  - ${message}`)
  process.exit(1)
}
if (STRICT && pending.length > 0) {
  console.error(`validate: FAIL (--strict) — ${pending.length} 项未完成`)
  for (const message of pending) console.error(`  - ${message}`)
  process.exit(1)
}
console.log(`validate: OK${pending.length > 0 ? `（${pending.length} 项 PENDING，加 --strict 视为失败）` : ''}`)
