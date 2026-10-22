import { test, summary, assert } from './harness.mjs'
import { MAX_SOURCES, defaultDocument, emptyDocument, validateSubmission, nextIdIn, nextRefIn } from '../bundle/host/core.mjs'

console.log('-- core: 提交校验 --')

const previous = defaultDocument()
const env = (id, ref) => ({ id, kind: 'tavily', mode: 'env', ref })
const literal = (id, secret) => ({ id, kind: 'tavily', mode: 'literal', ...(secret === undefined ? {} : { secret }) })

await test('合法提交：env 源原样通过，无 secret', () => {
	const result = validateSubmission({ sources: [env('s1', 'TAVILY_API_KEY2')] }, previous)
	assert.equal(result.ok, true)
	assert.deepEqual(result.sources, [{ id: 's1', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY2' }])
	assert.deepEqual(result.secrets, [])
})

await test('空数组是合法提交（用户明确不要 Tavily 源）', () => {
	const result = validateSubmission({ sources: [] }, previous)
	assert.equal(result.ok, true)
	assert.deepEqual(result.sources, [])
})

await test('请求体不是对象 / sources 不是数组 / 源不是对象 ⇒ INVALID_CONFIG', () => {
	assert.equal(validateSubmission(undefined, previous).code, 'INVALID_CONFIG')
	assert.equal(validateSubmission({}, previous).code, 'INVALID_CONFIG')
	assert.equal(validateSubmission({ sources: {} }, previous).code, 'INVALID_CONFIG')
	assert.equal(validateSubmission({ sources: [1] }, previous).code, 'INVALID_CONFIG')
})

await test(`超过 ${MAX_SOURCES} 个源 ⇒ TOO_MANY_SOURCES`, () => {
	const sources = Array.from({ length: MAX_SOURCES + 1 }, (_, index) => env(undefined, `K${index + 1}`))
	const result = validateSubmission({ sources }, previous)
	assert.equal(result.code, 'TOO_MANY_SOURCES')
	assert.equal(result.ok, false)
})

await test('模板不在表内 ⇒ UNKNOWN_KIND（带 field）', () => {
	const result = validateSubmission({ sources: [{ ...env('s1', 'K1'), kind: 'brave' }] }, previous)
	assert.equal(result.code, 'UNKNOWN_KIND')
	assert.equal(result.field, 'sources[0].kind')
})

await test('mode 非法 ⇒ INVALID_CONFIG', () => {
	const result = validateSubmission({ sources: [{ ...env('s1', 'K1'), mode: 'plain' }] }, previous)
	assert.equal(result.code, 'INVALID_CONFIG')
	assert.equal(result.field, 'sources[0].mode')
})

await test('env 源：ref 空 / 非法 / 超长 ⇒ INVALID_REF，field 指向该输入框', () => {
	for (const ref of ['', '   ', '1BAD', 'HAS SPACE', 'A'.repeat(65)]) {
		const result = validateSubmission({ sources: [env('s1', ref)] }, previous)
		assert.equal(result.code, 'INVALID_REF', `ref=${JSON.stringify(ref)}`)
		assert.equal(result.field, 'sources[0].ref')
	}
})

await test('两个源同一个 ref ⇒ DUPLICATE_REF；同一个 id ⇒ DUPLICATE_ID', () => {
	assert.equal(validateSubmission({ sources: [env('s1', 'K1'), env('s2', 'K1')] }, previous).code, 'DUPLICATE_REF')
	assert.equal(validateSubmission({ sources: [env('s1', 'K1'), env('s1', 'K2')] }, previous).code, 'DUPLICATE_ID')
})

await test('id 缺省 ⇒ 自动分配未用的最小 sN', () => {
	const result = validateSubmission({ sources: [env(undefined, 'K1'), env(undefined, 'K2'), env(undefined, 'K3')] }, emptyDocument())
	assert.deepEqual(result.sources.map((source) => source.id), ['s1', 's2', 's3'])
})

await test('literal 新源 ⇒ 拿到最小可用的 WEB_SEARCH_TAVILY_<n>，并带出 secret', () => {
	const result = validateSubmission({ sources: [literal('s9', 'tvly-x')] }, emptyDocument())
	assert.equal(result.ok, true)
	assert.equal(result.sources[0].ref, 'WEB_SEARCH_TAVILY_1')
	assert.deepEqual(result.secrets, [{ id: 's9', ref: 'WEB_SEARCH_TAVILY_1', secret: 'tvly-x' }])
})

await test('literal 同 id 且旧文档也是 literal ⇒ 沿用旧 ref；不给 secret = 保持原密钥', () => {
	const prior = { version: 1, sources: [{ id: 's1', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_3' }] }
	const result = validateSubmission({ sources: [literal('s1')] }, prior)
	assert.equal(result.sources[0].ref, 'WEB_SEARCH_TAVILY_3')
	assert.deepEqual(result.secrets, [])
})

await test('同 id 但从 env 切到 literal ⇒ 拿新 ref（不许把环境变量名当存储位置）', () => {
	const result = validateSubmission({ sources: [literal('s1', 'tvly-y')] }, previous)
	assert.equal(result.sources[0].ref, 'WEB_SEARCH_TAVILY_1')
})

await test('两个新 literal 源不会撞 ref', () => {
	const result = validateSubmission({ sources: [literal('a', 'k1'), literal('b', 'k2')] }, emptyDocument())
	assert.deepEqual(result.sources.map((source) => source.ref), ['WEB_SEARCH_TAVILY_1', 'WEB_SEARCH_TAVILY_2'])
})

await test('literal secret 为空串 / 非字符串 / 超长 ⇒ INVALID_CONFIG', () => {
	for (const secret of ['', 42, null, 'x'.repeat(1025)]) {
		const result = validateSubmission({ sources: [literal('s1', secret)] }, emptyDocument())
		assert.equal(result.code, 'INVALID_CONFIG', `secret=${JSON.stringify(secret)}`)
		assert.equal(result.field, 'sources[0].secret')
	}
})

await test('env 源的 ref 两侧空白会被 trim（用户粘贴带空格不该失败）', () => {
	const result = validateSubmission({ sources: [env('s1', '  TAVILY_API_KEY2  ')] }, previous)
	assert.equal(result.sources[0].ref, 'TAVILY_API_KEY2')
})

await test('nextIdIn / nextRefIn：取最小未用，且互不干扰', () => {
	assert.equal(nextIdIn(new Set()), 's1')
	assert.equal(nextIdIn(new Set(['s1'])), 's2')
	assert.equal(nextRefIn(new Set()), 'WEB_SEARCH_TAVILY_1')
	assert.equal(nextRefIn(new Set(['WEB_SEARCH_TAVILY_1'])), 'WEB_SEARCH_TAVILY_2')
})

await test('yuanbao 源：secretId 必填 → INVALID_SECRET_ID（field 指向那个输入框）', () => {
	const yuanbao = { kind: 'yuanbao', mode: 'env', ref: 'TENCENTCLOUD_SECRET_KEY' }
	for (const secretId of [undefined, '', '   ', 'has space']) {
		const result = validateSubmission({ sources: [{ ...yuanbao, secretId }] }, emptyDocument())
		assert.equal(result.code, 'INVALID_SECRET_ID', String(secretId))
		assert.equal(result.field, 'sources[0].secretId')
	}
})

await test('yuanbao 源：secretId 两侧空白被 trim，budget 原样归一化带出', () => {
	const result = validateSubmission(
		{
			sources: [
				{
					kind: 'yuanbao',
					mode: 'env',
					ref: 'TENCENTCLOUD_SECRET_KEY',
					secretId: '  AKIDtestSecretId0000000000000000  ',
					budget: { monthly: 6000, reserve: 300, promo: { monthly: 6000, until: '2026-11-30' } },
				},
			],
		},
		emptyDocument(),
	)
	assert.equal(result.ok, true)
	assert.equal(result.sources[0].secretId, 'AKIDtestSecretId0000000000000000')
	assert.deepEqual(result.sources[0].budget, { monthly: 6000, reserve: 300, promo: { monthly: 6000, until: '2026-11-30' } })
})

await test('yuanbao 源：budget 非法 → INVALID_BUDGET（不做静默 clamp）', () => {
	for (const budget of [{ monthly: -1 }, { monthly: 100, reserve: 101 }, { monthly: 0, reserve: 1 }, { monthly: 1.5 }]) {
		const result = validateSubmission(
			{ sources: [{ kind: 'yuanbao', mode: 'env', ref: 'K1', secretId: 'AKIDxxxxxxxx', budget }] },
			emptyDocument(),
		)
		assert.equal(result.code, 'INVALID_BUDGET', JSON.stringify(budget))
		assert.equal(result.field, 'sources[0].budget')
	}
})

await test('tavily 源：即使请求里带了 secretId / budget 也不会被写进文档（形状收紧）', () => {
	const result = validateSubmission({ sources: [{ kind: 'tavily', mode: 'env', ref: 'K1', secretId: 'AKIDxxxx', budget: { monthly: 5 } }] }, emptyDocument())
	assert.equal(result.ok, true)
	assert.equal('secretId' in result.sources[0], false)
	// budget 是通用能力（Tavily 也可以限流），所以这里允许带
	assert.deepEqual(result.sources[0].budget, { monthly: 5, reserve: 0 })
})

await test('yuanbao + 明文：沿用旧 literal ref、密钥进 secrets（与 tavily 同一套凭据域）', () => {
	const prior = { version: 2, sources: [{ id: 's1', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_2' }] }
	const result = validateSubmission({ sources: [{ id: 's1', kind: 'yuanbao', mode: 'literal', secretId: 'AKIDxxxxxxxx', secret: 'sk-tencent' }] }, prior)
	assert.equal(result.ok, true)
	assert.equal(result.sources[0].ref, 'WEB_SEARCH_TAVILY_2')
	assert.deepEqual(result.secrets, [{ id: 's1', ref: 'WEB_SEARCH_TAVILY_2', secret: 'sk-tencent' }])
})

summary('core-validate')
