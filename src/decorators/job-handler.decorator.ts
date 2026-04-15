import { SetMetadata } from '@nestjs/common';

export const JOB_HANDLER_METADATA = 'nestarc:jobs:handler';

export const JobHandler = (jobType: string): MethodDecorator =>
  SetMetadata(JOB_HANDLER_METADATA, jobType);
