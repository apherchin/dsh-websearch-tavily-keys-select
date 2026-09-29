import { test, summary, assert } from './harness.mjs'
import { orderedLegs, unusedRefs, describeAttempts, LITERAL_REF_PREFIX } from '../bundle/host/core.mjs'

console.log('-- core: 腿序 / 凭据回收 / 失败文案 --')

const fallback = { slot: 'deepseek', keyRef: 'DEEPSEEK_API_KEY' }

await test('腿序 = 文档顺序 + 末尾兜底（有兜底时）', () => {
	const sources = [
		{ id: 's1', kind: 'tavily', mode: 'env', ref: 'A' },
		{ id: 's2', kind: 'tavily', mode: 'literal', ref: 'B' },
	]
	assert.deepEqual(orderedLegs(sources, fallback), [
		{ kind: 'tavily', id: 's1', ref: 'A' },
		{ kind: 'tavily', id: 's2', ref: 'B' },
		{ kind: 'deepseek', id: 'deepseek', ref: 'DEEPSEEK_API_KEY' },
	])
})

await test('兜底行没挂载 ⇒ 腿里没有 deepseek', () => {
	const legs = orderedLegs([{ id: 's1', kind: 'tavily', mode: 'env', ref: 'A' }], undefined)
	assert.deepEqual(legs.map((leg) => leg.kind), ['tavily'])
})

await test('空源 + 有兜底 ⇒ 只剩兜底一条腿（合法降级形态）', () => {
	assert.deepEqual(orderedLegs([], fallback).map((leg) => leg.kind), ['deepseek'])
})

await test('回收：旧文档里不再被引用的、本插件分配的 ref 才 unset', () => {
	const prior = { version: 1, sources: [
		{ id: 's1', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1' },
		{ id: 's2', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY2' },
	] }
	assert.deepEqual(unusedRefs(prior, [{ id: 's2', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY2' }]), ['WEB_SEARCH_TAVILY_1'])
	assert.deepEqual(unusedRefs(prior, prior.sources), [])
})

await test('回收：环境变量名（不是本插件分配的 ref）绝不被 unset', () => {
	const prior = { version: 1, sources: [{ id: 's1', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY1' }] }
	assert.deepEqual(unusedRefs(prior, []), [])
})

await test('回收：literal 切到 env ⇒ 旧 ref 回收（不让密钥在凭据库里变孤儿）', () => {
	const prior = { version: 1, sources: [{ id: 's1', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_2' }] }
	assert.deepEqual(unusedRefs(prior, [{ id: 's1', kind: 'tavily', mode: 'env', ref: 'TAVILY_API_KEY1' }]), ['WEB_SEARCH_TAVILY_2'])
})

await test('回收：同一个 ref 即使出现在两个旧源里也只回收一次', () => {
	const prior = { version: 1, sources: [{ id: 's1', kind: 'tavily', mode: 'literal', ref: 'WEB_SEARCH_TAVILY_1' }] }
	assert.deepEqual(unusedRefs(prior, []), ['WEB_SEARCH_TAVILY_1'])
})

await test('describeAttempts：逐条列出 id(ref): outcome (message)', () => {
	assert.equal(
		describeAttempts([
			{ id: 's1', ref: 'K1', outcome: 'credential-missing' },
			{ id: 's2', ref: 'K2', outcome: 'failed', message: 'HTTP 401' },
		]),
		's1(K1): credential-missing; s2(K2): failed (HTTP 401)',
	)
})

await test('describeAttempts：一条尝试都没有（源被删空且无兜底）时的兜底文案', () => {
	assert.equal(describeAttempts([]), 'every source row is disabled')
})

await test('LITERAL_REF_PREFIX 就是本插件明文 ref 的命名空间', () => {
	assert.equal(LITERAL_REF_PREFIX, 'WEB_SEARCH_TAVILY_')
})

summary('core-chain')
