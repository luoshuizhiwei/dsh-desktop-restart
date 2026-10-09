/**
 * Client half of dsh-desktop-restart.
 *
 * 两个入口，都走宿主半同一条受守卫的重启路径：
 *
 * 1. **会话标题栏按钮**（`conversation.session.header.actions`）—— 常驻可见；
 * 2. **设置 → 通用 那一行** —— 备用入口。
 *
 * 另外宿主半还注册了 `/restart-desktop` 斜杠命令。
 *
 * 桌面版里 host 只是 Electron 主进程的子进程：host 自己退出只会换来一个
 * 「启动失败」恢复框，而主进程没有给插件留任何重启通道。宿主半因此把交接
 * 交给一个分离的 helper（见 lib/helper.cjs）。
 *
 * ## 守卫：会打断工作时先问（2026-10-08）
 *
 * 判据在宿主半（那里才看得到 agents / jobs 与安装记录）：没有东西在跑就直接
 * 排程；有东西在跑就先回 409 与「会打断什么」，客户端弹**官方那套风险确认**
 * （警告 + 显式勾选 + 确认按钮）再决定要不要带 `?force=1` 重发。
 *
 * ## 界面：直接用官方标准件（2026-10-08 第三轮）
 *
 * 前两轮我在「像不像官方」上走过弯路：先自己写内联样式，再照抄了一个**只读标签**
 * 的数值。真正的官方标准在安装包里：
 *
 * - `@deepseek-ai/dsh-client-ui-primitives`：官方共享组件库，`Button`（variant
 *   primary/ghost/outline/toolbar，size md=H36/R12、sm=H28/R8）、`Pill`、`Tag`、
 *   `StateDot`、`Modal`、**`RiskConfirmation`**（显式勾选把关的敏感操作确认），
 *   以及整套 `Icon*` 图标（`IconRefreshOutlineRegular`、`IconWarningOutlineRegular`…）。
 * - 同一个座位里官方真正的按钮是 `ui-jobs` 的 `JobListAction`：`min-height:28px`、
 *   `--dsw-radius-sm`、`padding:3px 2px`、`gap:3px`、`12px/18px`、字色
 *   `--dsw-alias-label-tertiary`，**hover / focus-visible 只把字色提到
 *   `--dsw-alias-label-secondary`，不加任何底色**。
 *
 * 所以这一版：官方组件能拿到就直接用（`dsh.client.inject` 里声明后，加载器会先把
 * 那个包注册好再执行我们的 factory），拿不到才退回自己那份**逐字照抄官方数值**的
 * 样式。完整对照见 `docs/official-ui-standard.md`。
 *
 * 本文件是包里的 `./client` bundle：交给 `window.__ModuleLoader__` 的工厂形式，
 * 无 import，`require("react")` 由打包器提供，导出 plain-Cordis 插件
 * `{ name, inject, apply }`。
 */

window.__ModuleLoader__.load({
	// factory id 必须等于 package.json 的包名（client-modules 文档约定：
	// "registers a lazy factory whose id equals the package name"）。
	// 包名改为 @luoshuizhiwei/dsh-desktop-restart 后此 id 若不同步，boot 图里
	// 对应行找不到 factory → import 失败 → 重试把同一 bundle 再执行一遍 →
	// "duplicate factory registration for 'dsh-desktop-restart'"，web boot 整体失败。
	id: "@luoshuizhiwei/dsh-desktop-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/**
		 * 官方共享组件库。它声明在 `dsh.client.inject` 里，加载器会在执行本 factory
		 * 之前先把那个包带进图并注册（`arriveDependency`），所以这里能同步拿到官方本体。
		 * DSH 以后若改名或挪包，require 会抛错 —— 那就退回下面那份逐字照抄官方数值的
		 * 样式，界面不会崩。
		 */
		let UI = null;
		try {
			UI = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch {
			UI = null;
		}
		const OfficialButton = UI && typeof UI.Button === "function" ? UI.Button : null;
		const OfficialRiskConfirmation = UI && typeof UI.RiskConfirmation === "function" ? UI.RiskConfirmation : null;
		const OfficialRefreshIcon = UI && typeof UI.IconRefreshOutlineRegular === "function" ? UI.IconRefreshOutlineRegular : null;
		const OfficialWarningIcon = UI && typeof UI.IconWarningOutlineRegular === "function" ? UI.IconWarningOutlineRegular : null;
		const OfficialSwitch = UI && typeof UI.Switch === "function" ? UI.Switch : null;

		/** 本包自己的三条宿主路由。 */
		const RESTART_ROUTE = "/dsh-desktop-restart/api/restart";
		const STATUS_ROUTE = "/dsh-desktop-restart/api/status";
		const SWEEP_ROUTE = "/dsh-desktop-restart/api/sweep";
		/** 第一次点击「武装」按钮的有效期。 */
		const CONFIRM_MS = 5000;
		/**
		 * 兜底路径（拿不到官方 RiskConfirmation 时）警告态的最小冷却：连点不能把
		 * 「有任务在跑」这句话点过去。宿主半只认 `?force=1`，而 force 只在警告态
		 * 被点出来，所以这里挡的是「双击 = 忽略警告」。
		 */
		const WARN_ARM_MS = 900;
		/** 会话标题栏的加性座位。 */
		const HEADER_SLOT = "conversation.session.header.actions";
		/** 通用设置页里加性一行的座位。 */
		const SETTINGS_SLOT = "settings.general.item";
		/**
		 * 左侧边栏底部的动作座位（`kind: "list"`）。这是官方文档化给第三方插件的入口 ——
		 * 应用自己的插件面板（cordis）就挂在这里，所以侧栏底部本来就能并排多个入口。
		 */
		const SIDEBAR_FOOTER_SLOT = "sidebar.footer.action";
		/**
		 * 左侧边栏**左上角**的「面板行」座位，以及主区那个配对的面板座位。
		 *
		 * 这是任务看板（`@linxin666/dsh-client-ui-task-board`）用的那一套：在
		 * `sidebar.panellist` 里登记 `{ id, order, label }` 并给一个**图标组件**，
		 * 侧栏就会用**它自己的官方行**把这一条画出来（`PanelRow`：36px 高、
		 * `--dsw-radius-md`、label-primary、active 态、收起时 36×36）—— 行不是插件
		 * 画的，插件只提供图标，所以外观一定是官方的。点一下由侧栏调 `selectPanel(id)`
		 * 把主区切到 `main` 里 key 相同的那个面板。
		 */
		const PANEL_SLOT = "sidebar.panellist";
		const MAIN_SLOT = "main";
		/** 官方给插件留的设置分区座位（插件自己的设置页就挂在这里）。 */
		const SETTINGS_SECTION_SLOT = "settings.section";
		const PANEL_ID = "dsh-desktop-restart";
		const PANEL_ORDER = 30;
		/** 本插件在这两个座位里的 key。 */
		const ID = "dsh-desktop-restart";

		/**
		 * 插件自己的开关：客户端这四个入口可以逐个开关，选择存在浏览器本地；
		 * **默认值**来自插件的 config（宿主半的 `/api/status` 会给）。
		 * 斜杠命令（`config.command`）和总开关（`config.enabled`）在宿主半，改配置即可。
		 */
		const ENTRY_KEYS = ["panel", "footer", "header", "settingsRow"];
		const ENTRY_STORE_KEY = "dsh-desktop-restart.entries";
		/** 设置页里每一行的文案：`[标题, 说明]`。 */
		const ENTRY_LABELS = {
			panel: ["侧栏左上角的入口", "显示在左侧边栏顶部的入口列表里；点一下会在主区域打开重启面板"],
			footer: ["侧栏底部的入口", "显示在左侧边栏底部（设置区上方）；点两次直接重启"],
			header: ["会话标题栏的按钮", "显示在会话页标题栏右侧，随手可用"],
			settingsRow: ["设置页里的入口", "在「设置 → 通用」里多出一行"],
		};

		/** 读本机保存的开关；读不到或被禁用时回空对象（于是全部走默认值）。 */
		function readStoredEntries() {
			try {
				const raw = window.localStorage.getItem(ENTRY_STORE_KEY);
				if (typeof raw !== "string" || raw === "") return {};
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return {};
				const out = {};
				for (const key of ENTRY_KEYS) if (typeof parsed[key] === "boolean") out[key] = parsed[key];
				return out;
			} catch {
				return {};
			}
		}

		/**
		 * 保存一个开关。
		 * @param {string} key - 入口名。
		 * @param {boolean} value - 新的值。
		 */
		function writeStoredEntry(key, value) {
			try {
				const next = Object.assign({}, readStoredEntries(), { [key]: value === true });
				window.localStorage.setItem(ENTRY_STORE_KEY, JSON.stringify(next));
			} catch {
				/* 无痕模式之类写不进去：这次照样生效，下次回到默认值 */
			}
		}

		/** 注入样式的标签标识；与包名分开，避免和别的插件撞车。 */
		const CSS_TAG_ID = ID + "/Client.module.css";

		/**
		 * 自己的样式：只在拿不到官方组件时兜底，数值逐字照抄官方。
		 *
		 * - `.dshdr-trigger`：照抄 `ui-jobs/JobListAction.module.css` 的 `.trigger`
		 *   （官方标题栏动作按钮的真实数值）；
		 * - `.dshdr-btn`：照抄组件库 `Button.module.css` 的 md + ghost / outline / primary；
		 * - 焦点环、按下态、状态色全部用官方 token（`--dsw-focus-ring-*`、
		 *   `--dsw-alias-interactive-bg-active`、`--dsw-alias-state-warn-primary` …）。
		 */
		const CSS = [
			// ── 会话标题栏动作（官方 JobListAction.trigger 的数值）──────────────
			".dshdr-trigger{display:inline-flex;align-items:center;gap:3px;box-sizing:border-box;min-height:28px;padding:3px 2px;border:0;border-radius:var(--dsw-radius-sm,8px);background:0 0;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer;font:inherit;font-size:12px;line-height:18px;white-space:nowrap;transition:color .12s ease,background .12s ease}",
			".dshdr-trigger:hover:not(:disabled),.dshdr-trigger:focus-visible{color:var(--dsw-alias-label-secondary,inherit)}",
			".dshdr-trigger:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.18))}",
			".dshdr-trigger:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgba(77,107,254,.75)));outline-offset:2px}",
			".dshdr-trigger:disabled{cursor:not-allowed;opacity:.4}",
			".dshdr-trigger[data-phase=confirm]{color:var(--dsw-alias-label-primary,inherit)}",
			".dshdr-trigger[data-phase=warn]{color:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dshdr-trigger[data-phase=error]{color:var(--dsw-alias-state-error-primary,#f85149)}",
			".dshdr-trigger[data-phase=done]{color:var(--dsw-alias-state-success-primary,#3fb950)}",
			".dshdr-trigger svg{transition:transform .12s}",
			".dshdr-trigger[data-busy=1] svg,.dshdr-foot-badge[data-busy=1] svg,.dshdr-btn[data-busy=1] svg{transform-origin:center;animation:dshdr-spin 1s linear infinite}",
			"@keyframes dshdr-spin{to{transform:rotate(360deg)}}",
			"@media (prefers-reduced-motion:reduce){.dshdr-trigger[data-busy=1] svg,.dshdr-foot-badge[data-busy=1] svg,.dshdr-btn[data-busy=1] svg{animation:none}}",			"@container (width<=540px){.dshdr-label{display:none}}",
			// ── 设置页那一行 ─────────────────────────────────────────────────
			".dshdr-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}",
			".dshdr-row-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}",
			".dshdr-row-label{color:var(--dsw-alias-label-primary,inherit);font-size:14px;font-weight:400;line-height:22px}",
			".dshdr-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(140,140,150,1))}",
			".dshdr-hint[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dshdr-hint[data-tone=error]{color:var(--dsw-alias-state-error-primary,#f85149)}",
			".dshdr-hint[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#3fb950)}",
			// ── 兜底按钮：官方 Button.module.css 的 md + 三种变体 ───────────────
			".dshdr-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,12px);cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,inherit);background:transparent}",
			".dshdr-btn:disabled{cursor:not-allowed;opacity:.4}",
			".dshdr-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgba(77,107,254,.75)));outline-offset:2px}",
			".dshdr-btn[data-variant=ghost]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}",
			".dshdr-btn[data-variant=ghost]:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.22))}",
			".dshdr-btn[data-variant=outline]{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:transparent}",
			".dshdr-btn[data-variant=outline]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}",
			".dshdr-btn[data-variant=primary]{background:var(--dsw-alias-button-primary-fill,rgba(77,107,254,1));color:var(--dsw-alias-label-primary-foreground,#fff)}",
			".dshdr-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,rgba(77,107,254,.85))}",
			".dshdr-btn[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dshdr-btn[data-tone=done]{color:var(--dsw-alias-state-success-primary,#3fb950)}",
			".dshdr-btn[data-tone=error]{color:var(--dsw-alias-state-error-primary,#f85149)}",
			".dshdr-btn[data-busy=1] svg{transform-origin:center;animation:dshdr-spin 1s linear infinite}",
			// ── 左侧边栏底部的动作行 ──
			// 逐字照抄**同一个座位里另外两个占用者**（它们完全一致）：
			//   - 官方插件面板 CordisPanel.module.css 的 .layer / .badge / .rail
			//   - 第三方 dsh-diff-approval 的 PendingPanel.module.css 的 .layer / .badge / .rail
			// 上一轮我改成了「侧栏设置行」的数值 —— 那是**另一个座位**（应用自带的
			// settingsArea，single，插件进不去）的规矩，所以越改越不像同座位的邻居。
			// 这个座位的规矩是：42px 全宽行、radius 12px、padding 0 10px 0 8px、
			// 14px/22px、hover 加 interactive-bg-hover、收起成 rail 时 36×36 圆形。
			".dshdr-foot{box-sizing:border-box;flex:none;align-items:center;width:calc(100% + 4px);height:42px;margin:4px -2px;display:flex;position:relative}",
			".dshdr-foot-badge{box-sizing:border-box;width:100%;height:42px;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}",
			".dshdr-foot-badge:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}",
			".dshdr-foot-badge:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,rgba(77,107,254,.75)));outline-offset:2px}",
			".dshdr-foot-badge:disabled{color:var(--dsw-alias-label-tertiary,inherit);cursor:default;background:0 0}",
			".dshdr-foot-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
			".dshdr-foot-badge[data-phase=warn]{color:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dshdr-foot-badge[data-phase=error]{color:var(--dsw-alias-state-error-primary,#f85149)}",
			".dshdr-foot-badge[data-phase=done]{color:var(--dsw-alias-state-success-primary,#3fb950)}",
			".dshdr-foot[data-rail=1]{width:36px;height:36px;margin:8px 0 10px}",
			".dshdr-foot[data-rail=1] .dshdr-foot-badge{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}",
			".dshdr-foot[data-rail=1] .dshdr-foot-label{display:none}",
			// 这个座位（sidebar.footer.action）的容器是 flex 横排，但同座位的条目**都假设
			// 自己独占整行**（`width:calc(100% + 4px)` + `flex:none` —— 官方插件面板和
			// dsh-diff-approval 都是这样）。两个插件同时占用时，后一个会被挤出容器、只露出
			// 一角（2026-10-09 实测：被「待处理改动」挤到右侧且大部分被遮挡）。
			// 让容器允许换行：整行条目各占一行，将来若出现紧凑条目也仍能并排。
			//
			// 但这是**改别人的容器**，所以必须收窄：`:has(.dshdr-foot)` 让它只命中
			// 「真的装着本插件这一行」的那个容器 —— 页面别处若有同名类不会受牵连，
			// 本插件的底部入口关掉时这条规则也自然失效（没有 .dshdr-foot 可匹配）。
			// 万一浏览器不支持 :has()，整条规则会被丢弃，退回「条目挤在一起」，
			// 而不是弄坏别处的布局。
			"[class*=\"footerActions\"]:has(.dshdr-foot){flex-wrap:wrap !important}",
			// ── 主区里的重启面板（点左上角那一条切过来）──
			".dshdr-panel{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;max-width:560px;margin:0 auto;padding:32px 24px}",
			".dshdr-panel-title{color:var(--dsw-alias-label-primary,inherit);margin:0;font-size:16px;font-weight:500;line-height:24px}",
			".dshdr-panel-desc{color:var(--dsw-alias-label-secondary,inherit);margin:0;font-size:14px;line-height:22px}",
			".dshdr-panel-actions{display:flex;align-items:center;gap:8px;margin-top:4px}",
			".dshdr-panel-note{color:var(--dsw-alias-label-tertiary,inherit);margin:0;font-size:12px;line-height:18px}",
			// ── 插件自己的设置分区（开关页）──
			".dshdr-set-page{box-sizing:border-box;display:flex;flex-direction:column;width:100%;max-width:720px;margin:0 auto;padding:24px}",
			".dshdr-set-title{color:var(--dsw-alias-label-primary,inherit);margin:0 0 4px;font-size:16px;font-weight:500;line-height:24px}",
			".dshdr-set-desc{color:var(--dsw-alias-label-secondary,inherit);margin:0;font-size:14px;line-height:22px}",
			".dshdr-set-row{display:flex;align-items:center;gap:12px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}",
			".dshdr-set-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}",
			".dshdr-set-label{color:var(--dsw-alias-label-primary,inherit);font-size:14px;font-weight:400;line-height:22px}",
			".dshdr-set-hint{color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;line-height:18px}",
			".dshdr-set-subtitle{color:var(--dsw-alias-label-primary,inherit);margin:24px 0 0;font-size:14px;font-weight:500;line-height:22px}",
			".dshdr-set-actions{display:flex;align-items:center;gap:8px;flex:none}",
		].join("");

		// 与应用自带插件同一个写法：一次性注入，选择器自带前缀，不污染别处。
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = ID;
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** 默认提示文案：说明这一行和「重启 dsh web」的区别。 */
		const DEFAULT_HINT = "重启整个 DeepSeek Harness 桌面应用。改了插件或设置、需要重启才生效时用这个。";

		/**
		 * 刷新图标。优先用官方 `IconRefreshOutlineRegular`（应用自己就是 size 14），
		 * 拿不到时画一个同样约定的 16 格描边 SVG。
		 * @param {number} size - 边长（像素）。
		 * @returns {object} React 元素。
		 */
		function Glyph(size) {
			if (OfficialRefreshIcon !== null) return React.createElement(OfficialRefreshIcon, { size: size });
			return React.createElement("svg", {
				width: String(size),
				height: String(size),
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.2",
				strokeLinecap: "round",
				"aria-hidden": "true",
				focusable: "false",
			},
				React.createElement("path", { d: "M13.51 7.03A5.6 5.6 0 1 1 10.8 3.15" }),
				React.createElement("path", { d: "M10.42 1.75L10.97 3.25L9.4 3.53" }));
		}

		/**
		 * 问一次宿主：这是不是 Electron 桌面版、现在有多少活在跑。
		 * @returns {Promise<{ desktop: boolean, guardHint: string }>} 状态。
		 */
		async function fetchStatus() {
			try {
				const response = await fetch(STATUS_ROUTE, { method: "GET" });
				const body = await response.json().catch(() => null);
				if (response.ok && body) {
					const reasons = body.guard && Array.isArray(body.guard.reasons) ? body.guard.reasons : [];
					return {
						desktop: body.desktop === true,
						guardHint: reasons.join("；"),
						// 每个入口的默认开关（config 里配的）
						entries: body.entries !== null && typeof body.entries === "object" ? body.entries : undefined,
						// 孤儿快照清理的开关与上次结果（宿主半给的）
						sweep: body.sweep !== null && typeof body.sweep === "object" ? body.sweep : undefined,
					};
				}
				return { desktop: false, guardHint: "", entries: undefined, sweep: undefined };
			} catch {
				return { desktop: false, guardHint: "", entries: undefined, sweep: undefined };
			}
		}

		/**
		 * 请宿主排程一次重启。
		 *
		 * `force` 走查询参数而不是请求体：桌面壳转发页面 fetch 时只保证 URL 与
		 * 头部到达，少一种失败形态就少一类「点了没反应」。
		 * @param {boolean} force - 是否已确认「我知道有东西在跑」。
		 * @returns {Promise<{ ok: boolean, text: string, guard?: boolean }>} 要显示的结果。
		 */
		async function requestRestart(force) {
			let response;
			try {
				response = await fetch(force ? RESTART_ROUTE + "?force=1" : RESTART_ROUTE, { method: "POST" });
			} catch (error) {
				return { ok: false, text: "请求失败：" + String((error && error.message) || error) };
			}
			const body = await response.json().catch(() => null);
			if (response.ok && body && body.ok === true) {
				return {
					ok: true,
					text: "已排程重启：窗口即将关闭，稍后会自动打开。",
				};
			}
			if (body && body.guard && body.guard.active === true) {
				return { ok: false, guard: true, text: String(body.error || "现在有任务在进行") };
			}
			return { ok: false, text: String((body && body.error) || ("HTTP " + response.status)) };
		}

		/**
		 * 按钮上的字。
		 * @param {{ phase: string, armed: boolean }} action - 动作状态。
		 * @returns {string} 文案。
		 */
		function labelOf(action) {
			if (action.phase === "restarting") return "重启中…";
			if (action.phase === "done") return "已排程";
			if (action.phase === "warn") return action.armed ? "仍要重启？" : "稍等…";
			if (action.phase === "confirm") return "确认重启？";
			if (action.phase === "error") return "重试";
			return "重启";
		}

		/**
		 * 给读屏软件的一句话：按钮上的字很短，状态要在这里说全。
		 * @param {{ phase: string, armed: boolean, guardHint: string, desktop: boolean | null }} action - 动作状态。
		 * @returns {string} 无障碍标签。
		 */
		function ariaLabelOf(action) {
			if (action.desktop === false) return "重启桌面应用（仅在桌面版可用）";
			if (action.phase === "restarting") return "正在重启桌面应用";
			if (action.phase === "done") return "已排程重启，页面即将断开";
			if (action.phase === "warn") return action.armed ? "仍要重启桌面应用，会打断正在跑的任务" : "正在准备确认，请稍等";
			if (action.phase === "confirm") return "再次点击以确认重启桌面应用";
			if (action.phase === "error") return "重启失败，点击重试";
			return action.guardHint !== "" ? "重启桌面应用（" + action.guardHint + "）" : "重启桌面应用";
		}

		/**
		 * 提示文字的语气。
		 * @param {{ phase: string }} action - 动作状态。
		 * @returns {"plain" | "warn" | "ok" | "error"} 语气。
		 */
		function toneOf(action) {
			if (action.phase === "error") return "error";
			if (action.phase === "done") return "ok";
			if (action.phase === "warn") return "warn";
			return "plain";
		}

		/**
		 * 两个入口共用的重启动作。
		 * @param {object | undefined} timer - 客户端 timer 服务，用于让武装态与警告冷却过期。
		 * @returns {object} 动作状态 + `press` / `refresh` / `modal`。
		 */
		function useRestart(timer) {
			const phasePair = React.useState("idle");
			const phase = phasePair[0];
			const setPhase = phasePair[1];
			const messagePair = React.useState("");
			const message = messagePair[0];
			const setMessage = messagePair[1];
			const desktopPair = React.useState(null);
			const desktop = desktopPair[0];
			const setDesktop = desktopPair[1];
			const hintPair = React.useState("");
			const guardHint = hintPair[0];
			const setGuardHint = hintPair[1];
			const armedPair = React.useState(false);
			const armed = armedPair[0];
			const setArmed = armedPair[1];
			// 官方风险确认（RiskConfirmation）是受控的：开合与勾选都由调用方持有。
			const modalOpenPair = React.useState(false);
			const modalOpen = modalOpenPair[0];
			const setModalOpen = modalOpenPair[1];
			const ackPair = React.useState(false);
			const acknowledged = ackPair[0];
			const setAcknowledged = ackPair[1];
			const guardTextPair = React.useState("");
			const guardText = guardTextPair[0];
			const setGuardText = guardTextPair[1];

			const hasTimer = timer !== undefined && typeof timer.timeout === "function";
			/**
			 * 需要「过一会儿就放行」的冷却。没有 timer 服务时立刻放行 ——
			 * 把自己锁在不可点上是最糟的失败形态。
			 */
			const armLater = (fn, ms) => {
				if (hasTimer) timer.timeout(fn, ms);
				else fn();
			};
			/**
			 * 需要「过一会儿就撤销」的确认窗口。没有 timer 服务时干脆不撤销。
			 */
			const expireLater = (fn, ms) => {
				if (hasTimer) timer.timeout(fn, ms);
			};

			/** 重新问一次宿主，好让提示不会过期（鼠标移入 / 聚焦时调用）。 */
			const refresh = () => {
				fetchStatus().then((status) => {
					setDesktop(status.desktop);
					setGuardHint(status.guardHint);
				}, () => {});
			};

			React.useEffect(() => {
				let live = true;
				fetchStatus().then((status) => {
					if (!live) return;
					setDesktop(status.desktop);
					setGuardHint(status.guardHint);
				}, () => {
					if (live) setDesktop(false);
				});
				return () => { live = false; };
			}, []);

			const send = (force) => {
				setPhase("restarting");
				setMessage("");
				requestRestart(force).then((result) => {
					if (result.ok) {
						setPhase("done");
						setMessage(result.text);
						return;
					}
					if (result.guard === true) {
						// 宿主半说了「有东西在跑」。有官方 RiskConfirmation 就用官方那套
						// （警告 + 显式勾选 + 确认按钮）；没有才退回内联警告态。
						if (OfficialRiskConfirmation !== null) {
							setGuardText(result.text);
							setAcknowledged(false);
							setModalOpen(true);
							setPhase("idle");
							return;
						}
						setPhase("warn");
						setMessage(result.text);
						setArmed(false);
						armLater(() => setArmed(true), WARN_ARM_MS);
						return;
					}
					setPhase("error");
					setMessage(result.text);
				}, (failure) => {
					setPhase("error");
					setMessage(String((failure && failure.message) || failure));
				});
			};

			const press = () => {
				if (phase === "restarting" || desktop === false || phase === "done") return;
				if (phase === "warn") {
					// 冷却期内点击直接忽略（按钮此时也是 disabled 的）。
					if (armed) send(true);
					return;
				}
				if (phase === "error") {
					// 上一次请求本身失败了，重试就是再发一次，不必重新武装。
					send(false);
					return;
				}
				if (phase !== "confirm") {
					setPhase("confirm");
					expireLater(() => setPhase((current) => (current === "confirm" ? "idle" : current)), CONFIRM_MS);
					return;
				}
				send(false);
			};

			/** 官方确认框：取消（含 Esc / 点遮罩）。 */
			const cancelModal = () => {
				setModalOpen(false);
				setAcknowledged(false);
				setPhase("idle");
			};

			/** 官方确认框：确认后带 force 重发。 */
			const confirmModal = () => {
				setModalOpen(false);
				setAcknowledged(false);
				send(true);
			};

			return {
				phase, message, desktop, guardHint, armed, press, refresh,
				modal: {
					open: modalOpen,
					acknowledged: acknowledged,
					text: guardText,
					setAcknowledged: setAcknowledged,
					cancel: cancelModal,
					confirm: confirmModal,
				},
			};
		}

		/**
		 * 官方风险确认框（拿不到官方组件时返回 null，由内联警告态兜底）。
		 * @param {object} action - {@link useRestart} 的返回值。
		 * @returns {object | null} React 元素或 null。
		 */
		function RiskDialog(action) {
			if (OfficialRiskConfirmation === null || action.modal.open !== true) return null;
			return React.createElement(OfficialRiskConfirmation, {
				open: true,
				title: "重启桌面应用？",
				description: action.modal.text,
				acknowledgeLabel: "我知道这会打断上面列出的工作（正在写的文件可能停在半路）",
				cancelLabel: "取消",
				closeLabel: "关闭",
				confirmLabel: "仍要重启",
				acknowledged: action.modal.acknowledged,
				onAcknowledgedChange: action.modal.setAcknowledged,
				onCancel: action.modal.cancel,
				onConfirm: action.modal.confirm,
			});
		}

		/**
		 * 插件主体：注册会话标题栏按钮与设置页那一行，都挂在本插件自己的
		 * fiber 上，卸载时随之移除。
		 * @param {object} ctx - 客户端 Cordis 上下文。
		 */
		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const timer = ctx.get("timer");

			/**
			 * 忙碌 / 冷却 / 非桌面版时按钮不可点；已排程之后也不必再点。
			 * @param {object} action - 动作状态。
			 * @returns {boolean} 是否禁用。
			 */
			function isDisabled(action) {
				return action.phase === "restarting"
					|| action.phase === "done"
					|| action.desktop === false
					|| (action.phase === "warn" && action.armed === false);
			}

			/** 会话标题栏上的常驻按钮：照官方那个座位里的动作按钮做。 */
			function HeaderRestartButton() {
				const action = useRestart(timer);
				const busy = action.phase === "restarting";
				const title = action.message !== ""
					? action.message
					: (action.desktop === false
						? "仅在桌面版可用"
						: (action.guardHint !== ""
							? action.guardHint + "；点两次仍可重启"
							: "重启整个 DeepSeek Harness 桌面应用"));

				return React.createElement(React.Fragment, null,
					React.createElement("button", {
						type: "button",
						className: "dshdr-trigger",
						"data-phase": action.phase,
						"data-busy": busy ? "1" : "0",
						disabled: isDisabled(action),
						title: title,
						"aria-label": ariaLabelOf(action),
						"aria-busy": busy ? "true" : undefined,
						onClick: action.press,
						onMouseEnter: action.refresh,
						onFocus: action.refresh,
					},
						Glyph(14),
						React.createElement("span", { className: "dshdr-label" }, labelOf(action))),
					RiskDialog(action));
			}

			/** 设置页那一行：标题、说明和两步确认的重启按钮。 */
			function SettingsRestartRow() {
				const action = useRestart(timer);
				const busy = action.phase === "restarting";
				const disabled = isDisabled(action);
				const hint = busy
					? "正在重启…本页马上会断开。"
					: (action.message !== ""
						? (action.phase === "warn" ? action.message + " 再点一次「仍要重启？」才会执行。" : action.message)
						: (action.desktop === false
							? "当前不是桌面版，这一行只在桌面应用里可用。"
							: (action.guardHint !== ""
								? action.guardHint + "；现在点两次仍可重启，但那会打断它们。"
								: DEFAULT_HINT)));
				const label = labelOf(action);
				const icon = Glyph(14);
				const shared = {
					disabled: disabled,
					title: action.desktop === false ? "仅在桌面版可用" : "重启整个桌面应用（结束当前实例并重新打开）",
					"aria-label": ariaLabelOf(action),
					"aria-busy": busy ? "true" : undefined,
					onClick: action.press,
					onMouseEnter: action.refresh,
					onFocus: action.refresh,
				};
				const button = OfficialButton !== null
					? React.createElement(OfficialButton, Object.assign({ variant: "ghost", icon: icon }, shared), label)
					: React.createElement("button", Object.assign({
						type: "button",
						className: "dshdr-btn",
						"data-variant": "ghost",
						"data-tone": toneOf(action),
						"data-busy": busy ? "1" : "0",
					}, shared), icon, label);

				return React.createElement(React.Fragment, null,
					React.createElement("div", { className: "dshdr-row" },
						React.createElement("div", { className: "dshdr-row-text" },
							React.createElement("span", { className: "dshdr-row-label" }, "重启桌面应用"),
							React.createElement("span", {
								className: "dshdr-hint",
								"data-tone": toneOf(action),
								// 状态变化要能被读屏软件念出来：从「没事」变成「有任务在跑」时，
								// 只靠颜色变化对读屏用户是看不见的。
								"aria-live": "polite",
							}, hint)),
						button),
					RiskDialog(action));
			}

			/**
			 * 左侧边栏底部的入口：照官方插件面板那个 42px 动作行做。
			 *
			 * 座位会把 `{ wide }`（侧栏是否展开）传进来：收起成 rail 时官方那个行变成
			 * 36×36 圆形、只剩图标，这里照同样规则。
			 * @param {{ wide?: boolean }} [props] - 座位传入的属性。
			 * @returns {object} React 元素。
			 */
			function SidebarRestartAction(props) {
				const action = useRestart(timer);
				const wide = !(props !== undefined && props !== null && props.wide === false);
				const busy = action.phase === "restarting";
				const title = action.message !== ""
					? action.message
					: (action.desktop === false
						? "仅在桌面版可用"
						: (action.guardHint !== ""
							? action.guardHint + "；点两次仍可重启"
							: "重启整个 DeepSeek Harness 桌面应用"));

				return React.createElement(React.Fragment, null,
					React.createElement("div", { className: "dshdr-foot", "data-rail": wide ? "0" : "1" },
						React.createElement("button", {
							type: "button",
							className: "dshdr-foot-badge",
							"data-phase": action.phase,
							"data-busy": busy ? "1" : "0",
							disabled: isDisabled(action),
							title: title,
							"aria-label": ariaLabelOf(action),
							"aria-busy": busy ? "true" : undefined,
							onClick: action.press,
							onMouseEnter: action.refresh,
							onFocus: action.refresh,
						},
							Glyph(16),
							React.createElement("span", { className: "dshdr-foot-label" }, labelOf(action)))),
					RiskDialog(action));
			}

			/**
			 * 左上角那条面板行的图标。座位只把 `{ size, active }` 传进来 —— 整行
			 * （按钮、tooltip、文字、active 态）都是侧栏自己画的，这里只给图标。
			 * @param {{ size?: number }} [props] - 座位传入的属性。
			 * @returns {object} React 元素。
			 */
			function PanelGlyph(props) {
				const size = props !== undefined && props !== null && typeof props.size === "number" ? props.size : 16;
				return Glyph(size);
			}

			/**
			 * 主区里的重启面板：点左上角那一条切过来。
			 *
			 * 面板本身不是「动作座位」，所以这里放一个正经的说明 + 官方 `Button`（primary），
			 * 有任务在跑时照旧走官方 `RiskConfirmation` 确认。
			 * @returns {object} React 元素。
			 */
			function RestartPanel() {
				const action = useRestart(timer);
				const busy = action.phase === "restarting";
				const label = busy
					? "重启中…"
					: (action.phase === "done" ? "已排程" : (action.phase === "confirm" ? "确认重启？" : (action.phase === "error" ? "重试" : "重启")));
				const disabled = busy
					|| action.phase === "done"
					|| action.desktop === false
					|| (action.phase === "warn" && action.armed === false);
				const desc = action.desktop === false
					? "当前不是桌面版；这个面板只在桌面应用里可用。"
					: (action.guardHint !== ""
						? action.guardHint + "；点「重启」之后还要再确认一次。"
						: "重启整个桌面应用。正在进行的会话会在关闭时正常保存，不会丢。");
				const icon = Glyph(16);
				const shared = {
					disabled: disabled,
					title: "重启整个桌面应用（结束当前实例并重新打开）",
					"aria-label": ariaLabelOf(action),
					"aria-busy": busy ? "true" : undefined,
					onClick: action.press,
					onMouseEnter: action.refresh,
					onFocus: action.refresh,
				};
				const button = OfficialButton !== null
					? React.createElement(OfficialButton, Object.assign({ variant: "primary", icon: icon }, shared), label)
					: React.createElement("button", Object.assign({
						type: "button",
						className: "dshdr-btn",
						"data-variant": "primary",
						"data-busy": busy ? "1" : "0",
					}, shared), icon, label);

				return React.createElement(React.Fragment, null,
					React.createElement("div", { className: "dshdr-panel" },
						React.createElement("h2", { className: "dshdr-panel-title" }, "重启桌面应用"),
						React.createElement("p", { className: "dshdr-panel-desc" }, desc),
						React.createElement("div", { className: "dshdr-panel-actions" }, button),
						action.message !== "" && React.createElement("p", {
							className: "dshdr-panel-note",
							"aria-live": "polite",
						}, action.message)),
					RiskDialog(action));
			}

			/**
			 * 「清理遗留的改动快照」那一行。
			 *
			 * 这一项与上面四个不同：它必须在客户端连上来之前就生效，所以开关存在**宿主**
			 * 那一侧（`~/.dsh/desktop-restart/settings.json`），这里只是读写它。
			 * 关掉之后宿主一个字节都不动；打开时会顺手立刻清一次，好让人当场看见结果。
			 * @returns {object} React 元素。
			 */
			function SweepRow() {
				const statePair = React.useState(null);
				const sweep = statePair[0];
				const setSweep = statePair[1];
				const busyPair = React.useState(false);
				const busy = busyPair[0];
				const setBusy = busyPair[1];
				const notePair = React.useState("");
				const note = notePair[0];
				const setNote = notePair[1];

				React.useEffect(() => {
					let live = true;
					fetchStatus().then((status) => {
						if (live && status.sweep !== undefined) setSweep(status.sweep);
					}, () => {});
					return () => { live = false; };
				}, []);

				/**
				 * 打一次宿主路由，并把结果反映到这一行上。
				 * @param {string} query - 查询串（`?enabled=1` / `?enabled=0` / `?run=1`）。
				 */
				const call = (query) => {
					setBusy(true);
					setNote("");
					fetch(SWEEP_ROUTE + query, { method: "POST" })
						.then((response) => response.json().catch(() => null))
						.then((body) => {
							if (body && body.ok === true) {
								setSweep({ enabled: body.enabled === true, last: body.last ?? null });
							} else {
								setNote("没成功：" + String((body && body.error) || "未知错误"));
							}
						}, (error) => {
							setNote("请求失败：" + String((error && error.message) || error));
						})
						.finally(() => { setBusy(false); });
				};

				const enabled = sweep !== null && sweep.enabled === true;
				const last = sweep !== null && sweep.last ? sweep.last : null;
				let hint;
				if (sweep === null) hint = "正在读取当前设置…";
				else if (note !== "") hint = note;
				else if (last !== null && last.error) hint = "上次清理出错：" + String(last.error);
				else if (last !== null && last.removed > 0) hint = "已清理 " + String(last.removed) + " 个遗留快照目录，释放 " + (last.bytes / 1048576).toFixed(1) + " MB。";
				else if (last !== null) hint = "上次检查没有发现遗留快照。";
				else if (enabled) hint = "已开启：每次启动时清理一次。";
				else hint = "已关闭：不会动 Temp 里的任何东西。";

				const detail = "DSH 的「改动快照」每开一个会话就在系统 Temp 建一个目录，被硬杀或崩溃时会留下孤儿。"
					+ "只清理「启动之前就存在、启动之后没被写过、而且已经躺够 24 小时」的目录，活动会话的绝不碰。";
				const control = OfficialSwitch !== null
					? React.createElement(OfficialSwitch, {
						checked: enabled,
						disabled: sweep === null || busy,
						onChange: (next) => { call(next === true ? "?enabled=1" : "?enabled=0"); },
						label: "启动时自动清理遗留的改动快照",
					})
					: React.createElement("input", {
						type: "checkbox",
						checked: enabled,
						disabled: sweep === null || busy,
						"aria-label": "启动时自动清理遗留的改动快照",
						onChange: (event) => { call(event.target.checked ? "?enabled=1" : "?enabled=0"); },
					});
				const runLabel = busy ? "清理中…" : "立即清理";
				const runNow = () => { call("?run=1"); };
				const runButton = OfficialButton !== null
					? React.createElement(OfficialButton, {
						variant: "ghost",
						disabled: busy,
						onClick: runNow,
						"aria-label": "立即清理一次遗留快照",
					}, runLabel)
					: React.createElement("button", {
						type: "button",
						className: "dshdr-btn",
						"data-variant": "ghost",
						disabled: busy,
						onClick: runNow,
						"aria-label": "立即清理一次遗留快照",
					}, runLabel);

				return React.createElement("div", { className: "dshdr-set-row" },
					React.createElement("span", { className: "dshdr-set-text" },
						React.createElement("span", { className: "dshdr-set-label" }, "清理遗留的改动快照"),
						React.createElement("span", { className: "dshdr-set-hint", "aria-live": "polite" }, hint),
						React.createElement("span", { className: "dshdr-set-hint" }, detail)),
					React.createElement("span", { className: "dshdr-set-actions" }, runButton, control));
			}

			/**
			 * 插件自己的设置分区（`settings.section`，官方给插件留的座位）：
			 * 四个客户端入口的开关（改完**立即生效**，选择存在本机浏览器），
			 * 外加「清理遗留的改动快照」那一行（开关存在宿主）。
			 * @returns {object} React 元素。
			 */
			function SettingsSection() {
				const bumpPair = React.useState(0);
				const bump = bumpPair[1];
				const rows = ENTRY_KEYS.map((key) => {
					const copy = ENTRY_LABELS[key];
					const checked = switches[key] === true;
					const toggle = (next) => {
						switches[key] = next === true;
						writeStoredEntry(key, switches[key]);
						applyEntries();
						bump((n) => n + 1);
					};
					const control = OfficialSwitch !== null
						? React.createElement(OfficialSwitch, { checked: checked, onChange: toggle, label: copy[0] })
						: React.createElement("input", {
							type: "checkbox",
							checked: checked,
							"aria-label": copy[0],
							onChange: (event) => toggle(event.target.checked),
						});
					return React.createElement("div", { className: "dshdr-set-row", key: key },
						React.createElement("span", { className: "dshdr-set-text" },
							React.createElement("span", { className: "dshdr-set-label" }, copy[0]),
							React.createElement("span", { className: "dshdr-set-hint" }, copy[1])),
						control);
				});
				return React.createElement("div", { className: "dshdr-set-page" },
					React.createElement("h2", { className: "dshdr-set-title" }, "重启桌面应用"),
					React.createElement("p", { className: "dshdr-set-desc" },
						"勾选要让哪些入口显示出来 —— 改完立即生效，选择保存在这台电脑上。斜杠命令 /restart-desktop 和总开关在插件配置里（config.command / config.enabled）。"),
					...rows,
					React.createElement("h3", { className: "dshdr-set-subtitle" }, "顺手清掉别人漏下的临时文件"),
					React.createElement(SweepRow));
			}

			/**
			 * 客户端入口的当前开关：宿主 config 给的默认值 + 本机保存的覆盖。
			 * 拿不到宿主默认值时先按 true 起，等 `/api/status` 回来再对齐。
			 */
			const defaults = { panel: true, footer: true, header: true, settingsRow: true };
			const stored = readStoredEntries();
			const switches = Object.assign({}, defaults, stored);
			let disposers = [];

			/** 撤掉已经注册的入口。 */
			function clearEntries() {
				for (const dispose of disposers) {
					try {
						dispose();
					} catch {
						/* 已经撤掉了 */
					}
				}
				disposers = [];
			}

			/** 按当前开关注册一轮入口。开关一变就调它 —— 所以改完不用刷新页面。 */
			function applyEntries() {
				clearEntries();
				if (switches.panel === true) {
					// 左上角：和任务看板同一个座位。这里只登记「id / order / 文案」+ 图标组件，
					// 整行由侧栏自己绘制 —— 所以这一条的外观一定是官方的。
					disposers.push(slots.inject(PANEL_SLOT, () => slots.register({
						name: PANEL_SLOT,
						id: PANEL_ID,
						order: PANEL_ORDER,
						label: () => "重启桌面应用",
					}, PanelGlyph)));
					// 主区：点左上角那一条，侧栏会 selectPanel(PANEL_ID) 切到这个面板。
					disposers.push(slots.inject(MAIN_SLOT, () => slots.register({
						name: MAIN_SLOT,
						key: PANEL_ID,
					}, RestartPanel)));
				}
				if (switches.footer === true) {
					// 官方文档化给第三方插件的动作座位（应用自己的插件面板也挂这里）。
					disposers.push(slots.inject(SIDEBAR_FOOTER_SLOT, () => slots.register({
						name: SIDEBAR_FOOTER_SLOT,
						id: ID,
						order: 100,
						label: "重启桌面应用",
					}, SidebarRestartAction)));
				}
				if (switches.header === true) {
					// order 必须小于内置 jobs 插件那个「N 个后台任务」条目的 20：
					// 标题栏的动作组是左紧排的，排在后面的条目会被它前面新增的条目
					// 往右顶（2026-10-06 实测右移 134px）。排在 20 之前，任务条目就出现在
					// 按钮右侧，按钮不动。
					disposers.push(slots.inject(HEADER_SLOT, () => slots.register({
						name: HEADER_SLOT,
						id: ID,
						order: 15,
					}, HeaderRestartButton)));
				}
				if (switches.settingsRow === true) {
					disposers.push(slots.inject(SETTINGS_SLOT, () => slots.register({
						name: SETTINGS_SLOT,
						id: ID,
						order: 91,
					}, SettingsRestartRow)));
				}
			}

			applyEntries();
			// 插件被卸载/停用时，把自己注册的入口一起撤掉。
			ctx.effect(() => () => clearEntries());

			// 插件自己的设置分区（开关页）—— 它本身不受开关影响，否则关掉就回不来了。
			ctx.effect(() => slots.inject(SETTINGS_SECTION_SLOT, () => slots.register({
				name: SETTINGS_SECTION_SLOT,
				id: ID,
				order: 90,
				label: () => "重启桌面应用",
			}, SettingsSection)));

			// 问一次宿主，把 config 里的默认值合进来（本机选过的以本机为准）。
			fetchStatus().then((status) => {
				if (status.entries === undefined) return;
				let changed = false;
				for (const key of ENTRY_KEYS) {
					if (Object.prototype.hasOwnProperty.call(stored, key)) continue;
					if (switches[key] !== status.entries[key]) {
						switches[key] = status.entries[key];
						changed = true;
					}
				}
				if (changed) applyEntries();
			}, () => {});
		}

		module.exports = { name: ID, inject: ["slots"], apply };
		return module.exports;
	}
});
