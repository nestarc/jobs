'use strict';
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const Redis = require('ioredis');
const { Worker } = require('bullmq');
const { BullMQBackend } = require('../dist');
if (!process.env.REDIS_URL) throw new Error('REDIS_URL must identify a disposable loopback Redis');
const url = new URL(process.env.REDIS_URL);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'chaos requires loopback Redis');
assert.equal(url.pathname.replace('/', ''), '', 'use the disposable Redis default DB');
const connection = { host: url.hostname, port: Number(url.port), maxRetriesPerRequest: null };
const ownedChildren = new Set();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function keys(client, pattern) {
  const found = []; let cursor = '0';
  do { const page = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200); cursor = page[0]; found.push(...page[1]); } while (cursor !== '0');
  return found;
}
function child(namespace, phase) {
  const processChild = fork(path.resolve(__dirname, '../test/fixtures/redis-chaos-producer.cjs'), { env: { ...process.env, JOBS_NAMESPACE: namespace, JOBS_CHAOS_PHASE: phase }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  ownedChildren.add(processChild);
  return processChild;
}
async function kill(processChild) {
  if (processChild.exitCode !== null || processChild.signalCode !== null) return;
  const exited = once(processChild, 'exit'); processChild.kill('SIGKILL'); await exited; ownedChildren.delete(processChild);
}
async function barrier(processChild) {
  let timer;
  try {
    const [message] = await Promise.race([once(processChild, 'message'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('child barrier timeout')), 15000); })]);
    if (message.error) throw new Error(message.error);
    return message;
  } finally { clearTimeout(timer); }
}
async function eventually(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) { try { return await fn(); } catch (error) { if (Date.now() > deadline) throw error; await delay(25); } }
}
async function main() {
  let client = new Redis(connection);
  try {
    for (const phase of (process.env.JOBS_CHAOS_RESTART_ONLY ? [] : ['before-reserve', 'after-reserve', 'after-add'])) {
      const namespace = `chaos-${randomUUID()}`;
      const backend = new BullMQBackend({ namespace, connection }); backend.registerJobTypes(['job']);
      const queue = backend.getRawQueue('job');
      try {
        const producer = child(namespace, phase); const message = await barrier(producer);
        const locks = await keys(client, `*${namespace}*:lock`);
        assert(locks.length > 0, 'producer must actually own Redis leases');
        console.log(JSON.stringify({ phase, pid: producer.pid, barrier: message, leaseTtls: await Promise.all(locks.map((key) => client.pttl(key))) }));
        await kill(producer);
        // Observe real lease expiration. Do not shorten TTL or delete the locks.
        await eventually(async () => { assert((await Promise.all(locks.map((key) => client.exists(key)))).every((n) => n === 0)); }, 65000);
        const options = { idempotencyKey: 'source', dedupe: { key: 'business' } };
        const ids = await Promise.all(Array.from({ length: 4 }, () => backend.enqueue('job', {}, options)));
        assert.equal(new Set(ids).size, 1);
        assert.equal(await queue.getWaitingCount(), 1);
        if (message.id) assert.equal(ids[0], message.id);
        console.log(JSON.stringify({ phase, result: 'PASS', id: ids[0], realLeaseExpiry: true }));
      } finally { await queue.obliterate({ force: true }); await backend.close(); const leftovers = await keys(client, `*${namespace}*`); if (leftovers.length) await client.del(...leftovers); }
    }
    const namespace = `chaos-stalled-${randomUUID()}`;
    const backend = new BullMQBackend({ namespace, connection }); backend.registerJobTypes(['job']);
    const queue = backend.getRawQueue('job'); let replacement;
    try {
      const id = await backend.enqueue('job', {}, { idempotencyKey: 'stalled' });
      const worker = child(namespace, 'active-worker'); await barrier(worker); await kill(worker);
      replacement = new Worker(`${namespace}.job`, async () => 'recovered', { connection, lockDuration: 500, stalledInterval: 200 });
      await eventually(async () => assert.equal((await backend.getJob(id)).status, 'succeeded'), 10000);
      console.log(JSON.stringify({ phase: 'stalled-worker', result: 'PASS', id }));
    } finally { await replacement?.close(); await queue.obliterate({ force: true }); await backend.close(); const leftovers = await keys(client, `*${namespace}*`); if (leftovers.length) await client.del(...leftovers); }
    if (process.env.JOBS_CHAOS_CONTAINER) {
      const container = process.env.JOBS_CHAOS_CONTAINER;
      const project = process.env.JOBS_CHAOS_PROJECT;
      assert(project && project.startsWith('jobs-maintenance-'), 'explicit owned compose project required');
      const actual = execFileSync('docker', ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', container], { encoding: 'utf8' }).trim();
      assert.equal(actual, project);
      const namespace = `chaos-restart-${randomUUID()}`;
      const backend = new BullMQBackend({ namespace, connection }); backend.registerJobTypes(['job']);
      const queue = backend.getRawQueue('job');
      try {
        const id = await backend.enqueue('job', {}, { idempotencyKey: 'restart' });
        // Save this disposable server before graceful restart; this is not a crash-durability claim.
        await client.save();
        client.disconnect();
        execFileSync('docker', ['restart', container], { stdio: 'inherit' });
        client = new Redis(connection);
        await client.ping();
        await eventually(async () => assert.equal(await backend.enqueue('job', {}, { idempotencyKey: 'restart' }), id), 15000);
        assert.equal(await queue.getWaitingCount(), 1);
        console.log(JSON.stringify({ phase: 'redis-disconnect-restart', result: 'PASS', id }));
      } finally { await queue.obliterate({ force: true }); await backend.close(); const leftovers = await keys(client, `*${namespace}*`); if (leftovers.length) await client.del(...leftovers); }
    }
  } finally { for (const processChild of ownedChildren) await kill(processChild); if (client.status !== 'end') await client.quit(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
