require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { BullMQBackend, JobsModule, JobsService } = require('../../dist');
(async () => {
  const url = new URL(process.env.REDIS_URL);
  const backend = new BullMQBackend({ namespace: process.env.JOBS_NAMESPACE, connection: { host: url.hostname, port: Number(url.port) } });
  const app = await Test.createTestingModule({ imports: [JobsModule.forBullMQ({ backend, jobTypes: ['role'], role: 'producer' })] }).compile();
  await app.init();
  const id = await app.get(JobsService).enqueue('role', { from: 'producer' });
  process.send({ id });
  process.on('message', async (message) => {
    if (message === 'close') { await app.close(); process.disconnect(); }
  });
})().catch((error) => { process.send?.({ error: error.stack }); process.exitCode = 1; process.disconnect?.(); });
