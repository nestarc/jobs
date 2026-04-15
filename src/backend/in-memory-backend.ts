import { randomUUID } from 'node:crypto';
import { detachContext } from '../context-serializer';
import type { JobsBackend } from './jobs-backend.interface';
import type { EnqueueOptions, JobEnvelope } from '../types';

interface Slot {
  envelope: JobEnvelope;
  state: 'waiting' | 'active' | 'done' | 'failed';
}

export class InMemoryBackend implements JobsBackend {
  private readonly store = new Map<string, Map<string, Slot>>();

  async enqueue(
    jobType: string,
    envelope: Record<string, unknown>,
    opts: EnqueueOptions,
  ): Promise<string> {
    const { payload, context } = detachContext(envelope);
    const id = opts.jobId ?? randomUUID();
    const bucket = this.bucketOf(jobType);
    bucket.set(id, {
      state: 'waiting',
      envelope: {
        id,
        jobType,
        payload,
        context,
        enqueuedAt: new Date(),
        attempts: 0,
      },
    });
    return id;
  }

  async peekWaiting(jobType: string): Promise<JobEnvelope[]> {
    return [...this.bucketOf(jobType).values()]
      .filter((s) => s.state === 'waiting')
      .map((s) => ({ ...s.envelope }));
  }

  async moveToActive(jobType: string, jobId: string): Promise<JobEnvelope | null> {
    const slot = this.bucketOf(jobType).get(jobId);
    if (!slot || slot.state !== 'waiting') return null;
    slot.state = 'active';
    slot.envelope.attempts += 1;
    return { ...slot.envelope };
  }

  async ack(jobType: string, jobId: string): Promise<void> {
    const slot = this.bucketOf(jobType).get(jobId);
    if (slot) slot.state = 'done';
  }

  async fail(jobType: string, jobId: string, _reason: string): Promise<void> {
    const slot = this.bucketOf(jobType).get(jobId);
    if (slot) slot.state = 'failed';
  }

  async close(): Promise<void> {
    this.store.clear();
  }

  private bucketOf(jobType: string): Map<string, Slot> {
    let bucket = this.store.get(jobType);
    if (!bucket) {
      bucket = new Map();
      this.store.set(jobType, bucket);
    }
    return bucket;
  }
}
