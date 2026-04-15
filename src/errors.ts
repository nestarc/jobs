export const JobsErrorCode = {
  ReservedPayloadKey: 'jobs_reserved_payload_key',
  HandlerNotFound: 'jobs_handler_not_found',
  QueueNotFound: 'jobs_queue_not_found',
  FairnessMisconfig: 'jobs_fairness_misconfig',
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
