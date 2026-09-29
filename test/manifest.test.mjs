import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, summary, assert } from './harness.mjs'

console.log('-- manifest: 组合包与行包声明 --')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const readJson = (rel) => JSON.parse(read(rel))

await test('bundle 包声明了 dsh.bundle.patch（官方契约：没有它就装不进去）', () => {
	const pkg = readJson('bundle/package.json')
	assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
	assert.equal(pkg.type, 'module')
	assert.equal(pkg.main, 'index-v5.mjs')
})

await test('bundle patch 只剩两条行：兜底源行 + 链本体行', () => {
	const yml = read('bundle/cordis.patch.yml')
	const ids = [...yml.matchAll(/^\s*- id:\s*(\S+)/gm)].map((match) => match[1])
	assert.deepEqual(ids, ['web-search-source-deepseek', 'web-search-chain'])
})

await test('bundle patch 里不再出现 key1/key2 行（源列表已由配置界面接管）', () => {
	const yml = read('bundle/cordis.patch.yml')
	assert.equal(/web-search-source-key[12]/.test(yml), false, yml)
	assert.equal(/dsh-search-key[12]/.test(yml), false, yml)
})

await test('链路行仍声明 tavily 传输设置（整体替换语义，别丢字段）', () => {
	const yml = read('bundle/cordis.patch.yml')
	for (const needle of ['baseURL: https://api.tavily.com', 'searchDepth:', 'maxResults:', 'topic:', 'timeoutMs:']) {
		assert.ok(yml.includes(needle), needle)
	}
})

await test('行包 dsh-search-chain：main + exports["./client"] + dsh.client.platform=web', () => {
	const pkg = readJson('row-chain/package.json')
	assert.equal(pkg.name, 'dsh-search-chain')
	assert.equal(pkg.type, 'module')
	assert.equal(pkg.main, 'index.mjs')
	assert.equal(pkg.exports?.['.'], './index.mjs')
	assert.equal(pkg.exports?.['./client'], './client.js')
	assert.equal(pkg.exports?.['./package.json'], './package.json')
	assert.equal(pkg.dsh?.client?.platform, 'web')
	assert.deepEqual(pkg.dsh?.client?.inject, [])
})

await test('行包 dsh-search-deepseek：仍是 host-only（没有 dsh.client）', () => {
	const pkg = readJson('row-deepseek/package.json')
	assert.equal(pkg.dsh?.client, undefined)
	assert.equal(pkg.main, 'index.mjs')
})

await test('两个行包的 index.mjs 都 re-export 同一个宿主模块（一个模块实例 = 一份注册表）', () => {
	for (const rel of ['row-chain/index.mjs', 'row-deepseek/index.mjs']) {
		const text = read(rel)
		assert.ok(text.includes("from '../dsh-web-search-chain/index-v5.mjs'"), rel)
		assert.ok(text.includes('export { name, inject, apply }'), rel)
	}
})

await test('bundle 包只声明两个行包依赖（file:），没有别的依赖', () => {
	const pkg = readJson('bundle/package.json')
	assert.deepEqual(pkg.dependencies, {
		'dsh-search-chain': 'file:../dsh-search-chain',
		'dsh-search-deepseek': 'file:../dsh-search-deepseek',
	})
})

await test('两个行包都不声明任何依赖（host 侧零 @deepseek-ai import）', () => {
	for (const rel of ['row-chain/package.json', 'row-deepseek/package.json']) {
		const pkg = readJson(rel)
		assert.equal(pkg.dependencies, undefined, rel)
	}
})

await test('host 半边不出现任何 @deepseek-ai 静态 import（只有官方兜底那次懒动态 import）', () => {
	const code = read('host/index-v5.mjs')
	assert.equal(/^import .*@deepseek-ai/m.test(code), false, '静态 import 不许引 @deepseek-ai')
	assert.ok(code.includes("await import('@deepseek-ai/dsh-web-search-deepseek')"))
})

summary('manifest')
