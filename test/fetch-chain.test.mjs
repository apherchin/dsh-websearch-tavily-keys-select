/**
 * 3.1.0：web_fetch 抓取梯队（本地 HTTP → Tavily Extract → DS Fetch 开关兜底）回归。
 *
 * 口径（用户 2026-11-14 定）：
 *   - Tavily 的 fetch 与 search **共享** $DSH_HOME\web-search-chain.json 的源/keys 与同一份 credits，
 *     不另立账本；某把 key 上游报用满就切下一把；两把都尽才落到 DS。
 *   - DS 只由 dsFetchFallback 开关控制，不做月度计数。
 *   - 「用满」记忆按**北京时间自然月**自动恢复（每月 1 号，不用人记/不用重启）。
 *
 * ⚠️ 隔离：DSH_HOME 指临时目录、fetch 全 stub、审计写临时文件 ⇒ 不碰真的 ~\.dsh、不花一分钱。
 * ⚠️ 本机不能用 node --test（沙箱命名管道 EPERM）⇒ 逐文件 node <绝对路径>。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, summary, assert, tempDir, cleanup, makeFakeCtx } from './harness.mjs'

const dir = tempDir('fetch-chain')
process.env.DSH_HOME = dir

const CONFIG_PATH = join(dir, 'web-search-chain.json')
const DEFAULT_CONFIG = {
	version: 3,
	sources: [{
		id: 'tavily', kind: 'tavily', billing: { unit: 'credits' },
		keys: [
			{ id: 's2', mode: 'env', ref: 'K1' },
			{ id: 's3', mode: 'env', ref: 'K2' },
		],
	}],
}

// 模块不存在时也给出**断言失败**而不是 import 报错，保证 RED 是「功能缺失」而非笔误。
const mod = await import('../bundle/host/fetch-chain.mjs').catch(() => null)

const { apply } = await import('../bundle/host/index-v5.mjs')

const TARGET = 'https://example.com/some-article'
const realFetch = globalThis.fetch
let calls = []
let handlers = {}

function stubFetch() {
	globalThis.fetch = async (url, init = {}) => {
		const u = String(url)
		const auth = String(init?.headers?.authorization ?? '')
		calls.push({ url: u, auth, body: String(init.body ?? '') })
		if (u.startsWith('https://api.tavily.com/extract')) {
			const body = JSON.parse(String(init.body ?? '{}'))
			const key = auth === 'Bearer KEY-1' ? 'K1' : auth === 'Bearer KEY-2' ? 'K2' : '?'
			const reply = handlers[key] ?? handlers.default ?? { status: 200, results: [{ url: body.urls?.[0] ?? TARGET, raw_content: 'TAVILY CONTENT' }], failed_results: [] }
			if (reply instanceof Error) throw reply
			return new Response(JSON.stringify({ results: reply.results ?? [], failed_results: reply.failed_results ?? [] }), {
				status: reply.status ?? 200, headers: { 'content-type': 'application/json' },
			})
		}
		if (u.includes('/v1/tools/fetch')) {
			return new Response(JSON.stringify({ content: 'DS CONTENT' }), { status: 200, headers: { 'content-type': 'application/json' } })
		}
		return new Response('blocked', { status: 403, headers: { 'content-type': 'text/plain' } })
	}
}

const usageLimit = (status = 432) => ({
	status,
	results: [],
	failed_results: [{ url: TARGET, error: "This request exceeds your plan's set usage limit" }],
})

const credentials = {
	async resolve(ref) { return { value: { K1: 'KEY-1', K2: 'KEY-2', DEEPSEEK_API_KEY: 'DS-KEY' }[ref] } },
}

function settings(over = {}) {
	return {
		baseURL: 'https://api.tavily.com',
		extractDepth: 'basic',
		format: 'markdown',
		timeoutMs: 5000,
		maxChars: 100000,
		dsFetchFallback: true,
		deepseekBaseURL: 'https://api.deepseek.com/v1/tools',
		apiKeyEnv: 'DEEPSEEK_API_KEY',
		logFile: join(dir, 'web-fetch-chain.log'),
		...over,
	}
}

function chainOf(over = {}) {
	assert.ok(mod, 'bundle/host/fetch-chain.mjs 尚未提供抓取梯队（3.1.0 功能缺失）')
	const ctx = makeFakeCtx({ credentials })
	const chain = mod.makeChainFetchProvider(ctx, settings(over))
	return { chain, ctx }
}

const dsCalls = () => calls.filter((c) => c.url.includes('/v1/tools/fetch')).length
const tavilyCalls = () => calls.filter((c) => c.url.startsWith('https://api.tavily.com/extract'))
const reset = () => {
	calls = []
	handlers = {}
	writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG))
	stubFetch()
}

console.log('-- fetch-chain: web_fetch 抓取梯队 --')

await test('apply 同时注册 search 与 chain-fetch 两个 provider', () => {
	reset()
	const ctx = makeFakeCtx({ credentials })
	apply(ctx, { role: 'chain', id: 'tavily-chain', tavily: { timeoutMs: 3000 }, fetch: settings() })
	assert.equal(ctx.__provider?.id, 'tavily-chain', '搜索 provider 仍必须是链本体')
	assert.ok((ctx.__fetchProviders ?? []).some((p) => p.id === 'chain-fetch'), 'chain-fetch 未注册')
})

await test('腿序是 http-leg → tavily-extract → deepseek-fetch-api', () => {
	reset()
	const { chain } = chainOf()
	assert.deepEqual(chain.resolveLegs().map((l) => l.id), ['http-leg', 'tavily-extract', 'deepseek-fetch-api'])
})

await test('dsFetchFallback:false 时腿序里没有 DS', () => {
	reset()
	const { chain } = chainOf({ dsFetchFallback: false })
	assert.deepEqual(chain.resolveLegs().map((l) => l.id), ['http-leg', 'tavily-extract'])
})

await test('本地 HTTP 失败后由 Tavily Extract 提供正文，DS 完全不被调用', async () => {
	reset()
	const { chain } = chainOf()
	const result = await chain.fetch({ url: TARGET })
	assert.equal(result.body.content, 'TAVILY CONTENT')
	assert.equal(dsCalls(), 0)
})

await test('第一把 key 报用满(432) 时自动切第二把，DS 不被调用', async () => {
	reset()
	handlers.K1 = usageLimit()
	const { chain } = chainOf()
	const result = await chain.fetch({ url: TARGET })
	assert.equal(result.body.content, 'TAVILY CONTENT')
	assert.deepEqual(tavilyCalls().map((c) => c.auth), ['Bearer KEY-1', 'Bearer KEY-2'])
	assert.equal(dsCalls(), 0)
})

await test('「用满」记忆跨请求保持：第二次不再请求已用满的那把 key', async () => {
	reset()
	handlers.K1 = usageLimit()
	const { chain } = chainOf()
	await chain.fetch({ url: TARGET })
	calls = []
	await chain.fetch({ url: TARGET })
	assert.deepEqual(tavilyCalls().map((c) => c.auth), ['Bearer KEY-2'])
	assert.equal(dsCalls(), 0)
})

await test('两把 key 都用满时落到 DS 兜底腿', async () => {
	reset()
	handlers.K1 = usageLimit()
	handlers.K2 = usageLimit()
	const { chain } = chainOf()
	const result = await chain.fetch({ url: TARGET })
	assert.equal(result.body.content, 'DS CONTENT')
	assert.equal(dsCalls(), 1)
})

await test('Tavily 返回 HTTP 200 但 results 为空（全在 failed_results）时推进到 DS', async () => {
	reset()
	handlers.default = { status: 200, results: [], failed_results: [{ url: TARGET, error: 'extraction failed' }] }
	const { chain } = chainOf()
	const result = await chain.fetch({ url: TARGET })
	assert.equal(result.body.content, 'DS CONTENT')
	assert.equal(dsCalls(), 1)
})

await test('dsFetchFallback:false 且两把 key 都尽 ⇒ 明确失败，且不调用 DS', async () => {
	reset()
	handlers.K1 = usageLimit()
	handlers.K2 = usageLimit()
	const { chain } = chainOf({ dsFetchFallback: false })
	await assert.rejects(() => chain.fetch({ url: TARGET }), /all fetch legs failed/u)
	assert.equal(dsCalls(), 0)
})

await test('配置里 disabled 的 key 不参与抓取，只剩启用的那把', () => {
	reset()
	writeFileSync(CONFIG_PATH, JSON.stringify({
		version: 3,
		sources: [{ id: 'tavily', kind: 'tavily', keys: [
			{ id: 's2', mode: 'env', ref: 'K1', disabled: true },
			{ id: 's3', mode: 'env', ref: 'K2' },
		] }],
	}))
	assert.ok(mod, 'fetch-chain.mjs 尚未提供')
	assert.deepEqual(mod.TavilyExtractLeg.tavilyKeys().map((k) => k.ref), ['K2'])
})

await test('Tavily 网络层失败时推进到 DS，不吞错', async () => {
	reset()
	handlers.K1 = new Error('fetch failed')
	handlers.K2 = new Error('fetch failed')
	const { chain } = chainOf()
	const result = await chain.fetch({ url: TARGET })
	assert.equal(result.body.content, 'DS CONTENT')
	assert.equal(dsCalls(), 1)
})

await test('HTTP 200 + failed_results 提示额度 ⇒ 该 key 被记住并切下一把', async () => {
	reset()
	handlers.K1 = { status: 200, results: [], failed_results: [{ url: TARGET, error: 'This request exceeds your plan set usage limit' }] }
	const { chain } = chainOf()
	const result = await chain.fetch({ url: TARGET })
	assert.equal(result.body.content, 'TAVILY CONTENT')
	assert.deepEqual(tavilyCalls().map((c) => c.auth), ['Bearer KEY-1', 'Bearer KEY-2'])
	assert.equal(dsCalls(), 0)
})

await test('请求体带 extract_depth / format / urls，且只发一个 URL', async () => {
	reset()
	const { chain } = chainOf({ extractDepth: 'advanced', format: 'text' })
	await chain.fetch({ url: TARGET })
	const body = JSON.parse(calls.find((c) => c.url.startsWith('https://api.tavily.com/extract'))?.body ?? '{}')
	assert.deepEqual(body, { urls: [TARGET], extract_depth: 'advanced', format: 'text' })
})

await test('跨月自动恢复：11 月标用满的 key，北京 12 月 1 日重新参与（无需重启）', async () => {
	reset()
	const { chain } = chainOf()
	const leg = chain.resolveLegs()[1]
	leg.now = () => Date.parse('2026-11-30T15:30:00Z') // 北京 11-30 23:30
	handlers.K1 = usageLimit()
	await chain.fetch({ url: TARGET })
	assert.deepEqual(tavilyCalls().map((c) => c.auth), ['Bearer KEY-1', 'Bearer KEY-2'])
	calls = []
	await chain.fetch({ url: TARGET })
	assert.deepEqual(tavilyCalls().map((c) => c.auth), ['Bearer KEY-2'])
	leg.now = () => Date.parse('2026-11-30T16:30:00Z') // UTC 仍是 11-30，北京已 12-01 00:30
	calls = []
	handlers = {}
	await chain.fetch({ url: TARGET })
	assert.deepEqual(tavilyCalls().map((c) => c.auth), ['Bearer KEY-1'])
})

await test('两把 key 都标用满后跨月：两把都恢复，不再直接落 DS', async () => {
	reset()
	const { chain } = chainOf()
	const leg = chain.resolveLegs()[1]
	leg.now = () => Date.parse('2026-11-15T04:00:00Z')
	handlers.K1 = usageLimit()
	handlers.K2 = usageLimit()
	const r1 = await chain.fetch({ url: TARGET })
	assert.equal(r1.body.content, 'DS CONTENT')
	leg.now = () => Date.parse('2026-12-01T04:00:00Z')
	calls = []
	handlers = {}
	const r2 = await chain.fetch({ url: TARGET })
	assert.equal(r2.body.content, 'TAVILY CONTENT')
	assert.equal(dsCalls(), 0)
	assert.deepEqual(tavilyCalls().map((c) => c.auth), ['Bearer KEY-1'])
})

globalThis.fetch = realFetch
summary('fetch-chain')
cleanup(dir)
