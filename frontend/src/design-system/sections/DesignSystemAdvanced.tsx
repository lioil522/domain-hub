import { useState } from "react";
import { CheckCircle2, Cloud, Folder, Globe, Key, Save } from "lucide-react";
import { Button, Card, DomainTimeline, Field, Modal } from "../../components";
import { Section } from "../primitives";

const mockTimelineBuckets = (() => {
  const start = new Date();
  start.setDate(1);
  const counts = [1, 0, 3, 0, 0, 6, 2, 0, 1, 4, 0, 2];
  const sourcePool = ["DNSHE", "Cloudflare", "DigitalPlat", "自定义"] as const;
  let n = 0;
  return counts.map((count, i) => {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const items = Array.from({ length: count }, (_, j) => {
      n++;
      const day = (j + 1) * 3;
      const daysLeft = i * 30 + day;
      return { full_domain: `demo-${n}.example.com`, source: sourcePool[n % sourcePool.length] as string, alias: n % 3 === 0 ? "" : `账号 ${n % 5}`, daysLeft, day };
    });
    return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: `${d.getMonth() + 1}月`, year: d.getFullYear(), month: d.getMonth() + 1, isCurrent: i === 0, items };
  });
})();

export function DesignSystemAdvanced() {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <>
        <Section
          title="Modal · 无障碍弹窗"
          desc="role=dialog + aria-modal、Esc 关闭、焦点陷阱（Tab 不逃出弹窗）、关闭后焦点归还到触发按钮 —— 这四项是键盘与读屏用户能正常使用弹窗的前提。"
        >
          <Card padding="lg">
            <Button variant="primary" onClick={() => setModalOpen(true)}>
              打开弹窗演示
            </Button>
            <p className="text-[11px] text-content-muted mt-3">
              试试：打开后按 Esc 应能关闭；连续按 Tab 焦点不应跑到弹窗外的元素上。
            </p>
          </Card>

          <Modal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            title="编辑到期信息"
            description="Cloudflare zone 不含到期字段，需手动录入或由 RDAP 自动查询"
            maxWidthClass="max-w-lg"
            footer={
              <>
                <Button variant="warn" size="sm">恢复自动查询</Button>
                <div className="flex items-center gap-3">
                  <Button variant="secondary" size="sm" onClick={() => setModalOpen(false)}>
                    取消
                  </Button>
                  <Button variant="primary" size="sm" icon={<Save className="w-3.5 h-3.5" />}>
                    保存手动值
                  </Button>
                </div>
              </>
            }
          >
            <div className="p-4 sm:p-6 flex flex-col gap-5">
              <Field label="域名">
                <input
                  className="form-input px-3 py-2 rounded-md text-sm w-full font-mono"
                  defaultValue="example.com"
                  readOnly
                />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="注册时间" hint="留空则不显示">
                  <input type="date" className="form-input px-3 py-2 rounded-md text-sm w-full" />
                </Field>
                <Field label="到期时间" hint="留空 = 永久">
                  <input type="date" className="form-input px-3 py-2 rounded-md text-sm w-full" />
                </Field>
              </div>
              <Field label="注册来源" hint="如 Namecheap / GoDaddy / 赠送">
                <input
                  className="form-input px-3 py-2 rounded-md text-sm w-full"
                  placeholder="选填"
                />
              </Field>
            </div>
          </Modal>
        </Section>

        {/* ── 资产时间轴 ── */}
        <Section
          title="资产时间轴"
          desc="未来 12 个月到期分布。柱高按当月数量归一，数字始终显示以区分「1 个」与「0 个」；点击有数据的月份展开域名清单。"
        >
          <div className="flex flex-col gap-4">
            {/* 主态：数据分布不均，含当前月、空月、跨年 */}
            <DomainTimeline
              buckets={mockTimelineBuckets}
              maxCount={Math.max(1, ...mockTimelineBuckets.map((b) => b.items.length))}
              scheduledTotal={mockTimelineBuckets.reduce((s, b) => s + b.items.length, 0)}
              permanentCount={3}
              overdueCount={2}
              onPickDomain={() => {}}
            />

            {/* 空态：全部永久域名，验证「无到期压力」时的降级呈现 */}
            <DomainTimeline
              buckets={mockTimelineBuckets.map((b) => ({ ...b, items: [] }))}
              maxCount={1}
              scheduledTotal={0}
              permanentCount={5}
              overdueCount={0}
            />
          </div>
        </Section>

        {/* ── 侧栏 badge 对照 ── */}
        <Section
          title="侧栏导航 · 来源色对照"
          desc="侧栏 badge 与服务商来源色统一，用户扫侧栏即知各来源的资产规模。"
        >
          <Card padding="lg">
            <ul className="flex flex-col gap-1">
              {[
                { label: "概览", icon: <Globe className="w-4 h-4" />, count: null },
                { label: "DNSHE", icon: <Globe className="w-4 h-4" />, count: 15, source: "dnshe" as const },
                { label: "Cloudflare", icon: <Cloud className="w-4 h-4" />, count: 55, source: "cloudflare" as const },
                { label: "DigitalPlat", icon: <Globe className="w-4 h-4" />, count: 4, source: "digitalplat" as const },
                { label: "自定义", icon: <Folder className="w-4 h-4" />, count: 7, source: "custom" as const },
                { label: "账号管理", icon: <Key className="w-4 h-4" />, count: 10, source: null }
              ].map((item) => (
                <li
                  key={item.label}
                  className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-hovered transition-colors"
                >
                  <span
                    className={
                      item.source
                        ? `text-source-${item.source === "cloudflare" ? "cf" : item.source === "digitalplat" ? "dp" : item.source}-fg`
                        : "text-content-muted"
                    }
                  >
                    {item.icon}
                  </span>
                  <span className="text-xs font-medium text-content-secondary flex-1">
                    {item.label}
                  </span>
                  {item.count !== null && (
                    <span className="text-[10px] font-semibold text-content-muted tabular-nums">
                      {item.count}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </Section>

        {/* ── 无障碍说明 ── */}
        <Section
          title="无障碍基线"
          desc="以下四项目前已全局生效，新增组件时请遵循。"
        >
          <Card padding="lg">
            <ul className="flex flex-col gap-3 text-xs text-content-secondary">
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-state-ok-fg flex-shrink-0 mt-px" />
                <span>
                  <strong className="font-semibold text-content-primary">焦点可见性</strong>
                  ：全局 :focus-visible 统一焦点环，用 outline 实现（不触发重排），
                  鼠标点击不出现、键盘导航才出现。
                </span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-state-ok-fg flex-shrink-0 mt-px" />
                <span>
                  <strong className="font-semibold text-content-primary">减动效偏好</strong>
                  ：尊重系统「减少动态效果」设置，动画压到 0.01ms，
                  结束态正常呈现。
                </span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-state-ok-fg flex-shrink-0 mt-px" />
                <span>
                  <strong className="font-semibold text-content-primary">触控目标</strong>
                  ：.touch-target 在粗指针设备上撑到 44×44，
                  桌面观感不变。
                </span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-state-ok-fg flex-shrink-0 mt-px" />
                <span>
                  <strong className="font-semibold text-content-primary">对比度</strong>
                  ：五组 state 语义色的 bg/fg 组合对比度均 ≥ 4.5:1（亮色实测
                  4.6–6.4:1，暗色 5.6–10.5:1），满足 WCAG AA 正文要求。
                </span>
              </li>
            </ul>
          </Card>
        </Section>
    </>
  );
}
