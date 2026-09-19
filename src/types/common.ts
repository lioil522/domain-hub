export type ID = string;

export interface Timestamped {
  createdAt?: string;
  updatedAt?: string;
}

export interface OperationResult<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  errorCode?: string;
}
