# Phase 3-G — Scanner State Persistence Boundary

## Goal

把 Scanner 的持久化副作用从状态 Hook 和能力 Hook 中移出，建立单一的 storage boundary，同时消除 `useScannerState -> useScannerReservedPrefixes` 的反向依赖。

## Changes

- 新增 `frontend/src/features/scanner/utils/scanner-storage.ts`
  - custom root domains
  - reserved prefixes
  - reserved-filter preference
  - scan cursor
- `useScannerState.ts` 只负责 React state 初始化，不再直接访问 `localStorage`。
- `useScannerRootDomains.ts` 不再直接访问 `localStorage`。
- `useScannerReservedPrefixes.ts` 不再直接访问 `localStorage`。
- `useScannerBatchScan.ts` 不再直接访问 `localStorage`。
- Scanner 默认常量统一进入 `scanner-constants.ts`。
- `useScannerReservedPrefixes.ts` 不再从 `useScannerState.ts` 导入默认值，避免 state/constants 循环依赖。
- `architecture-check.mjs` 增加 storage boundary 守卫：Scanner hooks 禁止直接使用 `localStorage`。

## Verification

- Architecture Check: PASS
- Root TypeScript: PASS
- Worker bundle: PASS
- Frontend TypeScript: PASS
- Frontend Vite build: PASS
- Unit/integration invariant tests: PASS
- Theme/Cascade/Contrast: 108/108 PASS

The uploaded Windows dependency archives required executable-bit normalization in the Linux verification environment; this is an environment packaging issue, not a source-code failure.
