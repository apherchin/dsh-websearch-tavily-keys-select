/**
 * 3.2.0 RED：Tavily credits 分账 + 手动查额度校正。
 *
 * 口径（用户 2026-11-14 22:21）：
 *   - 每 key 分两份：credits（web_search）、fetchUrls→fetchCredits（web_fetch，每 5 次成功 URL 折算）
 *   - credits_correction 新字段，可为负/正，默认 0；只由手动「查额度」写，两个原始记账永不改动
 *   - 卡片显示 = credits + fetchCredits + credits_correction，按各自 key 分别计算后求和
 *   - 查一个 key 只修一个，没查的不修；自动路径一次 /usage 都不发
 *
 * ⚠️ 本机不能用 node --test ⇒ 逐文件 node <绝对路径>。
 */
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, summary, assert, tempDir, cleanup, makeFakeCtx, makeFakeCredentials, makeFakeConnection } from './harness.mjs'
import { writeConfigDocument } from '../bundle/host/config-store.mjs'

const dir = tempDir('credits-ledger')
process.env.DSH_HOME = dir
const {
	parseUsageText, usageEntry, usageFetchUrls, usageCorrection,
	withUsageFetch, withUsageCorrection, withUsageCredits, withUsageCount,
	serializeUsageDocument, fetchCreditsOf,
} = await import('../bundle/host/core.mjs')
const parseUsageDocument = (text) => parseUsageText(text)

console.log('-- credits-ledger: 分账与校正 --')

await test('账本解析保留 fetchUrls / fetchCredits / credits_correction（可为负）', () => {
	const doc = parseUsageDocument(JSON.stringify({ version: 3, months: { '2026-11': {
		s2: { calls: 2, credits: 7, fetchUrls: 12, fetchCredits: 3, credits_correction: -4 },
	} } })).doc
	const e = usageEntry(doc, '2026-11', 's2')
	assert.equal(e.calls, 2)
	assert.equal(e.credits, 7)
	assert.equal(usageFetchUrls(doc, '2026-11', 's2'), 12)
	assert.equal(e.fetchCredits, 3)
	assert.equal(usageCorrection(doc, '2026-11', 's2'), -4)
})

await test('旧文档（数字 / {calls} / {calls,credits}）兼容，新字段缺省为 0', () => {
	const legacy = parseUsageDocument(JSON.stringify({ version: 2, months: { '2026-11': { s2: 1, s3: { calls: 2 }, s4: { calls: 3, credits: 4 } } } })).doc
	assert.deepEqual(usageEntry(legacy, '2026-11', 's2'), { calls: 1, credits: 0, fetchUrls: 0, fetchCredits: 0, credits_correction: 0 })
	assert.deepEqual(usageEntry(legacy, '2026-11', 's3'), { calls: 2, credits: 0, fetchUrls: 0, fetchCredits: 0, credits_correction: 0 })
	assert.equal(usageEntry(legacy, '2026-11', 's4').credits, 4)
})

await test('fetchUrls 折算：basic 每 5 次成功 = 1 credit，advanced = 2', () => {
	assert.equal(fetchCreditsOf(0, 'basic'), 0)
	assert.equal(fetchCreditsOf(1, 'basic'), 1)
	assert.equal(fetchCreditsOf(5, 'basic'), 1)
	assert.equal(fetchCreditsOf(6, 'basic'), 2)
	assert.equal(fetchCreditsOf(1, 'advanced'), 2)
	assert.equal(fetchCreditsOf(11, 'advanced'), 6)
})

await test('withUsageFetch 累加 fetchUrls 并重算 fetchCredits，不碰 credits/correction', () => {
	let doc = parseUsageDocument('{"version":3,"months":{}}').doc
	doc = withUsageCount(doc, '2026-11', 's2', 1)
	doc = withUsageCredits(doc, '2026-11', 's2', 9)
	doc = withUsageCorrection(doc, '2026-11', 's2', -3)
	for (let i = 0; i < 6; i += 1) doc = withUsageFetch(doc, '2026-11', 's2', i + 1, 'basic')
	const e = usageEntry(doc, '2026-11', 's2')
	assert.equal(e.calls, 1)
	assert.equal(e.credits, 9)
	assert.equal(e.fetchUrls, 6)
	assert.equal(e.fetchCredits, 2)
	assert.equal(e.credits_correction, -3)
})

await test('withUsageCorrection 允许负数且序列化往返不丢', () => {
	let doc = parseUsageDocument('{"version":3,"months":{}}').doc
	doc = withUsageCorrection(doc, '2026-11', 's2', -5)
	const again = parseUsageDocument(serializeUsageDocument(doc)).doc
	assert.equal(usageCorrection(again, '2026-11', 's2'), -5)
})

await test('readState：每 key used = credits + fetchCredits + correction，源级求和', async () => {
	const { readState } = await import('../bundle/host/index-v5.mjs')
	writeConfigDocument(join(dir, 'web-search-chain.json'), { sources: [{ id: 'tavily', kind: 'tavily', billing: { unit: 'credits' }, keys: [
		{ id: 's2', mode: 'env', ref: 'K1' }, { id: 's3', mode: 'env', ref: 'K2' },
	] }] })
	writeFileSync(join(dir, 'web-search-chain-usage.json'), JSON.stringify({ version: 3, months: { '2026-11': {
		s2: { credits: 3, fetchUrls: 6, fetchCredits: 2, credits_correction: -1 },
		s3: { credits: 1, fetchUrls: 1, fetchCredits: 1, credits_correction: 4 },
	} } }))
	const state = await readState(makeFakeCtx({ credentials: makeFakeCredentials() }))
	const s = state.sources.find((x) => x.kind === 'tavily')
	assert.equal(s.keys.find((k) => k.id === 's2').usage.used, 4)   // 3+2-1
	assert.equal(s.keys.find((k) => k.id === 's3').usage.used, 6)   // 1+1+4
	assert.equal(s.usage.used, 10)
	assert.equal(s.usage.credits, 4)
	assert.equal(s.usage.fetchCredits, 3)
	assert.equal(s.usage.correction, 3)
})

await test('queryUsage：成功后只写被查 key 的 correction，另一个保持 0；失败不写', async () => {
	const { queryUsage, usagePath, configPath } = await import('../bundle/host/index-v5.mjs')
	writeConfigDocument(configPath(), { sources: [{ id: 'tavily', kind: 'tavily', keys: [
		{ id: 's2', mode: 'env', ref: 'K1' }, { id: 's3', mode: 'env', ref: 'K2' },
	] }] })
	writeFileSync(usagePath(), JSON.stringify({ version: 3, months: { '2026-11': {
		s2: { credits: 2, fetchUrls: 5, fetchCredits: 1 },
		s3: { credits: 9, fetchUrls: 0, fetchCredits: 0 },
	} } }))
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials({ values: { K1: 'tvly-1', K2: 'tvly-2' } }) })
	const realFetch = globalThis.fetch
	const seen = []
	globalThis.fetch = async (url, init) => {
		seen.push({ url: String(url), auth: String(init?.headers?.authorization ?? '') })
		return new Response(JSON.stringify({ account: { current_plan: 'Researcher', plan_usage: 10, plan_limit: 1000 }, key: { usage: 10 } }), {
			status: 200, headers: { 'content-type': 'application/json' },
		})
	}
	try {
		const out = await queryUsage(ctx, ['s2'])
		assert.equal(out.ok, true)
		assert.equal(out.results.s2.correctionApplied, 7)  // 10 - (2+1)
		const doc = JSON.parse(readFileSync(usagePath(), 'utf8'))
		assert.equal(doc.months['2026-11'].s2.credits_correction, 7)
		assert.equal(doc.months['2026-11'].s2.credits, 2, '原始 credits 不许被覆盖')
		assert.equal(doc.months['2026-11'].s2.fetchUrls, 5, '原始 fetchUrls 不许被覆盖')
		assert.equal(doc.months['2026-11'].s3.credits_correction, undefined, '没查的 key 不修')
		assert.equal(seen.length, 1, '只查被请求的 key')
		assert.ok(seen[0].auth.includes('tvly-1'))
	} finally { globalThis.fetch = realFetch }
})

await test('queryUsage：上游返回失败时不写任何 correction', async () => {
	const { queryUsage, usagePath, configPath } = await import('../bundle/host/index-v5.mjs')
	writeConfigDocument(configPath(), { sources: [{ id: 'tavily', kind: 'tavily', keys: [{ id: 's2', mode: 'env', ref: 'K1' }] }] })
	writeFileSync(usagePath(), JSON.stringify({ version: 3, months: {} }))
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials({ values: { K1: 'tvly-1' } }) })
	const realFetch = globalThis.fetch
	globalThis.fetch = async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })
	try {
		await queryUsage(ctx, ['s2'], { retryDelayMs: 0 })
		const doc = JSON.parse(readFileSync(usagePath(), 'utf8'))
		assert.equal(JSON.stringify(doc.months), '{}')
	} finally { globalThis.fetch = realFetch }
})

await test('抓取成功回调按 key 写 fetchUrls，不写搜索 credits', async () => {
	const { apply } = await import('../bundle/host/index-v5.mjs')
	const { usagePath: uPath, configPath: cPath } = await import('../bundle/host/index-v5.mjs')
	writeConfigDocument(cPath(), { sources: [{ id: 'tavily', kind: 'tavily', keys: [{ id: 's2', mode: 'env', ref: 'K1' }] }] })
	writeFileSync(uPath(), JSON.stringify({ version: 3, months: {} }))
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials({ values: { K1: 'KEY-1' } }), connection: makeFakeConnection() })
	const providers = []
	ctx.web.registerFetchProvider = (p) => providers.push(p)
	apply(ctx, { role: 'chain', id: 'tavily-chain', fetch: { dsFetchFallback: false } })
	const chain = providers.find((p) => p.id === 'chain-fetch')
	const leg = chain.resolveLegs().find((l) => l.id === 'tavily-extract')
	const realFetch = globalThis.fetch
	globalThis.fetch = async () => new Response('blocked', { status: 412 })
	try {
		await leg.fetch({ url: 'https://example.com/x' }) // 会抛（无 results），不该记账
	} catch { /* 预期 */ }
	globalThis.fetch = async () => new Response(JSON.stringify({ results: [{ url: 'https://example.com/x', raw_content: 'OK' }], failed_results: [] }), {
		status: 200, headers: { 'content-type': 'application/json' },
	})
	try {
		await leg.fetch({ url: 'https://example.com/x' })
		const doc = JSON.parse(readFileSync(uPath(), 'utf8'))
		const e = doc.months[Object.keys(doc.months)[0]].s2
		assert.equal(e.fetchUrls, 1)
		assert.equal(e.fetchCredits, 1)
		assert.equal(e.credits, undefined, '搜索 credits 不许被抓取记账碰到')
		assert.equal(e.credits_correction, undefined)
	} finally { globalThis.fetch = realFetch }
})

await test('自动路径（apply / readState / 搜索）不发 /usage 请求', async () => {
	const { apply, readState } = await import('../bundle/host/index-v5.mjs')
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	const realFetch = globalThis.fetch
	let usageCalls = 0
	globalThis.fetch = async (url) => {
		if (String(url).endsWith('/usage')) usageCalls += 1
		throw new Error('network disabled in test')
	}
	try {
		apply(ctx, { role: 'chain', id: 'tavily-chain' })
		await readState(ctx)
		assert.equal(usageCalls, 0)
	} finally { globalThis.fetch = realFetch }
})

summary('credits-ledger')
cleanup(dir)
