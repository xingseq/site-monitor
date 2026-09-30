/**
 * App.jsx — site-monitor 管理前端
 *
 * 四个视图：
 *   监控面板  内层 iframe 嵌入 Uptime Kuma（添加监控项、查看可用率全在 Kuma 原生界面）
 *   运行状态  Docker 守护进程 / 容器 / Kuma 可达性 / 数据与配置路径
 *   通知设置  收件邮箱、限流、镜像与端口（保存后热重载并按需重建容器）+ Webhook 配置步骤
 *   告警日志  最近告警历史 + 网关日志 + Kuma 容器日志
 *
 * 数据来源：site-monitor 网关（同源 :3005），全部走相对 /api 路径
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'

const VIEWS = [
  { id: 'kuma', label: '监控面板' },
  { id: 'status', label: '运行状态' },
  { id: 'notify', label: '通知设置' },
  { id: 'alerts', label: '告警日志' }
]

const PHASE_LABEL = {
  starting: '启动中',
  ready: '运行中',
  degraded: '异常'
}

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  const text = await resp.text()
  try { return JSON.parse(text) } catch { return { error: text || `HTTP ${resp.status}` } }
}

const fmtTime = (iso) => {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }) } catch { return iso }
}

const fmtUptime = (sec) => {
  if (!Number.isFinite(sec)) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`
}

export default function App() {
  const [view, setView] = useState('kuma')
  const [status, setStatus] = useState(null)
  const [alerts, setAlerts] = useState([])
  const [logs, setLogs] = useState({ gateway: [], container: '' })
  const [form, setForm] = useState(null)
  const [msg, setMsg] = useState(null)       // { type: 'ok'|'err', text }
  const [busy, setBusy] = useState('')
  const msgTimer = useRef(null)

  const toast = useCallback((type, text) => {
    setMsg({ type, text })
    clearTimeout(msgTimer.current)
    msgTimer.current = setTimeout(() => setMsg(null), 5000)
  }, [])

  // ── 状态轮询 ────────────────────────────────────────────────────────────────
  const refreshStatus = useCallback(async () => {
    const data = await api('/api/status')
    if (data && !data.error) {
      setStatus(data)
      // 首次拿到配置时初始化表单（之后由用户编辑主导，不被轮询覆盖）
      setForm(prev => prev || (data.config ? JSON.parse(JSON.stringify(data.config)) : null))
    }
    return data
  }, [])

  useEffect(() => {
    refreshStatus()
    // 引导期间（拉镜像可能数分钟）加密轮询，让进度可见
    const interval = setInterval(refreshStatus, status?.phase === 'starting' ? 3000 : 6000)
    return () => clearInterval(interval)
  }, [refreshStatus, status?.phase])

  // ── 告警与日志 ──────────────────────────────────────────────────────────────
  const refreshAlerts = useCallback(async () => {
    const data = await api('/api/alerts?limit=50')
    if (data?.alerts) setAlerts(data.alerts)
  }, [])

  const refreshLogs = useCallback(async () => {
    const data = await api('/api/logs?tail=80')
    if (data && !data.error) setLogs({ gateway: data.gateway || [], container: data.container || '' })
  }, [])

  useEffect(() => {
    if (view !== 'alerts') return
    refreshAlerts()
    refreshLogs()
    const t = setInterval(() => { refreshAlerts(); refreshLogs() }, 8000)
    return () => clearInterval(t)
  }, [view, refreshAlerts, refreshLogs])

  // ── 操作 ────────────────────────────────────────────────────────────────────
  const runAction = useCallback(async (key, fn, okText) => {
    setBusy(key)
    try {
      const result = await fn()
      if (result?.success === false) {
        toast('err', result.error || '操作失败')
      } else {
        toast('ok', okText || '操作完成')
      }
      await refreshStatus()
      return result
    } catch (err) {
      toast('err', err.message)
    } finally {
      setBusy('')
    }
  }, [refreshStatus, toast])

  const saveConfig = () => runAction('save', async () => {
    const res = await api('/api/config', { method: 'PUT', body: JSON.stringify({ config: form }) })
    if (res.success === false) return { success: false, error: (res.errors || [res.error]).join('；') }
    return { success: true, rebootstrap: res.rebootstrap }
  }, '配置已保存').then(res => {
    if (res?.success && res.rebootstrap) toast('ok', '配置已保存，正在按新配置重建 Kuma 容器...')
  })

  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text)
      toast('ok', `${label}已复制`)
    } catch {
      toast('err', '复制失败，请手动选择文本复制')
    }
  }

  const kumaUrl = status?.docker?.kuma?.url
    || `http://127.0.0.1:${form?.kuma?.hostPort || 3004}/`
  const phase = status?.phase || 'starting'
  const kumaReachable = !!status?.docker?.kuma?.reachable

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>站点监控</h1>
          <div className="subtitle">
            Uptime Kuma · 网关 :{status?.gatewayPort || 3005} · 已运行 {fmtUptime(status?.uptimeSec)}
          </div>
        </div>
        <div className="header-right">
          <span className={`badge badge-${phase}`}>
            {PHASE_LABEL[phase] || phase}
            {status?.bootstrapping ? '（引导中）' : ''}
          </span>
          <button
            className="btn"
            disabled={!!busy}
            onClick={() => runAction('bootstrap', () => api('/api/bootstrap', { method: 'POST' }), '已触发重新引导')}
          >
            {busy === 'bootstrap' ? '引导中...' : '重新引导'}
          </button>
          <a className="btn btn-ghost" href={kumaUrl} target="_blank" rel="noreferrer">新窗口打开 Kuma</a>
        </div>
      </header>

      {status?.reason && phase !== 'ready' && (
        <div className="banner banner-warn">
          <strong>{phase === 'starting' ? '正在启动：' : '需要处理：'}</strong>
          <span className="banner-text">{status.reason}</span>
        </div>
      )}
      {msg && <div className={`banner banner-${msg.type === 'ok' ? 'ok' : 'err'}`}>{msg.text}</div>}

      <nav className="tabs">
        {VIEWS.map(v => (
          <button
            key={v.id}
            className={`tab ${view === v.id ? 'tab-active' : ''}`}
            onClick={() => setView(v.id)}
          >
            {v.label}
            {v.id === 'alerts' && alerts.length > 0 && <span className="tab-count">{alerts.length}</span>}
          </button>
        ))}
      </nav>

      <main className="content">
        {view === 'kuma' && (
          <KumaPanel url={kumaUrl} reachable={kumaReachable} phase={phase} reason={status?.reason} />
        )}
        {view === 'status' && <StatusView status={status} />}
        {view === 'notify' && (
          <NotifyView
            form={form}
            status={status}
            busy={busy}
            onChange={setForm}
            onSave={saveConfig}
            onTest={() => runAction('test', () => api('/api/notify/test', { method: 'POST' }), '测试邮件已发送，请查收')}
            onCopy={copyText}
          />
        )}
        {view === 'alerts' && (
          <AlertsView
            alerts={alerts}
            logs={logs}
            busy={busy}
            onStopKuma={() => runAction('stop', () => api('/api/kuma/stop', { method: 'POST' }), 'Kuma 容器已停止（监控暂停）')}
            onRestartKuma={() => runAction('restart', () => api('/api/kuma/restart', { method: 'POST' }), 'Kuma 容器已重启')}
          />
        )}
      </main>
    </div>
  )
}

// ── 监控面板 ──────────────────────────────────────────────────────────────────
function KumaPanel({ url, reachable, phase, reason }) {
  if (!reachable) {
    return (
      <div className="panel empty-panel">
        <div className="empty-title">Kuma 面板尚未就绪</div>
        <div className="empty-hint">
          {phase === 'starting'
            ? '正在启动 Docker 与 Uptime Kuma 容器。首次安装需要拉取约 600MB 镜像，请耐心等待，本页会自动刷新。'
            : (reason || '请切到「运行状态」查看 Docker 与容器详情，或点击顶部「重新引导」。')}
        </div>
        <div className="empty-hint">可在「告警日志」页查看容器日志定位问题。</div>
      </div>
    )
  }

  return (
    <div className="panel iframe-panel">
      <div className="iframe-bar">
        <span className="muted">{url}</span>
        <a className="btn btn-small btn-ghost" href={url} target="_blank" rel="noreferrer">新窗口打开</a>
      </div>
      {/* Kuma 原生界面：监控项增删、探测间隔、可用率统计、通知渠道均在此操作 */}
      <iframe className="kuma-frame" src={url} title="Uptime Kuma" />
    </div>
  )
}

// ── 运行状态 ──────────────────────────────────────────────────────────────────
function StatusView({ status }) {
  if (!status) return <div className="panel empty-panel">加载中...</div>
  const d = status.docker || {}
  const c = d.container || {}
  // 期望镜像取自 docker 状态段（/api/status 里嵌在 status.docker 下，不在顶层）
  const expectedImage = d.expectedImage || status.config?.kuma?.image || ''

  const rows = [
    { label: 'docker CLI', ok: d.dockerCli, value: d.dockerCliPath || d.dockerCliError || '未找到（请安装 Docker Desktop）' },
    { label: 'Docker 守护进程', ok: d.daemon?.ready, value: d.daemon?.ready ? `版本 ${d.daemon.version}` : (d.daemon?.error || '未运行') },
    { label: 'Kuma 容器', ok: c.state === 'running', value: c.exists ? `${c.state} · 启动于 ${fmtTime(c.startedAt)}` : '尚未创建' },
    { label: '容器镜像', ok: !!c.image && (c.image === expectedImage || c.image.startsWith(`${expectedImage}@`)), value: c.image ? `${c.image}${c.image === expectedImage ? '' : `（期望 ${expectedImage}）`}` : '—' },
    { label: '宿主端口', ok: c.hostPort === status.config?.kuma?.hostPort, value: c.hostPort ? `127.0.0.1:${c.hostPort} → 容器 3001` : '未映射' },
    { label: 'Kuma Web', ok: d.kuma?.reachable, value: d.kuma?.url || '—' }
  ]

  const n = status.notify || {}

  return (
    <div className="panel">
      <section className="section">
        <h2>容器与运行时</h2>
        <table className="kv">
          <tbody>
            {rows.map(r => (
              <tr key={r.label}>
                <td className="kv-label"><Dot ok={r.ok} />{r.label}</td>
                <td className="kv-value">{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="section">
        <h2>通知通道</h2>
        <table className="kv">
          <tbody>
            <tr>
              <td className="kv-label"><Dot ok={n.mailAppFound} />mail-app</td>
              <td className="kv-value">
                {n.mailAppCli || `未找到${n.mailAppConfigured ? `（指定路径不存在：${n.mailAppConfigured}）` : ''}`}
              </td>
            </tr>
            <tr>
              <td className="kv-label"><Dot ok={n.recipientSet} />收件邮箱</td>
              <td className="kv-value">{n.recipient || '未配置'}</td>
            </tr>
            <tr>
              <td className="kv-label"><Dot ok={n.enabled} />通知开关</td>
              <td className="kv-value">{n.enabled ? '开启' : '关闭'}</td>
            </tr>
            <tr>
              <td className="kv-label"><Dot ok={n.ready} />通道就绪</td>
              <td className="kv-value">{n.ready ? '告警邮件可正常发送' : (n.issue || '尚不可用，请补齐上述项')}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="section">
        <h2>路径</h2>
        <table className="kv">
          <tbody>
            <tr><td className="kv-label">配置文件</td><td className="kv-value mono">{status.configPath}</td></tr>
            <tr><td className="kv-label">监控数据</td><td className="kv-value mono">{status.config?.kuma?.dataDir}</td></tr>
            <tr><td className="kv-label">Webhook</td><td className="kv-value mono">{status.webhookUrl}</td></tr>
            <tr><td className="kv-label">最近引导</td><td className="kv-value">{fmtTime(status.lastBootstrapAt)}{status.lastAction ? ` · 动作 ${status.lastAction}` : ''}</td></tr>
          </tbody>
        </table>
        <p className="hint">
          监控数据放在安装目录之外，子应用更新或卸载都不会丢失 Kuma 里的监控项与历史记录。
        </p>
      </section>
    </div>
  )
}

function Dot({ ok }) {
  return <span className={`dot ${ok ? 'dot-ok' : 'dot-bad'}`} />
}

// ── 通知设置 ──────────────────────────────────────────────────────────────────
function NotifyView({ form, status, busy, onChange, onSave, onTest, onCopy }) {
  if (!form) return <div className="panel empty-panel">加载中...</div>

  const set = (section, key, value) => {
    onChange({
      ...form,
      [section]: { ...form[section], [key]: value }
    })
  }
  const setNested = (section, sub, key, value) => {
    onChange({
      ...form,
      [section]: { ...form[section], [sub]: { ...form[section]?.[sub], [key]: value } }
    })
  }

  const webhookUrl = status?.webhookUrl || 'http://host.docker.internal:3005/api/webhook/kuma'

  return (
    <div className="panel">
      <section className="section">
        <h2>告警通知</h2>
        <label className="field">
          <span className="field-label">收件邮箱</span>
          <input
            className="input"
            type="email"
            placeholder="you@example.com"
            value={form.notify?.email?.to || ''}
            onChange={e => setNested('notify', 'email', 'to', e.target.value)}
          />
          <span className="hint">站点挂掉与恢复时，通过 mail-app 的 SMTP 配置发到这个邮箱</span>
        </label>

        <label className="field field-row">
          <span className="field-label">启用邮件通知</span>
          <input
            type="checkbox"
            checked={form.notify?.enabled !== false}
            onChange={e => set('notify', 'enabled', e.target.checked)}
          />
        </label>

        <label className="field">
          <span className="field-label">mail-app 路径（可选）</span>
          <input
            className="input mono"
            placeholder="留空则自动探测"
            value={form.notify?.mailAppCli || ''}
            onChange={e => set('notify', 'mailAppCli', e.target.value)}
          />
          <span className="hint">
            当前使用：{status?.notify?.mailAppCli || '未找到'}。
            mail-app 未安装到应用商店目录时（如仅存在于开发仓库），在此填写其 src/cli.mjs 的绝对路径
          </span>
        </label>

        <label className="field">
          <span className="field-label">同状态告警限流（分钟）</span>
          <input
            className="input input-short"
            type="number"
            min="0"
            value={form.bridge?.rateLimitMinutes ?? 10}
            onChange={e => set('bridge', 'rateLimitMinutes', Number(e.target.value))}
          />
          <span className="hint">同一站点同一状态在此时间内只发一封，填 0 表示不限流</span>
        </label>

        <div className="btn-row">
          <button className="btn btn-primary" disabled={busy === 'save'} onClick={onSave}>
            {busy === 'save' ? '保存中...' : '保存配置'}
          </button>
          <button className="btn" disabled={busy === 'test'} onClick={onTest}>
            {busy === 'test' ? '发送中...' : '发送测试邮件'}
          </button>
        </div>
      </section>

      <section className="section">
        <h2>Uptime Kuma</h2>
        <label className="field">
          <span className="field-label">镜像版本</span>
          <input
            className="input"
            value={form.kuma?.image || ''}
            onChange={e => set('kuma', 'image', e.target.value)}
          />
          <span className="hint">
            改成新 tag 并保存即可升级：自动 pull 新镜像 → 用同一数据目录重建容器（监控项与历史保留）
          </span>
        </label>

        <label className="field">
          <span className="field-label">宿主端口</span>
          <input
            className="input input-short"
            type="number"
            min="1"
            max="65535"
            value={form.kuma?.hostPort ?? 3004}
            onChange={e => set('kuma', 'hostPort', Number(e.target.value))}
          />
          <span className="hint">仅绑定 127.0.0.1，不暴露到局域网。修改后保存会重建容器</span>
        </label>

        <label className="field">
          <span className="field-label">容器名</span>
          <input
            className="input"
            value={form.kuma?.containerName || ''}
            onChange={e => set('kuma', 'containerName', e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">数据目录</span>
          <input
            className="input mono"
            value={form.kuma?.dataDir || ''}
            onChange={e => set('kuma', 'dataDir', e.target.value)}
          />
          <span className="hint">Kuma 的 SQLite 数据库位置，建议保持在安装目录之外</span>
        </label>
      </section>

      <section className="section">
        <h2>在 Kuma 里配置 Webhook（一次性）</h2>
        <div className="field">
          <span className="field-label">Webhook 地址</span>
          <div className="copy-row">
            <code className="mono copy-text">{webhookUrl}</code>
            <button className="btn btn-small" onClick={() => onCopy(webhookUrl, 'Webhook 地址')}>复制</button>
          </div>
        </div>
        <ol className="steps">
          <li>切到「监控面板」，首次使用先创建 Kuma 管理员账号</li>
          <li>右上角头像 → <code>Settings</code> → <code>Notifications</code> → <code>Setup Notification</code></li>
          <li><code>Notification Type</code> 选 <code>Webhook</code>，URL 粘贴上面复制的地址</li>
          <li>勾选 <code>Apply on all existing monitors</code>，保存</li>
          <li>添加监控项：<code>Add New Monitor</code> → 填网址 → 心跳间隔建议 60 秒</li>
        </ol>
        <p className="hint">
          容器内通过 <code>host.docker.internal</code> 访问宿主机网关，无需额外网络配置。
          你也可以在 Kuma 里直接配置其他通知渠道（Telegram、Server 酱等），本桥接只负责邮件。
        </p>
      </section>
    </div>
  )
}

// ── 告警与日志 ────────────────────────────────────────────────────────────────
function AlertsView({ alerts, logs, busy, onStopKuma, onRestartKuma }) {
  const [tab, setTab] = useState('alerts')

  return (
    <div className="panel">
      <div className="subtabs">
        <button className={`tab ${tab === 'alerts' ? 'tab-active' : ''}`} onClick={() => setTab('alerts')}>
          告警历史（{alerts.length}）
        </button>
        <button className={`tab ${tab === 'gateway' ? 'tab-active' : ''}`} onClick={() => setTab('gateway')}>网关日志</button>
        <button className={`tab ${tab === 'container' ? 'tab-active' : ''}`} onClick={() => setTab('container')}>容器日志</button>
        <div className="subtabs-right">
          <button className="btn btn-small" disabled={busy === 'restart'} onClick={onRestartKuma}>重启容器</button>
          <button className="btn btn-small btn-danger" disabled={busy === 'stop'} onClick={onStopKuma}>停止容器</button>
        </div>
      </div>

      {tab === 'alerts' && (
        alerts.length === 0
          ? <div className="empty-hint">还没有告警记录。在 Kuma 里添加监控项后，状态变化会出现在这里。</div>
          : (
            <table className="table">
              <thead>
                <tr><th>时间</th><th>监控项</th><th>状态</th><th>通知</th><th>详情</th></tr>
              </thead>
              <tbody>
                {alerts.map((a, i) => (
                  <tr key={`${a.at}-${i}`}>
                    <td className="nowrap">{fmtTime(a.at)}</td>
                    <td>{a.monitorName}{a.url ? <div className="muted small">{a.url}</div> : null}</td>
                    <td><span className={`status status-${(a.status || '').toLowerCase()}`}>{a.status}</span></td>
                    <td>
                      {a.notified
                        ? <span className="status status-up">已发邮件</span>
                        : a.suppressed
                          ? <span className="muted">已抑制</span>
                          : a.error
                            ? <span className="status status-down" title={a.error}>失败</span>
                            : <span className="muted">未通知</span>}
                      {a.error ? <div className="muted small">{a.error}</div> : null}
                    </td>
                    <td className="muted small">{a.msg || (a.ping != null ? `${a.ping} ms` : '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}

      {tab === 'gateway' && (
        <pre className="log-box">
          {logs.gateway.length === 0
            ? '（暂无网关日志）'
            : logs.gateway.map(l => `${fmtTime(l.at)} [${l.level}] ${l.msg}`).join('\n')}
        </pre>
      )}

      {tab === 'container' && (
        <pre className="log-box">{logs.container || '（容器无日志或尚未创建）'}</pre>
      )}
    </div>
  )
}
