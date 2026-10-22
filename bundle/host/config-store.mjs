/**
 * 配置文档与用量文档的读写层：路径解析、损坏降级、原子写。
 *
 * 所有 I/O 都收敛在这里，理由有二：
 * 1. 纯逻辑（`core.mjs`）才能离线测；
 * 2. **搜索链路每次搜索都调 `readConfigDocument` / `readUsageDocument`**，所以它们绝不能抛 ——
 *    抛错就等于 web_search 挂掉。任何异常都退成默认值并把原因放进 `error`。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
	MAX_DOCUMENT_BYTES,
	defaultDocument,
	emptyRuntimeState,
	emptyUsageDocument,
	parseDocumentText,
	parseRuntimeStateText,
	parseUsageText,
	serializeDocument,
	serializeRuntimeState,
	serializeUsageDocument,
} from './core.mjs'

/** 配置文件体积上限（用量/状态文件比它更小，共用同一个上限做防呆）。 */
const MAX_USAGE_BYTES = MAX_DOCUMENT_BYTES

/** 配置文档路径。 */
export function configDocumentPath(home) {
	return join(home, 'web-search-chain.json')
}

/** 用量文档路径（本地额度计数；腾讯云没有查配额接口，这是唯一可编程的账本）。 */
export function usageDocumentPath(home) {
	return join(home, 'web-search-chain-usage.json')
}

/**
 * 运行时状态路径（失败计数 + 自动停用标记）。
 *
 * 与配置文档**分文件**：自动停用是观察到的现象，不是用户的意图；配置文档只记 `disabled`（手动）。
 */
export function runtimeStatePath(home) {
	return join(home, 'web-search-chain-state.json')
}

/**
 * 读配置文档。
 * @param path - 文档路径。
 * @returns `{doc, error}`；error 非空表示「按默认值工作」，doc 恒可用。
 */
export function readConfigDocument(path) {
	let size
	try {
		size = statSync(path).size
	} catch (error) {
		if (error?.code === 'ENOENT') return { doc: defaultDocument(), error: undefined }
		return { doc: defaultDocument(), error: `配置文件不可读：${String(error)}` }
	}
	if (size > MAX_DOCUMENT_BYTES) {
		return { doc: defaultDocument(), error: `配置文件超过 ${MAX_DOCUMENT_BYTES} 字节，已按默认值工作` }
	}
	let text
	try {
		text = readFileSync(path, 'utf8')
	} catch (error) {
		return { doc: defaultDocument(), error: `配置文件不可读：${String(error)}` }
	}
	const parsed = parseDocumentText(text)
	return {
		doc: parsed.doc,
		error: parsed.error === undefined ? undefined : `配置文件损坏（${parsed.error}），已按默认值工作`,
	}
}

/** 原子写：先写 `<path>.tmp` 再 rename 覆盖（不做原地截断）。 */
export function writeConfigDocument(path, doc) {
	const text = serializeDocument(doc)
	const temporary = `${path}.tmp`
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(temporary, text, 'utf8')
	renameSync(temporary, path)
}

/**
 * 读用量文档。**绝不抛**：坏了就当"本月还没用过"（宁可少算一次也不让搜索挂掉；
 * 少算的风险由 `reserve` 余量兜着）。
 * @param path - 文档路径。
 * @returns `{doc, error}`。
 */
export function readUsageDocument(path) {
	let size
	try {
		size = statSync(path).size
	} catch (error) {
		if (error?.code === 'ENOENT') return { doc: emptyUsageDocument(), error: undefined }
		return { doc: emptyUsageDocument(), error: `用量文件不可读：${String(error)}` }
	}
	if (size > MAX_USAGE_BYTES) {
		return { doc: emptyUsageDocument(), error: `用量文件超过 ${MAX_USAGE_BYTES} 字节，已按 0 计` }
	}
	let text
	try {
		text = readFileSync(path, 'utf8')
	} catch (error) {
		return { doc: emptyUsageDocument(), error: `用量文件不可读：${String(error)}` }
	}
	const parsed = parseUsageText(text)
	return {
		doc: parsed.doc,
		error: parsed.error === undefined ? undefined : `用量文件损坏（${parsed.error}），已按 0 计`,
	}
}

/** 原子写用量文档。 */
export function writeUsageDocument(path, doc) {
	const text = serializeUsageDocument(doc)
	const temporary = `${path}.tmp`
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(temporary, text, 'utf8')
	renameSync(temporary, path)
}

/**
 * 读运行时状态（失败计数 + 自动停用）。**绝不抛**：读不了就当"没有自动停用"。
 * @param path - 文档路径。
 * @returns `{state, error}`。
 */
export function readRuntimeState(path) {
	let size
	try {
		size = statSync(path).size
	} catch (error) {
		if (error?.code === 'ENOENT') return { state: emptyRuntimeState(), error: undefined }
		return { state: emptyRuntimeState(), error: `状态文件不可读：${String(error)}` }
	}
	if (size > MAX_USAGE_BYTES) {
		return { state: emptyRuntimeState(), error: `状态文件超过 ${MAX_USAGE_BYTES} 字节，已按空计` }
	}
	let text
	try {
		text = readFileSync(path, 'utf8')
	} catch (error) {
		return { state: emptyRuntimeState(), error: `状态文件不可读：${String(error)}` }
	}
	const parsed = parseRuntimeStateText(text)
	return {
		state: parsed.state,
		error: parsed.error === undefined ? undefined : `状态文件损坏（${parsed.error}），已按空计`,
	}
}

/** 原子写运行时状态。 */
export function writeRuntimeState(path, state) {
	const text = serializeRuntimeState(state)
	const temporary = `${path}.tmp`
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(temporary, text, 'utf8')
	renameSync(temporary, path)
}
