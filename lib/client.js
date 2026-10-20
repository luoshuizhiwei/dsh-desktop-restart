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

		// ── 字典（issue #1：英文支持）────────────────────────────────────────
		//
		// 走官方 locale 服务：ctx.locale.register(NS, { zh, en }) 注册一份双语字典，
		// ctx.locale.bind(NS) 拿翻译函数 —— **语言跟随 DSH 主应用的设置**，用户
		// 不需要在这里再挑一次语言（dshmarket 同款机制）。宿主半的错误消息仍写中文
		// —— 它没有 locale 服务（官方插件同样如此），那些字符串就是英文环境下的
		// 兜底；客户端在有字典键可翻译时用自己的译文覆盖它。
		const LOCALE_NS = "dsh-desktop-restart";
		/** 键 → 两种语言。忘了配哪个键时 t() 原样返回键名，肉眼可认。 */
		const DICT = {
			zh: {
				// 通用
				pluginName: "重启桌面应用",
				// 两个**侧栏入口**用的短名字（4 字）：侧栏行窄、收起后更容易被挤，
				// 设置分区标题与页面标题仍用完整名字。
				navLabel: "重启应用",
				desktopOnly: "仅在桌面版可用",
				desktopOnlyRow: "当前不是桌面版，这一行只在桌面应用里可用。",
				desktopOnlyPanel: "当前不是桌面版；这个面板只在桌面应用里可用。",
				defaultHint: "重启整个 DeepSeek Harness 桌面应用。改了插件或设置、需要重启才生效时用这个。",
				panelDesc: "重启整个桌面应用。正在进行的会话会在关闭时正常保存，不会丢。",
				wholeApp: "重启整个 DeepSeek Harness 桌面应用",
				wholeAppTooltip: "重启整个桌面应用（结束当前实例并重新打开）",
				// 按钮状态
				restarting: "重启中…",
				scheduled: "已排程",
				confirmRestart: "确认重启？",
				stillRestart: "仍要重启？",
				wait: "稍等…",
				retry: "重试",
				restart: "重启",
				// 请求结果
				requestFailed: "请求失败：",
				scheduledRestart: "已排程重启：窗口即将关闭，稍后会自动打开。",
				blockedFallback: "插件正在安装或更新，装完再重启",
				guardFallback: "现在有任务在进行",
				// 硬拦 / 守卫的出路
				blockedSuffix: "；装完之前不能重启。",
				clickTwiceSuffix: "；点两次仍可重启",
				clickTwiceInterruptSuffix: "；现在点两次仍可重启，但那会打断它们。",
				confirmAgainSuffix: "；点「重启」之后还要再确认一次。",
				restartingPageHint: "正在重启…本页马上会断开。",
				warnAgainHint: " 再点一次「仍要重启？」才会执行。",
				// 等空闲再重启（B 项）
				waitAndRestart: "等空闲再重启",
				cancelWaiting: "取消等待",
				waitingScheduled: "已安排：等任务跑完后自动重启。",
				waitingCancelled: "已取消等待；需要时再点重启。",
				waitingSuffix: "；已安排：跑完自动重启。",
				// 守卫的结构化组句（E 项）：宿主只给计数，句子由客户端按语言组
				guardTurns: "{n} 项正在生成或运行工具",
				guardQueued: "{n} 个会话有排队消息",
				guardJobs: "{n} 个后台任务在跑",
				guardTasksLine: "有任务在跑（{parts}）",
				guardInstalling: "插件正在安装或更新",
				guardAsk: "。继续重启会打断它们（正在写的文件可能停在半路），确认要继续吗？",
				listSep: "、",
				lineSep: "；",
				// 确认框
				riskTitle: "重启桌面应用？",
				riskAck: "我知道这会打断上面列出的工作（正在写的文件可能停在半路）",
				riskCancel: "取消",
				riskClose: "关闭",
				riskConfirm: "仍要重启",
				// 无障碍：**只放短状态词，一律 ≤4 个字**（2026-10-20 用户定的口径）。
				// 第三方皮肤（dsh-claude-style 等）会把 aria-label 当可见行标题
				// 画出来（源码实证：getAttribute("aria-label") || textContent），
				// 所以这里不但不能带动态提示，连修饰语也要省掉。
				ariaIdle: "重启应用",
				ariaRestarting: "重启中",
				ariaScheduled: "已排程",
				ariaWarnArmed: "仍要重启",
				ariaWarnWait: "请稍等",
				ariaConfirm: "确认重启",
				ariaError: "重试",
				// 主区面板右上角的状态词（与标题同一行，所以要短）
				statusReady: "就绪",
				statusBusy: "有任务在跑",
				statusWaiting: "等待中",
				statusError: "失败",
				statusDesktopOnly: "仅桌面版",
				// 设置分区
				setTitle: "重启桌面应用",
				setDesc: "勾选要让哪些入口显示出来 —— 改完立即生效，选择保存在这台电脑上。斜杠命令 /restart-desktop 和总开关在插件配置里（config.command / config.enabled）。",
				entryPanelTitle: "侧栏左上角的入口",
				entryPanelHint: "显示在左侧边栏顶部的入口列表里；点一下会在主区域打开重启面板",
				entryFooterTitle: "侧栏底部的入口",
				entryFooterHint: "显示在左侧边栏底部（设置区上方）；点两次直接重启",
				entryHeaderTitle: "会话标题栏的按钮",
				entryHeaderHint: "显示在会话页标题栏右侧，随手可用",
				entryRowTitle: "设置页里的入口",
				entryRowHint: "在「设置 → 通用」里多出一行",
				// 清理
				// 两件与重启无关的顺手功能共用这一个分类（2026-10-20 用户要求：
				// 合并 + 标题只写「附带功能」，不特意标明与重启的关系）。
				extrasSubtitle: "附带功能",
				sweepLabel: "清理遗留的改动快照",
				sweepAutoLabel: "启动时自动清理遗留的改动快照",
				sweepRunLabel: "立即清理",
				sweepRunning: "清理中…",
				sweepRunningLine: "正在清理遗留快照…",
				sweepAria: "立即清理一次遗留快照",
				sweepReading: "正在读取当前设置…",
				sweepOn: "已开启：每次启动时清理一次。",
				sweepOff: "已关闭：不会动 Temp 里的任何东西。",
				sweepLastPrefix: "上次清理",
				sweepJustNow: "刚刚清理过",
				sweepJustNowDone: "刚刚清理过。",
				sweepErrorHead: "出错：",
				sweepFailedTail: "，有 {n} 个没能删掉（多半还被占着）。",
				sweepDoneRemoved: "：清掉 {n} 个遗留快照目录，释放 {mb} MB",
				sweepDoneNone: "：扫描 {n} 个目录，没有需要清理的",
				sweepNotOk: "没成功：",
				sweepUnknown: "未知错误",
				sweepDetailA: "DSH 的「改动快照」每开一个会话就在系统 Temp 建一个目录，被硬杀或崩溃时会留下孤儿。",
				sweepDetailB: "只清理「启动之前就存在、启动之后没被写过、而且已经躺够 24 小时」的目录，活动会话的绝不碰。",
				// 收拾界面
				hideContactLabel: "隐藏账号菜单里的「意见反馈」",
				hideContactOn: "已隐藏：账号菜单里只剩「设置」和登录/退出，不会再误点。",
				hideContactOff: "已显示：那一项会照常出现在「设置」下面。",
			},
			en: {
				pluginName: "Restart Desktop App",
				navLabel: "Restart App",
				desktopOnly: "Desktop app only",
				desktopOnlyRow: "This is not the desktop build; this row works only inside the desktop app.",
				desktopOnlyPanel: "This is not the desktop build; this panel works only inside the desktop app.",
				defaultHint: "Restarts the entire DeepSeek Harness desktop app. Use it after changing plugins or settings so they take effect.",
				panelDesc: "Restarts the whole desktop app. Conversations in progress are saved normally on shutdown — nothing is lost.",
				wholeApp: "Restart the whole DeepSeek Harness desktop app",
				wholeAppTooltip: "Restart the whole desktop app (ends the current instance and opens it again)",
				restarting: "Restarting…",
				scheduled: "Scheduled",
				confirmRestart: "Restart now?",
				stillRestart: "Restart anyway?",
				wait: "Hold on…",
				retry: "Retry",
				restart: "Restart",
				requestFailed: "Request failed: ",
				scheduledRestart: "Restart scheduled: the window will close shortly and reopen by itself.",
				blockedFallback: "A plugin install/update is running; restart again once it finishes",
				guardFallback: "Work is currently in progress",
				blockedSuffix: "; restarting stays blocked until it finishes.",
				clickTwiceSuffix: "; click twice to restart anyway",
				clickTwiceInterruptSuffix: "; you can still click twice to restart, but that would interrupt them.",
				confirmAgainSuffix: "; after clicking Restart you will be asked once more.",
				restartingPageHint: "Restarting… this page is about to disconnect.",
				warnAgainHint: " Click \"Restart anyway?\" once more to proceed.",
				waitAndRestart: "Wait & restart",
				cancelWaiting: "Cancel waiting",
				waitingScheduled: "Scheduled: the restart will run automatically once the running work finishes.",
				waitingCancelled: "Waiting cancelled. Click restart whenever you're ready.",
				waitingSuffix: "; scheduled to restart automatically once they finish.",
				guardTurns: "{n} agents generating or running tools",
				guardQueued: "{n} sessions with queued messages",
				guardJobs: "{n} background jobs running",
				guardTasksLine: "Work in progress ({parts})",
				guardInstalling: "A plugin install/update is running",
				guardAsk: ". Restarting now would interrupt them (files being written may stop halfway). Continue?",
				listSep: ", ",
				lineSep: "; ",
				riskTitle: "Restart the desktop app?",
				riskAck: "I understand this interrupts the work listed above (files being written may be left half-done)",
				riskCancel: "Cancel",
				riskClose: "Close",
				riskConfirm: "Restart anyway",
				ariaIdle: "Restart",
				ariaRestarting: "Restarting",
				ariaScheduled: "Scheduled",
				ariaWarnArmed: "Restart anyway",
				ariaWarnWait: "Hold on",
				ariaConfirm: "Confirm restart",
				ariaError: "Retry",
				statusReady: "Ready",
				statusBusy: "Work running",
				statusWaiting: "Waiting",
				statusError: "Failed",
				statusDesktopOnly: "Desktop only",
				setTitle: "Restart Desktop App",
				setDesc: "Choose which entries are shown — changes apply immediately and are stored on this computer. The /restart-desktop command and the master switch live in the plugin config (config.command / config.enabled).",
				entryPanelTitle: "Sidebar panel entry",
				entryPanelHint: "Shows at the top of the sidebar list; clicking it opens the restart panel in the main area",
				entryFooterTitle: "Sidebar footer entry",
				entryFooterHint: "Shows at the bottom of the sidebar (above Settings); click twice to restart",
				entryHeaderTitle: "Conversation header button",
				entryHeaderHint: "Shows on the right side of the conversation header, always within reach",
				entryRowTitle: "Settings page entry",
				entryRowHint: "Adds one row under Settings → General",
				extrasSubtitle: "Bundled extras",
				sweepLabel: "Sweep leftover change snapshots",
				sweepAutoLabel: "Sweep leftover snapshots on every start",
				sweepRunLabel: "Sweep now",
				sweepRunning: "Sweeping…",
				sweepRunningLine: "Sweeping leftover snapshots…",
				sweepAria: "Sweep leftover snapshots once now",
				sweepReading: "Reading current settings…",
				sweepOn: "On: swept once on every start.",
				sweepOff: "Off: nothing in Temp is ever touched.",
				sweepLastPrefix: "Last sweep",
				sweepJustNow: "just swept",
				sweepJustNowDone: "Swept just now.",
				sweepErrorHead: " failed: ",
				sweepFailedTail: "; {n} could not be removed (probably still in use).",
				sweepDoneRemoved: ": removed {n} leftover snapshot directories, freeing {mb} MB",
				sweepDoneNone: ": scanned {n} directories, nothing to clean up",
				sweepNotOk: "Did not succeed: ",
				sweepUnknown: "unknown error",
				sweepDetailA: "DSH's change snapshots create a directory in the system Temp folder for every session; hard kills and crashes leave them behind as orphans.",
				sweepDetailB: "Only directories that existed before this start, were never written since, and are at least 24 hours old are swept — active sessions are never touched.",
				hideContactLabel: "Hide \"Feedback\" in the account menu",
				hideContactOn: "Hidden: the account menu keeps only Settings and sign-in/out, so it can't be misclicked.",
				hideContactOff: "Shown: the item reappears below Settings as usual.",
			},
		};

		/**
		 * 字典当前的翻译函数。apply() 里会先注册进 ctx.locale 并 rebind，
		 * 这里是**取不到 locale 服务时**的兜底：按浏览器语言挑 zh/en，
		 * 缺键原样返回键名（肉眼可认，好过一片空白）。
		 * @param {string} key - DICT 的键。
		 * @param {Record<string, string | number>} [vars] - 插值变量。
		 * @returns {string} 译文。
		 */
		let t = (key, vars) => {
			let lang = "zh";
			try {
				lang = String(navigator.language || "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
			} catch {
				/* 拿不到 navigator 就按 zh */
			}
			const table = DICT[lang] ?? DICT.zh;
			let text = typeof table[key] === "string" ? table[key] : String(key);
			if (vars !== undefined && vars !== null) {
				for (const [name, value] of Object.entries(vars)) {
					text = text.split("{" + name + "}").join(String(value));
				}
			}
			return text;
		};

		/**
		 * 把宿主给的中文错误消息换成当前语言的译文（有键可译时）。
		 * 宿主半没有 locale 服务，错误消息只写中文；英文界面下直接显示它
		 * 会很突兀。做法：错误响应里带 `code`（blocked / guard / …）时用
		 * 客户端字典重说一遍；纯文本（无 code）就原样显示 —— 宁可中文原文，
		 * 也不编一句宿主没说过的话。
		 * @param {string} hostText - 宿主返回的 message。
		 * @param {string} fallbackKey - 拿不到可译信息时用的字典键。
		 * @returns {string} 给界面显示的文本。
		 */
		function hostMessage(hostText, fallbackKey) {
			const text = String(hostText ?? "");
			if (text === "") return t(fallbackKey);
			return text;
		}

		/** 设置页里每一行的文案：`[标题, 说明]`（字典键，渲染时翻译）。 */
		const ENTRY_LABELS = {
			panel: ["entryPanelTitle", "entryPanelHint"],
			footer: ["entryFooterTitle", "entryFooterHint"],
			header: ["entryHeaderTitle", "entryHeaderHint"],
			settingsRow: ["entryRowTitle", "entryRowHint"],
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

		/**
		 * 「隐藏账号菜单里的『意见反馈』」。
		 *
		 * 那一项**不是本插件的**：它是 DSH 内置账号界面渲染的，位置正好紧挨在
		 * 账号菜单的「设置」下面，点错就跳外部网页。官方没给它 id、也没给 data 属性
		 * （dom 里就是一个光秃秃的 `button[role=menuitem]`），纯 CSS 认不出来，
		 * 所以只能按**文字**认人，等菜单挂进 DOM 之后再把它藏掉。
		 *
		 * 默认**藏着**（容易误点的东西不该默认杵在那儿）。关掉开关的瞬间，被藏起来的
		 * 节点会原样恢复，不用刷新页面。认不出文字时什么都不做 —— 宁可留着，也不误伤。
		 */
		const HIDE_CONTACT_STORE_KEY = "dsh-desktop-restart.hide-contact";
		/** 那一项的文字（中 / 英）。 */
		const CONTACT_LABELS = ["意见反馈", "Feedback"];
		/** 藏起来时打的标记，用来原样恢复。 */
		const HIDER_ATTR = "data-dshdr-hidden";
		/** 账号菜单是点开才挂上 DOM 的，所以是观察器而不是启动时扫一次。 */
		let hiderObserver = null;
		/** 当前是不是藏着（启动时读一次本机保存的值）。 */
		let hideContactOn = readHideContact();

		/**
		 * 读这个开关；没存过时默认**不藏**。
		 *
		 * 2026-10-20 用户定：附带功能对**新用户**一律默认关闭 —— 装上插件不该
		 * 悄悄改掉账号菜单的样子，想藏的人自己在设置里打开。用户明确点过的值
		 * 一律优先（存 "1" / "0"），老用户此前的选择不受影响。
		 */
		function readHideContact() {
			try {
				const raw = window.localStorage.getItem(HIDE_CONTACT_STORE_KEY);
				return raw === null ? false : raw !== "0";
			} catch {
				return false;
			}
		}

		/**
		 * 存这个开关。
		 * @param {boolean} value - 是否隐藏。
		 */
		function writeHideContact(value) {
			try {
				window.localStorage.setItem(HIDE_CONTACT_STORE_KEY, value === true ? "1" : "0");
			} catch {
				/* 写不进去：只对这次会话生效 */
			}
		}

		/**
		 * 把 root 里（含 root 自己）那一项藏起来。
		 * @param {Element} root - 新增的节点，或 document.body。
		 */
		function hideContactIn(root) {
			if (root === null || root === undefined || typeof root.querySelectorAll !== "function") return;
			const found = [];
			if (typeof root.matches === "function" && root.matches("button[role=\"menuitem\"]")) found.push(root);
			for (const item of root.querySelectorAll("button[role=\"menuitem\"]")) found.push(item);
			for (const item of found) {
				const text = (item.textContent || "").trim();
				if (CONTACT_LABELS.indexOf(text) < 0) continue;
				// 官方把每一项包在一个容器里（可能还带一条分隔线）。容器里只有这一项时
				// 连容器一起藏，否则会留下一条孤立的分隔线。
				const parent = item.parentElement;
				const wrapper = parent !== null && parent !== undefined
					&& (parent.textContent || "").trim() === text
					&& parent.querySelectorAll("button[role=\"menuitem\"]").length === 1
					? parent
					: item;
				wrapper.style.display = "none";
				wrapper.setAttribute(HIDER_ATTR, "1");
			}
		}

		/** 开始藏着：先扫一遍现有的，再盯着以后加进来的。 */
		function startHider() {
			if (typeof document === "undefined" || hiderObserver !== null) return;
			hideContactIn(document.body);
			if (typeof MutationObserver !== "function") return;
			hiderObserver = new MutationObserver((records) => {
				for (const record of records) {
					for (const node of record.addedNodes) {
						if (node.nodeType === 1) hideContactIn(node);
					}
				}
			});
			hiderObserver.observe(document.body, { childList: true, subtree: true });
		}

		/** 不藏了：断开观察器，并把已经藏起来的节点原样放开。 */
		function stopHider() {
			if (hiderObserver !== null) {
				hiderObserver.disconnect();
				hiderObserver = null;
			}
			if (typeof document === "undefined") return;
			for (const node of document.querySelectorAll("[" + HIDER_ATTR + "=\"1\"]")) {
				node.style.display = "";
				node.removeAttribute(HIDER_ATTR);
			}
		}

		/**
		 * 拨开关：存下来，并立刻起停（不刷新页面）。
		 * @param {boolean} value - 新的值。
		 */
		function setHideContact(value) {
			hideContactOn = value === true;
			writeHideContact(hideContactOn);
			if (hideContactOn) startHider();
			else stopHider();
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
			"@media (prefers-reduced-motion:reduce){.dshdr-trigger[data-busy=1] svg,.dshdr-foot-badge[data-busy=1] svg,.dshdr-btn[data-busy=1] svg,.dshdr-spin{animation:none}}",			"@container (width<=540px){.dshdr-label{display:none}}",
			// ── 设置页那一行 ─────────────────────────────────────────────────
			".dshdr-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}",
			".dshdr-row-actions{display:flex;align-items:center;gap:8px;flex:none}",
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
			// 只给读屏软件的隐藏文本（aria-describedby 的目标）：不能被看见，
			// 否则又变成「提示混进按钮文字」那个 bug 的另一种形态。
			".dshdr-sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
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
			// 版式照**同座位**的任务看板（[data-dsh-taskboard-view]）：根容器铺满
			// 高度并自带 bg-base，内边距 14/16，标题 16px/700 与右侧状态同一行，
			// 块间距 12，结果用卡片而不是一行灰字。2026-10-20 之前是「32/24 内边距
			// + 560px 窄栏居中 + 无背景」—— 在满高的主区里像一段文字飘在空白中。
			".dshdr-panel{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;height:100%;min-height:0;padding:14px 16px 16px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:var(--dsw-font-family,inherit)}",
			".dshdr-panel-header{display:flex;align-items:center;gap:10px;flex:none;min-width:0}",
			".dshdr-panel-title{color:var(--dsw-alias-label-primary,inherit);margin:0;font-size:16px;font-weight:700;line-height:24px;white-space:nowrap}",
			".dshdr-panel-status{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;line-height:18px}",
			".dshdr-panel-status[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dshdr-panel-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#3fb950)}",
			".dshdr-panel-body{display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;max-width:720px}",
			".dshdr-panel-desc{color:var(--dsw-alias-label-secondary,inherit);margin:0;font-size:14px;line-height:22px}",
			".dshdr-panel-warn{box-sizing:border-box;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:12px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-state-warn-primary,#d29922);font-size:13px;line-height:20px}",
			".dshdr-panel-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dshdr-panel-note{box-sizing:border-box;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:12px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-secondary,inherit);font-size:13px;line-height:20px}",
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
			// ── 清理结果那一行（2026-10-10 第二轮）────────────────────────────
			// 上一轮把回执写进了 `.dshdr-set-hint` —— 那是 12px 的三级灰字，读完
			// 还是「好像没发生什么」。结果行独立、13px、按结果上色（成功绿 / 失败红 /
			// 有没删掉的是警告黄），并排在说明上方，扫一眼就知道成没成。
			".dshdr-set-result{color:var(--dsw-alias-label-secondary,inherit);display:flex;align-items:center;gap:6px;font-size:13px;line-height:20px}",
			".dshdr-set-result[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#3fb950)}",
			".dshdr-set-result[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dshdr-set-result[data-tone=error]{color:var(--dsw-alias-state-error-primary,#f85149)}",
			// 转圈：官方 Button 不接受 data-busy，所以图标自己带一个可复用的类。
			".dshdr-spin{display:inline-flex;transform-origin:center;animation:dshdr-spin 1s linear infinite}",
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
		const DEFAULT_HINT_KEY = "defaultHint";

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
		 * 由结构化计数组一句守卫提示（2026-10-20 E 项）。
		 *
		 * 宿主的 `reasons` 是拼好的中文整句（斜杠命令直接用）；英文界面下原样
		 * 显示会夹一段中文。宿主同时给出 `guard.tasks` / `guard.installs` 的
		 * **计数** —— 有计数时按界面语言自己组句，没有时退回宿主原句（宁可
		 * 中文原文，也不编一句宿主没说过的话）。
		 * @param {object | null} body - 宿主的响应体。
		 * @returns {string} 一句话；没有守卫时为空串。
		 */
		function guardHintOf(body) {
			const guard = body !== null && typeof body === "object" && body.guard !== null && typeof body.guard === "object"
				? body.guard
				: {};
			const tasks = guard.tasks !== null && typeof guard.tasks === "object" ? guard.tasks : null;
			const installs = guard.installs !== null && typeof guard.installs === "object" ? guard.installs : null;
			const lines = [];
			if (tasks !== null && tasks.active === true) {
				const parts = [];
				if (Number(tasks.turns) > 0) parts.push(t("guardTurns", { n: Number(tasks.turns) }));
				if (Number(tasks.queued) > 0) parts.push(t("guardQueued", { n: Number(tasks.queued) }));
				if (Number(tasks.jobs) > 0) parts.push(t("guardJobs", { n: Number(tasks.jobs) }));
				if (parts.length > 0) lines.push(t("guardTasksLine", { parts: parts.join(t("listSep")) }));
			}
			if (installs !== null && installs.running === true) lines.push(t("guardInstalling"));
			if (lines.length > 0) return lines.join(t("lineSep"));
			return Array.isArray(guard.reasons) ? guard.reasons.join("；") : "";
		}

		/**
		 * 问一次宿主：这是不是 Electron 桌面版、现在有多少活在跑、有没有挂起的等待。
		 *
		 * `blocked` 表示宿主的**硬拦**已经生效（插件正在安装/更新，且记录里的
		 * 进程还活着）—— 那种情况下不能再说「仍可重启」。`waiting` 表示宿主
		 * 已挂起「等空闲再重启」，界面据此把等待按钮变成「取消等待」。
		 * @returns {Promise<{ desktop: boolean, guardHint: string, blocked: boolean, waiting: boolean }>} 状态。
		 */
		async function fetchStatus() {
			try {
				const response = await fetch(STATUS_ROUTE, { method: "GET" });
				const body = await response.json().catch(() => null);
				if (response.ok && body) {
					return {
						desktop: body.desktop === true,
						guardHint: guardHintOf(body),
						blocked: body.guard !== null && typeof body.guard === "object" && body.guard.blocked === true,
						waiting: body.waiting !== null && typeof body.waiting === "object",
						// 每个入口的默认开关（config 里配的）
						entries: body.entries !== null && typeof body.entries === "object" ? body.entries : undefined,
						// 孤儿快照清理的开关与上次结果（宿主半给的）
						sweep: body.sweep !== null && typeof body.sweep === "object" ? body.sweep : undefined,
					};
				}
				return { desktop: false, guardHint: "", blocked: false, waiting: false, entries: undefined, sweep: undefined };
			} catch {
				return { desktop: false, guardHint: "", blocked: false, waiting: false, entries: undefined, sweep: undefined };
			}
		}

		/**
		 * 请宿主排程一次重启。
		 *
		 * `force` / `wait` / `cancelWait` 都走查询参数而不是请求体：桌面壳转发
		 * 页面 fetch 时只保证 URL 与头部到达，少一种失败形态就少一类「点了没反应」。
		 * @param {{ force?: boolean, wait?: boolean, cancelWait?: boolean }} options - 动作。
		 * @returns {Promise<{ ok: boolean, text: string, guard?: boolean, blocked?: boolean, waiting?: boolean, cancelled?: boolean }>} 要显示的结果。
		 */
		async function requestRestart(options = {}) {
			const params = [];
			if (options.force === true) params.push("force=1");
			if (options.wait === true) params.push("wait=1");
			if (options.cancelWait === true) params.push("cancelWait=1");
			const query = params.length > 0 ? "?" + params.join("&") : "";
			let response;
			try {
				response = await fetch(RESTART_ROUTE + query, { method: "POST" });
			} catch (error) {
				return { ok: false, text: t("requestFailed") + String((error && error.message) || error) };
			}
			const body = await response.json().catch(() => null);
			if (response.ok && body && body.ok === true) {
				if (body.waiting === true) return { ok: true, waiting: true, text: t("waitingScheduled") };
				if (body.cancelled !== undefined) return { ok: true, cancelled: body.cancelled, text: t("waitingCancelled") };
				return {
					ok: true,
					text: t("scheduledRestart"),
				};
			}
			if (body && body.blocked === true) {
				// 插件正在安装/更新：宿主半**硬拦**，带 force 也过不去。所以这里
				// 绝不能弹「确认继续」—— 那只会让人勾一遍再撞一次墙，直接说清楚。
				return {
					ok: false,
					blocked: true,
					text: hostMessage(body.error, "blockedFallback"),
				};
			}
			if (body && body.guard && body.guard.active === true) {
				return { ok: false, guard: true, text: hostMessage(body.error, "guardFallback") };
			}
			return { ok: false, text: String((body && body.error) || ("HTTP " + response.status)) };
		}

		/**
		 * 按钮上的字。
		 * @param {{ phase: string, armed: boolean }} action - 动作状态。
		 * @returns {string} 文案。
		 */
		function labelOf(action) {
			if (action.phase === "restarting") return t("restarting");
			if (action.phase === "done") return t("scheduled");
			if (action.phase === "warn") return action.armed ? t("stillRestart") : t("wait");
			if (action.phase === "confirm") return t("confirmRestart");
			if (action.phase === "error") return t("retry");
			return t("restart");
		}

		/**
		 * 给读屏软件的一句话：**只描述动作与状态，绝不放详细提示**。
		 *
		 * 2026-10-20（用户上报并实证）：第三方皮肤 dsh-claude-style 接管侧栏底部
		 * 时，把它读到的 `aria-label` 当**可见行标题**画出来 —— 源码是
		 * `B.getAttribute("aria-label") || (B.textContent||"").trim()`。我们曾把
		 * 「有任务在跑（2 项正在生成或运行工具）；点两次仍可重启」整句塞进
		 * aria-label（为了读屏把状态说全），于是那句话被画成了按钮文字。
		 *
		 * 现在：这里只有短状态词；详细提示交给 aria-describedby（见
		 * {@link ariaDescriptionOf}），读屏照样念得到，但不会变成可见文字。
		 * @param {{ phase: string, armed: boolean, desktop: boolean | null }} action - 动作状态。
		 * @returns {string} 无障碍标签（短）。
		 */
		function ariaLabelOf(action) {
			if (action.desktop === false) return t("ariaIdle");
			if (action.phase === "restarting") return t("ariaRestarting");
			if (action.phase === "done") return t("ariaScheduled");
			if (action.phase === "warn") return action.armed ? t("ariaWarnArmed") : t("ariaWarnWait");
			if (action.phase === "confirm") return t("ariaConfirm");
			if (action.phase === "error") return t("ariaError");
			return t("ariaIdle");
		}

		/**
		 * 详细状态提示：**只给 aria-describedby 用**（读屏在标签后补念），
		 * 不进 aria-label —— 理由见 {@link ariaLabelOf}。
		 * @param {object} action - 动作状态。
		 * @returns {string} 详细提示；没有守卫时为空串。
		 */
		function ariaDescriptionOf(action) {
			if (action.guardHint === "") return "";
			if (action.blocked === true) return action.guardHint + t("blockedSuffix");
			if (action.waiting === true) return action.guardHint + t("waitingSuffix");
			return action.guardHint + t("clickTwiceSuffix");
		}

		/**
		 * 给 `aria-describedby` 用的稳定 id：每个挂载实例一个，卸载即弃。
		 * 不用 `useId` —— 本包要兼容 React 16.8+（useRef 就够了）。
		 * @returns {string} 形如 `dshdr-hint-3`。
		 */
		let hintSeq = 0;
		function useHintId() {
			const ref = React.useRef(null);
			if (ref.current === null) {
				hintSeq += 1;
				ref.current = "dshdr-hint-" + String(hintSeq);
			}
			return ref.current;
		}

		/**
		 * 面板右上角的状态词：与标题同一行，所以只放一个短词。
		 * @param {object} action - 动作状态。
		 * @returns {string} 状态词。
		 */
		function statusOf(action) {
			if (action.desktop === false) return t("statusDesktopOnly");
			if (action.phase === "restarting") return t("restarting");
			if (action.phase === "done") return t("scheduled");
			if (action.phase === "error") return t("statusError");
			if (action.waiting === true) return t("statusWaiting");
			if (action.guardHint !== "") return t("statusBusy");
			return t("statusReady");
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
			// 宿主半的硬拦是否生效（插件正在安装/更新）。提示语要靠它区分
			// 「确认后仍可重启」与「装完之前不能重启」—— 后者说前者就是骗人。
			const blockedPair = React.useState(false);
			const blocked = blockedPair[0];
			const setBlocked = blockedPair[1];
			// 宿主是否已挂起「等空闲再重启」（B 项）：挂起时等待按钮变成
			// 「取消等待」，守卫提示后追加「已安排」。
			const waitingPair = React.useState(false);
			const waiting = waitingPair[0];
			const setWaiting = waitingPair[1];

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
					setBlocked(status.blocked === true);
					setWaiting(status.waiting === true);
				}, () => {});
			};

			React.useEffect(() => {
				let live = true;
				fetchStatus().then((status) => {
					if (!live) return;
					setDesktop(status.desktop);
					setGuardHint(status.guardHint);
					setBlocked(status.blocked === true);
					setWaiting(status.waiting === true);
				}, () => {
					if (live) setDesktop(false);
				});
				return () => { live = false; };
			}, []);

			const send = (options) => {
				setPhase("restarting");
				setMessage("");
				requestRestart(options).then((result) => {
					if (result.ok) {
						// 等待挂起与取消都不是「重启已排程」：界面继续可用，
						// 只是状态换一句线。真正的重启仍由 done 那条路走。
						if (result.waiting === true) {
							setWaiting(true);
							setPhase("idle");
							setMessage(result.text);
							return;
						}
						if (result.cancelled !== undefined) {
							setWaiting(false);
							setPhase("idle");
							setMessage(result.text);
							return;
						}
						setPhase("done");
						setMessage(result.text);
						return;
					}
					if (result.blocked === true) {
						// 插件正在安装/更新：宿主半硬拦，连 force 都过不去。所以
						// 这里不弹「确认继续」（勾了也只会再撞一次），只把原因摆出来。
						setBlocked(true);
						setPhase("error");
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

			/** 挂起「等空闲再重启」：不需要两步确认 —— 它本来就不打断任何东西。 */
			const waitForIdle = () => {
				send({ wait: true });
			};

			/** 取消挂起的等待。 */
			const cancelWait = () => {
				send({ cancelWait: true });
			};

			const press = () => {
				if (phase === "restarting" || desktop === false || phase === "done") return;
				if (phase === "warn") {
					// 冷却期内点击直接忽略（按钮此时也是 disabled 的）。
					if (armed) send({ force: true });
					return;
				}
				if (phase === "error") {
					// 上一次请求本身失败了，重试就是再发一次，不必重新武装。
					send({});
					return;
				}
				if (phase !== "confirm") {
					setPhase("confirm");
					expireLater(() => setPhase((current) => (current === "confirm" ? "idle" : current)), CONFIRM_MS);
					return;
				}
				send({});
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
				send({ force: true });
			};

			return {
				phase, message, desktop, guardHint, blocked, waiting, armed, press, refresh, waitForIdle, cancelWait,
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
				title: t("riskTitle"),
				description: action.modal.text,
				acknowledgeLabel: t("riskAck"),
				cancelLabel: t("riskCancel"),
				closeLabel: t("riskClose"),
				confirmLabel: t("riskConfirm"),
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

			// 字典注册进官方 locale 服务（issue #1）：语言跟随 DSH 主应用设置。
			//
			// 接入方式照 dshmarket 的实证写法：服务在导出的 inject 数组里声明
			// （"locale"），之后 **ctx.locale 直接可用**。2026-10-20 的 0.4.0
			// 就是栽在这里：只写了 ctx.get("locale")、inject 里没声明 —— 服务
			// 拿不到，静默落到「按浏览器语言兜底」，主应用切英文也不管用。
			// 取不到服务（组合里没有它）时仍用兜底 t()，绝不起不来。
			try {
				const locale = ctx.locale ?? (typeof ctx.get === "function" ? ctx.get("locale") : undefined);
				if (locale !== undefined && locale !== null
					&& typeof locale.register === "function" && typeof locale.bind === "function") {
					locale.register(LOCALE_NS, DICT);
					const bound = locale.bind(LOCALE_NS);
					if (typeof bound === "function") t = bound;
				}
			} catch {
				/* 注册失败：保留兜底 t()，中文/英文仍按浏览器语言显示 */
			}

			/**
			 * 守卫提示后面那句「你可以怎么办」。
			 *
			 * 两类守卫的出路完全不同：任务在跑是「确认之后仍可重启」；插件正在
			 * 安装/更新则是**硬拦**（宿主半连 force 都不放行）—— 后者再写
			 * 「仍可重启」就是骗人，只能说等它装完。
			 *
			 * 只用 `blocked` 措辞，**不用它禁用按钮**：状态是上一次查询的快照，
			 * 拿它锁人会把「其实已经装完」的情况一起锁住；真正说了算的是点下去
			 * 时宿主半的回答。
			 * @param {object} action - 动作状态。
			 * @param {string} retryText - 非硬拦时追加的那句话。
			 * @returns {string} 追加文本；没有守卫时为空串。
			 */
			function guardSuffix(action, retryKey) {
				if (action.guardHint === "") return "";
				if (action.blocked === true) return t("blockedSuffix");
				if (action.waiting === true) return t("waitingSuffix");
				return t(retryKey);
			}

			/**
			 * 三个入口共用的 tooltip 文案。
			 * @param {object} action - 动作状态。
			 * @returns {string} 提示。
			 */
			function tooltipOf(action) {
				if (action.message !== "") return action.message;
				if (action.desktop === false) return t("desktopOnly");
				if (action.guardHint !== "") return action.guardHint + guardSuffix(action, "clickTwiceSuffix");
				return t("wholeApp");
			}

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

			/**
			 * 「等空闲再重启」按钮（B 项）：只在守卫响着且非桌面版守卫之外的
			 * 场景出现；已挂起等待时变成「取消等待」。放在动作按钮旁边，
			 * 不参与两步确认 —— 等待本来就不打断任何东西。
			 * @param {object} action - 动作状态。
			 * @returns {object | null} 按钮元素，或 null（没有守卫时）。
			 */
			function WaitButton(action) {
				if (action.desktop === false) return null;
				if (action.guardHint === "" && action.waiting !== true) return null;
				const onClick = action.waiting === true ? action.cancelWait : action.waitForIdle;
				const label = action.waiting === true ? t("cancelWaiting") : t("waitAndRestart");
				if (OfficialButton !== null) {
					return React.createElement(OfficialButton, {
						variant: "ghost",
						onClick: onClick,
						onMouseEnter: action.refresh,
						onFocus: action.refresh,
						title: label,
					}, label);
				}
				return React.createElement("button", {
					type: "button",
					className: "dshdr-btn",
					"data-variant": "ghost",
					onClick: onClick,
					onMouseEnter: action.refresh,
					onFocus: action.refresh,
					title: label,
				}, label);
			}

			/** 会话标题栏上的常驻按钮：照官方那个座位里的动作按钮做。 */
			function HeaderRestartButton() {
				const action = useRestart(timer);
				const busy = action.phase === "restarting";
				const title = tooltipOf(action);
				// 详细提示不进 aria-label（皮肤插件会把它当可见标题），走 describedby。
				const described = ariaDescriptionOf(action);
				const hintId = useHintId();

				return React.createElement(React.Fragment, null,
					React.createElement("button", {
						type: "button",
						className: "dshdr-trigger",
						"data-phase": action.phase,
						"data-busy": busy ? "1" : "0",
						disabled: isDisabled(action),
						title: title,
						"aria-label": ariaLabelOf(action),
						"aria-describedby": described === "" ? undefined : hintId,
						"aria-busy": busy ? "true" : undefined,
						onClick: action.press,
						onMouseEnter: action.refresh,
						onFocus: action.refresh,
					},
						Glyph(14),
						React.createElement("span", { className: "dshdr-label" }, labelOf(action))),
					described !== "" && React.createElement("span", { id: hintId, className: "dshdr-sr-only" }, described),
					RiskDialog(action));
			}

			/** 设置页那一行：标题、说明和两步确认的重启按钮。 */
			function SettingsRestartRow() {
				const action = useRestart(timer);
				const busy = action.phase === "restarting";
				const disabled = isDisabled(action);
				const hint = busy
					? t("restartingPageHint")
					: (action.message !== ""
						? (action.phase === "warn" ? action.message + t("warnAgainHint") : action.message)
						: (action.desktop === false
							? t("desktopOnlyRow")
							: (action.guardHint !== ""
								? action.guardHint + guardSuffix(action, "clickTwiceInterruptSuffix")
								: t(DEFAULT_HINT_KEY))));
				const label = labelOf(action);
				const icon = Glyph(14);
				const shared = {
					disabled: disabled,
					title: action.desktop === false ? t("desktopOnly") : t("wholeAppTooltip"),
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
							React.createElement("span", { className: "dshdr-row-label" }, t("pluginName")),
							React.createElement("span", {
								className: "dshdr-hint",
								"data-tone": toneOf(action),
								// 状态变化要能被读屏软件念出来：从「没事」变成「有任务在跑」时，
								// 只靠颜色变化对读屏用户是看不见的。
								"aria-live": "polite",
							}, hint)),
						React.createElement("span", { className: "dshdr-row-actions" }, button, WaitButton(action))),
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
				const title = tooltipOf(action);
				// 这一条最要紧：皮肤插件（dsh-claude-style）接管侧栏底部时，
				// 会把 aria-label 当可见行标题；详细提示只能走 describedby。
				const described = ariaDescriptionOf(action);
				const hintId = useHintId();

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
							"aria-describedby": described === "" ? undefined : hintId,
							"aria-busy": busy ? "true" : undefined,
							onClick: action.press,
							onMouseEnter: action.refresh,
							onFocus: action.refresh,
						},
							Glyph(16),
							React.createElement("span", { className: "dshdr-foot-label" }, labelOf(action)))),
					described !== "" && React.createElement("span", { id: hintId, className: "dshdr-sr-only" }, described),
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
				const label = labelOf(action);
				const disabled = busy
					|| action.phase === "done"
					|| action.desktop === false
					|| (action.phase === "warn" && action.armed === false);
				// 说明文字永远讲「这是什么」；守卫那类动态信息单独占一块警告卡片
				// （原先把它拼进说明里，读起来像一句话被硬接了一截）。
				const desc = action.desktop === false ? t("desktopOnlyPanel") : t("panelDesc");
				const guardWarn = action.guardHint === ""
					? ""
					: action.guardHint + guardSuffix(action, "confirmAgainSuffix");
				const icon = Glyph(16);
				const shared = {
					disabled: disabled,
					title: t("wholeAppTooltip"),
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
						React.createElement("div", { className: "dshdr-panel-header" },
							React.createElement("h2", { className: "dshdr-panel-title" }, t("pluginName")),
							React.createElement("span", {
								className: "dshdr-panel-status",
								"data-tone": toneOf(action),
								"aria-live": "polite",
							}, statusOf(action))),
						React.createElement("div", { className: "dshdr-panel-body" },
							React.createElement("p", { className: "dshdr-panel-desc" }, desc),
							guardWarn !== "" && React.createElement("p", { className: "dshdr-panel-warn" }, guardWarn),
							React.createElement("div", { className: "dshdr-panel-actions" }, button, WaitButton(action)),
							action.message !== "" && React.createElement("p", {
								className: "dshdr-panel-note",
								"aria-live": "polite",
							}, action.message))),
					RiskDialog(action));
			}

			/**
			 * 「隐藏账号菜单里的『意见反馈』」那一行。
			 *
			 * 藏的是一个**内置界面元素**，所以这里什么都不用问宿主：纯客户端行为，
			 * 开关也存本机。默认藏着 —— 那一项恰恰挨着「设置」，最容易点错。
			 * @returns {object} React 元素。
			 */
			function HideContactRow() {
				const countPair = React.useState(0);
				const bump = countPair[1];
				const on = hideContactOn === true;
				/**
				 * 拨一下开关：官方 Switch 给布尔值，万一将来给别的形状，就按「切换」理解。
				 * @param {unknown} next - 座位传来的新值。
				 */
				const toggle = (next) => {
					setHideContact(typeof next === "boolean" ? next : !on);
					bump((n) => n + 1);
				};
				const label = t("hideContactLabel");
				const control = OfficialSwitch !== null
					? React.createElement(OfficialSwitch, {
						checked: on,
						onChange: toggle,
						label: label,
					})
					: React.createElement("input", {
						type: "checkbox",
						checked: on,
						"aria-label": label,
						onChange: (event) => { toggle(event.target.checked); },
					});
				return React.createElement("div", { className: "dshdr-set-row" },
					React.createElement("span", { className: "dshdr-set-text" },
						React.createElement("span", { className: "dshdr-set-label" }, label),
						React.createElement("span", { className: "dshdr-set-hint", "aria-live": "polite" },
							on ? t("hideContactOn") : t("hideContactOff"))),
					React.createElement("span", { className: "dshdr-set-actions" }, control));
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
				// 上一次手动清理的结果：`{ tone, text }`。`null` = 这次会话里还没点过。
				const resultPair = React.useState(null);
				const result = resultPair[0];
				const setResult = resultPair[1];

				React.useEffect(() => {
					let live = true;
					fetchStatus().then((status) => {
						if (live && status.sweep !== undefined) setSweep(status.sweep);
					}, () => {});
					return () => { live = false; };
				}, []);

				/** 把宿主给的时间戳写成 HH:MM:SS；读不出来就回空串。 */
				const clockOf = (iso) => {
					const at = new Date(String(iso ?? ""));
					if (Number.isNaN(at.getTime())) return "";
					const two = (n) => String(n).padStart(2, "0");
					return " " + two(at.getHours()) + ":" + two(at.getMinutes()) + ":" + two(at.getSeconds());
				};

				/**
				 * 把一次清理的结果写成一句人话。
				 *
				 * **永远要说点什么，而且要带上时间戳。** 清理绝大多数时候的结果是「扫描
				 * 6 个、删掉 0 个」—— 如果这次跟上次一模一样，界面上就毫无变化，用户会
				 * 以为按钮坏了（2026-10-10 实测：点击其实成功，只是看不出区别）。时间戳
				 * 让「又跑了一次」这件事看得见。
				 * @param {object} result - 宿主返回的 last。
				 * @param {string} [prefixKey] - 前缀的字典键；手动清理时用 sweepJustNow。
				 * @returns {string} 一句话。
				 */
				const describe = (result, prefixKey) => {
					const head = t(prefixKey ?? "sweepLastPrefix") + clockOf(result.at);
					if (result.error) return head + t("sweepErrorHead") + String(result.error);
					const failed = Number(result.failed || 0);
					const tail = failed > 0 ? t("sweepFailedTail", { n: failed }) : "。";
					if (result.removed > 0) {
						return head + t("sweepDoneRemoved", {
							n: result.removed,
							mb: (Number(result.bytes || 0) / 1048576).toFixed(1),
						}) + tail;
					}
					return head + t("sweepDoneNone", { n: result.scanned ?? 0 }) + tail;
				};

				/**
				 * 这次结果该用什么颜色：出错是红，有没删掉的是警告黄，其余是成功绿。
				 * @param {object} result - 宿主返回的 last。
				 * @returns {string} `ok` / `warn` / `error`。
				 */
				const toneOf = (result) => {
					if (result.error) return "error";
					return Number(result.failed || 0) > 0 ? "warn" : "ok";
				};

				/**
				 * 打一次宿主路由，并把结果反映到这一行上。
				 * @param {string} query - 查询串（`?enabled=1` / `?enabled=0` / `?run=1`）。
				 * @param {boolean} manual - 是不是「立即清理」按钮触发的（决定要不要留一句回执）。
				 */
				const call = (query, manual) => {
					setBusy(true);
					if (manual === true) setResult(null);
					fetch(SWEEP_ROUTE + query, { method: "POST" })
						.then((response) => response.json().catch(() => null))
						.then((body) => {
							if (body && body.ok === true) {
								const next = body.last ?? null;
								setSweep({ enabled: body.enabled === true, last: next });
								// 手动清一次必须留下看得见的痕迹，哪怕结果和上次完全相同
								// —— 清理绝大多数时候就是「扫描 6 个、删掉 0 个」。
								if (manual === true) {
									setResult(next === null
										? { tone: "ok", text: t("sweepJustNowDone") }
										: { tone: toneOf(next), text: describe(next, "sweepJustNow") });
								}
							} else if (manual === true) {
								setResult({ tone: "error", text: t("sweepNotOk") + String((body && body.error) || t("sweepUnknown")) });
							}
						}, (error) => {
							if (manual === true) {
								setResult({ tone: "error", text: t("requestFailed") + String((error && error.message) || error) });
							}
						})
						.finally(() => { setBusy(false); });
				};

				const enabled = sweep !== null && sweep.enabled === true;
				const last = sweep !== null && sweep.last ? sweep.last : null;
				let hint;
				if (sweep === null) hint = t("sweepReading");
				else if (last !== null) hint = describe(last);
				else if (enabled) hint = t("sweepOn");
				else hint = t("sweepOff");

				const detail = t("sweepDetailA") + t("sweepDetailB");
				/**
				 * 开关被拨动。官方 Switch 给的是布尔值；万一将来换成事件对象之类，
				 * 就按「切换」理解，别让开关卡住不动。
				 * @param {unknown} next - 座位传来的新值。
				 */
				const toggle = (next) => {
					const on = typeof next === "boolean" ? next : enabled !== true;
					call(on ? "?enabled=1" : "?enabled=0", false);
				};
				const control = OfficialSwitch !== null
					? React.createElement(OfficialSwitch, {
						checked: enabled,
						disabled: sweep === null || busy,
						onChange: toggle,
						label: t("sweepAutoLabel"),
					})
					: React.createElement("input", {
						type: "checkbox",
						checked: enabled,
						disabled: sweep === null || busy,
						"aria-label": t("sweepAutoLabel"),
						onChange: (event) => { toggle(event.target.checked); },
					});
				const runLabel = busy ? t("sweepRunning") : t("sweepRunLabel");
				const runNow = () => { call("?run=1", true); };
				// 跑起来时图标转圈：光换文字标签在设置页里太轻，不像「正在做事」。
				const runIcon = busy ? React.createElement("span", { className: "dshdr-spin" }, Glyph(14)) : null;
				const runButton = OfficialButton !== null
					? React.createElement(OfficialButton, {
						variant: "ghost",
						disabled: busy,
						onClick: runNow,
						"aria-label": t("sweepAria"),
					}, runIcon, runLabel)
					: React.createElement("button", {
						type: "button",
						className: "dshdr-btn",
						"data-variant": "ghost",
						"data-busy": busy ? "1" : "0",
						disabled: busy,
						onClick: runNow,
						"aria-label": t("sweepAria"),
					}, runIcon, runLabel);

				// 结果行：点过之后才有，按结果上色，一直留到下一次点击。
				const shown = busy ? { tone: "", text: t("sweepRunningLine") } : result;
				const resultLine = shown === null ? null : React.createElement("span", {
					className: "dshdr-set-result",
					"data-tone": shown.tone === "" ? undefined : shown.tone,
					"aria-live": "polite",
				}, React.createElement("span", { className: busy ? "dshdr-spin" : undefined }, Glyph(14)),
					React.createElement("span", null, shown.text));

				return React.createElement("div", { className: "dshdr-set-row" },
					React.createElement("span", { className: "dshdr-set-text" },
						React.createElement("span", { className: "dshdr-set-label" }, t("sweepLabel")),
						resultLine,
						React.createElement("span", { className: "dshdr-set-hint" }, hint),
						React.createElement("span", { className: "dshdr-set-hint" }, detail)),
					React.createElement("span", { className: "dshdr-set-actions" }, runButton, control));
			}

			/**
			 * 插件自己的设置分区（`settings.section`，官方给插件留的座位）：
			 * 上面是四个客户端入口的开关（改完**立即生效**，选择存在本机浏览器）；
			 * 下面把两件**与重启无关**的顺手功能归进同一个「附带功能」分类。
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
						? React.createElement(OfficialSwitch, { checked: checked, onChange: toggle, label: t(copy[0]) })
						: React.createElement("input", {
							type: "checkbox",
							checked: checked,
							"aria-label": t(copy[0]),
							onChange: (event) => toggle(event.target.checked),
						});
					return React.createElement("div", { className: "dshdr-set-row", key: key },
						React.createElement("span", { className: "dshdr-set-text" },
							React.createElement("span", { className: "dshdr-set-label" }, t(copy[0])),
							React.createElement("span", { className: "dshdr-set-hint" }, t(copy[1]))),
						control);
				});
				return React.createElement("div", { className: "dshdr-set-page" },
					React.createElement("h2", { className: "dshdr-set-title" }, t("setTitle")),
					React.createElement("p", { className: "dshdr-set-desc" }, t("setDesc")),
					...rows,
					React.createElement("h3", { className: "dshdr-set-subtitle" }, t("extrasSubtitle")),
					React.createElement(SweepRow),
					React.createElement(HideContactRow));
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
						// 侧栏入口用短名字（4 字）：这一行由侧栏自己画，宽度有限，
						// 收起/被第三方皮肤镜像时更容易被挤长。
						label: () => t("navLabel"),
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
						label: t("navLabel"),
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

			// 顺手把账号菜单里那一项藏起来（默认藏；开关在插件自己的设置分区里）。
			if (hideContactOn) startHider();
			ctx.effect(() => () => stopHider());

			// 插件自己的设置分区（开关页）—— 它本身不受开关影响，否则关掉就回不来了。
			ctx.effect(() => slots.inject(SETTINGS_SECTION_SLOT, () => slots.register({
				name: SETTINGS_SECTION_SLOT,
				id: ID,
				order: 90,
				label: () => t("pluginName"),
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

		module.exports = { name: ID, inject: ["slots", "locale"], apply };
		return module.exports;
	}
});
