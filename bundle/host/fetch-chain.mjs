/**
 * 3.1.0：web_fetch 抓取梯队（host-only，零 `@deepseek-ai/*` 静态依赖）。
 *
 * 腿序：本地 HTTP（免费）→ Tavily Extract（credits）→ DeepSeek 官方 Fetch API（开关式兜底）。
 *
 * 口径（用户 2026-11-14 定）：
 *   - Tavily 的 fetch 与 search **共享** `$DSH_HOME\web-search-chain.json` 的源 / key，
 *     但 3.2.0 起**分两份记账**：搜索 credits 与抓取 fetchUrls→fetchCredits 各自按 key 累计；
 *     某把 key 上游报用满就切下一把；两把都尽才落到 DS。
 *   - DS 只由 `dsFetchFallback` 开关控制，不做月度计数。
 *   - 「用满」记忆按**北京时间自然月**自动恢复（每月 1 号，不用改配置 / 不用重启）。
 *   - 抓取成功由 `onExtractSuccess(keyId, extractDepth)` 回调写账本（与搜索共用读-改-写助手）。
 *
 * 审计：`$DSH_HOME\web-fetch-chain.log`（与搜索链日志分文件，避免互相污染）。
 * 官方契约：[Tavily Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract)、
 * [Credits](https://docs.tavily.com/documentation/api-credits.md)。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CHAIN_FETCH_ID = 'chain-fetch'
const HTTP_LEG_ID = 'http-leg'
const TAVILY_EXTRACT_ID = 'tavily-extract'
const DS_FETCH_ID = 'deepseek-fetch-api'
const DEFAULT_TAVILY_BASE_URL = 'https://api.tavily.com'
const DEFAULT_DS_BASE_URL = 'https://api.deepseek.com/v1/tools'
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const QUOTA_STATUSES = new Set([402, 429, 432])
const QUOTA_MESSAGE = /usage limit|exceeds your plan|out of credits|insufficient credits|quota|rate limit/iu
const PRIVATE_HOST_PATTERN = /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|.*\.local)$/iu

function dsHome() {
	return process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
}

function auditFile(settings) {
	return settings.logFile ?? join(dsHome(), 'web-fetch-chain.log')
}

function log(settings, kind, payload) {
	try {
		appendFileSync(auditFile(settings), `${JSON.stringify({ at: new Date().toISOString(), kind, ...payload })}\n`, 'utf8')
	} catch {
		// 审计失败绝不影响请求
	}
}

/** 北京时间月份键 `YYYY-MM`：Tavily 额度按自然月刷新，不能用 UTC（东八区，无夏令时）。 */
function beijingMonthKey(nowMs) {
	return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 7)
}

function trimBase(baseURL) {
	return String(baseURL ?? DEFAULT_TAVILY_BASE_URL).replace(/\/+$/u, '')
}

async function resolveCredential(ctx, ref) {
	const credentials = ctx?.get?.('credentials')
	if (credentials !== undefined) {
		try {
			const value = (await credentials.resolve(ref))?.value
			if (typeof value === 'string' && value.length > 0) return value.trim()
		} catch {
			// 退回进程环境
		}
	}
	const ambient = process.env[ref]
	return typeof ambient === 'string' && ambient.length > 0 ? ambient.trim() : undefined
}

async function postJson(endpoint, apiKey, body, signal) {
	const response = await fetch(endpoint, {
		method: 'POST',
		redirect: 'error',
		headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal,
	})
	const text = await response.text()
	let payload
	try { payload = JSON.parse(text) } catch { throw new Error(`DeepSeek API returned invalid JSON (HTTP ${response.status})`) }
	if (!response.ok) throw new Error(`DeepSeek API HTTP ${response.status}: ${payload?.error?.message ?? text.slice(0, 300)}`)
	return payload
}

/** 本地 HTTP 腿：免费第一腿，拒绝私网目标。 */
export class SimpleHttpFetchLeg {
	id = HTTP_LEG_ID
	constructor({ timeoutMs = 20_000, maxChars = 100_000 } = {}) {
		this.timeoutMs = timeoutMs
		this.maxChars = maxChars
	}
	async fetch(request, signal) {
		const url = new URL(request.url)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported protocol ${url.protocol}`)
		if (PRIVATE_HOST_PATTERN.test(url.hostname)) throw new Error(`local HTTP leg refuses private host ${url.hostname}`)
		const timeout = AbortSignal.timeout(this.timeoutMs)
		const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
		const response = await fetch(url, {
			redirect: 'follow',
			headers: { 'user-agent': 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)' },
			signal: combined,
		})
		const text = await response.text()
		if (response.status < 200 || response.status >= 300) throw new Error(`local HTTP leg got HTTP ${response.status}`)
		if (text.trim().length === 0) throw new Error('local HTTP leg got an empty body')
		const truncated = text.length > this.maxChars
		const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
		return {
			url: response.url || url.toString(),
			statusCode: response.status,
			body: { kind: contentType.includes('html') ? 'html' : 'text', content: truncated ? text.slice(0, this.maxChars) : text },
			truncated,
		}
	}
}

/** 官方 DeepSeek REST Fetch API（0.005 元/成功次），作为最后兜底。 */
export class DeepSeekFetchApiProvider {
	id = DS_FETCH_ID
	constructor({ ctx, settings }) {
		this.ctx = ctx
		this.settings = settings
	}
	async fetch(request, signal) {
		const apiKey = await resolveCredential(this.ctx, this.settings.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
		if (apiKey === undefined) throw new Error(`${this.settings.apiKeyEnv ?? DEFAULT_API_KEY_ENV} is not configured`)
		const started = Date.now()
		try {
			const payload = await postJson(
				`${trimBase(this.settings.deepseekBaseURL ?? DEFAULT_DS_BASE_URL)}/fetch`,
				apiKey, { url: request.url }, signal,
			)
			if (typeof payload.content !== 'string') throw new Error('DeepSeek Fetch API returned no Markdown content')
			log(this.settings, 'fetch-served', { provider: DS_FETCH_ID, url: request.url, chars: payload.content.length, ms: Date.now() - started })
			return { url: request.url, statusCode: 200, body: { kind: 'text', content: payload.content }, truncated: false }
		} catch (error) {
			log(this.settings, 'fetch-failed', { provider: DS_FETCH_ID, url: request.url, ms: Date.now() - started, message: String(error?.message ?? error) })
			throw error
		}
	}
}

/** Tavily Extract 腿：与搜索链共享配置文档与 credits。 */
export class TavilyExtractLeg {
	id = TAVILY_EXTRACT_ID
	constructor({ ctx, settings, onExtractSuccess = undefined }) {
		this.ctx = ctx
		this.settings = settings
		// 3.2.0：抓取成功后按该 key 记 fetchUrls（由 index-v5 注入统一读-改-写助手）。
		this.onExtractSuccess = onExtractSuccess
		// 「这把 key 上游已用满」的进程内记忆，按北京时间自然月分桶 ⇒ 每月 1 号自动清空。
		this.exhausted = new Set()
		this.exhaustedMonth = beijingMonthKey(Date.now())
		this.now = () => Date.now() // 测试可注入，验证跨月边界
	}
	/** 每次请求前调用：月份键变了就清空记忆，让所有 key 重新参与。 */
	refreshQuotaMonth() {
		const month = beijingMonthKey(this.now())
		if (month !== this.exhaustedMonth) {
			const previous = this.exhaustedMonth
			this.exhaustedMonth = month
			this.exhausted.clear()
			log(this.settings, 'tavily-extract-quota-reset', { from: previous, to: month })
		}
	}
	/** 从链配置文档里取 Tavily 源的启用 key（env ref），保持与搜索腿同一份顺序。 */
	static tavilyKeys() {
		try {
			const doc = JSON.parse(readFileSync(join(dsHome(), 'web-search-chain.json'), 'utf8'))
			const keys = []
			for (const source of Array.isArray(doc.sources) ? doc.sources : []) {
				if (source.kind !== 'tavily' || source.disabled === true) continue
				for (const key of Array.isArray(source.keys) ? source.keys : []) {
					if (key.disabled === true || typeof key.ref !== 'string') continue
					keys.push({ id: String(key.id ?? key.ref), ref: key.ref, mode: key.mode ?? 'env' })
				}
			}
			return keys
		} catch {
			return []
		}
	}
	async fetch(request, signal) {
		this.refreshQuotaMonth()
		const keys = TavilyExtractLeg.tavilyKeys().filter((k) => !this.exhausted.has(k.ref))
		if (keys.length === 0) throw new Error('Tavily Extract: no usable API key (all exhausted or disabled)')
		const endpoint = `${trimBase(this.settings.baseURL)}/extract`
		const timeout = AbortSignal.timeout(this.settings.timeoutMs ?? 20_000)
		const attempts = []
		for (const key of keys) {
			if (signal?.aborted === true) throw new Error('web fetch aborted')
			const apiKey = await resolveCredential(this.ctx, key.ref)
			if (apiKey === undefined) { attempts.push({ key: key.id, outcome: 'credential-missing' }); continue }
			try {
				const response = await fetch(endpoint, {
					method: 'POST',
					redirect: 'error',
					headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
					body: JSON.stringify({
						urls: [request.url],
						extract_depth: this.settings.extractDepth ?? 'basic',
						format: this.settings.format ?? 'markdown',
					}),
					signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
				})
				const text = await response.text()
				let payload
				try { payload = JSON.parse(text) } catch { throw new Error(`Tavily Extract returned invalid JSON (HTTP ${response.status})`) }
				if (!response.ok) {
					const detail = payload?.detail?.error ?? payload?.error?.message ?? text.slice(0, 300)
					const error = new Error(`Tavily Extract HTTP ${response.status}: ${detail}`)
					error.status = response.status
					throw error
				}
				const results = Array.isArray(payload.results) ? payload.results : []
				const hit = results.find((r) => typeof r?.raw_content === 'string' && r.raw_content.trim().length > 0)
				if (hit === undefined) {
					const reason = (Array.isArray(payload.failed_results) ? payload.failed_results : [])
						.map((r) => String(r?.error ?? '')).find((s) => s.length > 0) ?? ''
					attempts.push({ key: key.id, outcome: 'no-content', reason })
					if (QUOTA_MESSAGE.test(reason)) this.exhausted.add(key.ref)
					continue
				}
				log(this.settings, 'tavily-extract-served', { key: key.id, url: request.url, chars: hit.raw_content.length, attempts })
				// 3.2.0：只记成功的 URL（官方失败不收费）；回调异常绝不影响抓取结果。
				if (typeof this.onExtractSuccess === 'function') {
					try { await this.onExtractSuccess(key.id, this.settings.extractDepth ?? 'basic') }
					catch (error) { log(this.settings, 'tavily-extract-ledger-failed', { key: key.id, message: String(error?.message ?? error) }) }
				}
				const content = hit.raw_content
				const maxChars = this.settings.maxChars ?? 100_000
				const truncated = content.length > maxChars
				return {
					url: request.url,
					statusCode: 200,
					body: { kind: 'text', content: truncated ? content.slice(0, maxChars) : content },
					truncated,
				}
			} catch (error) {
				if (QUOTA_STATUSES.has(error?.status) || QUOTA_MESSAGE.test(String(error?.message ?? error))) this.exhausted.add(key.ref)
				attempts.push({ key: key.id, outcome: 'failed', message: String(error?.message ?? error) })
			}
		}
		throw new Error(`Tavily Extract: all keys failed: ${JSON.stringify(attempts)}`)
	}
}

/** 逐腿尝试；前一条腿抛错或返回空正文时推进；全部失败才抛错。 */
export class ChainFetchProvider {
	id = CHAIN_FETCH_ID
	constructor({ legs, settings }) {
		this.legs = legs
		this.settings = settings
	}
	available() { return this.legs.length > 0 }
	resolveLegs() { return this.legs }
	async fetch(request, signal) {
		const attempts = []
		for (const leg of this.legs) {
			if (signal?.aborted === true) throw new Error('web fetch aborted')
			const started = Date.now()
			try {
				const result = await leg.fetch(request, signal)
				if (result !== undefined && typeof result.body?.content === 'string' && result.body.content.length > 0) {
					log(this.settings, 'fetch-leg-served', { provider: CHAIN_FETCH_ID, leg: leg.id, url: request.url, chars: result.body.content.length, ms: Date.now() - started, priorAttempts: attempts })
					return result
				}
				attempts.push({ leg: leg.id, outcome: 'empty' })
			} catch (error) {
				attempts.push({ leg: leg.id, outcome: 'failed', message: String(error?.message ?? error) })
			}
		}
		log(this.settings, 'fetch-chain-failed', { provider: CHAIN_FETCH_ID, url: request.url, attempts })
		throw new Error(`all fetch legs failed: ${JSON.stringify(attempts)}`)
	}
}

/** 组装并（由调用方）注册 chain-fetch provider。 */
export function makeChainFetchProvider(ctx, settings = {}, hooks = {}) {
	const normalized = {
		baseURL: settings.baseURL ?? DEFAULT_TAVILY_BASE_URL,
		extractDepth: settings.extractDepth ?? 'basic',
		format: settings.format ?? 'markdown',
		timeoutMs: settings.timeoutMs ?? 20_000,
		maxChars: settings.maxChars ?? 100_000,
		dsFetchFallback: settings.dsFetchFallback !== false,
		deepseekBaseURL: settings.deepseekBaseURL ?? DEFAULT_DS_BASE_URL,
		apiKeyEnv: settings.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
		logFile: settings.logFile,
	}
	// 腿各建一次并复用：Tavily 的「用满」是进程内状态，每次 fetch 都 new 会清空记忆。
	const legs = [
		new SimpleHttpFetchLeg({ timeoutMs: normalized.timeoutMs, maxChars: normalized.maxChars }),
		new TavilyExtractLeg({ ctx, settings: normalized, onExtractSuccess: hooks.onExtractSuccess }),
		...(normalized.dsFetchFallback ? [new DeepSeekFetchApiProvider({ ctx, settings: normalized })] : []),
	]
	return new ChainFetchProvider({ legs, settings: normalized })
}
