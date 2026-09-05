import { assertPositiveInteger } from './enqueue-validation';

/** Shared by all type schedulers in one in-memory module. */
export class ExecutionBudget {
  private total = 0;
  private readonly tenants = new Map<string | symbol, number>();
  private readonly system = Symbol('system shard');

  constructor(
    readonly poolSize: number,
    private readonly tenantCap: number,
  ) {
    assertPositiveInteger(poolSize, 'concurrency.poolSize');
    assertPositiveInteger(tenantCap, 'concurrency.tenantCap');
  }

  canAcquire(tenantId: string | undefined): boolean {
    return (
      this.total < this.poolSize &&
      (this.tenants.get(tenantId ?? this.system) ?? 0) < this.tenantCap
    );
  }

  acquire(tenantId: string | undefined): void {
    const key = tenantId ?? this.system;
    this.total++;
    this.tenants.set(key, (this.tenants.get(key) ?? 0) + 1);
  }

  release(tenantId: string | undefined): void {
    const key = tenantId ?? this.system;
    const count = this.tenants.get(key) ?? 0;
    if (!count) return;
    this.total--;
    if (count === 1) this.tenants.delete(key);
    else this.tenants.set(key, count - 1);
  }
}
