/**
 * 客户端半点的**离线验证台**：把 `client.js` 放进假浏览器上下文里跑。
 *
 * 它验的是「静态可证」之外的那部分：注册形状、合规红线、`__internals` 纯逻辑、
 * 以及卡片在几种状态下的渲染树。范式抄自
 * `work\session-delete-20260926\verify-client-task6.mjs`（本机唯一被验证过可行的一套）。
 *
 * 用法：node verify-client.mjs   （非 0 退出 = 有断言失败）
 */
import fs from 'node:fs'
import vm from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'row-chain', 'client.js')

let pass = 0
const failures = []
function check(label, ok, detail) {
	if (ok) {
		pass += 1
		console.log(`  ok   ${label}`)
	} else {
		failures.push(label)
		console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
	}
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
/**
 * 键序无关的深比较。
 * ⚠️ `eq` 走 `JSON.stringify`，**对对象键序敏感**：`{kind,mode,id,ref}` 与
 * `{kind,mode,ref,id}` 会被判不等（本验证台踩过一次）。断言对象结构时用这个。
 */
const sortDeep = (value) =>
	Array.isArray(value)
		? value.map(sortDeep)
		: value !== null && typeof value === 'object'
			? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]))
			: value
const eqShape = (a, b) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b))

// ── BOM 铁律（AGENTS.md §8）：client.js 绝不能带 BOM ────────────────
const bytes = fs.readFileSync(CLIENT)
check('client.js 无 BOM（首 3 字节 ≠ EF BB BF）', !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), [...bytes.slice(0, 3)].join(','))

const source = bytes.toString('utf8')
/** 去掉注释后的**代码**（注释里要能写清被禁的东西，所以静态检查只看代码）。 */
const code = source
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.split('\n')
	.map((line) => {
		const at = line.indexOf('//')
		return at === -1 ? line : line.slice(0, at)
	})
	.join('\n')

// ── 合规红线（官方 practices 明文禁止 require 任何 Harness Client 包）──
check('合规：代码里不出现 require 任何 @deepseek-ai/* 包', !/require\s*\(\s*["']@deepseek-ai\//.test(code))
check(
	'合规：require 只允许 react / react-dom / react/jsx-runtime（基座）',
	(() => {
		const specs = [...code.matchAll(/require\s*\(\s*["']([^"']+)["']/g)].map((match) => match[1])
		return specs.length > 0 && specs.every((spec) => spec === 'react' || spec === 'react-dom' || spec === 'react/jsx-runtime')
	})(),
	JSON.stringify([...code.matchAll(/require\s*\(\s*["']([^"']+)["']/g)].map((match) => match[1])),
)
check('合规：不 require 任何 Harness Client 包的 store（createSnapshotStore 自包含）', code.includes('function createSnapshotStore'))

// ── 假 jsx / 假 react / 假环境 ────────────────────────────────────
const Fragment = Symbol('Fragment')
const jsxShim = (type, props, key) => ({ type, props: props ?? {}, key })
const errors = []
/**
 * ⚠️ `fetch` 必须是 **sandbox 自己的属性**：vm 上下文里的全局变量只来自 sandbox 对象，
 * 不在里面声明 `fetch` 的话，client.js 里那句 `fetch(...)` 会直接 ReferenceError。
 * 所以这里放一个转发器，测试里替换 `fetchImpl` 即可打桩。
 */
let fetchImpl = async () => {
	throw new Error('verify-client: fetch 还没打桩')
}
const sandbox = {
	window: { __ModuleLoader__: { load: (def) => { sandbox.__def = def } } },
	navigator: { language: 'zh-CN' },
	fetch: (...args) => fetchImpl(...args),
	setTimeout,
	clearTimeout,
	console: { log: () => {}, warn: () => {}, error: (...args) => errors.push(args.map(String).join(' ')) },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })
const def = sandbox.__def
check('client.js 通过 window.__ModuleLoader__.load 注册', def !== undefined)
check('bundle id = 行包名 dsh-search-chain', def?.id === 'dsh-search-chain', def?.id)

const reactShim = { useEffect: () => {}, useState: (initial) => [initial, () => {}], useRef: (value) => ({ current: value ?? null }) }
function loadClient() {
	const req = (spec) => {
		if (spec === 'react') return reactShim
		if (spec === 'react/jsx-runtime') return { jsx: jsxShim, jsxs: jsxShim, Fragment }
		// 刻意不给桩、直接抛：谁把 Harness Client 包的 import 加回来，验证台当场炸。
		throw new Error(`违规的 require(${spec})：client 半边只许 require 基座`)
	}
	return def.factory(req)
}
const exports = loadClient()
const I = exports.__internals

// ── 模块元数据 ────────────────────────────────────────────────────
check('exports.name 存在', typeof exports.name === 'string' && exports.name.length > 0, exports.name)
check('exports.inject 不挂任何硬门禁（[ ]）', eq(exports.inject, []), JSON.stringify(exports.inject))
check('exports.apply 是函数', typeof exports.apply === 'function')
check('__internals 是对象（验证台直接断言纯逻辑）', typeof I === 'object' && I !== null)

// ── 假槽位服务 + apply ────────────────────────────────────────────
const registrations = []
let currentSlot = null
/**
 * 假槽位服务。`slots.inject(key, callback)` 的真实语义是「把 callback 交给 `ctx.effect`」
 * （`ui-renderer-client.js:1369`），所以**普通函数与生成器函数都成立**：普通形式用返回值当
 * disposer，生成器形式把每个 yield 当 disposer。这里两种都接。
 */
function makeSlots() {
	return {
		inject: (slot, callback) => {
			currentSlot = slot
			const produced = callback()
			const list = produced !== undefined && produced !== null && typeof produced.next === 'function' ? [...produced] : [produced]
			for (const value of list) {
				if (value === undefined || value === null) continue
				registrations.push({ slot, spec: value.spec, Comp: value.Comp })
			}
		},
		register: (spec, Comp) => ({ slot: currentSlot, spec, Comp }),
	}
}
function makeCtx(options = {}) {
	const slots = options.slots === undefined ? makeSlots() : options.slots
	return {
		inject: (deps, callback) => {
			if ((options.hold ?? []).some((name) => deps.includes(name))) return () => {}
			callback({ slots })
			return () => {}
		},
	}
}

exports.apply(makeCtx())
check('注册进 plugins.bundle.config', registrations.length === 1 && registrations[0].slot === 'plugins.bundle.config', JSON.stringify(registrations.map((r) => r.slot)))
const reg = registrations[0]
check('注册 name = plugins.bundle.config', reg?.spec?.name === 'plugins.bundle.config', reg?.spec?.name)
check('注册 key = dsh-web-search-chain（包名逐字，否则包页不渲染）', reg?.spec?.key === 'dsh-web-search-chain', reg?.spec?.key)
check('注册 Comp 是函数', typeof reg?.Comp === 'function')
check('注册用了 inject 面（hooks + 4 个动作）', (() => {
	const face = reg?.spec?.inject?.()
	return face?.hooks?.webSearchChain !== undefined && ['load', 'save', 'discard', 'edit'].every((name) => typeof face[name] === 'function')
})())

// ── slots 不可用 / slots 抛错：apply 绝不外抛 ──────────────────────
{
	errors.length = 0
	let threw = false
	try {
		exports.apply(makeCtx({ hold: ['slots'] }))
	} catch { threw = true }
	check('slots 服务不到达时 apply 不抛（只降级）', threw === false)

	threw = false
	try {
		exports.apply({ inject: (deps, callback) => { callback({ slots: { inject: () => { throw new Error('slot boom') } } }); return () => {} } })
	} catch { threw = true }
	check('槽位注册抛错时 apply 仍不抛（启动门禁是全有全无）', threw === false)
	check('该失败被记进 console.error（可排查）', errors.some((line) => line.includes('配置卡片注册失败')), JSON.stringify(errors))
}

// ── 纯逻辑：草稿 ──────────────────────────────────────────────────
const SERVER_STATE = {
	ok: true,
	version: 1,
	maxSources: 3,
	templates: [{ kind: 'tavily', label: 'Tavily Key', refExample: 'TAVILY_API_KEY' }],
	sources: [
		{ id: 's1', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY2', credential: { configured: true, source: 'environment', writable: false } },
		{ id: 's2', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1', credential: { configured: true, source: 'store', writable: true } },
	],
	fallback: { kind: 'deepseek', enabled: true },
	configError: null,
}
const draft = I.draftFromState(SERVER_STATE)
check('draftFromState：逐字带出 4 个字段 + 空 secret + serverMode', eq(
	draft.sources.map((s) => [s.id, s.kind, s.mode, s.ref, s.secret, s.serverMode]),
	[['s1', 'tavily', 'env', 'TAVILY_API_KEY2', '', 'env'], ['s2', 'tavily', 'literal', 'WEB_SEARCH_TAVILY_1', '', 'literal']],
))
check('draftFromState：state 为 null 也不抛', eq(I.draftFromState(null).sources, []))

check('setMode：checkbox 互斥（模式是单值，不可能两个都勾）', (() => {
	const a = I.setMode(draft, 0, 'literal')
	const b = I.setMode(a, 0, 'env')
	return a.sources[0].mode === 'literal' && b.sources[0].mode === 'env' && !('modeLiteral' in b.sources[0])
})())
check('setMode/setRef/setSecret 不原地改（返回新草稿）', (() => {
	const next = I.setRef(draft, 0, 'OTHER')
	return draft.sources[0].ref === 'TAVILY_API_KEY2' && next.sources[0].ref === 'OTHER' && next !== draft
})())
check('addSource：默认 env + 空变量名 + 模板取表内第一项', (() => {
	const next = I.addSource(draft, SERVER_STATE.templates)
	const added = next.sources.at(-1)
	return next.sources.length === 3 && added.mode === 'env' && added.ref === '' && added.kind === 'tavily'
})())
check('addSource：到上限就不再追加（按钮与逻辑两层都挡）', (() => {
	const full = { sources: [0, 1, 2].map((n) => ({ id: `s${n}`, kind: 'tavily', mode: 'env', ref: `K${n}`, secret: '' })) }
	assertSame(I.addSource(full, SERVER_STATE.templates), full)
	return true
})())
check('removeSource：按下标删且保持其它源顺序', (() => {
	const next = I.removeSource(draft, 0)
	return next.sources.length === 1 && next.sources[0].id === 's2'
})())
check('toRequest：env 源带 trim 后的 ref；不带空 secret；缺 id 就不带 id', (() => {
	const next = I.toRequest({
		sources: [
			{ id: 's1', kind: 'tavily', mode: 'env', ref: '  K1  ', secret: '' },
			{ kind: 'tavily', mode: 'literal', ref: '', secret: '' },
			{ id: 's3', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1', secret: 'tvly-x' },
		],
	})
	return eqShape(next, {
		sources: [
			{ kind: 'tavily', mode: 'env', ref: 'K1', id: 's1' },
			{ kind: 'tavily', mode: 'literal' },
			{ kind: 'tavily', mode: 'literal', id: 's3', secret: 'tvly-x' },
		],
	})
})())
check('firstProblem：空变量名 ⇒ 提示；填好 ⇒ null', (() => {
	const bad = { sources: [{ kind: 'tavily', mode: 'env', ref: '  ' }] }
	const good = { sources: [{ kind: 'tavily', mode: 'env', ref: 'K1' }, { kind: 'tavily', mode: 'literal' }] }
	return I.firstProblem(bad) !== null && I.firstProblem(good) === null
})())
check('firstProblem：两个源同一个变量名 ⇒ 提示', (() => {
	const dup = { sources: [{ kind: 'tavily', mode: 'env', ref: 'K1' }, { kind: 'tavily', mode: 'env', ref: 'K1' }] }
	return I.firstProblem(dup) !== null
})())
check('firstProblem：非法的变量名 ⇒ 提示', (() => {
	const bad = { sources: [{ kind: 'tavily', mode: 'env', ref: '1BAD' }] }
	return I.firstProblem(bad) !== null
})())
check('secretDisabled：只有「服务端已是 literal 且只读」才置灰', (() => {
	const envish = { mode: 'literal', serverMode: 'env', credential: { writable: false } }
	const shadowed = { mode: 'literal', serverMode: 'literal', credential: { writable: false } }
	const normal = { mode: 'literal', serverMode: 'literal', credential: { writable: true } }
	return I.secretDisabled(envish) === false && I.secretDisabled(shadowed) === true && I.secretDisabled(normal) === false
})())
check('recycledRefs：常态（仍是 literal）不误报；切走与删除都报', (() => {
	const steady = I.recycledRefs(SERVER_STATE, I.draftFromState(SERVER_STATE))
	const switched = I.recycledRefs(SERVER_STATE, I.setMode(I.draftFromState(SERVER_STATE), 1, 'env'))
	const deleted = I.recycledRefs(SERVER_STATE, I.removeSource(I.draftFromState(SERVER_STATE), 1))
	return eq(steady, []) && eq(switched, ['WEB_SEARCH_TAVILY_1']) && eq(deleted, ['WEB_SEARCH_TAVILY_1'])
})())
check('summaryText：state 为 null 也不抛；有 state 时带源数量与兜底状态', (() => {
	const whenLoading = I.summaryText({ state: null })
	const whenReady = I.summaryText({ state: SERVER_STATE })
	return typeof whenLoading === 'string' && whenReady.includes('2') && whenReady.includes('已启用')
})())

function assertSame(actual, expected) {
	if (!eq(actual, expected)) throw new Error(`不等：${JSON.stringify(actual)}`)
}

// ── 卡片渲染（展开全部自包含原子，断言真实 DOM 形状）──────────────
function expandAll(node) {
	if (node === null || node === undefined || typeof node !== 'object') return node
	if (Array.isArray(node)) return node.map(expandAll)
	if (typeof node.type === 'function') return expandAll(node.type(node.props ?? {}))
	return { ...node, props: { ...node.props, children: expandAll(node.props?.children) } }
}
function findAll(node, predicate, found = []) {
	if (node === null || node === undefined || typeof node !== 'object') return found
	if (Array.isArray(node)) {
		for (const child of node) findAll(child, predicate, found)
		return found
	}
	if (predicate(node)) found.push(node)
	findAll(node.props?.children, predicate, found)
	return found
}
const face = reg.spec.inject()
const propsFor = (view) => ({
	view,
	load: face.load,
	save: face.save,
	discard: face.discard,
	edit: face.edit,
	useWebSearchChain: (selector) => selector(face.hooks.webSearchChain.getSnapshot()),
})

check('view=summary 返回字符串（不抛）', typeof reg.Comp(propsFor('summary')) === 'string')

face.hooks.webSearchChain.set({ status: 'ready', error: null, state: SERVER_STATE, draft: I.draftFromState(SERVER_STATE), saving: false, notice: null })
{
	const tree = expandAll(reg.Comp(propsFor('page')))
	const checkboxes = findAll(tree, (el) => el.type === 'input' && el.props?.type === 'checkbox')
	const checked = checkboxes.filter((el) => el.props.checked === true)
	const passwords = findAll(tree, (el) => el.type === 'input' && el.props?.type === 'password')
	const inputs = findAll(tree, (el) => el.type === 'input')
	check('渲染：每个源一对 checkbox（2 源 = 4 个）', checkboxes.length === 4, String(checkboxes.length))
	check('渲染：每个源恰好勾中一个（互斥）', checked.length === 2, String(checked.length))
	check('渲染：literal 源有密码输入框（1 个）', passwords.length === 1, String(passwords.length))
	check('渲染：env 源的变量名输入框显示 ref', inputs.some((el) => el.props.value === 'TAVILY_API_KEY2'))
	check('渲染：兜底行显示「已启用」', JSON.stringify(tree).includes('已启用'))
	check('渲染：明文已配置时用「留空即保持不变」占位', inputs.some((el) => String(el.props.placeholder).includes('留空即保持不变')))
	check('渲染：环境变量源的只读徽标出现', JSON.stringify(tree).includes('只读'))
}
{
	// 到上限：添加按钮必须置灰
	const full = { sources: [0, 1, 2].map((n) => ({ id: `s${n}`, kind: 'tavily', mode: 'env', ref: `K${n}`, credential: { configured: false, writable: true }, secret: '', serverMode: 'env' })) }
	face.hooks.webSearchChain.set({ status: 'ready', error: null, state: SERVER_STATE, draft: full, saving: false, notice: null })
	const tree = expandAll(reg.Comp(propsFor('page')))
	const buttons = findAll(tree, (el) => el.type === 'button')
	check('渲染：到上限时「添加」按钮置灰', buttons.some((el) => el.props.disabled === true && String(el.props.children).includes('上限')))
}
{
	// 有问题：保存键必须置灰
	const bad = { sources: [{ id: 's1', kind: 'tavily', mode: 'env', ref: '', credential: {}, secret: '', serverMode: 'env' }] }
	face.hooks.webSearchChain.set({ status: 'ready', error: null, state: SERVER_STATE, draft: bad, saving: false, notice: null })
	const tree = expandAll(reg.Comp(propsFor('page')))
	const buttons = findAll(tree, (el) => el.type === 'button')
	check('渲染：客户端预校验不过 ⇒ 保存键置灰', buttons.some((el) => el.props.disabled === true && String(el.props.children) === '保存'))
}
{
	// configError 与加载失败都要有可见文案
	face.hooks.webSearchChain.set({ status: 'ready', error: null, state: { ...SERVER_STATE, configError: '配置文件损坏（测试）' }, draft: I.draftFromState(SERVER_STATE), saving: false, notice: null })
	check('渲染：configError 显示黄条文案', JSON.stringify(expandAll(reg.Comp(propsFor('page')))).includes('配置文件损坏'))
	face.hooks.webSearchChain.set({ status: 'failed', error: 'HTTP 401', state: null, draft: null, saving: false, notice: null })
	check('渲染：加载失败显示错误文案且不抛', JSON.stringify(expandAll(reg.Comp(propsFor('page')))).includes('HTTP 401'))
}
{
	// 把已存的 literal 源切成环境变量 ⇒ 必须警告「保存后会连带删密钥」
	const switched = I.setMode(I.draftFromState(SERVER_STATE), 1, 'env')
	face.hooks.webSearchChain.set({ status: 'ready', error: null, state: SERVER_STATE, draft: switched, saving: false, notice: null })
	const text = JSON.stringify(expandAll(reg.Comp(propsFor('page'))))
	check('渲染：切走已存 literal 源时给出「同时移除已存储的密钥」警告', text.includes('同时移除已存储的密钥') && text.includes('WEB_SEARCH_TAVILY_1'))
	// 常态不该误报
	face.hooks.webSearchChain.set({ status: 'ready', error: null, state: SERVER_STATE, draft: I.draftFromState(SERVER_STATE), saving: false, notice: null })
	check('渲染：常态（仍是 literal）不出现该警告', !JSON.stringify(expandAll(reg.Comp(propsFor('page')))).includes('同时移除已存储的密钥'))
}

// ── 动作接线：edit 改草稿、save 发 POST、load 发 GET ───────────────
face.hooks.webSearchChain.set({ status: 'ready', error: null, state: SERVER_STATE, draft: I.draftFromState(SERVER_STATE), saving: false, notice: null })
face.edit({ kind: 'mode', index: 0, value: 'literal' })
check('edit(mode)：草稿真的变了（不是只画了个控件）', face.hooks.webSearchChain.getSnapshot().draft.sources[0].mode === 'literal')
face.edit({ kind: 'add' })
check('edit(add)：草稿多了一个源', face.hooks.webSearchChain.getSnapshot().draft.sources.length === 3)
face.edit({ kind: 'remove', index: 2 })
check('edit(remove)：草稿少了一个源', face.hooks.webSearchChain.getSnapshot().draft.sources.length === 2)

const calls = []
fetchImpl = async (url, init) => {
	calls.push({ url, init })
	return { status: 200, json: async () => SERVER_STATE }
}
await face.load()
await new Promise((resolve) => setTimeout(resolve, 0))
check('load()：GET 到 /api/web-search-chain.config', calls.some((call) => call.url === '/api/web-search-chain.config' && call.init.method === 'GET'), JSON.stringify(calls.map((c) => [c.url, c.init?.method])))
await face.save()
await new Promise((resolve) => setTimeout(resolve, 0))
{
	const post = calls.filter((call) => call.init?.method === 'POST').at(-1)
	check('save()：POST 到同一路径且带 JSON 头', post !== undefined && post.init.headers['content-type'] === 'application/json')
	check('save()：请求体只带真正要提交的字段（空 secret 不带）', (() => {
		const body = JSON.parse(post.init.body)
		return body.sources.length === 2 && body.sources.every((row) => !('secret' in row))
	})(), post.init.body)
	check('save() 成功后状态回到 ready 并给出「已保存」提示', (() => {
		const snapshot = face.hooks.webSearchChain.getSnapshot()
		return snapshot.status === 'ready' && snapshot.saving === false && snapshot.notice?.tone === 'ok'
	})())
}

// ── 收尾 ──────────────────────────────────────────────────────────
console.log(`\nverify-client: ${pass}/${pass + failures.length} 通过`)
if (failures.length > 0) {
	console.log(`失败：${failures.join(' | ')}`)
	process.exitCode = 1
}
