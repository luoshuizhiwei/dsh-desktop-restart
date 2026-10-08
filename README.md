# dsh-desktop-restart

给 **DeepSeek Harness 桌面版（Electron）** 用的重启插件：会话标题栏上常驻一个「⟳ 重启」，另外还有 `/restart-desktop` 斜杠命令与 设置 → 通用 那一行备用入口，点一下重启整个应用。

和插件市场里那类「重启 dsh web」的插件不同 —— 那些在桌面版里不能用，原因见下。

## 为什么需要它

桌面版的进程模型和终端里的 `dsh web` 完全不同：

```
DeepSeek Harness.exe            ← Electron 主进程：窗口、托盘、自动更新
  └── DeepSeek Harness.exe      ← host 子进程（同一个 exe + ELECTRON_RUN_AS_NODE=1）
        └── 本插件               跑 dsh-desktop-host，监听 127.0.0.1:19387
```

于是两件事同时成立：

1. **host 自己退出 ≠ 重启应用。** 主进程把子进程退出当成故障，弹「启动失败」恢复框（默认按钮是「重启应用」）——能用，但每次都要人点一下。
2. **主进程没给插件留重启通道。** 完整的 IPC 只有 `shutdown` / `quit-inspection` / `update-tasks`（主进程 → host）与 `ready` / `fatal` / `shutdown-complete` / `platform-session`（host → 主进程）；渲染进程侧的 `DESKTOP_IPC` 表里也没有 restart。内置的「重启应用与 Host」菜单项只在 development 下加入菜单，而 Windows 上应用菜单栏只有 devTools，托盘菜单只有「打开应用」和「退出」。

所以一键重启只能由**宿主之外**的进程完成。

## 它怎么工作

1. 入口向本插件自己的宿主路由发一个同源 POST。
2. 宿主半先**看清状态**：现在有没有在跑的任务、有没有安装/更新正在写这个 profile（见下「动手之前先看清楚状态」）。有就先只回一份警告，要调用方带 `?force=1` 再来一次。
3. 校验通过后写下交接描述，然后用 `process.execPath`（就是桌面应用本身）+ `ELECTRON_RUN_AS_NODE=1` 拉起一个**分离的 helper**，并立刻回 202。helper 因此不依赖系统 Node，也不依赖 `dsh` 在 PATH 里。
4. helper 等 1.5 秒让响应先送达浏览器，趁主进程还活着问一次它的命令行与可执行文件路径（重启要带上原参数，兜底强杀也要按路径认人）。
5. helper 结束 **Electron 主进程** —— 故意不带 `/T`：host 子进程必须活下来，才能在 IPC 断开后走自己的优雅关闭（`application.shutdown`），把会话日志正常落盘。带 `/T` 会把 host 一起强杀，那才会真丢数据。
6. helper 等主进程消失，再等监听端口释放（用「连接」探测，不用「绑定」—— 试探性绑定恰恰会占住替代进程要用的那个端口）。
7. 端口迟迟不放时兜底：只清掉**同一份可执行文件**的残留进程（helper 自己排除在外）；路径一条都拿不到时才退回按映像名匹配。
8. helper 用干净的环境拉起新实例 —— 必须去掉 `ELECTRON_RUN_AS_NODE`，否则新的「应用」会以 Node 模式启动，变成一个没有窗口的进程。新实例立刻退出就再试（默认 3 次），试完还不行才认输，并弹一个窗叫人手动打开 —— 否则用户只会看到窗口再也没回来，而日志里写着「已拉起」。
9. 交接目录只保留最近 20 组 handoff/log，旧的自动清掉。

## 动手之前先看清楚状态

「能重启」不等于「该重启」。应用自己的退出流程会先问宿主「现在停掉会打断什么工作」（`hasDesktopActiveTasks`：正在生成或跑工具的智能体、排队中的消息、正在跑或正在停的后台任务），有就弹窗问用户；而本插件走的是直接结束主进程，绕过了那道检查。于是补上等价的两道守卫：

| 守卫 | 判据 | 覆盖范围 |
| --- | --- | --- |
| 有任务在跑 | `agents` + `jobs` 两个服务，判据与应用自己的一致 | 所有会话、子智能体、专家团、任务板运行、后台任务 |
| 插件正在安装/更新 | `<profile>/.plugin-manager/run.json` 存在（应用自己记「有个 pnpm 运行正在写这个 profile」的凭据） | 内置插件管理、插件市场（它转发给 `pluginManager` 服务）、任何 `dsh plugin` 操作 |

两者都**只警告、不硬拦**：第一次请求回 `409` 与一份「会打断什么」，客户端把它摆出来并要求再点一次，第二次才带 `?force=1`。之所以不硬拦，是因为 `run.json` 在崩溃后会残留（应用自己也只等 5 秒就放弃），硬拦会把重启按钮永久锁死 —— 那正是 2026-10-06 修过的死锁类型。

## 安装

### 从 npm

```sh
dsh plugin add @luoshuizhiwei/dsh-desktop-restart
```

### 从源码

包放在 `~/.dsh/local-plugins/dsh-desktop-restart`，通过 profile 清单挂载：

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": {
    "@luoshuizhiwei/dsh-desktop-restart": "link:../../local-plugins/dsh-desktop-restart"
  },
  "dsh": { "profile": { "bundles": [ "...", "@luoshuizhiwei/dsh-desktop-restart" ] } }
}
```

在较早的桌面版上，`desktop` profile 由 Electron 应用独占管理，`dsh plugin --profile desktop add` 会被拒绝（`profile "desktop" is managed exclusively by the Electron application`），此时需要手工声明依赖与 bundle；`node_modules` 下的对应项是一个指向源码目录的 junction。

装好后**重启一次应用**才会加载 —— 这第一次得手动（插件还没跑起来）。

## 使用

三个入口，都走同一条受守卫的路径：

1. **会话标题栏按钮** —— 会话页抬头右侧的「⟳ 重启」，常驻可见，最顺手；
2. **斜杠命令** —— 在输入框里打 `/restart-desktop` 回车；
3. **设置 → 通用 → 重启桌面应用** —— 备用入口。

按钮类入口是两步确认：第一次点击武装（`确认重启？`），5 秒内第二次点击才执行；斜杠命令直接执行。随后页面断开，应用重启，页面在新进程就绪后自行恢复。

**有任务在跑时会多一步**：第二次点击不会立刻重启，而是显示「仍要重启？」并写清会打断什么（`有任务在跑（2 个回合正在生成或跑工具、1 个后台任务在跑）`）。那一步还有 0.9 秒冷却，连点越不过去；确认后才会真的重启。斜杠命令在同样情况下只回错误并提示 `/restart-desktop --force`。两个入口在挂载时也会把当前状态写在提示里，按之前就能看见。

## 安全模型

`POST /dsh-desktop-restart/api/restart` 在动手之前完成全部校验：

| 检查 | 拒绝方式 |
| --- | --- |
| 方法不是 POST | `405`，带 `Allow: POST` |
| TCP 对端不是回环地址 | `403` |
| `Host` 不是回环名字 | `403` |
| 带 `forwarded` / `x-forwarded-for` / `x-real-ip` | `403` |
| 无 `Origin` 时 `Sec-Fetch-Site` 不是 `same-origin` | `403` |
| 有 `Origin` 但其 host 不等于 `Host` | `403` |
| 当前宿主不是 Electron 桌面版 | `409` |
| `config.enabled` 为 false | `403` |
| 已有一次重启在交接中 | `409` |
| 有任务在跑 / 正在安装，且没带 `?force=1` | `409` + 一份 `guard`（只含计数与人话，不含任何路径） |

顺序是有意的：`enabled` → 是不是桌面版 → 是否已在交接中，这三条是**硬拒绝**，`force` 绕不过去；守卫排在最后，它问的是「要不要继续」，`force` 才是它的答案。

**为什么无 `Origin` 也放行**：桌面版的页面以 `dsh-app://` 协议装载，页面里的 `fetch('/…')` 由壳层转发到宿主端口，这种转发的请求**不带 `Origin`**。若直接要求 `Origin`，桌面版里这个按钮会永远返回 403 —— 这也正是插件市场里 `dsh-simple-restart` 在桌面版失效的原因之一。所以无 `Origin` 时改为要求其余每一条都成立（回环对端、回环 Host、无代理痕迹、`Sec-Fetch-Site` 缺省或 `same-origin`）。

## 已知限制

- **只适用于 Electron 桌面版。** 在 `dsh web` 上状态路由会如实报 `desktop: false`，重启按钮禁用；这是设计如此，不是故障。
- **守卫只提醒，不阻止。** 确认后照旧会打断正在跑的回合与后台任务；正在写的文件可能停在半路，插件不做回滚。正常退出（关窗口/托盘退出）会先弹窗问你，重启按钮则要你自己看那份警告。
- **强杀主进程。** 主进程自身的清理（窗口状态、托盘）不会执行。真正要紧的会话数据在 host 进程里，它会优雅关闭。这是「一键」必须付的代价 —— 主进程没暴露任何可请求的重启通道。
- **重启带上原始启动参数**（`--user-data-dir` 这类），但拿不准就不带：命令行查不到、不是同一个可执行文件、带转义引号、或看起来是 Chromium 子进程/host 的命令行时，一律退回「不带参数拉起」。工作目录固定为可执行文件所在目录。
- **应用自动更新途中重启没有守卫。** 更新流程没有留下可读的状态凭据，这一条只能靠别在更新时点重启。
- **DSH 升级后可能失效。** 实现依赖当前的进程模型与 `ELECTRON_RUN_AS_NODE` 约定；守卫依赖 `agents` / `jobs` 服务与 `.plugin-manager/run.json`，取不到时会静默跳过守卫（而不是拦住重启）。若上游改变 host 的启动方式或给主进程加上重启 IPC，应改用官方通道。
- **只在 Windows 上验证过。**

## 诊断

每次重启的交接描述与 helper 日志写在 `~/.dsh/desktop-restart/`（只保留最近 20 组）：

```
restart-<时间戳>.log       helper 的完整诊断
handoff-<时间戳>.json      这次交接的目标与参数
```

正常的一次重启，日志形如：

```
helper started: helper=… host=… main=… port=19387 exe=…\DeepSeek Harness.exe
preserving 0 launch argument(s): []
ending the Electron main process … without /T, so the host can close gracefully
taskkill /PID … /F ok
main process exited
port 19387 released
relaunched "…\DeepSeek Harness.exe" as pid …
relaunched process (pid …) is still alive after 2500ms
the new instance is listening on port 19387 — restart complete
```

拉不起来时不会谎报成功：

```
the relaunched process (pid …) is already gone — attempt 1 did not take
relaunch attempt 2/3 in 1500ms
the restart did not take after 3 attempt(s); the application is not running
failure notice dispatched to the user
```

## 开发

```sh
node scripts/smoke.mjs
```

离线冒烟测试（48 项）：宿主半用桩上下文加载，只验证路由守卫与全部拒绝路径；守卫的判据（任务快照、安装记录、路径过滤、命令行分词）是纯函数，直接单测；helper 只走「映像名不匹配」与「拉起来又立刻退出」两条分支（测试里 `alertOnFailure: false`，不会弹窗）。**它不会重启任何东西。**

## 许可证

MIT
