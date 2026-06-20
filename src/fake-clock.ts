export class FakeClock {
  private current: Date;

  constructor(now: Date | string | number = new Date()) {
    this.current = new Date(now);
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceBy(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms);
    return this.now();
  }

  set(next: Date | string | number): Date {
    this.current = new Date(next);
    return this.now();
  }
}
