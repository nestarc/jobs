const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required for coverage evidence');
const versions = Object.fromEntries(['@nestjs/core', 'bullmq', 'jest', 'typescript'].map((name) => [name, require(`${name}/package.json`).version]));
const evidence = { node: process.version, ref: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), versions, coverage: JSON.parse(fs.readFileSync('coverage/coverage-summary.json', 'utf8')) };
fs.writeFileSync('coverage/evidence.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ ...evidence, coverage: evidence.coverage.total }, null, 2));
