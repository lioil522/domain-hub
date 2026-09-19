import React from "react";
import { DNS_LINE_OPTIONS } from "../../constants/dns";
import { CustomSelect } from "../form/CustomSelect";

/**
 * 解析线路下拉框
 *
 * NOTE: 不支持线路的域名是「禁用」而不是隐藏 —— 一是保持表单网格对齐，二是上游对
 * 这类域名会静默忽略 line（不报错），不显式拦住的话用户会以为自己设置生效了。
 *
 * 实现：复用通用 CustomSelect（原生 <select> 已由设计系统统一下拉替代）。
 * 不支持线路时只保留「默认」一项并禁用，与替换前的行为完全一致。
 */
export const DnsLineSelect: React.FC<{
  value: string;
  onChange: (value: string) => void;
  supported: boolean;
  className: string;
  disabled?: boolean;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}> = ({ value, onChange, supported, className, disabled, onKeyDown }) => (
  <CustomSelect
    value={supported ? value || "default" : "default"}
    onChange={onChange}
    disabled={disabled || !supported}
    onKeyDown={onKeyDown}
    ariaLabel="解析线路"
    title={
      supported
        ? "不同运营商/地域可选择对应的解析线路，无特殊需求保持默认"
        : "该域名的根域 NS 不在「解析线路支持名单」内（即其 DNS 托管商不提供线路解析），填了也会被上游静默忽略"
    }
    options={supported ? [...DNS_LINE_OPTIONS] : [DNS_LINE_OPTIONS[0]]}
    className={`${className} disabled:opacity-50 disabled:cursor-not-allowed`}
  />
);
