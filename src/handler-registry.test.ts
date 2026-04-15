import { HandlerRegistry } from './handler-registry';

describe('HandlerRegistry', () => {
  it('registers and looks up a handler', async () => {
    const r = new HandlerRegistry();
    const fn = jest.fn(async () => 'ok');
    r.register('sendReport', fn);
    const result = await r.invoke('sendReport', { a: 1 }, { tenantId: 't1' });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledWith({ a: 1 }, { tenantId: 't1' });
  });

  it('throws handler_not_found for unknown jobType', async () => {
    const r = new HandlerRegistry();
    await expect(r.invoke('missing', {}, {})).rejects.toMatchObject({
      code: 'jobs_handler_not_found',
    });
  });

  it('rejects duplicate registration for same jobType', () => {
    const r = new HandlerRegistry();
    r.register('x', async () => null);
    expect(() => r.register('x', async () => null)).toThrow(/already/);
  });
});
