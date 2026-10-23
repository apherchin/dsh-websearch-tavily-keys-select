/**
 * 配置卡片（浏览器半边）：侧栏 Plugins → bundle 包页上的那张表单。
 *
 * 注册进 `plugins.bundle.config`，键 = **bundle 包的包名**（宿主侧 `configured = ledger.bundles.has(pkg.name)`
 * 用的就是这个名字，写错一个字符整块不渲染；改包名时必须同步改这里的 `ENTRY_KEY`，
 * `test/verify-client.mjs` 有动态守卫）。当前正本包名是 `dsh-websearch-tavily-keys-select`，
 * 而本机 profile 里部署的是它的旧名 `dsh-web-search-chain` —— 两个名字由 `sync-to-profile.mjs`
 * 的 live 布局负责改写，**不要手改**。
 *
 * ⚠️ 三条硬约束：
 * 1. **只 require 基座**（react / react/jsx-runtime）。官方 practices 明文禁止 client 半边
 *    require 任何 Harness Client 包（无预告变更 / 纯 JS 无类型检查 / 抛错的组件会让整块
 *    slot entry 空白）⇒ checkbox/input/button/tag 全部自包含。
 * 2. **apply 绝不能抛错**：client entry 变 failed/pending 会撞渲染端「每条 client entry
 *    必须 active」的全有全无启动门禁 ⇒ 整机起不来。故 entry 级 inject 为空 + 嵌套注入
 *    slots + 每处 try/catch + 最外层兜底。
 * 3. 明文**只出现在 POST 请求体里**；读回来的一律是 `{configured, source, writable}` 状态。
 *    SecretId 例外：它不是机密（腾讯云的原话是"类比用户名"），明文存在配置文档里、界面可改；
 *    真正的机密 SecretKey 走环境变量或凭据域。
 */
window.__ModuleLoader__.load({
	id: "dsh-search-chain",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const { useEffect } = react;
		const { jsx, jsxs } = jsxRuntime;

		const CONFIG_PATH = "/api/web-search-chain.config";
		const SLOT = "plugins.bundle.config";
		const ENTRY_KEY = "dsh-websearch-tavily-keys-select";
		const MAX_SOURCES = 4;
		/** 每个源最多几个 key（服务端 MAX_KEYS 为权威，state.maxKeys 会覆盖）。 */
		const MAX_KEYS = 4;
		const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
		/** SecretId 的宽松校验（与 core.mjs 的 SECRET_ID_PATTERN 保持一致）。 */
		const SECRET_ID_PATTERN = /^\S{6,128}$/;

		//#region 文案（中文为准；只有语言明确是英文才切英文）
		const COPY = {
			zh: {
				title: "网页搜索链路",
				intro: (max) => `按顺序尝试，最多 ${max} 个源；全部失败或没有可用源时交给官方搜索兜底。`,
				loading: "正在读取配置…",
				loadFailed: "读取配置失败：",
				source: (n) => `搜索源 ${n}`,
				template: "模板",
				modeEnv: "使用 Windows 环境变量",
				modeLiteral: "直接输入明文",
				envRef: "变量名",
				secret: "密钥",
				secretKeep: "留空即保持不变",
				refPending: "保存后自动分配",
				refStored: (ref) => `存储位置：${ref}`,
				configured: "已配置",
				unconfigured: "未配置",
				sourceEnvironment: "来源：环境变量 · 只读",
				sourceStore: "来源：已存储",
				remove: "删除",
				recycle: (refs) => `保存后将同时移除已存储的密钥：${refs.join("、")}`,
				addTemplate: (label) => `添加：${label}`,
				addLimit: (max) => `已达上限 ${max} 个`,
				fallback: "官方搜索（兜底）",
				fallbackOn: "已启用",
				fallbackOff: "已停用",
				fallbackHint: "在下面那一行的开关里控制",
				save: "保存",
				saving: "保存中…",
				discard: "放弃",
				saved: "已保存。",
				needRef: "每个「环境变量」源都要填一个变量名（形如 TAVILY_API_KEY）。",
				needUniqueRef: "两个源不能填同一个变量名。",
				configBroken: "配置文件损坏，当前按默认值工作：",
				secretId: "SecretId",
				secretIdHint: "SecretId 明文存在配置文件里（可随时改）；SecretKey 用上面的环境变量或下面的明文框。",
				needSecretId: "元宝搜索源必须填 SecretId（形如 AKID… 的腾讯云 API 密钥）。",
				budget: "额度",
				budgetMonthly: "每月",
				budgetReserve: "保留",
				budgetUnit: "次",
				budgetHint: "留空表示用默认额度（日常 2000 次/月，活动期 6000 次）",
				badBudget: "额度要填非负整数，且「保留」不能大于「每月」。",
				usedLabel: "本月已用",
				usedCalibrate: "（可改，用于和腾讯云控制台对账）",
				badUsed: "「本月已用」必须是非负整数。",
			tooManyKeys: "一个源最多 4 把 key。请再删掉一把，或另开一个源。",
			addKey: "＋ 加一把 key",
			keyOf: (index) => `密钥 ${index + 1}`,
			sourceOf: (id) => `所属源：${id}`,
			keysInSource: (count) => `本源共 ${count} 把 key`,
			sourceExhausted: "本源的 key 额度都已用完 ⇒ 自动换下一个源",
			sourceDisabled: "本源已停用（key 保留、不参与搜索）",
			spendLine: (spend) => `本月约 ¥${spend}`,
			sourceCardTitle: (id, label) => `源 ${id} · ${label}`,
			removeGroup: "删除源",
				usageUnlimited: (used) => `本月已用 ${used} 次（未设上限）`,
				usageLineCredits: (used, monthly, remaining) => `本月已用 ${used} / ${monthly} credits · 还剩 ${remaining}`,
				usageUnlimitedCredits: (used) => `本月已用 ${used} credits（未设上限）`,
				queryUsage: "查额度",
				upstreamLine: (plan, used, limit) => `上游：${plan ?? "—"} ${used ?? "?"}/${limit ?? "?"} credits`,
				upstreamFull: "已用满",
				upstreamFailed: (reason) => `查额度失败：${reason}`,
				usageLine: (used, monthly, remaining) => `本月已用 ${used} / ${monthly} 次 · 还剩 ${remaining}`,
				usageReserve: (reserve) => ` · 其中 ${reserve} 次作为余量不使用`,
				usagePromo: (monthly, until) => ` · 活动额度 ${monthly} 次（至 ${until}，到期自动降回日常额度）`,
				usageExhausted: "额度已用完，这条源会被跳过（不会超额计费）",
				enabled: "启用",
				disabledTag: "已停用（不参与搜索，配置保留）",
				autoDisabledTag: (reason) => `已自动停用（连续失败）：${reason}`,
				restore: "恢复",
				restorePending: "保存后恢复",
			},
			en: {
				title: "Web search chain",
				intro: (max) => `Tried in order, up to ${max} sources; the official search takes over when none is usable.`,
				loading: "Reading configuration…",
				loadFailed: "Could not read the configuration: ",
				source: (n) => `Source ${n}`,
				template: "Template",
				modeEnv: "Use a Windows environment variable",
				modeLiteral: "Type the key as plain text",
				envRef: "Variable",
				secret: "Key",
				secretKeep: "leave blank to keep the stored key",
				refPending: "assigned when you save",
				refStored: (ref) => `Stored as: ${ref}`,
				configured: "configured",
				unconfigured: "not configured",
				sourceEnvironment: "from the environment, read-only",
				sourceStore: "stored",
				remove: "Remove",
				recycle: (refs) => `Saving will also remove the stored key(s): ${refs.join(", ")}`,
				addTemplate: (label) => `Add: ${label}`,
				addLimit: (max) => `Limit reached (${max})`,
				fallback: "Official search (fallback)",
				fallbackOn: "enabled",
				fallbackOff: "disabled",
				fallbackHint: "controlled by that row's switch below",
				save: "Save",
				saving: "Saving…",
				discard: "Discard",
				saved: "Saved.",
				needRef: "Every environment-variable source needs a variable name (for example TAVILY_API_KEY).",
				needUniqueRef: "Two sources cannot use the same variable name.",
				configBroken: "The configuration file is unreadable; defaults are in effect: ",
				secretId: "SecretId",
				secretIdHint: "The SecretId is stored in plain text in the configuration file (editable); the SecretKey comes from the environment variable above or the field below.",
				needSecretId: "A Yuanbao source needs a SecretId (a Tencent Cloud API key such as AKID…).",
				budget: "Quota",
				budgetMonthly: "per month",
				budgetReserve: "reserve",
				budgetUnit: "calls",
				budgetHint: "Leave blank to use the defaults (2000 calls/month, 6000 during the promotion).",
				badBudget: "The quota must be a non-negative integer, and the reserve cannot exceed the monthly quota.",
				usedLabel: "Used this month",
				usedCalibrate: "(editable, for reconciling with the Tencent Cloud console)",
				badUsed: "“Used this month” must be a non-negative integer.",
			tooManyKeys: "A source can hold at most 4 keys — remove one, or add another source.",
			addKey: "+ Add a key",
			keyOf: (index) => `Key ${index + 1}`,
			sourceOf: (id) => `Source: ${id}`,
			keysInSource: (count) => `${count} key(s) in this source`,
			sourceExhausted: "All keys of this source are exhausted — the chain moves on",
			sourceDisabled: "This source is disabled (keys kept, not used)",
			spendLine: (spend) => `≈ ¥${spend} this month`,
			sourceCardTitle: (id, label) => `Source ${id} · ${label}`,
			removeGroup: "Delete source",
				usageUnlimited: (used) => `${used} calls used this month (no cap)`,
				usageLineCredits: (used, monthly, remaining) => `${used} / ${monthly} credits used this month · ${remaining} left`,
				usageUnlimitedCredits: (used) => `${used} credits used this month (no cap)`,
				queryUsage: "Check quota",
				upstreamLine: (plan, used, limit) => `Upstream: ${plan ?? "—"} ${used ?? "?"}/${limit ?? "?"} credits`,
				upstreamFull: "exhausted",
				upstreamFailed: (reason) => `Quota check failed: ${reason}`,
				usageLine: (used, monthly, remaining) => `${used} / ${monthly} calls used this month · ${remaining} left`,
				usageReserve: (reserve) => ` · ${reserve} calls held back as a reserve`,
				usagePromo: (monthly, until) => ` · promotion quota ${monthly} calls (until ${until}, then back to the regular quota)`,
				usageExhausted: "Quota exhausted — this source is skipped (no overage billing)",
				enabled: "Enabled",
				disabledTag: "disabled (kept, not searched)",
				autoDisabledTag: (reason) => `auto-disabled after repeated failures: ${reason}`,
				restore: "Restore",
				restorePending: "restored on save",
			},
		};
		const copy = typeof navigator !== "undefined" && /^en\b/i.test(String(navigator.language ?? "")) ? COPY.en : COPY.zh;
		//#endregion

		//#region 共享状态（自包含 store；接口与 @deepseek-ai/dsh-client-store 逐字一致）
		/**
		 * `inject: () => ({ hooks: { webSearchChain } })` 里的每个值都会被 renderer 当作
		 * **外部 store** 包成 `useWebSearchChain` hook（读 `getSnapshot`、订阅 `subscribe`）。
		 * 因此接口必须逐字一致：`subscribe(fn)` 的回调**不带参数**，`getSnapshot()` 在两次
		 * 变更之间必须是**同一个引用**。
		 */
		function createSnapshotStore(initial) {
			let state = initial;
			const listeners = new Set();
			const emit = () => {
				for (const listener of Array.from(listeners)) {
					try {
						listener();
					} catch (error) {
						console.error("[web-search-chain] store 订阅回调抛出（已忽略）：", error);
					}
				}
			};
			return {
				getSnapshot: () => state,
				subscribe: (fn) => {
					listeners.add(fn);
					return () => {
						listeners.delete(fn);
					};
				},
				update: (mutator) => {
					const draft = state !== null && typeof state === "object" ? Object.assign({}, state) : state;
					try {
						mutator(draft);
					} catch (error) {
						console.error("[web-search-chain] store.update 的 mutator 抛出（状态未变）：", error);
						return;
					}
					state = draft;
					emit();
				},
				set: (next) => {
					state = next;
					emit();
				},
			};
		}
		//#endregion

		//#region 纯逻辑（无副作用；以 __internals 导出，验证台直接断言）
		/** 初始（未加载）状态。 */
		function emptyState() {
			return { status: "loading", error: null, state: null, draft: null, saving: false, notice: null };
		}
		/**
		 * 数字输入 → 非负整数；空串/非数字 → null（
ull` 与 0 必须分得开：
		 * 空额度表示"用默认值"，额度 0 表示"不限"）。
		 */
		function toInteger(value) {
			if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
			const text = String(value ?? "").trim();
			if (text.length === 0 || !/^\d+$/.test(text)) return null;
			const parsed = Number(text);
			return Number.isSafeInteger(parsed) ? parsed : null;
		}
		/**
		 * 服务端状态 → 草稿。
		 *
		 * 2026-10-23 起服务端是三级模型（**源 → key → 额度**），卡片把每个 key **平铺成一行**：
		 * 行自带 `sourceId` / `keyId` / 源的计费单位，提交时再按 `sourceId` 分组还原成嵌套结构。
		 * 这样「每个 key 单独 enable/disable/delete」在界面上是一等公民，而"一个源两把 key"仍然成立。
		 */
		function draftFromState(state) {
			const rows = [];
			for (const source of state?.sources ?? []) {
				const unit = source.billing?.unit ?? (source.kind === "tavily" ? "credits" : "calls");
				const pricePer1000 = source.billing?.pricePer1000 ?? null;
				for (const key of source.keys ?? []) {
					const budget = key.budget ?? null;
					const usage = key.usage ?? null;
					const used = usage !== null && Number.isInteger(usage.used) ? usage.used : 0;
					rows.push({
						sourceId: source.id,
						keyId: key.id,
						kind: source.kind,
						label: source.label ?? null,
						unit,
						pricePer1000,
						sourceDisabled: source.disabled === true,
						sourceAvailable: source.available !== false,
						sourceExhausted: source.exhausted === true,
						sourceKeyCount: (source.keys ?? []).length,
						mode: key.mode,
						ref: key.ref,
						serverMode: key.mode,
						credential: key.credential ?? { configured: false, writable: true },
						secret: "",
						secretId: typeof key.secretId === "string" ? key.secretId : "",
						budgetMonthly: budget === null ? "" : String(budget.monthly),
						budgetReserve: budget === null ? "" : String(budget.reserve ?? 0),
						promo: budget?.promo ?? null,
						usage,
						used: String(used),
						serverUsed: used,
						// 停用（不是删除）：disabled = 用户手动；autoDisabled = 宿主连续失败后自动摘掉
						disabled: key.disabled === true,
						autoDisabled: key.autoDisabled ?? null,
						restoreAuto: false,
						// 上游额度查询结果（草稿态，不提交）：`{ok, plan, planUsage, planLimit, error}` 或 null
						upstream: null,
					});
				}
			}
			return { sources: rows };
		}
		/** 只改第 index 个源的一个字段，返回新草稿（绝不原地改）。 */
		function patchSource(draft, index, changes) {
			return { sources: draft.sources.map((source, at) => (at === index ? { ...source, ...changes } : source)) };
		}
		/**
		 * 模式就是**一个字段**：勾「环境变量」= mode:"env"，勾「明文」= mode:"literal"。
		 * 「两个 checkbox 互斥且不可都空」由此成为**结构上的必然**，不靠额外守卫。
		 */
		function setMode(draft, index, mode) {
			return patchSource(draft, index, { mode });
		}
		function setRef(draft, index, ref) {
			return patchSource(draft, index, { ref });
		}
		function setSecret(draft, index, secret) {
			return patchSource(draft, index, { secret });
		}
		/** 改 yuanbao 源的 SecretId（明文、可随时换）。 */
		function setSecretId(draft, index, secretId) {
			return patchSource(draft, index, { secretId });
		}
		/** 改额度的一个字段：`field` 是 `"budgetMonthly"` 或 `"budgetReserve"`。 */
		function setBudget(draft, index, field, value) {
			if (field !== "budgetMonthly" && field !== "budgetReserve") return draft;
			return patchSource(draft, index, { [field]: value });
		}
		/** 改「本月已用」（校准用，不是本地计数器本身）。 */
		function setUsed(draft, index, used) {
			return patchSource(draft, index, { used });
		}
		/**
		 * 勾选/取消「启用」：**停用不是删除** —— 源、密钥、顺序都原样保留，只是不参与搜索。
		 * 取消勾选（disabled=true）后 `toRequest` 会带 `disabled: true`。
		 */
		function toggleDisabled(draft, index, enabled) {
			return patchSource(draft, index, { disabled: enabled !== true });
		}
		/** 对自动停用的源点「恢复」：只在草稿上打标记，保存时发 `resetAutoDisabled`。 */
		function markRestoreAuto(draft, index) {
			return patchSource(draft, index, { restoreAuto: true });
		}
		/** 删除**整个源**（连同它下面所有 key 的行）——判据是渲染时用的 groupKey。 */
		function removeGroup(draft, groupKey) {
			if (typeof groupKey !== "string" || groupKey.length === 0) return draft;
			return {
				sources: draft.sources.filter((row, at) => {
					const key = typeof row.sourceId === "string" && row.sourceId.length > 0 ? row.sourceId : `__new-${at}`;
					return key !== groupKey;
				}),
			};
		}
		function removeSource(draft, index) {
			return { sources: draft.sources.filter((_, at) => at !== index) };
		}
		/** 模板默认预算（服务端 `state.defaults.budgets[kind]`）。 */
		function templateBudget(state, kind) {
			const budget = state?.defaults?.budgets?.[kind];
			return budget === undefined ? null : budget;
		}
		/**
		 * 源数量上限：以**服务端**给的 `state.maxSources` 为准（升级上限时界面不必跟着改），
		 * 没拿到时退回本文件的常量。`MAX_SOURCES` 只是兜底值。
		 */
		function maxSourcesOf(state) {
			const value = state?.maxSources;
			return Number.isInteger(value) && value > 0 ? value : MAX_SOURCES;
		}
		/**
		 * 追加一个源：`kind` 指定模板（缺省取表内第一项）。
		 * 新 yuanbao 源把**模板默认额度**预填进输入框，这样它和"不填"的语义一致（含活动额度）。
		 */
		function addSource(draft, templates, kind, state) {
			// 数量上限按**源**算：新行属于一个全新源（sourceId/keyId 都留空，交给服务端分配）
			const sourceCount = new Set(draft.sources.map((row) => row.sourceId).filter((id) => typeof id === "string")).size;
			if (sourceCount >= maxSourcesOf(state)) return draft;
			const table = templates ?? [];
			const template = table.find((candidate) => candidate.kind === kind) ?? table[0] ?? { kind: "tavily" };
			const budget = templateBudget(state, template.kind);
			return {
				sources: [
					...draft.sources,
					{
						sourceId: undefined,
						keyId: undefined,
						kind: template.kind,
						label: null,
						unit: template.unit ?? (template.kind === "tavily" ? "credits" : "calls"),
						pricePer1000: null,
						sourceDisabled: false,
						sourceAvailable: true,
						sourceExhausted: false,
						sourceKeyCount: 1,
						mode: "env",
						ref: "",
						serverMode: undefined,
						credential: { configured: false, writable: true },
						secret: "",
						secretId: "",
						budgetMonthly: budget === null ? "" : String(budget.monthly),
						budgetReserve: budget === null ? "" : String(budget.reserve ?? 0),
						promo: budget?.promo ?? null,
						usage: null,
						used: "0",
						serverUsed: 0,
						disabled: false,
						autoDisabled: null,
						restoreAuto: false,
						upstream: null,
					},
				],
			};
		}
		/**
		 * 草稿里的额度 → 提交用的预算对象。
		 * 空输入 = 
ull`（**不带这个字段** ⇒ 服务端用模板默认额度）；
		 * 活动额度 `promo` 原样带回，避免"改一下每月额度就把活动额度弄丢"。
		 */
		function budgetOf(source) {
			const monthly = toInteger(source?.budgetMonthly);
			if (monthly === null) return null;
			const reserve = toInteger(source?.budgetReserve ?? "0");
			if (reserve === null) return null;
			const budget = { monthly, reserve };
			if (source?.promo !== null && source?.promo !== undefined) budget.promo = source.promo;
			return budget;
		}
		/**
		 * 草稿 → POST 请求体：**按 `sourceId` 分组还原成三级结构**（源 → keys → 每个 key 自己的额度）。
		 * 只带真正要提交的字段（空 secret 不带、缺 id 不带）；一个 key 都不剩的源整组丢弃。
		 */
		function toRequest(draft) {
			const groups = [];
			const index = new Map();
			for (const row of draft.sources) {
				const groupKey = typeof row.sourceId === "string" && row.sourceId.length > 0 ? row.sourceId : `__new-${groups.length}`;
				let group = index.get(groupKey);
				if (group === undefined) {
					group = {
						kind: row.kind,
						keys: [],
						...(typeof row.sourceId === "string" && row.sourceId.length > 0 ? { id: row.sourceId } : {}),
						...(row.label === null || row.label === undefined ? {} : { label: row.label }),
						...(row.unit === undefined ? {} : { billing: { unit: row.unit, ...(row.pricePer1000 === null || row.pricePer1000 === undefined ? {} : { pricePer1000: row.pricePer1000 }) } }),
					};
					index.set(groupKey, group);
					groups.push(group);
				}
				const key = { mode: row.mode };
				if (typeof row.keyId === "string" && row.keyId.length > 0) key.id = row.keyId;
				if (row.mode === "env") key.ref = String(row.ref ?? "").trim();
				if (row.mode === "literal" && typeof row.secret === "string" && row.secret.length > 0) key.secret = row.secret;
				if (row.kind === "yuanbao") key.secretId = String(row.secretId ?? "").trim();
				const budget = budgetOf(row);
				if (budget !== null) key.budget = budget;
				// 手动停用：写进文档（key 仍保留）；取消勾选就**不带**这个字段
				if (row.disabled === true) key.disabled = true;
				group.keys.push(key);
				if (row.sourceDisabled === true) group.disabled = true;
			}
			return { sources: groups.filter((group) => group.keys.length > 0) };
		}
		/**
		 * 用户在界面上点了「恢复」的 **key id**（清自动停用标记用）。
		 * 只对**当前确实被自动停用**的行生效，避免把脏标记发上去。
		 */
		function restoreIdsOf(draft) {
			return (draft?.sources ?? [])
				.filter((row) => row.restoreAuto === true && row.autoDisabled !== null && row.autoDisabled !== undefined)
				.map((row) => row.keyId)
				.filter((id) => typeof id === "string" && id.length > 0);
		}
		/**
		 * 需要校准的「本月已用」：只带**用户改过的**那些（否则每次保存都会把本地计数器
		 * 回写成页面打开时的旧值，等于把刚发生的调用抹掉）。键是 **key id**。
		 */
		function usagePatchOf(state, draft) {
			const patch = {};
			for (const row of draft?.sources ?? []) {
				if (typeof row.keyId !== "string" || row.keyId.length === 0) continue;
				const used = toInteger(row.used);
				if (used === null) continue;
				if (used !== row.serverUsed) patch[row.keyId] = used;
			}
			return patch;
		}
		/** 客户端预校验：返回第一条人话问题，没有就 null（省一次注定失败的往返）。 */
		function firstProblem(draft) {
			const seen = new Set();
			const keysPerSource = new Map();
			for (const row of draft.sources) {
				if (row.mode === "env") {
					const ref = String(row.ref ?? "").trim();
					if (ref.length === 0 || !REF_PATTERN.test(ref)) return copy.needRef;
					if (seen.has(ref)) return copy.needUniqueRef;
					seen.add(ref);
				}
				if (row.kind === "yuanbao") {
					const secretId = String(row.secretId ?? "").trim();
					if (!SECRET_ID_PATTERN.test(secretId)) return copy.needSecretId;
				}
				// 额度只在"这一行确实填了额度"时才校验（空 = 用模板默认值）
				if (row.budgetMonthly !== undefined || row.budgetReserve !== undefined) {
					const budget = budgetOf(row);
					if (budget === null) return copy.badBudget;
					if (budget.monthly === 0 ? budget.reserve !== 0 : budget.reserve > budget.monthly) return copy.badBudget;
				}
				const used = String(row.used ?? "").trim();
				if (used.length > 0 && toInteger(used) === null) return copy.badUsed;
				const groupKey = row.sourceId ?? `__new-${draft.sources.indexOf(row)}`;
				const count = (keysPerSource.get(groupKey) ?? 0) + 1;
				keysPerSource.set(groupKey, count);
				if (count > MAX_KEYS) return copy.tooManyKeys;
			}
			return null;
		}
		/**
		 * 明文输入框是否置灰：**只有「服务端当前就已是 literal 且该 ref 不可写」才置灰**。
		 * 用户在界面上把 env 源切成 literal 时服务端 ref 还是旧的环境变量名，那一刻不该置灰
		 * ——真正的「写不进去」由服务端的 409 CREDENTIAL_READONLY 如实回答。
		 */
		function secretDisabled(source) {
			return source.mode === "literal" && source.serverMode === "literal" && source.credential?.writable === false;
		}
		/**
		 * 这次保存会连带删除哪些已存的明文密钥。
		 *
		 * ⚠️ 判据是**「旧文档里是 literal、而草稿里对应 id 已不再是 literal」**（切换到环境变量、
		 * 或整行删掉都算），**不是**「该源现在是 literal」——后者是常态，那样会在毫无风险时误报。
		 * @param state - 最近一次服务端状态。
		 * @param draft - 当前草稿。
		 * @returns 将被回收的引用名（可能为空）。
		 */
		function recycledRefs(state, draft) {
			// 判据：**服务端某个 key 是 literal，而草稿里同 keyId 已不再是 literal**（切走或删掉这把 key）
			const stillLiteral = new Set(draft.sources.filter((row) => row.mode === "literal").map((row) => row.keyId));
			const removed = [];
			for (const source of state?.sources ?? []) {
				for (const key of source.keys ?? []) {
					if (key.mode !== "literal") continue;
					if (stillLiteral.has(key.id)) continue;
					removed.push(key.ref);
				}
			}
			return removed;
		}
		/** 一个源的凭据状态文案。 */
		function credentialText(credential) {
			if (credential?.configured === true) {
				const fromEnvironment = credential.source === "environment" || credential.source === "process-env";
				return `${copy.configured}（${fromEnvironment ? copy.sourceEnvironment : copy.sourceStore}）`;
			}
			return copy.unconfigured;
		}
		/** 额度那一行的人话（`usage` 来自服务端，随保存刷新）。 */
		function usageText(usage) {
			if (usage === null || usage === undefined) return "";
			const used = Number.isInteger(usage.used) ? usage.used : 0;
			// Tavily 按 credit 计量（basic 1 / advanced 2），文案不能写「次」，否则数字对不上官方后台
			const line = usage.unit === "credits" ? copy.usageLineCredits : copy.usageLine;
			if (usage.unlimited === true || usage.monthly === null) {
				return usage.unit === "credits" ? copy.usageUnlimitedCredits(used) : copy.usageUnlimited(used);
			}
			const parts = [line(used, usage.monthly, usage.remaining ?? 0)];
			if (Number.isInteger(usage.reserve) && usage.reserve > 0) parts.push(copy.usageReserve(usage.reserve));
			if (usage.promo !== null && usage.promo !== undefined && usage.promo.active === true) {
				parts.push(copy.usagePromo(usage.promo.monthly, usage.promo.until));
			}
			return `${parts.join("")}${usage.exhausted === true ? ` · ${copy.usageExhausted}` : ""}`;
		}
		/** 摘要视图那一行（state 还没到时也要稳）。 */
		function summaryText(snapshot) {
			const state = snapshot?.state;
			if (state === null || state === undefined) return copy.loading;
			const enabled = state.fallback?.enabled === true;
			const sources = state.sources ?? [];
			const keys = sources.reduce((total, source) => total + (source.keys ?? []).length, 0);
			const quota = sources
				.filter((source) => source.kind === "yuanbao")
				.map((source) => {
					const usage = source.keys?.[0]?.usage ?? null;
					return `元宝 ${usage?.used ?? 0}/${usage?.monthly ?? "∞"}`;
				})
				.join(" · ");
			return `${copy.title} · ${sources.length} 个源 / ${keys} 把 key${quota.length > 0 ? ` · ${quota}` : ""} · ${copy.fallback} ${enabled ? copy.fallbackOn : copy.fallbackOff}`;
		}
		/** 每个源最多几个 key：以服务端 `state.maxKeys` 为准，没拿到时退回常量。 */
		function maxKeysOf(state) {
			const value = state?.maxKeys;
			return Number.isInteger(value) && value > 0 ? value : MAX_KEYS;
		}
		/**
		 * 给某个 key 行所在的源**追加一把新 key**（同一个源、按插入位置紧跟在同源最后一行之后）。
		 * 源已满（≥ maxKeys）或这一行还没有服务端 sourceId（新源的第一把 key）时退化成"再加一个源"。
		 */
		function addKey(draft, index, state) {
			const row = draft.sources[index];
			if (row === undefined) return draft;
			if (typeof row.sourceId !== "string" || row.sourceId.length === 0) return draft;
			const sameSource = draft.sources.filter((candidate) => candidate.sourceId === row.sourceId).length;
			if (sameSource >= maxKeysOf(state)) return draft;
			const lastAt = draft.sources.map((candidate) => candidate.sourceId).lastIndexOf(row.sourceId);
			const fresh = {
				...row,
				keyId: undefined,
				mode: "env",
				ref: "",
				serverMode: undefined,
				credential: { configured: false, writable: true },
				secret: "",
				budgetMonthly: "",
				budgetReserve: "0",
				promo: null,
				usage: null,
				used: "0",
				serverUsed: 0,
				disabled: false,
				autoDisabled: null,
				restoreAuto: false,
				upstream: null,
			};
			const next = [...draft.sources];
			next.splice(lastAt + 1, 0, fresh);
			return { sources: next };
		}
		/**
		 * 编辑动作：`{kind:"mode"|"ref"|"secret"|"secretId"|"budget"|"used"|"remove"|"add"|"addKey", index?, value?, field?}`。
		 * 所有改动都走这里 → 逻辑不散在 React 里，验证台能直接断言。
		 */
		function applyEdit(store, action) {
			store.update((shell) => {
				if (shell.draft === null) return;
				const current = shell.draft;
				switch (action?.kind) {
					case "mode":
						shell.draft = setMode(current, action.index, action.value);
						break;
					case "ref":
						shell.draft = setRef(current, action.index, action.value);
						break;
					case "secret":
						shell.draft = setSecret(current, action.index, action.value);
						break;
					case "secretId":
						shell.draft = setSecretId(current, action.index, action.value);
						break;
					case "budget":
						shell.draft = setBudget(current, action.index, action.field, action.value);
						break;
					case "used":
						shell.draft = setUsed(current, action.index, action.value);
						break;
					case "toggleDisabled":
						// action.value = 勾选后的「启用」状态
						shell.draft = toggleDisabled(current, action.index, action.value);
						break;
					case "restoreAuto":
						shell.draft = markRestoreAuto(current, action.index);
						break;
					case "remove":
						shell.draft = removeSource(current, action.index);
						break;
					case "removeGroup":
						shell.draft = removeGroup(current, action.groupKey);
						break;
					case "add":
						shell.draft = addSource(current, shell.state?.templates ?? [], action.value, shell.state);
						break;
					case "addKey":
						shell.draft = addKey(current, action.index, shell.state);
						break;
					default:
						return;
				}
				shell.notice = null;
			});
		}
		//#endregion

		//#region 自包含原子（不 require 任何 Harness Client 包；只用 --dsw-alias-* token）
		const TOKEN = {
			label: "var(--dsw-alias-label-primary, inherit)",
			tertiary: "var(--dsw-alias-label-tertiary, #888)",
			border: "var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
			danger: "var(--dsw-alias-state-error-primary, #d9534f)",
			business: "var(--dsw-alias-state-business-primary, #3b7ddd)",
		};
		const S = {
			intro: { color: TOKEN.tertiary, fontSize: 13, margin: "0 0 10px" },
			card: { display: "flex", flexDirection: "column", gap: 10, maxWidth: 760 },
			sourceCard: { border: `0.5px solid ${TOKEN.border}`, borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 },
			sourceTitle: { color: TOKEN.label, fontSize: 14, fontWeight: 600 },
			row: { border: `0.5px solid ${TOKEN.border}`, borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 },
			rowHead: { display: "flex", alignItems: "center", justifyContent: "space-between" },
			rowTitle: { color: TOKEN.label, fontSize: 13 },
			modeLine: { color: TOKEN.label, fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 },
			field: { display: "flex", alignItems: "center", gap: 8, marginLeft: 22, color: TOKEN.label, fontSize: 13 },
			input: { flex: 1, minWidth: 0, fontSize: 13, padding: "4px 8px", border: `0.5px solid ${TOKEN.border}`, borderRadius: 6, background: "transparent", color: TOKEN.label },
			number: { width: 88, fontSize: 13, padding: "4px 8px", border: `0.5px solid ${TOKEN.border}`, borderRadius: 6, background: "transparent", color: TOKEN.label },
			hint: { color: TOKEN.tertiary, fontSize: 12, margin: "0 0 0 22px" },
			budgetLine: { display: "flex", alignItems: "center", gap: 8, marginLeft: 22, color: TOKEN.label, fontSize: 13, flexWrap: "wrap" },
			tag: { fontSize: 11, padding: "1px 6px", borderRadius: 10, border: `0.5px solid ${TOKEN.border}`, color: TOKEN.tertiary, whiteSpace: "nowrap" },
			fallback: { display: "flex", alignItems: "center", gap: 8, color: TOKEN.tertiary, fontSize: 13, borderTop: `0.5px solid ${TOKEN.border}`, paddingTop: 10 },
			footer: { display: "flex", justifyContent: "flex-end", gap: 8 },
			banner: { color: TOKEN.danger, fontSize: 12, margin: 0 },
			ok: { color: TOKEN.tertiary, fontSize: 12, margin: 0 },
		};
		/** 自包含 checkbox（原生 input + 文字标签）。 */
		function AtomCheckbox(props) {
			return jsxs("label", {
				style: S.modeLine,
				children: [
					jsx("input", {
						type: "checkbox",
						checked: props.checked === true,
						disabled: props.disabled === true,
						style: { margin: 0 },
						onChange: (event) => props.onChange(event.target.checked === true),
					}),
					jsx("span", { children: props.label }),
				],
			});
		}
		/** 自包含文本输入（`type` 可传 `password` / 
umber`）。 */
		function AtomInput(props) {
			return jsx("input", {
				type: props.type ?? "text",
				value: props.value ?? "",
				placeholder: props.placeholder ?? "",
				disabled: props.disabled === true,
				style: { ...(props.narrow === true ? S.number : S.input), opacity: props.disabled === true ? 0.55 : 1 },
				onChange: (event) => props.onChange(event.target.value),
			});
		}
		/** 自包含按钮。 */
		function AtomButton(props) {
			const primary = props.variant === "primary";
			return jsx("button", {
				type: "button",
				disabled: props.disabled === true,
				onClick: props.onClick,
				style: {
					font: "inherit",
					fontSize: 13,
					padding: "5px 12px",
					borderRadius: 6,
					cursor: props.disabled === true ? "default" : "pointer",
					border: `0.5px solid ${TOKEN.border}`,
					background: primary ? TOKEN.business : "transparent",
					color: primary ? "#fff" : TOKEN.label,
					opacity: props.disabled === true ? 0.55 : 1,
				},
				children: props.children,
			});
		}
		/** 自包含徽标。 */
		function AtomTag(props) {
			return jsx("span", { style: S.tag, children: props.children });
		}
		//#endregion

		//#region 卡片
		/** 元宝搜索源独有的三段：SecretId / 额度 / 本月已用（校准）。 */
		function renderYuanbaoExtras(source, index, props) {
			return [
				jsxs(
					"div",
					{
						style: S.field,
						children: [
							jsx("span", { children: copy.secretId }),
							jsx(AtomInput, {
								value: source.secretId,
								placeholder: "AKID…",
								onChange: (value) => props.edit({ kind: "secretId", index, value }),
							}),
						],
					},
					`secretId-${index}`,
				),
				jsx("p", { style: S.hint, children: copy.secretIdHint }, `secretIdHint-${index}`),
				jsxs(
					"div",
					{
						style: S.budgetLine,
						children: [
							jsx("span", { children: copy.budget }),
							jsx("span", { children: copy.budgetMonthly }),
							jsx(AtomInput, {
								narrow: true,
								type: "number",
								value: source.budgetMonthly,
								placeholder: "2000",
								onChange: (value) => props.edit({ kind: "budget", field: "budgetMonthly", index, value }),
							}),
							jsx("span", { children: copy.budgetUnit }),
							jsx("span", { children: copy.budgetReserve }),
							jsx(AtomInput, {
								narrow: true,
								type: "number",
								value: source.budgetReserve,
								placeholder: "100",
								onChange: (value) => props.edit({ kind: "budget", field: "budgetReserve", index, value }),
							}),
							jsx("span", { children: copy.budgetUnit }),
						],
					},
					`budget-${index}`,
				),
				jsxs(
					"div",
					{
						style: S.budgetLine,
						children: [
							jsx("span", { children: copy.usedLabel }),
							jsx(AtomInput, {
								narrow: true,
								type: "number",
								value: source.used,
								onChange: (value) => props.edit({ kind: "used", index, value }),
							}),
							jsx("span", { style: { color: TOKEN.tertiary, fontSize: 12 }, children: copy.usedCalibrate }),
						],
					},
					`used-${index}`,
				),
				jsx("p", { style: S.hint, children: usageText(source.usage) }, `usage-${index}`),
			];
		}
		/**
		 * Tavily 专属：上游额度行 + 「查额度」按钮。
		 *
		 * 这是腾讯云做不到的一件事：Tavily 有 `GET /usage`，能直接读到套餐已用/上限，
		 * 与本地账本（credits）可以互相印证。
		 */
		function renderUpstreamExtras(source, index, props) {
			if (source.kind !== "tavily") return [];
			const upstream = source.upstream ?? null;
			let line = null;
			if (upstream !== null && upstream.loading === true) {
				line = jsx("span", { style: S.hint, children: copy.loading }, `upstream-${index}`);
			} else if (upstream !== null && upstream.ok === true) {
				const full = Number.isInteger(upstream.planUsage) && Number.isInteger(upstream.planLimit) && upstream.planUsage >= upstream.planLimit;
				line = jsx(
					"span",
					{ children: `${copy.upstreamLine(upstream.plan, upstream.planUsage, upstream.planLimit)}${full ? ` · ${copy.upstreamFull}` : ""}` },
					`upstream-${index}`,
				);
			} else if (upstream !== null) {
				line = jsx("span", { style: S.hint, children: copy.upstreamFailed(upstream.error ?? "unknown") }, `upstream-${index}`);
			}
			return [
				jsxs(
					"div",
					{
						style: S.field,
						children: [
							jsx(AtomButton, { children: copy.queryUsage, onClick: () => props.queryUsage(index) }),
							line,
						],
					},
					`query-usage-${index}`,
				),
			];
		}
		/**
		 * 一把 key 的渲染（2026-10-23 三级模型：源 → key）。
		 * 标题行带上「所属源 / 第几把 key / 计费单位」，并给「＋ 加一把 key」与「删除这把 key」。
		 */
		/**
		 * 按**源**把扁平的行分组（源 → keys）。
		 * 草稿仍是"每把 key 一行"（逻辑简单），渲染时才折叠成"一个源一张卡、卡内 N 行 key"。
		 */
		function groupRows(draft) {
			const groups = []
			const index = new Map()
			for (const [at, row] of (draft?.sources ?? []).entries()) {
				const groupKey = typeof row.sourceId === "string" && row.sourceId.length > 0 ? row.sourceId : `__new-${at}`
				let group = index.get(groupKey)
				if (group === undefined) {
					group = {
						groupKey,
						sourceId: typeof row.sourceId === "string" && row.sourceId.length > 0 ? row.sourceId : null,
						kind: row.kind,
						unit: row.unit,
						sourceDisabled: row.sourceDisabled === true,
						sourceExhausted: row.sourceExhausted === true,
						sourceAvailable: row.sourceAvailable !== false,
						indices: [],
						rows: [],
					}
					index.set(groupKey, group)
					groups.push(group)
				}
				group.indices.push(at)
				group.rows.push(row)
			}
			return groups
		}
		/**
		 * 一张**源卡**：源标题 + 源级动作（加 key / 删除源）+ 源级状态与汇总，卡内是各把 key 的行。
		 */
		function renderSourceCard(group, templates, props) {
			const template = (templates ?? []).find((candidate) => candidate.kind === group.kind)
			const unitLabel = group.unit === "credits" ? "credits" : "次"
			const used = group.rows.reduce((total, row) => total + (Number.isInteger(row.usage?.used) ? row.usage.used : 0), 0)
			const spend = group.rows.reduce((total, row) => total + (typeof row.usage?.spend === "number" ? row.usage.spend : 0), 0)
			const price = group.rows.find((row) => typeof row.pricePer1000 === "number")?.pricePer1000 ?? null
			const summary = price === null ? `${used} ${unitLabel}` : `${used} ${unitLabel} ≈ ¥${Math.round(spend * 10000) / 10000}`
			return jsxs(
				"div",
				{
					style: group.sourceDisabled === true ? { ...S.sourceCard, opacity: 0.7 } : S.sourceCard,
					children: [
						jsxs("div", {
							style: S.rowHead,
							children: [
								jsx("span", { style: S.sourceTitle, children: `${copy.sourceCardTitle(group.sourceId ?? "新", template?.label ?? group.kind)}` }),
								jsx(AtomTag, { children: copy.keysInSource(group.rows.length) }),
								jsx(AtomTag, { children: `${copy.usedLabel} ${summary}` }),
								jsx("span", { style: { flex: 1 } }),
								jsx(AtomButton, {
									children: copy.addKey,
									disabled: group.rows.length >= maxKeysOf(props?.state),
									onClick: () => props.edit({ kind: "addKey", index: group.indices.at(-1) }),
								}),
								jsx(AtomButton, { children: copy.removeGroup, onClick: () => props.edit({ kind: "removeGroup", groupKey: group.groupKey }) }),
							],
						}),
						group.sourceDisabled === true ? jsx("p", { style: S.hint, children: copy.sourceDisabled }, `src-disabled-${group.groupKey}`) : null,
						group.sourceExhausted === true ? jsx("p", { style: S.hint, children: copy.sourceExhausted }, `src-exhausted-${group.groupKey}`) : null,
						...group.rows.map((row, offset) => renderSourceRow(row, group.indices[offset], templates, props)),
					],
				},
				`source-card-${group.groupKey}`,
			)
		}
		/** 一把 key 的行（源卡内部）：启用 / 删除 / 模式 / 变量名或明文 / 额度 / 查额度。 */
		function renderSourceRow(source, index, templates, props) {
			const kind = source.kind;
			const template = (templates ?? []).find((candidate) => candidate.kind === kind);
			const keyOrdinal = (props?.keyOrdinals?.[index] ?? 0) + 1;
			const title = copy.keyOf(keyOrdinal - 1);
			const isEnv = source.mode === "env";
			const storedRef = source.serverMode === "literal" && typeof source.ref === "string" && source.ref.length > 0;
			const autoDisabled = source.autoDisabled ?? null;
			// 自动停用的行：草稿里点了「恢复」就显示待保存态，否则给「恢复」按钮
			const restorePending = source.restoreAuto === true;
			return jsxs(
				"div",
				{
					style: source.disabled === true ? { ...S.row, opacity: 0.6 } : S.row,
					children: [
						jsxs("div", {
							style: S.rowHead,
							children: [
								// 「启用」勾选框：取消勾选 = **停用这把 key**（key 不删，配置与额度都保留）
								jsx(AtomCheckbox, {
									checked: source.disabled !== true,
									label: copy.enabled,
									onChange: (value) => props.edit({ kind: "toggleDisabled", index, value }),
								}),
								jsx("span", { style: S.rowTitle, children: title }),
								jsx(AtomTag, { children: source.mode === "env" ? String(source.ref ?? "—") : copy.modeLiteral }),
								jsx("span", { style: { flex: 1 } }),
								jsx(AtomButton, { children: copy.remove, onClick: () => props.edit({ kind: "remove", index }) }),
							],
						}),
						source.disabled === true ? jsx("p", { style: S.hint, children: copy.disabledTag }, `disabled-${index}`) : null,
						autoDisabled !== null
							? jsxs(
									"div",
									{
										style: S.field,
										children: [
											jsx("span", { children: copy.autoDisabledTag(autoDisabled.reason ?? "") }),
											restorePending
												? jsx("span", { style: S.hint, children: copy.restorePending })
												: jsx(AtomButton, { children: copy.restore, onClick: () => props.edit({ kind: "restoreAuto", index }) }),
										],
									},
									`auto-${index}`,
								)
							: null,
						...(kind === "yuanbao" ? renderYuanbaoExtras(source, index, props) : []),
						...renderUpstreamExtras(source, index, props),
						jsx(AtomCheckbox, {
							checked: isEnv,
							label: copy.modeEnv,
							onChange: () => props.edit({ kind: "mode", index, value: "env" }),
						}),
						isEnv
							? jsxs("div", {
									style: S.field,
									children: [
										jsx("span", { children: copy.envRef }),
										jsx(AtomInput, {
											value: source.ref,
											placeholder: template?.refExample ?? "TAVILY_API_KEY",
											onChange: (value) => props.edit({ kind: "ref", index, value }),
										}),
									],
								})
							: null,
						isEnv ? jsx("p", { style: S.hint, children: credentialText(source.credential) }) : null,
						jsx(AtomCheckbox, {
							checked: !isEnv,
							label: copy.modeLiteral,
							onChange: () => props.edit({ kind: "mode", index, value: "literal" }),
						}),
						!isEnv
							? jsxs("div", {
									style: S.field,
									children: [
										jsx("span", { children: copy.secret }),
										jsx(AtomInput, {
											type: "password",
											value: source.secret,
											placeholder: source.credential?.configured === true ? copy.secretKeep : "",
											disabled: secretDisabled(source),
											onChange: (value) => props.edit({ kind: "secret", index, value }),
										}),
										jsx(AtomTag, { children: source.credential?.configured === true ? copy.configured : copy.unconfigured }),
									],
								})
							: null,
						!isEnv ? jsx("p", { style: S.hint, children: storedRef ? copy.refStored(source.ref) : copy.refPending }) : null,
					],
				},
				`source-${index}`,
			);
		}
		/** 末尾那行只读的官方兜底：真源是同页下面那一行的开关（避免两处真源）。 */
		function renderFallback(state) {
			const enabled = state?.fallback?.enabled === true;
			return jsxs("div", {
				style: S.fallback,
				children: [
					jsx("span", { children: `ⓘ ${copy.fallback}` }),
					jsx(AtomTag, { children: enabled ? copy.fallbackOn : copy.fallbackOff }),
					jsx("span", { children: copy.fallbackHint }),
				],
			});
		}
		/** 页面视图。 */
		function renderEditor(snapshot, props) {
			if (snapshot?.status === "failed") {
				return jsx("p", { style: S.banner, children: `${copy.loadFailed}${snapshot.error ?? ""}` });
			}
			const draft = snapshot?.draft ?? null;
			if (draft === null) return jsx("p", { style: S.intro, children: copy.loading });
			const state = snapshot.state;
			const problem = firstProblem(draft);
			const maxSources = maxSourcesOf(state);
			// 上限按**源**算（一个源可以有多把 key），不是按行算
			const sourceCount = new Set(draft.sources.map((row) => row.sourceId).filter((id) => typeof id === "string")).size;
			const atLimit = sourceCount >= maxSources;
			const templates = state?.templates ?? [];
			const recycling = recycledRefs(state, draft);
			const keyOrdinals = {};
			const seen = new Map();
			for (const [index, row] of draft.sources.entries()) {
				const groupKey = row.sourceId ?? `__new-${index}`;
				const ordinal = seen.get(groupKey) ?? 0;
				keyOrdinals[index] = ordinal;
				seen.set(groupKey, ordinal + 1);
			}
			const rowProps = { ...props, keyOrdinals, state };
			// 一个源一张卡：卡内按 key 顺序排（Tavily 的两把 key 会在同一张卡里）
			const groups = groupRows(draft);
			return jsxs("div", {
				style: S.card,
				children: [
					jsx("p", { style: S.intro, children: copy.intro(maxSources) }),
					typeof state?.configError === "string" && state.configError.length > 0
						? jsx("p", { style: S.banner, children: `${copy.configBroken}${state.configError}` })
						: null,
					...groups.map((group) => renderSourceCard(group, templates, rowProps)),
					jsx("div", {
						style: { display: "flex", gap: 8, flexWrap: "wrap" },
						children: (templates.length > 0 ? templates : [{ kind: "tavily", label: "Tavily Key" }]).map((template) =>
							jsx(
								AtomButton,
								{
									children: atLimit ? copy.addLimit(maxSources) : copy.addTemplate(template.label),
									disabled: atLimit,
									onClick: () => props.edit({ kind: "add", value: template.kind }),
								},
								`add-${template.kind}`,
							),
						),
					}),
					renderFallback(state),
					recycling.length > 0 ? jsx("p", { style: S.banner, children: copy.recycle(recycling) }) : null,
					snapshot.notice
						? jsx("p", { style: snapshot.notice.tone === "error" ? S.banner : S.ok, children: snapshot.notice.text })
						: null,
					problem !== null ? jsx("p", { style: S.banner, children: problem }) : null,
					jsxs("div", {
						style: S.footer,
						children: [
							jsx(AtomButton, { children: copy.discard, disabled: snapshot.saving === true, onClick: () => props.discard() }),
							jsx(AtomButton, {
								children: snapshot.saving === true ? copy.saving : copy.save,
								variant: "primary",
								disabled: snapshot.saving === true || problem !== null,
								onClick: () => props.save(),
							}),
						],
					}),
				],
			});
		}
		/** 卡片入口：摘要一行 / 页面一张表单。 */
		function WebSearchChainCard(props) {
			const snapshot = typeof props.useWebSearchChain === "function" ? props.useWebSearchChain((value) => value) : null;
			useEffect(() => {
				try {
					props.load();
				} catch (error) {
					console.error("[web-search-chain] 首次加载抛出（已忽略）：", error);
				}
			}, []);
			if (props.view === "summary") return summaryText(snapshot);
			return renderEditor(snapshot, props);
		}
		//#endregion

		//#region 同源调用
		/** 读整份状态。任何失败都降级成可见的错误文案，绝不抛。 */
		async function loadState(store) {
			try {
				const response = await fetch(CONFIG_PATH, { method: "GET" });
				const payload = await response.json().catch(() => void 0);
				if (payload === null || typeof payload !== "object" || payload.ok !== true) {
					store.update((shell) => {
						shell.status = "failed";
						shell.error = `HTTP ${response.status}`;
					});
					return;
				}
				store.update((shell) => {
					shell.status = "ready";
					shell.error = null;
					shell.state = payload;
					shell.draft = draftFromState(payload);
					shell.notice = null;
				});
			} catch (error) {
				store.update((shell) => {
					shell.status = "failed";
					shell.error = String(error);
				});
			}
		}
		/**
		 * 查某个源在**上游**的真实用量（目前只有 Tavily 有 `/usage`；腾讯云没有这个接口）。
		 *
		 * 只读动作：不动配置、不需要保存；结果放草稿的 `upstream`（不提交）。
		 * 任意失败都落成 `{ok:false, error}` 显示在行内，绝不外抛。
		 */
		async function loadUpstreamUsage(store, index) {
			const snapshot = store.getSnapshot();
			const source = snapshot?.draft?.sources?.[index];
			if (source === undefined || typeof source.keyId !== "string" || source.keyId.length === 0) return;
			store.update((shell) => {
				shell.draft = patchSource(shell.draft, index, { upstream: { loading: true } });
			});
			let result;
			try {
				const response = await fetch(CONFIG_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ queryUsage: [source.keyId] }),
				});
				const payload = await response.json().catch(() => void 0);
				const one = payload?.results?.[source.keyId];
				result = one ?? { ok: false, error: `HTTP ${response.status}` };
			} catch (error) {
				result = { ok: false, error: String(error) };
			}
			store.update((shell) => {
				shell.draft = patchSource(shell.draft, index, { upstream: result });
			});
		}
		/** 保存草稿。失败就地显示服务端的话，草稿保留。 */
		async function saveDraft(store) {
			const snapshot = store.getSnapshot();
			if (snapshot.draft === null || snapshot.saving === true) return;
			store.update((shell) => {
				shell.saving = true;
				shell.notice = null;
			});
			let response;
			let payload;
			try {
				response = await fetch(CONFIG_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...toRequest(snapshot.draft), usage: usagePatchOf(snapshot.state, snapshot.draft), resetAutoDisabled: restoreIdsOf(snapshot.draft) }),
				});
				payload = await response.json().catch(() => void 0);
			} catch (error) {
				store.update((shell) => {
					shell.saving = false;
					shell.notice = { tone: "error", text: `${copy.loadFailed}${String(error)}` };
				});
				return;
			}
			if (payload === null || typeof payload !== "object" || payload.ok !== true) {
				const text = payload !== null && typeof payload === "object" && typeof payload.message === "string" ? payload.message : `HTTP ${response.status}`;
				store.update((shell) => {
					shell.saving = false;
					shell.notice = { tone: "error", text };
				});
				return;
			}
			store.update((shell) => {
				shell.saving = false;
				shell.status = "ready";
				shell.error = null;
				shell.state = payload;
				shell.draft = draftFromState(payload);
				shell.notice = { tone: "ok", text: copy.saved };
			});
		}
		//#endregion

		//#region 接线
		/**
		 * 挂载配置卡片。任何失败只记一条日志，**绝不打穿**（启动门禁是全有全无）。
		 */
		function apply(ctx) {
			const store = createSnapshotStore(emptyState());
			try {
				ctx.inject(["slots"], (scope) => {
					try {
						scope.slots.inject(SLOT, () =>
							scope.slots.register(
								{
									name: SLOT,
									key: ENTRY_KEY,
									inject: () => ({
										hooks: { webSearchChain: store },
										load: () => {
											loadState(store).catch((error) => console.error("[web-search-chain] 加载失败（已忽略）：", error));
										},
										save: () => {
											saveDraft(store).catch((error) => console.error("[web-search-chain] 保存失败（已忽略）：", error));
										},
										discard: () => {
											store.update((shell) => {
												shell.draft = draftFromState(shell.state);
												shell.notice = null;
											});
										},
										edit: (action) => {
											applyEdit(store, action);
										},
										queryUsage: (index) => {
											loadUpstreamUsage(store, index).catch((error) => console.error("[web-search-chain] 查额度失败（已忽略）：", error));
										},
									}),
								},
								WebSearchChainCard,
							),
						);
					} catch (error) {
						console.error("[web-search-chain] 配置卡片注册失败（仅少一张卡片，不影响启动）：", error);
					}
				});
			} catch (error) {
				console.error("[web-search-chain] 嵌套注入 slots 服务失败（不注册卡片，不影响启动）：", error);
			}
		}
		//#endregion

		exports.name = "web-search-chain-client";
		exports.inject = [];
		exports.apply = apply;
		// 只读出口：验证台直接断言纯逻辑，不必穿过 React（不影响加载）
		exports.__internals = {
			createSnapshotStore,
			emptyState,
			draftFromState,
			patchSource,
			setMode,
			setRef,
			setSecret,
			setSecretId,
			setBudget,
			setUsed,
			toggleDisabled,
			markRestoreAuto,
			restoreIdsOf,
			removeSource,
			addSource,
			maxSourcesOf,
			toInteger,
			budgetOf,
			toRequest,
			usagePatchOf,
			firstProblem,
			secretDisabled,
			credentialText,
			usageText,
			recycledRefs,
			summaryText,
			maxKeysOf,
			addKey,
			removeGroup,
			groupRows,
			renderSourceRow,
			renderSourceCard,
			applyEdit,
			loadState,
			saveDraft,
			loadUpstreamUsage,
			renderUpstreamExtras,
		};
		return module.exports;
	},
});