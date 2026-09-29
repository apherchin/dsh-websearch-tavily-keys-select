// Row package for the web-search-chain implementation. Re-exporting keeps one
// module instance (and therefore one source registry) for every row.
//
// ⚠️ 必须按**包名**导入，不能写相对路径 `../dsh-web-search-chain/index-v5.mjs`：
//    在当前 profile 的"扁平 node_modules"里相对路径碰巧能解析，但 `dsh plugin`
//    用的是 **pnpm**（虚拟 store + 符号链接）⇒ 从 `.pnpm/dsh-search-chain@…/node_modules/
//    dsh-search-chain/` 出发，`../dsh-web-search-chain/` 并不存在 ⇒ 装上去直接 import 失败。
//    包名导入在 npm 扁平布局与 pnpm 布局下**都**成立（本包 package.json 已声明该依赖）。
export { name, inject, apply } from 'dsh-websearch-tavily-keys-select'
