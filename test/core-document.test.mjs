import { test, summary, assert } from './harness.mjs'
import { defaultDocument, emptyDocument, parseDocumentText, serializeDocument, MAX_DOCUMENT_BYTES, MAX_SOURCES } from '../bundle/host/core.mjs'

console.log('-- core: 配置文档 --')

await test('默认文档播种两条：TAVILY_API_KEY1 → TAVILY_API_KEY2（2026-09-29 用户选定）', () => {
	const doc = defaultDocument()
	assert.equal(doc.version, 1)
	assert.deepEqual(doc.sources, [
		{ id: 's1', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY1' },
		{ id: 's2', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY2' },
	])
})

await test('默认文档每次返回新对象（不许共享可变状态）', () => {
	const a = defaultDocument()
	const b = defaultDocument()
	assert.notEqual(a, b)
	assert.notEqual(a.sources, b.sources)
})

await test('空文档与默认文档语义不同（「删空」必须与「没配过」分得开）', () => {
	assert.deepEqual(emptyDocument(), { version: 1, sources: [] })
	assert.notDeepEqual(emptyDocument(), defaultDocument())
})

await test('序列化 → 解析 往返一致，且末尾一个换行', () => {
	const doc = { version: 1, sources: [{ id: 's2', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1' }] }
	const text = serializeDocument(doc)
	assert.ok(text.endsWith('}\n'))
	const parsed = parseDocumentText(text)
	assert.equal(parsed.error, undefined)
	assert.deepEqual(parsed.doc.sources, doc.sources)
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

await test(`超过 ${MAX_SOURCES} 个源 ⇒ 退默认 + error`, () => {
	const sources = [1, 2, 3, 4].map((n) => ({ id: `s${n}`, kind: 'tavily', mode: 'env', ref: `K${n}` }))
	const parsed = parseDocumentText(JSON.stringify({ version: 1, sources }))
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
		const parsed = parseDocumentText(JSON.stringify({ version: 1, sources: [source] }))
		assert.ok(parsed.error !== undefined && parsed.error.includes(needle), `${needle} ⇒ ${parsed.error}`)
		assert.deepEqual(parsed.doc, defaultDocument())
	}
})

await test('重复 id / 重复 ref ⇒ 退默认 + error', () => {
	const a = { id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' }
	const sameId = [a, { id: 's1', kind: 'tavily', mode: 'env', ref: 'K2' }]
	const sameRef = [a, { id: 's2', kind: 'tavily', mode: 'env', ref: 'K1' }]
	assert.ok(parseDocumentText(JSON.stringify({ version: 1, sources: sameId })).error !== undefined)
	assert.ok(parseDocumentText(JSON.stringify({ version: 1, sources: sameRef })).error !== undefined)
})

await test(`超过 ${MAX_DOCUMENT_BYTES} 字节 ⇒ 退默认 + error（大文件不进每次搜索）`, () => {
	const huge = JSON.stringify({ version: 1, sources: [], pad: 'x'.repeat(MAX_DOCUMENT_BYTES) })
	const parsed = parseDocumentText(huge)
	assert.ok(parsed.error.includes(String(MAX_DOCUMENT_BYTES)), parsed.error)
})

summary('core-document')
