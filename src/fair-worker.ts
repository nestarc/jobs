import type { JobsBackend } from './backend/jobs-backend.interface';
import type { Scheduler } from './scheduler';
import type { HandlerRegistry } from './handler-registry';
import type { JobContext, JobEvent } from './types';
import type { JobEventsOptions, JobLifecycleEventType } from './lifecycle';
import {
  notifyLifecycleObserver,
  snapshotLifecycleError,
  snapshotLifecycleValue,
} from './lifecycle-observer';
import { normalizeError } from './error-utils';

export interface FairWorkerOptions {
  jobType: string;
  backend: JobsBackend;
  scheduler: Scheduler;
  registry: HandlerRegistry;
  contextRunner: (ctx: JobContext, fn: () => Promise<unknown>) => Promise<unknown>;
  onStart?: (e: JobEvent) => void;
  onFinish?: (e: JobEvent) => void;
  onFail?: (e: JobEvent, err: Error) => void;
  events?: JobEventsOptions;
}

export class FairWorker {
  constructor(private readonly opts: FairWorkerOptions) {}

  async tick(): Promise<boolean> {
    const picked = this.opts.scheduler.pickNext();
    if (!picked) return false;

    const envelope = await this.opts.backend.moveToActive(this.opts.jobType, picked.jobId);
    if (!envelope) {
      this.opts.scheduler.onAck(picked.jobId);
      const record = await this.opts.backend.getJob(picked.jobId);
      if (record?.status === 'queued' || record?.status === 'delayed') {
        this.opts.scheduler.onEnqueue(picked.jobId, picked.tenantId);
      }
      return false;
    }

    const startedAt = new Date();
    const event: JobEvent = {
      jobId: picked.jobId,
      jobType: this.opts.jobType,
      tenantId: picked.tenantId,
      startedAt,
      attempt: envelope.attempts,
    };
    notifyLifecycleObserver(() => this.opts.onStart?.(snapshotLifecycleValue(event)));
    notifyLifecycleObserver(() =>
      this.opts.events?.onEvent?.(
        snapshotLifecycleValue({
          type: 'job.started',
          jobId: picked.jobId,
          jobType: this.opts.jobType,
          tenantId: picked.tenantId,
          attempt: envelope.attempts,
          at: startedAt,
          metadata: envelope.metadata,
        }),
      ),
    );

    const controller = new AbortController();
    const executionContext = { ...envelope.context };
    Object.defineProperty(executionContext, 'signal', {
      value: controller.signal,
      enumerable: false,
      configurable: true,
    });
    let timeout: NodeJS.Timeout | undefined;
    const invoke = Promise.resolve().then(() =>
      this.opts.contextRunner(executionContext, () =>
        this.opts.registry.invoke(
          this.opts.jobType,
          envelope.payload as Record<string, unknown>,
          executionContext,
        ),
      ),
    );
    const work = envelope.timeoutMs
      ? Promise.race([
          invoke,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              const err = new Error('timeout');
              (err as Error & { reason?: string }).reason = 'timeout';
              reject(err);
            }, envelope.timeoutMs);
          }),
        ])
      : invoke;

    try {
      await work;
      const finishedAt = new Date();
      await this.opts.backend.ack(this.opts.jobType, picked.jobId);
      this.opts.scheduler.onAck(picked.jobId);
      notifyLifecycleObserver(() =>
        this.opts.onFinish?.(
          snapshotLifecycleValue({
            ...event,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
          }),
        ),
      );
      notifyLifecycleObserver(() =>
        this.opts.events?.onEvent?.({
          type: 'job.succeeded',
          jobId: picked.jobId,
          jobType: this.opts.jobType,
          tenantId: picked.tenantId,
          attempt: envelope.attempts,
          at: finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          metadata: snapshotLifecycleValue(envelope.metadata),
        }),
      );
      return true;
    } catch (err) {
      const error = normalizeError(err);
      const reason = (error as Error & { reason?: string }).reason ?? error.message;
      const record = await this.opts.backend.fail(this.opts.jobType, picked.jobId, reason);
      this.opts.scheduler.onAck(picked.jobId);
      if (record?.status === 'queued' || record?.status === 'delayed') {
        this.opts.scheduler.onEnqueue(picked.jobId, picked.tenantId);
      }
      notifyLifecycleObserver(() =>
        this.opts.onFail?.(snapshotLifecycleValue(event), snapshotLifecycleError(error)),
      );
      notifyLifecycleObserver(() =>
        this.opts.events?.onEvent?.({
          type: this.eventTypeForFailure(record?.status),
          jobId: picked.jobId,
          jobType: this.opts.jobType,
          tenantId: picked.tenantId,
          attempt: envelope.attempts,
          at: new Date(),
          error: snapshotLifecycleValue(record?.error ?? { message: reason }),
          metadata: snapshotLifecycleValue(envelope.metadata),
        }),
      );
      return true;
    } finally {
      if (timeout) clearTimeout(timeout);
      invoke.catch(() => undefined);
    }
  }

  private eventTypeForFailure(status: string | undefined): JobLifecycleEventType {
    if (status === 'queued' || status === 'delayed') return 'job.retry_scheduled';
    if (status === 'dead_letter') return 'job.dead_lettered';
    return 'job.failed';
  }
}
