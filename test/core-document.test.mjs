import { test, summary, assert } from './harness.mjs'
import { defaultDocument, emptyDocument, parseDocumentText, serializeDocument, MAX_DOCUMENT_BYTES, MAX_SOURCES, DOCUMENT_VERSION, TEMPLATES } from '../bundle/host/core.mjs'

console.log('-- core: 配置文档 --')

const YUANBAO = {
	id: 's1',
	kind: 'yuanbao',
	mode: 'env',
	ref: 'TENCENTCLOUD_SECRET_KEY',
	secretId: 'AKIDtestSecretId0000000000000000',
	budget: { monthly: 2000, reserve: 100, promo: { monthly: 6000, until: '2026-11-30' } },
}

await test('默认文档播种一个 Tavily 源 + 两把 key（2026-10-23 三级模型）', () => {
	const doc = defaultDocument()
	assert.equal(doc.version, DOCUMENT_VERSION)
	assert.deepEqual(doc.sources, [
		{
			id: 's1',
			kind: 'tavily',
			keys: [
				{ id: 'k1', mode: 'env', ref: 'TAVILY_API_KEY1' },
				{ id: 'k2', mode: 'env', ref: 'TAVILY_API_KEY2' },
			],
		},
	])
})

await test('默认文档不播种 yuanbao（用户的 SecretId 不能写进包的默认值）', () => {
	assert.equal(defaultDocument().sources.some((source) => source.kind === 'yuanbao'), false)
})

await test('默认文档每次返回新对象（不许共享可变状态）', () => {
	const a = defaultDocument()
	const b = defaultDocument()
	assert.notEqual(a, b)
	assert.notEqual(a.sources, b.sources)
})

await test('模板表：yuanbao 在前、tavily 在后（界面按这个顺序渲染"添加"按钮）', () => {
	assert.deepEqual(TEMPLATES.map((template) => template.kind), ['yuanbao', 'deepseek-api', 'tavily'])
	assert.equal(TEMPLATES[0].refExample, 'TENCENTCLOUD_SECRET_KEY')
})

await test('空文档与默认文档语义不同（「删空」必须与「没配过」分得开）', () => {
	assert.deepEqual(emptyDocument(), { version: DOCUMENT_VERSION, sources: [] })
	assert.notDeepEqual(emptyDocument(), defaultDocument())
})

await test('disabled：手动停用能往返（只在 true 时写这个字段），不是删除', () => {
	const doc = {
		version: DOCUMENT_VERSION,
		sources: [
			{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1', disabled: true },
			{ id: 's2', kind: 'tavily', mode: 'env', ref: 'K2' },
		],
	}
	const text = serializeDocument(doc)
	assert.ok(text.includes('"disabled": true'), text)
	assert.equal(parseDocumentText(text).doc.sources[0].disabled, true)
	assert.equal('disabled' in parseDocumentText(text).doc.sources[1], false, 'false 不落盘')
	assert.ok(parseDocumentText('{"version":2,"sources":[{"id":"s1","kind":"tavily","mode":"env","ref":"K1","disabled":"yes"}]}').error !== undefined)
})

await test('序列化 → 解析 往返一致（含 secretId 与完整 budget），且末尾一个换行', () => {
	const doc = { version: DOCUMENT_VERSION, sources: [YUANBAO, { id: 's2', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1' }] }
	const text = serializeDocument(doc)
	assert.ok(text.endsWith('}\n'))
	assert.equal(text.includes('"version": 2'), true)
	const parsed = parseDocumentText(text)
	assert.equal(parsed.error, undefined)
	assert.deepEqual(parsed.doc.sources, doc.sources)
})

await test('serializeDocument：只写该写的字段（tavily 源不会凭空长出 secretId/budget）', () => {
	const text = serializeDocument({ version: 1, sources: [{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' }] })
	assert.equal(text.includes('secretId'), false)
	assert.equal(text.includes('budget'), false)
	assert.equal(JSON.parse(text).version, DOCUMENT_VERSION)
})

await test('非法 JSON ⇒ 退默认文档 + error（绝不抛）', () => {
	const parsed = parseDocumentText('{oops')
	assert.ok(parsed.error.includes('not valid JSON'), parsed.error)
	assert.deepEqual(parsed.doc, defaultDocument())
})

await test('根不是对象 / sources 不是数组 ⇒ 退默认 + error', () => {
	assert.ok(parseDocumentText('[]').error !== undefined)
	assert.ok(parseDocumentText('{"sources":{}}').error !== undefined)
	assert.ok(parseDocumentText('{"sources":[1]}').error !== undefined)
})

await test('源数量上限就是 4（改大/改小都必须同步界面文案、变异脚本与测试）', () => {
	assert.equal(MAX_SOURCES, 4)
})

await test(`超过 ${MAX_SOURCES} 个源 ⇒ 退默认 + error`, () => {
	const sources = Array.from({ length: MAX_SOURCES + 1 }, (_, index) => ({ id: `s${index + 1}`, kind: 'tavily', mode: 'env', ref: `K${index + 1}` }))
	const parsed = parseDocumentText(JSON.stringify({ version: DOCUMENT_VERSION, sources }))
	assert.ok(parsed.error.includes('more than'), parsed.error)
	assert.deepEqual(parsed.doc, defaultDocument())
})

await test('非法 mode / kind / id / ref ⇒ 逐条报错并退默认', () => {
	const base = { id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' }
	const cases = [
		[{ ...base, mode: 'plain' }, 'mode'],
		[{ ...base, kind: 'brave' }, 'kind'],
		[{ ...base, id: 'has space' }, 'id'],
		[{ ...base, ref: '1BAD' }, 'ref'],
	]
	for (const [source, needle] of cases) {
		const parsed = parseDocumentText(JSON.stringify({ version: DOCUMENT_VERSION, sources: [source] }))
		assert.ok(parsed.error !== undefined && parsed.error.includes(needle), `${needle} ⇒ ${parsed.error}`)
		assert.deepEqual(parsed.doc, defaultDocument())
	}
})

await test('yuanbao 源缺 secretId / secretId 非法 ⇒ 退默认 + error（别让它静默变成一条死源）', () => {
	for (const secretId of [undefined, '', 'has space', 'x'.repeat(129)]) {
		const parsed = parseDocumentText(JSON.stringify({ sources: [{ ...YUANBAO, secretId }] }))
		assert.ok(parsed.error !== undefined && parsed.error.includes('secretId'), `secretId=${JSON.stringify(secretId)} ⇒ ${parsed.error}`)
	}
})

await test('budget 非法（负 / reserve>monthly / 假日期）⇒ 退默认 + error', () => {
	const cases = [
		{ monthly: -1, reserve: 0 },
		{ monthly: 100, reserve: 101 },
		{ monthly: 0, reserve: 5 },
		{ monthly: 100, reserve: 0, promo: { monthly: 200, until: '2026-02-31' } },
		{ monthly: 100, reserve: 0, promo: { monthly: 0, until: '2026-11-30' } },
		'not-an-object',
	]
	for (const budget of cases) {
		const parsed = parseDocumentText(JSON.stringify({ sources: [{ ...YUANBAO, budget }] }))
		assert.ok(parsed.error !== undefined && parsed.error.includes('budget'), `budget=${JSON.stringify(budget)} ⇒ ${parsed.error}`)
	}
})

await test('budget.monthly = 0 ⇒ 合法（不限），serialize 往返保留', () => {
	const source = { ...YUANBAO, budget: { monthly: 0, reserve: 0 } }
	const parsed = parseDocumentText(JSON.stringify({ sources: [source] }))
	assert.equal(parsed.error, undefined)
	assert.deepEqual(parsed.doc.sources[0].budget, { monthly: 0, reserve: 0 })
})

await test('重复 id / 重复 ref ⇒ 退默认 + error', () => {
	const a = { id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' }
	const sameId = [a, { id: 's1', kind: 'tavily', mode: 'env', ref: 'K2' }]
	const sameRef = [a, { id: 's2', kind: 'tavily', mode: 'env', ref: 'K1' }]
	assert.ok(parseDocumentText(JSON.stringify({ version: DOCUMENT_VERSION, sources: sameId })).error !== undefined)
	assert.ok(parseDocumentText(JSON.stringify({ version: DOCUMENT_VERSION, sources: sameRef })).error !== undefined)
})

await test(`超过 ${MAX_DOCUMENT_BYTES} 字节 ⇒ 退默认 + error（大文件不进每次搜索）`, () => {
	const huge = JSON.stringify({ version: DOCUMENT_VERSION, sources: [], pad: 'x'.repeat(MAX_DOCUMENT_BYTES) })
	const parsed = parseDocumentText(huge)
	assert.ok(parsed.error.includes(String(MAX_DOCUMENT_BYTES)), parsed.error)
})

summary('core-document')
