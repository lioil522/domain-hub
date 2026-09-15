/**
 * 极简 className 合并工具
 *
 * WHY 不引 clsx / tailwind-merge：
 * 这个项目只在组件层用得到它，而 tailwind-merge 会带来约 6KB 的运行时开销，
 * 我们对 Worker 的静态资源体积一向敏感（见 Dockerfile 里后端压到 244KB 的努力）。
 * 组件层的 class 冲突由「调用方 className 永远排在最后」这一约定解决 ——
 * CSS 层后写的同名工具类覆盖先写的，与 tailwind-merge 的语义一致。
 *
 * 用法：cn("base", cond && "active", props.className)
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
