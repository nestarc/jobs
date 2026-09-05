export const JobsErrorCode = {
  ReservedPayloadKey: 'jobs_reserved_payload_key',
  HandlerNotFound: 'jobs_handler_not_found',
  QueueNotFound: 'jobs_queue_not_found',
  FairnessMisconfig: 'jobs_fairness_misconfig',
  CapabilityUnsupported: 'jobs_capability_unsupported',
  BackendClosed: 'jobs_backend_closed',
  ActivationConflict: 'jobs_activation_conflict',
  ShutdownIncomplete: 'jobs_shutdown_incomplete',
  IdentityConflict: 'jobs_identity_conflict',
} as const;

export type JobsErrorCode = (typeof JobsErrorCode)[keyof typeof JobsErrorCode];

export class JobsError extends Error {
  readonly code: JobsErrorCode;

  constructor(code: JobsErrorCode, reason?: string) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = 'JobsError';
    this.code = code;
  }
}

/** Shutdown did not complete; admission remains closed and records are retained. */
export class JobsShutdownError extends JobsError {
  readonly remainingJobIds: readonly string[];
  readonly remainingCount: number;

  constructor(
    readonly reason: 'deadline' | 'pending_jobs' | 'worker_error',
    jobIds: readonly string[],
    cause?: unknown,
  ) {
    const ids = [...new Set(jobIds)];
    super(JobsErrorCode.ShutdownIncomplete, `${reason}: ${ids.length} job(s) remain`);
    this.name = 'JobsShutdownError';
    this.remainingJobIds = Object.freeze(ids);
    this.remainingCount = ids.length;
    this.cause = cause;
  }
}
