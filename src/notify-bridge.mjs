/**
 * notify-bridge.mjs
 * Kuma Webhook → mail-app 邮件通知桥
 *
 * 职责：
 *   1. 解析 Kuma Webhook 载荷（心跳状态 UP/DOWN/PENDING/MAINTENANCE）
 *   2. 同监控项同方向限流去重（默认 10 分钟一封），避免故障期间邮件轰炸
 *   3. 调 mail-app CLI 发送邮件；mail-app 不可用时只记录告警日志，不影响监控本体
 *   4. 告警历史：内存环形缓冲（供 GUI 展示）+ alerts.jsonl 落盘（重启可追溯）
 *
 * 说明：mail-app 网关（:7830）只提供 health/mail-config/projects/logs 接口，
 *      没有 HTTP 发送端点，因此发送统一走 CLI 子进程（这也是 chat-app
 *      send_email 工具的既有调用方式）。
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { APP_DATA_DIR, getConfig } from './config-store.mjs'
import { log, error } from './logger.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HISTORY_LIMIT = 50
const ALERTS_FILE = path.join(APP_DATA_DIR, 'alerts.jsonl')
const MAIL_SEND_TIMEOUT = 60_000

// ── mail-app 定位 ─────────────────────────────────────────────────────────────
const PROJECTS_DIR = path.join(
  os.homedir(), 'Library', 'Application Support', 'xingseq', 'projects'
)

let mailAppCliCache  // undefined=未探测, null=找不到, string=cli.mjs 路径（仅缓存自动探测结果）

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

/**
 * 自动探测候选路径：
 *   1. 应用商店安装的 mail-app（projectsDir）
 *   2. 开发仓库：从 cwd 与本文件所在目录逐层向上，找 <dir>/apps/mail-app
 *      以及 <dir>/xingseq/apps/mail-app（外挂子应用与主仓库常为同级目录）
 */
function autoDetectCandidates() {
  const candidates = [path.join(PROJECTS_DIR, 'mail-app', 'src', 'cli.mjs')]
  const roots = new Set([process.cwd(), path.resolve(__dirname, '..')])
  for (const root of roots) {
    let dir = root
    for (let i = 0; i < 6; i++) {
      candidates.push(path.join(dir, 'apps', 'mail-app', 'src', 'cli.mjs'))
      candidates.push(path.join(dir, 'xingseq', 'apps', 'mail-app', 'src', 'cli.mjs'))
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return candidates
}

/** 用户显式指定的路径（不校验存在性） */
function explicitMailAppCli() {
  const fromEnv = String(process.env.MAIL_APP_CLI || '').trim()
  if (fromEnv) return fromEnv
  return String(getConfig().notify?.mailAppCli || '').trim()
}

/**
 * 解析 mail-app 的 cli.mjs。
 * 优先级：MAIL_APP_CLI 环境变量 > 配置 notify.mailAppCli > 自动探测。
 * 显式指定的路径不存在时不静默回退，由 checkChannel 报出具体原因。
 * @returns {Promise<string|null>}
 */
export async function resolveMailAppCli() {
  const explicit = explicitMailAppCli()
  if (explicit) return (await exists(explicit)) ? explicit : null

  if (mailAppCliCache !== undefined) return mailAppCliCache
  for (const c of autoDetectCandidates()) {
    if (await exists(c)) {
      mailAppCliCache = c
      return mailAppCliCache
    }
  }
  mailAppCliCache = null
  return null
}

/** 配置变更后重置探测缓存（GUI 保存 mailAppCli 后立即生效） */
export function resetMailAppCliCache() {
  mailAppCliCache = undefined
}

/** 发送一封邮件；返回 { success, error?, messageId?, skipped? } */
export async function sendEmail({ to, subject, body }) {
  const cli = await resolveMailAppCli()
  if (!cli) {
    const explicit = explicitMailAppCli()
    return {
      success: false,
      skipped: true,
      error: explicit
        ? `配置的 mail-app 路径不存在: ${explicit}`
        : '未找到 mail-app（请在应用商店安装「邮件」子应用，或在通知设置里填写 mail-app 的 cli.mjs 路径）'
    }
  }
  if (!to) {
    return { success: false, skipped: true, error: '未配置收件邮箱（notify.email.to）' }
  }

  const mailAppDir = path.dirname(path.dirname(cli))  // <mail-app>/src/cli.mjs → <mail-app>
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, 'send', '--to', to, '--subject', subject, '--body', body], {
      cwd: mailAppDir,   // 在 mail-app 目录下执行，保证 nodemailer 等依赖可解析
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { p.kill() } catch {}
      resolve({ success: false, error: `mail-app 发送超时（${MAIL_SEND_TIMEOUT / 1000}s）` })
    }, MAIL_SEND_TIMEOUT)

    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', (e) => { clearTimeout(timer); resolve({ success: false, error: `启动 mail-app 失败: ${e.message}` }) })
    p.on('exit', (code) => {
      clearTimeout(timer)
      // CLI 以 JSON 输出结果，解析失败则回退到退出码判断
      try {
        const parsed = JSON.parse(out.trim().split('\n').pop() || '{}')
        if (parsed && typeof parsed.success === 'boolean') {
          return resolve(parsed.success
            ? { success: true, messageId: parsed.messageId }
            : { success: false, error: parsed.error || `mail-app 返回失败 (code=${code})` })
        }
      } catch {}
      resolve(code === 0
        ? { success: true }
        : { success: false, error: firstLine(err) || firstLine(out) || `mail-app 退出码 ${code}` })
    })
  })
}

// ── Webhook 载荷解析 ──────────────────────────────────────────────────────────
/**
 * 解析 Kuma Webhook 通知载荷，兼容字段命名差异与 JSON 字符串形式。
 * @returns {{monitorName:string, monitorId:string|number, url:string, status:string, time:string, msg:string, ping:number|null}}
 */
export function parseKumaPayload(payload = {}) {
  const heartbeat = asObject(payload.heartbeat ?? payload.heartbeatJSON)
  const monitor = asObject(payload.monitorJSON ?? payload.monitor)

  const status = String(heartbeat.status ?? payload.status ?? 'UNKNOWN').toUpperCase()
  const monitorName = monitor.name || payload.monitorName || monitor.hostname || '未知监控项'
  const monitorId = monitor.id ?? payload.monitorID ?? monitorName
  const url = monitor.url || monitor.hostname || payload.url || ''

  return {
    monitorName,
    monitorId,
    url,
    status,
    time: heartbeat.time || payload.time || new Date().toISOString(),
    msg: heartbeat.msg || payload.msg || '',
    ping: parsePing(heartbeat.ping ?? payload.ping)
  }
}

/** Number(null) === 0，必须先排除空值，否则无响应时间会被当成 0ms */
function parsePing(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function asObject(v) {
  if (!v) return {}
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return {} }
}

// ── 限流去重 ──────────────────────────────────────────────────────────────────
// key = `${monitorId}|${status}` → 上次发送时间戳。
// 只在网关进程内存活，重启后重置（可接受：重启后最多补发一封）。
const lastSentAt = new Map()

/**
 * 判断该告警是否应被限流抑制。
 * @param {string|number} monitorId
 * @param {string} status
 * @param {number} rateLimitMinutes 0 表示不限流
 */
export function isRateLimited(monitorId, status, rateLimitMinutes) {
  if (!rateLimitMinutes || rateLimitMinutes <= 0) return false
  const key = `${monitorId}|${status}`
  const prev = lastSentAt.get(key)
  const now = Date.now()
  if (prev && now - prev < rateLimitMinutes * 60_000) return true
  return false
}

function markSent(monitorId, status) {
  lastSentAt.set(`${monitorId}|${status}`, Date.now())
}

/** 状态变化即清除对侧限流记录，保证 DOWN→UP 恢复通知不被抑制 */
function clearCounterpart(monitorId, status) {
  const counterpart = status === 'DOWN' ? 'UP' : 'DOWN'
  lastSentAt.delete(`${monitorId}|${counterpart}`)
}

// ── 告警历史 ──────────────────────────────────────────────────────────────────
const history = []

/** 最近告警（最新在前） */
export function getHistory(limit = HISTORY_LIMIT) {
  return history.slice(0, limit)
}

/** 启动时从 alerts.jsonl 尾部恢复历史（最多 50 条） */
export async function loadHistory() {
  try {
    const raw = await fs.readFile(ALERTS_FILE, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).slice(-HISTORY_LIMIT)
    history.length = 0
    for (const line of lines) {
      try { history.unshift(JSON.parse(line)) } catch {}
    }
  } catch {}
}

async function recordHistory(entry) {
  history.unshift(entry)
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT
  try {
    await fs.mkdir(APP_DATA_DIR, { recursive: true })
    await fs.appendFile(ALERTS_FILE, JSON.stringify(entry) + '\n')
  } catch (err) {
    error(`告警落盘失败: ${err.message}`)
  }
}

// ── 邮件文案 ──────────────────────────────────────────────────────────────────
function buildEmail(info) {
  const isDown = info.status === 'DOWN'
  const icon = isDown ? '🔴' : info.status === 'UP' ? '🟢' : '🟡'
  const title = isDown ? '站点异常告警' : info.status === 'UP' ? '站点已恢复' : `站点状态：${info.status}`
  const subject = `[站点监控] ${icon} ${info.monitorName} ${title}`

  const lines = [
    `${title}`,
    '',
    `监控项：${info.monitorName}`,
    `状态：${info.status}`,
    info.url ? `地址：${info.url}` : null,
    `时间：${formatTime(info.time)}`,
    info.ping != null ? `响应：${info.ping} ms` : null,
    info.msg ? `详情：${info.msg}` : null,
    '',
    '—— 由 XingSeq 站点监控（Uptime Kuma）自动发送'
  ].filter(Boolean)

  return { subject, body: lines.join('\n') }
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────────────
/**
 * 处理一次 Kuma Webhook 回调。
 * 只有 DOWN / UP 会发邮件；PENDING、MAINTENANCE 仅记录历史（避免噪音）。
 * @param {object} payload 原始 JSON 载荷
 * @returns {Promise<{received:true, notified:boolean, suppressed?:boolean, error?:string, info:object}>}
 */
export async function handleWebhook(payload) {
  const info = parseKumaPayload(payload)
  const cfg = getConfig()
  const notifyEnabled = cfg.notify?.enabled !== false
  const to = String(cfg.notify?.email?.to || '').trim()
  const rateLimitMinutes = Number(cfg.bridge?.rateLimitMinutes ?? 10)

  const entry = {
    at: new Date().toISOString(),
    monitorName: info.monitorName,
    url: info.url,
    status: info.status,
    msg: info.msg,
    ping: info.ping,
    notified: false,
    suppressed: false,
    error: ''
  }

  const shouldNotify = notifyEnabled && (info.status === 'DOWN' || info.status === 'UP')
  if (!shouldNotify) {
    await recordHistory(entry)
    return { received: true, notified: false, info }
  }

  if (isRateLimited(info.monitorId, info.status, rateLimitMinutes)) {
    entry.suppressed = true
    await recordHistory(entry)
    log(`限流抑制: ${info.monitorName} ${info.status}（${rateLimitMinutes} 分钟内已发过）`)
    return { received: true, notified: false, suppressed: true, info }
  }

  const { subject, body } = buildEmail(info)
  const result = await sendEmail({ to, subject, body })

  if (result.success) {
    // 发送成功才记限流时间戳，失败时保留下次重试机会
    markSent(info.monitorId, info.status)
    clearCounterpart(info.monitorId, info.status)
    entry.notified = true
    log(`告警邮件已发送: ${subject}`)
  } else {
    entry.error = result.error || '发送失败'
    if (result.skipped) entry.suppressed = true
    error(`告警邮件发送失败: ${entry.error}`)
  }

  await recordHistory(entry)
  return { received: true, notified: entry.notified, suppressed: entry.suppressed, error: entry.error || undefined, info }
}

/** 发送测试邮件（GUI「测试通知」按钮） */
export async function sendTestEmail(toOverride) {
  const cfg = getConfig()
  const to = String(toOverride || cfg.notify?.email?.to || '').trim()
  const result = await sendEmail({
    to,
    subject: '[站点监控] 测试通知',
    body: [
      '这是一封来自 XingSeq 站点监控的测试邮件。',
      '',
      `发送时间：${formatTime(new Date().toISOString())}`,
      `Webhook 地址：http://host.docker.internal:${Number(process.env.SITE_MONITOR_PORT || 3005)}/api/webhook/kuma`,
      '',
      '收到本邮件说明 mail-app 邮件通道配置正确。'
    ].join('\n')
  })
  await recordHistory({
    at: new Date().toISOString(),
    monitorName: '测试通知',
    url: '',
    status: 'TEST',
    msg: '',
    ping: null,
    notified: !!result.success,
    suppressed: false,
    error: result.error || ''
  })
  return result
}

/** 通知通道可用性自检（供 GUI 状态区展示） */
export async function checkChannel() {
  const cli = await resolveMailAppCli()
  const explicit = explicitMailAppCli()
  const cfg = getConfig()
  const to = String(cfg.notify?.email?.to || '').trim()
  const enabled = cfg.notify?.enabled !== false

  let issue = ''
  if (!cli) {
    issue = explicit
      ? `指定的 mail-app 路径不存在：${explicit}`
      : '未找到 mail-app，告警邮件无法发送（监控与 Kuma 面板不受影响）'
  } else if (!to) {
    issue = '未配置收件邮箱'
  } else if (!enabled) {
    issue = '邮件通知已关闭'
  }

  return {
    mailAppFound: !!cli,
    mailAppCli: cli || '',
    mailAppConfigured: explicit,
    recipient: to,
    recipientSet: !!to,
    enabled,
    ready: !!cli && !!to && enabled,
    issue
  }
}

function firstLine(text = '') {
  return String(text).split('\n').map(s => s.trim()).filter(Boolean)[0] || ''
}
