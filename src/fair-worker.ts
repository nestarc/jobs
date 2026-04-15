import type { JobsBackend } from './backend/jobs-backend.interface';
import type { Scheduler } from './scheduler';
import type { HandlerRegistry } from './handler-registry';
import type { JobContext, JobEvent } from './types';

export interface FairWorkerOptions {
  jobType: string;
  backend: JobsBackend;
  scheduler: Scheduler;
  registry: HandlerRegistry;
  contextRunner: (ctx: JobContext, fn: () => Promise<unknown>) => Promise<unknown>;
  onStart?: (e: JobEvent) => void;
  onFinish?: (e: JobEvent) => void;
  onFail?: (e: JobEvent, err: Error) => void;
}

export class FairWorker {
  constructor(private readonly opts: FairWorkerOptions) {}

  async tick(): Promise<boolean> {
    const picked = this.opts.scheduler.pickNext();
    if (!picked) return false;

    const envelope = await this.opts.backend.moveToActive(this.opts.jobType, picked.jobId);
    if (!envelope) {
      this.opts.scheduler.onAck(picked.jobId);
      return false;
    }

    const startedAt = new Date();
    const event: JobEvent = {
      jobId: picked.jobId,
      jobType: this.opts.jobType,
      tenantId: picked.tenantId,
      startedAt,
    };
    this.opts.onStart?.(event);

    try {
      await this.opts.contextRunner(envelope.context, () =>
        this.opts.registry.invoke(
          this.opts.jobType,
          envelope.payload as Record<string, unknown>,
          envelope.context,
        ),
      );
      const finishedAt = new Date();
      await this.opts.backend.ack(this.opts.jobType, picked.jobId);
      this.opts.scheduler.onAck(picked.jobId);
      this.opts.onFinish?.({
        ...event,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
      return true;
    } catch (err) {
      await this.opts.backend.fail(this.opts.jobType, picked.jobId, (err as Error).message);
      this.opts.scheduler.onAck(picked.jobId);
      this.opts.onFail?.(event, err as Error);
      return true;
    }
  }
}
