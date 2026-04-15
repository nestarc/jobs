import type { JobContext } from './types';

export const defaultContextExtractor = (): JobContext => ({});

export const defaultContextRunner = async (
  _ctx: JobContext,
  fn: () => Promise<unknown>,
): Promise<unknown> => fn();
