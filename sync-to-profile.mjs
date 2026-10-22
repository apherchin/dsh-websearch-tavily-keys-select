/**
 * 把本目录（正本）同步进 desktop profile 的 node_modules（生成物）。
 *
 * 用法：
 *   node sync-to-profile.mjs              # 等同 --dry-run（live 布局）
 *   node sync-to-profile.mjs --check      # 只报告是否一致（不一致退出码 1）
 *   node sync-to-profile.mjs --apply      # 写入并回读校验 sha256（需要提权：profile 在围栏外）
 *   node sync-to-profile.mjs --npm-check  # 只看「按 npm 包名布局」的差异（发布用，不落盘）
 *   node sync-to-profile.mjs --npm-apply  # 按 npm 包名布局写入（少用；发布前自检用）
 *
 * ⚠️ profile 不在工作区文件围栏内 ⇒ `--apply` 需要提权；`--dry-run/--check` 只读，随时可跑。
 * ⚠️ 这是**唯一**允许写 profile 的通道：手改 profile 会让「正本/生成物」对不上，
 *    而 `--check` 就是用来抓这件事的（收工自检）。
 *
 * ## 为什么有两套布局（2026-10-22 加）
 *
 * 正本的包名是发布用名 `dsh-websearch-tavily-keys-select`，而**本机 profile 里部署的是它的旧名**
 * `dsh-web-search-chain`（profile 的 `package.json`、`dsh.profile.bundles`、bundle 自己的 patch
 * 全指向旧名；只改一边会让包解析不到 ⇒ 整机起不来）。两套布局的差别只有三处：
 *   1. bundle 包目录名不同；
 *   2. 宿主实现放在 `host/` 子目录（正本）vs 包根（本机部署形态，`main: index-v5.mjs`）；
 *   3. `client.js` 里的 `ENTRY_KEY`（必须逐字等于 bundle 包名）。
 * 所以 live 布局在写 `client.js` 时做一次**受控改名**，并把 `host/*.mjs` 摊平到包根。
 * live 布局**不写** `package.json`：两个形态的包名/依赖本来就不同，写过去会破坏 profile。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PROFILE_NODE_MODULES = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules')

/** 正本里的发布用包名（bundle）。 */
const PUBLISHED_BUNDLE = 'dsh-websearch-tavily-keys-select'
/** 本机 profile 里实际部署的 bundle 目录名（旧名，不能改：profile 的清单指向它）。 */
const LIVE_BUNDLE = 'dsh-web-search-chain'

/**
 * 造同步条目：`{rel, source, target, transform?}`。
 *
 * @param layout - `"live"` 或 `"npm"`。
 */
function entries(layout) {
	const found = []
	const bundleRoot = join(here, 'bundle')

	if (layout === 'live') {
		const bundleTarget = join(PROFILE_NODE_MODULES, LIVE_BUNDLE)
		// 宿主实现：host/*.mjs → 包根（本机部署形态的 main 就是包根的 index-v5.mjs）
		for (const name of readdirSync(join(bundleRoot, 'host')).sort()) {
			if (!name.endsWith('.mjs')) continue
			found.push({
				rel: `${LIVE_BUNDLE}/${name}`,
				source: join(bundleRoot, 'host', name),
				target: join(bundleTarget, name),
			})
		}
		found.push({
			rel: `${LIVE_BUNDLE}/cordis.patch.yml`,
			source: join(bundleRoot, 'cordis.patch.yml'),
			target: join(bundleTarget, 'cordis.patch.yml'),
		})
		found.push({
			rel: 'dsh-search-chain/client.js',
			source: join(here, 'row-chain', 'client.js'),
			target: join(PROFILE_NODE_MODULES, 'dsh-search-chain', 'client.js'),
			// 受控改名：只替换 bundle 包名，并把替换次数回报出来（改了名字却漏改这里是真事故）
			transform: (text) => {
				const occurrences = text.split(PUBLISHED_BUNDLE).length - 1
				if (occurrences < 1) throw new Error(`client.js 里没找到包名 ${PUBLISHED_BUNDLE}：ENTRY_KEY 可能被写死成别的名字`)
				return text.split(PUBLISHED_BUNDLE).join(LIVE_BUNDLE)
			},
		})
		return found
	}

	// npm 布局：三个包各按目录整份复制
	const mapping = [
		{ from: 'bundle', to: PUBLISHED_BUNDLE },
		{ from: 'row-chain', to: 'dsh-search-chain' },
		{ from: 'row-deepseek', to: 'dsh-search-deepseek' },
	]
	for (const { from, to } of mapping) {
		const sourceRoot = join(here, from)
		if (!existsSync(sourceRoot)) continue
		for (const rel of listFiles(sourceRoot)) {
			found.push({ rel: `${to}/${rel}`, source: join(sourceRoot, rel), target: join(PROFILE_NODE_MODULES, to, rel) })
		}
	}
	return found
}

/** 递归列出目录下的相对文件路径（稳定排序）。 */
function listFiles(root) {
	const found = []
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const full = join(dir, entry.name)
			if (entry.isDirectory()) walk(full)
			else if (entry.isFile()) found.push(relative(root, full))
		}
	}
	walk(root)
	return found
}

/** 读文件内容（可选变换）。 */
function contentOf(path, transform) {
	const bytes = readFileSync(path)
	return transform === undefined ? bytes : Buffer.from(transform(bytes.toString('utf8')), 'utf8')
}

/** 内容的 sha256；文件不存在返回 undefined。 */
function hashOf(path, transform) {
	if (!existsSync(path)) return undefined
	return createHash('sha256').update(contentOf(path, transform)).digest('hex')
}

const argv = process.argv.slice(2)
const layout = argv.includes('--npm-check') || argv.includes('--npm-apply') ? 'npm' : 'live'
const mode = argv.includes('--apply') || argv.includes('--npm-apply') ? 'apply' : argv.includes('--check') || argv.includes('--npm-check') ? 'check' : 'dry-run'
const entriesToSync = entries(layout)

console.log(`布局：${layout}${layout === 'live' ? `（bundle 目录 = ${LIVE_BUNDLE}，client.js 里包名改写为同名）` : `（bundle 目录 = ${PUBLISHED_BUNDLE}）`}`)
let drifted = 0
let written = 0

for (const entry of entriesToSync) {
	const sourceHash = hashOf(entry.source, entry.transform)
	const targetHash = hashOf(entry.target)
	if (sourceHash === targetHash) continue
	drifted += 1
	const state = targetHash === undefined ? '缺失' : '不同'
	console.log(`  ${state}  ${entry.rel}`)
	if (mode === 'apply') {
		mkdirSync(dirname(entry.target), { recursive: true })
		if (entry.transform === undefined) copyFileSync(entry.source, entry.target)
		else writeFileSync(entry.target, contentOf(entry.source, entry.transform))
		const after = hashOf(entry.target)
		if (after !== sourceHash) {
			console.error(`  ✗ 回读校验失败：${entry.rel}`)
			process.exitCode = 1
			continue
		}
		written += 1
	}
}

if (mode === 'check') {
	console.log(drifted === 0 ? `一致：${entriesToSync.length}/${entriesToSync.length}` : `不一致：${drifted} 个文件与正本不同（跑 --apply 同步）`)
	if (drifted > 0) process.exitCode = 1
} else if (mode === 'apply') {
	console.log(`已写入 ${written} 个文件（共检查 ${entriesToSync.length} 个）`)
} else {
	console.log(drifted === 0 ? `一致：${entriesToSync.length}/${entriesToSync.length}` : `待写入 ${drifted} 个文件（--dry-run，未落盘）`)
}
