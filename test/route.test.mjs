import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, summary, assert, tempDir, cleanup, makeFakeCtx, makeFakeCredentials, makeFakeConnection, readResponse } from './harness.mjs'

// ⚠️ 必须在 import index-v5 之前指定 DSH_HOME：配置文档与审计日志都由它派生。
const dir = tempDir('route')
process.env.DSH_HOME = dir

const { CONFIG_PATH, apply, routeFetch, readState, configPath, usagePath, __resetFallbackRegistryForTests } = await import('../bundle/host/index-v5.mjs')
const { readConfigDocument, readUsageDocument, writeConfigDocument, writeUsageDocument } = await import('../bundle/host/config-store.mjs')
const { MAX_SOURCES, beijingMonthKey } = await import('../bundle/host/core.mjs')

// 模块级兜底注册表在同一进程里被别的测试文件挂过 ⇒ 先清空，保证本文件的断言与顺序无关。
__resetFallbackRegistryForTests()

console.log('-- route: 配置路由 --')

const post = (body, ctx) => routeFetch(ctx, { method: 'POST', json: async () => body })
const get = (ctx) => routeFetch(ctx, { method: 'GET' })

await test('路由常量 = /api/web-search-chain.config（路径段合法：^[A-Za-z0-9_$.-]+$）', () => {
	assert.equal(CONFIG_PATH, '/api/web-search-chain.config')
})

await test('apply 注册路由：path / methods / requestBody 都对，且挂在 ctx.effect 上', () => {
	const connection = makeFakeConnection()
	const ctx = makeFakeCtx({ connection, credentials: makeFakeCredentials() })
	apply(ctx, { role: 'chain', id: 'tavily-chain' })
	assert.equal(connection.routes.length, 1)
	const route = connection.routes[0]
	assert.equal(route.path, CONFIG_PATH)
	assert.deepEqual(route.methods, ['GET', 'POST'])
	assert.equal(route.requestBody, 'buffered')
	assert.equal(typeof route.fetch, 'function')
	assert.ok(ctx.__effects.some((effect) => effect.label.includes('config route')), '路由必须注册在 effect 里')
})

await test('connection 服务不可用 ⇒ apply 不抛（只是没有配置界面）', () => {
	const ctx = makeFakeCtx({ connection: undefined, credentials: makeFakeCredentials() })
	assert.doesNotThrow(() => apply(ctx, { role: 'chain', id: 'tavily-chain' }))
})

await test('★回归：connection「稍后才就绪」时路由必须补注册（本次真机 404 的根因）', () => {
	// 现场：本行的硬门禁只声明了 web ⇒ apply 可能在 connection 被提供**之前**就跑。
	// 旧实现一次性 `ctx.get('connection')` 拿到 undefined ⇒ 路由永远不注册 ⇒ 页面报
	// 「读取配置失败：HTTP 404」（而两行都显示"运行中"，因为 apply 本身没抛）。
	const connection = makeFakeConnection()
	const ctx = makeFakeCtx({ connection, credentials: makeFakeCredentials(), deferred: ['connection'] })
	apply(ctx, { role: 'chain', id: 'tavily-chain' })
	assert.equal(connection.routes.length, 0, '服务未就绪时先不注册（这是对的）')
	ctx.__deliver('connection')
	assert.equal(connection.routes.length, 1, '服务就绪后必须补注册，否则页面 404')
	assert.equal(connection.routes[0].path, CONFIG_PATH)
	assert.deepEqual(connection.routes[0].methods, ['GET', 'POST'])
})

await test('★回归：connection 永远不到达时，搜索 provider 仍必须注册（不能连搜索一起丢）', () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials() }) // 不给 connection
	assert.doesNotThrow(() => apply(ctx, { role: 'chain', id: 'tavily-chain' }))
	assert.equal(ctx.__provider?.id, 'tavily-chain', '搜索 provider 不依赖 connection，必须照常注册')
})

await test('开机探针：apply / 服务就绪 / 路由注册 三步都落进审计日志（真机问题可直接读日志定性）', () => {
	const connection = makeFakeConnection()
	const ctx = makeFakeCtx({ connection, credentials: makeFakeCredentials() })
	apply(ctx, { role: 'chain', id: 'tavily-chain' })
	const lines = readFileSync(join(dir, 'web-search-chain.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
	const steps = lines.filter((entry) => entry.probe === true).map((entry) => entry.step)
	for (const step of ['apply-chain', 'connection-injected', 'route-registered']) {
		assert.ok(steps.includes(step), `缺探针 ${step}；实际 ${JSON.stringify(steps)}`)
	}
})

await test('GET：文件不存在时给默认文档 + 默认凭据状态 + 模板表', async () => {
	const credentials = makeFakeCredentials()
	const ctx = makeFakeCtx({ credentials, connection: makeFakeConnection() })
	const { status, body } = await readResponse(await get(ctx))
	assert.equal(status, 200)
	assert.equal(body.ok, true)
	assert.equal(body.version, 2)
	assert.equal(body.maxSources, MAX_SOURCES)
	assert.deepEqual(body.templates, [
		{ kind: 'yuanbao', label: '腾讯元宝搜索', refExample: 'TENCENTCLOUD_SECRET_KEY' },
		{ kind: 'deepseek-api', label: 'DeepSeek 搜索 API', refExample: 'DEEPSEEK_API_KEY' },
		{ kind: 'tavily', label: 'Tavily Key', refExample: 'TAVILY_API_KEY' },
	])
	const month = beijingMonthKey(Date.now())
	const unlimitedUsage = { month, unlimited: true, monthly: null, reserve: 0, used: 0, remaining: null, exhausted: false, promo: null }
	assert.deepEqual(body.sources, [
		// ⚠️ 注意没有 `source` 键：`Response.json` 序列化会丢掉值为 undefined 的键。
		// 界面因此只能按 `configured` / `writable` 分支（不去读 source）—— 与 spec §7 一致。
		// 同一条教训在本仓库 session-delete 上踩过：attached=undefined 时该键在 JSON 里消失。
		// 默认文档 = 两条 Tavily（key1 → key2，2026-09-29 用户选定）。
		{ id: 's1', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY1', budget: null, credential: { configured: false, writable: true }, usage: unlimitedUsage, disabled: false, autoDisabled: null },
		{ id: 's2', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY2', budget: null, credential: { configured: false, writable: true }, usage: unlimitedUsage, disabled: false, autoDisabled: null },
	])
	assert.deepEqual(body.defaults, {
		budgets: {
			yuanbao: { monthly: 2000, reserve: 100, promo: { monthly: 6000, until: '2026-11-30' } },
			'deepseek-api': null,
			tavily: null,
		},
	})
	assert.deepEqual(body.fallback, { kind: 'deepseek', enabled: false })
	assert.equal(body.configError, null)
	assert.equal(body.usageError, null)
	assert.equal(body.stateError, null)
})

await test('GET：文档损坏时照常 200，并用 configError 告知界面', async () => {
	const { writeFileSync } = await import('node:fs')
	writeFileSync(configPath(), '{oops', 'utf8')
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	const { status, body } = await readResponse(await get(ctx))
	assert.equal(status, 200)
	assert.ok(typeof body.configError === 'string' && body.configError.includes('损坏'), body.configError)
	assert.equal(body.sources.length, 2, '损坏时退成默认文档（两条）')
})

await test('GET：兜底行挂载后 fallback.enabled = true', async () => {
	writeConfigDocument(configPath(), { sources: [] })
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	apply(ctx, { role: 'source', slot: 'deepseek', kind: 'deepseek', keyRef: 'DEEPSEEK_API_KEY' })
	const { body } = await readResponse(await get(ctx))
	assert.deepEqual(body.fallback, { kind: 'deepseek', enabled: true })
})

await test('GET：凭据状态取 describe 的三元组，且**从不返回值**', async () => {
	writeConfigDocument(configPath(), { sources: [{ id: 's1', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1' }] })
	const credentials = makeFakeCredentials({ values: { WEB_SEARCH_TAVILY_1: 'tvly-secret' } })
	const ctx = makeFakeCtx({ credentials, connection: makeFakeConnection() })
	const { body } = await readResponse(await get(ctx))
	assert.deepEqual(body.sources[0].credential, { configured: true, source: 'store', writable: true })
	assert.equal(JSON.stringify(body).includes('tvly-secret'), false, 'GET 响应里绝不能出现明文')
})

await test('GET：被环境变量遮住的 ref 报 writable:false', async () => {
	writeConfigDocument(configPath(), { sources: [{ id: 's1', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY2' }] })
	const credentials = makeFakeCredentials({ shadowed: ['TAVILY_API_KEY2'] })
	const ctx = makeFakeCtx({ credentials, connection: makeFakeConnection() })
	const { body } = await readResponse(await get(ctx))
	assert.deepEqual(body.sources[0].credential, { configured: true, source: 'environment', writable: false })
})

await test('POST 校验失败 ⇒ 400 + code/field，且**一个字节都不写**', async () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	const before = readConfigDocument(configPath()).doc
	const cases = [
		[{ sources: 'nope' }, 'INVALID_CONFIG'],
		[{ sources: Array.from({ length: MAX_SOURCES + 1 }, () => ({ kind: 'tavily', mode: 'env', ref: 'K' })) }, 'TOO_MANY_SOURCES'],
		[{ sources: [{ kind: 'brave', mode: 'env', ref: 'K1' }] }, 'UNKNOWN_KIND'],
		[{ sources: [{ kind: 'tavily', mode: 'plain', ref: 'K1' }] }, 'INVALID_CONFIG'],
		[{ sources: [{ kind: 'tavily', mode: 'env', ref: '1BAD' }] }, 'INVALID_REF'],
	]
	for (const [body, code] of cases) {
		const { status, body: payload } = await readResponse(await post(body, ctx))
		assert.equal(status, 400, code)
		assert.equal(payload.ok, false)
		assert.equal(payload.code, code, JSON.stringify(payload))
	}
	assert.deepEqual(readConfigDocument(configPath()).doc, before)
})

await test('POST 坏 JSON ⇒ 400 BAD_JSON', async () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	const response = await routeFetch(ctx, { method: 'POST', json: async () => { throw new Error('bad json') } })
	const { status, body } = await readResponse(response)
	assert.equal(status, 400)
	assert.equal(body.code, 'BAD_JSON')
})

await test('不支持的方法 ⇒ 405（别假装成功）', async () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	const response = await routeFetch(ctx, { method: 'DELETE', json: async () => ({}) })
	assert.equal(response.status, 405)
	assert.equal((await response.json()).code, 'METHOD_NOT_ALLOWED')
})

await test('POST 合法 env 提交 ⇒ 200、文档落盘、返回 applied', async () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	const { status, body } = await readResponse(await post({ sources: [{ id: 's1', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY9' }] }, ctx))
	assert.equal(status, 200)
	assert.equal(body.ok, true)
	assert.deepEqual(body.applied, { setRefs: [], unsetRefs: [], warnings: [], usage: {}, restoredAuto: {} })
	assert.deepEqual(readConfigDocument(configPath()).doc.sources, [{ id: 's1', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY9' }])
	assert.equal(body.sources[0].ref, 'TAVILY_API_KEY9')
})

await test('POST 明文 ⇒ 调 credentials.set(ref, value)，响应里**没有**明文', async () => {
	const credentials = makeFakeCredentials()
	const ctx = makeFakeCtx({ credentials, connection: makeFakeConnection() })
	const { status, body } = await readResponse(await post({ sources: [{ id: 's1', kind: 'tavily', mode: 'literal', secret: 'tvly-secret' }] }, ctx))
	assert.equal(status, 200)
	assert.deepEqual(credentials.calls.set, [['WEB_SEARCH_TAVILY_1', 'tvly-secret']])
	assert.deepEqual(body.applied.setRefs, ['WEB_SEARCH_TAVILY_1'])
	assert.equal(JSON.stringify(body).includes('tvly-secret'), false, '响应里绝不能出现明文')
	assert.deepEqual(readConfigDocument(configPath()).doc.sources, [{ id: 's1', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1' }])
})

await test('POST 明文留空（不带 secret）⇒ 不调 set，引用名与密钥都保持', async () => {
	const credentials = makeFakeCredentials({ values: { WEB_SEARCH_TAVILY_1: 'tvly-old' } })
	writeConfigDocument(configPath(), { sources: [{ id: 's1', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1' }] })
	const ctx = makeFakeCtx({ credentials, connection: makeFakeConnection() })
	const { status } = await readResponse(await post({ sources: [{ id: 's1', kind: 'tavily', mode: 'literal' }] }, ctx))
	assert.equal(status, 200)
	assert.deepEqual(credentials.calls.set, [])
	assert.deepEqual(credentials.calls.unset, [])
	assert.equal(credentials.values.get('WEB_SEARCH_TAVILY_1'), 'tvly-old')
})

await test('POST 删除 literal 源 ⇒ unset 被调用并回报', async () => {
	const credentials = makeFakeCredentials({ values: { WEB_SEARCH_TAVILY_1: 'tvly-old' } })
	writeConfigDocument(configPath(), { sources: [{ id: 's1', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1' }] })
	const ctx = makeFakeCtx({ credentials, connection: makeFakeConnection() })
	const { body } = await readResponse(await post({ sources: [] }, ctx))
	assert.deepEqual(credentials.calls.unset, ['WEB_SEARCH_TAVILY_1'])
	assert.deepEqual(body.applied.unsetRefs, ['WEB_SEARCH_TAVILY_1'])
	assert.equal(credentials.values.has('WEB_SEARCH_TAVILY_1'), false)
})

await test('POST 删除被环境变量遮住的 literal 源 ⇒ **不** unset（不跟别人的凭据较劲）', async () => {
	const credentials = makeFakeCredentials({ shadowed: ['WEB_SEARCH_TAVILY_1'] })
	writeConfigDocument(configPath(), { sources: [{ id: 's1', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1' }] })
	const ctx = makeFakeCtx({ credentials, connection: makeFakeConnection() })
	const { status, body } = await readResponse(await post({ sources: [] }, ctx))
	assert.equal(status, 200)
	assert.deepEqual(credentials.calls.unset, [])
	assert.deepEqual(body.applied.unsetRefs, [])
})

await test('POST literal 但该 ref 只读 ⇒ 409 CREDENTIAL_READONLY，文档未写', async () => {
	writeConfigDocument(configPath(), { sources: [{ id: 's1', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1' }] })
	const credentials = makeFakeCredentials({ shadowed: ['WEB_SEARCH_TAVILY_1'] })
	const ctx = makeFakeCtx({ credentials, connection: makeFakeConnection() })
	const { status, body } = await readResponse(await post({ sources: [{ id: 's1', kind: 'tavily', mode: 'literal', secret: 'tvly-x' }] }, ctx))
	assert.equal(status, 409)
	assert.equal(body.code, 'CREDENTIAL_READONLY')
	assert.deepEqual(credentials.calls.set, [])
	assert.deepEqual(readConfigDocument(configPath()).doc.sources, [{ id: 's1', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1' }])
})

await test('POST 明文但凭据服务不可用 ⇒ 500 CREDENTIAL_FAILED，文档未写', async () => {
	const before = readConfigDocument(configPath()).doc
	const ctx = makeFakeCtx({ credentials: undefined, connection: makeFakeConnection() })
	const { status, body } = await readResponse(await post({ sources: [{ id: 's1', kind: 'tavily', mode: 'literal', secret: 'tvly-x' }] }, ctx))
	assert.equal(status, 500)
	assert.equal(body.code, 'CREDENTIAL_FAILED')
	assert.deepEqual(readConfigDocument(configPath()).doc, before)
})

await test('文档写失败 ⇒ 500 CONFIG_WRITE_FAILED（把路径占成目录来制造失败）', async () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	cleanup(configPath())
	mkdirSync(configPath(), { recursive: true })
	try {
		const { status, body } = await readResponse(await post({ sources: [{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' }] }, ctx))
		assert.equal(status, 500)
		assert.equal(body.code, 'CONFIG_WRITE_FAILED')
	} finally {
		cleanup(configPath())
	}
})

await test('readState 直接可用（界面首次加载走的就是它）', async () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	const state = await readState(ctx)
	assert.equal(state.ok, true)
	assert.equal(Array.isArray(state.sources), true)
})

//#region 元宝搜索源（2026-10-22）
const YUANBAO_SUBMISSION = {
	id: 's1',
	kind: 'yuanbao',
	mode: 'env',
	ref: 'TENCENTCLOUD_SECRET_KEY',
	secretId: 'AKIDtestSecretId0000000000000000',
	budget: { monthly: 2000, reserve: 100, promo: { monthly: 6000, until: '2026-11-30' } },
}

await test('POST yuanbao：落盘含 secretId + budget，GET 回来带额度状态（活动期按 6000 算）', async () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	const { status, body } = await readResponse(await post({ sources: [YUANBAO_SUBMISSION] }, ctx))
	assert.equal(status, 200)
	assert.equal(body.ok, true)
	const doc = readConfigDocument(configPath()).doc
	assert.deepEqual(doc.sources[0].secretId, 'AKIDtestSecretId0000000000000000')
	assert.deepEqual(doc.sources[0].budget, YUANBAO_SUBMISSION.budget)
	const state = await readState(ctx)
	const source = state.sources[0]
	assert.equal(source.usage.used, 0)
	assert.equal(source.usage.monthly, 6000, '活动期内生效额度是 6000')
	assert.equal(source.usage.reserve, 100)
	assert.equal(source.usage.remaining, 5900)
	assert.equal(source.usage.exhausted, false)
	assert.equal(source.usage.promo.active, true)
})

await test('POST yuanbao：SecretId 可更换（改一次就覆盖，不留旧值）', async () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	await readResponse(await post({ sources: [YUANBAO_SUBMISSION] }, ctx))
	const next = { ...YUANBAO_SUBMISSION, secretId: 'AKIDanotherSecretId000000000000000000' }
	const { status } = await readResponse(await post({ sources: [next] }, ctx))
	assert.equal(status, 200)
	assert.equal(readConfigDocument(configPath()).doc.sources[0].secretId, 'AKIDanotherSecretId000000000000000000')
})

await test('POST yuanbao 缺 SecretId ⇒ 400 INVALID_SECRET_ID，且一个字都不写', async () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	const before = readConfigDocument(configPath()).doc
	const { status, body } = await readResponse(await post({ sources: [{ ...YUANBAO_SUBMISSION, secretId: '' }] }, ctx))
	assert.equal(status, 400)
	assert.equal(body.code, 'INVALID_SECRET_ID')
	assert.deepEqual(readConfigDocument(configPath()).doc, before)
})

await test('POST 用量校准：只写在请求里出现的源，越界/未知 id ⇒ 400 INVALID_USAGE', async () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	writeUsageDocument(usagePath(), { months: {} })
	const { status, body } = await readResponse(await post({ sources: [YUANBAO_SUBMISSION], usage: { s1: 1234 } }, ctx))
	assert.equal(status, 200)
	assert.deepEqual(body.applied.usage, { s1: 1234 })
	const month = beijingMonthKey(Date.now())
	assert.equal(readUsageDocument(usagePath()).doc.months[month].s1, 1234)
	assert.equal(body.sources[0].usage.used, 1234, 'GET 回来的状态要立刻反映校准值')

	for (const usage of [{ s9: 1 }, { s1: -1 }, { s1: 'x' }, 'nope']) {
		const rejected = await readResponse(await post({ sources: [YUANBAO_SUBMISSION], usage }, ctx))
		assert.equal(rejected.status, 400, JSON.stringify(usage))
		assert.equal(rejected.body.code, 'INVALID_USAGE')
	}
	// 被拒的校准不该改动账本
	assert.equal(readUsageDocument(usagePath()).doc.months[month].s1, 1234)
})

await test('GET：用量文件损坏时照常 200，并给出 usageError（界面能看见）', async () => {
	const { writeFileSync } = await import('node:fs')
	// 清掉进程内用量缓存，才能断言"坏文件 ⇒ 按 0 计"这条降级（否则 max(文件, 缓存) 会拿缓存值）
	__resetFallbackRegistryForTests()
	writeFileSync(usagePath(), '{oops', 'utf8')
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	const { status, body } = await readResponse(await get(ctx))
	assert.equal(status, 200)
	assert.ok(typeof body.usageError === 'string' && body.usageError.includes('用量文件损坏'), body.usageError)
	assert.equal(body.sources[0].usage.used, 0)
})
//#region 停用（disable，不是 delete）与自动停用
await test('POST：手动停用写进文档（源还在，只是 disabled: true），GET 如实返回', async () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	const disabled = { ...YUANBAO_SUBMISSION, disabled: true }
	const { status, body } = await readResponse(await post({ sources: [disabled] }, ctx))
	assert.equal(status, 200)
	assert.equal(readConfigDocument(configPath()).doc.sources[0].disabled, true, '停用必须落盘（不是删除）')
	assert.equal(readConfigDocument(configPath()).doc.sources.length, 1)
	assert.equal(body.sources[0].disabled, true)
	assert.equal(body.sources[0].secretId, YUANBAO_SUBMISSION.secretId, '停用不丢字段')
})

await test('GET：自动停用状态来自运行时状态文件（与手动 disabled 分开）', async () => {
	const { writeRuntimeState } = await import('../bundle/host/config-store.mjs')
	const { runtimePath } = await import('../bundle/host/index-v5.mjs')
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	await readResponse(await post({ sources: [YUANBAO_SUBMISSION] }, ctx))
	writeRuntimeState(runtimePath(), { sources: { s1: { fails: 3, autoDisabledAt: '2026-10-22T05:00:00.000Z', reason: 'HTTP 432' } } })
	const { body } = await readResponse(await get(ctx))
	assert.equal(body.sources[0].disabled, false)
	assert.deepEqual(body.sources[0].autoDisabled, { at: '2026-10-22T05:00:00.000Z', reason: 'HTTP 432' })
})

await test('POST resetAutoDisabled：清掉自动停用标记（源仍在），并在 applied 里回报', async () => {
	const { writeRuntimeState, readRuntimeState } = await import('../bundle/host/config-store.mjs')
	const { runtimePath } = await import('../bundle/host/index-v5.mjs')
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	await readResponse(await post({ sources: [YUANBAO_SUBMISSION] }, ctx))
	writeRuntimeState(runtimePath(), { sources: { s1: { fails: 3, autoDisabledAt: '2026-10-22T05:00:00.000Z', reason: 'HTTP 432' }, s9: { fails: 9 } } })
	const { status, body } = await readResponse(await post({ sources: [YUANBAO_SUBMISSION], resetAutoDisabled: ['s1', 's9', 'nope'] }, ctx))
	assert.equal(status, 200)
	assert.deepEqual(body.applied.restoredAuto, { s1: { at: '2026-10-22T05:00:00.000Z', reason: 'HTTP 432' } }, '只恢复真实存在且属于这份配置的 id')
	assert.equal(body.sources[0].autoDisabled, null)
	const state = readRuntimeState(runtimePath()).state
	assert.equal(state.sources.s1, undefined)
	assert.ok(state.sources.s9 !== undefined, '不在这份配置里的 id 不许被清（防误伤）')
})
//#endregion

await test('apply 两次（同一 ctx）也不抛：路由重复注册由 connection 自己兜（这里换新 connection）', () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	assert.doesNotThrow(() => {
		apply(ctx, { role: 'chain', id: 'tavily-chain' })
		apply(ctx, { role: 'chain', id: 'tavily-chain' })
	})
})

await test('配置文件被占成目录时 readConfigDocument 也不抛（防呆回归）', () => {
	cleanup(configPath())
	mkdirSync(configPath(), { recursive: true })
	try {
		const result = readConfigDocument(configPath())
		assert.ok(typeof result.error === 'string' && result.error.length > 0, String(result.error))
		assert.equal(result.doc.sources.length, 2, '读不了就退默认文档')
	} finally {
		cleanup(configPath())
	}
})

summary('route')
cleanup(dir)
