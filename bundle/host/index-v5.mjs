/**
 * Web search provider chain for DSH.
 *
 * Tavily 源（0~3 个）+ 官方 DeepSeek 搜索兜底。与旧版的唯一区别是**源从哪来**：
 * 旧版把源做成了三条 loader 行（key1/key2/deepseek）并在进程内注册表里发布；
 * 现在 **Tavily 源列表由配置文件决定**（`$DSH_HOME\web-search-chain.json`，界面是唯一真源），
 * 链路**每次搜索都重读**该文件 —— 一次 `statSync` + 一次小文件读取换掉整类「缓存失效/热更新」bug。
 *
 * 官方兜底仍是一条 loader 行（`web-search-source-deepseek`），因为它同时是**花钱总开关**：
 * 关掉那行就不花官方钱。
 *
 * 本模块刻意**零 `@deepseek-ai/*` 静态依赖**（只用 `node:*` 与自身相对路径），
 * profile 解析器因此不必为这些行映射裸 specifier；官方 provider 通过**懒动态 import** 复用，
 * 拿不到时 Tavily 腿照常工作、只有最后一条腿报错。
 *
 * 审计：每个动作一行 JSON 追加到 `<DSH_HOME>\web-search-chain.log` —— 唯一能证明
 * 「哪条源服务了、什么时候花了官方钱」的 durable 记录。
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	MAX_SOURCES,
	REF_PATTERN,
	TEMPLATES,
	defaultDocument,
	describeAttempts,
	orderedLegs,
	unusedRefs,
	validateSubmission,
} from './core.mjs'
import { configDocumentPath, readConfigDocument, writeConfigDocument } from './config-store.mjs'

export const name = 'web-search-chain'
export const inject = ['web']

/** 官方兜底那条行在注册表里的槽位名。 */
const FALLBACK_SLOT = 'deepseek'
/** 兜底引用名的缺省值（官方 provider 的 keyRef）。 */
const DEFAULT_FALLBACK_REF = 'DEEPSEEK_API_KEY'
/** Tavily 端点缺省值；`/search` 由本模块拼。 */
const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'
/** 官方 DeepSeek Anthropic 兼容端点缺省值；`/messages` 由官方 provider 拼。 */
const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'
/** Tavily 请求的 UA。 */
const USER_AGENT = 'deepseek-harness-search-chain/2.0.0'
const SEARCH_DEPTHS = ['advanced', 'basic', 'fast', 'ultra-fast']
const TOPICS = ['general', 'news', 'finance']

/** 已挂载的兜底源行（槽位 → 条目）。与旧版一样，同一模块 URL 的多个行共享这一份注册表。 */
const enabledFallback = new Map()

/** 尽最大努力写一条 warn：日志本身绝不许打穿调用方。 */
function warn(ctx, message) {
	try {
		ctx.logger?.warn?.(message)
	} catch {
		// 日志失败不影响功能
	}
}

/** DSH home；测试通过 `DSH_HOME` 指到临时目录，绝不碰真的 `~\.dsh`。 */
function homeDir() {
	return process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
}

/** 配置文档路径（每次调用都重新解析 env，便于测试注入）。 */
export function configPath() {
	return configDocumentPath(homeDir())
}

/** 审计日志路径。 */
function auditFile() {
	return join(homeDir(), 'web-search-chain.log')
}

/**
 * Provider 失败，带 web seam 那个稳定的机器可路由 `code`。
 * 本地定义，避免为 seam 的错误类引一个裸 specifier。
 */
class ChainError extends Error {
	/**
	 * @param message - 人类可读的失败文本。
	 * @param code - 消费者据此路由的稳定码（如 `WEB_PROVIDER_ERROR`）。
	 * @param options - 标准 `Error` 选项（携带 `cause`）。
	 */
	constructor(message, code, options) {
		super(message, options)
		this.code = code
	}
}

/** 读一个可选的非空字符串。 */
function optionalString(value) {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 把可选整数字段夹到合理范围，不可用时回退。 */
function clampInteger(value, min, max, fallback) {
	return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

/**
 * 归一化兜底源行。**现在只剩这一种源行** —— Tavily 源由配置文档决定，
 * 再看到 `slot: key1/key2` 这类写法就是旧配置没清干净，直接报错让它可见。
 * @param config - 该行的原始 config。
 * @returns 该槽位的注册表条目。
 */
function normalizeSource(config) {
	const source = config ?? {}
	const slot = optionalString(source.slot)
	if (slot !== FALLBACK_SLOT) {
		throw new Error(
			`web-search-chain: a source row must declare slot: "${FALLBACK_SLOT}" (got ${JSON.stringify(source.slot)}); Tavily sources now come from the configuration document`,
		)
	}
	return { slot, kind: 'deepseek', keyRef: optionalString(source.keyRef) ?? DEFAULT_FALLBACK_REF }
}

/**
 * 归一化链本体行：provider id + 所有共享传输设置。
 * @param config - 该行的原始 config。
 * @returns 一次链式操作的完整默认化设置。
 */
export function normalizeChain(config) {
	const source = config ?? {}
	const tavily = source.tavily ?? {}
	const deepseek = source.deepseek ?? {}
	const tavilyBaseURL = optionalString(tavily.baseURL) ?? optionalString(source.tavilyBaseURL) ?? TAVILY_DEFAULT_BASE_URL
	return {
		id: optionalString(source.id) ?? 'tavily-chain',
		tavilyBaseURL: tavilyBaseURL.replace(/\/+$/u, ''),
		searchDepth: SEARCH_DEPTHS.includes(tavily.searchDepth) ? tavily.searchDepth : 'basic',
		maxResults: clampInteger(tavily.maxResults, 0, 20, 10),
		topic: TOPICS.includes(tavily.topic) ? tavily.topic : 'general',
		includePublishedDate: tavily.includePublishedDate === true,
		timeoutMs: clampInteger(tavily.timeoutMs, 1, 600000, 30000),
		deepseekBaseURL: optionalString(deepseek.baseURL) ?? optionalString(source.fallbackBaseURL) ?? DEEPSEEK_DEFAULT_BASE_URL,
		deepseekModel: optionalString(deepseek.model) ?? 'deepseek-v4-flash',
		deepseekApiVersion: optionalString(deepseek.apiVersion) ?? '2023-06-01',
		deepseekMaxTokens: clampInteger(deepseek.maxTokens, 1, Number.MAX_SAFE_INTEGER, 4096),
		deepseekMaxUses: clampInteger(deepseek.maxUses, 1, Number.MAX_SAFE_INTEGER, 5),
	}
}

/** 官方 provider 类的缓存加载器（动态 import 让这条腿成为可选项）。 */
let deepSeekProviderClass
async function loadDeepSeekProviderClass() {
	if (deepSeekProviderClass === undefined) {
		const module = await import('@deepseek-ai/dsh-web-search-deepseek')
		if (typeof module.DeepSeekSearchProvider !== 'function') {
			throw new ChainError(
				'the installed @deepseek-ai/dsh-web-search-deepseek does not export DeepSeekSearchProvider; the official search fallback is unavailable',
				'WEB_PROVIDER_UNAVAILABLE',
			)
		}
		deepSeekProviderClass = module.DeepSeekSearchProvider
	}
	return deepSeekProviderClass
}

/** 把 Tavily `/search` 响应映射成 seam 的 `WebSearchResult.sources`。 */
function mapTavilySources(payload) {
	const sources = []
	const seen = new Set()
	for (const item of Array.isArray(payload?.results) ? payload.results : []) {
		const url = typeof item?.url === 'string' ? item.url : ''
		if (url.length === 0 || seen.has(url)) continue
		seen.add(url)
		sources.push({
			url,
			...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
			...(typeof item.content === 'string' && item.content.length > 0 ? { snippet: item.content } : {}),
			...(typeof item.published_date === 'string' && item.published_date.length > 0 ? { publishedAt: item.published_date } : {}),
		})
	}
	return sources
}

/** 读 Tavily 的 `{detail:{error}}` 失败体，绝不因为读失败体而失败。 */
async function readTavilyFailure(response) {
	try {
		const parsed = await response.json()
		const detail = parsed?.detail
		if (typeof detail === 'string' && detail.length > 0) return detail
		if (typeof detail?.error === 'string' && detail.error.length > 0) return detail.error
		if (typeof parsed?.error === 'string' && parsed.error.length > 0) return parsed.error
	} catch {
		// 非 JSON 的响应体没有可报的细节
	}
	return undefined
}

/** 开始下一条腿之前先抛调用方自己的取消原因。 */
function throwIfAborted(signal) {
	if (signal?.aborted === true) {
		throw new ChainError('web search aborted', 'WEB_ABORTED', { cause: signal.reason })
	}
}

/** 把调用方的 signal 与单腿超时合起来，并区分二者（取消传播、超时推进）。 */
function linkAbort(signal, timeoutMs) {
	const controller = new AbortController()
	let timedOut = false
	const onCallerAbort = () => controller.abort(signal?.reason)
	if (signal !== undefined) {
		if (signal.aborted) controller.abort(signal.reason)
		else signal.addEventListener('abort', onCallerAbort, { once: true })
	}
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort(new Error('web search chain timeout'))
	}, timeoutMs)
	return {
		signal: controller.signal,
		didTimeOut: () => timedOut,
		dispose() {
			clearTimeout(timer)
			signal?.removeEventListener('abort', onCallerAbort)
		},
	}
}

/**
 * 链本体：注册成 `ctx.web` 唯一被选中的搜索 provider。
 *
 * `available()` 仍是**廉价的本地判断**（seam 在那里禁止网络调用），但会读一次配置文档
 * （小文件；读失败即退默认，绝不抛）。
 */
export class ChainSearchProvider {
	/**
	 * @param ctx - 插件上下文（只用于可选的 credentials 查找）。
	 * @param getConfig - 返回当前归一化链配置的 thunk。
	 * @param readDocument - 返回 `{doc, error}` 的 thunk（每次调用都重读，无缓存）。
	 * @param loadFallback - 加载官方 provider 类；测试可注入假的。
	 */
	constructor(ctx, getConfig, readDocument, loadFallback = loadDeepSeekProviderClass) {
		this.ctx = ctx
		this.getConfig = getConfig
		this.readDocument = readDocument
		this.loadFallback = loadFallback
	}

	/** seam 用 `searchProvider` 选中的注册表键。 */
	get id() {
		return this.getConfig().id
	}

	/** 有源、或兜底行已挂载，就还算可用。 */
	available() {
		const { doc } = this.readDocument()
		return doc.sources.length > 0 || enabledFallback.size > 0
	}

	/** 按固定腿序跑一次搜索。 */
	async search(request, signal) {
		const config = this.getConfig()
		const { doc } = this.readDocument()
		const legs = orderedLegs(doc.sources, [...enabledFallback.values()][0])
		const attempts = []

		for (const leg of legs) {
			throwIfAborted(signal)
			if (leg.kind === 'deepseek') {
				this.record(config, {
					outcome: 'delegating',
					target: 'deepseek-official',
					slot: leg.id,
					ref: leg.ref,
					query: request.query,
					priorAttempts: attempts,
				})
				const Provider = await this.loadFallback()
				const provider = new Provider(() => this.deepSeekOptions(config, leg))
				return provider.search(request, signal)
			}

			const apiKey = await this.resolveCredential(leg.ref)
			if (apiKey === undefined) {
				attempts.push({ id: leg.id, ref: leg.ref, outcome: 'credential-missing' })
				continue
			}
			try {
				const result = await this.searchTavily(config, apiKey, request, signal)
				this.record(config, {
					outcome: 'served',
					target: 'tavily',
					slot: leg.id,
					ref: leg.ref,
					query: request.query,
					sources: result.sources.length,
					credits: result.credits,
					priorAttempts: attempts,
				})
				return { sources: result.sources, truncated: false }
			} catch (error) {
				if (signal?.aborted === true) throw error
				attempts.push({
					id: leg.id,
					ref: leg.ref,
					outcome: 'failed',
					message: error instanceof Error ? error.message : String(error),
				})
			}
		}

		this.record(config, { outcome: 'exhausted', target: 'none', query: request.query, priorAttempts: attempts })
		throw new ChainError(`every enabled web search source failed: ${describeAttempts(attempts)}`, 'WEB_PROVIDER_ERROR')
	}

	/** 一次 Tavily `/search` 调用，带自己的超时。 */
	async searchTavily(config, apiKey, request, signal) {
		const endpoint = `${config.tavilyBaseURL}/search`
		const body = {
			query: request.query,
			search_depth: config.searchDepth,
			max_results: request.maxResults ?? config.maxResults,
			topic: config.topic,
			include_published_date: config.includePublishedDate,
		}
		const link = linkAbort(signal, config.timeoutMs)
		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				redirect: 'error',
				headers: {
					authorization: `Bearer ${apiKey}`,
					'content-type': 'application/json',
					accept: 'application/json',
					'user-agent': USER_AGENT,
				},
				body: JSON.stringify(body),
				signal: link.signal,
			})
			if (!response.ok) {
				const detail = await readTavilyFailure(response)
				throw new ChainError(
					`Tavily search failed (HTTP ${response.status})${detail === undefined ? '' : `: ${detail}`}`,
					response.status === 429 ? 'RATE_LIMIT' : 'WEB_PROVIDER_ERROR',
				)
			}
			const payload = await response.json()
			return { sources: mapTavilySources(payload), credits: payload?.usage?.credits }
		} catch (error) {
			if (signal?.aborted === true) throw error
			if (link.didTimeOut()) {
				throw new ChainError(`Tavily search timed out after ${config.timeoutMs}ms`, 'TIMEOUT')
			}
			throw error
		} finally {
			link.dispose()
		}
	}

	/** 官方 provider 每次操作前读的选项。 */
	deepSeekOptions(config, leg) {
		return {
			resolveApiKey: () => this.resolveCredential(leg.ref),
			apiKeyEnv: leg.ref,
			baseURL: config.deepseekBaseURL,
			model: config.deepseekModel,
			apiVersion: config.deepseekApiVersion,
			maxTokens: config.deepseekMaxTokens,
			maxUses: config.deepseekMaxUses,
			recordRequest: (audit) =>
				this.record(config, {
					outcome: 'official-request',
					target: 'deepseek-official',
					endpoint: audit?.endpoint,
					body: audit?.body,
				}),
		}
	}

	/**
	 * 每次操作现解析一次凭据：先问凭据域（它自带「启动环境快照 → 存储文件 → 两个 .env」四层），
	 * 再退回本进程环境。取不到就是 `undefined`，让链路推进；格式不对的引用同样跳过。
	 */
	async resolveCredential(reference) {
		if (!REF_PATTERN.test(reference)) return undefined
		const credentials = this.ctx.get('credentials')
		if (credentials !== undefined) {
			try {
				const resolved = await credentials.resolve(reference)
				const value = resolved?.value
				if (typeof value === 'string' && value.length > 0) return value.trim()
			} catch {
				// 落到进程环境
			}
		}
		const ambient = process.env[reference]
		return typeof ambient === 'string' && ambient.length > 0 ? ambient.trim() : undefined
	}

	/** 记一行审计。审计绝不许弄坏一次搜索。 */
	record(config, payload) {
		const entry = { at: new Date().toISOString(), provider: config.id, ...payload }
		try {
			appendFileSync(auditFile(), `${JSON.stringify(entry)}\n`)
		} catch {
			// 审计失败不影响搜索
		}
	}
}

/** 挂载兜底源行：发布它的槽位，卸载时摘掉。 */
function applySource(ctx, config) {
	const entry = normalizeSource(config)
	ctx.effect(() => {
		enabledFallback.set(entry.slot, entry)
		return () => {
			// 只有当前属主能删：重挂载不能被它替换掉的那一行的销毁动作撤销。
			if (enabledFallback.get(entry.slot) === entry) enabledFallback.delete(entry.slot)
		}
	}, `web-search-source:${entry.slot}`)
}

/**
 * 写一行**开机探针**到审计日志（与搜索审计同一个文件）。
 *
 * 方法论（本仓库反复验证过的一条）：**分辨「没发生」与「没送到」的唯一手段是边界探针**。
 * 2026-09-29 那次真机 404 就是靠"两行显示运行中、但页面 404"反推出来的；
 * 有了这几行，下次同类问题可以直接读日志定性，而不必再猜：
 *   `step=apply-chain` → apply 跑到了；`step=connection-injected` → 嵌套注入等到了服务；
 *   `step=route-registered` → 路由注册成功；`step=route-failed` → 带原因。
 */
function probe(payload) {
	try {
		appendFileSync(auditFile(), `${JSON.stringify({ at: new Date().toISOString(), probe: true, ...payload })}\n`)
	} catch {
		// 探针失败绝不影响功能
	}
}

/** 挂载链本体行：注册 seam 唯一被选中的搜索 provider + 自有配置路由。 */
function applyChain(ctx, config) {
	const current = normalizeChain(config)
	const readDocument = () => readConfigDocument(configPath())
	ctx.web.registerSearchProvider(new ChainSearchProvider(ctx, () => current, readDocument))
	probe({ step: 'apply-chain', provider: current.id, inject: [...inject] })
	registerConfigRoute(ctx)
}

/**
 * 注册配置路由。
 *
 * ⚠️ **必须用嵌套注入等 connection 服务，不能一次性地 `ctx.get('connection')`**
 * （2026-09-29 真机实测：页面报「读取配置失败：HTTP 404」，而两行都显示"运行中"）：
 * 本行的硬门禁只声明了 `web` ⇒ `apply` 可能在 `connection` 被提供**之前**跑
 * ⇒ 拿到 `undefined` ⇒ 路由永远不注册。离线假 ctx 永远"服务就绪"，一条断言都抓不到，
 * 所以现在有一条专门的时序回归用例（`test\route.test.mjs` 的「★回归」）。
 *
 * 两条形状上的选择及其理由：
 * 1. **不用硬门禁 `inject: ['web','connection']`**：本行还负责注册搜索 provider，
 *    把 connection 挂成硬门禁会让「拿不到 connection」**连带弄丢 web_search 本身**。
 * 2. **嵌套注入正是官方形状**：`dsh-client-connection` 自己就写
 *    `ctx.inject(["webServer"], webCtx => webCtx.webServer.register(route))`。
 */
function registerConfigRoute(ctx) {
	try {
		ctx.inject(['connection'], (connectionCtx) => {
			try {
				probe({ step: 'connection-injected' })
				// 官方用法是**属性访问**（`webCtx.webServer…`）；`get` 只作兜底。
				const connection = Reflect.get(connectionCtx, 'connection') ?? connectionCtx.get('connection')
				if (connection === undefined) throw new Error('the connection service is unavailable')
				connectionCtx.effect(
					() =>
						connection.fetch.register({
							path: CONFIG_PATH,
							methods: ['GET', 'POST'],
							requestBody: 'buffered',
							fetch: (request) => routeFetch(ctx, request),
						}),
					'web-search-chain: config route',
				)
				probe({ step: 'route-registered', path: CONFIG_PATH })
			} catch (error) {
				probe({ step: 'route-failed', message: String(error) })
				warn(ctx, `web-search-chain: config route not registered: ${String(error)}`)
			}
		})
	} catch (error) {
		probe({ step: 'inject-failed', message: String(error) })
		warn(ctx, `web-search-chain: could not wait for the connection service: ${String(error)}`)
	}
}

/**
 * 挂载本模块的一行。`role` 决定这一行是什么；没有 `role` 就当作链本体，
 * 这样切换之前的旧配置仍然能跑。
 */
export function apply(ctx, config) {
	const role = optionalString(config?.role) ?? 'chain'
	if (role === 'source') return applySource(ctx, config)
	if (role === 'chain') return applyChain(ctx, config)
	throw new Error(`web-search-chain: unknown role ${JSON.stringify(role)}; expected "source" or "chain"`)
}

// 供配置路由与验证台使用（官方文档只列 apply/inject/Config；这些是内部接缝与测试出口，
// 实测不影响加载 —— 见 reports\dsh-session-delete-标准符合性与发布可行性-20260929.md §2 第 14 条）
export { MAX_SOURCES, TEMPLATES, defaultDocument, warn }

/**
 * **只给离线测试用**：清空兜底源注册表。
 *
 * 模块级注册表是设计需要（同一模块 URL 的多条 loader 行必须共享一份），代价是同一进程里
 * 连续跑多个测试文件时会互相污染 —— 实测 `run-all.mjs` 里 route 断言因此从 22/22 掉到 21/22。
 * 每个依赖「注册表为空」的测试文件在开头调它做隔离。
 */
export function __resetFallbackRegistryForTests() {
	enabledFallback.clear()
}

//#region 配置路由：GET 读状态 / POST 保存（全有全无）
/**
 * 自有配置路由。同源 fetch 的唯一入口，与其它 `/api/*` 共用同一道鉴权闸门
 * （`connection.fetch.register` 的精确路由挂在 `/api` 前缀路由内部，未登录会先被 401）。
 */
export const CONFIG_PATH = '/api/web-search-chain.config'

/**
 * 一个引用的凭据状态。**只回答「有没有 / 从哪来 / 能不能写」，从不返回值。**
 *
 * `source` 只是给人看的文案来源：界面对它只按 `configured` / `writable` 分支，
 * **不做字符串相等判断**（凭据域的具体取值字符串没有实证，不许把实现押在上面）。
 */
async function describeCredential(ctx, ref) {
	const credentials = ctx.get('credentials')
	if (credentials !== undefined) {
		try {
			const info = await credentials.describe(ref)
			return {
				configured: info?.configured === true,
				source: optionalString(info?.source),
				writable: info?.writable === true,
			}
		} catch (error) {
			warn(ctx, `web-search-chain: credentials.describe(${ref}) failed: ${String(error)}`)
		}
	}
	const ambient = process.env[ref]
	const configured = typeof ambient === 'string' && ambient.length > 0
	return { configured, source: configured ? 'process-env' : undefined, writable: false }
}

/** 界面用的整份状态。 */
export async function readState(ctx) {
	const { doc, error } = readConfigDocument(configPath())
	const sources = []
	for (const source of doc.sources) {
		sources.push({ ...source, credential: await describeCredential(ctx, source.ref) })
	}
	return {
		ok: true,
		version: doc.version,
		maxSources: MAX_SOURCES,
		templates: TEMPLATES.map((template) => ({ ...template })),
		sources,
		fallback: { kind: 'deepseek', enabled: enabledFallback.size > 0 },
		configError: error ?? null,
	}
}

/** 返回 `{status, payload}`：路由处理器只负责把它塞进 Response。 */
function respond(status, payload) {
	return { status, payload }
}

/**
 * 保存一次提交。写入顺序**不可颠倒**：
 *   1. 全量校验（任何一项不过 ⇒ 一个字节都不写）；
 *   2. 凭据（先 set 后 unset）；任一失败 ⇒ 整单放弃，**文档不写** ——
 *      保证文档里不会引用一个创建失败的 ref；
 *   3. 文档（临时文件 + rename 原子替换）。
 */
export async function applyConfig(ctx, body) {
	const path = configPath()
	const current = readConfigDocument(path)
	const validation = validateSubmission(body, current.doc)
	if (!validation.ok) {
		return respond(400, {
			ok: false,
			code: validation.code,
			message: validation.message,
			...(validation.field === undefined ? {} : { field: validation.field }),
		})
	}

	const credentials = ctx.get('credentials')
	const setRefs = []
	const unsetRefs = []

	for (const entry of validation.secrets) {
		if (credentials === undefined) {
			return respond(500, { ok: false, code: 'CREDENTIAL_FAILED', message: '凭据服务不可用，无法保存明文密钥' })
		}
		try {
			const info = await credentials.describe(entry.ref)
			if (info?.writable === false) {
				return respond(409, {
					ok: false,
					code: 'CREDENTIAL_READONLY',
					message: `凭据 ${entry.ref} 已由环境变量提供（只读），无法写入明文；请先在系统里删掉该环境变量并重启 DSH`,
				})
			}
			await credentials.set(entry.ref, entry.secret)
			setRefs.push(entry.ref)
		} catch (error) {
			return respond(500, { ok: false, code: 'CREDENTIAL_FAILED', message: `写入凭据 ${entry.ref} 失败：${String(error)}` })
		}
	}

	for (const ref of unusedRefs(current.doc, validation.sources)) {
		if (credentials === undefined) continue
		try {
			const info = await credentials.describe(ref)
			// 被环境变量遮住的 ref 不能写，也不该硬来：跳过并留着（我们的命名空间里出现这种情况极罕见）。
			if (info?.writable === false) continue
			await credentials.unset(ref)
			unsetRefs.push(ref)
		} catch (error) {
			warn(ctx, `web-search-chain: credentials.unset(${ref}) failed: ${String(error)}`)
		}
	}

	try {
		writeConfigDocument(path, { sources: validation.sources })
	} catch (error) {
		return respond(500, { ok: false, code: 'CONFIG_WRITE_FAILED', message: `写入配置失败：${String(error)}` })
	}

	const state = await readState(ctx)
	return respond(200, { ...state, applied: { setRefs, unsetRefs, warnings: [] } })
}

/**
 * 路由处理器。`request` 只需满足 `{method, json()}` 形状（离线测试用假对象）。
 * **任何路径都不许把异常抛给运行时**：最外层兜底成 500。
 */
export async function routeFetch(ctx, request) {
	try {
		if (request.method === 'GET') return Response.json(await readState(ctx), { status: 200 })
		if (request.method !== 'POST') {
			return Response.json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 GET / POST' }, { status: 405 })
		}
		let body
		try {
			body = await request.json()
		} catch {
			return Response.json({ ok: false, code: 'BAD_JSON', message: 'body must be JSON' }, { status: 400 })
		}
		const { status, payload } = await applyConfig(ctx, body)
		return Response.json(payload, { status })
	} catch (error) {
		warn(ctx, `web-search-chain: config route failed: ${String(error)}`)
		return Response.json({ ok: false, code: 'INTERNAL', message: String(error) }, { status: 500 })
	}
}
//#endregion
