'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateArtifact, registryManifest, verifyIntegrity, verifyProvenance } = require('./lib/release-artifact');
async function main() {
const directory = process.argv[2];
const tarballs = fs.readdirSync(directory).filter((name) => name.endsWith('.tgz'));
if (tarballs.length !== 1) throw new Error('exactly one verified tarball is required');
const source = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const result = validateArtifact(path.join(directory, tarballs[0]), source, fs.readFileSync('CHANGELOG.md', 'utf8'), process.env.GITHUB_REF_NAME);
const published = registryManifest(`${source.name}@${result.version}`);
if (published) {
  verifyIntegrity(result.bytes, published);
  const url = new URL(published.dist?.attestations?.url);
  if (url.origin !== 'https://registry.npmjs.org' || !url.pathname.startsWith('/-/npm/v1/attestations/')) throw new Error('unexpected attestation endpoint');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`attestation fetch failed: ${response.status}`);
  verifyProvenance(result.bytes, await response.json(), result.version, process.env.GITHUB_SHA);
}
if (process.argv.includes('--require-published') && !published) throw new Error('published artifact missing');
const summary = { version: result.version, integrity: result.integrity, published: !!published, ref: process.env.GITHUB_SHA };
console.log(JSON.stringify(summary, null, 2));
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `published=${!!published}\nintegrity=${result.integrity}\n`);

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
