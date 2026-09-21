import { AlertTriangle, CheckCircle2, Download, ExternalLink, Plus, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { Badge, Button, Card } from "../../components";
import { statusTone, expiryTone } from "../../components";
import { Section } from "../primitives";

export interface DesignSystemControlsProps {
  loadingDemo: boolean;
  onRunLoadingDemo: () => void;
}

export function DesignSystemControls({ loadingDemo, onRunLoadingDemo }: DesignSystemControlsProps) {
  return (
    <>
        {/* ── 按钮 ── */}
        <Section
          title="Button · 变体"
          desc="variant 表达重要性而非颜色。primary 主操作（保存/登录）、secondary 次操作（取消）、ghost 弱操作（工具栏）、danger 破坏性、warn 需谨慎、success 正向确认。"
        >
          <Card padding="lg">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" icon={<Plus className="w-4 h-4" />}>主操作</Button>
              <Button variant="secondary" icon={<RefreshCw className="w-4 h-4" />}>次操作</Button>
              <Button variant="ghost" icon={<Search className="w-4 h-4" />}>弱操作</Button>
              <Button variant="danger" icon={<Trash2 className="w-4 h-4" />}>删除</Button>
              <Button variant="warn" icon={<AlertTriangle className="w-4 h-4" />}>恢复自动查询</Button>
              <Button variant="success" icon={<CheckCircle2 className="w-4 h-4" />}>启用</Button>
            </div>
          </Card>
        </Section>

        <Section title="Button · 尺寸与状态" desc="四档尺寸均落在 4px 栅格。lg 档高度 44px，正好满足触控目标最小值。">
          <Card padding="lg">
            <div className="flex flex-wrap items-end gap-3 mb-5">
              <Button size="xs" variant="primary">xs · 28px</Button>
              <Button size="sm" variant="primary">sm · 34px</Button>
              <Button size="md" variant="primary">md · 38px</Button>
              <Button size="lg" variant="primary">lg · 44px</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-border-soft">
              <Button variant="primary" loading={loadingDemo} onClick={onRunLoadingDemo}>
                {loadingDemo ? "同步中" : "点击演示加载态"}
              </Button>
              <Button variant="primary" disabled>禁用态</Button>
              <Button variant="secondary" disabled>禁用态</Button>
              <Button variant="primary" trailingIcon={<ExternalLink className="w-3.5 h-3.5" />}>
                控制台
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-4 mt-4 border-t border-border-soft">
              <Button variant="ghost" iconOnly aria-label="添加" icon={<Plus className="w-4 h-4" />} />
              <Button variant="ghost" iconOnly aria-label="删除" icon={<Trash2 className="w-4 h-4" />} />
              <Button variant="ghost" iconOnly aria-label="下载" icon={<Download className="w-4 h-4" />} />
              <Button variant="ghost" iconOnly aria-label="上传" icon={<Upload className="w-4 h-4" />} />
              <span className="text-[11px] text-content-muted">
                图标按钮模式 · 已配 aria-label，读屏可读出用途
              </span>
            </div>
            <div className="pt-4 mt-4 border-t border-border-soft">
              <Button variant="primary" block size="lg">占满宽度的主操作</Button>
            </div>
          </Card>
        </Section>

        {/* ── 徽章 ── */}
        <Section
          title="Badge · 状态与来源"
          desc="statusTone() 与 expiryTone() 把后端的原始字符串/天数映射为语义色，三个页面共用同一套判断，新增状态只改一个函数。"
        >
          <Card padding="lg">
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <Badge tone="ok">正常</Badge>
              <Badge tone="info">已委派</Badge>
              <Badge tone="warn">待删除（7 天后释放）</Badge>
              <Badge tone="danger">已过期</Badge>
              <Badge tone="idle">未知</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2 mb-4 pt-4 border-t border-border-soft">
              <Badge source="dnshe" size="md">DNSHE</Badge>
              <Badge source="cloudflare" size="md">Cloudflare</Badge>
              <Badge source="digitalplat" size="md">DigitalPlat</Badge>
              <Badge source="custom" size="md">自定义</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-4 border-t border-border-soft">
              <Badge dot tone="ok">system · 已解析</Badge>
              <Badge dot tone="info">Cloudflare</Badge>
              <Badge dot tone="idle">未解析</Badge>
              <Badge dot tone="warn">剩余 42 天</Badge>
              <Badge dot tone="danger">剩余 -3 天</Badge>
            </div>
            <div className="mt-4 pt-4 border-t border-border-soft">
              <p className="text-[11px] text-content-muted mb-2">映射函数实测：</p>
              <div className="flex flex-wrap gap-2">
                <code className="text-[10px] font-mono text-content-secondary bg-elevated px-2 py-1 rounded-sm">
                  statusTone("active") → {statusTone("active")}
                </code>
                <code className="text-[10px] font-mono text-content-secondary bg-elevated px-2 py-1 rounded-sm">
                  statusTone("待删除") → {statusTone("待删除")}
                </code>
                <code className="text-[10px] font-mono text-content-secondary bg-elevated px-2 py-1 rounded-sm">
                  expiryTone(42) → {expiryTone(42)}
                </code>
                <code className="text-[10px] font-mono text-content-secondary bg-elevated px-2 py-1 rounded-sm">
                  expiryTone(-3) → {expiryTone(-3)}
                </code>
              </div>
            </div>
          </Card>
        </Section>
    </>
  );
}
