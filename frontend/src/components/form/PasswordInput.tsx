import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

/**
 * 带「显示 / 隐藏」小眼睛的密码输入框
 *
 * 用在所有 type="password" 的位置（登录、初始化、修改密码、API Secret），
 * 让用户能自查手输 / 粘贴的内容，省掉「输了两遍还是不匹配」的来回。
 *
 * NOTE: 必须定义在 App() 外面。若写成 App 内部的组件，App 每次重渲染都会生成
 * 新的组件类型，React 会卸载重挂载整棵子树 —— 明暗态会被重置，输入框还会丢焦点。
 *
 * NOTE: 眼睛按钮一定要写 type="button"。登录页与初始化表单是真 <form onSubmit>，
 * button 默认 type="submit"，点一下眼睛就会顺手把表单提交掉。
 *
 * NOTE: name / autoComplete 一律原样透传给 input，不在这里加工。本项目为了压制
 * Chrome 的凭据预填，刻意把修改密码的三个框都标成 new-password、并给 name 取了
 * 不像 username 的值（见「修改登录密码」处的注释），组件替调用处改写会破坏这套约定。
 */
export const PasswordInput: React.FC<{
  value: string;
  onChange: (value: string) => void;
  className: string;
  placeholder?: string;
  name?: string;
  autoComplete?: string;
  required?: boolean;
  /** 供外层 <label htmlFor> 关联（a11y）：原样透传给内部 input 的 id。
      本组件是「输入框 + 眼睛按钮」的组合，外层 label 只有通过这个 id
      才能与真正的输入框建立程序化关联。 */
  id?: string;
  /** 无障碍名称（a11y）：用于没有外层 label 可关联、只能直接给名字的调用处。 */
  ariaLabel?: string;
}> = ({ value, onChange, className, placeholder, name, autoComplete, required, id, ariaLabel }) => {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        /* 明文态切成 type="text"；pr-10 给右侧眼睛让位，避免长密码钻到图标底下。
           Tailwind 生成的 CSS 里 pr-* 排在 px-* 之后，所以能盖住调用处的 px-3 / px-3.5 */
        type={visible ? "text" : "password"}
        name={name}
        id={id}
        aria-label={ariaLabel}
        autoComplete={autoComplete}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${className} pr-10`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        /* 命中区撑满输入框高度，窄屏上也够点 */
        className="absolute inset-y-0 right-0 px-3 flex items-center text-content-muted hover:text-content-primary transition-colors"
        title={visible ? "隐藏密码" : "显示密码"}
        aria-label={visible ? "隐藏密码" : "显示密码"}
      >
        {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
};
