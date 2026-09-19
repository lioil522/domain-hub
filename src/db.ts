/**
 * DatabaseManager 公开 API 出口
 *
 * NOTE: 从 legacy.ts 迁移到模块化架构后，所有导出保持不变。
 * 既有代码的 `import { DatabaseManager, ... } from "../db"` 无需修改。
 */
export { DatabaseManager } from "./db/database-manager";
export * from "./db/types";
export * from "./db/crypto";
