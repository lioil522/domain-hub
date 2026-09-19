import type { BadgeTone } from "../../components/Badge";

  // DigitalPlat 注册态 → 徽标文案与语义 tone
  // pendingdelete 是上游「待删除（7 天后释放）」的宽限期状态，用 danger 而非 warn：
  // 它不可逆，且用户需要立刻行动（续期或迁移），配色必须最高优先级。
  export const dpStatusBadge = (status: string): { text: string; tone: BadgeTone } => {
    const s = String(status || "").toLowerCase();
    if (s === "ok" || s === "active") {
      return { text: "正常", tone: "ok" };
    }
    if (s.includes("pendingdelete") || s.includes("pending delete")) {
      return { text: "待删除（7 天后释放）", tone: "danger" };
    }
    if (s) {
      return { text: s, tone: "warn" };
    }
    return { text: "未知", tone: "idle" };
  };
