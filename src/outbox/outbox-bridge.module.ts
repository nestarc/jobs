import type { JobsService } from '../jobs.service';

export interface OutboxEvent {
  type: string;
  payload: Record<string, unknown>;
  tenantId: string;
}

export interface OutboxSource {
  onEvent(cb: (event: OutboxEvent) => Promise<void>): void;
}

export interface JobsOutboxBridgeOptions {
  jobs: JobsService;
  source: OutboxSource;
  map: Record<string, string>;
  tenantFrom?: (event: OutboxEvent) => string;
}

/** @deprecated Compatibility-only bridge without source identity/lineage. Use createOutboxJobsPublisher for first-party Outbox. */
export class JobsOutboxBridge {
  constructor(private readonly opts: JobsOutboxBridgeOptions) {
    opts.source.onEvent(async (event) => this.dispatch(event));
  }

  private async dispatch(event: OutboxEvent): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(this.opts.map, event.type)) return;
    const jobType = this.opts.map[event.type];
    if (!jobType) return;
    const tenantId = this.opts.tenantFrom?.(event) ?? event.tenantId;
    await this.opts.jobs.enqueue(jobType, event.payload, { context: { tenantId } });
  }
}
