export function assertValidJobId(jobId: unknown): void {
  if (jobId === undefined) return;
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw new TypeError('jobId must be a non-empty string');
  }
}
