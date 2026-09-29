/**
 * 极简离线测试台。
 *
 * ⚠️ 本机**不能用 `node --test`**：沙箱禁命名管道 ⇒ runner spawn EPERM，还会打印误导性的
 * `# fail 1`。所以所有测试都用「逐文件 node <file>」，异步用例一律 `await test(...)`。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export { assert }

let passed = 0
const failures = []

/** 跑一个用例；抛错即失败，但**不中断**后续用例。 */
export async function test(name, fn) {
	try {
		await fn()
		passed += 1
		console.log(`  ok   ${name}`)
	} catch (error) {
		failures.push(name)
		console.log(`  FAIL ${name}\n       ${error?.stack ?? String(error)}`)
	}
}

/**
 * 打印汇总并把退出码置为非 0（有失败时）。
 *
 * ⚠️ 打印后**清零计数器**：`run-all.mjs` 在同一个进程里顺序 import 每个测试文件，
 * 不清零的话第二份文件的汇总会打成本进程的累计值（实测出现过 `core-validate: 45/45`
 * 这种误导性数字）。每个文件只该报自己的数。
 */
export function summary(label) {
	const total = passed + failures.length
	console.log(`\n${label}: ${passed}/${total} 通过`)
	if (failures.length > 0) {
		console.log(`失败：${failures.join(' | ')}`)
		process.exitCode = 1
	}
	const result = { passed, failures: [...failures] }
	passed = 0
	failures.length = 0
	return result
}

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 建一个测试临时目录。刻意**放在插件目录下**（`.tmp\`，已 gitignore）：
 * 工作区文件围栏保证可写，不依赖系统临时目录是否被沙箱放行。
 */
export function tempDir(tag) {
	const root = join(pluginRoot, '.tmp')
	mkdirSync(root, { recursive: true })
	return mkdtempSync(join(root, `${tag}-`))
}

/** 删掉临时目录（用例收尾必须调，别让 .tmp 长胖）。 */
export function cleanup(dir) {
	rmSync(dir, { recursive: true, force: true })
}

/**
 * 假 Host ctx：只实现被测代码真正用到的表面。
 *
 * ⚠️ 2026-09-29 加的两件事，专门用来复现**服务就绪时序**类 bug（离线假 ctx 的盲区）：
 * - `options.deferred: string[]` —— 这些名字**此刻还不算就绪**（`get` 返回 undefined，
 *   且 `inject` 不回调），随后用 `ctx.__deliver(name)` 模拟"服务稍后就绪"；
 * - `inject(deps, cb)` —— 与 cordis 同义：依赖**全就绪**时**同步**回调，否则**挂起**等
 *   `__deliver`。回调收到的 scope 带 `.effect()`、`.get()` 与**服务属性**（`scope.connection`），
 *   与官方 `ctx.inject(["webServer"], webCtx => webCtx.webServer…)` 的用法一致。
 *
 * 为什么需要它：真机实测过一次「apply 跑在 connection 就绪之前 ⇒ 路由没注册 ⇒ 页面 404」，
 * 而旧版假 ctx 永远"服务就绪"，这类 bug **一条断言都抓不到**。
 *
 * @param options.credentials - 假凭据服务；`undefined` = 服务不可用
 * @param options.connection - 假 connection 服务；`undefined` = 服务不可用
 * @param options.deferred - 此刻视为"尚未就绪"的服务名
 */
export function makeFakeCtx(options = {}) {
	const effects = []
	const deferred = new Set(options.deferred ?? [])
	const pending = []
	const services = {}
	if (options.connection !== undefined) services.connection = options.connection
	if (options.credentials !== undefined) services.credentials = options.credentials
	const available = (name) => services[name] !== undefined && !deferred.has(name)
	/** 造一个「依赖已就绪」的 scope：与 cordis 的嵌套注入 scope 同形。 */
	const makeScope = () => {
		const scope = {
			get: (name) => (available(name) ? services[name] : undefined),
			effect: (callback, label) => {
				effects.push({ label, dispose: callback() })
			},
		}
		for (const [name, value] of Object.entries(services)) if (available(name)) scope[name] = value
		return scope
	}
	const ctx = {
		logger: { info: () => {}, warn: () => {} },
		get: (name) => (available(name) ? services[name] : undefined),
		inject: (deps, callback) => {
			if ((deps ?? []).every((name) => available(name))) {
				callback(makeScope())
				return () => {}
			}
			pending.push({ deps, callback })
			return () => {}
		},
		effect: (callback, label) => {
			effects.push({ label, dispose: callback() })
		},
		web: { registerSearchProvider: (provider) => { ctx.__provider = provider } },
		__effects: effects,
		/** 模拟「`name` 服务稍后就绪」：投递所有已满足的等待者。 */
		__deliver(name) {
			deferred.delete(name)
			for (const entry of [...pending]) {
				if (!entry.deps.every((dep) => available(dep))) continue
				pending.splice(pending.indexOf(entry), 1)
				entry.callback(makeScope())
			}
		},
	}
	return ctx
}

/** 假凭据服务：记录 set/unset/describe，可按 `shadowed` 模拟「被环境变量遮住（只读）」。 */
export function makeFakeCredentials(seed = {}) {
	const values = new Map(Object.entries(seed.values ?? {}))
	const shadowed = new Set(seed.shadowed ?? [])
	const calls = { set: [], unset: [], describe: [], resolve: [] }
	return {
		calls,
		values,
		async resolve(ref) {
			calls.resolve.push(ref)
			return values.has(ref) ? { value: values.get(ref), source: 'store' } : undefined
		},
		async describe(ref) {
			calls.describe.push(ref)
			if (shadowed.has(ref)) return { configured: true, source: 'environment', writable: false }
			return { configured: values.has(ref), source: values.has(ref) ? 'store' : undefined, writable: true }
		},
		async set(ref, value) {
			calls.set.push([ref, value])
			values.set(ref, value)
		},
		async unset(ref) {
			calls.unset.push(ref)
			values.delete(ref)
		},
	}
}

/** 假 connection 服务：记录路由，返回一个清理函数。 */
export function makeFakeConnection() {
	const routes = []
	return { routes, fetch: { register: (route) => { routes.push(route); return () => {} } } }
}

/** 响应 → `{status, body}`（路由用例到处都用）。 */
export async function readResponse(response) {
	return { status: response.status, body: await response.json() }
}
