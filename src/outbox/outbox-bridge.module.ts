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

export class JobsOutboxBridge {
  constructor(private readonly opts: JobsOutboxBridgeOptions) {
    opts.source.onEvent(async (event) => this.dispatch(event));
  }

  private async dispatch(event: OutboxEvent): Promise<void> {
    const jobType = this.opts.map[event.type];
    if (!jobType) return;
    const tenantId = this.opts.tenantFrom?.(event) ?? event.tenantId;
    await this.opts.jobs.enqueue(jobType, event.payload, { context: { tenantId } });
  }
}
