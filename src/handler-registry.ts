import { JobsError, JobsErrorCode } from './errors';
import type { JobContext } from './types';

export type HandlerFn = (
  payload: Record<string, unknown>,
  context: JobContext,
) => Promise<unknown>;

export class HandlerRegistry {
  private readonly handlers = new Map<string, HandlerFn>();

  register(jobType: string, handler: HandlerFn): void {
    if (this.handlers.has(jobType)) {
      throw new Error(`handler for ${jobType} already registered`);
    }
    this.handlers.set(jobType, handler);
  }

  async invoke(
    jobType: string,
    payload: Record<string, unknown>,
    context: JobContext,
  ): Promise<unknown> {
    const handler = this.handlers.get(jobType);
    if (!handler) throw new JobsError(JobsErrorCode.HandlerNotFound, jobType);
    return handler(payload, context);
  }

  list(): string[] {
    return [...this.handlers.keys()];
  }
}
