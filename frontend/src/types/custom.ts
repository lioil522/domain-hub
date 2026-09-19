/** 自定义服务商（无 API）的账号（归属某个分组） */
export interface CustomAccount {
  id: number;
  group_id: number;
  name: string;
  updated_at: string;
}

/** 自定义服务商（无 API）手动录入的域名（归属某个账号，或直接挂在分组下） */
export interface CustomDomain {
  id: number;
  group_id: number;
  account_id: number | null;
  full_domain: string;
  /** 注册时间（YYYY-MM-DD，null=未填，公益域名常查不到） */
  registered_at: string | null;
  expires_at: string;
  remark: string | null;
  updated_at: string;
}
