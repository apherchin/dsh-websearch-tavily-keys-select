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
		find: 'const legs = []\n\tfor (const source of sources) {',
		replace: 'const legs = []\n\tfor (const source of sources.slice().reverse()) {',
		test: 'test/core-chain.test.mjs',
	},
	{
		name: 'M2 忽略 mode（一律按 env 解析，明文源失效）',
		file: 'bundle/host/core.mjs',
		find: "if (rawKey.mode === 'env') {",
		replace: 'if (true) {',
		test: 'test/core-validate.test.mjs',
	},
	{
		name: 'M3 上限 4 改成 5',
		file: 'bundle/host/core.mjs',
		find: 'export const MAX_SOURCES = 4',
		replace: 'export const MAX_SOURCES = 5',
		test: 'test/core-document.test.mjs',
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
	{
		// 额度闸门是本插件唯一"能替用户省钱"的东西：闸门失效 ⇒ 超额按 20 元/千次计费。
		// 2026-10-22 起 Tavily 腿也有闸门（按 credit），所以这里锚在"按单位算 used"那一行，保证唯一。
		name: 'M6 拆掉额度闸门（超额照发，会真花钱）',
		file: 'bundle/host/index-v5.mjs',
		find: 'const status = budgetStatus(keyBudget(source, key), usedInUnit, this.now())',
		replace: 'const status = { exhausted: false, monthly: null, reserve: 0, used: 0, remaining: null, unlimited: true }',
		test: 'test/chain-provider.test.mjs',
	},
	{
		name: 'M7 把「保留余量」漏掉（可用额度 = 全额，撞线风险）',
		file: 'bundle/host/core.mjs',
		find: 'const usable = Math.max(0, monthly - reserve)',
		replace: 'const usable = monthly',
		test: 'test/core-budget.test.mjs',
	},
	{
		name: 'M8 不校验 SecretId（yuanbao 源能存成死源）',
		file: 'bundle/host/core.mjs',
		find: "if (!SECRET_ID_PATTERN.test(secretId)) {\n\t\t\t\t\treturn failure('INVALID_SECRET_ID'",
		replace: "if (false) {\n\t\t\t\t\treturn failure('INVALID_SECRET_ID'",
		test: 'test/core-validate.test.mjs',
	},
	{
		// 北京时间切月：写成 UTC 会把每月最后 8 小时的调用算进下个月 ⇒ 本地账本与腾讯云对不上。
		name: 'M9 月份键改成 UTC（东八区每月最后 8 小时错月）',
		file: 'bundle/host/core.mjs',
		find: 'return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10)',
		replace: 'return new Date(nowMs).toISOString().slice(0, 10)',
		test: 'test/core-budget.test.mjs',
	},
	{
		name: 'M10 签名里的 x-tc-action 不做小写（腾讯云会判签名不符）',
		file: 'bundle/host/tencent-sign.mjs',
		find: 'x-tc-action:${String(action).toLowerCase()}',
		replace: 'x-tc-action:${String(action)}',
		test: 'test/tencent-sign.test.mjs',
	},
	{
		name: 'M11 停用的源照样被搜索（selectableSources 不过滤 disabled / 自动停用）',
		file: 'bundle/host/core.mjs',
		find: 'export function selectableSources(sources, runtime) {',
		replace: 'export function selectableSources(sources, runtime) {\n\treturn sources.slice()',
		test: 'test/core-chain.test.mjs',
	},
	{
		name: 'M12 结果 URL 不剥 userinfo（伪装域名 / 像泄漏账号的地址会原样交给模型）',
		file: 'bundle/host/index-v5.mjs',
		find: 'const at = authority.lastIndexOf(\'@\')',
		replace: 'const at = -1',
		test: 'test/chain-provider.test.mjs',
	},
	{
		name: 'M13 query 里的 site: 不翻译成 Site 参数（等于又把站点约束丢掉）',
		file: 'bundle/host/index-v5.mjs',
		find: 'const site = settings.site ?? intent.site',
		replace: 'const site = settings.site',
		test: 'test/chain-provider.test.mjs',
	},
	{
		name: 'M14 query 里的时间词不翻译成 Freshness（时效约束丢失，会拿到旧闻）',
		file: 'bundle/host/index-v5.mjs',
		find: 'const freshness = settings.freshness ?? intent.freshness',
		replace: 'const freshness = settings.freshness',
		test: 'test/chain-provider.test.mjs',
	},
	{
		name: 'M15 未授权/签名错误不再给中文提示（模型只能看到云厂商原文）',
		file: 'bundle/host/index-v5.mjs',
		find: "if (/^(AuthFailure|UnauthorizedOperation)/u.test(code)",
		replace: 'if (false && /^(AuthFailure|UnauthorizedOperation)/u.test(code)',
		test: 'test/chain-provider.test.mjs',
	},
	{
		name: 'M16 Freshness 超界不夹到官方上限（发 d40 给上游必被拒）',
		file: 'bundle/host/index-v5.mjs',
		find: 'freshness = `d${Math.min(count, 30)}`',
		replace: 'freshness = `d${count}`',
		test: 'test/chain-provider.test.mjs',
	},
	{
		name: 'M17 源内只跑第一把 key（第二把永远轮不到，等于回到"一源一 key"）',
		file: 'bundle/host/core.mjs',
		find: 'for (const key of source.keys ?? []) {',
		replace: 'for (const key of (source.keys ?? []).slice(0, 1)) {',
		test: 'test/core-chain.test.mjs',
	},
	{
		name: 'M18 记账按源而不是按 key（多把 key 共用一本账，额度判断会错）',
		file: 'bundle/host/index-v5.mjs',
		find: 'const calls = this.bumpUsage(key.id, month)',
		replace: 'const calls = this.bumpUsage(source.id, month)',
		test: 'test/chain-provider.test.mjs',
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