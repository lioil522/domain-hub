/**
 * 自定义平台 DNS Provider 适配器
 *
 * NOTE: 自定义平台账号仅支持手动记录信息，不支持通过统一上游 API 读写 DNS 记录。
 */

import type { DnsProviderAdapter, DnsProviderContext } from "./types";
import type { DnsRecordInput } from "../../types/dns";

export class CustomDnsAdapter implements DnsProviderAdapter {
  async listRecords(_context: DnsProviderContext) {
    return { success: false, records: [], message: "自定义服务商不支持在线管理 DNS 记录" };
  }

  async createRecord(_context: DnsProviderContext, _input: DnsRecordInput) {
    return { success: false, message: "自定义服务商不支持在线管理 DNS 记录" };
  }

  async updateRecord(_context: DnsProviderContext, _recordId: string, _input: DnsRecordInput) {
    return { success: false, message: "自定义服务商不支持在线管理 DNS 记录" };
  }

  async deleteRecord(_context: DnsProviderContext, _recordId: string) {
    return { success: false, message: "自定义服务商不支持在线管理 DNS 记录" };
  }
}
