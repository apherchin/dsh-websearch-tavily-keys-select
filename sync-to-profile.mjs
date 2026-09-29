/**
 * 把本目录（正本）同步进 desktop profile 的 node_modules（生成物）。
 *
 * 用法：
 *   node sync-to-profile.mjs            # 等同 --dry-run
 *   node sync-to-profile.mjs --dry-run  # 只列差异，不落盘
 *   node sync-to-profile.mjs --apply    # 写入并回读校验 sha256
 *   node sync-to-profile.mjs --check    # 只报告是否一致（不一致退出码 1）
 *
 * ⚠️ profile 不在工作区文件围栏内 ⇒ --apply 需要提权；--dry-run/--check 只读，随时可跑。
 * ⚠️ 这是**唯一**允许写 profile 的通道：手改 profile 会让「正本/生成物」对不上，
 *    而 --check 就是用来抓这件事的（收工自检）。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PROFILE_NODE_MODULES = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'node_modules')

/** 正本子目录 → profile 里的包目录。 */
const MAPPING = [
	// bundle 包已**自包含**（host/ 在包内）：npm 包不能引用 `../host`，所以正本也按包的实际形态组织。
	{ from: 'bundle', to: 'dsh-websearch-tavily-keys-select' },
	{ from: 'row-chain', to: 'dsh-search-chain' },
	{ from: 'row-deepseek', to: 'dsh-search-deepseek' },
]

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

/** 全部同步对（相对路径 → 源文件 / 目标文件）。 */
function pairs() {
	const all = []
	for (const { from, to } of MAPPING) {
		const sourceRoot = join(here, from)
		if (!existsSync(sourceRoot)) continue
		for (const rel of listFiles(sourceRoot)) {
			all.push({ rel: `${to}/${rel}`, source: join(sourceRoot, rel), target: join(PROFILE_NODE_MODULES, to, rel) })
		}
	}
	return all
}

/** 文件的 sha256；不存在返回 undefined。 */
function hashOf(path) {
	if (!existsSync(path)) return undefined
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--check') ? 'check' : 'dry-run'
const entries = pairs()
let drifted = 0
let written = 0

for (const entry of entries) {
	const sourceHash = hashOf(entry.source)
	const targetHash = hashOf(entry.target)
	if (sourceHash === targetHash) continue
	drifted += 1
	const state = targetHash === undefined ? '缺失' : '不同'
	console.log(`  ${state}  ${entry.rel}`)
	if (mode === 'apply') {
		mkdirSync(dirname(entry.target), { recursive: true })
		copyFileSync(entry.source, entry.target)
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
	console.log(drifted === 0 ? `一致：${entries.length}/${entries.length}` : `不一致：${drifted} 个文件与正本不同（跑 --apply 同步）`)
	if (drifted > 0) process.exitCode = 1
} else if (mode === 'apply') {
	console.log(`已写入 ${written} 个文件（共检查 ${entries.length} 个）`)
} else {
	console.log(drifted === 0 ? `一致：${entries.length}/${entries.length}` : `待写入 ${drifted} 个文件（--dry-run，未落盘）`)
}
