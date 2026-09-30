/**
 * docker.mjs
 * Docker 守护进程探测 + Uptime Kuma 容器生命周期管理
 *
 * 全部通过 child_process 直调 docker CLI，零 npm 依赖。
 *
 * 关键约定：
 *   - 宿主端口只绑 127.0.0.1，不对局域网暴露 Kuma
 *   - 数据卷挂载到 config.kuma.dataDir（安装目录之外），子应用更新不丢监控数据
 *   - --restart unless-stopped：容器随 Docker Desktop 自启，关掉控制台不中断监控
 *   - 镜像 tag 变更 = 显式升级：pull 新镜像 → 删旧容器 → 同数据卷重新 run
 */

import { spawn, execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import http from 'node:http'

const DEFAULT_TIMEOUT = 30_000
/** 镜像拉取上限：registry 不可达时 docker pull 可能永久挂住，必须自行超时 */
const PULL_TIMEOUT = 30 * 60_000

// ── docker CLI 定位 ───────────────────────────────────────────────────────────
// 经 LaunchServices（open/双击）启动时 PATH 不含常见安装路径，这里逐个探测。
const DOCKER_CANDIDATES = [
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  '/usr/bin/docker'
]

let dockerBinCache
/** DOCKER_BIN 显式配置但无效时的原因（供状态页展示，便于排障） */
let dockerBinError = ''

async function isExecutable(p) {
  try {
    await fs.access(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 解析可用的 docker 可执行文件路径；找不到返回 null */
export async function resolveDockerBin() {
  if (dockerBinCache !== undefined) return dockerBinCache

  // DOCKER_BIN 显式指定即视为权威来源：无效时直接失败，不静默回退自动探测。
  // 否则用户配错路径仍会得到「docker 可用」的假象，排障无从下手。
  const fromPath = String(process.env.DOCKER_BIN || '').trim()
  if (fromPath) {
    if (await isExecutable(fromPath)) {
      dockerBinCache = fromPath
    } else {
      dockerBinCache = null
      dockerBinError = `DOCKER_BIN 指向的 docker 不存在或不可执行: ${fromPath}`
    }
    return dockerBinCache
  }

  for (const candidate of DOCKER_CANDIDATES) {
    if (await isExecutable(candidate)) {
      dockerBinCache = candidate
      return dockerBinCache
    }
  }
  // PATH 里找（which 可能因精简 PATH 失败，故放在最后兜底）
  const found = await runRaw('which', ['docker'])
  const p = found.stdout.trim()
  dockerBinCache = (found.ok && p && await isExecutable(p)) ? p : null
  return dockerBinCache
}

function runRaw(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, {
      timeout: opts.timeout || DEFAULT_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PATH: withDockerPaths(process.env.PATH) }
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err || err.code === 0,
        code: err ? (err.code ?? 1) : 0,
        stdout: stdout || '',
        stderr: stderr || (err && err.killed ? '命令超时' : (err?.message || ''))
      })
    })
  })
}

/** 补齐 docker 常见安装路径（子进程 PATH 可能很精简） */
function withDockerPaths(basePath = '') {
  const parts = basePath.split(':').filter(Boolean)
  for (const extra of ['/usr/local/bin', '/opt/homebrew/bin']) {
    if (!parts.includes(extra)) parts.push(extra)
  }
  return parts.join(':')
}

/** 执行 docker 子命令 */
export async function docker(args, opts = {}) {
  const bin = await resolveDockerBin()
  if (!bin) {
    return { ok: false, code: -1, stdout: '', stderr: dockerBinError || '未找到 docker CLI（请安装 Docker Desktop）' }
  }
  return runRaw(bin, args, opts)
}

// ── 守护进程状态 ──────────────────────────────────────────────────────────────
export async function isDaemonReady() {
  const r = await docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 8000 })
  return { ready: r.ok && !!r.stdout.trim(), version: r.stdout.trim(), error: r.ok ? '' : r.stderr }
}

export async function isDockerDesktopInstalled() {
  if (process.platform !== 'darwin') return null  // 非 macOS 不做判断
  try {
    await fs.access('/Applications/Docker.app')
    return true
  } catch {
    return false
  }
}

/**
 * 确保 Docker 守护进程就绪：未就绪则拉起 Docker Desktop 并轮询等待。
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=120000] 最长等待时间（首次启动虚拟机较慢）
 * @param {(msg:string)=>void} [opts.onLog]
 * @returns {Promise<{ok:boolean, version?:string, reason?:string}>}
 */
export async function ensureDaemon({ timeoutMs = 120_000, onLog = () => {} } = {}) {
  const bin = await resolveDockerBin()
  if (!bin) {
    return {
      ok: false,
      reason: dockerBinError || '未找到 docker CLI：请先安装 Docker Desktop（https://www.docker.com/products/docker-desktop/）'
    }
  }

  const first = await isDaemonReady()
  if (first.ready) return { ok: true, version: first.version }

  if (process.platform === 'darwin') {
    onLog('Docker 守护进程未就绪，尝试启动 Docker Desktop...')
    const opened = await runRaw('open', ['-a', 'Docker'])
    if (!opened.ok) {
      return { ok: false, reason: `Docker Desktop 启动失败: ${opened.stderr.trim()}` }
    }
  } else {
    // TODO: Linux 下可尝试 systemctl --user start docker-desktop，当前仅提示
    return { ok: false, reason: 'Docker 守护进程未运行，请手动启动 Docker 服务（当前仅支持 macOS 自动拉起）' }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const probe = await isDaemonReady()
    if (probe.ready) {
      onLog(`Docker 守护进程已就绪 (${probe.version})`)
      return { ok: true, version: probe.version }
    }
    await sleep(3000)
  }

  const last = await isDaemonReady()
  return {
    ok: false,
    reason: `等待 Docker 守护进程超时（${Math.round(timeoutMs / 1000)}s）。请手动打开 Docker Desktop 确认其正常运行。${last.error ? `\n最后错误: ${firstLine(last.error)}` : ''}`
  }
}

// ── 镜像 ──────────────────────────────────────────────────────────────────────
export async function imageExists(image) {
  const r = await docker(['image', 'inspect', image], { timeout: 15_000 })
  return r.ok
}

/**
 * 确保镜像存在，缺失则 pull（首次安装的主要耗时）。
 * @param {string} image
 * @param {(msg:string)=>void} [onLog]
 */
export async function ensureImage(image, onLog = () => {}) {
  if (await imageExists(image)) return { ok: true, pulled: false }

  onLog(`正在拉取镜像 ${image}（首次约 600MB，请耐心等待）...`)
  // pull 耗时长且输出多，用 spawn 实时转发进度
  const bin = await resolveDockerBin()
  const ok = await new Promise((resolve) => {
    const p = spawn(bin, ['pull', image], {
      env: { ...process.env, PATH: withDockerPaths(process.env.PATH) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let lastLine = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { p.kill('SIGKILL') } catch {}
    }, PULL_TIMEOUT)

    const onData = (d) => {
      // docker pull 用 \r 刷新同一行，只取最后一段作为进度摘要
      const text = d.toString()
      const segments = text.split(/[\r\n]+/).filter(s => s.trim())
      if (segments.length) {
        lastLine = segments[segments.length - 1].trim()
        onLog(`  pull: ${lastLine}`)
      }
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    p.on('error', (err) => { clearTimeout(timer); onLog(`pull 进程错误: ${err.message}`); resolve(false) })
    p.on('exit', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        onLog(`pull 超时（${Math.round(PULL_TIMEOUT / 60000)} 分钟），最后一行: ${lastLine || '无输出'}`)
        return resolve(false)
      }
      resolve(code === 0)
    })
  })

  if (!ok) {
    return {
      ok: false,
      pulled: false,
      error: `镜像拉取失败或超时: ${image}。常见原因是无法访问 Docker Hub（需在 Docker Desktop 里配置代理或镜像加速器），可先在终端执行 docker pull ${image} 验证`
    }
  }
  onLog(`镜像就绪: ${image}`)
  return { ok: true, pulled: true }
}

// ── 容器 ──────────────────────────────────────────────────────────────────────
/** 容器 inspect 结果；不存在返回 null */
export async function inspectContainer(name) {
  const r = await docker(['inspect', name], { timeout: 10_000 })
  if (!r.ok) return null
  try {
    const arr = JSON.parse(r.stdout)
    return Array.isArray(arr) && arr.length ? arr[0] : null
  } catch {
    return null
  }
}

/** 容器当前使用的镜像（tag 形式，取不到则返回 RepoDigests 首项） */
export function containerImageOf(inspectResult) {
  const cfg = inspectResult?.Config
  if (!cfg) return ''
  if (cfg.Image) return cfg.Image
  return inspectResult?.Image ? String(inspectResult.Image).slice(0, 19) : ''
}

/** 宿主端口映射是否与期望一致 */
function containerPortOf(inspectResult) {
  const bindings = inspectResult?.HostConfig?.PortBindings || {}
  const key = Object.keys(bindings).find(k => k.startsWith('3001/'))
  return key ? Number(bindings[key]?.[0]?.HostPort) : null
}

/** 构造 docker run 参数 */
function buildRunArgs({ image, containerName, hostPort, dataDir }) {
  return [
    'run', '-d',
    '--name', containerName,
    '--restart', 'unless-stopped',
    // 仅绑定回环地址，不暴露到局域网
    '-p', `127.0.0.1:${hostPort}:3001`,
    '-v', `${dataDir}:/app/data`,
    image
  ]
}

/**
 * 确保 Kuma 容器按配置运行：
 *   不存在 → run；存在但已停 → start；存在但镜像/端口与配置不符 → 重建（数据卷保留）
 * @param {object} kumaCfg config.kuma
 * @param {(msg:string)=>void} [onLog]
 * @returns {Promise<{ok:boolean, action:'run'|'start'|'recreate'|'noop', error?:string}>}
 */
export async function ensureContainer(kumaCfg, onLog = () => {}) {
  const { image, containerName, hostPort, dataDir } = kumaCfg

  await fs.mkdir(dataDir, { recursive: true })

  const existing = await inspectContainer(containerName)

  if (!existing) {
    onLog(`创建 Kuma 容器 ${containerName}（${image}，端口 ${hostPort}）...`)
    const r = await docker(buildRunArgs(kumaCfg), { timeout: 60_000 })
    if (!r.ok) return { ok: false, action: 'run', error: firstLine(r.stderr) || '容器创建失败' }
    return { ok: true, action: 'run' }
  }

  const currentImage = containerImageOf(existing)
  const currentPort = containerPortOf(existing)
  const state = existing?.State?.Status
  const imageMatch = currentImage === image || currentImage.startsWith(`${image}@`)
  const portMatch = currentPort === Number(hostPort)

  // 镜像升级或端口变更 → 删容器重建（数据在挂载卷里，不受影响）
  if (!imageMatch || !portMatch) {
    onLog(`容器配置已变更（镜像 ${currentImage} → ${image}，端口 ${currentPort} → ${hostPort}），重建容器...`)
    const stopped = await docker(['stop', containerName], { timeout: 60_000 })
    if (!stopped.ok && state === 'running') return { ok: false, action: 'recreate', error: firstLine(stopped.stderr) }
    const removed = await docker(['rm', containerName], { timeout: 30_000 })
    if (!removed.ok) return { ok: false, action: 'recreate', error: firstLine(removed.stderr) }
    const r = await docker(buildRunArgs(kumaCfg), { timeout: 60_000 })
    if (!r.ok) return { ok: false, action: 'recreate', error: firstLine(r.stderr) || '容器重建失败' }
    return { ok: true, action: 'recreate' }
  }

  if (state !== 'running') {
    onLog(`启动已存在的 Kuma 容器 ${containerName}...`)
    const r = await docker(['start', containerName], { timeout: 60_000 })
    if (!r.ok) return { ok: false, action: 'start', error: firstLine(r.stderr) }
    return { ok: true, action: 'start' }
  }

  return { ok: true, action: 'noop' }
}

/** 停止容器（监控暂停，数据保留） */
export async function stopContainer(containerName) {
  return docker(['stop', containerName], { timeout: 60_000 })
}

/** 重启容器 */
export async function restartContainer(containerName) {
  return docker(['restart', containerName], { timeout: 60_000 })
}

/** 容器日志尾部 */
export async function containerLogs(containerName, tail = 100) {
  const r = await docker(['logs', '--tail', String(tail), containerName], { timeout: 15_000 })
  // docker logs 把正常输出写 stderr，两者都要
  return (r.stdout + r.stderr).trim()
}

// ── Kuma 服务健康 ─────────────────────────────────────────────────────────────
/** 探测 Kuma Web 是否可访问（容器起来到页面可用有几秒延迟） */
export function probeKuma(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

/** 轮询等待 Kuma Web 就绪 */
export async function waitKumaReady(port, { timeoutMs = 90_000, onLog = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs
  let announced = false
  while (Date.now() < deadline) {
    if (await probeKuma(port)) return true
    if (!announced) { onLog(`等待 Kuma Web 就绪 (http://127.0.0.1:${port}/)...`); announced = true }
    await sleep(2000)
  }
  return false
}

/**
 * 汇总当前状态（供 /api/status 与 CLI status 使用）
 * @param {object} kumaCfg config.kuma
 */
export async function collectStatus(kumaCfg) {
  const bin = await resolveDockerBin()
  const status = {
    dockerCli: !!bin,
    dockerCliPath: bin || '',
    dockerCliError: bin ? '' : dockerBinError,
    daemon: { ready: false, version: '', error: '' },
    container: { exists: false, state: '', image: '', hostPort: null, startedAt: '' },
    kuma: { reachable: false, url: `http://127.0.0.1:${kumaCfg.hostPort}/` },
    expectedImage: kumaCfg.image,
    dataDir: kumaCfg.dataDir
  }
  if (!bin) return status

  const daemon = await isDaemonReady()
  status.daemon = { ready: daemon.ready, version: daemon.version, error: daemon.error ? firstLine(daemon.error) : '' }
  if (!daemon.ready) return status

  const inspectResult = await inspectContainer(kumaCfg.containerName)
  if (inspectResult) {
    status.container = {
      exists: true,
      state: inspectResult?.State?.Status || 'unknown',
      image: containerImageOf(inspectResult),
      hostPort: containerPortOf(inspectResult),
      startedAt: inspectResult?.State?.StartedAt || ''
    }
  }
  status.kuma.reachable = await probeKuma(kumaCfg.hostPort, 2000)
  return status
}

/**
 * 完整引导：守护进程 → 镜像 → 容器 → Kuma Web 就绪
 * @param {object} kumaCfg config.kuma
 * @param {(msg:string)=>void} [onLog]
 */
export async function bootstrapKuma(kumaCfg, onLog = () => {}) {
  const daemon = await ensureDaemon({ onLog })
  if (!daemon.ok) return { ok: false, stage: 'daemon', reason: daemon.reason }

  const image = await ensureImage(kumaCfg.image, onLog)
  if (!image.ok) return { ok: false, stage: 'image', reason: image.error }

  const container = await ensureContainer(kumaCfg, onLog)
  if (!container.ok) return { ok: false, stage: 'container', reason: container.error }

  const ready = await waitKumaReady(kumaCfg.hostPort, { onLog })
  if (!ready) {
    return {
      ok: false,
      stage: 'web',
      reason: `Kuma 容器已启动但 Web 未就绪（端口 ${kumaCfg.hostPort}）。可执行 docker logs ${kumaCfg.containerName} 查看原因。`,
      action: container.action
    }
  }

  onLog(`Kuma 就绪: http://127.0.0.1:${kumaCfg.hostPort}/ (容器动作: ${container.action})`)
  return { ok: true, stage: 'ready', action: container.action, daemonVersion: daemon.version }
}

// ── 小工具 ────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function firstLine(text = '') {
  const line = String(text).split('\n').map(s => s.trim()).filter(Boolean)[0]
  return line || ''
}
