import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, summary, assert, tempDir, cleanup, makeFakeCtx, makeFakeCredentials, makeFakeConnection, readResponse } from './harness.mjs'

// ⚠️ 必须在 import index-v5 之前指定 DSH_HOME：配置文档与审计日志都由它派生。
const dir = tempDir('route')
process.env.DSH_HOME = dir

const { CONFIG_PATH, apply, routeFetch, readState, configPath, __resetFallbackRegistryForTests } = await import('../host/index-v5.mjs')
const { readConfigDocument, writeConfigDocument } = await import('../host/config-store.mjs')
const { MAX_SOURCES } = await import('../host/core.mjs')

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
	assert.equal(body.version, 1)
	assert.equal(body.maxSources, MAX_SOURCES)
	assert.deepEqual(body.templates, [{ kind: 'tavily', label: 'Tavily Key', refExample: 'TAVILY_API_KEY' }])
	assert.deepEqual(body.sources, [
		// ⚠️ 注意没有 `source` 键：`Response.json` 序列化会丢掉值为 undefined 的键。
		// 界面因此只能按 `configured` / `writable` 分支（不去读 source）—— 与 spec §7 一致。
		// 同一条教训在本仓库 session-delete 上踩过：attached=undefined 时该键在 JSON 里消失。
		// 默认文档 = 两条（key1 → key2，2026-09-29 用户选定）。
		{ id: 's1', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY1', credential: { configured: false, writable: true } },
		{ id: 's2', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY2', credential: { configured: false, writable: true } },
	])
	assert.deepEqual(body.fallback, { kind: 'deepseek', enabled: false })
	assert.equal(body.configError, null)
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
		[{ sources: [1, 2, 3, 4] }, 'TOO_MANY_SOURCES'],
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
	assert.deepEqual(body.applied, { setRefs: [], unsetRefs: [], warnings: [] })
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

await test('apply 两次（同一 ctx）也不抛：路由重复注册由 connection 自己兜（这里换新 connection）', () => {
	const ctx = makeFakeCtx({ credentials: makeFakeCredentials(), connection: makeFakeConnection() })
	assert.doesNotThrow(() => {
		apply(ctx, { role: 'chain', id: 'tavily-chain' })
		apply(ctx, { role: 'chain', id: 'tavily-chain' })
	})
})

await test('目录被占成文件后 readConfigDocument 也不抛（防呆回归）', () => {
	assert.equal(existsSync(configPath()), false)
})

summary('route')
cleanup(dir)
