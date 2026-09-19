/**
 * 页面级组件共用的数据形状（re-export 出口）
 *
 * WHY 单独抽一份：`Domain` / `Account` / `DnsRecord` 原本只定义在 `App.tsx` 里，
 * 抽组件后 `DnsRecordPanel` / `AccountsPage` 都要引用它们。若从 `App.tsx` 反向
 * 导出（`export type { Domain } from "../App"`），会形成
 * App → components → App 的循环依赖 —— TS 能编译，但打包器会报循环警告，
 * 且 Vite 的 HMR 在这种环下偶发整页刷新。放到中立文件里切断了这个环。
 *
 * NOTE: 定义已归位到 `src/types/`（按业务域拆分）。本文件保留为**向后兼容的
 * 再导出层**，`./types` 的既有引用（`DnsRecordPanel` / `AccountsPage`）无需改动，
 * 全项目仍只有一处 interface 声明。
 *
 * 字段来源：与后端 `/api/domains`、`/api/accounts`、`/api/domains/:id/dns`
 * 的响应结构一一对应，新增字段时三处（后端 SQL SELECT、types/、消费点）要同步。
 */

export type { Domain, CfExpiryEntry } from "../types/domain";
export type { Account, AccountProvider } from "../types/account";
export type { DnsRecord } from "../types/dns";
