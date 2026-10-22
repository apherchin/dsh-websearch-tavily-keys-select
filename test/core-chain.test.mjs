import { test, summary, assert } from './harness.mjs'
import {
	orderedLegs,
	unusedRefs,
	describeAttempts,
	LITERAL_REF_PREFIX,
	selectableSources,
	recordFailure,
	recordSuccess,
	clearAutoDisable,
	autoDisabledOf,
	AUTO_DISABLE_THRESHOLD,
} from '../bundle/host/core.mjs'

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

//#region 停用（disable，不是 delete）
await test('selectableSources：手动停用与自动停用都被跳过，其余保持文档顺序', () => {
	const sources = [
		{ id: 's1', kind: 'tavily', mode: 'env', ref: 'A' },
		{ id: 's2', kind: 'tavily', mode: 'env', ref: 'B', disabled: true },
		{ id: 's3', kind: 'tavily', mode: 'env', ref: 'C' },
	]
	const runtime = { sources: { s3: { fails: 3, autoDisabledAt: '2026-10-22T05:00:00.000Z', reason: 'HTTP 432' } } }
	assert.deepEqual(selectableSources(sources, runtime).map((source) => source.id), ['s1'])
	assert.deepEqual(selectableSources(sources, undefined).map((source) => source.id), ['s1', 's3'])
})

await test(`recordFailure：连到第 ${AUTO_DISABLE_THRESHOLD} 次才自动停用（并记原因/时间）；recordSuccess 清零`, () => {
	let state = { sources: {} }
	for (let round = 1; round < AUTO_DISABLE_THRESHOLD; round += 1) {
		state = recordFailure(state, 's1', 'HTTP 432', 1000)
		assert.equal(autoDisabledOf(state, 's1'), undefined, `第 ${round} 次不该停用`)
		assert.equal(state.sources.s1.fails, round)
	}
	state = recordFailure(state, 's1', 'HTTP 432', 2000)
	assert.deepEqual(autoDisabledOf(state, 's1'), { at: '1970-01-01T00:00:02.000Z', reason: 'HTTP 432' })
	// 再失败不会把停用时间刷新
	state = recordFailure(state, 's1', 'again', 3000)
	assert.equal(autoDisabledOf(state, 's1').at, '1970-01-01T00:00:02.000Z')
	const cleared = recordSuccess(state, 's1')
	assert.equal(cleared.sources.s1.autoDisabledAt, '1970-01-01T00:00:02.000Z', '成功不清停用标记')
	assert.equal(cleared.sources.s1.fails, 0)
})

await test('clearAutoDisable：清掉标记（源与失败计数一起清），不碰别的源', () => {
	const state = { sources: { s1: { fails: 3, autoDisabledAt: '2026-10-22T05:00:00.000Z', reason: 'HTTP 432' }, s2: { fails: 1 } } }
	const next = clearAutoDisable(state, 's1')
	assert.equal(next.sources.s1, undefined)
	assert.equal(next.sources.s2.fails, 1)
	// 幂等
	assert.equal(clearAutoDisable(next, 's1'), next)
})
//#endregion
summary('core-chain')
