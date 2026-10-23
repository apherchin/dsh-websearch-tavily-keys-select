import { readFileSync } from 'node:fs'

/**
 * 极简 semver：判断 `^X.Y.Z` 是否覆盖版本 `V`（只处理本项目用到的 caret 形式）。
 * 例：covers('^3.0.0', '3.0.1') === true；covers('^2.0.0', '3.0.0') === false。
 */
const covers = (range, version) => {
	const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim())
	const target = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim())
	if (caret === null || target === null) return false
	const [rMajor, rMinor, rPatch] = [Number(caret[1]), Number(caret[2]), Number(caret[3])]
	const [vMajor, vMinor, vPatch] = [Number(target[1]), Number(target[2]), Number(target[3])]
	if (rMajor === 0) return vMajor === 0 && vMinor === rMinor && vPatch >= rPatch
	return vMajor === rMajor && (vMinor > rMinor || (vMinor === rMinor && vPatch >= rPatch))
}
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
	assert.equal(pkg.main, './host/index-v5.mjs', 'host/ 已并入包内（npm 包不能引用 ../host）')
	assert.equal(pkg.name, 'dsh-websearch-tavily-keys-select', '发布用的包名')
	assert.equal(pkg.private, undefined, 'private 必须去掉，否则 npm 拒绝发布')
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

await test('两个行包的 index.mjs 都按**包名** re-export 同一个宿主模块（一个模块实例 = 一份注册表）', () => {
	for (const rel of ['row-chain/index.mjs', 'row-deepseek/index.mjs']) {
		const text = read(rel)
		// ⚠️ 必须是包名导入：相对路径 `../dsh-web-search-chain/index-v5.mjs` 在 pnpm 的虚拟 store
		//    布局下解析不到（`.pnpm/dsh-search-chain@…/node_modules/` 里没有该兄弟目录）⇒ 发布阻塞点。
		assert.ok(text.includes("from 'dsh-websearch-tavily-keys-select'"), rel)
		// 只禁"相对路径导入"这种形态（注释里提到旧路径是允许的 —— 那是在解释为什么不能这么写）
		assert.equal(/from\s+['"]\.\.\/dsh-web-search-chain/.test(text), false, `${rel} 仍用相对路径导入`)
		assert.ok(text.includes('export { name, inject, apply }'), rel)
	}
})

await test('两个行包都声明了 bundle 包依赖（裸包名导入要能解析）', () => {
	for (const rel of ['row-chain/package.json', 'row-deepseek/package.json']) {
		const pkg = readJson(rel)
		// 声明的范围必须覆盖 bundle 的当前版本
		assert.equal(covers(pkg.dependencies?.['dsh-websearch-tavily-keys-select'], readJson('bundle/package.json').version), true, rel)
		assert.equal(pkg.private, undefined, `${rel} 的 private 必须去掉`)
	}
})

await test('bundle 包只声明两个行包依赖（发布用版本号；file: 无法发布）', () => {
	const pkg = readJson('bundle/package.json')
	assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['dsh-search-chain', 'dsh-search-deepseek'])
	// 声明的是 caret 范围：只要**覆盖**行包当前版本就行（`^3.0.0` 覆盖 3.0.1）
	assert.equal(covers(pkg.dependencies['dsh-search-chain'], readJson('row-chain/package.json').version), true, pkg.dependencies['dsh-search-chain'])
	assert.equal(covers(pkg.dependencies['dsh-search-deepseek'], readJson('row-deepseek/package.json').version), true, pkg.dependencies['dsh-search-deepseek'])
})

await test('两个行包只依赖 bundle 包，且不依赖任何 @deepseek-ai 包（host 侧零 @deepseek-ai 依赖）', () => {
	for (const rel of ['row-chain/package.json', 'row-deepseek/package.json']) {
		const pkg = readJson(rel)
		// 发布形态：行包必须声明 bundle 包依赖，否则"按包名 re-export"在 pnpm 下解析不到。
		assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['dsh-websearch-tavily-keys-select'], rel)
		assert.equal(Object.keys(pkg.dependencies ?? {}).some((name) => name.startsWith('@deepseek-ai/')), false, rel)
	}
})

await test('host 半边不出现任何 @deepseek-ai 静态 import（只有官方兜底那次懒动态 import）', () => {
	const code = read('bundle/host/index-v5.mjs')
	assert.equal(/^import .*@deepseek-ai/m.test(code), false, '静态 import 不许引 @deepseek-ai')
	assert.ok(code.includes("await import('@deepseek-ai/dsh-web-search-deepseek')"))
})

summary('manifest')
