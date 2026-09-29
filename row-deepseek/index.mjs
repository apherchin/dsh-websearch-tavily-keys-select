// Row package for the web-search-chain implementation. Re-exporting keeps one
// module instance (and therefore one source registry) for every row.
//
// ⚠️ 必须按**包名**导入（相对路径在 pnpm 的虚拟 store 布局下解析不到）——详见 row-chain/index.mjs 的说明。
export { name, inject, apply } from 'dsh-websearch-tavily-keys-select'
