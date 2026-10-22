import { readFileSync } from 'node:fs'
import { test, summary, assert, tempDir, cleanup, makeFakeCtx, makeFakeCredentials, makeFakeConnection } from './harness.mjs'
import { writeConfigDocument } from '../bundle/host/config-store.mjs'

// ⚠️ 必须在 import index-v5 之前把 DSH_HOME 指到临时目录：
// 审计日志 `web-search-chain.log` 与配置文档都由它派生，绝不能碰真的 ~\.dsh。
const dir = tempDir('chain-provider')
process.env.DSH_HOME = dir

const { apply, ChainSearchProvider, normalizeChain, configPath, __resetFallbackRegistryForTests } = await import('../bundle/host/index-v5.mjs')
const { emptyDocument, orderedLegs } = await import('../bundle/host/core.mjs')

// 模块级兜底注册表在同一进程里被别的测试文件挂过 ⇒ 先清空，保证本文件的断言与顺序无关
// （本文件跑在 run-all 的最前面，但别把"字母序"当成隔离手段）。
__resetFallbackRegistryForTests()

console.log('-- chain-provider: 链路行为 --')

const realFetch = globalThis.fetch
function stubFetch(handler) {
	globalThis.fetch = handler
}
function tavilyOk(urls) {
	return new Response(JSON.stringify({ results: urls.map((url) => ({ url, title: url, content: 'x' })), usage: { credits: 1 } }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}
function tavilyFail(status, detail) {
	return new Response(JSON.stringify({ detail: { error: detail } }), { status, headers: { 'content-type': 'application/json' } })
}
/** 造一个走完 apply 的真实链（provider 由 ctx.web 捕获）。 */
function mountChain({ credentials = makeFakeCredentials(), connection = makeFakeConnection(), chain = {} } = {}) {
	const ctx = makeFakeCtx({ credentials, connection })
	apply(ctx, {
		role: 'chain',
		id: 'tavily-chain',
		tavily: { baseURL: 'https://tavily.invalid', searchDepth: 'basic', maxResults: 10, topic: 'general', timeoutMs: 3000 },
		deepseek: { baseURL: 'https://deepseek.invalid', model: 'deepseek-v4-flash', maxTokens: 4096, maxUses: 5 },
		...chain,
	})
	return { ctx, provider: ctx.__provider, credentials }
}
const setDoc = (sources) => writeConfigDocument(configPath(), { sources })

await test('apply 注册了 provider，id 取自配置', () => {
	const { provider } = mountChain()
	assert.equal(typeof provider, 'object')
	assert.equal(provider.id, 'tavily-chain')
})

await test('available()：文档内有源 ⇒ true；文档空且无兜底 ⇒ false', () => {
	const { provider } = mountChain()
	setDoc([])
	assert.equal(provider.available(), false)
	setDoc([{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' }])
	assert.equal(provider.available(), true)
})

await test('缺凭据的源记 credential-missing 并推进到下一条', async () => {
	const { provider, credentials } = mountChain({ credentials: makeFakeCredentials({ values: { K2: 'key2' } }) })
	setDoc([
		{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' },
		{ id: 's2', kind: 'tavily', mode: 'env', ref: 'K2' },
	])
	const seen = []
	stubFetch(async (url, init) => {
		seen.push(init.headers.authorization)
		return tavilyOk(['https://served-by-s2'])
	})
	try {
		const result = await provider.search({ query: 'q' }, undefined)
		assert.deepEqual(result.sources.map((source) => source.url), ['https://served-by-s2'])
		assert.deepEqual(seen, ['Bearer key2'])
		const log = readFileSync(`${dir}\\web-search-chain.log`, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
		const served = log.filter((entry) => entry.outcome === 'served').at(-1)
		assert.equal(served.slot, 's2')
		assert.deepEqual(served.priorAttempts, [{ id: 's1', ref: 'K1', outcome: 'credential-missing' }])
		assert.ok(credentials.calls.resolve.includes('K1'), '缺凭据的那条源必须真的去解析过')
	} finally {
		stubFetch(realFetch)
	}
})

await test('一条源请求失败 ⇒ 推进到下一条（HTTP 401 带出 detail）', async () => {
	const { provider } = mountChain({ credentials: makeFakeCredentials({ values: { K1: 'k1', K2: 'k2' } }) })
	setDoc([
		{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' },
		{ id: 's2', kind: 'tavily', mode: 'env', ref: 'K2' },
	])
	let call = 0
	stubFetch(async () => {
		call += 1
		return call === 1 ? tavilyFail(401, 'bad key') : tavilyOk(['https://served-by-s2'])
	})
	try {
		const result = await provider.search({ query: 'q' }, undefined)
		assert.equal(call, 2)
		assert.deepEqual(result.sources.map((source) => source.url), ['https://served-by-s2'])
	} finally {
		stubFetch(realFetch)
	}
})

await test('全败 ⇒ 抛 WEB_PROVIDER_ERROR，文案逐条列出每个源', async () => {
	const { provider } = mountChain({ credentials: makeFakeCredentials({ values: { K1: 'k1' } }) })
	setDoc([
		{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' },
		{ id: 's2', kind: 'tavily', mode: 'env', ref: 'K2' },
	])
	stubFetch(async () => tavilyFail(429, 'rate limited'))
	try {
		await assert.rejects(
			() => provider.search({ query: 'q' }, undefined),
			(error) => {
				assert.equal(error.code, 'WEB_PROVIDER_ERROR')
				assert.ok(error.message.includes('s1(K1): failed'), error.message)
				assert.ok(error.message.includes('RATE_LIMIT') === false, '腿级失败不改变整体错误码')
				assert.ok(error.message.includes('s2(K2): credential-missing'), error.message)
				return true
			},
		)
	} finally {
		stubFetch(realFetch)
	}
})

await test('源被删空且兜底未挂载 ⇒ 一条腿都没有，文案是 every source row is disabled', async () => {
	const { provider } = mountChain()
	setDoc([])
	await assert.rejects(
		() => provider.search({ query: 'q' }, undefined),
		(error) => {
			assert.equal(error.code, 'WEB_PROVIDER_ERROR')
			assert.ok(error.message.includes('every source row is disabled'), error.message)
			return true
		},
	)
})

await test('调用方取消 ⇒ 抛 WEB_ABORTED，且一次网络请求都不发', async () => {
	const { provider } = mountChain({ credentials: makeFakeCredentials({ values: { K1: 'k1' } }) })
	setDoc([{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' }])
	let calls = 0
	stubFetch(async () => { calls += 1; return tavilyOk([]) })
	const controller = new AbortController()
	controller.abort()
	try {
		await assert.rejects(
			() => provider.search({ query: 'q' }, controller.signal),
			(error) => {
				assert.equal(error.code, 'WEB_ABORTED')
				return true
			},
		)
		assert.equal(calls, 0)
	} finally {
		stubFetch(realFetch)
	}
})

await test('腿序：文档顺序优先，兜底最后（用假兜底 provider 断言委托发生在所有源之后）', async () => {
	const order = []
	class FakeFallback {
		constructor(resolveOptions) { this.resolveOptions = resolveOptions }
		async search() {
			order.push('fallback')
			return { sources: [{ url: 'https://fallback' }], truncated: false }
		}
	}
	const credentials = makeFakeCredentials({ values: { K1: 'k1' } })
	const ctx = makeFakeCtx({ credentials })
	// ⚠️ 必须先把兜底行挂上：`orderedLegs` 只在注册表里有条目时才追加 deepseek 腿
	// （这是有意语义，不是 bug）。不挂的话这条用例只会撞「全败」。
	apply(ctx, { role: 'source', slot: 'deepseek', kind: 'deepseek', keyRef: 'DEEPSEEK_API_KEY' })
	const readDocument = () => ({ doc: { version: 1, sources: [{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' }] }, error: undefined })
	const provider = new ChainSearchProvider(ctx, () => normalizeChain({ id: 'tavily-chain', tavily: { baseURL: 'https://tavily.invalid', timeoutMs: 3000 } }), readDocument, async () => FakeFallback)
	// 先让 Tavily 腿失败，才能走到兜底
	stubFetch(async () => tavilyFail(500, 'boom'))
	try {
		const result = await provider.search({ query: 'q' }, undefined)
		assert.deepEqual(order, ['fallback'])
		assert.deepEqual(result.sources.map((source) => source.url), ['https://fallback'])
	} finally {
		stubFetch(realFetch)
	}
})

await test('兜底行的注册表条目由源行发布：apply({role:"source"}) 后腿里就有 deepseek', async () => {
	const { provider } = mountChain()
	const ctx2 = makeFakeCtx({ credentials: makeFakeCredentials() })
	apply(ctx2, { role: 'source', slot: 'deepseek', kind: 'deepseek', keyRef: 'DEEPSEEK_API_KEY' })
	setDoc([{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' }])
	// 只断言「腿序里有 deepseek」：真跑会去 import 官方 provider 包，离线环境拿不到。
	const legs = orderedLegs(
		[{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' }],
		{ slot: 'deepseek', keyRef: 'DEEPSEEK_API_KEY' },
	)
	assert.deepEqual(legs.map((leg) => leg.kind), ['tavily', 'deepseek'])
	assert.equal(typeof provider.search, 'function')
})

await test('源行只接受 slot:deepseek（旧的 key1/key2 写法必须报错，让它可见）', () => {
	const ctx = makeFakeCtx({})
	assert.throws(() => apply(ctx, { role: 'source', slot: 'key1', kind: 'tavily', keyRef: 'K' }), /slot: "deepseek"/)
})

await test('未知 role ⇒ 抛错（配置写错时立刻可见）', () => {
	const ctx = makeFakeCtx({})
	assert.throws(() => apply(ctx, { role: 'sources' }), /unknown role/)
})

await test('emptyDocument 仍是空文档（回归守卫）', () => {
	assert.deepEqual(emptyDocument(), { version: 2, sources: [] })
})

//#region 元宝搜索腿（2026-10-22）
const { usagePath } = await import('../bundle/host/index-v5.mjs')
const { writeUsageDocument } = await import('../bundle/host/config-store.mjs')
const { beijingMonthKey } = await import('../bundle/host/core.mjs')
const { mapYuanbaoPages } = await import('../bundle/host/index-v5.mjs')

const SECRET_KEY_REF = 'TENCENTCLOUD_SECRET_KEY'
const SECRET_ID = 'AKIDtestSecretId0000000000000000'
/** 元宝搜索成功响应：Pages 是**字符串数组**，每个元素是 JSON 文本。 */
function yuanbaoOk(items, extra = {}) {
	return new Response(
		JSON.stringify({
			Response: {
				Pages: items.map((item) => JSON.stringify(item)),
				Query: 'q',
				Version: 'standard',
				RequestId: 'req-1',
				...extra,
			},
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	)
}
const yuanbaoSource = (overrides = {}) => ({ id: 's1', kind: 'yuanbao', mode: 'env', ref: SECRET_KEY_REF, secretId: SECRET_ID, ...overrides })
const resetUsage = () => { __resetFallbackRegistryForTests(); writeUsageDocument(usagePath(), { months: {} }) }

await test('yuanbao 腿：签名头/请求体/结果映射都成立', async () => {
	const credentials = makeFakeCredentials({ values: { [SECRET_KEY_REF]: 'sk-test' } })
	const { provider } = mountChain({ credentials, chain: { yuanbao: { cnt: 10 } } })
	resetUsage()
	setDoc([yuanbaoSource()])
	let seen
	stubFetch(async (url, init) => {
		seen = { url, init }
		return yuanbaoOk([
			{ title: '标题一', url: 'https://a.example/1', passage: '标准摘要', content: '动态摘要', date: '2026/10/22 09:00:00' },
			{ title: '重复', url: 'https://a.example/1', passage: 'x' },
			{ title: '无 passage', url: 'https://a.example/2', content: '只有动态摘要' },
		])
	})
	try {
		const result = await provider.search({ query: '今天北京的天气' }, undefined)
		assert.equal(seen.url, 'https://wsa.tencentcloudapi.com/')
		assert.equal(seen.init.method, 'POST')
		assert.equal(seen.init.headers['x-tc-action'], 'SearchPro')
		assert.equal(seen.init.headers['x-tc-version'], '2025-05-08')
		assert.equal(seen.init.headers['content-type'], 'application/json; charset=utf-8')
		assert.match(seen.init.headers.authorization, /^TC3-HMAC-SHA256 Credential=AKIDtestSecretId0000000000000000\/\d{4}-\d{2}-\d{2}\/wsa\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/u)
		assert.deepEqual(JSON.parse(seen.init.body), { Query: '今天北京的天气', Cnt: 10 })
		assert.deepEqual(result.sources, [
			{ url: 'https://a.example/1', title: '标题一', snippet: '标准摘要', publishedAt: '2026/10/22 09:00:00' },
			{ url: 'https://a.example/2', title: '无 passage', snippet: '只有动态摘要' },
		])
	} finally {
		stubFetch(realFetch)
	}
})

await test('yuanbao 腿：一次成功调用会记进本月用量（北京时间月份桶）', async () => {
	const credentials = makeFakeCredentials({ values: { [SECRET_KEY_REF]: 'sk-test' } })
	const { provider } = mountChain({ credentials })
	resetUsage()
	setDoc([yuanbaoSource()])
	stubFetch(async () => yuanbaoOk([{ url: 'https://a.example/1' }]))
	try {
		await provider.search({ query: 'q' }, undefined)
		const month = beijingMonthKey(Date.now())
		const { readUsageDocument } = await import('../bundle/host/config-store.mjs')
		const usage = readUsageDocument(usagePath())
		assert.equal(usage.doc.months[month].s1, 1, JSON.stringify(usage.doc))
	} finally {
		stubFetch(realFetch)
	}
})

await test('★额度闸门：用到上限就**不再发请求**，改走后面的腿并记 quota-exhausted', async () => {
	const credentials = makeFakeCredentials({ values: { [SECRET_KEY_REF]: 'sk-test', K2: 'k2' } })
	const { provider } = mountChain({ credentials })
	// 预算 2 次、保留 1 次 ⇒ 可用 1 次；已经用掉 1 次 ⇒ 到点
	setDoc([yuanbaoSource({ budget: { monthly: 2, reserve: 1 } }), { id: 's2', kind: 'tavily', mode: 'env', ref: 'K2' }])
	const month = beijingMonthKey(Date.now())
	writeUsageDocument(usagePath(), { months: { [month]: { s1: 1 } } })
	const urls = []
	stubFetch(async (url) => {
		urls.push(String(url))
		return tavilyOk(['https://served-by-s2'])
	})
	try {
		const result = await provider.search({ query: 'q' }, undefined)
		assert.deepEqual(result.sources.map((source) => source.url), ['https://served-by-s2'])
		assert.equal(urls.length, 1, '元宝那条腿一次请求都不该发')
		assert.ok(urls[0].includes('tavily.invalid'), urls[0])
		const log = readFileSync(`${dir}\\web-search-chain.log`, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
		const blocked = log.filter((entry) => entry.outcome === 'quota-exhausted').at(-1)
		assert.ok(blocked !== undefined, '必须留一条 quota-exhausted 审计')
		assert.equal(blocked.slot, 's1')
		assert.equal(blocked.budget.exhausted, true)
	} finally {
		stubFetch(realFetch)
	}
})

await test('额度闸门：用途中额度会随调用推进（第 1 次成功、第 2 次被拦）', async () => {
	const credentials = makeFakeCredentials({ values: { [SECRET_KEY_REF]: 'sk-test' } })
	const { provider } = mountChain({ credentials })
	resetUsage()
	setDoc([yuanbaoSource({ budget: { monthly: 1, reserve: 0 } })])
	let calls = 0
	stubFetch(async () => {
		calls += 1
		return yuanbaoOk([{ url: 'https://a.example/1' }])
	})
	try {
		await provider.search({ query: 'q' }, undefined)
		assert.equal(calls, 1)
		await assert.rejects(
			() => provider.search({ query: 'q' }, undefined),
			(error) => {
				assert.equal(error.code, 'WEB_PROVIDER_ERROR')
				assert.ok(error.message.includes('quota-exhausted'), error.message)
				return true
			},
		)
		assert.equal(calls, 1, '超额后一个请求都不许发')
	} finally {
		stubFetch(realFetch)
	}
})

await test('yuanbao 业务错误（HTTP 200 + Response.Error）⇒ 映射成腿失败并推进（AuthFailure）', async () => {
	const credentials = makeFakeCredentials({ values: { [SECRET_KEY_REF]: 'sk-test', K2: 'k2' } })
	const { provider } = mountChain({ credentials })
	resetUsage()
	setDoc([yuanbaoSource(), { id: 's2', kind: 'tavily', mode: 'env', ref: 'K2' }])
	let call = 0
	stubFetch(async () => {
		call += 1
		if (call === 1) {
			return new Response(JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: '签名错误' }, RequestId: 'r' } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		}
		return tavilyOk(['https://served-by-s2'])
	})
	try {
		const result = await provider.search({ query: 'q' }, undefined)
		assert.deepEqual(result.sources.map((source) => source.url), ['https://served-by-s2'])
	} finally {
		stubFetch(realFetch)
	}
})

await test('mapYuanbaoPages：脏元素跳过、去重、passage 优先、非数组当空', () => {
	const pages = [JSON.stringify({ url: 'u1', passage: 'p', content: 'c' }), '{bad json', JSON.stringify({ url: 'u1' }), JSON.stringify({ title: '无 url' }), { url: 'u2' }]
	assert.deepEqual(mapYuanbaoPages(pages), [{ url: 'u1', snippet: 'p' }, { url: 'u2' }])
	assert.deepEqual(mapYuanbaoPages(undefined), [])
	assert.deepEqual(mapYuanbaoPages('nope'), [])
})

await test('yuanbao 缺 SecretId ⇒ 记 credential-missing，不发请求', async () => {
	const credentials = makeFakeCredentials({ values: { [SECRET_KEY_REF]: 'sk-test' } })
	const { provider } = mountChain({ credentials })
	resetUsage()
	setDoc([{ id: 's1', kind: 'yuanbao', mode: 'env', ref: SECRET_KEY_REF }])
	let calls = 0
	stubFetch(async () => {
		calls += 1
		return yuanbaoOk([])
	})
	try {
		await assert.rejects(
			() => provider.search({ query: 'q' }, undefined),
			(error) => {
				assert.ok(error.message.includes('credential-missing'), error.message)
				return true
			},
		)
		assert.equal(calls, 0)
	} finally {
		stubFetch(realFetch)
	}
})
//#endregion

//#region DeepSeek 搜索 REST API 腿（2026-10-22 用户决定：官方 Messages 兜底关掉，用它兜底）
await test('deepseek-api 腿：Bearer + /search + 结果映射，且作为元宝额度用尽后的兜底', async () => {
	const credentials = makeFakeCredentials({ values: { [SECRET_KEY_REF]: 'sk-test', DEEPSEEK_API_KEY: 'ds-key' } })
	const { provider } = mountChain({
		credentials,
		chain: { deepseekApi: { baseURL: 'https://deepseek-api.invalid/v1/tools', count: 10, timeoutMs: 3000 } },
	})
	resetUsage()
	// 元宝预算 1 且已用 1 ⇒ 到点；下一条就是 DS 搜索 API
	setDoc([yuanbaoSource({ budget: { monthly: 1, reserve: 0 } }), { id: 's2', kind: 'deepseek-api', mode: 'env', ref: 'DEEPSEEK_API_KEY' }])
	writeUsageDocument(usagePath(), { months: { [beijingMonthKey(Date.now())]: { s1: 1 } } })
	let seen
	stubFetch(async (url, init) => {
		seen = { url, init }
		return new Response(
			JSON.stringify({
				results: [
					{ url: 'https://ds.example/1', title: '标题', snippet: '摘要', date: '2026-10-22' },
					{ url: 'https://ds.example/1', title: '重复' },
					{ title: '无 url' },
				],
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)
	})
	try {
		const result = await provider.search({ query: 'q' }, undefined)
		assert.equal(seen.url, 'https://deepseek-api.invalid/v1/tools/search')
		assert.equal(seen.init.method, 'POST')
		assert.equal(seen.init.headers.authorization, 'Bearer ds-key')
		assert.deepEqual(JSON.parse(seen.init.body), { query: 'q', count: 10, need_content: false })
		assert.deepEqual(result.sources, [{ url: 'https://ds.example/1', title: '标题', snippet: '摘要', publishedAt: '2026-10-22' }])
		const log = readFileSync(`${dir}\\web-search-chain.log`, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
		const served = log.filter((entry) => entry.outcome === 'served').at(-1)
		assert.equal(served.target, 'deepseek-api')
		assert.equal(served.slot, 's2')
	} finally {
		stubFetch(realFetch)
	}
})

await test('deepseek-api 腿：HTTP 429 ⇒ RATE_LIMIT，带出 error.message；推进到下一条', async () => {
	const credentials = makeFakeCredentials({ values: { DEEPSEEK_API_KEY: 'ds-key', K2: 'k2' } })
	const { provider } = mountChain({ credentials })
	resetUsage()
	setDoc([
		{ id: 's1', kind: 'deepseek-api', mode: 'env', ref: 'DEEPSEEK_API_KEY' },
		{ id: 's2', kind: 'tavily', mode: 'env', ref: 'K2' },
	])
	let call = 0
	stubFetch(async () => {
		call += 1
		if (call === 1) {
			return new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json' } })
		}
		return tavilyOk(['https://served-by-s2'])
	})
	try {
		const result = await provider.search({ query: 'q' }, undefined)
		assert.equal(call, 2)
		assert.deepEqual(result.sources.map((source) => source.url), ['https://served-by-s2'])
	} finally {
		stubFetch(realFetch)
	}
})
//#endregion

summary('chain-provider')
cleanup(dir)
