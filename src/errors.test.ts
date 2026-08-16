import { JobsError, JobsErrorCode } from './errors';

describe('JobsError', () => {
  it('reserved payload key carries its code', () => {
    const err = new JobsError(JobsErrorCode.ReservedPayloadKey);
    expect(err.code).toBe('jobs_reserved_payload_key');
  });

  it('preserves optional reason', () => {
    const err = new JobsError(JobsErrorCode.HandlerNotFound, 'sendReport');
    expect(err.message).toContain('sendReport');
  });

  it('supports the public error codes', () => {
    expect(new JobsError(JobsErrorCode.ReservedPayloadKey).code).toBe('jobs_reserved_payload_key');
    expect(new JobsError(JobsErrorCode.HandlerNotFound).code).toBe('jobs_handler_not_found');
    expect(new JobsError(JobsErrorCode.QueueNotFound).code).toBe('jobs_queue_not_found');
    expect(new JobsError(JobsErrorCode.FairnessMisconfig).code).toBe('jobs_fairness_misconfig');
    expect(new JobsError(JobsErrorCode.CapabilityUnsupported).code).toBe(
      'jobs_capability_unsupported',
    );
    expect(new JobsError(JobsErrorCode.BackendClosed).code).toBe('jobs_backend_closed');
    expect(new JobsError(JobsErrorCode.IdentityConflict).code).toBe('jobs_identity_conflict');
  });
});
