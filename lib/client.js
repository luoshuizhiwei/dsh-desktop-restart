/**
 * Client half of dsh-desktop-restart.
 *
 * 面板、底栏、标题栏和账号菜单共用宿主状态；设置通用行只读并刷新。
 * 宿主另提供 /restart-desktop 命令。空闲时按钮两击提交普通等待请求；
 * 最近查询已知有任务时两击强制立即重启，带冷却及过期窗口。
 * 等待/倒计时/暂停期间主按钮锁定。安装及实例身份守卫不能被强制绕过。
 * 桌面主进程没有公开重启接口，实际停止与拉起由分离 helper 执行。
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

/**
 * 文件分节：模块外壳、常量、双语字典、纯判定、本机存储、样式、
 * 路由请求、共享 store、组件、入口/设置注册、导出。
 * apply 内的组件共用当前宿主服务；本轮不进行模块拆分。
 */
// ── §1 模块外壳（loader / 运行时 / 官方组件） ──────────────────────────
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
		const OfficialSwitch = UI && typeof UI.Switch === "function" ? UI.Switch : null;

		// ── §2 常量（路由 / 座位 / 开关 / 文案键） ───────────────────────────
		/** 本包自己的宿主路由。 */
		const RESTART_ROUTE = "/dsh-desktop-restart/api/restart";
		const STATUS_ROUTE = "/dsh-desktop-restart/api/status";
		const SWEEP_ROUTE = "/dsh-desktop-restart/api/sweep";
		/** 设置写路由（清理专用；sweep 是它的旧路径）。 */
		const PREFS_ROUTE = "/dsh-desktop-restart/api/prefs";
		/** 第一次点击「武装」按钮的有效期。 */
		const CONFIRM_MS = 5000;
		const REQUEST_TIMEOUT_MS = 10000;

		/** 当前时间（毫秒）。测试可注入 window.__dshdrNow；生产与 Date.now() 一致。 */
		function nowMs() {
			if (typeof window !== "undefined" && typeof window.__dshdrNow === "function") return window.__dshdrNow();
			return Date.now();
		}
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
		const ENTRY_KEYS = ["panel", "footer", "header", "settingsRow", "accountMenu", "headerRefresh"];
		const ENTRY_STORE_KEY = "dsh-desktop-restart.entries";

		/** 设置页里每一行的文案：`[标题, 说明]`（字典键，渲染时翻译）。 */
		const ENTRY_LABELS = {
			panel: ["entryPanelTitle", "entryPanelHint"],
			footer: ["entryFooterTitle", "entryFooterHint"],
			header: ["entryHeaderTitle", "entryHeaderHint"],
			settingsRow: ["entryRowTitle", "entryRowHint"],
			accountMenu: ["entryAccountTitle", "entryAccountHint"],
			headerRefresh: ["entryHeaderRefreshTitle", "entryHeaderRefreshHint"],
		};

		/** 默认提示文案：说明这一行和「重启 dsh web」的区别。 */
		const DEFAULT_HINT_KEY = "defaultHint";

		// ── §3 i18n 字典（zh + en）与兜底翻译函数 t() ────────────────────────
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
				requestTimedOut: "请求超过 10 秒未返回",
				settingSaveUncertain: "保存结果尚未确认，已尝试重新读取；请核对后再试：",
				submissionUnknown: "提交结果尚未确认，正在核对宿主状态。请勿重复提交；若一直无法确认，请手动退出并重新打开应用。",
				submissionReconciled: "已核对宿主状态，可以重新操作。",
				recoveryAckFailed: "重启客户端恢复回执尚未保存，请刷新状态重试。",
				"reason_ready-unconfirmed": "宿主或重启客户端尚未确认恢复",
				"reason_submission-unknown": "提交结果尚未确认，请先核对宿主状态",
				guardUnknown: "无法核实任务忙闲，普通请求会继续等待",
				taskCheckTitle: "任务检查",
				taskVerified: "已核实",
				taskUnknown: "尚未核实",
				nextCountdown: "下次空闲后倒计时",
				secondsValue: "{sec} 秒",
				entriesGroup: "显示入口",
				behaviorGroup: "重启行为",
				headerCancelled: "已取消",
				headerNoWait: "没有等待",
				headerResult: "操作结果",
				cookieNoSample: "尚无停机检查结果",
				// 通用
				pluginName: "重启桌面应用",
				// 两个**侧栏入口**用的短名字（4 字）：侧栏行窄、收起后更容易被挤，
				// 设置分区标题与页面标题仍用完整名字。
				navLabel: "重启应用",
				desktopOnly: "仅在桌面版可用",
				desktopOnlyRow: "当前不是桌面版，这一行只在桌面应用里可用。",
				desktopOnlyPanel: "当前不是桌面版；这个面板只在桌面应用里可用。",
				defaultHint: "重启整个 DeepSeek Harness 桌面应用。改了插件或设置、需要重启才生效时用这个。",
				panelDesc: "重启整个桌面应用。重启会打断正在进行的工作；正常关闭时通常会保存会话，但异常强制结束时最后一段记录可能不完整。建议先等空闲再重启。",
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
				// 2026-10-29 文案修正：第一击已直达 warn（两击强制），旧句
				// 「点「重启」之后还要再确认一次」描述的是已废弃的三步流程。
				confirmAgainSuffix: "；点「重启」之后还要再确认一次。",
				forceTwoClickSuffix: "；点两次强制重启，会打断它们。",
				warnConfirmLine: "再点一次确认强制重启（{sec} 秒内有效）",
				cookieReasonSqlite: "当前 Node 不支持内置 SQLite，已跳过检查和清理。",
				cookieReasonRunning: "旧实例尚未完全退出，已跳过检查和清理。",
				cookieReasonDatabase: "数据库不可用或仍被锁定，未强行读取或清理。",
				cookieReasonBackup: "备份未完成；原数据库未修改。",
				cookieReasonOther: "检查或备份未完成，请查看重启日志。",
				cookieReasonTimeout: "检查超过 8 秒，已结束检查并继续重启；显示上次样本。",
				announceCountdown: "已进入重启倒计时",
				cookieTitle: "认证 Cookie 健康",
				cookieManual: "已超限：先完全退出 DSH，运行中 Cookies 文件被锁定。请先保留备份，再手动删除 %APPDATA%\\@deepseek-ai\\dsh-desktop\\Network\\Cookies（启动时会重建，可能需要重新登录），或使用浏览器开发者工具清理 Cookie。本插件不会自动删除。",
				cookieNormal: "正常",
				cookieNear: "接近上限",
				cookieExceeded: "已超限",
				cookieUnavailable: "无法读取",
				cookieSnapshot: "上次停机检查结果（估算，非实时值）",
				cookieLocked: "运行中无法读取：DSH 独占 Cookie 数据库；只在通过本插件重启、旧实例完全退出后检查。",
				cookieUsed: "估算已用",
				cookieLimit: "默认上限",
				cookieCount: "dsh-auth-* 条数",
				cookieChecked: "上次检查时间",
				cookieNever: "尚未检查",
				cookieRecheck: "重新检查（需在重启时完成）",
				cookiePending: "已安排下次通过本插件重启时检查；此操作不会立即重启。",
				cookieBackup: "重启时备份 Cookie 数据库",
				cookieWarn: "Cookie 接近上限时提前警告（80%）",
				cookieRisk: "仅保存数据库副本，保留最近 3 份；不会自动删除 Cookie 或改变登录状态。",
				cookieBenefit: "默认关闭。备份不会降低请求头大小。",
				cookieWarning: "上次估算达到上限的 80% 或以上，请到附带功能查看手动处理指引。",
				cookieError: "上次停机检查未完成；未强行访问数据库。原因：",
				cookieEstimate: "估算包含 127.0.0.1 的 Cookie 存储长度和 350 字节其他头部；加密存储会带来高估，不是精确请求头。",
				cookieUnsupported: "宿主暂不支持 Cookie 健康检查。",
				cookieFailed: "检查失败",
				entryHeaderRefreshTitle: "标题栏的刷新按钮",
				entryHeaderRefreshHint: "在会话标题栏显示「刷新」按钮（只刷新插件状态，不重载页面）",
				entryAccountTitle: "在账号菜单里显示重启",
				entryAccountHint: "依赖桌面应用内部菜单结构；不兼容时自动跳过。",
				accountRestart: "重启桌面应用",
				warnExpireSetting: "强制重启确认有效时间（5–60 秒）",
				saveWarnExpire: "保存有效时间",
				restartingPageHint: "正在重启…本页马上会断开。",
				warnAgainHint: " 再点一次「仍要重启？」才会执行。",
				// 等空闲再重启（B 项）
				waitAndRestart: "等空闲再重启",
				cancelWaiting: "取消等待",
				refreshShort: "刷新",
				settingsRestartMoved: "重启在会话标题栏执行",
				forceNow: "仍要立即重启",
				waitingScheduled: "已安排：等任务跑完后自动重启。",
				waitingCancelled: "已取消等待；需要时再点重启。",
				nothingToCancel: "当前没有等待中的请求（可能已经开始执行）。",
				waitingLine: "等待中：自 {at} 起已等 {elapsed} 秒（最长 {max} 分钟，空闲后自动重启）",
				expectedRestart: "上次同类重启交接约 {sec} 秒，可作参考。",
				"reason_args-uncertain": "读不出旧实例的启动参数，为避免丢配置，这次没有执行。可手动重开应用。",
				"reason_bad-handoff": "重启交接信息不完整，已中止。可重试一次；仍失败请手动重开应用。",
				"reason_helper-died": "辅助进程中途退出了，重启没有完成。可再试一次。",
				"reason_helper-exited": "辅助进程已退出且未确认新实例就绪。请确认窗口是否已恢复。",
				"reason_helper-spawn-failed": "无法启动辅助进程，重启没有执行。可手动重开应用。",
				"reason_host-kill-failed": "旧实例没能关闭，重启中止。可再试一次，或手动重开应用。",
				"reason_identity-changed": "目标进程的身份在操作中途变了，为安全起见中止。可再试一次。",
				"reason_identity-unproven": "无法证明要关闭的就是当前实例，为安全起见没有动手。可再试一次。",
				"reason_port-foreign": "端口被另一个实例占着，归属不明，已中止。请确认没有其它实例在运行。",
				"reason_port-held": "旧端口一直没释放，重启中止。可再试一次。",
				"reason_ready-port-missing": "新实例起来了但没找到监听端口，结果无法确认。请查看窗口是否正常。",
				"reason_ready-unverifiable": "无法确认新实例是否就绪。请查看窗口是否正常。",
				"reason_record-missing": "这次操作的状态记录缺失，无法判断进度。请确认窗口状态，必要时手动重开。",
				"reason_relaunch-failed": "新实例没能启动，重启失败。可手动重开应用。",
				"reason_state-write-failed": "无法保存操作状态，为安全起见没有动手。可再试一次。",
				"reason_stop-failed": "旧实例没能正常关闭，重启中止。可再试一次，或手动重开应用。",
				"reason_timeout": "等了很久仍未完成，结果不确定。请确认窗口状态，必要时再点一次。",
				waitingSuffix: "；已安排：跑完自动重启。",
				// 守卫的结构化组句（E 项）：宿主只给计数，句子由客户端按语言组
				guardTurns: "{n} 项正在生成或运行工具",
				guardQueued: "{n} 个会话有排队消息",
				guardJobs: "{n} 个后台任务在跑",
				guardTasksLine: "有任务在跑（{parts}）",
				guardInstalling: "插件正在安装或更新",
				guardAsk: "。继续重启会打断它们（正在写的文件可能停在半路）。",
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
				ariaUnknown: "结果未知",
				// 倒计时/暂停/等待的短状态词（≤4 字，无动态数字——数字
				// 由 labelCountdown 拼接，动态内容走 aria-describedby）。
				ariaCountdown: "倒计时",
				ariaPaused: "已暂停",
				ariaWaiting: "等待中",
				// 主区面板右上角的状态词（与标题同一行，所以要短）
				statusReady: "就绪",
				statusBusy: "有任务在跑",
				statusWaiting: "等待中",
				statusError: "失败",
				statusDesktopOnly: "仅桌面版",
				statusUnavailable: "暂时无法读取桌面应用状态，请重试。",
				statusUnknown: "结果未知",
				retryStatus: "重试状态",
				refreshStatus: "刷新状态",
				// 重启完成回执（2026-10-21）：{time} 是本机时刻，{sec} 是停机秒数
				restartReceipt: "宿主已于 {time} 恢复（交接 {sec} 秒）",
				opScheduled: "已排程，等待辅助进程核验…",
				opVerify: "正在核验目标进程…",
				opStop: "正在关闭旧实例…",
				opPortWait: "等待端口释放…",
				opLaunch: "正在打开新实例…",
				opReady: "等待界面就绪…",
				opOk: "宿主与重启客户端已连通。其他插件和任务的恢复请在界面核对。",
				opFailed: "重启没有成功：{reason}",
				opUnknown: "重启结果不确定：{reason}。请确认窗口是否已恢复，必要时再试一次。",
				opReason: "见诊断信息",
				// 设置分区
				setTitle: "重启桌面应用",
				setDesc: "勾选要让哪些入口显示出来 —— 改完立即生效，选择保存在这台电脑上。斜杠命令 /restart-desktop 和总开关在插件配置里（config.command / config.enabled）。",
				localSaveFailed: "保存失败，已保留原设置：",
				noticeTitle: "重启诊断",
				noticeRead: "标记已读",
				noticeHistory: "已读诊断",
				noticeDetails: "展开脱敏详情",
				noticeDelivery: "系统通知未确认可见；此提醒会保留至明确标记已读。",
				noticeError: "诊断读取或已读保存失败，请重试。",
				requestDeadline: "最晚 {at} 自动取消（30 分钟总期限）",
				requestCountdown: "倒计时：{sec} 秒后执行",
				requestPaused: "倒计时已暂停，等待你的选择。",
				// 2026-10-26 缺陷 2：倒计时/暂停/等待必须出现在用户点击的那个入口。
				// 标题栏与侧栏不渲染主面板的 waitingLine 段落，所以按钮文字
				// 本身要带上状态。labelCountdown 形如「5s」。
				labelCountdown: "{sec}s",
				labelPaused: "已暂停",
				labelWaiting: "等待中",
				// 2026-10-28 等待态主按钮锁定：主按钮文字改禁用语义，
				// 不再显示「等待中」状态词（那看起来像个可点的状态标签）。
				labelLocked: "已锁定",
				continueWaiting: "继续等待",
				cancelRequest: "取消请求",
				confirmNow: "确认立即重启",
				confirmNowHint: "立即重启会跳过等待和倒计时，可能打断工作。安装和身份保护仍然有效。",
				hostTooOld: "宿主版本过旧，请重启应用",
				countdownSetting: "空闲后倒计时（0–60 秒）",
				saveCountdown: "保存倒计时",
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
				sweepLabel: "遗留快照扫描预览",
				sweepAutoLabel: "启动时自动扫描遗留快照（仅预览）",
				sweepCancel: "取消扫描",
				sweepRunLabel: "立即扫描预览",
				sweepRunning: "扫描中…",
				sweepRunningLine: "正在扫描遗留快照…",
				sweepAria: "立即扫描一次遗留快照预览",
				sweepReading: "正在读取当前设置…",
				sweepOn: "已开启：每次启动时扫描并预览候选项，不会删除。",
				sweepOff: "已关闭：启动时不会自动扫描。",
				sweepLastPrefix: "上次扫描",
				sweepJustNow: "刚刚扫描",
				sweepJustNowDone: "扫描已完成。",
				sweepErrorHead: "出错：",
				sweepDoneNone: "：扫描 {scanned} 项，未删除项目",
				sweepPreview: "：扫描 {scanned} 项，发现 {count} 个候选项（估算 {mb} MB）；仅预览，未删除",
				sweepSkippedOwner: "未删除原因：无法确认候选项归属。",
				sweepSkippedActive: "未删除原因：宿主仍有活动会话。",
				sweepSkippedOther: "未删除原因：当前仅提供预览，不会删除候选项。",
				sweepRecovery: "操作失败：{error}",
				sweepRetryRead: "重试读取",
				sweepRetryWrite: "重试上次操作",
				sweepNotOk: "没成功：",
				// 问题 2：扫描失败/不完整要能看懂，不要把对象拼成 [object Object]
				sweepErrorShort: "读取临时目录失败（{code}）：这次没有完成扫描。",
				sweepPartialShort: "扫描未完成（已取消或超出预算），下面是已扫描到的部分结果。",
				sweepPrefiltered: " 已预先排除 {n} 项。",
				sweepPartialSummary: "已扫描 {scanned} 项，发现 {count} 个候选项（估算 {mb} MB）；仅预览，未删除。",
				sweepUnknown: "未知错误",
				sweepDetailA: "DSH 的「改动快照」会在系统 Temp 创建目录，异常退出后可能遗留。",
				sweepDetailB: "当前版本只扫描并预览候选项，不会删除，也不代表候选容量已经释放。",
				// 收拾界面
				hideContactLabel: "隐藏账号菜单里的「意见反馈」",
				hideContactOn: "已隐藏：账号菜单里只剩「设置」和登录/退出，不会再误点。",
				hideContactOff: "已显示：那一项会照常出现在「设置」下面。",
			},
			en: {
				requestTimedOut: "No response within 10 seconds",
				settingSaveUncertain: "Save outcome is unconfirmed; a read-back was attempted. Check before retrying: ",
				submissionUnknown: "Submission is unconfirmed; checking host state. Do not resubmit. If it remains unconfirmed, quit and reopen the app manually.",
				submissionReconciled: "Host state checked; actions are available again.",
				recoveryAckFailed: "The restart client recovery receipt was not saved. Refresh status to retry.",
				"reason_ready-unconfirmed": "Host or restart client recovery is unconfirmed",
				"reason_submission-unknown": "Submission is unconfirmed; check host state first",
				guardUnknown: "Task activity is unverified; a normal request will keep waiting",
				taskCheckTitle: "Task check",
				taskVerified: "Verified",
				taskUnknown: "Not yet verified",
				nextCountdown: "Next idle countdown",
				secondsValue: "{sec}s",
				entriesGroup: "Visible entries",
				behaviorGroup: "Restart behavior",
				cookieNoSample: "No downtime sample yet",
				pluginName: "Restart Desktop App",
				navLabel: "Restart App",
				desktopOnly: "Desktop app only",
				desktopOnlyRow: "This is not the desktop build; this row works only inside the desktop app.",
				desktopOnlyPanel: "This is not the desktop build; this panel works only inside the desktop app.",
				defaultHint: "Restarts the entire DeepSeek Harness desktop app. Use it after changing plugins or settings so they take effect.",
				panelDesc: "Restarts the whole desktop app. A restart interrupts work in progress; sessions are usually saved on a normal shutdown, but an abnormal forced stop can leave the last part of a record incomplete. Prefer waiting until idle.",
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
				// 2026-10-29 copy fix: the first click now goes straight to warn
				// (two clicks force-restart); the old three-step wording is stale.
				confirmAgainSuffix: "; after clicking Restart you will be asked once more.",
				forceTwoClickSuffix: "; click twice to force-restart, interrupting them.",
				warnConfirmLine: "Click once more to confirm the force-restart (valid for {sec}s)",
				cookieReasonSqlite: "This Node runtime does not support built-in SQLite; checking and backup were skipped.",
				cookieReasonRunning: "The old instance has not fully exited; checking and backup were skipped.",
				cookieReasonDatabase: "The database is unavailable or still locked; reading and backup were not forced.",
				cookieReasonBackup: "Backup did not complete; the original database was not modified.",
				cookieReasonOther: "The check or backup did not complete; see the restart log.",
				cookieReasonTimeout: "The check exceeded 8 seconds and was stopped before relaunch; showing the previous sample.",
				announceCountdown: "Restart countdown started",
				cookieTitle: "Authentication Cookie health",
				cookieManual: "Over limit: fully quit DSH first; Cookies is locked while running. Keep a backup, then manually delete %APPDATA%\\@deepseek-ai\\dsh-desktop\\Network\\Cookies (rebuilt at launch; sign-in may be required), or clear Cookies using browser developer tools. This plugin never deletes them.",
				cookieNormal: "Normal",
				cookieNear: "Near limit",
				cookieExceeded: "Over limit",
				cookieUnavailable: "Unavailable",
				cookieSnapshot: "Last downtime check (estimate, not live)",
				cookieLocked: "Cannot read while running: DSH exclusively locks the Cookie database. Checks run only after the old instance fully exits during a restart through this plugin.",
				cookieUsed: "Estimated usage",
				cookieLimit: "Default limit",
				cookieCount: "dsh-auth-* count",
				cookieChecked: "Last check",
				cookieNever: "Not checked yet",
				cookieRecheck: "Check again (during next restart)",
				cookiePending: "Scheduled for the next restart through this plugin; this does not restart the app now.",
				cookieBackup: "Back up Cookie database during restart",
				cookieWarn: "Warn when Cookies approach the limit (80%)",
				cookieRisk: "Only saves database copies, retaining the latest 3; never deletes Cookies or changes sign-in state.",
				cookieBenefit: "Off by default. Backups do not reduce header size.",
				cookieWarning: "Last estimate reached at least 80% of the limit. See bundled extras for manual guidance.",
				cookieError: "The last downtime check did not complete; database access was not forced. Reason: ",
				cookieEstimate: "Estimate includes stored Cookie lengths for 127.0.0.1 plus 350 bytes for other headers. Encrypted storage can overestimate usage; this is not an exact request header.",
				cookieUnsupported: "This host does not support Cookie health checks yet.",
				cookieFailed: "Check failed",
				entryHeaderRefreshTitle: "Refresh button in the session header",
				entryHeaderRefreshHint: "Show a Refresh button in the session header (refreshes plugin status only; never reloads the page)",
				entryAccountTitle: "Show restart in the account menu",
				entryAccountHint: "Uses the desktop app’s internal menu structure; skips incompatible menus.",
				accountRestart: "Restart desktop app",
				warnExpireSetting: "Force-restart confirmation window (5–60 seconds)",
				saveWarnExpire: "Save window",
				restartingPageHint: "Restarting… this page is about to disconnect.",
				warnAgainHint: " Click \"Restart anyway?\" once more to proceed.",
				waitAndRestart: "Wait & restart",
				cancelWaiting: "Cancel waiting",
				refreshShort: "Refresh",
				settingsRestartMoved: "Restart from the session title bar",
				forceNow: "Restart now anyway",
				waitingScheduled: "Scheduled: the restart will run automatically once the running work finishes.",
				waitingCancelled: "Waiting cancelled. Click restart whenever you're ready.",
				nothingToCancel: "There was no pending wait to cancel (the restart may already be running).",
				waitingLine: "Waiting: {elapsed}s since {at} (up to {max} min; starts automatically when idle)",
				expectedRestart: "The last restart handoff took about {sec}s; use it as a rough guide.",
				"reason_args-uncertain": "Could not read the running instance's launch arguments, so nothing was done. Reopen the app manually.",
				"reason_bad-handoff": "The restart handoff was incomplete, so it aborted. Retry once; if it persists, reopen manually.",
				"reason_helper-died": "The helper process exited mid-way, so the restart did not finish. Try again.",
				"reason_helper-exited": "The helper exited without confirming the new instance. Check whether the window came back.",
				"reason_helper-spawn-failed": "Could not start the helper process, so nothing was done. Reopen manually.",
				"reason_host-kill-failed": "The old instance could not be closed, so the restart aborted. Retry or reopen manually.",
				"reason_identity-changed": "The target process identity changed mid-operation; aborted for safety. Try again.",
				"reason_identity-unproven": "Could not prove the target is this instance, so nothing was done. Try again.",
				"reason_port-foreign": "The port is held by another instance with unclear ownership; aborted. Check for other instances.",
				"reason_port-held": "The old port was never released, so the restart aborted. Try again.",
				"reason_ready-port-missing": "The new instance started but no listening port was found. Check the window manually.",
				"reason_ready-unverifiable": "Could not verify the new instance became ready. Check the window manually.",
				"reason_record-missing": "The operation record is missing, so progress is unknown. Check the window; reopen if needed.",
				"reason_relaunch-failed": "The new instance failed to launch. Reopen the app manually.",
				"reason_state-write-failed": "Could not persist the operation state, so nothing was done. Try again.",
				"reason_stop-failed": "The old instance did not close cleanly, so the restart aborted. Retry or reopen manually.",
				"reason_timeout": "It took too long and the outcome is uncertain. Check the window; retry if needed.",
				waitingSuffix: "; scheduled to restart automatically once they finish.",
				guardTurns: "{n} agents generating or running tools",
				guardQueued: "{n} sessions with queued messages",
				guardJobs: "{n} background jobs running",
				guardTasksLine: "Work in progress ({parts})",
				guardInstalling: "A plugin install/update is running",
				guardAsk: ". Restarting now would interrupt them (files being written may stop halfway).",
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
				ariaUnknown: "Unknown result",
				ariaCountdown: "Countdown",
				ariaPaused: "Paused",
				ariaWaiting: "Waiting",
				statusReady: "Ready",
				statusBusy: "Work running",
				statusWaiting: "Waiting",
				statusError: "Failed",
				statusDesktopOnly: "Desktop only",
				statusUnavailable: "Could not read desktop app status. Try again.",
				statusUnknown: "Unknown",
				retryStatus: "Retry status",
				refreshStatus: "Refresh status",
				restartReceipt: "Host recovered at {time} (handoff {sec}s)",
				opScheduled: "Scheduled; waiting for the helper to verify…",
				opVerify: "Verifying the target process…",
				opStop: "Closing the previous instance…",
				opPortWait: "Waiting for the port to be released…",
				opLaunch: "Starting the new instance…",
				opReady: "Waiting for the interface to come up…",
				opOk: "Host and restart client reconnected. Check the UI for other plugins and tasks.",
				opFailed: "The restart did not succeed: {reason}",
				opUnknown: "The restart result is unknown: {reason}. Check whether the window is back, then retry if needed.",
				opReason: "see diagnostics",
				setTitle: "Restart Desktop App",
				setDesc: "Choose which entries are shown — changes apply immediately and are stored on this computer. The /restart-desktop command and the master switch live in the plugin config (config.command / config.enabled).",
				localSaveFailed: "Could not save; the previous setting was kept: ",
				noticeTitle: "Restart diagnostics",
				noticeRead: "Mark as read",
				noticeHistory: "Read diagnostics",
				noticeDetails: "Show redacted details",
				noticeDelivery: "System notification visibility is unconfirmed; this reminder remains until marked read.",
				noticeError: "Could not read diagnostics or save read status. Please retry.",
				requestDeadline: "Auto-cancel by {at} (30-minute total deadline)",
				requestCountdown: "Countdown: restart in {sec}s",
				requestPaused: "Countdown paused. Waiting for your choice.",
				labelCountdown: "{sec}s",
				labelPaused: "Paused",
				labelWaiting: "Waiting",
				labelLocked: "Locked",
				continueWaiting: "Continue waiting",
				cancelRequest: "Cancel request",
				confirmNow: "Confirm restart now",
				confirmNowHint: "Restart now skips waiting and countdown and may interrupt work. Install and identity guards still apply.",
				hostTooOld: "Host version is too old; please restart the application.",
				countdownSetting: "Countdown after idle (0–60 seconds)",
				saveCountdown: "Save countdown",
				entryPanelTitle: "Sidebar panel entry",
				entryPanelHint: "Shows at the top of the sidebar list; clicking it opens the restart panel in the main area",
				entryFooterTitle: "Sidebar footer entry",
				entryFooterHint: "Shows at the bottom of the sidebar (above Settings); click twice to restart",
				entryHeaderTitle: "Conversation header button",
				entryHeaderHint: "Shows on the right side of the conversation header, always within reach",
				entryRowTitle: "Settings page entry",
				entryRowHint: "Adds one row under Settings → General",
				headerCancelled: "Cancelled",
				headerNoWait: "no pending wait",
				headerResult: "Result",
				extrasSubtitle: "Bundled extras",
				sweepLabel: "Leftover snapshot scan preview",
				sweepAutoLabel: "Scan leftover snapshots on start (preview only)",
				sweepCancel: "Cancel scan",
				sweepRunLabel: "Scan preview now",
				sweepRunning: "Scanning…",
				sweepRunningLine: "Scanning leftover snapshots…",
				sweepAria: "Scan leftover snapshot preview now",
				sweepReading: "Reading current settings…",
				sweepOn: "On: scan and preview candidates on every start; nothing is deleted.",
				sweepOff: "Off: no automatic scan on start.",
				sweepLastPrefix: "Last scan",
				sweepJustNow: "Scanned just now",
				sweepJustNowDone: "Scan completed.",
				sweepErrorHead: " failed: ",
				sweepDoneNone: ": scanned {scanned} items; no items removed",
				sweepPreview: ": scanned {scanned} items; {count} candidates (estimated {mb} MB); preview only, nothing deleted",
				sweepSkippedOwner: "Not removed: candidate ownership could not be verified.",
				sweepSkippedActive: "Not removed: the host still has active sessions.",
				sweepSkippedOther: "Not removed: this version only previews candidates.",
				sweepRecovery: "Operation failed: {error}",
				sweepRetryRead: "Retry read",
				sweepRetryWrite: "Retry last operation",
				sweepNotOk: "Did not succeed: ",
				sweepErrorShort: "Could not read the temp directory ({code}); this scan did not complete.",
				sweepPartialShort: "Scan incomplete (cancelled or over budget); the figures below cover only what was scanned.",
				sweepPrefiltered: " {n} items were prefiltered.",
				sweepPartialSummary: "Scanned {scanned}; found {count} candidates (estimated {mb} MB); preview only, nothing deleted.",
				sweepUnknown: "unknown error",
				sweepDetailA: "DSH change snapshots are stored under system Temp and may remain after abnormal exits.",
				sweepDetailB: "This version only scans and previews candidates; it deletes nothing, and candidate size is not reclaimed space.",
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

		// ── §4 纯文案 / 判定 helper ──────────────────────────────────────────
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
			if (tasks?.known === false) lines.push(t("guardUnknown"));
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
		 * warn 态的确认行文案（2026-10-29）：「再点一次确认强制重启（N 秒内有效）」。
		 * N = ceil((warnAt + warnExpireMs - nowMs()) / 1000) —— nowMs 与测试假时钟
		 * （window.__dshdrNow）兼容，可快进；warnAt/warnExpireMs 由共享 store 的
		 * snapshot 暴露。渲染层每秒重算（显示时钟驱动），秒数随时间递减。
		 * @param {object} action - 动作状态。
		 * @returns {string} 文案；非 warn 态为空串。
		 */
		function warnConfirmLineOf(action) {
			if (action.phase !== "warn" || !(action.warnAt > 0)) return "";
			const window_ = Number(action.warnExpireMs) > 0 ? Number(action.warnExpireMs) : 15000;
			const left = Math.ceil((action.warnAt + window_ - nowMs()) / 1000);
			// 守卫说明（armWarnState 存进 message 的那句）+ 确认行一起渲染：
			// warn 态下 guardWarn 段落已禁用（同一件事只出现一次），这里是
			// 守卫句的唯一出口 —— 直达 warn 时 message=guardHint+forceTwoClickSuffix，
			// 409 路径 message=宿主 result.text，两者都含守卫信息。
			const guard = action.message !== "" ? action.message + " " : "";
			return guard + t("warnConfirmLine", { sec: String(Math.max(0, left)) });
		}

		/**
		 * 倒计时剩余整秒（向上取整，至少 0）：与 {@link waitingLine} 同一取数规则 ——
		 * countdownUntil 优先，读不出再退 countdownRemainingMs。
		 * 2026-10-26 缺陷 2：入口的按钮文字 / aria-label 都用它拼「Ns」。
		 * @param {object} action - 动作状态。
		 * @returns {number} 剩余秒数；不在倒计时态时为 NaN。
		 */
		function requestCountdownSeconds(action) {
			if (action.request?.state !== "countdown") return Number.NaN;
			const until = Date.parse(action.request.countdownUntil);
			const remaining = Number.isFinite(until) ? until - nowMs() : Number(action.request.countdownRemainingMs);
			return Number.isFinite(remaining) ? Math.ceil(Math.max(0, remaining) / 1000) : Number.NaN;
		}

		/**
		 * 按钮上的字。
		 * 2026-10-26 缺陷 2：countdown / paused / waiting 三态必须出现在按钮
		 * 文字里 —— 标题栏与侧栏不渲染主面板的等待行，用户点击的那个入口
		 * 自己就得能看出「正在倒计时（还剩几秒）/ 已暂停 / 等待中」。
		 * @param {{ phase: string, armed: boolean, request?: object, waiting?: boolean }} action - 动作状态。
		 * @returns {string} 文案。
		 */
		function labelOf(action) {
			// 2026-10-28 等待态主按钮锁定：主按钮文字必须是禁用语义（已锁定），
			// 不能再显示状态词 —— 「等待中」看起来像个可点的状态标签，用户点了
			// 却毫无反应（缺陷反馈原文）。状态词仍由 headerStateOf（标题栏可见
			// 状态文字）与 statusOf（面板右上角）承担，二者不受影响。
			if (action.request?.state === "countdown") return t("labelLocked");
			if (action.request?.state === "paused") return t("labelLocked");
			if (action.waiting === true) return t("labelLocked");
			if (action.request?.state === "executing") return t("restarting");
			if (action.op?.result === "unknown") return t("ariaUnknown");
			if (action.op?.result === "failed") return t("retry");
			if (action.op?.result === "ok") return t("restart");
			if (action.phase === "restarting") return t("restarting");
			if (action.phase === "done") return t("scheduled");
			if (action.phase === "warn") return action.armed ? t("stillRestart") : t("wait");
			if (action.phase === "confirm") return t("confirmRestart");
			if (action.phase === "error") return t("retry");
			return t("restart");
		}

		/**
		 * 标题栏的可见状态短词（2026-10-27 缺陷 1）。
		 *
		 * 与 {@link labelOf} 的分工：labelOf 喂按钮内部那个 .dshdr-label（在窄
		 * 容器下不可见、且 idle 时是「重启」这种常态词）；本函数喂**独立于容器
		 * 查询**的 .dshdr-header-state —— idle 一律 null（不渲染节点、不占
		 * 宽度），非 idle 给出肉眼可辨的短词：
		 *   confirm →「确认重启？」；countdown →「5s」；waiting →「等待中」；
		 *   paused →「已暂停」；executing →「重启中…」；warn/done/error →
		 *   复用既有按钮词（仍要可见）。倒计时秒数与 labelOf 同一取数规则。
		 * @param {object} action - 动作状态。
		 * @returns {string | null} 状态短词；idle 时为 null。
		 */
		function headerStateOf(action) {
			// A direct action result (including cancelled:false) is immediate feedback.
			// Warning messages contain long guard details, so their short action wins.
			if (action.message !== "" && action.phase !== "warn") return action.message;
			if (action.request?.state === "countdown") {
				const sec = requestCountdownSeconds(action);
				return Number.isFinite(sec) ? t("labelCountdown", {sec:String(sec)}) : t("labelWaiting");
			}
			if (action.request?.state === "paused") return t("labelPaused");
			if (action.request?.state === "executing") return t("restarting");
			if (action.waiting === true) return t("labelWaiting");
			if (action.phase === "warn") return action.armed ? t("stillRestart") : t("wait");
			// 刚发生的操作结果优先（如「当前没有等待中的请求」「已取消等待」）：
			// 这是用户在标题栏点完取消后唯一的即时反馈；超长由 CSS 的
			// max-width+ellipsis 收口，完整句子仍在主面板。等待/倒计时一旦由
			// 轮询确认（restartRequest 到位），applyStatus 会清掉 message，
			// 不会长期盖住「等待中 / 5s」这类常态词。
			if (action.phase === "confirm") return t("confirmRestart");
			if (action.phase === "done") return t("scheduled");
			if (action.phase === "restarting") return t("restarting");
			if (action.phase === "error") return t("retry");
			return null;
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
			// 2026-10-26 缺陷 2：倒计时的剩余秒数进 aria-label（短词「倒计时 5s」，
			// 与按钮文字同形）；动态详情仍走 aria-describedby。
			if (action.request?.state === "countdown") {
				const sec = requestCountdownSeconds(action);
				return Number.isFinite(sec)
					? t("ariaCountdown") + " " + t("labelCountdown", { sec: String(sec) })
					: t("ariaCountdown");
			}
			if (action.request?.state === "paused") return t("ariaPaused");
			if (action.waiting === true) return t("ariaWaiting");
			if (action.op?.result === "unknown") return t("ariaUnknown");
			if (action.op?.result === "failed") return t("ariaError");
			if (action.op?.result === "ok") return t("ariaIdle");
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
			if (action.statusError !== "") return action.statusError;
			// 2026-10-26 缺陷 2：countdown / paused 时守卫多半安静（guardHint 为空），
			// 此前直接返回空串 —— 读屏在倒计时期间没有任何提示。现在复用
			// waitingLine(action)：它自带倒计时秒数、最晚取消时刻与暂停说明。
			if (action.request?.state === "countdown" || action.request?.state === "paused") {
				const line = waitingLine(action);
				if (line !== "") return line;
			}
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
		/**
		 * 等待中那句「已等 N 秒」。
		 * 批 2：之前只显示「在等待当前的任务结束」，用户无法判断是卡住还是在正常等。
		 * @param {{ waiting: boolean, waitingSince?: string | null, waitingMaxMs?: number | null }} action - 动作状态。
		 * @returns {string} 文案；不处于等待时为空串。
		 */
		function requestDeadlineLine(action) {
			const at = Date.parse(action.request?.deadlineAt ?? "");
			return Number.isFinite(at) ? " · " + t("requestDeadline", {at:new Date(at).toTimeString().slice(0,5)}) : "";
		}

		function PhaseAnnouncement(action) {
			const stage = action.request?.state;
			const text = stage === "countdown" ? t("announceCountdown")
				: stage === "paused" ? t("labelPaused")
				: action.phase === "warn" ? t("stillRestart")
				: statusOf(action);
			return React.createElement("span", {className:"dshdr-sr-only", "data-phase-announcement":"1", "aria-live":"polite", "aria-atomic":"true"}, text);
		}

		function localDateTimeOf(iso, includeDate = true) {
			if (typeof iso !== "string" || iso === "") return "";
			const at = new Date(iso);
			if (Number.isNaN(at.getTime())) return "";
			const two = value => String(value).padStart(2, "0");
			const time = [at.getHours(), at.getMinutes(), at.getSeconds()].map(two).join(":");
			return includeDate ? String(at.getFullYear()).padStart(4,"0") + "-" + two(at.getMonth()+1) + "-" + two(at.getDate()) + " " + time : time;
		}

		function waitingLine(action) {
			if (action.request?.state === "countdown") return t("requestCountdown", { sec: String(Math.ceil(Math.max(0, Number.isFinite(Date.parse(action.request.countdownUntil)) ? Date.parse(action.request.countdownUntil) - nowMs() : action.request.countdownRemainingMs) / 1000)) }) + requestDeadlineLine(action);
			if (action.request?.state === "paused") return t("requestPaused") + requestDeadlineLine(action);
			if (action.waiting !== true) return "";
			const since = typeof action.waitingSince === "string" ? Date.parse(action.waitingSince) : Number.NaN;
			const maxMs = Number.isFinite(action.waitingMaxMs) ? action.waitingMaxMs : 30 * 60 * 1000;
			const elapsed = Number.isFinite(since) ? Math.max(0, Math.floor((nowMs() - since) / 1000)) : null;
			const at = Number.isFinite(since) ? new Date(since).toTimeString().slice(0, 8) : "--:--:--";
			return t("waitingLine", { at, elapsed: elapsed === null ? "?" : String(elapsed), max: String(Math.round(maxMs / 60000)) }) + requestDeadlineLine(action);
		}

		/**
		 * 「上次同类重启停机约 N 秒」——给等待/进行中的用户一个心理预期。
		 * @param {{ restart?: { downtimeMs?: number } | null }} action - 动作状态。
		 * @returns {string} 文案；没有历史回执时为空串。
		 */
		function expectedRestartLine(action) {
			const ms = action.restart !== null && typeof action.restart === "object" ? Number(action.restart.downtimeMs) : Number.NaN;
			if (!Number.isFinite(ms) || ms <= 0) return "";
			return t("expectedRestart", { sec: String(Math.max(1, Math.round(ms / 1000))) });
		}

		function statusOf(action) {
			if (action.desktop === false) return t("statusDesktopOnly");
			if (action.statusError !== "") return t("statusUnavailable");
			if (action.request?.state === "executing") return t("restarting");
			if (action.request?.state === "countdown" || action.request?.state === "paused") return waitingLine(action);
			if (action.op?.result === "unknown") return t("statusUnknown");
			if (action.op?.result === "failed") return t("statusError");
			if (action.op?.result === "ok") return t("statusReady");
			if (action.phase === "restarting") return t("restarting");
			if (action.phase === "done") return t("scheduled");
			if (action.phase === "error") return t("statusError");
			if (action.waiting === true) return t("statusWaiting");
			if (action.guardHint !== "") return t("statusBusy");
			return t("statusReady");
		}

		/**
		 * 把宿主的操作状态翻成一句当前语言的话（第 1 项）。
		 * @param {object | null} op - 宿主给的操作摘要。
		 * @returns {string} 文案；没有操作时为 ""。
		 */
		/**
		 * 原因码 → 人话（批 3）。查不到词条时退回原始码，绝不吞掉信息。
		 * @param {unknown} code - 服务端给的原因码。
		 * @returns {string} 可读说明。
		 */
		function reasonTextOf(code) {
			if (typeof code !== "string" || code === "") return t("opReason");
			const key = "reason_" + code;
			const text = t(key);
			// 人话在前、原码在后：便于用户看懂，也便于排查时对码。
			return text === key ? code : `${text}（${code}）`;
		}

		function opTextOf(op) {
			if (op === null || typeof op !== "object") return "";
			const phaseKey = { scheduled: "opScheduled", verify: "opVerify", stop: "opStop", "port-wait": "opPortWait", launch: "opLaunch", ready: "opReady" };
			if (op.result === "ok") return t("opOk");
			if (op.result === "failed") return t("opFailed", { reason: reasonTextOf(op.reason) });
			if (op.result === "unknown") return t("opUnknown", { reason: reasonTextOf(op.reason) });
			return t(phaseKey[op.phase] ?? "opScheduled");
		}

		/**
		 * 重启完成回执的一句话（2026-10-21）。
		 * @param {{ at?: string, downtimeMs?: number }} restart - 宿主给的回执。
		 * @returns {string} 「已于 HH:MM:SS 完成重启（停机 N 秒）」。
		 */
		function restartReceiptText(restart) {
			const at = new Date(String(restart?.hostReadyAt ?? restart?.at ?? ""));
			const time = Number.isNaN(at.getTime())
				? "—"
				: [at.getHours(), at.getMinutes(), at.getSeconds()]
					.map((n) => String(n).padStart(2, "0"))
					.join(":");
			const sec = Math.max(0, Math.round((Number(restart?.downtimeMs) || 0) / 1000));
			return t("restartReceipt", { time, sec });
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

		// ── §5 本机存储（入口开关 / 隐藏反馈） ───────────────────────────────
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
				return { ok: true };
			} catch (error) {
				return { ok: false, error: String(error?.message ?? error) };
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
		 * 默认不藏；只有用户保存开启后才隐藏。关掉开关的瞬间，被藏起来的
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
				return raw === "1";
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
				return { ok: true };
			} catch (error) {
				return { ok: false, error: String(error?.message ?? error) };
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
				// Portal surfaces are body children; only open menus need subtree work.
				hiderObserver.disconnect();
				hiderObserver.observe(document.body, { childList: true });
				for (const menu of document.querySelectorAll('[role="menu"]')) hiderObserver.observe(menu, {childList:true,subtree:true});
			});
			hiderObserver.observe(document.body, { childList: true });
			for (const menu of document.querySelectorAll('[role="menu"]')) hiderObserver.observe(menu, {childList:true,subtree:true});
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
			const result = writeHideContact(value);
			if (!result.ok) return result;
			hideContactOn = value === true;
			if (hideContactOn) startHider();
			else stopHider();
			return result;
		}

		// ── §6 样式注入（CSS 兜底） ──────────────────────────────────────────
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
			"@media (prefers-reduced-motion:reduce){.dshdr-trigger[data-busy=1] svg,.dshdr-foot-badge[data-busy=1] svg,.dshdr-btn[data-busy=1] svg,.dshdr-spin{animation:none}}",			"@container (width<=540px){.dshdr-label{display:none}.dshdr-trigger--label{padding:0 6px;height:26px;border-radius:8px;gap:4px;width:auto}.dshdr-trigger--label .dshdr-label{display:inline;font-size:12px;line-height:18px;white-space:nowrap}}",
			// ── 标题栏状态文字与就地取消（2026-10-27 缺陷 1/2；2026-10-28 修重复）──
			// State is inside the header main button: visible at every width, bounded and truncated.
			".dshdr-header-state{display:inline;font-size:12px;line-height:18px;white-space:nowrap;color:inherit;max-width:72px;overflow:hidden;text-overflow:ellipsis}",
			".dshdr-trigger[data-header-main]{flex-shrink:0;gap:6px;padding:3px 7px}.dshdr-trigger[data-header-main] svg{flex-shrink:0}",
			".dshdr-header-name{display:inline;white-space:nowrap}",
			".dshdr-set-page>.dshdr-set-heading{display:grid;grid-template-columns:minmax(0,1fr) max-content;align-items:center;column-gap:12px}.dshdr-set-page>.dshdr-set-heading>.dshdr-set-title{width:auto;min-width:0}.dshdr-set-heading>[data-settings-restart]{grid-column:2;grid-row:1;justify-self:end;width:auto}",
			".dshdr-trigger[data-header-main][data-phase=confirm],.dshdr-trigger[data-header-main][data-phase=warn]{color:var(--dsw-alias-state-error-primary,#ec1313)}",
			".dshdr-trigger[data-header-main][data-request-state=waiting],.dshdr-trigger[data-header-main][data-request-state=countdown],.dshdr-trigger[data-header-main][data-request-state=paused]{color:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dshdr-header-state[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dshdr-header-state[data-tone=error]{color:var(--dsw-alias-state-error-primary,#f85149)}",
			".dshdr-header-state[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#3fb950)}",
			// Narrow containers keep the tighter state-text width limit.
			"@container (width<=540px){.dshdr-header-state{display:inline;max-width:48px}}",
			// 标题栏就地取消：复用 .dshdr-trigger 的形状，但保持纯图标尺寸，
			// aria-label 承担可读性（不占宽度）。
			".dshdr-trigger.dshdr-trigger--cancel{padding:3px 4px}",
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
			// ── 危险操作警示色（2026-10-28，DSH 官方范式）────────────────────
			// 照抄 app.asar 插件卸载确认框的 dangerButton：保留 variant=primary 的
			// 全部尺寸/圆角/内边距，只覆盖两个 CSS 变量让底色变 DSH 标准危险红。
			// 变量随深浅主题自动切换，不硬编码十六进制。
			".dshdr-danger{--dsw-alias-button-primary-fill:var(--dsw-alias-state-error-primary,#ec1313);--dsw-alias-button-primary-hover:var(--dsw-alias-state-error-primary,#ec1313)}",
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
			".dshdr-set-heading{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin-bottom:4px}.dshdr-set-heading .dshdr-set-title{margin:0}.dshdr-set-heading .dshdr-btn{min-height:28px;padding:3px 9px;font-size:12px}.dshdr-health-fold{border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));padding:12px 0}.dshdr-health-fold>summary{cursor:pointer;font-size:14px;line-height:22px}.dshdr-health-summary{color:var(--dsw-alias-label-secondary,inherit);font-size:12px;margin-left:8px}.dshdr-health-fold .dshdr-health{padding:12px 0;border:0}.dshdr-health-fold .dshdr-set-text{gap:6px}.dshdr-health-fold .dshdr-set-subtitle{margin:0}",
			".dshdr-set-desc{color:var(--dsw-alias-label-secondary,inherit);margin:0;font-size:14px;line-height:22px}",
			".dshdr-set-row{display:flex;align-items:center;gap:12px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}",
			".dshdr-set-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}",
			".dshdr-set-label{color:var(--dsw-alias-label-primary,inherit);font-size:14px;font-weight:400;line-height:22px}",
			".dshdr-set-hint{color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;line-height:18px}",
			".dshdr-set-hint[data-tone=error]{color:var(--dsw-alias-state-error-primary,#f85149)}",
			".dshdr-set-subtitle{color:var(--dsw-alias-label-primary,inherit);margin:24px 0 0;font-size:14px;font-weight:500;line-height:22px}",
			".dshdr-set-actions{display:flex;align-items:center;gap:8px;flex:none}",
			".dshdr-set-row>label{display:flex;align-items:center;flex-wrap:wrap;gap:10px;flex:1;font-size:14px;line-height:22px}",
			".dshdr-number{box-sizing:border-box;width:76px;min-height:32px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit}",
			".dshdr-number:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#4d6bfe);outline-offset:2px}",
			".dshdr-health .dshdr-set-text{padding-right:0;gap:10px}.dshdr-health p{margin:0;font-size:13px;line-height:20px}.dshdr-health label{display:flex;align-items:center;gap:8px;font-size:14px;line-height:22px}.dshdr-health progress{width:100%;height:8px;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
			".dshdr-panel-facts{display:flex;flex-wrap:wrap;gap:12px 32px;margin:0}.dshdr-panel-facts div{display:grid;gap:4px}.dshdr-panel-facts dt{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}.dshdr-panel-facts dd{margin:0;font-size:13px}",
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

		// ── §7 宿主路由访问（status / restart） ──────────────────────────────
		/** Bound both transport and JSON-body reading; a timeout is not proof of rejection. */
		async function fetchJSON(url, options) {
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			let timeout;
			try {
				return await Promise.race([
					(async () => {
						const response = await fetch(url, Object.assign({}, options, controller ? {signal:controller.signal} : {}));
						const body = await response.json();
						return {response, body};
					})(),
					new Promise((_, reject) => { timeout = window.setTimeout(() => {
						controller?.abort();
						reject(new Error(t("requestTimedOut")));
					}, REQUEST_TIMEOUT_MS); }),
				]);
			} finally { window.clearTimeout(timeout); }
		}

		async function savePreference(query) {
			try {
				const {response, body} = await fetchJSON(PREFS_ROUTE + "?" + query, {method:"POST",credentials:"same-origin"});
				if (!response.ok || !body?.ok) throw new Error(body?.error || t("statusUnavailable"));
				return body;
			} catch (cause) {
				// A lost response cannot prove the write failed. Read back before showing a value.
				const status = await fetchStatus();
				return {reconciled:true,status,error:t("settingSaveUncertain") + String(cause?.message ?? cause)};
			}
		}

		const recoveryAcks = new Set();
		let recoveryAckError = "";
		function acknowledgeRecovery(id) {
			if (typeof id !== "string") { recoveryAckError = ""; return; }
			if (recoveryAcks.has(id)) return;
			recoveryAcks.add(id);
			// Acknowledge only after a renderer frame, not merely after finding a socket.
			window.requestAnimationFrame(() => {
				fetchJSON(PREFS_ROUTE + "?clientReady=" + encodeURIComponent(id), {method:"POST"})
					.then(({response,body}) => {
						if (!response.ok || body?.ok !== true) throw new Error("client-recovery-not-saved");
						recoveryAckError = "";
					}).catch(() => {
						recoveryAcks.delete(id);
						recoveryAckError = t("recoveryAckFailed");
					});
			});
		}
		/**
		 * 问一次宿主：这是不是 Electron 桌面版、现在有多少活在跑、有没有挂起的等待。
		 *
		 * `blocked` 表示宿主的**硬拦**已经生效（插件正在安装/更新，且记录里的
		 * 进程还活着）—— 那种情况下不能再说「仍可重启」。`waiting` 表示宿主
		 * 已挂起「等空闲再重启」，界面据此把等待按钮变成「取消等待」。
		 * @returns {Promise<{ statusAvailable: boolean, statusError: string, desktop: boolean | null, guardHint: string, blocked: boolean, waiting: boolean }>} 状态。
		 */
		async function fetchStatus() {
			try {
				const {response, body} = await fetchJSON(STATUS_ROUTE, { method: "GET" });
				if (response.ok && body !== null && typeof body === "object" && typeof body.desktop === "boolean") {
					acknowledgeRecovery(body.recoveryId);
					return {
						serverNow: body.serverNow,
						menuTraceEnabled: body.menuTraceEnabled === true,
						requestExpiry: body.requestExpiry === true,
						countdownSeconds: body.countdownSeconds,
						statusAvailable: true,
						statusError: recoveryAckError,
						desktop: body.desktop === true,
						guardHint: guardHintOf(body),
						tasksKnown: typeof body.guard?.tasks?.known === "boolean" ? body.guard.tasks.known : null,
						blocked: body.guard !== null && typeof body.guard === "object" && body.guard.blocked === true,
						waiting: body.waiting !== null && typeof body.waiting === "object",
				// 批 2：等待时长要能显示，所以保留 since / maxMs（之前只压成布尔，时间信息丢了）
				waitingSince: body.waiting !== null && typeof body.waiting === "object" && typeof body.waiting.since === "string" ? body.waiting.since : null,
				waitingMaxMs: body.waiting !== null && typeof body.waiting === "object" && typeof body.waiting.maxMs === "number" ? body.waiting.maxMs : null,
						// 本次启动是不是由一次重启而来（有就给回执，界面显示一句「已于…重启」）
						lastRestart: body.lastRestart !== null && typeof body.lastRestart === "object"
							? {
								at: String(body.lastRestart.at ?? ""),
								hostReadyAt: String(body.lastRestart.hostReadyAt ?? body.lastRestart.at ?? ""),
								downtimeMs: Number(body.lastRestart.downtimeMs) || 0,
							}
							: null,
						// 重启操作阶段（宿主 restartState()；busy=正在执行）；续跑模式已整体移除
						// F1 返修：之前这里漏了 restartOp，导致界面永远看不到排程后的进展。
						restartOp: body.restartOp !== null && typeof body.restartOp === "object" ? body.restartOp : null,
						restartBusy: typeof body.restartBusy === "boolean"
							? body.restartBusy
							: (body.restartOp !== null && typeof body.restartOp === "object" && typeof body.restartOp.busy === "boolean"
								? body.restartOp.busy
								: undefined),
						notifications: body.notifications ?? { items: [], error: null },
						restartRequest: body.restartRequest ?? null,
						// 2026-10-29：警告态有效秒数（老宿主无此字段 → undefined，
						// 客户端退默认 15 并禁用保存）。
						warnExpireSeconds: body.warnExpireSeconds,
						authCookie: body.authCookie,
						// 每个入口的默认开关（config 里配的）
						entries: body.entries !== null && typeof body.entries === "object" ? body.entries : undefined,
						// 孤儿快照清理的开关与上次结果（宿主半给的）
						sweep: body.sweep !== null && typeof body.sweep === "object" ? body.sweep : undefined,
					};
				}
				const detail = body !== null && typeof body === "object" && typeof body.error === "string"
					? body.error
					: "HTTP " + String(response.status);
				return {
					statusAvailable: false,
					statusError: t("statusUnavailable") + " " + detail,
					desktop: null,
					guardHint: "",
					blocked: false,
					waiting: false,
				waitingSince: null,
				waitingMaxMs: null,
					lastRestart: null,
					restartOp: undefined,
					restartBusy: true,
					entries: undefined,
					sweep: undefined,
				};
			} catch (error) {
				return {
					statusAvailable: false,
					statusError: t("statusUnavailable") + " " + String((error && error.message) || error),
					desktop: null,
					guardHint: "",
					blocked: false,
					waiting: false,
					lastRestart: null,
					restartOp: undefined,
					restartBusy: true,
					entries: undefined,
					sweep: undefined,
				};
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
			if (options.choice) params.push("choice=" + encodeURIComponent(options.choice));
			if (options.ask) params.push("ask=" + encodeURIComponent(options.ask));
			// 默认等空闲（服务端默认）；只有用户在风险确认里选择「仍要立即重启」
			// 时才显式带 now=1 跳过等待。2026-10-26 缺陷 1 修复：force 与 now
			// 是两个独立标志 —— 立即执行要求两者同时出现；只带 force 的请求
			// （warn 态二击）在宿主侧被当作普通等待请求处理。
			if (options.force === true) params.push("force=1");
			if (options.now === true) params.push("now=1");
			if (options.wait === true) params.push("wait=1");
			if (options.cancelWait === true) params.push("cancelWait=1");
			const expiresAt = nowMs() + REQUEST_TIMEOUT_MS;
			params.push("expiresAt=" + String(expiresAt));
			const query = params.length > 0 ? "?" + params.join("&") : "";
			let response;
			let body;
			try {
				({response, body} = await fetchJSON(RESTART_ROUTE + query, { method: "POST" }));
			} catch (error) {
				return { ok: false, uncertain: true, expiresAt, text: t("submissionUnknown") };
			}
			if (response.ok && (!body || typeof body.ok !== "boolean")) return {ok:false,uncertain:true,expiresAt,text:t("submissionUnknown")};
			if (response.ok && body && body.ok === true) {
				if (body.waiting === true) return { ok: true, waiting: true, since: body.since, request: body.restartRequest, text: t("waitingScheduled") };
				if (body.cancelled !== undefined) {
					// F2：宿主如实返回 cancelled:false 时不能显示“已取消”
					const really = body.cancelled === true;
					return { ok: true, cancelled: really, request: body.restartRequest, text: really ? t("waitingCancelled") : t("nothingToCancel") };
				}
				return {
					ok: true,
					text: t("scheduledRestart"),
				};
			}
			if (body && body.blocked === true) {
				// 插件正在安装/更新：宿主半**硬拦**，带 force 也过不去。所以这里
				// 绝不能弹「确认继续」—— 那只会让人勾一遍再撞一次墙，直接说清楚。
				const structured = guardHintOf(body);
				return {
					ok: false,
					blocked: true,
					text: structured !== "" ? structured + t("blockedSuffix") : hostMessage(body.error, "blockedFallback"),
				};
			}
			if (body && body.guard && body.guard.active === true) {
				const structured = guardHintOf(body);
				return {
					ok: false,
					guard: true,
					text: structured !== "" ? structured + t("guardAsk") : hostMessage(body.error, "guardFallback"),
				};
			}
			return { ok: false, text: String((body && body.error) || ("HTTP " + response.status)) };
		}

		// ── §8 共享状态 store（单一状态源） ──────────────────────────────────
		/**
		 * 共享重启状态的初始快照。
		 *
		 * 字段与原来 `useRestart` 里那 17 个 `useState` 一一对应（`pollFailures`
		 * 是内部计数，不外露）。四个入口看到的就是这一份。
		 */
		const RESTART_INITIAL_STATE = {
			phase: "idle",
			message: "",
			desktop: null,
			statusError: "",
			statusPending: false,
			guardHint: "",
			blocked: false,
			waiting: false,
			request: null,
            displayTick: 0,
			notifications: { items: [], error: null },
			noticeReadError: "",
			pauseOwner: null,
			forceOwner: null,
			restart: null,
			op: null,
			opBusy: false,
			opError: "",
			armed: false,
			warnAt: 0,
			modalOpen: false,
			modalOwner: null,
			acknowledged: false,
			guardText: "",
			pollFailures: 0,
				confirmAt: 0,
			submissionUncertain: false,
			submissionExpiresAt: 0,
		};

		/**
		 * 重启状态的 store：**一份快照 + 一个订阅者集合 + 一条轮询**（2026-10-22）。
		 *
		 * 之前是每个入口各自 `useRestart(timer)`：标题栏、设置行、侧栏底部、主面板
		 * 四个实例各存一份状态、各发一次 `/api/status`、pending 时各起一条 2 秒轮询
		 * —— 最多 4 路重复请求，而且四个入口的状态会短暂分叉。现在状态只有一份，
		 * 轮询只有一条；hook 只负责订阅（见 {@link useRestart}）。
		 *
		 * 生命周期用引用计数：第一个订阅者出现才做首次拉取并启动轮询，最后一个
		 * 退订就清掉定时器 —— 否则 `useEffect` 的清理会把定时器漏在模块里。
		 *
		 * 行为照搬原来每个实例里的那套逻辑：`phase` 状态机（idle / confirm /
		 * restarting / done / warn / error 六态）、两步确认、官方风险确认弹窗、
		 * pending 时 2 秒轮询、连续失败 3 次停、失败仍保留可读错误。
		 *
		 * 弹窗是唯一按入口区分的东西：宿主回 409「有任务在跑」时只有**发起那一次
		 * 请求的入口**弹确认框（`modalOwner`），否则标题栏与侧栏底部会同时弹出两个
		 * 一模一样的对话框 —— 那是可见的回归。
		 */
		function createRestartStore() {
			let state = Object.assign({}, RESTART_INITIAL_STATE);
			const listeners = new Set();
			const questionViews = new Set();
			let viewSeq = 0;
			/** 客户端 timer 服务（ctx 的 `timer`），只用于武装 / 冷却这类延时。 */
			let timerService;
			/** 有订阅者（已挂载的入口）时为 true；退订清零后置回 false。 */
			let started = false;
			let statusSeq = 0;
			let appliedSeq = 0;
			let lifecycle = 0;
			/** 唯一那条 2 秒轮询的句柄。 */
			let pollTimer = null;
			let displayTimer = null;

			const hasTimer = () => timerService !== undefined && typeof timerService.timeout === "function";

			/**
			 * 需要「过一会儿就放行」的冷却。没有 timer 服务时立刻放行 ——
			 * 把自己锁在不可点上是最糟的失败形态。
			 */
			function armLater(fn, ms) {
				if (hasTimer()) timerService.timeout(fn, ms);
				else fn();
			}

			/** 需要「过一会儿就撤销」的确认窗口。没有 timer 服务时干脆不撤销。 */
			function expireLater(fn, ms) {
				// 2026-10-22 真机回归：没有 timer 服务时原来什么都不做，
				// 于是「确认态」永远不撤销 —— 下一次单击会被当成第二次点击直接重启。
				// 修法不靠额外定时器（会干扰「轮询只有一条」的断言），
				// 而是给确认态加时间戳，由 press 自己判断是否过期。
				if (hasTimer()) timerService.timeout(fn, ms);
			}

			/**
			 * 警告态的过期秒数（2026-10-29）：宿主设置优先，老宿主退默认 15。
			 * fetchStatus 读 warnExpireSeconds，applyStatus 同步进 warnExpireMs。
			 */
			const warnExpireDefault = 15;
			let warnExpireMs = warnExpireDefault * 1000;

			/**
			 * 进入警告态（2026-10-29 过期机制）。
			 *
			 * 真机问题：此前 warn 态只有武装定时器（900ms 冷却）没有过期，
			 * 放几小时后误碰一击 = 直接强制重启。现在与 confirm 态同款双保险：
			 * - warnAt 时间戳：press 判定新鲜度（点击瞬间用 nowMs() —— 与测试
			 *   时钟 window.__dshdrNow 兼容，可假时钟快进）；
			 * - expireLater：到时自动回 idle（去红、恢复「重启」）。
			 * 时间轴：900ms 冷却武装 → WARN 有效窗口（warnExpireMs）→ 过期。
			 * @param {string} message - 警告文案（含守卫原因）。
			 */
			function armWarnState(guardText) {
				// 2026-10-29 文案修正：warn 态的 message 不再重复守卫整句
				// （那由面板黄色提示条承担 —— 同一件事只出现一次），只留
				// 「再点一次确认强制重启（N 秒内有效）」；N 在渲染层用
				// warnAt + warnExpireMs 实时计算（随显示时钟逐秒递减）。
				update({ phase: "warn", message: guardText, armed: false, confirmAt: 0, warnAt: nowMs() });
				const warningAt = state.warnAt;
				const generation = lifecycle;
				armLater(() => { if (generation === lifecycle && state.phase === "warn" && state.warnAt === warningAt) update({ armed: true }) }, WARN_ARM_MS);
				expireLater(() => {
					if (generation === lifecycle && state.phase === "warn" && state.warnAt === warningAt) update({ phase: "idle", armed: false, warnAt: 0, message: "" });
				}, warnExpireMs);
			}


			/** 任何一个订阅者抛错都不能影响其他入口。 */
			function emit() {
				for (const listener of Array.from(listeners)) {
					try {
						listener();
					} catch {
						/* 订阅者自己的问题，丢掉 */
					}
				}
			}

			/** 只有真的变了才换快照并通知；同值写入不惊动任何入口。 */
			function update(patch) {
				let changed = false;
				for (const key of Object.keys(patch)) {
					if (!Object.is(state[key], patch[key])) {
						changed = true;
						break;
					}
				}
				if (!changed) return;
				state = Object.assign({}, state, patch);
				syncDisplayClock();
				emit();
			}

			function clearPoll() {
				if (pollTimer === null) return;
				if (typeof window !== "undefined" && typeof window.clearTimeout === "function") window.clearTimeout(pollTimer);
				pollTimer = null;
			}

			/**
			 * 宿主仍在等待或操作 pending、且没连续失败三次时，
			 * 隔 2 秒问一次；其余时候一条定时器都不留。
			 */
			function syncDisplayClock() {
				const until = Date.parse(state.request?.countdownUntil);
				const countdown = state.request?.state === "countdown" && Number.isFinite(until) && until > nowMs() && state.pollFailures < 3;
				const warning = state.phase === "warn" && state.warnAt > 0 && nowMs() - state.warnAt < warnExpireMs;
				const wanted = started && (countdown || warning);
				if (!wanted) {
					if (displayTimer !== null) window.clearTimeout(displayTimer);
					displayTimer = null;
					return;
				}
				if (displayTimer !== null || typeof window?.setTimeout !== "function") return;
				displayTimer = window.setTimeout(() => {
					displayTimer = null;
					if (!started) return;
					update({displayTick:state.displayTick + 1});
					syncDisplayClock();
				}, 1000);
			}

			function syncPoll() {
				syncDisplayClock();
				const wanted = started
					&& (state.waiting === true || state.request?.state === "executing" || (state.submissionUncertain === true && state.requestExpiry === true) || (state.op !== null && state.op.result === "pending"))
					&& state.pollFailures < 3
					&& typeof window !== "undefined"
					&& typeof window.setTimeout === "function";
				if (!wanted) {
					clearPoll();
					return;
				}
				if (pollTimer !== null) return;
				pollTimer = window.setTimeout(() => {
					pollTimer = null;
					if (!started) return;
					const seq = ++statusSeq;
					const generation = lifecycle;
					fetchStatus().then((status) => {
						if (!started || generation !== lifecycle) return;
						if (seq < appliedSeq) return;
						appliedSeq = seq;
						if (status.statusAvailable === true) {
							applyStatus(status);
							return;
						}
						const error = status.statusError || t("statusUnavailable");
						update({ opError: error, statusError: error, pollFailures: state.pollFailures + 1 });
						syncPoll();
					});
				}, 2000);
			}

			/** 应用已确认的状态；失败留在未知态并保留可读错误。 */
			function applyStatus(status) {
				warnExpireMs = Number.isInteger(status.warnExpireSeconds) && status.warnExpireSeconds >= 5 && status.warnExpireSeconds <= 60
					? status.warnExpireSeconds * 1000 : warnExpireDefault * 1000;
				const available = status.statusAvailable === true;
				const request = available ? status.restartRequest ?? null : state.request;
				const preExecution = request !== null && ["waiting", "countdown", "paused"].includes(request.state);
				let { op, opBusy, pollFailures, message, phase } = state;
				let submissionUncertain = state.submissionUncertain;
				if (available) {
					if (state.waiting === true && status.waiting !== true) message = "";
					if (state.request?.state === "terminal" && request?.state === "idle") message = "";
					op = status.restartOp ?? null;
					opBusy = typeof status.restartBusy === "boolean"
						? status.restartBusy
						: (op !== null && (op.result === "pending"
							|| (op.result === "unknown" && op.helperAlive !== false)));
					pollFailures = 0;
					if (["ok", "failed", "unknown"].includes(op?.result)) message = "";
					if ((preExecution || request?.executed === false) && !opBusy) op = null;
					// 2026-10-29：warn 态的 message 是守卫句（warnConfirmLineOf 要用），
					// 不得被状态轮询清掉 —— 只清非 warn 的 preExecution 消息。
					if (preExecution && phase !== "error" && phase !== "warn") message = "";
					if (request?.state === "terminal" && request.executed === false) message = request.message || "";
					if (submissionUncertain) {
						// New hosts reject delayed submissions after their deadline. A GET
						// observed after it can safely reconcile even a lost POST response.
						const expiredAtHost = status.requestExpiry === true && status.serverNow >= state.submissionExpiresAt;
						if (preExecution || request?.state === "executing" || opBusy || expiredAtHost) {
							submissionUncertain = false;
							phase = "idle";
							if (!preExecution && !opBusy && request?.state !== "terminal") message = t("submissionReconciled");
						} else {
							op = {id:null,result:"unknown",phase:"unknown",reason:"submission-unknown",busy:true,needsManualCheck:true};
							opBusy = true;
							message = t("submissionUnknown");
						}
					}
				}
				// 原来是独立一条 effect：宿主确认终态且 busy=false 后清掉「排程中」。
				if (op !== null
					&& opBusy === false
					&& ["ok", "failed", "unknown"].includes(op.result)
					&& (phase === "done" || phase === "restarting")) phase = "idle";
				const patch = {
					submissionUncertain,
					requestExpiry: available ? status.requestExpiry : state.requestExpiry,
					countdownSeconds: available ? status.countdownSeconds : state.countdownSeconds,
					notifications: available ? status.notifications : state.notifications,
					authCookie: available ? status.authCookie : state.authCookie,
					request,
					pauseOwner: request?.state === "paused" ? (questionViews.has(state.pauseOwner) ? state.pauseOwner : questionViews.values().next().value ?? null) : null,
					forceOwner: preExecution || (request === null && state.waiting) ? state.forceOwner : null,
					desktop: available ? status.desktop : null,
					statusError: available ? status.statusError || "" : (status.statusError || t("statusUnavailable")),
					guardHint: status.guardHint,
					tasksKnown: available ? status.tasksKnown : null,
					blocked: status.blocked === true,
					waiting: available ? preExecution || status.waiting === true : state.waiting,
				waitingSince: status.waitingSince ?? null,
				// 2026-10-29：宿主配置的警告态有效秒数（老宿主 undefined → 保持默认）。
				warnExpireMs,
				waitingMaxMs: status.waitingMaxMs ?? null,
					restart: status.lastRestart ?? null,
					op,
					opBusy,
					pollFailures,
					phase,
					message,
				};
				if (available) patch.opError = "";
				update(patch);
				syncPoll();
			}

			/**
			 * 第一个订阅者来了：回到「刚挂载」的瞬时状态，拉一次状态，再按结果决定
			 * 要不要开始轮询。确认态 / 武装态不该跨过一段没有界面的时间活下来。
			 */
			function start() {
				started = true;
				lifecycle += 1;
				update({
					phase: "idle",
					message: "",
					request: null, pauseOwner: null, forceOwner: null,
					armed: false,
					modalOpen: false,
					modalOwner: null,
					acknowledged: false,
					guardText: "",
					opError: "",
				});
				refresh();
			}

			/** 最后一个订阅者走了：轮询必须真的停掉（否则清理会漏在模块里）。 */
			function stop() {
				started = false;
				lifecycle += 1;
				clearPoll();
				syncDisplayClock();
			}

			/** 重新问一次宿主，好让提示不会过期（鼠标移入 / 聚焦时调用）。 */
			function refresh() {
				if (!started) return;
				// F6：状态回包按世代有序应用；旧 GET 晚到不得覆盖新状态
				const seq = ++statusSeq;
				const generation = lifecycle;
				update({ statusPending: true });
				fetchStatus().then((status) => {
					if (!started || generation !== lifecycle) return;
					if (seq < appliedSeq) return;
					appliedSeq = seq;
					applyStatus(status);
					update({ statusPending: false });
				}, (error) => {
					if (!started || generation !== lifecycle) return;
					if (seq < appliedSeq) return;
					appliedSeq = seq;
					update({ statusError: String((error && error.message) || error), statusPending: false });
				});
			}

			/**
			 * 请宿主排程一次重启。
			 * @param {{ force?: boolean, wait?: boolean, cancelWait?: boolean }} options - 动作。
			 * @param {string} owner - 发起这次请求的入口：风险确认框只弹给它。
			 */
			function send(options, owner) {
				if (state.submissionUncertain || state.phase === "restarting") return;
				const generation = lifecycle;
				appliedSeq = ++statusSeq;
				update({ phase: "restarting", message: "", op: null, opBusy: false, opError: "", pollFailures: 0 });
				syncPoll();
				requestRestart(options).then((result) => {
					if (!started || generation !== lifecycle) return;
					if (result.uncertain) {
						update({phase:"idle",submissionUncertain:true,submissionExpiresAt:result.expiresAt,opBusy:true,
							op:{id:null,result:"unknown",phase:"unknown",reason:"submission-unknown",busy:true,needsManualCheck:true},message:result.text});
						refresh();
						return;
					}
					if (result.ok) {
						// 已接受的等待/取消也使此前在途的状态读取失效。
						appliedSeq = ++statusSeq;
						// 等待挂起与取消都不是「重启已排程」：界面继续可用，
						// 只是状态换一句线。真正的重启仍由 done 那条路走。
						if (result.waiting === true) {
							update({ waiting: true, waitingSince: result.since ?? state.waitingSince ?? new Date().toISOString(), phase: "idle", message: result.text });
							syncPoll();
							if (result.request !== undefined) refresh();
							return;
						}
						if (result.cancelled !== undefined) {
							if (result.cancelled === true) {
								update({ waiting: false, request: result.request ?? state.request, phase: "idle", message: result.text });
								syncPoll();
								refresh();
								return;
							}
							// 没有可取消的等待：不假装已取消，重新读取权威状态
							update({ phase: "idle", message: result.text });
							refresh();
							return;
						}
						// 202 = 请求已被接受，不等于重启成功。置 pending 占位，让轮询
						// 去读宿主的真实阶段；失败/未知时由 watcher 解锁重试。
						update({
							phase: "done",
							message: "",
							opError: "",
							pollFailures: 0,
							opBusy: true,
							op: { id: null, phase: "scheduled", result: "pending", reason: null, stages: {}, ageMs: 0, helperAlive: true, busy: true, argsPreserved: false },
						});
						syncPoll();
						refresh();
						return;
					}
					if (result.blocked === true) {
						// 插件正在安装/更新：宿主半硬拦，连 force 都过不去。所以
						// 这里不弹「确认继续」（勾了也只会再撞一次），只把原因摆出来。
						update({ blocked: true, phase: "error", message: result.text });
						return;
					}
					if (result.guard === true) {
						// 宿主半说了「有东西在跑」。有官方 RiskConfirmation 就用官方那套
						// （警告 + 显式勾选 + 确认按钮）；没有才退回内联警告态。
						// A DOM-only subscriber has no React dialog surface. Keep the existing
						// inline warning path actionable for that owner.
						if (OfficialRiskConfirmation !== null && questionViews.has(owner)) {
							update({ guardText: result.text, acknowledged: false, modalOpen: true, modalOwner: owner, phase: "idle" });
							return;
						}
						// 2026-10-29 过期机制：409 回 warn 也走 armWarnState。
						armWarnState(result.text);
						return;
					}
					update({ phase: "error", message: result.text });
				}, (failure) => {
					if (!started || generation !== lifecycle) return;
					update({ phase: "error", message: String((failure && failure.message) || failure) });
				});
			}

			/** 挂起「等空闲再重启」：不需要两步确认 —— 它本来就不打断任何东西。 */
			function waitForIdle(owner) {
				send({ wait: true }, owner);
			}

			/** 取消挂起的等待。 */
			function cancelWait(owner) {
				if (state.request?.state === "paused") send({ choice: "cancel", ask: state.request.ask }, owner);
				else send({ cancelWait: true }, owner);
			}

			/**
			 * 等待期间也要能「别等了，现在就重启」。
			 * 2026-10-22：默认等待接管后，风险确认的入口走不到，用户被锁在等待里。
			 */
			function forceNowRestart(owner) {
				if (state.phase === "restarting" || state.opBusy) return;
				// 2026-10-29 决策甲：此函数只服务等待/暂停态的显式入口（暂停询问框
				// 的「仍要立即重启」）。warn 态（有任务在跑）的主按钮二击已改为
				// 直接 send({force,now})，不再经过这里。
				if (!state.waiting) return;
				armInterruptConfirm(owner);
			}

			/** 暂停询问中的显式立即执行，需要额外确认；warn 两击不经过这里。 */
			function armInterruptConfirm(owner) {
				if (OfficialRiskConfirmation !== null) {
					update({ guardText: state.guardHint !== "" ? state.guardHint + t("guardAsk") : state.message,
						acknowledged: false, modalOpen: true, modalOwner: owner, phase: "idle", confirmAt: 0 });
					return;
				}
				update({ forceOwner: owner, phase: "idle", confirmAt: 0, message: "" });
			}

			function press(owner) {
				const { phase, desktop, opBusy, armed, guardHint } = state;
				if (phase === "restarting" || desktop === false || phase === "done") return;
				// 问题 3：结果未知且仍可能占着互斥时，不允许再发起一次。
				if (opBusy === true) return;
				// 2026-10-28 硬守卫：等待/倒计时/暂停（请求由宿主管着）直接早退。
				// 不只靠按钮的 disabled 属性 —— disabled 只挡得住真实鼠标，键盘
				// 回车/其它包装层仍可能调到 onClick。此前这里会落入 confirm 分支：
				// 第一次点击无可见变化地武装确认，CONFIRM_MS 内第二击 send({})
				// 真正提交重启 —— 「一次像坏了、两次直接重启」。现在早退，两击
				// 都不发任何请求；常规出口是「取消等待」，显式「仍要立即重启」
				// 走 forceNowRestart（设计内入口，不受影响）。
				if (state.request !== null
					&& ["waiting", "countdown", "paused"].includes(state.request.state)) return;
				// warn 态新鲜度双保险：expireLater 的定时器因无 timer 服务缺失或
				// 竞态未触发时，由点击瞬间的时间戳兜底（与 confirm 态同款）。
				if (phase === "warn" && state.warnAt > 0 && nowMs() - state.warnAt >= warnExpireMs) {
					// 已过期：本次点击当作新的第一击重新进入 warn。
					armWarnState(guardHint + t("forceTwoClickSuffix"));
					return;
				}
				if (phase === "warn") {
					// 2026-10-29 决策甲：有任务在跑时，主按钮第二击直接强制重启。
					// 「仍要重启？」的文字本身已是确认语义 —— 不弹任何确认框
					// （10-28 的弹框版被用户否决：四步太繁琐）。
					// 历史注记：10-26 曾改 send({}) 普通请求、10-28 曾改弹框确认，
					// 两版都被推翻；本版回到「二击即执行」，但由 warn 态首击
					// 直达（不再先撞一次 409 再回 warn）。
					// 冷却期内点击直接忽略（按钮此时也是 disabled 的）。
					if (armed) send({ force: true, now: true }, owner);
					return;
				}
				if (phase === "error") {
					// 上一次请求本身失败了，重试就是再发一次，不必重新武装。
					send({}, owner);
					return;
				}
				// 2026-10-29 决策甲：最近一次状态查询确认有任务（guardHint 非空）时，
				// 第一击直接进 warn 态（红色「仍要重启？」）—— 跳过 confirm 与
				// 「发普通请求被宿主 409 拒绝再回 warn」的旧弯路。guardHint 的
				// 时效边界（任务刚启动/刚结束、轮询未跟上）：此时走普通 confirm
				// 路径，二击 send({})；由宿主根据最新任务进入等待，安装时硬拦。
				if (guardHint !== "" && phase === "idle" && !state.waiting) {
					// 2026-10-29 过期机制：改走 armWarnState（warnAt 时间戳 +
					// expireLater，时长来自宿主 warnExpire 设置，默认 15 秒）——
					// 修复真机「warn 态永不过期、误碰一击即重启」。
					armWarnState(guardHint + t("forceTwoClickSuffix"));
					return;
				}
				// 确认态必须是「刚刚」的：超过窗口就当第一次点击重新武装，
				// 否则一个卡住的 confirm 会让下一次单击直接重启（真机已复现）。
				const fresh = phase === "confirm" && typeof state.confirmAt === "number"
					&& nowMs() - state.confirmAt <= CONFIRM_MS;
				if (!fresh) {
					const confirmAt = nowMs();
					const generation = lifecycle;
					update({ phase: "confirm", confirmAt });
					expireLater(() => {
						if (generation === lifecycle && state.phase === "confirm" && state.confirmAt === confirmAt) update({ phase: "idle", confirmAt: 0 });
					}, CONFIRM_MS);
					return;
				}
				update({ confirmAt: 0 });
				send({}, owner);
			}

			/** 官方确认框：取消（含 Esc / 点遮罩）。 */
			function cancelModal(owner) {
				if (state.modalOwner !== owner) return;
				update({ modalOpen: false, modalOwner: null, acknowledged: false, phase: "idle" });
			}

			/**
			 * 官方确认框：确认后带 force=1&now=1 重发。
			 * 2026-10-26 缺陷 1 修复：官方 RiskConfirmation 弹窗本身就有勾选 +
			 * 确认两步，是显式的「仍要重启」动作 —— 所以这里明确带上 now=1
			 * （跳过等待与倒计时），而不是只带 force 让宿主去猜。
			 */
			function confirmModal(owner) {
				if (state.modalOwner !== owner) return;
				update({ modalOpen: false, modalOwner: null, acknowledged: false });
				send({ force: true, now: true }, owner);
			}

			function setAcknowledged(owner, next) {
				if (state.modalOwner !== owner) return;
				update({ acknowledged: typeof next === "function" ? next(state.acknowledged) : next });
			}

			/**
			 * 一个入口能看到的快照：字段形状与原来 `useRestart` 的返回值完全一致
			 * （所以四个入口的组件代码一行都不用改）。
			 * @param {string} viewId - 入口自己的标识；只有它能看到自己发起的风险确认框。
			 * @returns {object} 动作状态 + `press` / `refresh` / `modal`。
			 */
			function getSnapshot(viewId) {
				const { phase, message, desktop, statusError, statusPending, guardHint, blocked, waiting, waitingSince, waitingMaxMs, restart, op, opBusy, opError, armed, warnAt, warnExpireMs } = state;
				const owns = state.modalOpen === true && state.modalOwner === viewId;
				const request = state.request;
				return {
					countdownSeconds: state.countdownSeconds,
					tasksKnown: state.tasksKnown,
					request: state.request,
					notifications: state.notifications,
					authCookie: state.authCookie,
					noticeReadError: state.noticeReadError,
					markNoticeRead: async (id) => {
						try {
							const response = await fetch(PREFS_ROUTE + "?readNotice=" + encodeURIComponent(id), {method:"POST"});
							const body = await response.json();
							if (!response.ok || body.read !== true) throw new Error("read-not-saved");
							update({noticeReadError:""}); refresh();
						} catch { update({noticeReadError:t("noticeError")}); }
					},
					phase,
					message,
					desktop,
					statusError,
					statusPending,
					guardHint,
					blocked,
					waiting,
					waitingSince,
					waitingMaxMs,
					restart,
					op,
					opBusy: opBusy || state.request?.state === "executing",
					opError,
					armed,
					// 2026-10-29：warn 态过期机制的字段（warnConfirmLineOf 要用；
					// 此前只解构未返回 —— 快照里 undefined，渲染层拿不到）。
					warnAt,
					warnExpireMs,
					press: () => press(viewId),
					submit: (patch) => send(patch, viewId),
					// 2026-10-29 决策甲：直通共享 store 的 press()——pressLocal 的
					// guardHint 直达 warn 分支复用它，避免在两套 press 里复制
					// warn 武装（update + armLater）逻辑。
					storePress: () => press(viewId),
					forceNowRestart: () => forceNowRestart(viewId),
					refresh,
					waitForIdle: () => waitForIdle(viewId),
					cancelWait: () => cancelWait(viewId),
					pause: {
						open: state.request?.state === "paused" && state.pauseOwner === viewId && state.forceOwner === null,
						wait: () => send({ choice: "wait", ask: request.ask }, viewId),
					},
					immediate: {
						open: state.forceOwner === viewId,
						cancel: () => update({ forceOwner: null }),
						confirm: () => {
							// 2026-10-28 合并改动：warn 态（无挂起请求，只有任务在跑）
							// 也经此确认发 force+now —— 与等待/暂停态共用同一道确认。
							if (state.forceOwner !== viewId) return;
							if (state.request === null && state.waiting !== true) {
								// warn 态：无 restartRequest，确认即打断。
								update({ forceOwner: null });
								send({ force: true, now: true }, viewId);
								return;
							}
							if (state.request?.id !== request?.id || !state.waiting) return;
							update({ forceOwner: null });
							send(request?.state === "paused" ? { choice: "now", ask: request.ask } : { force: true, now: true }, viewId);
						},
					},
					modal: {
						open: owns,
						acknowledged: owns ? state.acknowledged : false,
						text: state.guardText,
						setAcknowledged: (next) => setAcknowledged(viewId, next),
						cancel: () => cancelModal(viewId),
						confirm: () => confirmModal(viewId),
					},
				};
			}

			/**
			 * 订阅共享状态；返回退订函数。引用计数归零时停掉轮询。
			 * @param {() => void} listener - 状态变化时调用。
			 * @returns {() => void} 退订。
			 */
			function subscribe(listener, viewId, canAsk) {
				listeners.add(listener);
				if (canAsk) questionViews.add(viewId);
				if (listeners.size === 1) start();
				if (state.request?.state === "paused" && state.pauseOwner === null) update({ pauseOwner: questionViews.values().next().value ?? null });
				return function unsubscribe() {
					if (!listeners.delete(listener)) return;
					questionViews.delete(viewId);
					if (state.pauseOwner === viewId) update({ pauseOwner: questionViews.values().next().value ?? null });
					if (state.forceOwner === viewId) update({ forceOwner: null });
					if (listeners.size === 0) stop();
				};
			}

			/**
			 * 每个入口一个只读标识：用来把风险确认框只留给发起请求的那个入口。
			 * @returns {string} 形如 `view-3`。
			 */
			function newViewId() {
				viewSeq += 1;
				return "view-" + String(viewSeq);
			}

			return {
				subscribe,
				getSnapshot,
				newViewId,
				/** 客户端 timer 服务（武装 / 冷却那类延时用），四个入口传的是同一个。 */
				bindTimer(next) {
					if (next !== undefined && next !== null) timerService = next;
				},
			};
		}

		const restartStore = createRestartStore();

		// ── §9 视图小组件（图标 / 订阅 hook / 风险框） ───────────────────────
		/**
		 * 刷新图标。优先用官方 `IconRefreshOutlineRegular`（应用自己就是 size 14），
		 * 拿不到时画一个同样约定的 16 格描边 SVG。
		 * @param {number} size - 边长（像素）。
		 * @returns {object} React 元素。
		 */
		const REFRESH_PATHS = ["M13.51 7.03A5.6 5.6 0 1 1 10.8 3.15", "M10.42 1.75L10.97 3.25L9.4 3.53"];
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
				React.createElement("path", { d: REFRESH_PATHS[0] }),
				React.createElement("path", { d: REFRESH_PATHS[1] }));
		}

		/**
		 * 标题栏就地取消按钮的图标：一个「×」—— 与 Glyph 同一画法（描边、
		 * currentColor），不依赖官方组件，兜底样式与重启图标保持一致。
		 * @param {number} size - 边长。
		 * @returns {object} React 元素。
		 */
		function RefreshStatusGlyph(size) {
			return React.createElement("svg", {
				width:String(size), height:String(size), viewBox:"0 0 16 16",
				fill:"none", stroke:"currentColor", strokeWidth:"1.4",
				strokeLinecap:"round", strokeLinejoin:"round", "aria-hidden":"true", focusable:"false",
				"data-refresh-status-icon":"1",
			}, React.createElement("path", {d:"M3 5h10M10 2l3 3-3 3M13 11H3M6 8l-3 3 3 3"}));
		}

		function CancelGlyph(size) {
			return React.createElement("svg", {
				width: String(size),
				height: String(size),
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.6",
				strokeLinecap: "round",
				"aria-hidden": "true",
				focusable: "false",
			},
				React.createElement("path", { d: "M4 4L12 12" }),
				React.createElement("path", { d: "M12 4L4 12" }));
		}

		/**
		 * 入口共用的重启动作：只订阅上面那份共享状态。
		 *
		 * 返回值形状与「每个实例自己存 state」那版**完全一致**，所以四个入口的
		 * 组件代码一行都不用改：字段、默认值、禁用判据、请求 URL 都没动。
		 * @param {object | undefined} timer - 客户端 timer 服务，用于让武装态与警告冷却过期。
		 * @returns {object} 动作状态 + `press` / `refresh` / `modal`。
		 */
		function useDialogFocus(open, cancel) {
			const ref = React.useRef(null);
			const cancelRef = React.useRef(cancel);
			cancelRef.current = cancel;
			React.useEffect(() => {
				const dialog = ref.current;
				if (!open || !dialog) return;
				const previous = document.activeElement;
				const controls = () => Array.from(dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[href],[tabindex="0"]'));
				(dialog.querySelector('[data-dialog-cancel]') ?? controls()[0] ?? dialog).focus();
				const onKey = event => {
					if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRef.current(); return; }
					if (event.key !== "Tab") return;
					const items = controls();
					if (!items.length) { event.preventDefault(); dialog.focus(); return; }
					const first = items[0], last = items[items.length - 1];
					if (!dialog.contains(document.activeElement) || event.shiftKey && document.activeElement === first) {
						event.preventDefault(); (event.shiftKey ? last : first).focus();
					} else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
				};
				document.addEventListener("keydown", onKey, true);
				return () => { document.removeEventListener("keydown", onKey, true); if (previous?.isConnected) previous.focus(); else document.querySelector('[data-header-main]:not(:disabled),[data-settings-restart]:not(:disabled),.dshdr-panel-actions button:not(:disabled),button[aria-haspopup="menu"][data-signed-out]')?.focus(); };
			}, [open]);
			return ref;
		}

		function useRestart(timer, canAsk = true) {
			const viewRef = React.useRef(null);
			if (viewRef.current === null) viewRef.current = restartStore.newViewId();
			const bumpPair = React.useState(0);
			const bump = bumpPair[1];
			// 确认态属于“每个入口自己”：共享 store 的 phase 变化曾不触发这些入口重渲染。
			const confirmPair = React.useState(0);
			const confirmAt = confirmPair[0];
			const setConfirmAt = confirmPair[1];
			const expiryRef = React.useRef(null);
			React.useEffect(() => {
				restartStore.bindTimer(timer);
				const unsubscribe = restartStore.subscribe(() => bump((count) => count + 1), viewRef.current, canAsk);
				return () => {
					unsubscribe();
					if (expiryRef.current !== null && typeof window !== "undefined" && typeof window.clearTimeout === "function") {
						window.clearTimeout(expiryRef.current);
						expiryRef.current = null;
					}
				};
			}, []);
			const snapshot = restartStore.getSnapshot(viewRef.current);
			const dialogRef = useDialogFocus(snapshot.immediate.open || snapshot.pause.open,
				() => snapshot.immediate.open ? snapshot.immediate.cancel() : snapshot.cancelWait());
			// 渲染期只决定“现在显示成什么”；是否仍在确认窗口内由点击瞬间判断。
			const freshForRender = confirmAt > 0 && nowMs() - confirmAt <= CONFIRM_MS;
			const clearExpiry = () => {
				if (expiryRef.current !== null && typeof window !== "undefined" && typeof window.clearTimeout === "function") {
					window.clearTimeout(expiryRef.current);
				}
				expiryRef.current = null;
			};
			const pressLocal = () => {
				if (snapshot.phase === "restarting" || snapshot.desktop === false || snapshot.phase === "done") return;
				if (snapshot.opBusy === true) return;
				// 2026-10-28 硬守卫：与共享 store 的 press() 同步 —— 等待/倒计时/
				// 暂停态早退，不进入 confirm 分支（第一击无可见变化、第二击提交
				// 的漏洞在两套 press 里各有一份，必须一起堵）。
				if (snapshot.request !== null
					&& ["waiting", "countdown", "paused"].includes(snapshot.request.state)) return;
				if (snapshot.phase === "warn") {
					if (snapshot.warnAt > 0 && nowMs() - snapshot.warnAt >= snapshot.warnExpireMs) {
						snapshot.storePress();
						return;
					}
					// 2026-10-29 决策甲：与共享 store 的 press() 同步 —— warn 态
					// 二击直接 submit force+now（「仍要重启？」即确认，不弹框）。
					if (snapshot.armed === true) snapshot.submit({ force: true, now: true });
					return;
				}
				if (snapshot.phase === "error") {
					snapshot.submit({});
					return;
				}
				// 2026-10-29 决策甲：与共享 store 的 press() 同步 —— 已知有任务
				// （guardHint 非空）时第一击直达 warn。本地 confirm 态与正在生效的
				// 确认窗口都让位：转交共享 press()（它做 warn 武装 update+armLater），
				// 不在包装层再复制一份。
				if (snapshot.guardHint !== "" && snapshot.phase === "idle" && !snapshot.waiting) {
					snapshot.storePress();
					return;
				}
				// F1：必须在点击瞬间判断，不能复用渲染期算好的值
				const stillFresh = confirmAt > 0 && nowMs() - confirmAt <= CONFIRM_MS;
				if (stillFresh) {
					clearExpiry();
					setConfirmAt(0);
					snapshot.submit({});
					return;
				}
				const armedAt = nowMs();
				setConfirmAt(armedAt);
				clearExpiry();
				if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
					expiryRef.current = window.setTimeout(() => {
						setConfirmAt((current) => (current === armedAt ? 0 : current));
						expiryRef.current = null;
					}, CONFIRM_MS + 20);
				}
			};
			return Object.assign({}, snapshot, {
				dialogRef,
				phase: freshForRender ? "confirm" : snapshot.phase,
				armed: freshForRender ? true : snapshot.armed,
				press: pressLocal,
			});
		}

		/**
		 * 官方风险确认框（拿不到官方组件时返回 null，由内联警告态兜底）。
		 * @param {object} action - {@link useRestart} 的返回值。
		 * @returns {object | null} React 元素或 null。
		 */
		function DiagnosticNotices(action) {
			const items = action.notifications?.items ?? [];
			const view = (item) => React.createElement("section", {key:item.id, className:"dshdr-panel-warn", role:item.unread ? "alert" : undefined},
				React.createElement("strong", null, item.summary),
				item.unread && React.createElement("p", null, t("noticeDelivery")),
				React.createElement("details", null, React.createElement("summary",null,t("noticeDetails")), React.createElement("pre",null,JSON.stringify(item.details,null,2))),
				item.unread && React.createElement("button",{type:"button",onClick:()=>action.markNoticeRead(item.id)},t("noticeRead")));
			return React.createElement("div",null,
				(action.notifications?.error || action.noticeReadError) && React.createElement("p",{role:"alert"},action.noticeReadError || t("noticeError")),
				...items.filter(item=>item.unread).map(view),
				items.some(item=>!item.unread) && React.createElement("details",null,React.createElement("summary",null,t("noticeHistory")),...items.filter(item=>!item.unread).map(view)));
		}

		function RiskDialog(action) {
			if (action.immediate.open || action.pause.open) {
				const immediate = action.immediate.open;
				const pending = action.phase === "restarting";
				return React.createElement("div", { role: "dialog", ref:action.dialogRef, tabIndex:-1, "aria-modal": true, "aria-label": immediate ? t("confirmNow") : t("requestPaused"),
					style: { position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,.35)", display: "grid", placeItems: "center" } },
					React.createElement("div", { className: "dshdr-panel-note", style: { maxWidth: 480, background: "var(--dsw-alias-bg-base,white)", padding: 24 } },
						React.createElement("h2", null, immediate ? t("confirmNow") : t("requestPaused")),
						React.createElement("p", null, immediate ? t("confirmNowHint") : action.request.pausedReason),
						immediate
							? React.createElement(React.Fragment, null,
								React.createElement("button", { type: "button", "data-dialog-cancel":"1", disabled: pending, onClick: action.immediate.cancel }, t("riskCancel")),
								// 2026-10-28 危险警示色：确认「立即重启」是破坏性动作的最终
								// 确认 —— 同款 danger 类（DSH 官方范式）。
								React.createElement("button", { type: "button", className: "dshdr-btn dshdr-danger", "data-variant": "primary", disabled: pending, onClick: action.immediate.confirm }, t("confirmNow")))
							: React.createElement(React.Fragment, null,
								React.createElement("button", { type: "button", disabled: pending, onClick: action.pause.wait }, t("continueWaiting")),
								React.createElement("button", { type: "button", disabled: pending, onClick: action.forceNowRestart }, t("forceNow")),
								React.createElement("button", { type: "button", "data-dialog-cancel":"1", disabled: pending, onClick: action.cancelWait }, t("cancelRequest")))));
			}
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

		// ── §10 apply / 座位注册（内部再分 10.1–10.3） ──────────────────────
		/**
		 * 插件主体：注册会话标题栏按钮与设置页那一行，都挂在本插件自己的
		 * fiber 上，卸载时随之移除。
		 * @param {object} ctx - 客户端 Cordis 上下文。
		 */
		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const timer = ctx.get("timer");

			// ── §10.1 locale 注册 + 入口共用 helper（守卫文案 / tooltip / 禁用判据） ──────
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
				if (["ok", "failed", "unknown"].includes(action.op?.result)) return t("wholeAppTooltip");
				if (action.message !== "") return action.message;
				if (action.statusError !== "") return action.statusError;
				if (action.desktop === false) return t("desktopOnly");
				// 2026-10-26 缺陷 2：countdown / paused / waiting 期间，悬停提示直接
				// 复用主面板那行 waitingLine —— 含剩余秒数与最晚取消时刻，
				// 这样标题栏与侧栏按钮的 tooltip 也能回答「还要等多久」。
				const waiting = waitingLine(action);
				if (waiting !== "") return waiting;
				if (action.guardHint !== "") return action.guardHint + guardSuffix(action, "clickTwiceSuffix");
				return t("wholeApp");
			}

			/**
			 * 忙碌 / 冷却 / 非桌面版时按钮不可点；已排程之后也不必再点。
			 * @param {object} action - 动作状态。
			 * @returns {boolean} 是否禁用。
			 */
			/**
			 * 主按钮的类名（2026-10-29 决策甲）：warn 态加 danger 警示色。
			 * 有任务在跑时主按钮显示「仍要重启？」且第二击会**直接打断任务**
			 * —— 破坏性动作落在按钮本身，红色预警随之落在按钮上
			 * （与 DSH 官方 dangerButton 同款变量覆盖，见 .dshdr-danger）。
			 * confirm 态（无任务，二击走普通倒计时）保持主色不变。
			 * @param {object} action - 动作状态。
			 * @returns {string} 类名（空串 = 无附加类）。
			 */
			function mainDangerClass(action) {
				return action.phase === "warn" ? " dshdr-danger" : "";
			}

			function isDisabled(action) {
				// 2026-10-28：等待/倒计时/暂停（请求由宿主管着）一律禁用。
				// 此前不含这三态：主按钮可点但 press 只武装 confirm，界面上毫无
				// 反馈，CONFIRM_MS 内第二击会 send({}) 真正提交 —— 「一次像坏了、
				// 两次直接重启」。常规出口是旁边的「取消等待」；显式「仍要立即重启」
				// 走 forceNowRestart（设计内入口，不受此禁用影响）。
				// 这是三个入口共用的**单一判定函数**；面板原先自带一份重复表达式，
				// 本轮合并，不再维护两套。
				if (action.request !== null
					&& ["waiting", "countdown", "paused"].includes(action.request.state)) return true;
				return action.phase === "restarting"
					|| action.phase === "done"
					|| action.opBusy === true
					|| (action.desktop === false && action.statusError === "")
					|| (action.phase === "warn" && action.armed === false);
			}

			// ── §10.2 各入口组件（刷新 / 重试 / 等待 / 标题栏 / 设置行 / 侧栏 / 面板 / 设置分区） ──────
			/** 状态路由失败时提供明确的重试动作。 */
			/** 常驻「刷新」：正常状态下重读一次宿主状态（出错时交给 StatusRetry）。 */
			function RefreshButton(action) {
				if (action.statusError !== "") return null;
				if (action.desktop === false) return null;
				const label = action.statusPending ? t("wait") : t("refreshStatus");
				const props = { variant: "ghost", disabled: action.statusPending === true, onClick: action.refresh, "aria-label": label, title: label };
				return OfficialButton !== null
					? React.createElement(OfficialButton, props, label)
					: React.createElement("button", Object.assign({ type: "button", className: "dshdr-btn", "data-variant": "ghost" }, props), label);
			}

			function StatusRetry(action) {
				// 2026-10-30 修复重复按钮：只在状态读取**真的失败**时出现，
				// 标签恒为「重试状态」。此前 statusError==="" && opBusy===true
				// 时也渲染且标签与 RefreshButton 相同（refreshStatus）—— 执行
				// 期间面板出现两个「刷新状态」（0.4.5 就有的缺陷，真机报告）。
				// 执行期间的刷新由常驻 RefreshButton 独自承担，功能不缺失。
				if (action.statusError === "") return null;
				const label = t("retryStatus");
				const props = {
					variant: "ghost",
					disabled: action.statusPending,
					onClick: action.refresh,
					"aria-label": label,
				};
				return OfficialButton !== null
					? React.createElement(OfficialButton, props, action.statusPending ? t("wait") : label)
					: React.createElement("button", Object.assign({ type: "button", className: "dshdr-btn", "data-variant": "ghost" }, props),
						action.statusPending ? t("wait") : label);
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
				const waiting = action.waiting === true;
				const onClick = waiting ? action.cancelWait : action.waitForIdle;
				const label = waiting ? t("cancelWaiting") : t("waitAndRestart");
				// 2026-10-28：等待期间主重启按钮已禁用（isDisabled 硬守卫），
				// 「取消等待」成了唯一常规出口 —— 视觉升为主操作（primary），
				// 「仍要立即重启」降为次级（ghost）。主次对调：此前取消是 ghost，
				// 与「它现在是主路径」不符，用户反馈「取消入口太弱」。
				// forceNowRestart 显式路径原样保留。
				const mainVariant = waiting ? "primary" : "ghost";
				const main = OfficialButton !== null
					? React.createElement(OfficialButton, {
						variant: mainVariant,
						onClick: onClick,
						onMouseEnter: action.refresh,
						onFocus: action.refresh,
						title: label,
					}, label)
					: React.createElement("button", {
						type: "button",
						className: "dshdr-btn",
						"data-variant": mainVariant,
						onClick: onClick,
						onMouseEnter: action.refresh,
						onFocus: action.refresh,
						title: label,
					}, label);
				// 2026-10-28 合并决策（用户选乙）：移除等待态的独立「仍要立即重启」
				// 按钮 —— 有任务时的打断确认已并入主按钮第二击（armInterruptConfirm），
				// 等待/暂停态保留的显式入口是暂停询问框的 forceNow（RiskDialog）。
				// 此处等待态只渲染「取消等待」（唯一常规出口）；非等待态保持原样
				// （「等空闲再重启」ghost）。forceNowRestart 函数与状态机保留，
				// 供暂停询问框与合并路径内部复用。
				return main;
			}

			/** 会话标题栏上的常驻按钮：照官方那个座位里的动作按钮做。 */
			function HeaderRestartButton() {
				const action = useRestart(timer);
				const busy = action.phase === "restarting" || action.request?.state === "executing" || action.op?.result === "pending";
				const title = tooltipOf(action);
				// 详细提示不进 aria-label（皮肤插件会把它当可见标题），走 describedby。
				const described = ariaDescriptionOf(action);
				const hintId = useHintId();
				// 2026-10-27 缺陷 1/2：标题栏自己的可见状态与就地取消。
				// - headerStateText：非 idle 时的短状态词（确认重启 / 5s / 等待中 /
				//   已暂停 / 重启中…）。idle 为 null —— 不渲染任何节点、不占宽度。
				// - cancellable：waiting / countdown / paused 时为 true（executing
				//   不可撤回，不出现取消）。
				const cancelled = action.phase === "idle" && (action.request?.reason === "cancelled" || action.message === t("waitingCancelled"));
				const headerStateText = cancelled ? null : action.message !== "" && action.phase !== "warn"
					? (action.message === t("nothingToCancel") ? t("headerNoWait") : action.request?.reason === "cancelled" || action.message === t("waitingCancelled") ? t("headerCancelled") : t("headerResult"))
					: headerStateOf(action);
				const cancellable = action.request !== null
					&& ["waiting", "countdown", "paused"].includes(action.request.state);

				return React.createElement(React.Fragment, null,
					// 就地取消（缺陷 2）：仅 waiting/countdown/paused 出现；纯图标尺寸，
					// 可读性交给 aria-label/title。点击走既有 cancelWait 语义
					// （宿主回 cancelled:true → 已取消等待；false → 没有可取消的等待，
					// 复用 F2 已修的如实上报，不把 false 显示成已取消）。
					cancellable && React.createElement("button", {
						type: "button",
						className: "dshdr-trigger dshdr-trigger--cancel",
						disabled: action.phase === "restarting",
						title: t("cancelWaiting"),
						"aria-label": t("cancelWaiting"),
						onClick: action.cancelWait,
					}, CancelGlyph(12)),
					React.createElement("button", {
						type: "button",
						className: "dshdr-trigger",
						"data-phase": action.phase,
						"data-header-main": "1",
						"data-request-state": action.request?.state ?? (action.waiting ? "waiting" : undefined),
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
						(headerStateText === null || (action.message !== "" && action.phase !== "warn")) && React.createElement("span", {
							className:"dshdr-header-name", "aria-hidden":true,
						}, t("restart")),
						headerStateText !== null && React.createElement("span", {
							className: "dshdr-header-state",
							"aria-hidden": true,
						}, headerStateText)),
					described !== "" && React.createElement("span", { id: hintId, className: "dshdr-sr-only" }, described),
					// 2026-10-23 用户要求：标题栏要有个「刷新」。注意**只刷新状态**，
					// 绝不做整页重载——那会按旧 rev 请求 bundle，导致 boot 失败。
					switches.headerRefresh === true && React.createElement("button", {
						type: "button",
						// --label 修饰类：让文字可见（默认 .dshdr-label 是 display:none，只显示图标）
						className: "dshdr-trigger dshdr-trigger--label",
						"data-variant": "ghost",
						disabled: action.statusPending === true,
						title: t("refreshShort"),
						"aria-label": t("refreshShort"),
						onClick: action.refresh,
					}, RefreshStatusGlyph(14), React.createElement("span", { className: "dshdr-label" }, t("refreshShort"))),
					// 这里不要再放「重载页面」按钮：整页 re-boot 在桌面壳里会拿主进程启动时
					// 缓存的旧引导图去请求宿主，插件文件在应用运行期间被改过时该条目的 rev 已失效，
					// 本插件那一项激活失败 → web boot 整体失败 → 主进程弹「禁用第三方插件」恢复框。
					RiskDialog(action));
			}

			/** 设置页那一行：标题、说明和两步确认的重启按钮。 */
		function SettingsRestartRow() {
				const action = useRestart(timer, false);
				const busy = action.phase === "restarting" || action.request?.state === "executing" || action.op?.result === "pending";
				const hint = busy
					? t("restartingPageHint")
					: (["ok", "failed", "unknown"].includes(action.op?.result)
						? opTextOf(action.op)
						: (action.message !== ""
						? (action.phase === "warn" ? action.message + t("warnAgainHint") : action.message)
						: (action.statusError !== ""
							? action.statusError
							: (action.desktop === false
							? t("desktopOnlyRow")
							: (action.guardHint !== ""
								? action.guardHint + guardSuffix(action, "clickTwiceInterruptSuffix")
								: (action.restart !== null ? restartReceiptText(action.restart) : t(DEFAULT_HINT_KEY)))))));
				const icon = Glyph(14);
				// 2026-10-22 入口差异化：设置页是「配置与诊断」，不放破坏性主操作。
				// 重启统一走会话标题栏；这里只提供「刷新状态」，避免在设置里误触。
				const refreshLabel = action.statusPending ? t("wait") : t("refreshStatus");
				const shared2 = {
					disabled: action.statusPending,
					title: t("settingsRestartMoved"),
					"aria-label": refreshLabel,
					onClick: action.refresh,
				};
				const button = OfficialButton !== null
					? React.createElement(OfficialButton, Object.assign({ variant: "ghost", icon: icon }, shared2), refreshLabel)
					: React.createElement("button", Object.assign({
						type: "button",
						className: "dshdr-btn",
						"data-variant": "ghost",
					}, shared2), icon, refreshLabel);

				return React.createElement(React.Fragment, null,
                    PhaseAnnouncement(action),
					React.createElement("div", { className: "dshdr-row" },
						React.createElement("div", { className: "dshdr-row-text" },
							React.createElement("span", { className: "dshdr-row-label" }, t("pluginName")),
							React.createElement("span", {
								className: "dshdr-hint",
								"data-tone": toneOf(action),
								// 状态变化要能被读屏软件念出来：从「没事」变成「有任务在跑」时，
								// 只靠颜色变化对读屏用户是看不见的。
								"aria-live": "off",
							}, hint)),
						React.createElement("span", { className: "dshdr-row-actions" }, button)));
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
				const busy = action.phase === "restarting" || action.request?.state === "executing" || action.op?.result === "pending";
				const title = tooltipOf(action);
				// 这一条最要紧：皮肤插件（dsh-claude-style）接管侧栏底部时，
				// 会把 aria-label 当可见行标题；详细提示只能走 describedby。
				const described = ariaDescriptionOf(action);
				const hintId = useHintId();

				return React.createElement(React.Fragment, null,
                    PhaseAnnouncement(action),
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
				const busy = action.phase === "restarting" || action.request?.state === "executing" || action.op?.result === "pending";
				const label = labelOf(action);
				// 2026-10-28：改用共用的 isDisabled —— 此前面板自带一份重复表达式
				//（少 statusError 豁免、且不含等待态），两套判定已经漂移过一次
				//（等待态漏洞正是两处都漏）。单一函数，不再维护两套。
				const disabled = isDisabled(action);
				// 说明文字永远讲「这是什么」；守卫那类动态信息单独占一块警告卡片
				// （原先把它拼进说明里，读起来像一句话被硬接了一截）。
				const desc = action.statusError !== "" ? action.statusError
					: (action.desktop === false ? t("desktopOnlyPanel") : t("panelDesc"));
				// 2026-10-29 文案修正：warn 态（两击强制的确认期）不再渲染
				// guardWarn —— 守卫说明由 message 段落（warnConfirmLine，带剩余
				// 秒数）承担，同一件事只出现一次；非 warn 态照旧（含等待中的
				// waitingSuffix 出口）。
				const guardWarn = action.guardHint === "" || action.phase === "warn"
					? ""
					: action.guardHint + guardSuffix(action, "forceTwoClickSuffix");
				const icon = Glyph(16);
				const shared = {
					disabled: disabled,
					title: tooltipOf(action),
					"aria-label": ariaLabelOf(action),
					"aria-busy": busy ? "true" : undefined,
					onClick: action.press,
					onMouseEnter: action.refresh,
					onFocus: action.refresh,
				};
				const button = OfficialButton !== null
					? React.createElement(OfficialButton, Object.assign({ variant: "primary", icon: icon, className: mainDangerClass(action).trim() || undefined }, shared), label)
					: React.createElement("button", Object.assign({
						type: "button",
						className: "dshdr-btn" + mainDangerClass(action),
						"data-variant": "primary",
						"data-busy": busy ? "1" : "0",
					}, shared), icon, label);

				return React.createElement(React.Fragment, null,
                    PhaseAnnouncement(action),
					React.createElement("div", { className: "dshdr-panel" },
						React.createElement("div", { className: "dshdr-panel-header" },
							React.createElement("h2", { className: "dshdr-panel-title" }, t("pluginName")),
							React.createElement("span", {
								className: "dshdr-panel-status",
								"data-tone": toneOf(action),
								"aria-live": "off",
							}, statusOf(action))),
						React.createElement("div", { className: "dshdr-panel-body" },
							React.createElement("p", { className: "dshdr-panel-desc" }, desc),
						React.createElement("dl", {className:"dshdr-panel-facts"},
							React.createElement("div", null, React.createElement("dt",null,t("taskCheckTitle")), React.createElement("dd",null,t(action.tasksKnown === true ? "taskVerified" : "taskUnknown"))),
							React.createElement("div", null, React.createElement("dt",null,t("nextCountdown")), React.createElement("dd",null,Number.isInteger(action.countdownSeconds) ? t("secondsValue",{sec:String(action.countdownSeconds)}) : "—"))),
							React.createElement(AuthCookieWarning, {health:action.authCookie}),
							DiagnosticNotices(action),
						action.op !== null && React.createElement("p", {
							className: action.op.result === "pending" ? "dshdr-panel-desc" : "dshdr-panel-warn",
							"aria-live": "off",
						}, opTextOf(action.op)),
							action.opError !== "" && React.createElement("p", { className: "dshdr-panel-warn", "aria-live": "polite" }, action.opError),
							action.restart !== null && React.createElement("p", { className: "dshdr-panel-note" }, restartReceiptText(action.restart)),
							guardWarn !== "" && React.createElement("p", { className: "dshdr-panel-warn" }, guardWarn),
						waitingLine(action) !== "" && React.createElement("p", { className: "dshdr-panel-note", "aria-live": "off" }, waitingLine(action)),
						(action.waiting === true || action.op?.result === "pending") && expectedRestartLine(action) !== "" && React.createElement("p", { className: "dshdr-panel-note" }, expectedRestartLine(action)),
							React.createElement("div", { className: "dshdr-panel-actions" }, button, StatusRetry(action), RefreshButton(action), WaitButton(action)),
							action.message !== "" && React.createElement("p", {
								className: "dshdr-panel-note",
								"aria-live": "off",
							}, action.phase === "warn" ? warnConfirmLineOf(action) : action.message))),
					RiskDialog(action));
			}

			function SettingsDiagnostics() { return DiagnosticNotices(useRestart(timer, false)); }

			function CountdownRow() {
				const [supported, setSupported] = React.useState(false);
				const [saved, setSaved] = React.useState(0);
				const [draft, setDraft] = React.useState("0");
				const [busy, setBusy] = React.useState(true);
				const [error, setError] = React.useState("");
				React.useEffect(() => {
					let mounted = true;
					fetchStatus().then((status) => {
						if (!mounted) return;
						if (status.statusAvailable && Number.isInteger(status.countdownSeconds)) {
							setSupported(true);
							setSaved(status.countdownSeconds);
							setDraft(String(status.countdownSeconds));
						} else setError(status.statusAvailable ? t("hostTooOld") : status.statusError || t("statusUnavailable"));
						setBusy(false);
					});
					return () => { mounted = false; };
				}, []);
				const save = async () => {
					if (!supported) return;
					setBusy(true);
					try {
						const body = await savePreference("countdown=" + encodeURIComponent(draft));
						if (body.reconciled) {
							const current = body.status.statusAvailable && body.status.countdownSeconds;
							if (Number.isInteger(current)) { setSaved(current); setDraft(String(current)); }
							setError(body.error);
							return;
						}
						if (!Number.isInteger(body.countdownSeconds)) { setSupported(false); throw new Error(t("hostTooOld")); }
						setSaved(body.countdownSeconds);
						setDraft(String(body.countdownSeconds));
						setError("");
					} catch (cause) {
						setDraft(String(saved));
						setError(cause?.message === t("hostTooOld") ? t("hostTooOld") : t("localSaveFailed") + String(cause?.message ?? cause));
					} finally { setBusy(false); }
				};
				return React.createElement("div", { className: "dshdr-set-row" },
					React.createElement("label", null, t("countdownSetting"),
						React.createElement("input", { className:"dshdr-number", type: "number", min: 0, max: 60, step: 1, value: draft, disabled: busy || !supported, "aria-label": t("countdownSetting"), onChange: (event) => setDraft(event.target.value) })),
					React.createElement(OfficialButton ?? "button", {type:"button",variant:"ghost",className:OfficialButton ? undefined : "dshdr-btn","data-variant":"ghost",disabled:busy || !supported,onClick:save}, t("saveCountdown")),
					error ? React.createElement("span", { role: "alert" }, error) : null);
			}

			/**
			 * 「隐藏账号菜单里的『意见反馈』」那一行。
			 *
			 * 藏的是一个**内置界面元素**，所以这里什么都不用问宿主：纯客户端行为，
			 * 开关也存本机。默认关闭；用户明确开启才隐藏。
			 * @returns {object} React 元素。
			 */
			/**
			 * 「强制重启确认有效时间」设置行（2026-10-29）：与倒计时并列。
			 * 照抄 CountdownRow 的读写/回滚/hostTooOld 模式；宿主字段
			 * warnExpireSeconds（老宿主 undefined → 禁用保存，store 退默认 15）。
			 * @returns {object} React 元素。
			 */
			function WarnExpireRow() {
				const [supported, setSupported] = React.useState(false);
				const [saved, setSaved] = React.useState(15);
				const [draft, setDraft] = React.useState("15");
				const [busy, setBusy] = React.useState(true);
				const [error, setError] = React.useState("");
				React.useEffect(() => {
					let mounted = true;
					fetchStatus().then((status) => {
						if (!mounted) return;
						if (status.statusAvailable && Number.isInteger(status.warnExpireSeconds)) {
							setSupported(true);
							setSaved(status.warnExpireSeconds);
							setDraft(String(status.warnExpireSeconds));
						} else setError(status.statusAvailable ? t("hostTooOld") : status.statusError || t("statusUnavailable"));
						setBusy(false);
					});
					return () => { mounted = false; };
				}, []);
				const save = async () => {
					if (!supported) return;
					setBusy(true);
					try {
						const body = await savePreference("warnExpire=" + encodeURIComponent(draft));
						if (body.reconciled) {
							const current = body.status.statusAvailable && body.status.warnExpireSeconds;
							if (Number.isInteger(current)) { setSaved(current); setDraft(String(current)); }
							setError(body.error);
							return;
						}
						if (!Number.isInteger(body.warnExpireSeconds)) { setSupported(false); throw new Error(t("hostTooOld")); }
						setSaved(body.warnExpireSeconds);
						setDraft(String(body.warnExpireSeconds));
						setError("");
					} catch (cause) {
						setDraft(String(saved));
						setError(cause?.message === t("hostTooOld") ? t("hostTooOld") : t("localSaveFailed") + String(cause?.message ?? cause));
					} finally { setBusy(false); }
				};
				return React.createElement("div", { className: "dshdr-set-row" },
					React.createElement("label", null, t("warnExpireSetting"),
						React.createElement("input", { className:"dshdr-number", type: "number", min: 5, max: 60, step: 1, value: draft, disabled: busy || !supported, "aria-label": t("warnExpireSetting"), onChange: (event) => setDraft(event.target.value) })),
					React.createElement(OfficialButton ?? "button", {type:"button",variant:"ghost",className:OfficialButton ? undefined : "dshdr-btn","data-variant":"ghost",disabled:busy || !supported,onClick:save}, t("saveWarnExpire")),
					error ? React.createElement("span", { role: "alert" }, error) : null);
			}

			function AuthCookieWarning({ health }) {
				return health?.warn === true && health.last?.sample?.estimatedBytes >= health.limitBytes * 0.8
					? React.createElement("p", { role: "alert", className: "dshdr-hint", "data-tone": "warn" }, t("cookieWarning")) : null;
			}

			function AuthCookieHealth() {
				const [health, setHealth] = React.useState(null);
				const [busy, setBusy] = React.useState(true);
				const [error, setError] = React.useState("");
				React.useEffect(() => {
					let mounted = true;
					fetchStatus().then(status => {
						if (!mounted) return;
						setHealth(status.authCookie ?? null);
						if (!status.authCookie) setError(status.statusAvailable ? t("cookieUnsupported") : status.statusError || t("statusUnavailable"));
						setBusy(false);
					});
					return () => { mounted = false; };
				}, []);
				const save = async (key, value) => {
					setBusy(true);
					try {
						const body = await savePreference(key + "=" + value);
						if (body.reconciled) {
							if (body.status.statusAvailable && body.status.authCookie) setHealth(body.status.authCookie);
							setError(body.error);
							return;
						}
						if (!body.authCookie) throw new Error(t("cookieUnsupported"));
						setHealth(body.authCookie); setError("");
						restartStore.getSnapshot(null).refresh();
					} catch (cause) { setError(t("localSaveFailed") + String(cause?.message ?? cause)); }
					finally { setBusy(false); }
				};
				const sample = health?.last?.sample;
				const status = health?.last?.status;
				const statusKey = status === "normal" ? "cookieNormal" : status === "near" ? "cookieNear" : status === "exceeded" ? "cookieExceeded" : "cookieUnavailable";
				const reason = health?.last?.reason;
				const reasonKey = reason === "check-timeout" ? "cookieReasonTimeout" : reason === "sqlite-unavailable" ? "cookieReasonSqlite" : reason === "old-instance-running" ? "cookieReasonRunning" : reason === "database-unavailable" || reason === "database-missing" ? "cookieReasonDatabase" : reason === "backup-failed" || reason === "backup-retention-failed" ? "cookieReasonBackup" : "cookieReasonOther";
				const ratio = sample ? (sample.estimatedBytes / health.limitBytes * 100).toFixed(1) : null;
				return React.createElement("details", {className:"dshdr-health-fold",open:status === "exceeded" ? true : undefined},
					React.createElement("summary", null, t("cookieTitle"), React.createElement("span", {className:"dshdr-health-summary"},
						sample ? t(statusKey) + " · " + (sample.estimatedBytes / 1024).toFixed(2) + " / 16 KiB" : t("cookieNoSample"))),
                    status === "exceeded" ? React.createElement("p", {role:"alert"}, t("cookieManual")) : null,
					React.createElement("div", {className:"dshdr-set-row dshdr-health"},
					React.createElement("div", {className:"dshdr-set-text"},
						React.createElement("h3", {className:"dshdr-set-subtitle"}, t("cookieTitle")),
						React.createElement("p", null, t("cookieSnapshot") + ": " + t(statusKey)),
						React.createElement("p", null, t("cookieUsed") + ": " + (sample ? (sample.estimatedBytes / 1024).toFixed(2) + " KiB (" + ratio + "%)" : t("cookieNoSample"))),
						React.createElement("p", null, t("cookieLimit") + ": 16 KiB (16384 bytes)"),
						sample ? React.createElement("progress", {max:health.limitBytes,value:Math.min(sample.estimatedBytes,health.limitBytes),"aria-label":t("cookieUsed")}) : null,
						React.createElement("p", null, t("cookieCount") + ": " + (sample ? String(sample.authCount) : t("cookieUnavailable"))),
						React.createElement("p", null, t("cookieChecked") + ": " + (localDateTimeOf(health?.last?.checkedAt) || t("cookieNever"))),
						sample && sample.checkedAt !== health?.last?.checkedAt ? React.createElement("p", null, t("cookieSnapshot") + ": " + (localDateTimeOf(sample.checkedAt) || t("cookieNever"))) : null,
						React.createElement("p", {className:"dshdr-set-hint"}, t("cookieLocked")),
						React.createElement("p", {className:"dshdr-set-hint"}, t("cookieEstimate")),
						status === "unavailable" ? React.createElement("p", {role:"status"}, t("cookieError") + t(reasonKey) + " (" + String(health.last.errorCode) + ")") : null,
						OfficialSwitch ? React.createElement(OfficialSwitch,{checked:health?.backup === true,disabled:busy || !health,label:t("cookieBackup"),onChange:value=>save("authCookieBackup",value ? "1" : "0")}) : React.createElement("label", null, React.createElement("input", {type:"checkbox",checked:health?.backup === true,disabled:busy || !health,"aria-label":t("cookieBackup"),onChange:event => save("authCookieBackup",event.target.checked ? "1" : "0")}),t("cookieBackup")),
						React.createElement("p", {className:"dshdr-set-hint"}, t("cookieRisk")),
						React.createElement("p", {className:"dshdr-set-hint"}, t("cookieBenefit")),
						OfficialSwitch ? React.createElement(OfficialSwitch,{checked:health?.warn !== false,disabled:busy || !health,label:t("cookieWarn"),onChange:value=>save("authCookieWarn",value ? "1" : "0")}) : React.createElement("label", null, React.createElement("input", {type:"checkbox",checked:health?.warn !== false,disabled:busy || !health,"aria-label":t("cookieWarn"),onChange:event => save("authCookieWarn",event.target.checked ? "1" : "0")}),t("cookieWarn")),
						React.createElement(OfficialButton ?? "button", {type:"button",variant:"ghost",className:OfficialButton ? undefined : "dshdr-btn","data-variant":"ghost",disabled:busy || !health,onClick:()=>save("checkAuthCookie","1")},t("cookieRecheck")),
						health?.checkPending ? React.createElement("p", {role:"status"}, t("cookiePending")) : null,
						React.createElement(AuthCookieWarning, {health}),
						error ? React.createElement("p", {role:"alert"}, error) : null)));
			}

			function HideContactRow() {
				const countPair = React.useState(0);
				const bump = countPair[1];
				const [saveError, setSaveError] = React.useState("");
				const on = hideContactOn === true;
				/**
				 * 拨一下开关：官方 Switch 给布尔值，万一将来给别的形状，就按「切换」理解。
				 * @param {unknown} next - 座位传来的新值。
				 */
				const toggle = (next) => {
					const result = setHideContact(typeof next === "boolean" ? next : !on);
					setSaveError(result.ok ? "" : t("localSaveFailed") + result.error);
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
							on ? t("hideContactOn") : t("hideContactOff")),
						saveError !== "" ? React.createElement("span", { className: "dshdr-set-hint", role: "alert" }, saveError) : null),
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
				const readErrorPair = React.useState("");
				const readError = readErrorPair[0];
				const setReadError = readErrorPair[1];
				const retryQueryPair = React.useState(null);
				const retryQuery = retryQueryPair[0];
				const setRetryQuery = retryQueryPair[1];

				React.useEffect(() => {
					let live = true;
					fetchStatus().then((status) => {
						if (!live) return;
						if (status.statusAvailable === true && status.sweep !== undefined) {
							setSweep(status.sweep);
							setReadError("");
						} else setReadError(status.statusError || t("sweepUnknown"));
					});
					return () => { live = false; };
				}, []);

				/** 把宿主给的时间戳写成 HH:MM:SS；读不出来就回空串。 */
				const clockOf = (iso) => {
					const time = localDateTimeOf(iso, false);
					return time ? " " + time : "";
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
					const errorCode = typeof result.error === "string" ? result.error
						: (typeof result.error?.code === "string" ? result.error.code : "scan-failed");
					const prefiltered = Number(result.prefiltered || 0);
					const prefilteredText = prefiltered > 0 ? t("sweepPrefiltered", { n: prefiltered }) : "";
					const partialSummary = t("sweepPartialSummary", {
						scanned: Number(result.scanned || 0),
						count: Number(result.candidateCount || 0),
						mb: (Number(result.candidateBytes || 0) / 1048576).toFixed(1),
					});
					if (result.error) return head + t("sweepErrorShort", { code: errorCode })
						+ (result.partial === true ? " " + t("sweepPartialShort") + " " + partialSummary : "")
						+ prefilteredText;
					if (result.partial === true) return head + t("sweepPartialShort") + " " + partialSummary + prefilteredText;
					const tail = ".";
					if (Number(result.candidateCount || 0) > 0 || Number(result.skippedCount || 0) > 0) {
						const reason = result.skipReason === "owner-unknown" ? t("sweepSkippedOwner")
							: (result.skipReason === "active-hosts" ? t("sweepSkippedActive") : t("sweepSkippedOther"));
						return head + t("sweepPreview", {
							scanned: Number(result.scanned || 0),
							count: Number(result.candidateCount || 0),
							mb: (Number(result.candidateBytes || 0) / 1048576).toFixed(1),
						}) + " " + reason + tail;
					}

					return head + t("sweepDoneNone", { scanned: result.scanned ?? 0 }) + tail;
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
					fetch((query === "?cancelSweep=1" ? PREFS_ROUTE : SWEEP_ROUTE) + query, { method: "POST" })
						.then(async (response) => ({ response: response, body: await response.json().catch(() => null) }))
						.then(({ response, body }) => {
							if (response.ok && body && body.ok === true) {
								const next = body.last ?? null;
								setSweep({ enabled: body.enabled === true, last: next });
								setRetryQuery(null);
								setReadError("");
								// 手动清一次必须留下看得见的痕迹，哪怕结果和上次完全相同
								// —— 清理绝大多数时候就是「扫描 6 个、删掉 0 个」。
								if (manual === true) {
									setResult(next === null
										? { tone: "ok", text: t("sweepJustNowDone") }
										: { tone: toneOf(next), text: describe(next, "sweepJustNow") });
								}
							} else {
							const error = String((body && body.error) || ("HTTP " + response.status));
							setRetryQuery(query);
							if (manual === true) setResult({ tone: "error", text: t("sweepRecovery", { error: error }) });
							else setReadError(t("sweepRecovery", { error: error }));
							}
						}, (error) => {
							setRetryQuery(query);
							const message = String((error && error.message) || error);
							if (manual === true) setResult({ tone: "error", text: t("sweepRecovery", { error: message }) });
							else setReadError(t("sweepRecovery", { error: message }));
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
				const recoveryButton = (label, handler) => OfficialButton !== null
					? React.createElement(OfficialButton, { variant: "ghost", onClick: handler, "aria-label": label }, label)
					: React.createElement("button", { type: "button", className: "dshdr-btn", "data-variant": "ghost", onClick: handler, "aria-label": label }, label);
				const recovery = retryQuery !== null
					? recoveryButton(t("sweepRetryWrite"), () => call(retryQuery, retryQuery === "?run=1"))
					: (readError !== ""
					? recoveryButton(t("sweepRetryRead"), () => {
						setReadError("");
						fetchStatus().then((status) => {
							if (status.statusAvailable === true && status.sweep !== undefined) {
								setSweep(status.sweep);
								setReadError("");
							} else setReadError(status.statusError || t("sweepUnknown"));
						});
					}) : null);
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
						readError !== "" && React.createElement("span", { className: "dshdr-set-hint", "data-tone": "error", "aria-live": "polite" }, readError),
						React.createElement("span", { className: "dshdr-set-hint" }, hint),
						React.createElement("span", { className: "dshdr-set-hint" }, detail)),
					React.createElement("span", { className: "dshdr-set-actions" }, runButton, (busy || sweep?.running) ? recoveryButton(t("sweepCancel"), () => call("?cancelSweep=1", true)) : null, recovery, control));
			}

			/**
			 * 插件自己的设置分区（`settings.section`，官方给插件留的座位）：
			 * 上面是四个客户端入口的开关（改完**立即生效**，选择存在本机浏览器）；
			 * 下面把两件**与重启无关**的顺手功能归进同一个「附带功能」分类。
			 * @returns {object} React 元素。
			 */
			function SettingsTitleAction() {
				const action = useRestart(timer);
				const hintId = useHintId();
				const described = ariaDescriptionOf(action);
				return React.createElement(React.Fragment, null,
					React.createElement("button", {
						type:"button", className:"dshdr-btn" + mainDangerClass(action),
						"data-variant":"outline", "data-settings-restart":"1",
						"data-busy":action.phase === "restarting" ? "1" : "0",
						disabled:isDisabled(action), title:tooltipOf(action),
						"aria-label":ariaLabelOf(action), "aria-describedby":described ? hintId : undefined,
						onClick:action.press, onMouseEnter:action.refresh, onFocus:action.refresh,
					}, Glyph(14), labelOf(action)),
					described && React.createElement("span", {id:hintId,className:"dshdr-sr-only"}, described),
					RiskDialog(action));
			}

			function SettingsSection() {
				const bumpPair = React.useState(0);
				const bump = bumpPair[1];
				const [saveErrors, setSaveErrors] = React.useState({});
				const rows = ENTRY_KEYS.map((key) => {
					const copy = ENTRY_LABELS[key];
					const checked = switches[key] === true;
					const toggle = (next) => {
						const result = writeStoredEntry(key, next);
						if (result.ok) {
							switches[key] = next === true;
							stored[key] = switches[key];
							applyEntries();
						}
						setSaveErrors((previous) => Object.assign({}, previous, { [key]: result.ok ? "" : t("localSaveFailed") + result.error }));
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
							React.createElement("span", { className: "dshdr-set-hint" }, t(copy[1])),
							saveErrors[key] ? React.createElement("span", { className: "dshdr-set-hint", role: "alert" }, saveErrors[key]) : null),
						control);
				});
				return React.createElement("div", { className: "dshdr-set-page" },
					React.createElement("div", {className:"dshdr-set-heading"},
						React.createElement("h2", { className: "dshdr-set-title" }, t("setTitle")),
						React.createElement(SettingsTitleAction)),
					React.createElement("p", { className: "dshdr-set-desc" }, t("setDesc")),
					React.createElement("h3", {className:"dshdr-set-subtitle"}, t("entriesGroup")),
					...rows,
					React.createElement(SettingsDiagnostics),
					React.createElement("h3", {className:"dshdr-set-subtitle"}, t("behaviorGroup")),
					React.createElement(CountdownRow),
					React.createElement(WarnExpireRow),
					React.createElement("h3", { className: "dshdr-set-subtitle" }, t("extrasSubtitle")),
					React.createElement(AuthCookieHealth),
					React.createElement(SweepRow),
					React.createElement(HideContactRow));
			}

			/** Best effort DOM boundary: never modify a host node or its handlers.
			 * Only a click on the verified account launcher arms a short-lived
			 * discovery observer (body childList, non-recursive, max 500ms).
			 * 2026-10-30 flicker fix: the menu item is injected synchronously in the
			 * MutationObserver callback that fires when the host adds the menu to
			 * body — React commits DOM synchronously and MO callbacks run before
			 * paint, so the user never sees a frame without our item (the old
			 * setTimeout(0)+two-frame stabilization injected after first paint,
			 * pushing official items down one row — the reported flicker).
			 * No polling, no network, no observer while the menu is closed.
			 */
			let menuTraceEnabled = false;
			let menuTraceSequence = 0;
			function startAccountMenu() {
				if (typeof document === "undefined" || typeof document.addEventListener !== "function" || typeof MutationObserver !== "function" || typeof window.requestAnimationFrame !== "function" || typeof window.cancelAnimationFrame !== "function") { return () => {}; }
				const triggerSelector = 'button[aria-haspopup="menu"][data-signed-out][data-collapsed]';
				const menuSelector = '[role="menu"][data-menu-material]';
				const marker = "data-dshdr-account-inject";
				const DISCOVERY_WINDOW_MS = 500;
				let discovery = null;      // {observer, timeout} while waiting for the menu
				let frame = null;
				let cleanupOpen = () => {};
				let active = null;
                let traceSession = null;
                const traceEvent = (type, outcome) => {
                    if (traceSession === null) return;
                    const trigger = traceSession.trigger;
                    const menus = document.querySelectorAll(menuSelector);
                    const menu = menus.length === 1 ? menus[0] : null;
                    const item = menu?.querySelector('button[role="menuitem"]');
                    const viewport = menu ? viewportOf(menu) : null;
                    traceSession.events.push({at:Date.now(),type,outcome,
                        expanded:trigger.getAttribute("aria-expanded"),connected:trigger.isConnected,menus:menus.length,
                        menuitem:!!item,viewport:!!viewport && item?.closest('[role="presentation"]') === viewport,
                        bodyDeliveries:traceSession.bodyDeliveries,bodyRecords:traceSession.bodyRecords,
                        injected:active?.button.isConnected === true,first:active?.viewport.firstElementChild === active?.button && active !== null,
                        visibility:active?.button.style.visibility ?? null});
                    if (traceSession.events.length > 80) traceSession.events.pop();
                };
                const traceEnd = (endReason) => {
                    if (traceSession === null) return;
                    traceEvent("end",endReason);
                    const session = traceSession;
                    traceSession = null;
                    // Upload only after observation ends; never block probing or painting.
                    const send = async () => {
                        let chunk = [];
                        const payload = events => JSON.stringify({id:session.id,startedAt:session.startedAt,endReason,events});
                        const upload = async events => {
                            const {response} = await fetchJSON(PREFS_ROUTE + "?menuTrace=" + encodeURIComponent(payload(events)),{method:"POST",credentials:"same-origin"});
                            if (!response.ok) throw new Error("menu-trace-upload-failed");
                        };
                        for (const event of session.events) {
                            if (chunk.length && encodeURIComponent(payload([...chunk,event])).length > 1750) { await upload(chunk);chunk=[]; }
                            chunk.push(event);
                        }
                        if (chunk.length) await upload(chunk);
                    };
                    send().catch(() => { console.warn("menu trace upload failed; capture is incomplete"); });
                };
                const traceStart = trigger => {
                    if (!menuTraceEnabled) return;
                    traceEnd("next-click");
                    const startedAt=Date.now();
                    traceSession={id:String(startedAt)+"-"+String(++menuTraceSequence),startedAt,trigger,bodyDeliveries:0,bodyRecords:0,events:[]};
                    traceEvent("click","received");
                };
				// The first presentation child is the item viewport. Decorative material
				// layers may precede it; a later presentation child is an optional footer.
				const viewportOf = menu => Array.from(menu.children).find(child => child.getAttribute("role") === "presentation") ?? null;
				const cancelFrame = () => {
					if (frame !== null) window.cancelAnimationFrame(frame);
					frame = null;
				};
				const nextFrame = (run) => {
					cancelFrame();
					frame = window.requestAnimationFrame(() => { frame = null; run() });
				};
				const stopDiscovery = (reason = "rearmed") => {
					if (discovery === null) return;
                    traceEvent("discovery-stop",reason);
                    if (reason !== "injected" && reason !== "rearmed") traceEnd(reason);
					discovery.observer.disconnect();
					if (discovery.timeout !== null) window.clearTimeout(discovery.timeout);
					discovery = null;
				};
				function probe(trigger, attempt = 0) {
                    traceEvent("probe","begin");
					if (active?.trigger === trigger && active.button.isConnected
						&& active.viewport.firstElementChild === active.button && trigger.getAttribute("aria-expanded") === "true") { traceEvent("probe","already-active"); return; }
					cleanupOpen();
					cleanupOpen = () => {};
					let button = null;
					let observer = null;
					let unsubscribe = null;
					const cleanup = () => {
						cancelFrame();
						observer?.disconnect();
						unsubscribe?.();
						unsubscribe = null;
						button?.remove();
						if (active?.button === button) active = null;
					};
					try {
						if (!trigger.isConnected || trigger.getAttribute("aria-expanded") !== "true") { traceEvent("probe","trigger-not-open"); return; }
						if (document.querySelectorAll(triggerSelector).length !== 1) { traceEvent("probe","trigger-count"); return; }
						const menus = document.querySelectorAll(menuSelector);
						if (menus.length !== 1) { traceEvent("probe","menu-count"); return; }
						const menu = menus[0];
						// The current host portals the surface directly to body. A changed
						// portal layout is an unsupported structure, not a discovery task.
						if (menu.parentElement !== document.body) { traceEvent("probe","portal-parent"); return; }
						const seed = menu.querySelector('button[role="menuitem"]');
						if (!seed || menu.querySelector("[" + marker + "]")) { traceEvent("probe","menuitem-or-duplicate"); return; }
						const viewport = viewportOf(menu);
						if (!viewport || seed.closest('[role="presentation"]') !== viewport || viewport.parentElement !== menu) { traceEvent("probe","viewport-mismatch"); return; }
						button = document.createElement("button");
						button.type = "button";
						button.style.visibility = "hidden";
						button.setAttribute("role", "menuitem");
						button.setAttribute(marker, "1");
						// Reuse the ordinary Settings item's class so host sizing and hover
						// stay authoritative; never clone its id, children, or event handlers.
						const baseClass = seed.className;
						button.className = baseClass;
						const icon = document.createElement("span");
						icon.setAttribute("aria-hidden", "true");
						// Same fallback refresh glyph as Glyph(), with the host icon wrapper.
						const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
						for (const [name, value] of Object.entries({width:"16",height:"16",viewBox:"0 0 16 16",fill:"none",stroke:"currentColor","stroke-width":"1.2","stroke-linecap":"round"})) svg.setAttribute(name, value);
						for (const d of REFRESH_PATHS) {
							const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
							path.setAttribute("d", d); svg.appendChild(path);
						}
						icon.appendChild(svg);
						const label = document.createElement("span");
						button.appendChild(icon); button.appendChild(label);
						const viewId = restartStore.newViewId();
						const render = () => {
							const action = restartStore.getSnapshot(viewId);
							label.textContent = action.phase === "idle" && !action.waiting && !action.opBusy ? t("accountRestart") : labelOf(action);
							button.disabled = isDisabled(action);
							button.className = baseClass;
							button.style.color = action.phase === "warn" ? "var(--dsw-alias-state-error-primary,#ec1313)" : "";
							button.setAttribute("data-phase", action.phase);
							button.title = warnConfirmLineOf(action) || tooltipOf(action);
						};
						button.addEventListener("click", (event) => {
							event.stopPropagation();
							restartStore.getSnapshot(viewId).press();
						});
						restartStore.bindTimer(timer);
						render();
						unsubscribe = restartStore.subscribe(render, viewId, false);
						// Anchor to the container, independently of any particular official item.
						viewport.insertBefore(button, viewport.firstElementChild);
						active = {trigger, viewport, button};
                        traceEvent("probe","injected");
						const retry = () => {
							button.style.visibility = "hidden";
                            traceEvent("position","retry");
							cleanup();
							// 与旧实现同语义：锚点被破坏只重试一次（第二次失败彻底放弃，
							// 不无限循环）。
							if (attempt === 0) probe(trigger, 1);
						};
						observer = new MutationObserver(() => {
							if (!trigger.isConnected || trigger.getAttribute("aria-expanded") !== "true") { cleanup(); return }
							if (!menu.isConnected || !viewport.isConnected || viewportOf(menu) !== viewport
								|| viewport.firstElementChild !== button) retry();
						});
						observer.observe(document.body, { childList: true });
						observer.observe(menu, { childList: true, subtree: true });
						observer.observe(trigger, { attributes: true, attributeFilter: ["aria-expanded"] });
						cleanupOpen = cleanup;
						nextFrame(() => {
							if (!menu.isConnected || trigger.getAttribute("aria-expanded") !== "true") { cleanup(); return }
							if (viewportOf(menu) !== viewport || viewport.firstElementChild !== button) { retry(); return }
							button.style.visibility = "visible";
                            traceEvent("position","visible");traceEnd("visible");
						});
					} catch {
                        traceEvent("probe","dom-operation-failed");
						// DOM/observer APIs are an optional host boundary. Roll back only
						// our own node/subscription; leave the original menu untouched.
						cleanup();
					}
				}
				const armDiscovery = (trigger) => {
					stopDiscovery();
                    // Bound discovery for commits that occur after the document click.
                    // The click path also probes immediately: real rc.5 traces show the
                    // menu may already be committed, with no later body mutation at all.
					const observer = new MutationObserver((records) => {
                        if (traceSession !== null) { traceSession.bodyDeliveries++;traceSession.bodyRecords+=records.filter(record=>record.target===document.body).length; }
                        traceEvent("body","delivery");
						if (!trigger.isConnected || trigger.getAttribute("aria-expanded") !== "true") { stopDiscovery("trigger-not-open"); return; }
						// probe returns without side effects until the real menu
						// (with items and a valid viewport) is in place; on success
						// active is set — tear the discovery observer down then.
						probe(trigger);
						if (active !== null && active.trigger === trigger) stopDiscovery("injected");
					});
					try {
						observer.observe(document.body, { childList: true });
					} catch {
						observer.disconnect();
						return;
					}
					const timeout = window.setTimeout(() => { stopDiscovery("timeout"); }, DISCOVERY_WINDOW_MS);
					discovery = { observer, timeout };
				};
				const onClick = (event) => {
					const trigger = event.target.closest?.(triggerSelector);
					if (!trigger) return;
                    traceStart(trigger);
					if (active?.trigger === trigger && active.button.isConnected
						&& active.viewport.firstElementChild === active.button && trigger.getAttribute("aria-expanded") === "true") { traceEnd("already-active"); return; }
					// 2026-10-30 flicker fix: arm a discovery observer on body right away.
					// The host portals the menu into body when it opens; the MO callback
					// runs before paint, so probe() injects synchronously in the same
					// commit — no setTimeout(0), no multi-frame stabilization.
					armDiscovery(trigger);
                    probe(trigger);
                    if (active !== null && active.trigger === trigger) stopDiscovery("injected");
				};
				document.addEventListener("click", onClick);
				// A menu may already be open when the plugin (re)loads.
				const openTrigger = document.querySelector(triggerSelector + '[aria-expanded="true"]');
				if (openTrigger) {
					if (document.querySelectorAll(menuSelector).length === 1) probe(openTrigger);
					else armDiscovery(openTrigger);
				}
				return () => {
					document.removeEventListener("click", onClick);
					stopDiscovery();
					cancelFrame();
					cleanupOpen();
                    traceEnd("disposed");
				};
			}

			// ── §10.3 入口注册（开关 → 座位）与清理 ────────────────────────────
			/**
			 * 客户端入口的当前开关：宿主 config 给的默认值 + 本机保存的覆盖。
			 * 拿不到宿主默认值时先按 true 起，等 `/api/status` 回来再对齐。
			 */
			const defaults = { panel: true, footer: true, header: true, settingsRow: true, accountMenu: true, headerRefresh: false };
			const stored = readStoredEntries();
			const switches = Object.assign({}, defaults, stored);
			let disposers = [];
			let accountMenuCleanup = () => {};

			/** 撤掉已经注册的入口。 */
			function clearEntries() {
				accountMenuCleanup();
				accountMenuCleanup = () => {};
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
				if (switches.accountMenu) accountMenuCleanup = startAccountMenu();
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

			let entriesDisposed = false;
			applyEntries();
			// Discard the independent initial status response after plugin disposal.
			ctx.effect(() => () => { entriesDisposed = true; clearEntries(); });

			// 按用户保存的开关隐藏账号菜单反馈项（新用户默认关闭）。
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
				if (entriesDisposed) return;
                menuTraceEnabled = status.menuTraceEnabled === true;
                if (status.entries === undefined) return;
				let changed = false;
				for (const key of ENTRY_KEYS) {
					if (Object.prototype.hasOwnProperty.call(stored, key)) continue;
					if (typeof status.entries[key] !== "boolean") continue;
					if (switches[key] !== status.entries[key]) {
						switches[key] = status.entries[key];
						changed = true;
					}
				}
				if (changed) applyEntries();
			}, () => {});
		}

		// ── §11 导出（plain-Cordis 插件对象） ────────────────────────────────
		module.exports = { name: ID, inject: ["slots", "locale"], apply };
		return module.exports;
	}
});
