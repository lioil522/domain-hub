import { LogRepository } from "../repositories/log-repository";

export class LogService {
  constructor(private readonly repository: LogRepository) {}
  write(type: Parameters<LogRepository["write"]>[0], category: Parameters<LogRepository["write"]>[1], message: string, details?: unknown) {
    return this.repository.write(type, category, message, details);
  }
  list(limit = 100, categories?: string[]) { return this.repository.list(limit, categories); }
  clear() { return this.repository.clear(); }
}
