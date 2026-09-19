/**
 * NS 输入解析与规范化（Phase 4-B 从 App.tsx 抽出）
 *
 * DNSHE 与 DigitalPlat 两个 NS 弹窗都要用这组纯函数：前者把输入合并成「添加 NS」的
 * 多条记录，后者把输入合并进「整组替换」的草稿列表。抽组件后若各自留一份副本，
 * 就会出现两套去重/大小写规则，因此统一放这里，双方共同引用。
 */

/**
 * 把 NS 输入框内容解析为去重后的地址列表
 * （换行/逗号/空格分隔，去掉末尾的根点，统一小写）
 */
export const parseNsInput = (text: string): string[] =>
  Array.from(
    new Set(
      text
        .split(/[,，;；\s\n]+/)
        .map((s) => s.trim().replace(/\.$/, "").toLowerCase())
        .filter(Boolean)
    )
  );

/** 单条 NS 规范化（小写 + 去末尾根点），用于列表去重/比对 */
export const normalizeNs = (value: string): string =>
  String(value || "").trim().toLowerCase().replace(/\.$/, "");
