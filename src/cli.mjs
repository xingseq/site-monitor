#!/usr/bin/env node
/**
 * cli.mjs
 * site-monitor 命令行入口（子命令风格，供 subapp-host 与控制台 startCommand 调用）
 *
 * 用法：
 *   node src/cli.mjs gateway      启动网关（含 Kuma 容器引导），常驻前台
 *   node src/cli.mjs ensure       只确保 Docker 就绪并拉起 Kuma 容器，完成后退出
 *   node src/cli.mjs status       打印 Docker / 容器 / Kuma / 通知通道状态
 *   node src/cli.mjs logs [--tail N]           查看 Kuma 容器日志
 *   node src/cli.mjs stop-kuma    停止 Kuma 容器（监控暂停，数据保留）
 *   node src/cli.mjs restart-kuma 重启 Kuma 容器
 */

import * as store from './config-store.mjs'
import * as docker from './docker.mjs'
import * as bridge from './notify-bridge.mjs'

const [, , command, ...rest] = process.argv

function readArg(name) {
  const i = rest.indexOf(name)
  return i >= 0 ? rest[i + 1] : null
}

function printStatus(s) {
  const mark = (ok) => (ok ? '✓' : '✗')
  console.log('── Docker ─────────────────────────────────────')
  console.log(`  ${mark(s.dockerCli)} docker CLI: ${s.dockerCliPath || s.dockerCliError || '未找到'}`)
  console.log(`  ${mark(s.daemon.ready)} 守护进程: ${s.daemon.ready ? s.daemon.version : '未运行'}`)
  if (s.daemon.error) console.log(`      错误: ${s.daemon.error}`)

  console.log('── Uptime Kuma 容器 ───────────────────────────')
  if (!s.container.exists) {
    console.log('  ✗ 容器不存在（尚未创建）')
  } else {
    console.log(`  ${mark(s.container.state === 'running')} 容器: ${s.container.state}`)
    console.log(`    镜像: ${s.container.image}`)
    console.log(`    端口: ${s.container.hostPort ?? '未映射'}`)
    if (s.container.startedAt) console.log(`    启动于: ${s.container.startedAt}`)
  }
  console.log(`  ${mark(s.kuma.reachable)} Web: ${s.kuma.url}`)
  console.log(`    期望镜像: ${s.expectedImage}`)
  console.log(`    数据目录: ${s.dataDir}`)
}

async function runStatus() {
  const cfg = await store.loadConfig()
  const s = await docker.collectStatus(cfg.kuma)
  printStatus(s)

  console.log('── 通知通道 ───────────────────────────────────')
  const ch = await bridge.checkChannel()
  console.log(`  ${ch.mailAppFound ? '✓' : '✗'} mail-app: ${ch.mailAppCli || `未找到${ch.mailAppConfigured ? `（指定路径不存在: ${ch.mailAppConfigured}）` : ''}`}`)
  console.log(`  ${ch.recipientSet ? '✓' : '✗'} 收件邮箱: ${ch.recipient || '未配置'}`)
  console.log(`  ${ch.enabled ? '✓' : '✗'} 通知开关: ${ch.enabled ? '开启' : '关闭'}`)
  console.log(`  ${ch.ready ? '✓' : '✗'} 通道就绪: ${ch.ready ? '告警邮件可正常发送' : (ch.issue || '尚不可用')}`)

  console.log('── 路径 ───────────────────────────────────────')
  console.log(`  配置文件: ${store.configFilePath()}`)
  console.log(`  Webhook : http://host.docker.internal:${process.env.SITE_MONITOR_PORT || 3005}/api/webhook/kuma`)

  process.exit(s.kuma.reachable && ch.ready ? 0 : 1)
}

async function runEnsure() {
  const cfg = await store.loadConfig()
  console.log(`==> 确保 Kuma 就绪（镜像 ${cfg.kuma.image}，端口 ${cfg.kuma.hostPort}）`)
  const result = await docker.bootstrapKuma(cfg.kuma, (m) => console.log(`    ${m}`))
  if (!result.ok) {
    console.error(`✗ 失败（阶段 ${result.stage}）: ${result.reason}`)
    process.exit(1)
  }
  console.log(`✓ Kuma 就绪: http://127.0.0.1:${cfg.kuma.hostPort}/  (容器动作: ${result.action})`)
  process.exit(0)
}

async function runLogs() {
  const cfg = await store.loadConfig()
  const tail = Number(readArg('--tail') || 100)
  const text = await docker.containerLogs(cfg.kuma.containerName, tail)
  console.log(text || `（容器 ${cfg.kuma.containerName} 无日志或不存在）`)
  process.exit(0)
}

async function runContainerOp(op) {
  const cfg = await store.loadConfig()
  const result = op === 'stop'
    ? await docker.stopContainer(cfg.kuma.containerName)
    : await docker.restartContainer(cfg.kuma.containerName)
  if (!result.ok) {
    console.error(`✗ 失败: ${(result.stderr || '').trim()}`)
    process.exit(1)
  }
  console.log(op === 'stop'
    ? `✓ 已停止 ${cfg.kuma.containerName}（监控暂停，数据保留在 ${cfg.kuma.dataDir}）`
    : `✓ 已重启 ${cfg.kuma.containerName}`)
  process.exit(0)
}

function showHelp() {
  console.log(`site-monitor — 基于 Uptime Kuma 的站点监控子应用

用法: node src/cli.mjs <command> [options]

命令:
  gateway        启动网关常驻服务（默认端口 3005），并引导 Kuma 容器
  ensure         只确保 Docker 就绪 + Kuma 容器运行，完成后退出
  status         打印 Docker / 容器 / Kuma / 通知通道状态
  logs           查看 Kuma 容器日志
                 --tail N       日志行数（默认 100）
  stop-kuma      停止 Kuma 容器（监控暂停，数据保留）
  restart-kuma   重启 Kuma 容器

环境变量:
  SITE_MONITOR_PORT   网关端口（默认 3005）
  DOCKER_BIN          docker 可执行文件路径（自动探测失败时手动指定）
  MAIL_APP_CLI        mail-app 的 cli.mjs 路径（自动探测失败时手动指定）

配置文件: ~/Library/Application Support/xingseq/site-monitor/config.json
          （Kuma 镜像 tag / 宿主端口 / 容器名 / 数据目录 / 通知收件人均在此修改，支持热重载）
监控数据: ~/Library/Application Support/xingseq/site-monitor/kuma-data/
`)
}

switch (command) {
  case 'gateway': {
    const { startGateway } = await import('./gateway.mjs')
    await startGateway()
    break
  }
  case 'ensure':
    await runEnsure()
    break
  case 'status':
    await runStatus()
    break
  case 'logs':
    await runLogs()
    break
  case 'stop-kuma':
    await runContainerOp('stop')
    break
  case 'restart-kuma':
    await runContainerOp('restart')
    break
  case '--help':
  case '-h':
  case undefined:
    showHelp()
    break
  default:
    console.error(`未知命令: ${command}\n`)
    showHelp()
    process.exit(1)
}
