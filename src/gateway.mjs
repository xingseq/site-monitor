/**
 * gateway.mjs
 * site-monitor HTTP 网关 — 状态 API + Kuma Webhook 接收 + 管理前端静态托管
 *
 * 端口：SITE_MONITOR_PORT 环境变量（electron-shell 按 manifest portEnv 注入），默认 3005
 *
 * 启动时序（关键）：
 *   1. 立即 listen 并提供 /api/health —— electron-shell 的 waitForHealth 只有 15s，
 *      Docker 拉起 + 镜像 pull 可能耗时数分钟，绝不能阻塞在健康检查之前
 *   2. listen 成功后异步执行 Kuma 引导，进度写入日志缓冲，前端轮询 /api/status 展示
 *   3. 引导失败不回退网关：进入 degraded 状态，管理前端给出可操作的提示
 */

import http from 'node:http'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as store from './config-store.mjs'
import * as docker from './docker.mjs'
import * as bridge from './notify-bridge.mjs'
import { log, getLogs } from './logger.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIST = path.resolve(__dirname, '..', 'web', 'dist')
const PORT = parseInt(process.env.SITE_MONITOR_PORT || '3005', 10)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
}

const STARTED_AT = Date.now()

// ── 运行态 ────────────────────────────────────────────────────────────────────
/**
 * phase:
 *   starting  — 引导进行中（拉 Docker / pull 镜像 / 建容器）
 *   ready     — Kuma Web 可访问
 *   degraded  — 引导失败（Docker 未安装/未启动、镜像拉取失败等），网关本身仍可用
 */
const state = {
  phase: 'starting',
  reason: '',
  bootstrapping: false,
  lastBootstrapAt: null,
  lastAction: ''
}

// 日志统一走 logger.mjs：config-store / notify-bridge 内部的记录也要出现在
// GUI「网关日志」里，否则会出现「控制台有、面板没有」的日志缺失错觉。

/** 影响容器形态的配置指纹，变更才需重建 */
function kumaKeyOf(cfg) {
  return [cfg.kuma.image, cfg.kuma.hostPort, cfg.kuma.containerName, cfg.kuma.dataDir].join('|')
}

let lastKumaKey = ''
// PUT /api/config 已自行处理引导时，抑制文件监听重复触发一次 bootstrap
let suppressWatchTrigger = false

// ── 引导 ──────────────────────────────────────────────────────────────────────
/**
 * 执行 Kuma 引导。并发保护：同时只允许一个引导流程。
 * @param {{force?:boolean}} [opts] force=true 时即使 ready 也重新检查容器状态
 */
async function bootstrap({ force = false } = {}) {
  if (state.bootstrapping) {
    log('引导已在进行中，跳过本次触发')
    return { ok: false, skipped: true }
  }

  const cfg = await store.loadConfig({ force: true })
  state.bootstrapping = true
  state.phase = 'starting'
  state.reason = ''

  try {
    log(`开始引导：镜像 ${cfg.kuma.image}，端口 ${cfg.kuma.hostPort}，数据目录 ${cfg.kuma.dataDir}`)
    const result = await docker.bootstrapKuma(cfg.kuma, (m) => log(m))
    state.lastBootstrapAt = new Date().toISOString()

    if (result.ok) {
      state.phase = 'ready'
      state.reason = ''
      state.lastAction = result.action || ''
      log(`引导完成（Docker ${result.daemonVersion || ''}，容器动作: ${result.action || 'noop'}）`)
      const channel = await bridge.checkChannel()
      if (!channel.ready) {
        log(channel.mailAppFound
          ? `通知通道未就绪：${channel.recipientSet ? '' : '未配置收件邮箱，'}请在管理面板填写 notify.email.to`
          : '通知通道未就绪：未找到 mail-app，告警邮件将无法发送（监控本体不受影响）', 'error')
      }
      return { ok: true, ...result }
    }

    state.phase = 'degraded'
    state.reason = result.reason || '引导失败'
    state.lastAction = ''
    log(`引导失败（阶段 ${result.stage}）：${state.reason}`, 'error')
    return { ok: false, ...result }
  } catch (err) {
    state.phase = 'degraded'
    state.reason = err.message
    log(`引导异常：${err.message}`, 'error')
    return { ok: false, reason: err.message }
  } finally {
    state.bootstrapping = false
    if (!force && state.phase === 'ready') {
      // 引导成功后再确认一次实际可达性（容器可能几秒后崩溃）
      const cfgNow = store.getConfig()
      const reachable = await docker.probeKuma(cfgNow.kuma.hostPort, 2000)
      if (!reachable) {
        state.phase = 'degraded'
        state.reason = `Kuma 曾就绪但当前不可访问（端口 ${cfgNow.kuma.hostPort}）`
        log(state.reason, 'error')
      }
    }
  }
}

/** 配置热重载回调（手改 config.json 等外部变更） */
function onConfigChanged(next) {
  if (suppressWatchTrigger) {
    suppressWatchTrigger = false
    return
  }
  // mailAppCli 可能被改过，重置探测缓存使新值立即生效
  bridge.resetMailAppCliCache()

  const key = kumaKeyOf(next)
  if (key === lastKumaKey) {
    log('配置已热重载（通知相关字段，无需重建容器）')
    return
  }
  lastKumaKey = key
  log(`配置已热重载：镜像 ${next.kuma.image}，端口 ${next.kuma.hostPort}，重建容器`)
  bootstrap().catch(err => log(`配置变更后引导失败: ${err.message}`, 'error'))
}

// ── HTTP 工具 ─────────────────────────────────────────────────────────────────
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', c => {
      raw += c
      if (raw.length > 1_000_000) { req.destroy(); reject(new Error('body 过大')) }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('无效 JSON')) }
    })
    req.on('error', reject)
  })
}

/** 当前 Kuma Webhook 地址（容器内经 host.docker.internal 访问宿主网关） */
function webhookUrl() {
  return `http://host.docker.internal:${PORT}/api/webhook/kuma`
}

// ── API 路由 ──────────────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  const pathname = url.pathname
  const method = req.method

  // 健康检查：网关自身活着就返回 ok，kuma 字段反映监控本体状态
  if (method === 'GET' && pathname === '/api/health') {
    const cfg = store.getConfig()
    const reachable = state.phase === 'ready' || await docker.probeKuma(cfg.kuma.hostPort, 1500)
    return sendJson(res, 200, {
      ok: true,
      mode: 'live',
      phase: state.phase,
      kuma: reachable ? 'up' : (state.phase === 'starting' ? 'starting' : 'down'),
      reason: state.reason || undefined
    })
  }

  // 汇总状态（管理前端主轮询接口）
  if (method === 'GET' && pathname === '/api/status') {
    const cfg = await store.loadConfig()
    const [dockerStatus, channel] = await Promise.all([
      docker.collectStatus(cfg.kuma).catch(err => ({ error: err.message })),
      bridge.checkChannel().catch(() => ({}))
    ])
    return sendJson(res, 200, {
      phase: state.phase,
      reason: state.reason,
      bootstrapping: state.bootstrapping,
      lastBootstrapAt: state.lastBootstrapAt,
      lastAction: state.lastAction,
      startedAt: new Date(STARTED_AT).toISOString(),
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      gatewayPort: PORT,
      webhookUrl: webhookUrl(),
      configPath: store.configFilePath(),
      config: cfg,
      docker: dockerStatus,
      notify: channel
    })
  }

  // 配置读写
  if (pathname === '/api/config') {
    if (method === 'GET') {
      return sendJson(res, 200, { config: await store.loadConfig(), path: store.configFilePath() })
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readBody(req)
      const incoming = body.config || body
      // 允许提交部分字段：与当前配置深合并后再校验，避免把补丁当完整配置报错
      const current = await store.loadConfig()
      const merged = {
        kuma: { ...current.kuma, ...(incoming.kuma || {}) },
        notify: {
          ...current.notify,
          ...(incoming.notify || {}),
          email: { ...current.notify.email, ...(incoming.notify?.email || {}) }
        },
        bridge: { ...current.bridge, ...(incoming.bridge || {}) }
      }
      // hostPort 可能被提交为字符串（表单输入），统一转数字
      if (merged.kuma.hostPort !== undefined) merged.kuma.hostPort = Number(merged.kuma.hostPort)
      if (merged.bridge.rateLimitMinutes !== undefined) merged.bridge.rateLimitMinutes = Number(merged.bridge.rateLimitMinutes)

      const errors = store.validateConfig(merged)
      if (errors.length) return sendJson(res, 400, { success: false, errors })

      const before = store.getConfig()
      suppressWatchTrigger = true
      const saved = await store.saveConfig(merged)
      bridge.resetMailAppCliCache()
      const needRebootstrap = kumaKeyOf(before) !== kumaKeyOf(saved)
      lastKumaKey = kumaKeyOf(saved)

      log(`配置已保存${needRebootstrap ? '（Kuma 相关字段变更，将重建容器）' : ''}`)
      if (needRebootstrap) bootstrap({ force: true }).catch(err => log(`重建容器失败: ${err.message}`, 'error'))
      return sendJson(res, 200, { success: true, config: saved, rebootstrap: needRebootstrap })
    }
  }

  // 手动触发引导 / Kuma 容器操作
  if (method === 'POST' && pathname === '/api/bootstrap') {
    if (state.bootstrapping) return sendJson(res, 200, { success: true, alreadyRunning: true, phase: state.phase })
    bootstrap({ force: true }).catch(err => log(`手动引导失败: ${err.message}`, 'error'))
    return sendJson(res, 202, { success: true, started: true, phase: state.phase })
  }

  if (method === 'POST' && pathname.startsWith('/api/kuma/')) {
    const cfg = await store.loadConfig()
    const action = pathname.split('/').pop()
    let result
    if (action === 'stop') {
      result = await docker.stopContainer(cfg.kuma.containerName)
      log(result.ok ? `已停止 Kuma 容器（监控暂停，数据保留）` : `停止容器失败: ${result.stderr}`, result.ok ? 'info' : 'error')
    } else if (action === 'restart') {
      result = await docker.restartContainer(cfg.kuma.containerName)
      log(result.ok ? '已重启 Kuma 容器' : `重启容器失败: ${result.stderr}`, result.ok ? 'info' : 'error')
    } else if (action === 'logs') {
      const text = await docker.containerLogs(cfg.kuma.containerName, Number(url.searchParams.get('tail') || 200))
      return sendJson(res, 200, { success: true, logs: text })
    } else {
      return sendJson(res, 404, { success: false, error: `未知操作: ${action}` })
    }
    if (!result?.ok) return sendJson(res, 500, { success: false, error: (result?.stderr || '').trim() })
    return sendJson(res, 200, { success: true, action })
  }

  // Kuma 告警回调
  if (pathname === '/api/webhook/kuma') {
    if (method !== 'POST') return sendJson(res, 405, { error: '仅支持 POST' })
    let payload
    try {
      payload = await readBody(req)
    } catch (err) {
      return sendJson(res, 400, { success: false, error: err.message })
    }
    log(`收到 Kuma 告警回调: ${JSON.stringify(payload).slice(0, 300)}`)
    try {
      const result = await bridge.handleWebhook(payload)
      // 始终返回 200：即使邮件发送失败，也不让 Kuma 反复重试同一告警
      return sendJson(res, 200, { success: true, ...result })
    } catch (err) {
      log(`告警处理异常: ${err.message}`, 'error')
      return sendJson(res, 200, { success: false, error: err.message })
    }
  }

  // 告警历史
  if (method === 'GET' && pathname === '/api/alerts') {
    return sendJson(res, 200, {
      alerts: bridge.getHistory(Number(url.searchParams.get('limit') || 50))
    })
  }

  // 测试通知
  if (method === 'POST' && pathname === '/api/notify/test') {
    const body = await readBody(req).catch(() => ({}))
    const result = await bridge.sendTestEmail(body.to)
    if (!result.success) return sendJson(res, 200, { success: false, error: result.error })
    return sendJson(res, 200, { success: true, messageId: result.messageId })
  }

  // 日志（网关 + 容器）
  if (method === 'GET' && pathname === '/api/logs') {
    const tail = Number(url.searchParams.get('tail') || 100)
    const cfg = store.getConfig()
    const withContainer = url.searchParams.get('container') !== '0'
    const containerLogs = withContainer
      ? await docker.containerLogs(cfg.kuma.containerName, tail).catch(() => '')
      : ''
    return sendJson(res, 200, {
      gateway: getLogs(tail),
      container: containerLogs
    })
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: `未知接口: ${method} ${pathname}` })
  }
}

// ── 静态文件（管理前端） ──────────────────────────────────────────────────────
async function handleStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''))
  // 防目录穿越
  const filePath = path.resolve(WEB_DIST, rel)
  if (!filePath.startsWith(WEB_DIST)) {
    res.writeHead(403); return res.end('Forbidden')
  }

  try {
    const stat = await fs.stat(filePath)
    if (stat.isDirectory()) throw Object.assign(new Error('is dir'), { code: 'EISDIR' })
    const ext = path.extname(filePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    res.end(await fs.readFile(filePath))
  } catch {
    // SPA fallback：非文件路径统一回 index.html
    try {
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      res.end(await fs.readFile(path.join(WEB_DIST, 'index.html')))
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('site-monitor 管理前端未构建。请运行: npm run build:web\n（Kuma 面板不受影响，可直接访问 http://127.0.0.1:3004/）')
    }
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────────────
export async function startGateway() {
  const initialCfg = await store.loadConfig()
  lastKumaKey = kumaKeyOf(initialCfg)
  await bridge.loadHistory()
  await store.watchConfig()
  store.onConfigChange(onConfigChanged)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url)
      } else {
        await handleStatic(res, url.pathname)
      }
    } catch (err) {
      log(`请求处理异常: ${err.message}`, 'error')
      if (!res.headersSent) sendJson(res, 500, { error: err.message })
    }
  })

  // 端口被占用时给出明确提示（可能是上一次网关未被回收）
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`端口 ${PORT} 已被占用：可能已有 site-monitor 网关在运行。`, 'error')
      process.exit(1)
    }
    log(`HTTP 服务错误: ${err.message}`, 'error')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  log(`网关已就绪: http://127.0.0.1:${PORT}/  (Webhook: ${webhookUrl()})`)

  // 异步引导，不阻塞健康检查
  bootstrap().catch(err => log(`引导失败: ${err.message}`, 'error'))

  // 定期复核 Kuma 可达性：容器被外部停掉时把状态如实反映为 degraded
  const ticker = setInterval(async () => {
    if (state.bootstrapping) return
    const cfg = store.getConfig()
    const reachable = await docker.probeKuma(cfg.kuma.hostPort, 2000)
    if (reachable && state.phase !== 'ready') {
      state.phase = 'ready'
      state.reason = ''
      log('Kuma 恢复可访问')
    } else if (!reachable && state.phase === 'ready') {
      state.phase = 'degraded'
      state.reason = `Kuma 不可访问（端口 ${cfg.kuma.hostPort}），可能被外部停止或 Docker 未运行`
      log(state.reason, 'error')
    }
  }, 30_000)
  ticker.unref?.()

  const shutdown = () => {
    log('网关退出（Kuma 容器按设计保持运行，监控不中断）')
    store.stopWatchConfig()
    clearInterval(ticker)
    try { server.close() } catch {}
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  return server
}
