# dsh-desktop-restart

给 **DeepSeek Harness 桌面版（Electron）** 用的重启插件：在 设置 → 通用 里加一行按钮，点一下重启整个应用。

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

1. 设置页那一行向本插件自己的宿主路由发一个同源 POST。
2. 宿主半校验请求、写下交接描述，然后用 `process.execPath`（就是桌面应用本身）+ `ELECTRON_RUN_AS_NODE=1` 拉起一个**分离的 helper**，并立刻回 202。helper 因此不依赖系统 Node，也不依赖 `dsh` 在 PATH 里。
3. helper 等 1.5 秒让响应先送达浏览器，然后结束 **Electron 主进程** —— 故意不带 `/T`：host 子进程必须活下来，才能在 IPC 断开后走自己的优雅关闭（`application.shutdown`），把会话日志正常落盘。带 `/T` 会把 host 一起强杀，那才会真丢数据。
4. helper 等主进程消失，再等监听端口释放（用「连接」探测，不用「绑定」—— 试探性绑定恰恰会占住替代进程要用的那个端口）。
5. 端口迟迟不放时兜底：按映像名清掉残留的桌面进程（helper 自己排除在外）。
6. helper 用干净的环境拉起新实例 —— 必须去掉 `ELECTRON_RUN_AS_NODE`，否则新的「应用」会以 Node 模式启动，变成一个没有窗口的进程。

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

**为什么无 `Origin` 也放行**：桌面版的页面以 `dsh-app://` 协议装载，页面里的 `fetch('/…')` 由壳层转发到宿主端口，这种转发的请求**不带 `Origin`**。若直接要求 `Origin`，桌面版里这个按钮会永远返回 403 —— 这也正是插件市场里 `dsh-simple-restart` 在桌面版失效的原因之一。所以无 `Origin` 时改为要求其余每一条都成立（回环对端、回环 Host、无代理痕迹、`Sec-Fetch-Site` 缺省或 `same-origin`）。

## 已知限制

- **只适用于 Electron 桌面版。** 在 `dsh web` 上状态路由会如实报 `desktop: false`，重启按钮禁用；这是设计如此，不是故障。
- **强杀主进程。** 主进程自身的清理（窗口状态、托盘）不会执行。真正要紧的会话数据在 host 进程里，它会优雅关闭。这是「一键」必须付的代价 —— 主进程没暴露任何可请求的重启通道。
- **DSH 升级后可能失效。** 实现依赖当前的进程模型与 `ELECTRON_RUN_AS_NODE` 约定；若上游改变 host 的启动方式或给主进程加上重启 IPC，应改用官方通道。
- **只在 Windows 上验证过。**

## 诊断

每次重启的交接描述与 helper 日志写在 `~/.dsh/desktop-restart/`：

```
restart-<时间戳>.log       helper 的完整诊断
handoff-<时间戳>.json      这次交接的目标与参数
```

正常的一次重启，日志形如：

```
helper started: helper=… host=… main=… port=19387 exe=…\DeepSeek Harness.exe
ending the Electron main process … without /T, so the host can close gracefully
taskkill /PID … /F ok
main process exited
port 19387 released
relaunched "…\DeepSeek Harness.exe" as pid …
```

## 开发

```sh
node scripts/smoke.mjs
```

离线冒烟测试：宿主半用桩上下文加载，只验证路由守卫与全部拒绝路径；helper 只走「映像名不匹配」的拒绝分支。**它不会重启任何东西。**

## 许可证

MIT
