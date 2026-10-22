import { test, summary, assert } from './harness.mjs'
import {
	beijingDateKey,
	beijingMonthKey,
	previousMonthKey,
	defaultBudgetFor,
	normalizeBudget,
	effectiveBudget,
	effectiveMonthly,
	budgetStatus,
	emptyUsageDocument,
	parseUsageText,
	serializeUsageDocument,
	usageCount,
	withUsageCount,
	defaultDocument,
} from '../bundle/host/core.mjs'

console.log('-- core: 额度与用量 --')

/** 北京时间 2026-10-22 12:00（活动期内） */
const DURING_PROMO = Date.parse('2026-10-22T04:00:00Z')
/** 北京时间 2026-11-30 23:59（活动最后一分钟，仍算活动期） */
const PROMO_LAST_MINUTE = Date.parse('2026-11-30T15:59:00Z')
/** 北京时间 2026-12-01 00:00（活动结束） */
const AFTER_PROMO = Date.parse('2026-11-30T16:00:00Z')

const YUANBAO = { id: 's3', kind: 'yuanbao', mode: 'env', ref: 'TENCENTCLOUD_SECRET_KEY', secretId: 'AKIDxxxxxxxx' }

await test('北京时间键：跨月边界按东八区切（UTC 会把最后 8 小时算进下个月）', () => {
	// 2026-10-31 23:30 UTC == 2026-11-01 07:30 北京
	assert.equal(beijingDateKey(Date.parse('2026-10-31T23:30:00Z')), '2026-11-01')
	assert.equal(beijingMonthKey(Date.parse('2026-10-31T23:30:00Z')), '2026-11')
	// 2026-10-31 15:30 UTC == 2026-10-31 23:30 北京
	assert.equal(beijingMonthKey(Date.parse('2026-10-31T15:30:00Z')), '2026-10')
})

await test('previousMonthKey：跨年也对', () => {
	assert.equal(previousMonthKey('2026-01'), '2025-12')
	assert.equal(previousMonthKey('2026-10'), '2026-09')
})

await test('yuanbao 默认预算 = 日常 2000 + 保留 100 + 活动 6000（至 2026-11-30）', () => {
	assert.deepEqual(defaultBudgetFor('yuanbao'), { monthly: 2000, reserve: 100, promo: { monthly: 6000, until: '2026-11-30' } })
	assert.equal(defaultBudgetFor('tavily'), undefined)
})

await test('normalizeBudget：接受合法值（含 promo），拒绝非法值', () => {
	assert.deepEqual(normalizeBudget({ monthly: 2000, reserve: 100 }), { monthly: 2000, reserve: 100 })
	assert.deepEqual(normalizeBudget({ monthly: 6000, reserve: 0, promo: { monthly: 9000, until: '2026-11-30' } }), {
		monthly: 6000,
		reserve: 0,
		promo: { monthly: 9000, until: '2026-11-30' },
	})
	for (const bad of [null, [], 'x', { monthly: -1 }, { monthly: 1.5 }, { monthly: 100, reserve: -1 }, { monthly: 100, reserve: 101 }, { monthly: 0, reserve: 1 }, { monthly: 100, promo: { monthly: 200, until: '2026-13-01' } }]) {
		assert.equal(normalizeBudget(bad), undefined, JSON.stringify(bad))
	}
})

await test('effectiveBudget：文档里的优先，否则取模板默认', () => {
	assert.deepEqual(effectiveBudget(YUANBAO), defaultBudgetFor('yuanbao'))
	assert.deepEqual(effectiveBudget({ ...YUANBAO, budget: { monthly: 50, reserve: 0 } }), { monthly: 50, reserve: 0 })
	assert.equal(effectiveBudget({ kind: 'tavily' }), undefined)
})

await test('effectiveMonthly：活动期内 6000，过期回 2000（按北京时间判）', () => {
	const budget = defaultBudgetFor('yuanbao')
	assert.deepEqual(effectiveMonthly(budget, DURING_PROMO), { monthly: 6000, promoActive: true })
	assert.deepEqual(effectiveMonthly(budget, PROMO_LAST_MINUTE), { monthly: 6000, promoActive: true })
	assert.deepEqual(effectiveMonthly(budget, AFTER_PROMO), { monthly: 2000, promoActive: false })
})

await test('budgetStatus：活动期 6000 − 100 保留 = 可用 5900，到点即 exhausted', () => {
	const status = budgetStatus(YUANBAO, 5899, DURING_PROMO)
	assert.equal(status.monthly, 6000)
	assert.equal(status.reserve, 100)
	assert.equal(status.remaining, 1)
	assert.equal(status.exhausted, false)
	assert.equal(status.promo.active, true)
	const edge = budgetStatus(YUANBAO, 5900, DURING_PROMO)
	assert.equal(edge.remaining, 0)
	assert.equal(edge.exhausted, true)
	assert.equal(budgetStatus(YUANBAO, 0, DURING_PROMO).exhausted, false)
})

await test('budgetStatus：活动结束后同样的 used 会立刻判超额（防"忘了改配置"）', () => {
	const status = budgetStatus(YUANBAO, 2000 - 100, AFTER_PROMO)
	assert.equal(status.monthly, 2000)
	assert.equal(status.exhausted, true)
	assert.equal(status.promo.active, false)
})

await test('budgetStatus：无预算 = 不限；monthly:0 = 不限（remaining 是 null，不是 Infinity）', () => {
	const free = budgetStatus({ kind: 'tavily' }, 999)
	assert.deepEqual(free, { unlimited: true, monthly: null, reserve: 0, used: 999, remaining: null, exhausted: false, promo: null })
	const unlimited = budgetStatus({ ...YUANBAO, budget: { monthly: 0, reserve: 0 } }, 999)
	assert.equal(unlimited.unlimited, true)
	assert.equal(unlimited.exhausted, false)
	assert.equal(JSON.stringify(unlimited).includes('Infinity'), false)
})

await test('budgetStatus：非法 used 当 0（读坏了也不许把闸门放开成"已用 -1"）', () => {
	for (const used of [-5, '12', null, undefined, 3.5]) {
		assert.equal(budgetStatus(YUANBAO, used, DURING_PROMO).used, 0, String(used))
	}
})

await test('用量文档：解析非法内容不抛，坏桶被丢掉', () => {
	assert.deepEqual(parseUsageText('{oops').doc, emptyUsageDocument())
	assert.deepEqual(parseUsageText('[]').doc, emptyUsageDocument())
	const parsed = parseUsageText(JSON.stringify({ version: 1, months: { '2026-10': { s3: 12, bad: -1, 'no space': 3 }, nope: { s3: 5 } } }))
	assert.equal(parsed.error, undefined)
	assert.deepEqual(parsed.doc.months, { '2026-10': { s3: { calls: 12 } } })
})

await test('用量文档：写入只保留本月与上月，序列化稳定', () => {
	let doc = emptyUsageDocument()
	doc = withUsageCount(doc, '2026-08', 's3', 5)
	doc = withUsageCount(doc, '2026-09', 's3', 6)
	doc = withUsageCount(doc, '2026-10', 's3', 7)
	assert.deepEqual(Object.keys(doc.months).sort(), ['2026-09', '2026-10'])
	assert.equal(usageCount(doc, '2026-10', 's3'), 7)
	assert.equal(usageCount(doc, '2026-10', 's1'), 0)
	const round = parseUsageText(serializeUsageDocument(doc))
	assert.deepEqual(round.doc.months, doc.months)
	assert.ok(serializeUsageDocument(doc).endsWith('}\n'))
})

await test('用量文档：非法计数不覆盖旧值（不是把闸门清零）', () => {
	const doc = withUsageCount(emptyUsageDocument(), '2026-10', 's3', 42)
	assert.equal(withUsageCount(doc, '2026-10', 's3', -1), doc)
	assert.equal(withUsageCount(doc, '2026-10', 's3', 'x'), doc)
})

await test('默认文档 / 空文档里的源都没有 budget（预算只属于 yuanbao 之类的付费源）', () => {
	assert.equal(defaultDocument().sources.every((source) => source.budget === undefined), true)
})

summary('core-budget')
