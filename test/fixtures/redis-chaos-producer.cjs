const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const { BullMQBackend } = require('../../dist');
const url = new URL(process.env.REDIS_URL);
const connection = { host: url.hostname, port: Number(url.port) };
const namespace = process.env.JOBS_NAMESPACE;
const phase = process.env.JOBS_CHAOS_PHASE;
const park = () => new Promise(() => {});
(async () => {
  if (phase === 'active-worker') {
    new Worker(`${namespace}.job`, async () => { process.send({ phase }); await park(); }, { connection, lockDuration: 500, stalledInterval: 200 });
    return;
  }
  if (phase === 'after-add') {
    const add = Queue.prototype.add;
    Queue.prototype.add = async function (...args) { const result = await add.apply(this, args); process.send({ phase, id: result.id }); await park(); };
  } else {
    const evaluate = Redis.prototype.eval;
    Redis.prototype.eval = async function (...args) {
      if (String(args[0]).includes('for index, key in ipairs(KEYS)')) {
        if (phase === 'after-reserve') await evaluate.apply(this, args);
        process.send({ phase }); await park();
      }
      return evaluate.apply(this, args);
    };
  }
  const backend = new BullMQBackend({ namespace, connection });
  await backend.enqueue('job', {}, { idempotencyKey: 'source', dedupe: { key: 'business' } });
})().catch((error) => { process.send?.({ error: error.stack }); process.exitCode = 1; process.disconnect?.(); });
