/**
 * Client half of dsh-desktop-restart.
 *
 * 提供两个入口，都走宿主半同一条受守卫的重启路径：
 *
 * 1. **会话标题栏按钮**（`conversation.session.header.actions`）—— 常驻可见，
 *    抬头就能按；
 * 2. **设置 → 通用 那一行** —— 留作备用入口。
 *
 * 另外宿主半还注册了 `/restart-desktop` 斜杠命令，在输入框里直接打字即可。
 *
 * 和「重启 dsh web」那类插件不同，这里要重启的是 Electron 应用本身，因为
 * 桌面版里 host 只是主进程的一个子进程 —— host 自己退出只会换来一个
 * 「启动失败」恢复框，而主进程没有给插件留任何重启通道。宿主半因此把交接
 * 交给一个分离的 helper（见 lib/helper.cjs）。
 *
 * ## 三次点击才打断正在跑的活（2026-10-08）
 *
 * 守卫的判据在宿主半（那里才看得到 agents / jobs 与安装记录），客户端只负责
 * 把话说清楚，因此顺序是：
 *
 *   idle --点击--> confirm --点击--> 宿主半判定
 *                                     ├─ 没有东西在跑 → 排程重启
 *                                     └─ 有 → warn（写清会打断什么）
 *                                            warn --等 0.9 秒--点击--> 真的重启
 *
 * 那 0.9 秒不是装饰：没有它，一次连点就能把「警告」连点过去，守卫等于没有。
 *
 * 本文件是包里的 `./client` bundle，格式与所有 web 插件一致：交给
 * `window.__ModuleLoader__` 的工厂形式，无 import，`require("react")` 由
 * 打包器提供，导出 plain-Cordis 插件 `{ name, inject, apply }`。
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

		/** 本包自己的两条宿主路由。 */
		const RESTART_ROUTE = "/dsh-desktop-restart/api/restart";
		const STATUS_ROUTE = "/dsh-desktop-restart/api/status";
		/** 第一次点击「武装」按钮的有效期。 */
		const CONFIRM_MS = 5000;
		/**
		 * 警告态的最小冷却：连点不能把「有任务在跑」这句话点过去。
		 * 宿主半只认 `?force=1`，而 force 只在警告态被点出来，所以这里挡的是
		 * 「双击 = 忽略警告」。 */
		const WARN_ARM_MS = 900;
		/** 会话标题栏的加性座位。 */
		const HEADER_SLOT = "conversation.session.header.actions";
		/** 通用设置页里加性一行的座位。 */
		const SETTINGS_SLOT = "settings.general.item";
		/** 本插件在这两个座位里的 key。 */
		const ID = "dsh-desktop-restart";

		const FOCUS_RING = { outline: "2px solid var(--dsw-alias-interactive-bg-hover-accent, rgba(77,107,254,.75))", outlineOffset: "-1px" };

		/** 通用设置区自带的行的配方（对齐 Language / Permission 这类内置行）。 */
		const S = {
			row: { display: "flex", alignItems: "center", gap: "8px", padding: "16px 0", borderBottom: ".5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))" },
			text: { display: "flex", flexDirection: "column", flex: 1, gap: "4px", minWidth: 0, paddingRight: "48px" },
			label: { color: "var(--dsw-alias-label-primary, inherit)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" },
			hint: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			hintError: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-error-primary, #f85149)" },
			hintWarn: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-warning-primary, #d29922)" },
			hintOk: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-success-primary, #3fb950)" },
			btn: { display: "inline-flex", alignItems: "center", gap: "12px", flex: "none", boxSizing: "border-box", height: "36px", padding: "0 14px", border: "none", borderRadius: "18px", background: "var(--dsw-alias-bg-module-platform, var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)))", color: "var(--dsw-alias-label-primary, inherit)", font: "inherit", fontSize: "14px", lineHeight: "22px", cursor: "pointer", transition: "background .12s ease, color .12s ease" },
			btnHover: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18))" },
			btnDanger: { color: "var(--dsw-alias-state-error-primary, #f85149)" },
			btnDangerHover: { background: "var(--dsw-alias-interactive-bg-hover-danger, rgba(248,81,73,.14))" },
			btnBusy: { opacity: .6, cursor: "default" },
			btnDisabled: { opacity: .45, cursor: "not-allowed" },
			// 标题栏是紧凑的横排，按钮因此做成小胶囊，不用设置页那种 36px 控件。
			headerBtn: { display: "inline-flex", alignItems: "center", gap: "5px", flex: "none", boxSizing: "border-box", height: "26px", padding: "0 9px", border: "none", borderRadius: "13px", background: "transparent", color: "var(--dsw-alias-label-secondary, inherit)", font: "inherit", fontSize: "12px", lineHeight: "18px", cursor: "pointer", whiteSpace: "nowrap", transition: "background .12s ease, color .12s ease" },
			headerBtnHover: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18))", color: "var(--dsw-alias-label-primary, inherit)" },
			headerBtnDanger: { background: "var(--dsw-alias-interactive-bg-hover-danger, rgba(248,81,73,.14))", color: "var(--dsw-alias-state-error-primary, #f85149)" },
		};

		/** 默认提示文案：说明这一行和「重启 dsh web」的区别。 */
		const DEFAULT_HINT = "重启整个 DeepSeek Harness（桌面应用与它的 host 进程）。改插件或配置后需要重启才生效时用这个。";

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
					return { desktop: body.desktop === true, guardHint: reasons.join("；") };
				}
				return { desktop: false, guardHint: "" };
			} catch {
				return { desktop: false, guardHint: "" };
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
					text: "已排程重启：宿主 pid " + String(body.hostPid) + "，主进程 pid " + String(body.mainPid) + "，交接 helper " + String(body.helperPid) + "。本页即将断开，稍后会自动回来。",
				};
			}
			if (body && body.guard && body.guard.active === true) {
				return { ok: false, guard: true, text: String(body.error || "现在有工作在跑") };
			}
			return { ok: false, text: String((body && body.error) || ("HTTP " + response.status)) };
		}

		/**
		 * 两个入口共用的重启动作。
		 * @param {object | undefined} timer - 客户端 timer 服务，用于让武装态与警告冷却过期。
		 * @returns {{ phase: string, message: string, desktop: boolean | null, guardHint: string, armed: boolean, press: Function }} 动作状态。
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
			 * 需要「过一会儿就撤销」的确认窗口。没有 timer 服务时干脆不撤销，
			 * 也就是 0.1.x 的行为：武装态一直有效。
			 */
			const expireLater = (fn, ms) => {
				if (hasTimer) timer.timeout(fn, ms);
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
						// 宿主半说了「有东西在跑」：把原因原样摆出来，并要求再点一次。
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
				if (phase === "restarting" || desktop === false) return;
				if (phase === "warn") {
					// 冷却期内点击直接忽略（按钮此时也是 disabled 的）。
					if (armed) send(true);
					return;
				}
				if (phase !== "confirm") {
					setPhase("confirm");
					expireLater(() => setPhase((current) => (current === "confirm" ? "idle" : current)), CONFIRM_MS);
					return;
				}
				send(false);
			};

			return { phase, message, desktop, guardHint, armed, press };
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
			 * 按钮文案：警告态与普通确认态要一眼能分开。
			 * @param {object} action - {@link useRestart} 的返回值。
			 * @returns {string} 文案。
			 */
			function labelOf(action) {
				if (action.phase === "restarting") return "重启中…";
				if (action.phase === "warn") return "仍要重启？";
				if (action.phase === "confirm") return "确认重启？";
				if (action.phase === "error") return "重试";
				return "重启";
			}

			/** 会话标题栏上的常驻按钮：抬头就能按。 */
			function HeaderRestartButton() {
				const action = useRestart(timer);
				const hoverPair = React.useState(false);
				const hovered = hoverPair[0];
				const setHovered = hoverPair[1];
				const focusPair = React.useState(false);
				const focused = focusPair[0];
				const setFocused = focusPair[1];

				const unavailable = action.desktop === false;
				const busy = action.phase === "restarting";
				const danger = action.phase === "confirm" || action.phase === "warn";
				const locked = action.phase === "warn" && action.armed === false;
				const style = Object.assign({}, S.headerBtn,
					danger ? S.headerBtnDanger : null,
					busy ? S.btnBusy : null,
					(unavailable || locked) ? S.btnDisabled : null,
					focused ? FOCUS_RING : null,
					(!busy && !unavailable && !danger && !locked && hovered) ? S.headerBtnHover : null);
				const label = labelOf(action);
				const title = action.message !== ""
					? action.message
					: (unavailable
						? "仅 Electron 桌面版可用"
						: (action.guardHint !== ""
							? action.guardHint + "；点两次仍可重启"
							: "重启整个 DeepSeek Harness 桌面应用"));

				return React.createElement("button", {
					type: "button",
					style: style,
					disabled: busy || unavailable || locked,
					title: title,
					onClick: action.press,
					onMouseEnter: () => setHovered(true),
					onMouseLeave: () => setHovered(false),
					onFocus: () => setFocused(true),
					onBlur: () => setFocused(false),
				}, React.createElement("span", { "aria-hidden": "true", style: { fontSize: "13px", lineHeight: 1 } }, "⟳"), label);
			}

			/** 设置页那一行：标题、说明和两步确认的重启按钮。 */
			function SettingsRestartRow() {
				const action = useRestart(timer);
				const hoverPair = React.useState(false);
				const hovered = hoverPair[0];
				const setHovered = hoverPair[1];
				const focusPair = React.useState(false);
				const focused = focusPair[0];
				const setFocused = focusPair[1];

				const unavailable = action.desktop === false;
				const busy = action.phase === "restarting";
				const danger = action.phase === "confirm" || action.phase === "warn";
				const locked = action.phase === "warn" && action.armed === false;
				const style = Object.assign({}, S.btn,
					danger ? S.btnDanger : null,
					busy ? S.btnBusy : null,
					(unavailable || locked) ? S.btnDisabled : null,
					focused ? FOCUS_RING : null,
					(!busy && !unavailable && !locked && hovered) ? (danger ? S.btnDangerHover : S.btnHover) : null);
				const hintStyle = action.phase === "error"
					? S.hintError
					: (action.phase === "warn" ? S.hintWarn : (action.phase === "done" ? S.hintOk : S.hint));
				const hint = busy
					? "正在交接重启…本页马上会断开。"
					: (action.message !== ""
						? (action.phase === "warn" ? action.message + " 再点一次「仍要重启？」才会执行。" : action.message)
						: (unavailable
							? "当前宿主不是 Electron 桌面版，这一行只在桌面应用里可用。"
							: (action.guardHint !== ""
								? action.guardHint + "；现在点两次仍可重启，但那会打断它们。"
								: DEFAULT_HINT)));

				return React.createElement("div", { style: S.row },
					React.createElement("div", { style: S.text },
						React.createElement("span", { style: S.label }, "重启桌面应用"),
						React.createElement("span", { style: hintStyle }, hint)),
					React.createElement("button", {
						type: "button",
						style: style,
						disabled: busy || unavailable || locked,
						title: unavailable ? "仅 Electron 桌面版可用" : "结束 Electron 主进程并拉起新的应用实例（仅同源 loopback 可用）",
						onClick: action.press,
						onMouseEnter: () => setHovered(true),
						onMouseLeave: () => setHovered(false),
						onFocus: () => setFocused(true),
						onBlur: () => setFocused(false),
					}, labelOf(action)));
			}

			// 会话标题栏：常驻可见的主入口。
			//
			// order 必须小于内置 jobs 插件那个「N 个后台任务」条目的 20：
			// 标题栏的动作组是左紧排的，排在后面的条目会被它前面新增的条目
			// 往右顶。若本按钮排在任务条目之后（order > 20），后台任务一跑
			// 起来按钮就被顶走一截（2026-10-06 实测右移 134px）。排在 20 之前，
			// 任务条目就出现在按钮右侧，按钮不动。
			ctx.effect(() => slots.inject(HEADER_SLOT, () => slots.register({
				name: HEADER_SLOT,
				id: ID,
				order: 15,
			}, HeaderRestartButton)));

			// 设置 → 通用：备用入口。
			ctx.effect(() => slots.inject(SETTINGS_SLOT, () => slots.register({
				name: SETTINGS_SLOT,
				id: ID,
				order: 91,
			}, SettingsRestartRow)));
		}

		module.exports = { name: ID, inject: ["slots"], apply };
		return module.exports;
	}
});
