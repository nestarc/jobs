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
import { JobsError, JobsErrorCode } from './errors';

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
  private readonly ticks = new Set<Promise<boolean>>();
  private readonly invocations = new Set<string>();

  outstandingJobIds(): string[] {
    return [...this.invocations];
  }

  async waitForIdle(): Promise<void> {
    while (this.ticks.size) await Promise.all([...this.ticks]);
  }

  constructor(private readonly opts: FairWorkerOptions) {
    if (!opts.backend.capabilities().activationFencing) {
      throw new JobsError(
        JobsErrorCode.CapabilityUnsupported,
        'FairWorker requires activation fencing',
      );
    }
  }

  tick(): Promise<boolean> {
    const tick = this.runTick();
    this.ticks.add(tick);
    void tick.then(
      () => this.ticks.delete(tick),
      () => this.ticks.delete(tick),
    );
    return tick;
  }

  private async runTick(): Promise<boolean> {
    const picked = this.opts.scheduler.pickNext();
    if (!picked) return false;

    this.invocations.add(picked.jobId);
    try {
      return await this.execute(picked);
    } finally {
      this.invocations.delete(picked.jobId);
    }
  }

  private async execute(picked: { jobId: string; tenantId: string }): Promise<boolean> {
    const envelope = await this.opts.backend.moveToActive(this.opts.jobType, picked.jobId);
    if (!envelope) {
      this.opts.scheduler.onAck(picked.jobId);
      const record = await this.opts.backend.getJob(picked.jobId);
      if (
        record?.status === 'queued' ||
        record?.status === 'delayed' ||
        record?.status === 'retrying'
      ) {
        this.opts.scheduler.onEnqueue(picked.jobId, picked.tenantId, {
          scheduledFor: record.nextAttemptAt ?? record.scheduledFor,
        });
      }
      return false;
    }

    const activationId = envelope.activationId;
    if (!activationId) {
      throw new JobsError(
        JobsErrorCode.CapabilityUnsupported,
        'FairWorker requires activation fencing',
      );
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
    let timedOut = false;
    const timeoutError = Object.assign(new Error('timeout'), { reason: 'timeout' });
    if (envelope.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        notifyLifecycleObserver(() =>
          this.opts.events?.onEvent?.({
            type: 'job.timed_out',
            jobId: picked.jobId,
            jobType: this.opts.jobType,
            tenantId: picked.tenantId,
            attempt: envelope.attempts,
            at: new Date(),
            error: { message: 'timeout', reason: 'timeout' },
            metadata: snapshotLifecycleValue(envelope.metadata),
          }),
        );
        controller.abort();
      }, envelope.timeoutMs);
    }
    // Abort is cooperative. Keep ownership until the actual invocation settles.
    const work = invoke.then(
      (value) => {
        if (timedOut) throw timeoutError;
        return value;
      },
      (error) => {
        throw timedOut ? timeoutError : error;
      },
    );

    try {
      await work;
      const finishedAt = new Date();
      try {
        await this.opts.backend.ack(this.opts.jobType, picked.jobId, activationId);
      } catch (err) {
        if (!(err instanceof JobsError) || err.code !== JobsErrorCode.ActivationConflict) throw err;
        this.opts.scheduler.onAck(picked.jobId);
        return true;
      }
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
      let record;
      try {
        record = await this.opts.backend.fail(
          this.opts.jobType,
          picked.jobId,
          reason,
          activationId,
        );
      } catch (failure) {
        if (!(failure instanceof JobsError) || failure.code !== JobsErrorCode.ActivationConflict)
          throw failure;
        this.opts.scheduler.onAck(picked.jobId);
        return true;
      }
      this.opts.scheduler.onAck(picked.jobId);
      if (
        record?.status === 'queued' ||
        record?.status === 'delayed' ||
        record?.status === 'retrying'
      ) {
        this.opts.scheduler.onEnqueue(picked.jobId, picked.tenantId, {
          scheduledFor: record.nextAttemptAt ?? record.scheduledFor,
        });
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
    }
  }

  private eventTypeForFailure(status: string | undefined): JobLifecycleEventType {
    if (status === 'queued' || status === 'delayed' || status === 'retrying') {
      return 'job.retry_scheduled';
    }
    if (status === 'dead_letter') return 'job.dead_lettered';
    return 'job.failed';
  }
}
