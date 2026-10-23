/**
 * web-search-chain 的**纯逻辑层**：零 I/O、零副作用、可离线测试。
 *
 * 这里只放「与 DSH 运行时无关」的判定：文档形状、提交校验、凭据回收、腿序、失败文案，
 * 以及**额度（budget）与用量（usage）的算术**。文件读写在 `config-store.mjs`，
 * 运行时接线在 `index-v5.mjs`，TC3 签名在 `tencent-sign.mjs`。
 *
 * 2026-10-22 起支持两种源模板：
 * - `tavily`：一个密钥（环境变量或明文）。
 * - `yuanbao`：腾讯云元宝搜索，SecretId（明文存配置、界面可改）+ SecretKey（环境变量或明文），
 *   并且**带额度闸门**（免费额度 2000 次/自然月/UIN，限时活动 6000，超额按量计费且单价高）。
 */

/**
 * 源数量上限（界面与 Host 两侧都按它约束）。
 *
 * 2026-10-22 由 3 提到 4：典型腿序是 **元宝（免费额度）→ Tavily key1 → Tavily key2 → DS 搜索 API**，
 * 四条都要能同时配在链里。上限只是防呆，不改变"按文档顺序尝试"的语义。
 */
export const MAX_SOURCES = 4
/**
 * **每个源**最多几个 key（2026-10-23 三级模型：源 → key → 额度）。
 *
 * 例如 Tavily 一个"源"里放两把 key，各自 1000 credits/月，key1 用完自动换 key2，
 * key2 也完了才轮到下一个源 —— 不用再把两把 key 拆成两个源。
 */
export const MAX_KEYS = 4
/** 计费单位的合法取值：`calls`（按次）/ `credits`（按 credit，Tavily 用）。 */
export const BILLING_UNITS = ['calls', 'credits']
/** 各模板的**默认**计费单位（一个源就是一份账单，单位由它的计费方式决定）。 */
export const DEFAULT_UNIT_BY_KIND = { yuanbao: 'calls', 'deepseek-api': 'calls', tavily: 'credits' }
/** 配置文件体积上限：超过即视同损坏。 */
export const MAX_DOCUMENT_BYTES = 65536
/** 凭据引用名文法（与凭据域一致：POSIX shell 标识符）。 */
export const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** 源 id 文法（界面草稿用的短标识）。 */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
/** 明文源自动分配的引用名前缀（也是「本插件拥有的凭据命名空间」）。 */
export const LITERAL_REF_PREFIX = 'WEB_SEARCH_TAVILY_'
/** 引用名长度上限。 */
export const MAX_REF_LENGTH = 64
/** 明文长度上限。 */
export const MAX_SECRET_LENGTH = 1024
/** 文档版本（形状变化时用它做迁移分支；v2 起有 secretId / budget）。 */
export const DOCUMENT_VERSION = 3

/**
 * 腾讯云 SecretId 的形状校验。
 *
 * 官方形态是 `AKID` + 32 位字母数字，但**刻意只做宽松校验**（非空白、6~128 字符）：
 * 将来形如 `AKID…` 的其它密钥类型、或临时凭证的 TmpSecretId 都不该被我们卡住。
 * 真正的对错由腾讯云返回 `AuthFailure.*` 回答。
 */
export const SECRET_ID_PATTERN = /^\S{6,128}$/

/** 月度预算上限（防止把 `1e9` 当额度填进来，界面上也拦）。 */
export const MAX_MONTHLY_BUDGET = 10000000

/**
 * 模板表。加新模板 = 往这张表里加一项 + 在 index-v5 里实现它的腿。
 *
 * `yuanbao` 排第一：2026-10-22 起它是主通道（Tavily 的两把 key 都已超套餐限额），
 * 界面「添加」按钮按模板逐个渲染，顺序即展示顺序。
 */
export const TEMPLATES = [
	{ kind: 'yuanbao', label: '腾讯元宝搜索', refExample: 'TENCENTCLOUD_SECRET_KEY' },
	{ kind: 'deepseek-api', label: 'DeepSeek 搜索 API', refExample: 'DEEPSEEK_API_KEY' },
	{ kind: 'tavily', label: 'Tavily Key', refExample: 'TAVILY_API_KEY' },
]

/** 判断「朴素对象」。 */
function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 默认文档：**两条都播种**，`TAVILY_API_KEY1` → `TAVILY_API_KEY2`（2026-09-29 用户选定）。
 *
 * 等于旧设计「两个 Tavily key + 官方兜底」的韧性：一把 key 死了还能用另一把，
 * 不会直接掉到"花官方钱"那一档。界面里可以随时删掉不想要的那条。
 *
 * ⚠️ 这里**刻意不播种 yuanbao 源**：SecretId 是用户自己的凭据，不能写进包的默认值里
 * （会随 npm 包/仓库外泄，也会让「删掉后又被默认值复活」）。元宝源由界面添加，
 * 或由部署时的种子配置写进 `$DSH_HOME\web-search-chain.json`。
 *
 * ⚠️ 最初只播种 key2，依据是「profile 补丁里 `web-search-source-key1` 那条行早已被停用」
 * （当时 624/630 次搜索由 key2 服务）。**该依据后来被证伪**：审计日志显示
 * 2026-09-29 20:53–22:13 全部是 `served slot=key1 / credentialRef=TAVILY_API_KEY1`，
 * 而文件里那一刻明明写着 `disabled: true` ⇒ **「文件里的状态」与「进程内实际生效的状态」
 * 会不一致**（override 写进文件但没热生效）。所以不再据此推断用户意图，改成两条都播。
 */
export function defaultDocument() {
	// 默认播种「一个 Tavily 源 + 两把 key」= 三级模型（源 → key → 额度）的样例：
	// key1 用完自动换 key2，两把都完了才轮到下一个源。
	return {
		version: DOCUMENT_VERSION,
		sources: [
			{
				id: 's1',
				kind: 'tavily',
				keys: [
					{ id: 'k1', mode: 'env', ref: 'TAVILY_API_KEY1' },
					{ id: 'k2', mode: 'env', ref: 'TAVILY_API_KEY2' },
				],
			},
		],
	}
}

/** 空文档：用户明确不要任何源（与「文件不存在」语义不同）。 */
export function emptyDocument() {
	return { version: DOCUMENT_VERSION, sources: [] }
}

//#region 额度（北京时间自然月）
/**
 * 北京时间的日期键 `YYYY-MM-DD`。
 *
 * 元宝的免费额度按**自然月**重置，账单/活动期都以北京时间为准（活动截止 2026-11-30 是北京时间），
 * 所以本地计数必须用北京时间切月，不能用 UTC（UTC+0 会把每月最后 8 小时算进下个月）。
 * 中国不实行夏令时 ⇒ 固定 +8 小时是精确的，不需要 Intl/时区库。
 *
 * @param nowMs - 毫秒时间戳。
 */
export function beijingDateKey(nowMs) {
	return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 北京时间的月份键 `YYYY-MM`（额度计数的桶）。 */
export function beijingMonthKey(nowMs) {
	return beijingDateKey(nowMs).slice(0, 7)
}

/** 上一个月份键（`YYYY-MM` 可直接按字符串比较大小）。 */
export function previousMonthKey(monthKey) {
	const [year, month] = monthKey.split('-').map(Number)
	return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`
}

/** 某个模板的默认预算；`undefined` = 不限（Tavily 的套餐限额由它自己返回 432 回答我们）。 */
export function defaultBudgetFor(kind) {
	if (kind !== 'yuanbao') return undefined
	// 2026-10-22 用户口径：日常 2000 次/自然月/UIN；限时活动（2026-10-10 ~ 2026-11-30 北京时间）6000 次。
	// 活动额度写进带到期日的 `promo`，**过了 2026-11-30 自动降回 2000**，不靠人记得改配置。
	// reserve 100：本地计数可能低估（别处也用同一个 SecretId 调过、写盘失败等），留一点余量。
	return {
		monthly: 2000,
		reserve: 100,
		promo: { monthly: 6000, until: '2026-11-30' },
	}
}

/**
 * 归一化一个预算对象；非法返回 `undefined`（调用方据此报错，绝不静默改造用户输入）。
 *
 * @param raw - 形如 `{monthly, reserve, promo?: {monthly, until}}`。
 * @returns 归一化后的预算，或 `undefined` 表示非法。
 */
export function normalizeBudget(raw) {
	if (!isPlainObject(raw)) return undefined
	const monthly = raw.monthly
	if (!Number.isInteger(monthly) || monthly < 0 || monthly > MAX_MONTHLY_BUDGET) return undefined
	const reserve = raw.reserve === undefined ? 0 : raw.reserve
	if (!Number.isInteger(reserve) || reserve < 0 || reserve > MAX_MONTHLY_BUDGET) return undefined
	if (monthly === 0) {
		// 0 = 不限；这时 reserve 没有意义，但**不接受**用户填一个非零值（那说明他理解错了）
		if (reserve !== 0) return undefined
		return { monthly: 0, reserve: 0 }
	}
	if (reserve > monthly) return undefined
	const budget = { monthly, reserve }
	if (raw.promo !== undefined) {
		if (!isPlainObject(raw.promo)) return undefined
		const promoMonthly = raw.promo.monthly
		const until = raw.promo.until
		if (!Number.isInteger(promoMonthly) || promoMonthly < 1 || promoMonthly > MAX_MONTHLY_BUDGET) return undefined
		if (typeof until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return undefined
		// 必须是真实存在的日期（拒绝 2026-02-31 这种能过正则的假日期）
		const parsed = new Date(`${until}T00:00:00Z`)
		if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== until) return undefined
		budget.promo = { monthly: promoMonthly, until }
	}
	return budget
}

/**
 * 一个源的计费单位：文档里显式写的优先，否则按模板取默认（元宝/DS=按次，Tavily=按 credit）。
 *
 * **一个源就是一份账单**：它的所有 key 都按这个单位计量（所以额度闸门、显示、换算都用同一个单位）。
 * @param source - 文档里的源（可带 `billing: {unit, pricePer1000?}`）。
 */
export function sourceUnit(source) {
	const unit = source?.billing?.unit
	if (BILLING_UNITS.includes(unit)) return unit
	return DEFAULT_UNIT_BY_KIND[source?.kind] ?? 'calls'
}

/**
 * 某个 key 的有效额度：key 上写了的优先，否则取该源模板的默认额度。
 *
 * 为什么默认值挂在 key 上而不是源上：额度是**按 key 单独结算**的（每个 key 一份账单），
 * 源级数字只是它的汇总。
 * @param source - 该 key 所属的源（提供 `kind`）。
 * @param key - 该 key（可带 `budget`）。
 */
export function keyBudget(source, key) {
	if (key?.budget !== undefined) return key.budget
	return defaultBudgetFor(source?.kind)
}

/**
 * 当前生效的月度额度：活动期内用 `promo.monthly`，活动结束后用 `monthly`。
 *
 * @param budget - 预算对象。
 * @param nowMs - 毫秒时间戳（测试注入用）。
 */
export function effectiveMonthly(budget, nowMs) {
	if (budget === undefined) return undefined
	const promoActive = budget.promo !== undefined && beijingDateKey(nowMs) <= budget.promo.until
	return { monthly: promoActive ? budget.promo.monthly : budget.monthly, promoActive }
}

/**
 * **v2 形状的便利函数**：源上直接挂 `budget` 时的有效额度（等价于 `keyBudget(source, source)`）。
 * 三级模型下额度挂在 key 上，新代码请用 `keyBudget(source, key)`。
 */
export function effectiveBudget(source) {
	if (source?.budget !== undefined) return source.budget
	return defaultBudgetFor(source?.kind)
}

/**
 * 一次搜索前要看的额度状态（**针对单个 key**）。
 *
 * 语义要点：
 * 1. **`reserve` 是「不用的余量」**：可用 = monthly − reserve。
 * 2. `monthly: 0` 表示**不限**（`unlimited: true`），此时 `remaining` 是 `null` 而不是 Infinity
 *    （Infinity 过不了 JSON，界面会拿到 null）。
 * 3. 判据是 `used >= 可用` ⇒ `exhausted`，**到点即停**（宁可在 1999 次停，也不要在 2001 次花 2.8 倍的钱）。
 *
 * @param budget - **已解析好的**预算（`keyBudget(source, key)` 的结果；undefined = 不限）。
 * @param used - 本月已用（单位由调用方决定：按次或按 credit）。
 * @param nowMs - 毫秒时间戳（测试注入用）。
 */
export function budgetStatus(budget, used, nowMs = Date.now()) {
	// 兼容：老调用方直接把"源"当第一个参数传进来（v2 形状）⇒ 就地解析它的额度
	const resolved = budget !== undefined && budget.kind !== undefined && budget.monthly === undefined ? effectiveBudget(budget) : budget
	const usedCount = Number.isInteger(used) && used >= 0 ? used : 0
	if (resolved === undefined || resolved.monthly === 0) {
		return { unlimited: true, monthly: null, reserve: 0, used: usedCount, remaining: null, exhausted: false, promo: null }
	}
	const effective = effectiveMonthly(resolved, nowMs)
	const monthly = effective.monthly
	const reserve = Math.min(resolved.reserve ?? 0, monthly)
	const usable = Math.max(0, monthly - reserve)
	return {
		unlimited: false,
		monthly,
		reserve,
		used: usedCount,
		remaining: Math.max(0, usable - usedCount),
		exhausted: usedCount >= usable,
		promo:
			resolved.promo === undefined
				? null
				: { monthly: resolved.promo.monthly, until: resolved.promo.until, active: effective.promoActive },
	}
}
//#endregion

//#region 用量文档（本地账本；腾讯云没有查配额接口，Tavily 有 /usage）
/**
 * 用量文档版本。
 *
 * v1：`{months:{YYYY-MM:{s1: 3}}}`（只有调用次数）
 * v2：`{months:{YYYY-MM:{s1: {calls: 3, credits: 5}}}}`（多一个"计费单位"）
 *
 * 为什么 v2 要记 credits：Tavily 按 **credit** 计量（basic 搜索 1、advanced 2），一次调用不等于一个额度；
 * 元宝 / DS 搜索 API 按**调用次数**计费，credits 恒等于 calls（不写这个字段）。
 */
export const USAGE_VERSION = 2

/** 空用量文档。 */
export function emptyUsageDocument() {
	return { version: USAGE_VERSION, months: {} }
}

/**
 * 解析用量文档文本。**任何问题都不抛**：坏数据当成「没用过」比让搜索挂掉好。
 * 形状不对但能读的月份/计数会被丢弃（只保留合法的）。v1 的数字按 `{calls}` 读入。
 *
 * @param text - 文件内容。
 * @returns `{doc, error}`；`doc` 恒可用。
 */
export function parseUsageText(text) {
	if (typeof text !== 'string') return { doc: emptyUsageDocument(), error: 'usage is not text' }
	let parsed
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		return { doc: emptyUsageDocument(), error: `usage is not valid JSON: ${String(error)}` }
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.months)) {
		return { doc: emptyUsageDocument(), error: 'usage must be an object with a months object' }
	}
	const months = {}
	for (const [month, counters] of Object.entries(parsed.months)) {
		if (!/^\d{4}-\d{2}$/.test(month) || !isPlainObject(counters)) continue
		const clean = {}
		for (const [id, value] of Object.entries(counters)) {
			if (!ID_PATTERN.test(id)) continue
			// v1：数字 = 调用次数；v2：`{calls, credits}`（缺哪个都行）
			const entry = Number.isInteger(value)
				? value >= 0
					? { calls: value }
					: undefined
				: isPlainObject(value)
					? {
							...(Number.isInteger(value.calls) && value.calls >= 0 ? { calls: value.calls } : {}),
							...(Number.isInteger(value.credits) && value.credits >= 0 ? { credits: value.credits } : {}),
						}
					: undefined
			if (entry === undefined) continue
			if (entry.calls === undefined && entry.credits === undefined) continue
			clean[id] = entry
		}
		months[month] = clean
	}
	return { doc: { version: USAGE_VERSION, months }, error: undefined }
}

/** 序列化用量文档：稳定 2 空格缩进 + 末尾一个换行。 */
export function serializeUsageDocument(doc) {
	return `${JSON.stringify({ version: USAGE_VERSION, months: doc.months }, null, 2)}\n`
}

/** 某月某源的账本条目 `{calls, credits}`（没有就是两个 0）。 */
export function usageEntry(doc, month, sourceId) {
	const value = doc?.months?.[month]?.[sourceId]
	if (Number.isInteger(value) && value >= 0) return { calls: value, credits: 0 }
	return {
		calls: Number.isInteger(value?.calls) && value.calls >= 0 ? value.calls : 0,
		credits: Number.isInteger(value?.credits) && value.credits >= 0 ? value.credits : 0,
	}
}

/** 读某月某源的已用调用次数（没有就是 0）。 */
export function usageCount(doc, month, sourceId) {
	return usageEntry(doc, month, sourceId).calls
}

/** 读某月某源的已用 credit 数（没有就是 0；元宝这类按次计费的源恒为 0）。 */
export function usageCredits(doc, month, sourceId) {
	return usageEntry(doc, month, sourceId).credits
}

/**
 * 写某月某源的账本条目，并**只保留本月与上月**（其余月份丢掉，文件不会长胖）。
 *
 * @param doc - 当前用量文档。
 * @param month - `YYYY-MM`。
 * @param sourceId - 源 id。
 * @param patch - 要覆盖的字段（`calls` / `credits`；非法值忽略）。
 * @returns 新的用量文档（不原地改）。
 */
function withUsageEntry(doc, month, sourceId, patch) {
	if (!/^\d{4}-\d{2}$/.test(month) || !ID_PATTERN.test(sourceId)) return doc
	const hasCalls = Number.isInteger(patch.calls) && patch.calls >= 0
	const hasCredits = Number.isInteger(patch.credits) && patch.credits >= 0
	if (!hasCalls && !hasCredits) return doc
	const current = usageEntry(doc, month, sourceId)
	const calls = Number.isInteger(patch.calls) && patch.calls >= 0 ? patch.calls : current.calls
	const credits = Number.isInteger(patch.credits) && patch.credits >= 0 ? patch.credits : current.credits
	// 只写非 0 的字段：元宝这类按次计费的源永远不出现 credits，文件更小也更好读
	const next = {}
	if (calls > 0) next.calls = calls
	if (credits > 0) next.credits = credits
	if (Object.keys(next).length === 0) return doc
	const keep = new Set([month, previousMonthKey(month)])
	const months = {}
	for (const [key, counters] of Object.entries(doc?.months ?? {})) {
		if (!keep.has(key)) continue
		months[key] = { ...counters }
	}
	const bucket = { ...(months[month] ?? {}) }
	bucket[sourceId] = next
	months[month] = bucket
	return { version: USAGE_VERSION, months }
}

/** 写入某月某源的已用**调用次数**（credits 保持不变）。 */
export function withUsageCount(doc, month, sourceId, value) {
	return withUsageEntry(doc, month, sourceId, { calls: value })
}

/** 写入某月某源的已用 **credit**（调用次数保持不变）。 */
export function withUsageCredits(doc, month, sourceId, value) {
	return withUsageEntry(doc, month, sourceId, { credits: value })
}
//#endregion

/**
 * 解析文档里一个 **key** 的形状（v3：额度挂在 key 上）。
 * @returns `{key}` 或 `{error}`。
 */
function parseKeyRow(raw, kind, at) {
	if (!isPlainObject(raw)) return { error: `${at} must be an object` }
	if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return { error: `${at}.id is invalid` }
	if (raw.mode !== 'env' && raw.mode !== 'literal') return { error: `${at}.mode must be "env" or "literal"` }
	if (typeof raw.ref !== 'string' || raw.ref.length > MAX_REF_LENGTH || !REF_PATTERN.test(raw.ref)) {
		return { error: `${at}.ref is invalid` }
	}
	const key = { id: raw.id, mode: raw.mode, ref: raw.ref }
	if (kind === 'yuanbao') {
		const secretId = typeof raw.secretId === 'string' ? raw.secretId.trim() : ''
		if (!SECRET_ID_PATTERN.test(secretId)) return { error: `${at}.secretId is invalid` }
		key.secretId = secretId
	}
	if (raw.budget !== undefined) {
		const budget = normalizeBudget(raw.budget)
		if (budget === undefined) return { error: `${at}.budget is invalid` }
		key.budget = budget
	}
	if (raw.disabled !== undefined) {
		if (typeof raw.disabled !== 'boolean') return { error: `${at}.disabled must be a boolean` }
		if (raw.disabled) key.disabled = true
	}
	return { key }
}

/** 解析源的计费方式（`{unit, pricePer1000?}`）；非法返回 `{error}`。 */
function parseBillingRow(raw, at) {
	if (!isPlainObject(raw)) return { error: `${at} must be an object` }
	const billing = {}
	if (raw.unit !== undefined) {
		if (!BILLING_UNITS.includes(raw.unit)) return { error: `${at}.unit must be one of ${BILLING_UNITS.join('/')}` }
		billing.unit = raw.unit
	}
	if (raw.pricePer1000 !== undefined) {
		if (typeof raw.pricePer1000 !== 'number' || !Number.isFinite(raw.pricePer1000) || raw.pricePer1000 < 0) {
			return { error: `${at}.pricePer1000 must be a non-negative number` }
		}
		billing.pricePer1000 = raw.pricePer1000
	}
	return { billing: Object.keys(billing).length === 0 ? undefined : billing }
}

/**
 * **v2 → v3 迁移**：v2 的每个源（一个源一把 key）变成一个「单 key 源」。
 *
 * 关键点：**key id 沿用旧源 id**（`s1`/`s2`…）⇒ 本地账本（按 id 计数）与运行时状态（按 id 记失败）
 * 都不需要动，历史用量的对应关系原样保留。
 *
 * @param rawSources - v2 文档里的 `sources` 数组。
 * @returns v3 形状的源数组（未做校验，交给后面的统一校验）。
 */
export function migrateV2Sources(rawSources) {
	return rawSources.map((raw) => {
		if (!isPlainObject(raw)) return raw
		const key = { id: raw.id, mode: raw.mode, ref: raw.ref }
		if (typeof raw.secretId === 'string') key.secretId = raw.secretId
		if (raw.budget !== undefined) key.budget = raw.budget
		// 原样带过去（哪怕是非法值），交给统一校验去报错，避免静默丢弃
		if (raw.disabled !== undefined) key.disabled = raw.disabled
		return { id: raw.id, kind: raw.kind, keys: [key] }
	})
}

/**
 * 解析文档文本。**任何问题都返回 `{doc: 默认文档, error}`，绝不抛** ——
 * 搜索链路每次搜索都调这里，它抛错就等于 web_search 挂掉。
 *
 * v3 形状：`{version:3, sources:[{id, kind, label?, billing?, disabled?, keys:[{id, mode, ref, secretId?, budget?, disabled?}]}]}`；
 * 读到 v2（源上直接挂 mode/ref/budget）会**自动迁移**，并把 key id 设成原来的源 id。
 */
export function parseDocumentText(text) {
	if (typeof text !== 'string') return { doc: defaultDocument(), error: 'configuration is not text' }
	if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) {
		return { doc: defaultDocument(), error: `configuration exceeds ${MAX_DOCUMENT_BYTES} bytes` }
	}
	let parsed
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		return { doc: defaultDocument(), error: `configuration is not valid JSON: ${String(error)}` }
	}
	if (!isPlainObject(parsed)) return { doc: defaultDocument(), error: 'configuration must be a JSON object' }
	if (!Array.isArray(parsed.sources)) return { doc: defaultDocument(), error: 'configuration.sources must be an array' }
	// v2 判定：显式 version===2，或（没有 version 且源上直接带 mode/ref 而没有 keys）
	const isV2 = parsed.version === 2 || parsed.sources.some((raw) => isPlainObject(raw) && raw.keys === undefined && raw.mode !== undefined)
	const rawSources = isV2 ? migrateV2Sources(parsed.sources) : parsed.sources
	if (rawSources.length > MAX_SOURCES) {
		return { doc: defaultDocument(), error: `configuration lists more than ${MAX_SOURCES} sources` }
	}
	const sources = []
	for (const [sourceIndex, raw] of rawSources.entries()) {
		const atSource = `configuration.sources[${sourceIndex}]`
		if (!isPlainObject(raw)) return { doc: defaultDocument(), error: `${atSource} must be an object` }
		if (!TEMPLATES.some((template) => template.kind === raw.kind)) {
			return { doc: defaultDocument(), error: `${atSource}.kind is not a known template` }
		}
		if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
			return { doc: defaultDocument(), error: `${atSource}.id is invalid` }
		}
		if (!Array.isArray(raw.keys)) return { doc: defaultDocument(), error: `${atSource}.keys must be an array` }
		if (raw.keys.length === 0) return { doc: defaultDocument(), error: `${atSource}.keys must not be empty` }
		if (raw.keys.length > MAX_KEYS) return { doc: defaultDocument(), error: `${atSource}.keys lists more than ${MAX_KEYS} keys` }
		const source = { id: raw.id, kind: raw.kind, keys: [] }
		if (raw.label !== undefined) {
			if (typeof raw.label !== 'string' || raw.label.length > 64) return { doc: defaultDocument(), error: `${atSource}.label is invalid` }
			if (raw.label.length > 0) source.label = raw.label
		}
		if (raw.billing !== undefined) {
			const parsedBilling = parseBillingRow(raw.billing, `${atSource}.billing`)
			if (parsedBilling.error !== undefined) return { doc: defaultDocument(), error: parsedBilling.error }
			if (parsedBilling.billing !== undefined) source.billing = parsedBilling.billing
		}
		if (raw.disabled !== undefined) {
			if (typeof raw.disabled !== 'boolean') return { doc: defaultDocument(), error: `${atSource}.disabled must be a boolean` }
			if (raw.disabled) source.disabled = true
		}
		for (const [keyIndex, rawKey] of raw.keys.entries()) {
			const keyPath = isV2 ? atSource : `${atSource}.keys[${keyIndex}]`
			const parsedKey = parseKeyRow(rawKey, raw.kind, keyPath)
			if (parsedKey.error !== undefined) return { doc: defaultDocument(), error: parsedKey.error }
			source.keys.push(parsedKey.key)
		}
		sources.push(source)
	}
	const ids = new Set()
	const keyIds = new Set()
	const refs = new Set()
	for (const source of sources) {
		if (ids.has(source.id)) return { doc: defaultDocument(), error: `configuration repeats source id ${JSON.stringify(source.id)}` }
		ids.add(source.id)
		for (const key of source.keys) {
			if (keyIds.has(key.id)) return { doc: defaultDocument(), error: `configuration repeats key id ${JSON.stringify(key.id)}` }
			if (refs.has(key.ref)) return { doc: defaultDocument(), error: `configuration repeats credential reference ${JSON.stringify(key.ref)}` }
			keyIds.add(key.id)
			refs.add(key.ref)
		}
	}
	return { doc: { version: DOCUMENT_VERSION, sources }, error: undefined }
}

/** 序列化文档：稳定 2 空格缩进 + 末尾一个换行（version 恒由本函数写死）。 */
export function serializeDocument(doc) {
	// 容错：调用方若还递 v2 形状（源上直接挂 mode/ref），先迁成三级结构再写，绝不写坏文件
	const list = (doc.sources ?? []).some((source) => !Array.isArray(source.keys)) ? migrateV2Sources(doc.sources ?? []) : doc.sources ?? []
	const sources = list.map((source) => {
		const row = { id: source.id, kind: source.kind }
		if (typeof source.label === 'string' && source.label.length > 0) row.label = source.label
		if (source.billing !== undefined) row.billing = source.billing
		if (source.disabled === true) row.disabled = true
		row.keys = source.keys.map((key) => {
			const keyRow = { id: key.id, mode: key.mode, ref: key.ref }
			if (source.kind === 'yuanbao' && typeof key.secretId === 'string') keyRow.secretId = key.secretId
			if (key.budget !== undefined) keyRow.budget = key.budget
			if (key.disabled === true) keyRow.disabled = true
			return keyRow
		})
		return row
	})
	return `${JSON.stringify({ version: DOCUMENT_VERSION, sources }, null, 2)}\n`
}

/** 在 `usedIds` 之外取最小的 `sN`。 */
export function nextIdIn(usedIds) {
	for (let n = 1; n <= MAX_SOURCES + 1; n += 1) {
		const candidate = `s${n}`
		if (!usedIds.has(candidate)) return candidate
	}
	return `s${Date.now()}`
}

/** 在 `usedIds` 之外取最小的 `kN`（key 的 id 在**整份文档**里唯一）。 */
export function nextKeyIdIn(usedIds) {
	for (let n = 1; n <= MAX_SOURCES * MAX_KEYS + 1; n += 1) {
		const candidate = `k${n}`
		if (!usedIds.has(candidate)) return candidate
	}
	return `k${Date.now()}`
}

/** 在 `usedRefs` 之外取最小的 `WEB_SEARCH_TAVILY_<n>`。 */
export function nextRefIn(usedRefs) {
	for (let n = 1; n <= MAX_SOURCES * MAX_KEYS + 1; n += 1) {
		const candidate = `${LITERAL_REF_PREFIX}${n}`
		if (!usedRefs.has(candidate)) return candidate
	}
	return `${LITERAL_REF_PREFIX}${Date.now()}`
}

/** 造一个校验失败结果。 */
function failure(code, message, field) {
	return { ok: false, code, message, ...(field === undefined ? {} : { field }) }
}

/**
 * 校验一次提交并归一成「下一份文档」（v3：源 → key → key 上的额度）。
 *
 * 要点：
 * 1. **id 决定身份**：源 id 在源之间唯一、key id 在**整份文档**里唯一；明文 key 的引用名按 key id 沿用，
 *    增删别的源/键不会让它漂移（漂了就对不上已存的密钥）。
 * 2. **明文 key 的 `ref` 由服务端决定**（忽略请求里的值）：新的分配最小 `WEB_SEARCH_TAVILY_<n>`，避免撞名与伪造。
 * 3. **全量校验在前**：任何一项不过就返回失败，调用方据此做到「一个字节都不写」。
 * 4. `yuanbao` 的 key 必须带 SecretId；额度挂在 key 上，带了就按 `normalizeBudget` 全量校验（不做静默 clamp）。
 *
 * @param body - POST 的 JSON 体。
 * @param previousDoc - 当前文档（沿用引用名用）。
 * @returns `{ok:true, sources, secrets}` 或 `{ok:false, code, message, field?}`
 */
export function validateSubmission(body, previousDoc) {
	if (!isPlainObject(body)) return failure('INVALID_CONFIG', '请求体必须是一个 JSON 对象')
	const rawSources = body.sources
	if (!Array.isArray(rawSources)) return failure('INVALID_CONFIG', 'sources 必须是数组', 'sources')
	if (rawSources.length > MAX_SOURCES) {
		return failure('TOO_MANY_SOURCES', `最多只能有 ${MAX_SOURCES} 个搜索源`, 'sources')
	}

	const previousKeysById = new Map()
	for (const source of previousDoc?.sources ?? []) {
		// v2 旧文档没有 keys：源本身就是那把 key
		for (const key of source.keys ?? [{ id: source.id, mode: source.mode, ref: source.ref }]) previousKeysById.set(key.id, key)
	}
	const sources = []
	const secrets = []
	const usedSourceIds = new Set()
	const usedKeyIds = new Set()
	const usedRefs = new Set()

	for (const [sourceIndex, raw] of rawSources.entries()) {
		const atSource = (name) => `sources[${sourceIndex}].${name}`
		if (!isPlainObject(raw)) return failure('INVALID_CONFIG', `sources[${sourceIndex}] 必须是对象`, `sources[${sourceIndex}]`)
		// 兼容 v2 提交形状（`mode`/`ref`/`budget` 直接挂在源上、没有 keys）：当成"一个源一把 key"。
		// 界面已经改成三级模型，但手写 JSON / 老客户端不该因为形状旧而整单失败。
		const legacy = raw.keys === undefined && raw.mode !== undefined
		const rawKeys = legacy
			? [
					{
						id: raw.id,
						mode: raw.mode,
						ref: raw.ref,
						secret: raw.secret,
						secretId: raw.secretId,
						budget: raw.budget,
						disabled: raw.disabled,
					},
				]
			: raw.keys
		if (!TEMPLATES.some((template) => template.kind === raw.kind)) {
			return failure('UNKNOWN_KIND', `不支持的模板 ${JSON.stringify(raw.kind)}`, atSource('kind'))
		}

		let sourceId = raw.id
		if (sourceId !== undefined) {
			if (typeof sourceId !== 'string' || !ID_PATTERN.test(sourceId)) return failure('INVALID_CONFIG', '源 id 非法', atSource('id'))
			if (usedSourceIds.has(sourceId)) return failure('DUPLICATE_ID', `源 id ${JSON.stringify(sourceId)} 重复`, atSource('id'))
		} else {
			sourceId = nextIdIn(usedSourceIds)
		}
		usedSourceIds.add(sourceId)

		const source = { id: sourceId, kind: raw.kind, keys: [] }
		if (raw.label !== undefined) {
			if (typeof raw.label !== 'string' || raw.label.length > 64) return failure('INVALID_CONFIG', 'label 必须是 ≤64 字符的字符串', atSource('label'))
			if (raw.label.length > 0) source.label = raw.label
		}
		if (raw.billing !== undefined) {
			const parsedBilling = parseBillingRow(raw.billing, atSource('billing'))
			if (parsedBilling.error !== undefined) return failure('INVALID_BILLING', parsedBilling.error, atSource('billing'))
			if (parsedBilling.billing !== undefined) source.billing = parsedBilling.billing
		}
		if (raw.disabled !== undefined) {
			// 手动停用（**不是删除**）：源留在文档里、它的 key 全部不参与搜索，随时可以再启用
			if (typeof raw.disabled !== 'boolean') return failure('INVALID_CONFIG', 'disabled 必须是布尔值', atSource('disabled'))
			if (raw.disabled) source.disabled = true
		}

		if (!Array.isArray(rawKeys)) return failure('INVALID_CONFIG', 'keys 必须是数组', atSource('keys'))
		if (rawKeys.length === 0) return failure('INVALID_CONFIG', '每个源至少要有一个 key', atSource('keys'))
		if (rawKeys.length > MAX_KEYS) return failure('TOO_MANY_KEYS', `每个源最多 ${MAX_KEYS} 个 key`, atSource('keys'))

		for (const [keyIndex, rawKey] of rawKeys.entries()) {
			// 兼容 v2 提交（一个源一把 key）时，field 仍指回 sources[i].xxx，老界面/老测试的定位不变
			const atKey = (name) => (legacy ? `sources[${sourceIndex}].${name}` : `sources[${sourceIndex}].keys[${keyIndex}].${name}`)
			if (!isPlainObject(rawKey)) return failure('INVALID_CONFIG', `keys[${keyIndex}] 必须是对象`, `sources[${sourceIndex}].keys[${keyIndex}]`)
			if (rawKey.mode !== 'env' && rawKey.mode !== 'literal') {
				return failure('INVALID_CONFIG', '模式必须是 "env" 或 "literal"', atKey('mode'))
			}
			let keyId = rawKey.id
			if (keyId !== undefined) {
				if (typeof keyId !== 'string' || !ID_PATTERN.test(keyId)) return failure('INVALID_CONFIG', 'key id 非法', atKey('id'))
				if (usedKeyIds.has(keyId)) return failure('DUPLICATE_ID', `key id ${JSON.stringify(keyId)} 重复`, atKey('id'))
			} else {
				keyId = nextKeyIdIn(usedKeyIds)
			}
			usedKeyIds.add(keyId)

			const key = { id: keyId, mode: rawKey.mode }
			if (raw.kind === 'yuanbao') {
				const secretId = typeof rawKey.secretId === 'string' ? rawKey.secretId.trim() : ''
				if (!SECRET_ID_PATTERN.test(secretId)) {
					return failure('INVALID_SECRET_ID', 'SecretId 必填，形如 AKID… 的腾讯云 API 密钥', atKey('secretId'))
				}
				key.secretId = secretId
			}
			if (rawKey.budget !== undefined) {
				const budget = normalizeBudget(rawKey.budget)
				if (budget === undefined) {
					return failure('INVALID_BUDGET', '额度必须是 {monthly, reserve} 非负整数（reserve ≤ monthly；monthly=0 表示不限）', atKey('budget'))
				}
				key.budget = budget
			}
			if (rawKey.disabled !== undefined) {
				if (typeof rawKey.disabled !== 'boolean') return failure('INVALID_CONFIG', 'disabled 必须是布尔值', atKey('disabled'))
				if (rawKey.disabled) key.disabled = true
			}

			if (rawKey.mode === 'env') {
				const ref = typeof rawKey.ref === 'string' ? rawKey.ref.trim() : ''
				if (ref.length === 0) return failure('INVALID_REF', '环境变量名不能为空', atKey('ref'))
				if (ref.length > MAX_REF_LENGTH || !REF_PATTERN.test(ref)) {
					return failure('INVALID_REF', '环境变量名必须是形如 TENCENTCLOUD_SECRET_KEY 的标识符', atKey('ref'))
				}
				if (usedRefs.has(ref)) return failure('DUPLICATE_REF', `凭据引用 ${JSON.stringify(ref)} 重复`, atKey('ref'))
				usedRefs.add(ref)
				source.keys.push({ ...key, ref })
				continue
			}

			const prior = previousKeysById.get(key.id)
			const ref = prior !== undefined && prior.mode === 'literal' ? prior.ref : nextRefIn(usedRefs)
			if (usedRefs.has(ref)) return failure('DUPLICATE_REF', `凭据引用 ${JSON.stringify(ref)} 重复`, atKey('ref'))
			usedRefs.add(ref)
			if (rawKey.secret !== undefined) {
				if (typeof rawKey.secret !== 'string' || rawKey.secret.length === 0) {
					return failure('INVALID_CONFIG', '明文密钥必须是非空字符串（留空表示保持原值）', atKey('secret'))
				}
				if (rawKey.secret.length > MAX_SECRET_LENGTH) {
					return failure('INVALID_CONFIG', `明文密钥超过 ${MAX_SECRET_LENGTH} 个字符`, atKey('secret'))
				}
				secrets.push({ id: key.id, ref, secret: rawKey.secret })
			}
			source.keys.push({ ...key, ref })
		}
		sources.push(source)
	}

	return { ok: true, sources, secrets }
}

/**
 * 搜索腿的固定顺序：**源按文档顺序，源内 key 按顺序**，最后接官方兜底（若那条行已挂载）。
 *
 * 腿只带「定位」信息（kind / sourceId / keyId / ref）；额度、secretId 这些从文档按 keyId 查，
 * 这样腿序这个概念不必知道 key 的全部字段（也少一处要同步的形状）。
 *
 * 这里只过滤**手动停用**（源或 key 上的 `disabled`）与**自动停用**（运行时状态）；
 * 额度是否用完要读账本，留给宿主在搜索时判断（`quota-exhausted`）。
 *
 * @param sources - 文档里的源（有序，每个带 `keys`）。
 * @param runtime - 运行时状态（按 key id 记失败/自动停用）。
 * @param fallback - 兜底源行的注册表条目；`undefined` = 未挂载。
 */
export function orderedKeyLegs(sources, runtime, fallback) {
	const legs = []
	for (const source of sources) {
		if (source.disabled === true) continue
		for (const key of source.keys ?? []) {
			if (key.disabled === true) continue
			if (autoDisabledOf(runtime, key.id) !== undefined) continue
			legs.push({ kind: source.kind, sourceId: source.id, keyId: key.id, ref: key.ref })
		}
	}
	if (fallback !== undefined) legs.push({ kind: 'deepseek', sourceId: 'deepseek-official', keyId: fallback.slot, ref: fallback.keyRef })
	return legs
}

/**
 * **v2 形状的便利函数**：按文档顺序给出「源级路径」（每条源一条腿，ref 取它的第一把 key）。
 * 三级模型下真正的腿序是 `orderedKeyLegs(sources, runtime, fallback)`（一个源可能有多把 key）。
 * @param sources - 文档里的源（v2 或 v3 形状都行）。
 * @param fallback - 兜底源行的注册表条目；`undefined` = 未挂载。
 */
export function orderedLegs(sources, fallback) {
	const legs = (sources ?? []).map((source) => ({
		kind: source.kind,
		id: source.id,
		ref: source.ref ?? source.keys?.[0]?.ref,
	}))
	if (fallback !== undefined) legs.push({ kind: 'deepseek', id: fallback.slot, ref: fallback.keyRef })
	return legs
}
/** 一个源里**还有可用 key**（手动未停用、也未自动停用）——注意这里不看额度。 */
export function sourceHasUsableKey(source, runtime) {
	if (source.disabled === true) return false
	// 兼容 v2 形状（没有 keys）：源本身就是唯一那把 key
	if (!Array.isArray(source.keys)) return autoDisabledOf(runtime, source.id) === undefined
	return source.keys.some((key) => key.disabled !== true && autoDisabledOf(runtime, key.id) === undefined)
}

/**
 * 参与搜索的源：**手动停用的源**与**所有 key 都不可用的源**都不算。
 * 顺序保持文档顺序 —— 停用只是"跳过"，不是删除，重新启用后回到原位。
 */
export function selectableSources(sources, runtime) {
	return sources.filter((source) => sourceHasUsableKey(source, runtime))
}

//#region 运行时状态：失败计数与「自动停用」（**不是删除**）
/** 运行时状态版本。 */
export const RUNTIME_VERSION = 1
/** 连续多少次「确定性失败」后自动停用一条源。 */
export const AUTO_DISABLE_THRESHOLD = 3

/**
 * 空运行时状态。
 *
 * 与配置文档分开存的两个理由：
 * 1. **不伪造用户意图**：自动停用是"观察到的现象"，用户从未说过要停用；写进配置会让界面误以为是他按的；
 * 2. 搜索路径因此**不必写配置文档**（那是用户的东西），只碰自己的状态文件。
 */
export function emptyRuntimeState() {
	return { version: RUNTIME_VERSION, sources: {} }
}

/**
 * 解析运行时状态。坏数据一律降级成空（搜索不能因为这个文件挂掉）。
 * @param text - 文件内容。
 */
export function parseRuntimeStateText(text) {
	if (typeof text !== 'string') return { state: emptyRuntimeState(), error: 'runtime state is not text' }
	let parsed
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		return { state: emptyRuntimeState(), error: `runtime state is not valid JSON: ${String(error)}` }
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.sources)) {
		return { state: emptyRuntimeState(), error: 'runtime state must be an object with a sources object' }
	}
	const sources = {}
	for (const [id, entry] of Object.entries(parsed.sources)) {
		if (!ID_PATTERN.test(id) || !isPlainObject(entry)) continue
		const clean = {}
		if (Number.isInteger(entry.fails) && entry.fails > 0) clean.fails = entry.fails
		if (typeof entry.autoDisabledAt === 'string') clean.autoDisabledAt = entry.autoDisabledAt
		if (typeof entry.reason === 'string') clean.reason = entry.reason.slice(0, 200)
		if (Object.keys(clean).length > 0) sources[id] = clean
	}
	return { state: { version: RUNTIME_VERSION, sources }, error: undefined }
}

/** 序列化运行时状态（稳定 2 空格缩进 + 末尾换行）。 */
export function serializeRuntimeState(state) {
	return `${JSON.stringify({ version: RUNTIME_VERSION, sources: state.sources }, null, 2)}\n`
}

/** 某源是否被自动停用；是则返回 `{at, reason}`。 */
export function autoDisabledOf(state, id) {
	const entry = state?.sources?.[id]
	return typeof entry?.autoDisabledAt === 'string' ? { at: entry.autoDisabledAt, reason: entry.reason ?? '' } : undefined
}

/**
 * 记一次失败：连续 `AUTO_DISABLE_THRESHOLD` 次「确定性失败」⇒ 打上 `autoDisabledAt`。
 *
 * 只给**确定性失败**（鉴权失败、套餐超限、404 之类）调用：超时/429/5xx 属于暂时性，
 * 记进去会让"网络抖一下"就把源永久摘掉。
 *
 * @param state - 当前运行时状态。
 * @param id - 源 id。
 * @param reason - 失败原因（截断 200 字）。
 * @param nowMs - 毫秒时间戳（测试注入）。
 */
export function recordFailure(state, id, reason, nowMs = Date.now()) {
	const entry = state?.sources?.[id] ?? {}
	const fails = (Number.isInteger(entry.fails) ? entry.fails : 0) + 1
	const next = { ...entry, fails }
	if (fails >= AUTO_DISABLE_THRESHOLD && typeof entry.autoDisabledAt !== 'string') {
		next.autoDisabledAt = new Date(nowMs).toISOString()
		next.reason = String(reason ?? '').slice(0, 200)
	}
	return { version: RUNTIME_VERSION, sources: { ...state.sources, [id]: next } }
}

/** 记一次成功：把失败计数清零（自动停用的标记不该被普通成功清掉——停用的源根本不会跑）。 */
export function recordSuccess(state, id) {
	const entry = state?.sources?.[id]
	if (entry === undefined || (entry.fails === undefined && entry.autoDisabledAt === undefined)) return state
	const next = { ...state.sources }
	if (typeof entry.autoDisabledAt === 'string') {
		// 理论上不会发生（停用的源不参与搜索）；保守地保留停用标记，只清计数
		next[id] = { ...entry, fails: 0 }
	} else {
		delete next[id]
	}
	return { version: RUNTIME_VERSION, sources: next }
}

/** 用户点了「恢复」：清掉该源的自动停用标记与失败计数。 */
export function clearAutoDisable(state, id) {
	if (state?.sources?.[id] === undefined) return state
	const next = { ...state.sources }
	delete next[id]
	return { version: RUNTIME_VERSION, sources: next }
}
//#endregion

/**
 * 这次保存之后应当删除的凭据引用。
 *
 * 两条守卫（缺一不可）：
 * 1. **只碰本插件的命名空间**（`WEB_SEARCH_TAVILY_*`）——用户自己配的环境变量名绝不 unset；
 * 2. 只回收「旧文档里有、新文档里没人再用」的那些。
 *
 * @param previousDoc - 保存前的文档。
 * @param nextSources - 校验通过后的新源列表。
 */
export function unusedRefs(previousDoc, nextSources) {
	// key 级（v3）+ 源级（v2 兼容：源本身就是一把 key）两种形状都收
	const keyRefsOf = (source) => (Array.isArray(source.keys) ? source.keys.map((key) => key.ref) : [source.ref])
	const live = new Set()
	for (const source of nextSources) for (const ref of keyRefsOf(source)) live.add(ref)
	const removed = []
	for (const source of previousDoc.sources) {
		for (const ref of keyRefsOf(source)) {
			if (typeof ref !== 'string' || !ref.startsWith(LITERAL_REF_PREFIX)) continue
			if (live.has(ref)) continue
			if (removed.includes(ref)) continue
			removed.push(ref)
		}
	}
	return removed
}

/**
 * 把尝试记录渲染成一句可操作的失败说明。
 * 文案保持英文（与改动前的链路错误信息一致，模型/日志里已经在读这些串）。
 */
export function describeAttempts(attempts) {
	if (attempts.length === 0) return 'every source row is disabled'
	return attempts
		.map((attempt) => {
			const label = `${attempt.id}${attempt.ref === undefined ? '' : `(${attempt.ref})`}`
			return attempt.message === undefined ? `${label}: ${attempt.outcome}` : `${label}: ${attempt.outcome} (${attempt.message})`
		})
		.join('; ')
}