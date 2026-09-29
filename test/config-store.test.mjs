import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, summary, assert, tempDir, cleanup } from './harness.mjs'
import { configDocumentPath, readConfigDocument, writeConfigDocument } from '../bundle/host/config-store.mjs'
import { defaultDocument, MAX_DOCUMENT_BYTES } from '../bundle/host/core.mjs'

console.log('-- config-store: 读写与降级 --')

const dir = tempDir('config-store')
const path = configDocumentPath(dir)

await test('路径 = <home>\\web-search-chain.json', () => {
	assert.equal(path, join(dir, 'web-search-chain.json'))
})

await test('文件不存在 ⇒ 默认文档、无 error（不主动落盘）', () => {
	const result = readConfigDocument(path)
	assert.deepEqual(result.doc, defaultDocument())
	assert.equal(result.error, undefined)
	assert.equal(existsSync(path), false)
})

await test('合法文件 ⇒ 原样读出，无 error', () => {
	writeConfigDocument(path, { sources: [{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' }] })
	const result = readConfigDocument(path)
	assert.equal(result.error, undefined)
	assert.deepEqual(result.doc.sources, [{ id: 's1', kind: 'tavily', mode: 'env', ref: 'K1' }])
})

await test('损坏文件 ⇒ 默认文档 + error（绝不抛）', () => {
	writeFileSync(path, '{oops', 'utf8')
	const result = readConfigDocument(path)
	assert.deepEqual(result.doc, defaultDocument())
	assert.ok(result.error.includes('损坏'), result.error)
})

await test(`超过 ${MAX_DOCUMENT_BYTES} 字节 ⇒ 默认文档 + error（不读进每次搜索）`, () => {
	writeFileSync(path, JSON.stringify({ version: 1, sources: [], pad: 'x'.repeat(MAX_DOCUMENT_BYTES) }), 'utf8')
	const result = readConfigDocument(path)
	assert.deepEqual(result.doc, defaultDocument())
	assert.ok(result.error.includes(String(MAX_DOCUMENT_BYTES)), result.error)
})

await test('`sources: []` 与「文件不存在」区分开（空数组是明确语义）', () => {
	writeConfigDocument(path, { sources: [] })
	const result = readConfigDocument(path)
	assert.equal(result.error, undefined)
	assert.deepEqual(result.doc.sources, [])
})

await test('原子写：不留 .tmp，落盘的是新内容', () => {
	writeConfigDocument(path, { sources: [] })
	assert.equal(existsSync(`${path}.tmp`), false)
	assert.ok(readFileSync(path, 'utf8').includes('"sources": []'))
})

await test('目录不存在 ⇒ 自动创建（首次保存不需要预建目录）', () => {
	const nested = join(dir, 'deep', 'nested')
	const nestedPath = configDocumentPath(nested)
	writeConfigDocument(nestedPath, { sources: [] })
	assert.equal(existsSync(nestedPath), true)
})

await test('序列化后的版本号恒为 1（不接受外部塞进来的别的值）', () => {
	writeConfigDocument(path, { version: 99, sources: [] })
	assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1)
})

summary('config-store')
cleanup(dir)
