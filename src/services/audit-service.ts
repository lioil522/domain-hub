import { AuditRepository, type AuditRecord } from "../repositories/audit-repository";

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}
  write(record: AuditRecord) { return this.repository.write(record); }
  list(limit = 100) { return this.repository.list(limit); }
}
