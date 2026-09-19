import React, { useState } from "react";
import {
  Plus,
  Trash2,
  RefreshCw,
  Download,
  Upload,
  ExternalLink,
  Search,
  Save,
  AlertTriangle,
  CheckCircle2,
  Globe,
  Cloud,
  Folder,
  Key
} from "lucide-react";
import {
  Button,
  Badge,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Skeleton,
  Field,
  Modal,
  DomainTimeline,
  ThemePicker,
  CustomSelect,
  Input,
  Textarea,
  statusTone,
  expiryTone
} from "./components";
import { THEMES, isThemeId, type ThemeId, applyThemeAttribute } from "./theme";

/**
 * DesignSystem —— 设计系统展示页
 *
 * 作用有两个：
 * 1) 视觉验收：所有组件 × 所有变体 × 所有状态在一页内可见，
 *    改令牌后打开这一页就知道影响面，不需要逐页点过去找。
 * 2) 开发对照：替换 App.tsx 内联样式时，在这里找到对应变体照抄调用方式，
 *    避免每个人按自己的理解写一套新样式。
 *
 * 该页面不参与业务，通过 #/design-system 访问。
 */

function Section(props: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-sm font-semibold text-content-primary mb-1">{props.title}</h2>
      {props.desc && <p className="text-xs text-content-muted mb-4">{props.desc}</p>}
      {!props.desc && <div className="mb-4" />}
      {props.children}
    </section>
  );
}

function Swatch(props: { name: string; varName: string; className: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={`h-10 rounded-md border border-border-base ${props.className}`} />
      <span className="text-[11px] text-content-secondary font-medium">{props.name}</span>
      <code className="text-[10px] text-content-muted font-mono">{props.varName}</code>
    </div>
  );
}

/**
 * 时间轴的展示用 mock 数据。
 *
 * 刻意构造成「分布不均 + 含空月 + 跨年」，因为均匀分布和全满的图看不出
 * 归一逻辑是否正确（柱高全一样，测不出归一；有空月才能验证零值不被画成柱子）。
 * 月份从当前月推演，保证「当前月」高亮在任何时候打开都落在真实位置。
 */
const mockTimelineBuckets = (() => {
  const start = new Date();
  start.setDate(1);
  const counts = [1, 0, 3, 0, 0, 6, 2, 0, 1, 4, 0, 2]; // 有意留空月
  const sourcePool = ["DNSHE", "Cloudflare", "DigitalPlat", "自定义"] as const;
  let n = 0;
  return counts.map((count, i) => {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const items = Array.from({ length: count }, (_, j) => {
      n++;
      const day = (j + 1) * 3;
      const daysLeft = i * 30 + day;
      return {
        full_domain: `demo-${n}.example.com`,
        source: sourcePool[n % sourcePool.length] as string,
        alias: n % 3 === 0 ? "" : `账号 ${n % 5}`,
        daysLeft,
        day
      };
    });
    return {
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: `${d.getMonth() + 1}月`,
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      isCurrent: i === 0,
      items
    };
  });
})();

export default function DesignSystem() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );
  /*
   * NOTE: 展示页的主题状态直接读 <html data-theme> 而不是从 localStorage 初始化 ——
   * 这样「在 App 里换了主题、再导航到展示页」能拿到最新值（同一标签页内
   * localStorage 是同步的，但读属性更直接且不会因为键名拼错而静默失效）。
   */
  const [colorTheme, setColorTheme] = useState<ThemeId>(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    return isThemeId(attr) ? attr : "indigo";
  });
  const [modalOpen, setModalOpen] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [formValue, setFormValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [providerDemo, setProviderDemo] = useState("dnshe");

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
  };

  const changeColorTheme = (id: ThemeId) => {
    setColorTheme(id);
    applyThemeAttribute(id);
  };

  const runLoadingDemo = () => {
    setLoadingDemo(true);
    window.setTimeout(() => setLoadingDemo(false), 1800);
  };

  const validateDemo = (v: string) => {
    setFormValue(v);
    // 演示校验反馈：少于 3 字符即报错
    setFormError(v.length > 0 && v.length < 3 ? "至少需要 3 个字符" : null);
  };

  return (
    <div className="min-h-screen bg-page p-4 sm:p-8">
      <div className="max-w-5xl mx-auto">
        {/* 头部 */}
        <header className="mb-8 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-bold text-content-primary">设计系统</h1>
            <p className="text-xs text-content-muted mt-1">
              Domain Hub 组件库 · 令牌 · 交互状态 · 无障碍基线
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={toggleTheme}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            切换到{dark ? "亮色" : "暗色"}
          </Button>
        </header>

        {/* ── 主题 ── */}
        <Section
          title="主题 · 配色身份 × 明暗"
          desc="两个正交维度：配色身份（data-theme）管色相，明暗（.dark 类）管明度。3 套主题 × 明暗共 6 个组合各自独立配平，切换任一维度都不影响另一个。"
        >
          <Card padding="lg">
            <div className="mb-4">
              <ThemePicker value={colorTheme} onChange={changeColorTheme} />
            </div>

            {/* 四个组合的真实渲染 —— 不是示意图，是当前令牌下的实际效果。
                每个小卡强制带上对应组合的作用域，所以要在这里临时写死属性，
                不能靠祖先继承（页面本身只有一个组合生效）。 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {THEMES.map((t) =>
                ([false, true] as const).map((isDark) => (
                  <div
                    key={`${t.id}-${isDark}`}
                    data-theme={t.id}
                    className={isDark ? "dark" : undefined}
                  >
                    <div className="rounded-lg border border-border-base bg-page p-3">
                      <div className="text-[10px] font-mono text-content-muted mb-2">
                        {t.label} × {isDark ? "暗色" : "亮色"}
                      </div>
                      <div className="rounded-md border border-border-base bg-surface p-2.5 space-y-2">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold bg-accent-gradient"
                            aria-hidden="true"
                          >
                            A
                          </span>
                          <span className="text-xs font-semibold text-content-primary">
                            正文 Primary
                          </span>
                          <span className="text-[11px] text-accent font-semibold">accent</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-state-ok-bg text-state-ok-fg border-state-ok-border">
                            正常
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-state-warn-bg text-state-warn-fg border-state-warn-border">
                            将到期
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-state-danger-bg text-state-danger-fg border-state-danger-border">
                            已过期
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-source-dnshe-bg text-source-dnshe-fg">
                            DNSHE
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-source-cf-bg text-source-cf-fg">
                            Cloudflare
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-source-dp-bg text-source-dp-fg">
                            DigitalPlat
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <p className="text-[11px] text-content-muted mt-4 leading-relaxed">
              对比度由项目根的 <span className="font-mono">contrast-check.mjs</span> 脚本机械校验
              （WCAG 2.1 相对亮度公式，含半透明底色的合成），108 项配对全量跑一遍。
              三套主题 × 明暗共 6 个组合现已<b className="text-content-secondary">全部 ≥ 4.5:1</b>。
              靛蓝主题的 accent 系列原先不达标（于 bg-base 4.08:1、暗色 bg-elevated 上仅 3.50:1），
              修复时保持色相不变、只调明度与饱和度 —— 你看到的仍是同一个靛蓝。
            </p>
          </Card>
        </Section>

        {/* ── 令牌 ── */}
        <Section
          title="色彩令牌 · 状态语义"
          desc="组件不直接使用具体色阶，一律引用语义名。改品牌色只需动 index.css 一处。每对 bg/fg 组合的对比度均 ≥ 4.5:1。"
        >
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Swatch name="ok 正常" varName="--state-ok-*" className="bg-state-ok-bg border-state-ok-border" />
            <Swatch name="warn 警告" varName="--state-warn-*" className="bg-state-warn-bg border-state-warn-border" />
            <Swatch name="danger 危险" varName="--state-danger-*" className="bg-state-danger-bg border-state-danger-border" />
            <Swatch name="info 提示" varName="--state-info-*" className="bg-state-info-bg border-state-info-border" />
            <Swatch name="idle 中性" varName="--state-idle-*" className="bg-state-idle-bg border-state-idle-border" />
          </div>
        </Section>

        <Section
          title="色彩令牌 · 服务商来源"
          desc="跨源搜索、侧栏 badge、域名卡片共用同一套来源色，让「这条数据来自哪」成为可扫读的视觉锚点。"
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Swatch name="DNSHE" varName="--source-dnshe-*" className="bg-source-dnshe-bg" />
            <Swatch name="Cloudflare" varName="--source-cf-*" className="bg-source-cf-bg" />
            <Swatch name="DigitalPlat" varName="--source-dp-*" className="bg-source-dp-bg" />
            <Swatch name="自定义" varName="--source-custom-*" className="bg-source-custom-bg" />
          </div>
        </Section>

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
              <Button variant="primary" loading={loadingDemo} onClick={runLoadingDemo}>
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

        {/* ── 卡片 ── */}
        <Section
          title="Card · 三档高度与骨架屏"
          desc="elevation 表达层级：flat 用于嵌套、default 用于信息容器、raised 用于可点击卡片。骨架屏保留内容将出现的位置，感知等待短于 spinner，且避免布局跳动。"
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            <Card elevation="flat" padding="lg">
              <span className="text-xs font-semibold text-content-primary">flat</span>
              <p className="text-[11px] text-content-muted mt-1">无阴影，嵌套在卡片内使用</p>
            </Card>
            <Card elevation="default" padding="lg">
              <span className="text-xs font-semibold text-content-primary">default</span>
              <p className="text-[11px] text-content-muted mt-1">轻阴影，信息容器默认档</p>
            </Card>
            <Card elevation="raised" padding="lg" interactive onClick={() => window.alert("卡片可点击")}>
              <span className="text-xs font-semibold text-content-primary">raised</span>
              <p className="text-[11px] text-content-muted mt-1">可点击，支持键盘 Enter</p>
            </Card>
          </div>

          <Card padding="none" className="mb-4">
            <CardHeader>
              <span className="text-xs font-semibold text-content-primary">复合卡片</span>
              <Badge tone="ok">active</Badge>
            </CardHeader>
            <CardBody>
              <p className="text-xs text-content-secondary">
                CardHeader / CardBody / CardFooter 提供统一的内边距与分隔线，
                替代调用处手写 px-4 py-3 border-b。
              </p>
            </CardBody>
            <CardFooter>
              <span className="text-[11px] text-content-muted">共 24 个 zone</span>
              <Button variant="ghost" size="xs">查看详情</Button>
            </CardFooter>
          </Card>

          <Card padding="lg">
            <p className="text-[11px] text-content-muted mb-3">骨架屏</p>
            <Skeleton variant="title" width="35%" className="mb-3" />
            <Skeleton variant="text" lines={3} />
          </Card>
        </Section>

        {/* ── 表单 ── */}
        <Section
          title="Field · 表单语义"
          desc="label 的 htmlFor 自动关联、错误提示自动接 aria-describedby、必填自动加 aria-required —— 只要用 Field 包住输入框，这三件事都不需要调用方记。"
        >
          <Card padding="lg">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <Field
                label="账号别名"
                required
                hint="用于在账号列表中区分不同凭据"
              >
                <input
                  className="form-input px-3 py-2 rounded-md text-sm w-full"
                  placeholder="例如：主力账号"
                />
              </Field>

              <Field
                label="API Key"
                hint="在服务商控制台创建，绑定后加密存储"
              >
                <input
                  className="form-input px-3 py-2 rounded-md text-sm w-full font-mono"
                  placeholder="cf_xxxxxxxxxxxx"
                />
              </Field>

              <Field
                label="到期阈值（天）"
                required
                hint="剩余天数低于此值即触发提醒"
              >
                <input
                  type="number"
                  defaultValue={90}
                  className="form-input px-3 py-2 rounded-md text-sm w-full"
                />
              </Field>

              <Field
                label="实时校验演示"
                required
                error={formError}
                hint={formError ? undefined : "输入少于 3 个字符会触发错误态"}
              >
                <input
                  className="form-input px-3 py-2 rounded-md text-sm w-full"
                  placeholder="试着输入 1-2 个字符"
                  value={formValue}
                  onChange={(e) => validateDemo(e.target.value)}
                />
              </Field>

              <Field label="成功态演示" success="Token 校验通过，账号名已自动识别">
                <input
                  className="form-input px-3 py-2 rounded-md text-sm w-full"
                  defaultValue="cf_token_valid"
                />
              </Field>

              <Field label="服务商">
                <CustomSelect
                  value={providerDemo}
                  onChange={setProviderDemo}
                  ariaLabel="服务商"
                  options={[
                    { value: "dnshe", label: "DNSHE" },
                    { value: "cloudflare", label: "Cloudflare" },
                    { value: "digitalplat", label: "DigitalPlat" },
                    { value: "custom", label: "自定义" },
                  ]}
                  className="px-3 py-2 rounded-md text-sm w-full"
                />
              </Field>
            </div>
          </Card>
        </Section>

        {/* ── Input / Textarea ── */}
        <Section
          title="Input / Textarea · 输入控件"
          desc="form-input 皮肤 + 尺寸 + 状态收敛为组件。宽度由调用处 className 决定（不自带 w-full），文字色也由调用处表达 —— 迁移存量 <input> 时逐字保留原 class，零视觉漂移。"
        >
          <Card padding="lg">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <Field label="Input · md（默认）" hint="全站默认档：px-3 py-2.5">
                <Input className="w-full" placeholder="账号别名" />
              </Field>

              <Field label="Input · sm" hint="密集表单 / 弹窗：px-3 py-2">
                <Input size="sm" className="w-full" placeholder="搜索" />
              </Field>

              <Field label="Input · mono" hint="等宽字体，用于 API Key / 域名">
                <Input mono className="w-full" placeholder="cf_xxxxxxxxxxxx" />
              </Field>

              <Field label="Input · invalid" error="该字段不能为空">
                <Input invalid className="w-full" defaultValue="" placeholder="校验失败态" />
              </Field>

              <Field label="Textarea · md" hint="默认 resize-none，与存量批量文本框一致">
                <Textarea className="w-full" rows={3} placeholder="每行一条记录" />
              </Field>

              <Field label="Textarea · mono 可拖拽" hint="resizable 打开纵向拖拽">
                <Textarea mono resizable className="w-full" rows={3} placeholder={"example.com\nwww.example.com"} />
              </Field>
            </div>
          </Card>
        </Section>

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

        <footer className="pt-6 border-t border-border-base text-[11px] text-content-muted">
          Domain Hub 设计系统 · 组件层建于既有语义变量之上，未改动任何业务逻辑
        </footer>
      </div>
    </div>
  );
}
