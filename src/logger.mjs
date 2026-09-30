/**
 * logger.mjs
 * 统一日志出口：环形缓冲（供 /api/logs 与 GUI「网关日志」展示）+ 控制台输出
 *
 * 存在意义：config-store 的热重载、notify-bridge 的发信记录都发生在模块内部，
 * 若各自用 console.* 直出，控制台看得到、GUI 日志页却看不到，排障时会产生
 * 「日志缺失」的错觉。故所有模块统一走这里。
 *
 * 无外部依赖，避免与其他模块形成循环引用。
 */

const LOG_LIMIT = 300

const lines = []

/**
 * 写一条日志。
 * @param {string} msg
 * @param {'info'|'error'|'warn'} [level]
 */
export function log(msg, level = 'info') {
  const line = { at: new Date().toISOString(), level, msg: String(msg) }
  lines.push(line)
  if (lines.length > LOG_LIMIT) lines.shift()

  // pull 进度这类高频行只进缓冲，不刷屏
  if (!line.msg.startsWith('  pull:')) {
    const prefix = level === 'error' ? '[site-monitor:err]' : level === 'warn' ? '[site-monitor:warn]' : '[site-monitor]'
    const out = level === 'error' ? console.error : console.log
    out(`${prefix} ${line.msg}`)
  }
}

export const error = (msg) => log(msg, 'error')
export const warn = (msg) => log(msg, 'warn')

/** 最近日志（最新在后） */
export function getLogs(limit = LOG_LIMIT) {
  return limit >= lines.length ? [...lines] : lines.slice(-limit)
}

export function logCount() {
  return lines.length
}
