import { snapshotLifecycleError, snapshotLifecycleValue } from './lifecycle-observer';

describe('lifecycle snapshots', () => {
  it('does not execute source functions or accessors through a snapshot', () => {
    const source: {
      value: number;
      nested: { value: string };
      mutate(): void;
      linked?: { value: string };
    } = {
      value: 0,
      nested: { value: 'source' },
      mutate() {
        source.value += 1;
      },
    };
    Object.defineProperty(source, 'linked', {
      enumerable: true,
      configurable: true,
      get: () => source.nested,
      set: (value: { value: string }) => {
        source.nested = value;
      },
    });

    const snapshot = snapshotLifecycleValue(source);

    expect(() => snapshot.mutate()).toThrow('lifecycle snapshot functions are not executable');
    expect(snapshot.linked).toBeUndefined();
    expect(Reflect.set(snapshot, 'linked', { value: 'observer' })).toBe(true);
    expect(source).toMatchObject({ value: 0, nested: { value: 'source' } });
  });

  it('preserves isolated non-enumerable Error diagnostics and cause', () => {
    const cause = new Error('inner');
    const error = new Error('outer', { cause });
    Object.defineProperty(error, 'diagnostic', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: { code: 'E_OUTER' },
    });

    const snapshot = snapshotLifecycleError(error) as Error & {
      cause: Error;
      diagnostic: { code: string };
    };

    expect(snapshot).toBeInstanceOf(Error);
    expect(snapshot).not.toBe(error);
    expect(snapshot.cause).toBeInstanceOf(Error);
    expect(snapshot.cause).not.toBe(cause);
    expect(snapshot.cause.message).toBe('inner');
    expect(Object.getOwnPropertyDescriptor(snapshot, 'diagnostic')?.enumerable).toBe(false);
    snapshot.diagnostic.code = 'changed';
    expect((error as Error & { diagnostic: { code: string } }).diagnostic.code).toBe('E_OUTER');
  });

  it('isolates typed arrays and data views', () => {
    const bytes = new Uint16Array([10, 20]);
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, 42);

    const snapshot = snapshotLifecycleValue({ bytes, view });
    snapshot.bytes[0] = 99;
    snapshot.view.setUint32(0, 7);

    expect(snapshot.bytes).toBeInstanceOf(Uint16Array);
    expect(snapshot.view).toBeInstanceOf(DataView);
    expect([...bytes]).toEqual([10, 20]);
    expect(view.getUint32(0)).toBe(42);
  });
});
