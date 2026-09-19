import type { DatabaseManager } from "../db";
import { ScannerRepository } from "../repositories/scanner-repository";
import type { ScannerJobModel, ScannerJobStatus } from "../types/scanner";

const VALID_STATUSES = new Set<ScannerJobStatus>(["created", "running", "paused", "completed", "failed"]);

export class ScannerService {
  constructor(private readonly repository: ScannerRepository) {}

  async create(id = crypto.randomUUID(), cursor = ""): Promise<ScannerJobModel> {
    const job: ScannerJobModel = {
      id,
      status: "created",
      cursor,
      totalChecked: 0,
      available: 0,
      registered: 0,
      failed: 0,
      startedAt: new Date().toISOString(),
    };
    await this.repository.save(job);
    return job;
  }

  get(id: string) { return this.repository.get(id); }
  list(limit = 50) { return this.repository.list(limit); }

  async update(id: string, patch: Partial<ScannerJobModel>) {
    const current = await this.repository.get(id);
    if (!current) throw new Error(`Scanner job ${id} not found`);
    if (patch.status && !VALID_STATUSES.has(patch.status)) throw new Error(`Invalid scanner status: ${String(patch.status)}`);
    const next: ScannerJobModel = {
      ...current,
      ...patch,
      totalChecked: patch.totalChecked == null ? current.totalChecked : Math.max(0, Number(patch.totalChecked)),
      available: patch.available == null ? current.available : Math.max(0, Number(patch.available)),
      registered: patch.registered == null ? current.registered : Math.max(0, Number(patch.registered)),
      failed: patch.failed == null ? current.failed : Math.max(0, Number(patch.failed)),
      updatedAt: new Date().toISOString(),
    };
    await this.repository.save(next);
    return next;
  }

  async pause(id: string) { return this.update(id, { status: "paused" }); }
  async resume(id: string) { return this.update(id, { status: "running" }); }
}

export function scannerService(db: DatabaseManager) { return new ScannerService(new ScannerRepository(db)); }
