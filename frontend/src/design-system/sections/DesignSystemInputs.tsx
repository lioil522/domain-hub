import { Badge, Button, Card, CardBody, CardFooter, CardHeader, CustomSelect, Field, Input, Skeleton, Textarea } from "../../components";
import { Section } from "../primitives";

export interface DesignSystemInputsProps {
  formValue: string;
  formError: string | null;
  onValidateDemo: (value: string) => void;
  providerDemo: string;
  setProviderDemo: (value: string) => void;
}

export function DesignSystemInputs(props: DesignSystemInputsProps) {
  const { formValue, formError, onValidateDemo, providerDemo, setProviderDemo } = props;
  return (
    <>
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
                  onChange={(e) => onValidateDemo(e.target.value)}
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
    </>
  );
}
