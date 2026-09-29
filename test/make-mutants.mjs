/**
 * 变异测试：往正本里注入 4 个**语义错误**，每个都必须让对应用例变红。
 *
 * 手法：把整棵树复制到 `.tmp` 下的一个临时目录，在副本上做字符串替换，再 `node <副本的测试文件>`。
 * ⚠️ 用 `spawnSync(..., { stdio: 'ignore' })`：本机沙箱禁命名管道 ⇒ 捕获子进程输出会 EPERM，
 *    而我们只需要退出码。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
/**
 * ⚠️ 变异副本**不能**放在插件目录里：`cpSync` 会拒绝「把目录拷进它自己的子目录」
 * （`ERR_FS_CP_EINVAL`，路径校验先于 filter）。所以放系统临时目录
 * （本机沙箱已把它重定向到进程专属目录，实测可写）。
 */
const tmpRoot = join(tmpdir(), 'dsh-web-search-chain-mutants')
mkdirSync(tmpRoot, { recursive: true })

/** 每个变异：改哪个文件、替换哪段、跑哪个测试文件。 */
const MUTANTS = [
	{
		name: 'M1 源顺序倒过来（腿序不再按文档顺序）',
		file: 'bundle/host/core.mjs',
		find: 'const legs = sources.map((source) => ({ kind: source.kind, id: source.id, ref: source.ref }))',
		replace: 'const legs = sources.slice().reverse().map((source) => ({ kind: source.kind, id: source.id, ref: source.ref }))',
		test: 'test/core-chain.test.mjs',
	},
	{
		name: 'M2 忽略 mode（一律按 env 解析，明文源失效）',
		file: 'bundle/host/core.mjs',
		find: "if (raw.mode === 'env') {",
		replace: 'if (true) {',
		test: 'test/core-validate.test.mjs',
	},
	{
		name: 'M3 上限 3 改成 4',
		file: 'bundle/host/core.mjs',
		find: 'export const MAX_SOURCES = 3',
		replace: 'export const MAX_SOURCES = 4',
		test: 'test/core-validate.test.mjs',
	},
	{
		name: 'M4 删掉「只读凭据不 unset」的守卫（会跟环境变量较劲）',
		file: 'bundle/host/index-v5.mjs',
		find: 'if (info?.writable === false) continue',
		replace: 'if (false) continue',
		test: 'test/route.test.mjs',
	},
	{
		// 这一条正是 2026-09-29 真机 404 的根因形状：不再"等 connection 服务就绪"，
		// 而是在 apply 时直接去看它。空依赖 ⇒ 回调立刻跑，此时服务还没提供。
		name: 'M5 把「等 connection 就绪」的嵌套注入换成不等（真机 404 的形状）',
		file: 'bundle/host/index-v5.mjs',
		find: "ctx.inject(['connection'], (connectionCtx) => {",
		replace: 'ctx.inject([], (connectionCtx) => {',
		test: 'test/route.test.mjs',
	},
]

/** 复制正本（跳过 .tmp），返回副本根目录。 */
function copyTree(tag) {
	const target = join(tmpRoot, tag)
	rmSync(target, { recursive: true, force: true })
	cpSync(pluginRoot, target, {
		recursive: true,
		filter: (source) => !source.includes(`${join(pluginRoot, '.tmp')}`),
	})
	return target
}

/** 改一处；必须恰好命中一次，否则这个变异本身是坏的。 */
function mutate(root, mutant) {
	const path = join(root, mutant.file)
	const before = readFileSync(path, 'utf8')
	const occurrences = before.split(mutant.find).length - 1
	if (occurrences !== 1) throw new Error(`${mutant.name}: 命中 ${occurrences} 次（必须恰好 1 次），变异脚本要跟着代码改`)
	writeFileSync(path, before.replace(mutant.find, mutant.replace), 'utf8')
}

/** 基线：未变异的代码必须全绿（否则后面的「变红」没有意义）。 */
{
	const baseline = copyTree('mutant-baseline')
	const result = spawnSync(process.execPath, [join(baseline, 'test', 'run-all.mjs')], { stdio: 'ignore' })
	console.log(`基线（未变异）run-all.mjs：退出码 ${result.status} ${result.status === 0 ? '✓ 全绿' : '✗ 本来就有失败，先修测试'}`)
	if (result.status !== 0) process.exitCode = 1
	rmSync(baseline, { recursive: true, force: true })
}

let killed = 0
let survived = 0
for (const [index, mutant] of MUTANTS.entries()) {
	const root = copyTree(`mutant-${index + 1}`)
	mutate(root, mutant)
	const result = spawnSync(process.execPath, [join(root, mutant.test)], { stdio: 'ignore' })
	const isKilled = result.status !== 0
	if (isKilled) killed += 1
	else survived += 1
	console.log(`${isKilled ? '✓ 被杀' : '✗ 存活'}  ${mutant.name}  →  ${mutant.test} 退出码 ${result.status}`)
	rmSync(root, { recursive: true, force: true })
}

console.log(`\nmake-mutants: ${killed}/${MUTANTS.length} 个变异被杀`)
rmSync(tmpRoot, { recursive: true, force: true })
if (survived > 0) {
	console.log('⚠️ 有变异存活 = 对应行为没有被任何断言守住，必须补断言')
	process.exitCode = 1
}
