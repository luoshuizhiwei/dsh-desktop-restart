# 官方界面标准（从安装包里提取）

本文件是从**本机安装的 DSH 桌面版**（`resources/app.asar`，运行时 0.2.0-rc.2）里提取的官方界面标准，
用于让本插件的界面和官方保持一致。所有数值都是**逐字抄录**，不是我的推测。

提取方式：`E:\dsh-asar-probe\asar.cjs`（只读解析 app.asar 的头部索引，按路径取文件）。
官方源码路径写在每段前面 —— 那是应用自己的 `packages/client/*/src/...`。

## 1. 官方共享组件库：`@deepseek-ai/dsh-client-ui-primitives`

应用自己有一份共享组件库，`lib/` 下是 **39 个可直接阅读的 `.module.css`**：

| 文件 | 用途 |
| --- | --- |
| `Button.module.css` | 按钮（primary / ghost / outline / toolbar 四种变体，md / sm 两种尺寸） |
| `Pill.module.css` | 紧凑胶囊（可交互 / 选中态） |
| `Tag.module.css` | 标签 |
| `StateDot.module.css` | 状态点与旋转指示器（done / warning / error / idle） |
| `RiskConfirmation.module.css` | 破坏性操作的确认模态（警告块 + 显式勾选） |
| `Modal.module.css`、`Menu.module.css`、`MenuSurface.module.css`、`Tooltip.module.css`、`Toast.module.css` | 浮层与提示 |
| `SegmentedControl.module.css`、`Switch.module.css`、`Input.module.css`、`Checkbox.module.css` | 控件 |
| `settings-form/SettingsForm.module.css`、`settings-form/fields.module.css` | 设置页表单 |

组件清单（README.zh.md）：`Button`、`Switch`、`SegmentedControl`、`SegmentedTabs`、`Pill`、`Tag`、
`Menu`/`MenuGroup`/`MenuSurface`、`Modal`、`Tooltip`、`Toast`、`StateDot`、`DisclosureRow`、`HoverCard`、
`ShortcutKeys`、`Input`、`Checkbox`、`CodeCard`、`DiffBlock`、`TerminalBlock`、`JsonTree`、`WebBlock`、
`SearchBlock`、`ReadBlock`、`PathLabel`、`FileTypeIcon`、`ConnectionIndicator`、`RiskConfirmation` 等。

### 1.1 `Button.module.css`（逐字）

```css
.button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: none;
  border-radius: var(--dsw-radius-md);
  cursor: pointer;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  padding: 0 14px;
}
.button:disabled { cursor: not-allowed; opacity: 0.4; }
.md { height: 36px; }
.sm { height: 28px; font-size: 12px; line-height: 18px; padding: 0 10px; border-radius: var(--dsw-radius-sm); }
.primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ghost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.outline { border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; }
.outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.toolbar { background: var(--dsw-alias-button-tool-bar-fill); }
.toolbar:hover:not(:disabled) { background: var(--dsw-alias-button-tool-bar-hover); }
.icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; }
```

README 里的尺寸规则：**`Button` 的 `md` 是 H36/R12，`sm` 是 H28/R8**（R = 圆角半径）。

### 1.2 标题栏动作按钮（同一个座位里的真实按钮）

来源：`packages/client/ui-jobs/src/client/JobListAction.module.css` —— 它就是会话标题栏
`conversation.session.header.actions` 座位里那个「N 个后台任务」入口，`order: 20`。

```css
.root { position: relative; }
.trigger {
  border-radius: var(--dsw-radius-sm);
  min-height: 28px;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  background: 0 0;
  border: 0;
  align-items: center;
  gap: 3px;
  padding: 3px 2px;
  font-size: 12px;
  line-height: 18px;
  display: inline-flex;
}
.trigger:hover,
.trigger:focus-visible { color: var(--dsw-alias-label-secondary); }
.trigger svg { transition: transform .12s; }
.triggerOpen { transform: rotate(180deg); }
.triggerDot { flex: none; }
.count { margin: 0 5px; }
```

要点：**hover / focus-visible 只把字色从 tertiary 提到 secondary，不加任何底色**；
高度是 `min-height: 28px`（不是 22px）；圆角 `--dsw-radius-sm`；内边距 `3px 2px`；间距 `3px`。

### 1.3 `Pill.module.css`（紧凑胶囊）

```css
.pill {
  display: inline-flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 8px;
  border: none; border-radius: 999px; corner-shape: round;
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.interactive { cursor: pointer; }
.interactive:hover { background: var(--dsw-alias-interactive-bg-hover); }
.active {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-button-ghost-active-fill);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border);
}
```

### 1.4 `StateDot.module.css`（状态点与旋转指示器）

```css
/* 10px 槽位里画一个 6px 的实心点（inset:20%），颜色取 currentColor */
.dot { position: relative; display: inline-block; flex: none; }
.dot::after { content: ''; position: absolute; inset: 20%; border-radius: 50%; corner-shape: round; background: currentColor; }
.dot[data-state='done']    { color: var(--dsw-alias-state-success-primary); }
.dot[data-state='warning'] { color: var(--dsw-alias-state-warn-primary); }
.dot[data-state='error']   { color: var(--dsw-alias-state-error-primary); }
.dot[data-state='idle']    { color: var(--dsw-alias-state-idle-primary); }

.spinner { flex: none; color: var(--dsw-alias-label-tertiary); }
.spinnerMotion { transform-origin: center; animation: dsh-state-dot-spin 1.5s linear infinite; }
.spinnerTrack, .spinnerArc { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.spinnerTrack { opacity: 0.25; }
.spinnerArc { stroke-dasharray: 12 150; animation: dsh-state-dot-dash 1.5s ease-in-out infinite; }
@keyframes dsh-state-dot-spin { to { transform: rotate(360deg); } }
@keyframes dsh-state-dot-dash {
  0%   { stroke-dasharray: 12 150; stroke-dashoffset: 0; }
  50%  { stroke-dasharray: 24 150; stroke-dashoffset: -6; }
  100% { stroke-dasharray: 12 150; stroke-dashoffset: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .spinnerMotion, .spinnerArc { animation: none; }
  .spinnerArc { stroke-dasharray: 18 150; stroke-dashoffset: -3; }
}
```

**注意 token 名**：警告态是 `--dsw-alias-state-warn-primary`（warn），不是 `warning`。

### 1.5 破坏性操作的标准形态：`RiskConfirmation.module.css`

```css
.confirmation { width: min(440px, 100%); max-height: 100%; overflow: hidden; }
.confirmationContent { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.warning { display: flex; align-items: flex-start; gap: 10px; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px; }
.warningIcon { flex: none; margin-top: 2px; color: var(--dsw-alias-state-error-primary); }
.acknowledgement { display: flex; align-items: flex-start; gap: 10px; margin-top: 20px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; cursor: pointer; }
.acknowledgement input { flex: none; width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--dsw-alias-button-primary-fill); cursor: pointer; }
.acknowledgement input:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.modalAction { min-width: 72px; }
.confirmAction { min-width: 136px; }
```

即：官方遇到破坏性操作走**模态框 + 警告块 + 显式勾选 + 明确的确认按钮**，而不是「同一个按钮点两次」。

## 2. 官方图标约定

应用自己的图标全是内联 SVG：`viewBox="0 0 16 16"`、`fill: none`、`stroke: currentColor`、
`strokeWidth` 由调用方给（1 左右）、`aria-hidden`，尺寸 14–16。
（来源：`ui-chat`、`ui-tool-*` 等包的客户端 bundle，例如 `InputBar` 的停止按钮、
`ChatView` 的运行指示器。）

## 3. 第三方插件怎么用官方组件（模块解析规则）

来源：`@deepseek-ai/dsh-client-modules` 的 `README.zh.md` 与 `lib/client.js`。

工厂拿到的同步 `require` 按这个顺序解析：

1. **平台 seed 表**（HTML 引导阶段注入的模块，如 `react`）；
2. 已物化的模块记录；
3. **已注册的 factory**（即某个包已经执行过 `__ModuleLoader__.load({ id: <包名> })`）；
4. 都不匹配 → 直接抛错。

而包自己的 `dsh.client.inject` 里列出的包，会在本插件 factory 执行前被**先带进图里并注册**
（`arriveDependency`）。所以：**在 `dsh.client.inject` 里声明官方包，然后
`require("@deepseek-ai/dsh-client-ui-primitives")` 就能拿到官方组件本体。**

代价：这是官方内部包，DSH 升级改名/挪包会让这条 require 抛错 —— 必须用 try/catch 兜底。

## 4. 本插件现状 vs 官方标准（2026-10-08 对照）

**状态：下表已全部对齐**（`lib/client.js` 第三轮重写）：标题栏按钮照抄 `JobListAction.trigger`；
设置页按钮改用官方 `Button`；图标改用官方 `IconRefreshOutlineRegular`；危险确认改用官方
`RiskConfirmation`（勾选前确认按钮不可用）；自造的 token 全部换成官方 token。
下表保留为对照记录 —— 它记录了当时为什么「看起来不像官方」。

| 项 | 官方 | 本插件当时 |
| --- | --- | --- |
| 标题栏按钮高度 | `min-height: 28px` | 22px |
| 标题栏按钮圆角 | `--dsw-radius-sm` | `--dsw-radius-xs` |
| 标题栏按钮内边距 / 间距 | `padding: 3px 2px` / `gap: 3px` | `0 6px` / `gap: 4px` |
| 标题栏按钮行高 | `line-height: 18px` | 22px |
| 标题栏按钮 hover | 只换字色 tertiary→secondary，无底色 | 加 `--dsw-alias-fill-tsp-secondary` 底色 + 字色到 primary |
| 警告色 token | `--dsw-alias-state-warn-primary` | `--dsw-alias-state-warning-primary`（**该 token 不存在**，退回硬编码 #d29922） |
| 按下态 | `--dsw-alias-interactive-bg-active` | 误用 `-hover` |
| 焦点环 | `var(--dsw-focus-ring-width)` + `var(--dsw-focus-ring-color, …)` | 自写 2px + 自造颜色 |
| 设置页按钮 | `Button md`：H36 / `--dsw-radius-md` / gap 4px / padding 0 14px / ghost 或 outline 变体 | H36 + 圆角 18px + gap 12px + 自造填充色 |
| 危险确认形态 | 模态 + 警告块 + 勾选（`RiskConfirmation`） | 同一个按钮点两次 |
| 图标 | 16 格描边 SVG | 已对齐（2026-10-08 改） |
| 状态色语义 | `StateDot` 的 done / warning / error / idle 四个 token | 自造四种语气 + 自造色值 |

## 5. 左侧边栏的入口是怎么做的（2026-10-08 调研）

来源：`@deepseek-ai/dsh-client-ui-sidebar`（侧栏本体）、`@deepseek-ai/dsh-client-ui-workspace`
（行与「新会话」按钮）、`@deepseek-ai/dsh-client-ui-layout`（三栏骨架）、
`@deepseek-ai/dsh-cordis-client-runner`（给插件作者的座位说明与示例）。

### 5.1 结构

- 左侧栏是 `root` 座位下的 **`sidebar` 座位（`kind: "single"`）**，由 `ui-sidebar` 实现；
  三栏骨架（sidebar | main | rightbar）由 `ui-layout` 的 AppFrame 持有。
- 侧栏内部：品牌区（`sidebar.brand.mark` / `sidebar.brand.name`）→ 工作区与会话列表
  （`ui-workspace` 的 Rows）→ 底部（`sidebar.settings` + **`sidebar.footer.action`**）。

### 5.2 插件能用的侧栏座位（官方为第三方留的）

`sidebar.footer.action` 是 **`kind: "list"`**，官方给插件作者的示例就是：

```js
ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
  { name: 'sidebar.footer.action', id: 'my-entry', order: 100, label: 'My entry' },
  MyEntry))
```

应用自己的**插件面板**（cordis）正是这么挂的：`id: "cordis-panel"`，渲染在侧栏底部的
`footerActions` 里，并且会收到 `{ wide }`（侧栏是否展开）。

其它可用的座位：`sidebar.settings`、`sidebar.brand.mark` / `sidebar.brand.name`、
`sidebar.workspaces.directoryFlow`、`sidebar.session.row.leading` / `sidebar.session.row.hover`、
`sidebar.workspaces.session.row.action` / `sidebar.workspaces.session.menu.item`、
`sidebar.right.pane.tab`、`sidebar.right.tab.files.actions`、`sidebar.right.tab.document.actions`。
顶层 `sidebar` 座位是 `single`，被官方侧栏占着 —— 插件不能直接往里塞东西。

### 5.2b 左上角那组「面板行」（`sidebar.panellist` + `main`）

任务看板（`@linxin666/dsh-client-ui-task-board`）用的就是这一套，只有两个登记动作：

```js
slots.inject("sidebar.panellist", () => slots.register({
  name: "sidebar.panellist", id: "task-board", order: 20, label: () => t("entry.label")
}, TaskBoardPanelIcon))            // 只提供图标
slots.inject("main", () => slots.register({
  name: "main", key: "task-board", children: { ... }
}, TaskBoardPanel))                // 点开后在主区显示的内容
```

侧栏自己把这些登记变成行 —— `PanelRow`（`ui-sidebar`）绘制按钮、tooltip、文字与 active 态：

```js
function PanelRow({ id, label, wide, usePanelInfo, selectPanel, renderSlot }) {
  const active = usePanelInfo((info) => info.activePanelId === id);
  return <Tooltip label={label} delayMs={500} disabled={wide}>
    <button type="button" className={clsx(panelRow, active && panelActive)}
      aria-label={label} aria-current={active ? "page" : undefined}
      onClick={() => { selectPanel(id); }}>
      <span className={panelGlyph} aria-hidden="true">
        {renderSlot("sidebar.panellist", { size: wide ? 16 : 18, active }, { only: id })}
      </span>
      …
```

列表顺序：`panels.map(...)` 渲染在**会话列表上方**（`panelList` 在 `regionArea` 之前），
行样式是 `.panelList{gap:4px;margin-bottom:8px}` + `.panelRow{min-height:36px;border-radius:var(--dsw-radius-md);
color:var(--dsw-alias-label-primary)}`，收起成 rail 时 `36×36`。

**结论**：想让插件入口「一定是官方的外观」，就登记这个座位 —— **行由宿主绘制，插件只给图标**，
不存在自己写 CSS 写歪的可能。代价：它是**面板（视图）座位**，点一下会把主区切到同名 `main` 面板
（聊天被替换），所以面板里要放真正的操作按钮。

### 5.2c 插件自己的设置页（`settings.section`）

官方给插件留的设置分区座位：`settings.section`（`ui-agent-preset` 用它挂了「智能体预设」那一栏）：

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section", id: "agent-presets", order: 20,
  label: () => ctx.locale.bind("settings.agentPreset")("nav"),
  locale: "settings.agentPreset", inject: sectionInjected
}, AgentPresetSection));
```

`label` 就是设置页左侧导航里的那一项。官方开关组件是 `Switch({ checked, onChange, label, disabled, title, className })`
（渲染成 `role="switch"` 的按钮）。本插件用它做「自己决定用哪些入口」那一栏。

### 5.3 那些入口的样子（逐字）

**底部动作行**（官方插件面板 `CordisPanel.module.css`）：

```css
.layer { flex: none; align-items: center; width: 100%; height: 42px; margin: 8px 0 0; display: flex; position: relative; }
.footerButtons { align-items: center; width: 100%; display: flex; }
.badge {
  width: calc(100% + 4px); height: 42px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer; background: 0 0; border: none; border-radius: 12px;
  align-items: center; gap: 8px; margin: 0 -2px; padding: 0 10px 0 8px;
  font-family: inherit; font-size: 14px;
  display: inline-flex; overflow: hidden;
}
.badge:hover, .badge[data-active] { background: var(--dsw-alias-interactive-bg-hover); }
.badgeLabel { text-overflow: ellipsis; white-space: nowrap; min-width: 0; overflow: hidden; }
/* 侧栏收起成 rail 时 */
.rail { width: 36px; height: 36px; margin: 0; }
.rail .badge { corner-shape: round; border-radius: 50%; justify-content: center; gap: 0; width: 36px; height: 36px; padding: 0; }
.rail .footerButtons { flex-direction: column; gap: 2px; }
```

**它旁边那一行才是真正的参照物** —— 侧栏设置行（`ui-settings-general/SidebarSettings.module.css`）：

```css
.triggerRow { flex: none; align-items: center; gap: 8px; width: calc(100% + 4px); margin: 4px -2px; display: flex; position: relative; }
.triggerRow.railRow { width: 36px; margin: 8px 0 10px; }
.trigger {
  box-sizing: border-box; border-radius: var(--dsw-radius-md); cursor: pointer;
  width: auto; min-width: 0; height: 42px;
  color: var(--dsw-alias-label-primary); background: 0 0; border: none;
  flex: 1; align-items: center; gap: 8px; margin: 0; padding: 0 10px 0 8px;
  font-family: inherit; font-size: 14px; line-height: 22px; display: flex; overflow: hidden;
}
.trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
.trigger.rail { flex: none; justify-content: center; gap: 0; width: 36px; height: 36px; margin: 0; padding: 0; }
.triggerLabel { white-space: nowrap; overflow: hidden; }
```

与插件面板那份的差别 —— 正是「看着不像旁边那行」的原因：少了 `line-height: 22px`；
`margin` 是 `4px -2px` 而不是 `8px 0 0`；`calc(100% + 4px)` 挂在**行**上而不是按钮上
（挂在按钮上会让左右各多出 2px）；收起成 rail 时官方是 36×36 **圆角方块**（`--dsw-radius-md`），
不是圆形。

**行**（工作区 / 会话行 `Rows.module.css`）：

```css
.projectRow, .sessionRow {
  border-radius: var(--dsw-radius-md); padding: 0 8px; cursor: pointer; user-select: none;
  color: var(--dsw-alias-label-primary); align-items: center; gap: 6px;
  padding-inline-start: calc(8px + var(--dsh-workspace-indent, 0px)); display: flex;
}
.projectRow:hover, .sessionRow:hover, .sessionRow.selected { background: var(--dsw-alias-interactive-bg-hover); }
.projectRow { box-sizing: border-box; align-items: center; height: 34px; }
.sessionRow { gap: 0; height: 32px; }
.title { text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-size: 14px; line-height: 20px; overflow: hidden; }
.slot { width: 16px; height: 20px; color: var(--dsw-alias-label-tertiary); flex: none; justify-content: center; align-items: center; display: inline-flex; }
```

**「新会话」图标按钮**（工作区行里那个，同上模块）：

```css
.iconButton {
  border-radius: var(--dsw-radius-xs); cursor: pointer; width: 16px; height: 16px;
  color: var(--dsw-alias-label-tertiary); background: 0 0; border: none; flex: none;
  justify-content: center; align-items: center; padding: 0; display: inline-flex;
}
.iconButton:hover { color: var(--dsw-alias-label-primary); }
```

**列表头部的图标按钮**（另一个模块）：28×28、`--dsw-radius-sm`、`--dsw-alias-label-secondary`、
`:hover{background: var(--dsw-alias-interactive-bg-hover)}`、
`:focus-visible{outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, …); outline-offset: -2px}`；
rail 模式下 36×36、`--dsw-radius-md`、`--dsw-alias-label-primary`。
区块标题 `.sectionHeader`：`height:36px`、`--dsw-radius-md`、`--dsw-alias-label-tertiary`。

### 5.4 结论

插件要「和左侧那些一样」，正确做法是**注册 `sidebar.footer.action` 的一个条目**，照官方
插件面板那个 42px 行来做（图标 + 文字 + hover 底色；侧栏收起时 36×36 圆形）。
这是官方文档化的第三方入口，而不是照抄外观。

**已按此实现**（2026-10-08）：`lib/client.js` 注册 `sidebar.footer.action`（`order: 100`、带 `label`），
组件 `SidebarRestartAction` 读取座位传入的 `{ wide }` 在收起成 rail 时切成 36×36 **圆形** ——
同座位的官方插件面板就是这个形态（`.rail .badge { border-radius: 50% }`）；上面 5.3 里那个
「圆角方块」是**设置行**（另一个座位）的规矩，别混用。
第一版照抄的是 `CordisPanel.module.css`（插件面板），用户看后指出「排版、字体、位置不像旁边那行」——
比对后发现真正的参照物是它旁边的**设置行**，四处偏差已按上表改正。会话标题栏那个按钮按用户要求保留。

**容器换行**（2026-10-09）：这个座位的条目**都假设自己独占整行**（`width: calc(100% + 4px)` +
`flex:none`），容器却是 flex 横排，所以两个插件同时占用时后一个会被挤到边上、只露出一角。
插件在 `lib/client.js` 里加了一条规则让容器换行，但这是**改别人的容器**，因此收窄成
`[class*="footerActions"]:has(.dshdr-foot){flex-wrap:wrap !important}` —— 只命中「真的装着本插件
这一行」的那个容器，页面别处若有同名类不受牵连，本插件的底部入口关掉时这条规则也自然失效。

