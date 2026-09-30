# site-monitor（站点监控）

XingSeq 外挂子应用：把 [Uptime Kuma](https://github.com/louislam/uptime-kuma) 封装成一键安装的站点监控服务。

网站探测、失败重试、可用率统计、SSL 证书到期检测全部由 Kuma 承担；本子应用只做三件薄封装：

1. **容器管家** — 检测 Docker 就绪（未启动则自动拉起 Docker Desktop）、拉取镜像、创建/启动/升级 Kuma 容器
2. **通知桥** — 接收 Kuma 的 Webhook 告警，限流去重后经 mail-app 发邮件
3. **管理面板** — 容器状态、通知配置、告警历史与日志，并内嵌 Kuma 原生界面

## 前置依赖

| 依赖 | 必需 | 说明 |
|---|---|---|
| Docker Desktop | 是 | Kuma 以容器方式运行。未启动时子应用会尝试自动拉起（macOS） |
| mail-app（邮件子应用） | 否 | 告警邮件发送通道。缺失时监控与 Kuma 面板仍正常工作，只是不发邮件 |

## 安装

**方式一：XingSeq 控制台应用商店**（推荐）— 搜索「站点监控」→ 安装。

**方式二：本地开发安装**

```bash
git clone https://github.com/xingseq/site-monitor
cd site-monitor
./install.sh          # 构建前端 + 复制到 skill-host 安装目录
./install.sh --remove # 卸载（保留 Kuma 监控数据）
```

安装后重启 XingSeq 控制台（或刷新子应用列表），左侧会出现「站点监控」。

## 首次使用

1. 打开控制台里的「站点监控」。**首次启动需拉取约 600MB 镜像**，「运行状态」页会显示进度，请耐心等待
2. 就绪后切到「监控面板」。Kuma 2.x 首次运行是两步向导：
   - 先选数据库 —— 保持默认的 **SQLite** 直接点继续即可（数据落在本机数据目录，无需装数据库）
   - 再创建管理员账号（本地使用，自行设置即可）
3. `Add New Monitor` → 填网址 → 心跳间隔建议 60 秒 → 保存
4. 配置告警通知（见下）

## 配置邮件告警

**第一步：在本子应用「通知设置」页填写收件邮箱，保存**

**第二步：在 Kuma 里配置 Webhook（一次性）**

1. 「监控面板」右上角头像 → `Settings` → `Notifications` → `Setup Notification`
2. `Notification Type` 选 `Webhook`
3. `Webhook URL` 粘贴「通知设置」页提供的地址（默认 `http://host.docker.internal:3005/api/webhook/kuma`，可一键复制）
4. 勾选 `Apply on all existing monitors` → 保存

之后站点挂掉发「🔴 站点异常告警」，恢复发「🟢 站点已恢复」。同一站点同一状态默认 10 分钟内只发一封（可在通知设置里调整，填 0 关闭限流）。

> 你也可以在 Kuma 里直接配置 Telegram、Server 酱等其他通知渠道——本桥接只负责邮件这一路。

## 端口

| 用途 | 端口 |
|---|---|
| 管理网关（本子应用） | 3005 |
| Uptime Kuma 界面 | 3004（仅绑定 127.0.0.1，不暴露到局域网） |
| 前端开发服务器 | 5182 |

## 配置文件

`~/Library/Application Support/xingseq/site-monitor/config.json`

```jsonc
{
  "kuma": {
    "image": "louislam/uptime-kuma:2.5.5",   // 改 tag 并保存即触发升级
    "containerName": "xingseq-uptime-kuma",
    "hostPort": 3004,
    "dataDir": ".../site-monitor/kuma-data"  // Kuma 的 SQLite 数据库
  },
  "notify": {
    "enabled": true,
    "email": { "to": "you@example.com" },
    "mailAppCli": ""                         // 留空自动探测 mail-app
  },
  "bridge": { "rateLimitMinutes": 10 }
}
```

支持**热重载**：手改文件保存后自动生效。改 `kuma.*` 字段会自动重建容器（数据卷不变，监控项与历史保留）；改 `notify.*` / `bridge.*` 立即生效，不动容器。也可以在「通知设置」页用表单编辑。

## 升级 Kuma

在「通知设置」页把镜像 tag 改成新版本（如 `louislam/uptime-kuma:2.6.0`）并保存即可：自动 pull 新镜像 → 停掉旧容器 → 用同一数据目录重建。

大版本升级前建议备份数据目录：

```bash
cp -R ~/Library/Application\ Support/xingseq/site-monitor/kuma-data ~/Desktop/kuma-backup
```

## 命令行

```bash
node src/cli.mjs gateway       # 启动网关常驻服务（控制台 startCommand 用这个）
node src/cli.mjs ensure        # 只确保 Docker + Kuma 容器就绪，完成后退出
node src/cli.mjs status        # 打印 Docker / 容器 / Kuma / 通知通道状态
node src/cli.mjs logs --tail 200   # Kuma 容器日志
node src/cli.mjs stop-kuma     # 停止容器（监控暂停，数据保留）
node src/cli.mjs restart-kuma  # 重启容器
```

环境变量：`SITE_MONITOR_PORT`（网关端口）、`DOCKER_BIN`（docker 路径）、`MAIL_APP_CLI`（mail-app 的 cli.mjs 路径）。

## 数据位置

- 配置：`~/Library/Application Support/xingseq/site-monitor/config.json`
- 监控数据：`~/Library/Application Support/xingseq/site-monitor/kuma-data/`
- 告警历史：`~/Library/Application Support/xingseq/site-monitor/alerts.jsonl`

数据目录刻意放在**安装目录之外**：子应用更新（卸载+重装）或从商店移除，都不会丢失 Kuma 里的监控项与历史记录。彻底清理需手动删除该目录并执行 `docker rm -f xingseq-uptime-kuma`。

## 已知限制

- **电脑关机 / 休眠期间监控中断**。容器设了 `--restart unless-stopped`，Docker Desktop 启动后会自动恢复；如需 7×24 不间断，应把 Kuma 部署到常开的服务器上
- 首次启动镜像拉取耗时数分钟，期间「监控面板」显示尚未就绪（会自动刷新），可在「告警日志」页看到拉取进度
- 仅支持 macOS 自动拉起 Docker Desktop；Linux 需自行确保 Docker 服务在运行
- 关闭控制台不会停止 Kuma 容器（这是设计如此：监控不能因关掉面板而中断）。需要停止请用「告警日志」页的「停止容器」按钮或 `stop-kuma` 命令

### 镜像拉取卡住不动（Docker Hub 访问受限）

若「网关日志」长时间停在 `pull:` 进度且无变化，通常是 Docker Hub 直连不通。两种解法：

**A. 走国内加速源手动拉一次**（不改任何全局配置）

```bash
docker pull docker.m.daocloud.io/louislam/uptime-kuma:2.5.5
docker tag  docker.m.daocloud.io/louislam/uptime-kuma:2.5.5 louislam/uptime-kuma:2.5.5
```

打上官方 tag 后，网关检测到本地已有该镜像就不会再 pull，回到「运行状态」页点「重新引导」即可。

**B. 给 Docker Desktop 配代理或加速器**（一劳永逸，升级新版本也自动生效）

Docker Desktop → `Settings` → `Resources` → `Proxies` 填你的代理，或 `Docker Engine` 里加 `registry-mirrors`，改完重启 Docker Desktop。

## License

MIT
