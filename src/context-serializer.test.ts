import { attachContext, detachContext, CONTEXT_KEY } from './context-serializer';
import { JobsError } from './errors';

describe('attachContext', () => {
  it('embeds context under __nestarcCtx', () => {
    const result = attachContext({ userId: 'u1' }, { tenantId: 't1' });
    expect(result).toEqual({ userId: 'u1', [CONTEXT_KEY]: { tenantId: 't1' } });
  });

  it('rejects payload that already uses reserved key', () => {
    expect(() => attachContext({ [CONTEXT_KEY]: 'x' }, { tenantId: 't1' })).toThrow(JobsError);
  });

  it('handles undefined context as empty', () => {
    const result = attachContext({ a: 1 }, undefined);
    expect(result).toEqual({ a: 1, [CONTEXT_KEY]: {} });
  });
});

describe('detachContext', () => {
  it('returns context and clean payload', () => {
    const envelope = { userId: 'u1', [CONTEXT_KEY]: { tenantId: 't1' } };
    const { payload, context } = detachContext(envelope);
    expect(payload).toEqual({ userId: 'u1' });
    expect(context).toEqual({ tenantId: 't1' });
  });

  it('gives empty context when key missing', () => {
    const { context } = detachContext({ userId: 'u1' });
    expect(context).toEqual({});
  });
});
