/**
 * config-store.mjs
 * site-monitor 配置持久化 + 热重载
 *
 * 配置文件：~/Library/Application Support/xingseq/site-monitor/config.json
 * 数据目录：~/Library/Application Support/xingseq/site-monitor/kuma-data/
 *           （Kuma 的 SQLite 与配置；刻意放在安装目录之外，
 *            因为 skill-host 的 update = 删目录 + 重装，放里面会丢数据）
 *
 * 结构：
 *   {
 *     kuma:   { image, containerName, hostPort, dataDir },
 *     notify: { enabled, email: { to }, mailAppCli },
 *     bridge: { rateLimitMinutes }
 *   }
 */

import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { warn, error } from './logger.mjs'

// ── 路径 ──────────────────────────────────────────────────────────────────────
export const APP_DATA_DIR = path.join(
  os.homedir(), 'Library', 'Application Support', 'xingseq', 'site-monitor'
)
const CONFIG_FILE = path.join(APP_DATA_DIR, 'config.json')

/** Kuma 镜像版本锁定：不用浮动的 :2，升级由改配置显式触发 */
export const DEFAULT_KUMA_IMAGE = 'louislam/uptime-kuma:2.5.5'

export const DEFAULTS = Object.freeze({
  kuma: {
    image: DEFAULT_KUMA_IMAGE,
    containerName: 'xingseq-uptime-kuma',
    hostPort: 3004,
    dataDir: path.join(APP_DATA_DIR, 'kuma-data')
  },
  notify: {
    enabled: true,
    email: { to: '' },
    // mail-app 的 cli.mjs 绝对路径；留空则自动探测（见 notify-bridge.resolveMailAppCli）
    mailAppCli: ''
  },
  bridge: {
    rateLimitMinutes: 10
  }
})

// ── 内存态 ────────────────────────────────────────────────────────────────────
let config = null          // null 表示未加载
let watcher = null         // fs.watch 句柄，只注册一次（重复注册会导致回调叠加）
let watchDebounce = null
const changeListeners = new Set()

/** 深合并：以 defaults 为底，用户配置覆盖（缺失字段自动补默认值） */
function mergeDefaults(user = {}) {
  return {
    kuma: { ...DEFAULTS.kuma, ...(user.kuma || {}) },
    notify: {
      ...DEFAULTS.notify,
      ...(user.notify || {}),
      email: { ...DEFAULTS.notify.email, ...(user.notify?.email || {}) }
    },
    bridge: { ...DEFAULTS.bridge, ...(user.bridge || {}) }
  }
}

export function configFilePath() {
  return CONFIG_FILE
}

/** 读取配置（带内存缓存）；文件不存在时写入默认配置 */
export async function loadConfig({ force = false } = {}) {
  if (config && !force) return config

  let user = {}
  try {
    user = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))
  } catch (err) {
    if (err.code !== 'ENOENT') {
      warn(`配置解析失败，回退默认值: ${err.message}`)
    }
  }

  config = mergeDefaults(user)
  await fs.mkdir(APP_DATA_DIR, { recursive: true })
  await fs.mkdir(config.kuma.dataDir, { recursive: true })

  // 首次运行时落盘默认配置，让用户能直接看到可编辑的完整配置
  // （写失败不影响运行，降级为仅内存配置）
  if (Object.keys(user).length === 0) {
    try {
      await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))
    } catch (err) {
      warn(`默认配置写入失败（${err.code || err.message}），本次仅使用内存配置`)
    }
  }
  return config
}

export function getConfig() {
  return config || mergeDefaults({})
}

/** 全量写入配置（GUI 表单提交走这里）；落盘成功后才提交内存态 */
export async function saveConfig(next) {
  const merged = mergeDefaults(next)
  await fs.mkdir(APP_DATA_DIR, { recursive: true })
  await fs.mkdir(merged.kuma.dataDir, { recursive: true })
  // 先写盘再更新内存：写失败（权限/磁盘）时不能让内存与配置文件分叉
  await fs.writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2))
  config = merged
  return config
}

/** 部分更新（点合并） */
export async function patchConfig(patch = {}) {
  const cur = await loadConfig()
  return saveConfig({
    kuma: { ...cur.kuma, ...(patch.kuma || {}) },
    notify: {
      ...cur.notify,
      ...(patch.notify || {}),
      email: { ...cur.notify.email, ...(patch.notify?.email || {}) }
    },
    bridge: { ...cur.bridge, ...(patch.bridge || {}) }
  })
}

/** 校验配置，返回错误消息数组（空数组表示合法） */
export function validateConfig(cfg) {
  const errors = []
  const port = Number(cfg?.kuma?.hostPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('kuma.hostPort 必须是 1-65535 的整数')
  }
  if (!cfg?.kuma?.image || typeof cfg.kuma.image !== 'string') {
    errors.push('kuma.image 不能为空')
  }
  const limit = Number(cfg?.bridge?.rateLimitMinutes)
  if (!Number.isFinite(limit) || limit < 0) {
    errors.push('bridge.rateLimitMinutes 必须是非负数字')
  }
  const to = cfg?.notify?.email?.to
  if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to).trim())) {
    errors.push('notify.email.to 不是合法的邮箱地址')
  }
  const cli = cfg?.notify?.mailAppCli
  if (cli && !path.isAbsolute(String(cli).trim())) {
    errors.push('notify.mailAppCli 必须是绝对路径（或留空交由自动探测）')
  }
  return errors
}

// ── 热重载 ────────────────────────────────────────────────────────────────────
/** 订阅配置变更（GUI 编辑或手改文件都会触发） */
export function onConfigChange(fn) {
  if (typeof fn === 'function') changeListeners.add(fn)
  return () => changeListeners.delete(fn)
}

/**
 * 启动配置文件监听。
 * 幂等：多次调用只保留一个 fs.watch 监听器，避免回调叠加导致重复处理。
 */
export async function watchConfig() {
  await loadConfig()
  if (watcher) return

  try {
    watcher = fsSync.watch(APP_DATA_DIR, (eventType, filename) => {
      if (filename && filename !== 'config.json') return
      // 编辑器保存常触发多次事件，去抖后只重载一次
      clearTimeout(watchDebounce)
      watchDebounce = setTimeout(async () => {
        const before = JSON.stringify(config)
        const next = await loadConfig({ force: true })
        if (JSON.stringify(next) === before) return
        // 重载本身不单独记日志：订阅方会记录带上下文的结果
        //（如「配置已保存」「无需重建容器」），这里再记一条会形成重复噪音。
        for (const fn of changeListeners) {
          try { fn(next) } catch (err) { error(`配置变更回调失败: ${err.message}`) }
        }
      }, 200)
    })
    watcher.on('error', (err) => {
      error(`配置监听失败: ${err.message}`)
      watcher = null
    })
  } catch (err) {
    error(`无法监听配置目录: ${err.message}`)
  }
}

export function stopWatchConfig() {
  clearTimeout(watchDebounce)
  if (watcher) { try { watcher.close() } catch {} watcher = null }
}

/** 同步读取（CLI 一次性命令用，不启动监听） */
export function loadConfigSync() {
  let user = {}
  try {
    user = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf-8'))
  } catch {}
  return mergeDefaults(user)
}
