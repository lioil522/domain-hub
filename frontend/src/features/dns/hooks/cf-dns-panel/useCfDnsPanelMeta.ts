import { useMemo } from "react";
import { MULTI_PROVIDER_META, MULTI_PROVIDER_ORDER } from "../../../providers/providerMeta";
import { dpStatusBadge } from "../../../domains/dpStatusBadge";
import { providerSupportsLine } from "../../../../dnsrecords";
import type { Domain } from "../../../../types/domain";
import type { MultiProviderKey } from "../../../../types/provider";

export function useCfDnsPanelMeta(cfSelectedZone: Domain | null) {
  const dnsPanelMeta = useMemo(() => {
    const provider = cfSelectedZone?.account_provider || "cloudflare";
    const supportsLine = providerSupportsLine(provider, Boolean(cfSelectedZone?.supports_line));
    if (provider === "digitalplat") {
      return {
        isDp: true,
        isCloudflare: false,
        provider,
        supportsLine,
        // DigitalPlat 的记录类型/主机名由 API 决定，不允许在编辑态改动
        lockedIdentity: true,
        label: "DigitalPlat",
        subtitle: `DigitalPlat 托管域名 · ${dpStatusBadge(String(cfSelectedZone?.status || "")).text}`,
        refreshTitle: "强制刷新（忽略缓存，重新从 DigitalPlat 拉取）",
      };
    }
    if ((MULTI_PROVIDER_ORDER as readonly string[]).includes(provider)) {
      const key = provider as MultiProviderKey;
      return {
        isDp: false,
        isCloudflare: false,
        provider,
        supportsLine,
        // DNSPod / 阿里云 / 华为云 / Vercel 的记录类型与主机名同样由各自 API 固定
        lockedIdentity: true,
        label: MULTI_PROVIDER_META[key].label,
        subtitle: `${MULTI_PROVIDER_META[key].label} 托管域名 · 状态: ${String(cfSelectedZone?.status || "正常")}`,
        refreshTitle: `强制刷新（忽略缓存，重新从 ${MULTI_PROVIDER_META[key].label} 拉取）`,
      };
    }
    return {
      isDp: false,
      isCloudflare: true,
      provider,
      supportsLine,
      // 只有 Cloudflare 允许在编辑态切换记录类型与主机名
      lockedIdentity: false,
      label: "Cloudflare",
      subtitle: `Cloudflare 托管 zone · ${
        String(cfSelectedZone?.status || "").toLowerCase() === "active" ? "已激活" : "待激活"
      }`,
      refreshTitle: "强制刷新（忽略缓存，重新从 Cloudflare 拉取）",
    };
  }, [cfSelectedZone]);

  return { dnsPanelMeta, dnsPanelIsDp: dnsPanelMeta.isDp };
}

export type UseCfDnsPanelMetaReturn = ReturnType<typeof useCfDnsPanelMeta>;
