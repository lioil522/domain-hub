import type { ScannerJobModel } from "../../types/scanner";
import { ScannerRepository } from "../../repositories/scanner-repository";
export class ScannerJobStore {
  constructor(private readonly repository: ScannerRepository) {}
  get(id: string) { return this.repository.get(id); }
  save(job: ScannerJobModel) { return this.repository.save(job); }
  list(limit = 50) { return this.repository.list(limit); }
}
