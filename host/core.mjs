/**
 * web-search-chain 的**纯逻辑层**：零 I/O、零副作用、可离线测试。
 *
 * 这里只放「与 DSH 运行时无关」的判定：文档形状、提交校验、凭据回收、腿序、失败文案。
 * 文件读写在 `config-store.mjs`，运行时接线在 `index-v5.mjs`。
 */

/** 源数量上限（界面与 Host 两侧都按它约束）。 */
export const MAX_SOURCES = 3
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
/** 文档版本（形状变化时用它做迁移分支）。 */
export const DOCUMENT_VERSION = 1
/** 模板表：现在只有 Tavily。加新模板 = 往这张表里加一项 + 在 index-v5 里实现它的腿。 */
export const TEMPLATES = [{ kind: 'tavily', label: 'Tavily Key', refExample: 'TAVILY_API_KEY' }]

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
 * ⚠️ 最初只播种 key2，依据是「profile 补丁里 `web-search-source-key1` 那条行早已被停用」
 * （当时 624/630 次搜索由 key2 服务）。**该依据后来被证伪**：审计日志显示
 * 2026-09-29 20:53–22:13 全部是 `served slot=key1 / credentialRef=TAVILY_API_KEY1`，
 * 而文件里那一刻明明写着 `disabled: true` ⇒ **「文件里的状态」与「进程内实际生效的状态」
 * 会不一致**（override 写进文件但没热生效）。所以不再据此推断用户意图，改成两条都播。
 */
export function defaultDocument() {
	return {
		version: DOCUMENT_VERSION,
		sources: [
			{ id: 's1', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY1' },
			{ id: 's2', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY2' },
		],
	}
}

/** 空文档：用户明确不要任何 Tavily 源（与「文件不存在」语义不同）。 */
export function emptyDocument() {
	return { version: DOCUMENT_VERSION, sources: [] }
}

/**
 * 解析文档文本。**任何问题都返回 `{doc: 默认文档, error}`，绝不抛** ——
 * 搜索链路每次搜索都调这里，它抛错就等于 web_search 挂掉。
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
	if (parsed.sources.length > MAX_SOURCES) {
		return { doc: defaultDocument(), error: `configuration lists more than ${MAX_SOURCES} sources` }
	}
	const sources = []
	for (const [index, raw] of parsed.sources.entries()) {
		if (!isPlainObject(raw)) return { doc: defaultDocument(), error: `configuration.sources[${index}] must be an object` }
		if (!TEMPLATES.some((template) => template.kind === raw.kind)) {
			return { doc: defaultDocument(), error: `configuration.sources[${index}].kind is not a known template` }
		}
		if (raw.mode !== 'env' && raw.mode !== 'literal') {
			return { doc: defaultDocument(), error: `configuration.sources[${index}].mode must be "env" or "literal"` }
		}
		if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
			return { doc: defaultDocument(), error: `configuration.sources[${index}].id is invalid` }
		}
		if (typeof raw.ref !== 'string' || raw.ref.length > MAX_REF_LENGTH || !REF_PATTERN.test(raw.ref)) {
			return { doc: defaultDocument(), error: `configuration.sources[${index}].ref is invalid` }
		}
		sources.push({ id: raw.id, kind: raw.kind, mode: raw.mode, ref: raw.ref })
	}
	const ids = new Set()
	const refs = new Set()
	for (const source of sources) {
		if (ids.has(source.id)) return { doc: defaultDocument(), error: `configuration repeats source id ${JSON.stringify(source.id)}` }
		if (refs.has(source.ref)) return { doc: defaultDocument(), error: `configuration repeats credential reference ${JSON.stringify(source.ref)}` }
		ids.add(source.id)
		refs.add(source.ref)
	}
	return { doc: { version: DOCUMENT_VERSION, sources }, error: undefined }
}

/** 序列化文档：稳定 2 空格缩进 + 末尾一个换行（version 恒由本函数写死）。 */
export function serializeDocument(doc) {
	return `${JSON.stringify({ version: DOCUMENT_VERSION, sources: doc.sources }, null, 2)}\n`
}

/** 在 `usedIds` 之外取最小的 `sN`。 */
export function nextIdIn(usedIds) {
	for (let n = 1; n <= MAX_SOURCES + 1; n += 1) {
		const candidate = `s${n}`
		if (!usedIds.has(candidate)) return candidate
	}
	return `s${Date.now()}`
}

/** 在 `usedRefs` 之外取最小的 `WEB_SEARCH_TAVILY_<n>`。 */
export function nextRefIn(usedRefs) {
	for (let n = 1; n <= MAX_SOURCES + 1; n += 1) {
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
 * 校验一次提交并归一成「下一份文档」。
 *
 * 三条要记住的语义：
 * 1. **源的身份是 `id` 而不是数组下标**：明文源的引用名按 id 沿用，增删别的源不会让它漂移
 *    （漂了就对不上已存的密钥）。
 * 2. **明文源的 `ref` 由服务端决定**（忽略请求里的值）：新源分配最小的
 *    `WEB_SEARCH_TAVILY_<n>`，避免撞名与伪造。
 * 3. **全量校验在前**：任何一项不过就返回失败，调用方据此做到「一个字节都不写」。
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

	const previousById = new Map(previousDoc.sources.map((source) => [source.id, source]))
	const sources = []
	const secrets = []
	const usedIds = new Set()
	const usedRefs = new Set()

	for (const [index, raw] of rawSources.entries()) {
		const at = (name) => `sources[${index}].${name}`
		if (!isPlainObject(raw)) return failure('INVALID_CONFIG', `sources[${index}] 必须是对象`, `sources[${index}]`)
		if (!TEMPLATES.some((template) => template.kind === raw.kind)) {
			return failure('UNKNOWN_KIND', `不支持的模板 ${JSON.stringify(raw.kind)}`, at('kind'))
		}
		if (raw.mode !== 'env' && raw.mode !== 'literal') {
			return failure('INVALID_CONFIG', '模式必须是 "env" 或 "literal"', at('mode'))
		}

		let id = raw.id
		if (id !== undefined) {
			if (typeof id !== 'string' || !ID_PATTERN.test(id)) return failure('INVALID_CONFIG', '源 id 非法', at('id'))
			if (usedIds.has(id)) return failure('DUPLICATE_ID', `源 id ${JSON.stringify(id)} 重复`, at('id'))
		} else {
			id = nextIdIn(usedIds)
		}
		usedIds.add(id)

		if (raw.mode === 'env') {
			const ref = typeof raw.ref === 'string' ? raw.ref.trim() : ''
			if (ref.length === 0) return failure('INVALID_REF', '环境变量名不能为空', at('ref'))
			if (ref.length > MAX_REF_LENGTH || !REF_PATTERN.test(ref)) {
				return failure('INVALID_REF', '环境变量名必须是形如 TAVILY_API_KEY 的标识符', at('ref'))
			}
			if (usedRefs.has(ref)) return failure('DUPLICATE_REF', `凭据引用 ${JSON.stringify(ref)} 重复`, at('ref'))
			usedRefs.add(ref)
			sources.push({ id, kind: raw.kind, mode: 'env', ref })
			continue
		}

		const prior = previousById.get(id)
		const ref = prior !== undefined && prior.mode === 'literal' ? prior.ref : nextRefIn(usedRefs)
		if (usedRefs.has(ref)) return failure('DUPLICATE_REF', `凭据引用 ${JSON.stringify(ref)} 重复`, at('ref'))
		usedRefs.add(ref)
		if (raw.secret !== undefined) {
			if (typeof raw.secret !== 'string' || raw.secret.length === 0) {
				return failure('INVALID_CONFIG', '明文密钥必须是非空字符串（留空表示保持原值）', at('secret'))
			}
			if (raw.secret.length > MAX_SECRET_LENGTH) {
				return failure('INVALID_CONFIG', `明文密钥超过 ${MAX_SECRET_LENGTH} 个字符`, at('secret'))
			}
			secrets.push({ id, ref, secret: raw.secret })
		}
		sources.push({ id, kind: raw.kind, mode: 'literal', ref })
	}

	return { ok: true, sources, secrets }
}

/**
 * 搜索腿的固定顺序：文档里的源按序，最后接官方兜底（若那条行已挂载）。
 * @param sources - 文档里的源（有序）。
 * @param fallback - 兜底源行的注册表条目；`undefined` = 未挂载。
 */
export function orderedLegs(sources, fallback) {
	const legs = sources.map((source) => ({ kind: source.kind, id: source.id, ref: source.ref }))
	if (fallback !== undefined) legs.push({ kind: 'deepseek', id: fallback.slot, ref: fallback.keyRef })
	return legs
}

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
	const live = new Set(nextSources.map((source) => source.ref))
	const removed = []
	for (const source of previousDoc.sources) {
		if (!source.ref.startsWith(LITERAL_REF_PREFIX)) continue
		if (live.has(source.ref)) continue
		if (removed.includes(source.ref)) continue
		removed.push(source.ref)
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
