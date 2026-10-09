# dsh-desktop-restart

给 **DeepSeek Harness 桌面版（Electron）** 用的重启插件：**左侧边栏左上角**有一个「重启桌面应用」入口（挂在官方给插件留的面板座位上 —— 那一行由侧栏自己绘制，所以外观就是官方的），**侧栏底部**还有一个入口，会话标题栏上还有一个按钮，另外还有 `/restart-desktop` 斜杠命令与 设置 → 通用 那一行。哪个入口要、哪个不要，都由设置里「重启桌面应用」那一栏自己决定。

顺带它还管一件事：DSH 被硬杀时漏在系统 Temp 里的「改动快照」目录，启动时自动清掉（同样可以在设置里关掉，见「顺手清掉别人漏下的临时快照」）。

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
7. 端口迟迟不放时兜底：先清掉**同一份可执行文件**的残留进程（helper 自己、主进程、以及 **host** 都排除在外）；路径一条都拿不到时才退回按映像名匹配。清完端口若仍被占，说明卡住的正是 host —— 它本该自己退出 —— 这时才**单独**结束它，并在日志里写明这是最后手段、它的会话日志可能不完整（见「已知限制」）。
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

五个入口，都走同一条受守卫的路径：

1. **左侧边栏左上角的「重启桌面应用」** —— 挂在官方给第三方插件的面板座位（`sidebar.panellist` + `main`），**那一行由侧栏自己绘制**，所以外观就是官方的；点一下会在主区打开重启面板，面板里再点「重启」；
2. **左侧边栏底部的「重启桌面应用」** —— 官方给第三方插件的动作座位（42px 动作行，侧栏收起时变 36×36 圆形），点两次即可重启；
3. **会话标题栏按钮** —— 会话页抬头右侧那个刷新图标 + 「重启」；
4. **斜杠命令** —— 在输入框里打 `/restart-desktop` 回车；
5. **设置 → 通用 → 重启桌面应用** —— 备用入口。

按钮类入口是两步确认：第一次点击武装（`确认重启？`），5 秒内第二次点击才执行；斜杠命令直接执行。随后页面断开，应用重启，页面在新进程就绪后自行恢复。

**有任务在跑时**：第二次点击不会立刻重启，而是弹出**官方的风险确认框**（警告 + 显式勾选 + 确认按钮，勾选前确认按钮不可用），写清会打断什么（`有任务在跑（2 项正在生成或运行工具、1 个后台任务在跑）`）。斜杠命令在同样情况下只回错误并提示 `/restart-desktop --force`。几个入口在挂载时也会把当前状态写在提示里，按之前就能看见。（万一拿不到官方组件，退回内联警告态 + 0.9 秒冷却。）

**界面语言**（2026-10-08 第三轮）：直接用**官方标准件**，不是照着画的。

- **左上角那一条挂在官方的面板座位上**（`sidebar.panellist`，官方给第三方插件的面板座位）：插件只登记 `id / order / 文案` 和一个图标组件，**整行（按钮、tooltip、文字、active 态、收起态）都由侧栏自己绘制** —— 所以它不可能不像官方。点一下会把主区切到同名的 `main` 面板，面板里用官方 `Button`（primary）触发重启。
- **左侧边栏底部那个入口挂在官方座位 `sidebar.footer.action` 上**（应用自己的插件面板也在那里），并照抄同座位占用者（官方插件面板 / `dsh-diff-approval`）的 42px 动作行：`height:42px`、`border-radius:12px`、`gap:8px`、`padding:0 10px 0 8px`、14px/22px、hover / active 加 `--dsw-alias-interactive-bg-hover` 底色；侧栏收起成 rail 时变 36×36 圆形（座位会把 `{ wide }` 传进来）。
- 标题栏按钮照抄同一个座位里官方那个真实按钮（`ui-jobs` 的 `JobListAction`）：`min-height:28px`、`--dsw-radius-sm`、`padding:3px 2px`、`gap:3px`、`12px/18px`、字色 `--dsw-alias-label-tertiary`，hover / focus 只把字色提到 `--dsw-alias-label-secondary`（不加底色）；窄窗口 540px 以下只留图标。
- 设置页按钮用官方 `Button`（`variant="ghost"`）；图标用官方 `IconRefreshOutlineRegular`（应用自己也是 size 14）；**会打断工作时的确认用官方 `RiskConfirmation`** —— 警告 + 显式勾选 + 确认按钮，勾选前确认按钮不可用。
- 颜色语义用官方 token：普通确认只做中性强调，会打断工作是 `--dsw-alias-state-warn-primary`，失败才是 `--dsw-alias-state-error-primary`，成功是绿色；交接期间图标转圈（系统开了「减少动效」就不转）。
- 官方组件在 `dsh.client.inject` 里声明后由加载器先注册再执行本插件；万一 DSH 改名或挪包导致 require 失败，会退回自己那份**逐字照抄官方数值**的样式，界面不会崩。

完整对照（含官方逐字 CSS 与官方源码路径）见 `docs/official-ui-standard.md`。

## 自己决定用哪些入口

插件自带一个**设置分区**（设置里找到「重启插件」那一栏），里面四个开关 —— 改完**立即生效**，不用重启或刷新：

| 开关 | 关掉之后 |
| --- | --- |
| 左上角的面板入口 | 侧栏左上角那一条消失（连带主区那个重启面板） |
| 侧栏底部的入口 | 侧栏底部那一条消失 —— 它和同座位里别的插件条目可能挤在一起，真挤了就关这个 |
| 会话标题栏按钮 | 会话页抬头右侧那个按钮消失 |
| 设置 → 通用 那一行 | 通用设置页里的备用入口消失 |

选择存在**本机浏览器**（`localStorage`）；**默认值**来自插件的 config —— 在
`~/.dsh/profiles/<profile>/cordis.patch.yml` 里本插件那一行写
`config: { panel: false, footer: false, header: false, settingsRow: false, command: false, enabled: false }`
可以一次改掉默认值（`command` 是 `/restart-desktop` 斜杠命令，`enabled` 是总开关）。

## 顺手清掉别人漏下的临时快照

DSH 内置的「改动快照」（界面上那些「本轮改了哪些文件」卡片就是它渲染的）每开一个会话，就把工作目录快照一份到系统 Temp，会话关闭或应用**正常退出**时删掉。应用被硬杀（任务管理器结束 host、崩溃、断电）时没人删 —— 2026-10-09 的一次 C 盘体检就在 Temp 里清出 25 个这样的目录、共 10.9 GB。

本插件顺手接管这件事：**启动后 10 秒**（异步，不抢启动 I/O）扫一次系统 Temp，删掉判定为孤儿的目录。下面几条**同时成立**才动手：

| 条件 | 为什么 |
| --- | --- |
| 名字是 `dsh-workspace-changes-` 前缀 | 不碰 Temp 里任何别的东西 |
| 是个目录 | 同前缀的文件不动 |
| 创建时间早于本次宿主启动 | 本次进程里的会话目录都是启动之后才建的 |
| 自本次宿主启动以来没被写过 | 还有人在往里写，说明它不孤单 |
| 而且已经躺够 24 小时 | 给「同时开着第二个实例」留余量 |

开关在 **设置 → 插件 → 重启桌面应用** 里（插件自己的设置分区），默认开启；那一行还有个「立即清理」，可以随时手动清一次。开关存在宿主侧（`~/.dsh/desktop-restart/settings.json`），因为清理必须发生在客户端连上来之前；关掉之后宿主一个字节都不动。

「立即清理」用的是**同一套判定**，不会因为手点就放宽 —— 所以刚崩掉留下的目录当天清不掉，要等满 24 小时。这是有意的：那个年龄门槛正是用来区分「孤儿」和「另一个实例里还活着的会话」的。

**已知边界**：同时开着第二个 DSH 实例（比如终端里的 `dsh web`）时，那个实例里**完全空闲超过 24 小时**的会话目录会被误判成孤儿。代价是那个实例该会话的改动对比卡片失效（目录里只是快照副本，不动任何用户数据），重启那个实例即可恢复。要彻底避免只能等上游把退出清理修好。

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

`POST /dsh-desktop-restart/api/sweep`（清理开关与手动清理）与状态路由同一套门槛：非 `POST` 回 `405`、不可信来源回 `403`，参数只认 `?enabled=0|1` 与 `?run=1`（用查询参数而不是请求体，理由同上）。它能删的东西被上面那五条判定卡死 —— 拿不准就一个都不删。

## 已知限制

- **只适用于 Electron 桌面版。** 在 `dsh web` 上状态路由会如实报 `desktop: false`，重启按钮禁用；这是设计如此，不是故障。
- **守卫只提醒，不阻止。** 确认后照旧会打断正在跑的回合与后台任务；正在写的文件可能停在半路，插件不做回滚。正常退出（关窗口/托盘退出）会先弹窗问你，重启按钮则要你自己看那份警告。
- **强杀主进程。** 主进程自身的清理（窗口状态、托盘）不会执行。真正要紧的会话数据在 host 进程里，它会优雅关闭。这是「一键」必须付的代价 —— 主进程没暴露任何可请求的重启通道。
- **兜底清理最后会结束 host，那一瞬间它的会话日志可能不完整。** 只在一种情况下发生：主进程已经结束、端口等了 30 秒还没释放 —— 那说明 host 卡住了，不结束它新实例就绑不上端口。它不会被混在「残留进程」里顺手杀掉，日志里会单独写明。正常情况下端口 1 秒内就释放，这条路径走不到。
- **主进程是靠 `process.ppid` 认定的**（host 的父进程就是它），再用映像名复核一次。若上游改成别的启动方式，或 pid 被回收后恰好被另一个同名程序占用，理论上可能认错目标；复核不过就拒绝动手，不会乱杀。
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

离线冒烟测试（75 项）：宿主半用桩上下文加载，只验证路由守卫与全部拒绝路径；守卫的判据（任务快照、安装记录、路径过滤、命令行分词）是纯函数，直接单测；孤儿快照的判定是纯函数（含「启动后才建」「启动后被写过」「太年轻」三个反例），删除本身在临时目录里真跑一遍；客户端那半校验包身份、注入写法、尺寸与配色对齐官方、颜色语义与无障碍属性；helper 走「映像名不匹配」「拉起来又立刻退出」「问不出进程表」「端口迟迟不放」四条分支（最后一条用测试自己拉起的替身进程当 host、自己占住的端口当被占端口，且 `alertOnFailure: false` 不弹窗）。**它不会重启任何东西**，也不会碰真实的系统 Temp（清理相关的用例都把 `TMP`/`TEMP` 与 `DSH_HOME` 指向本次测试的临时目录），自己建的临时目录还会在退出时删干净（2026-10-09 之前每跑一次就往系统 Temp 里留 5 个空目录）。

## 许可证

MIT
