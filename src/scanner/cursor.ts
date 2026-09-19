export interface ScannerCursor<T = string> {
  value: T;
  updatedAt: string;
}

export function createCursor<T>(value: T): ScannerCursor<T> {
  return { value, updatedAt: new Date().toISOString() };
}

export function advanceCursor<T>(cursor: ScannerCursor<T>, value: T): ScannerCursor<T> {
  return createCursor(value);
}
