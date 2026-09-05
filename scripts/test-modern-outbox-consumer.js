'use strict';

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
if (process.env.JOBS_TARBALL_DIR) {
  const files = fs.readdirSync(process.env.JOBS_TARBALL_DIR).filter((f) => f.endsWith('.tgz'));
  if (files.length !== 1) throw new Error('exactly one candidate tarball required');
  process.env.JOBS_TARBALL = path.join(process.env.JOBS_TARBALL_DIR, files[0]);
}
const fixturePath = path.join(projectRoot, 'test', 'consumer', 'modern-outbox.ts');
const expectedOutboxVersion = process.env.OUTBOX_EXPECTED_VERSION ?? '0.2.1';
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(expectedOutboxVersion)) throw new Error('exact expected Outbox version required');
const exactVersions = Object.freeze({
  '@nestjs/common': '11.2.1',
  '@nestjs/core': '11.2.1',
  '@nestjs/schedule': '5.0.1',
  '@nestjs/testing': '11.2.1',
  '@prisma/adapter-pg': '7.10.0',
  '@prisma/client': '7.10.0',
  '@types/node': '20.19.39',
  pg: '8.16.3',
  prisma: '7.10.0',
  'reflect-metadata': '0.2.2',
  rxjs: '7.8.2',
  typescript: '5.9.3',
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
    }
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }

  return (result.stdout ?? '').trim();
}

function enabled(value) {
  if (typeof value !== 'string') return false;
  return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function digest(filePath, algorithm, encoding) {
  return createHash(algorithm).update(fs.readFileSync(filePath)).digest(encoding);
}

function sha256(filePath) {
  return digest(filePath, 'sha256', 'hex');
}

function sriSha512(filePath) {
  return `sha512-${digest(filePath, 'sha512', 'base64')}`;
}

function isHttpsTarball(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname.endsWith('.tgz');
  } catch {
    return false;
  }
}

function installedVersion(graph, packageName) {
  const version = graph.dependencies?.[packageName]?.version;
  if (typeof version !== 'string') {
    throw new Error(`Installed package graph is missing ${packageName}`);
  }
  return version;
}

function assertVersion(graph, packageName, expectedVersion) {
  const actualVersion = installedVersion(graph, packageName);
  if (actualVersion !== expectedVersion) {
    throw new Error(`Expected ${packageName}@${expectedVersion}, received ${actualVersion}`);
  }
}

function lockKey(packageName) {
  return `node_modules/${packageName}`;
}

function assertExactRegistryLock(packageLock, packageName, expectedVersion) {
  const locked = packageLock.packages?.[lockKey(packageName)];
  if (!locked || locked.version !== expectedVersion) {
    throw new Error(`package-lock.json does not bind ${packageName}@${expectedVersion}`);
  }
  if (!locked.resolved?.startsWith('https://registry.npmjs.org/')) {
    throw new Error(`${packageName}@${expectedVersion} is not resolved from the npm registry`);
  }
  if (!locked.integrity?.startsWith('sha512-')) {
    throw new Error(`${packageName}@${expectedVersion} is missing lockfile integrity`);
  }
  if (packageLock.packages?.['']?.dependencies?.[packageName] !== expectedVersion) {
    throw new Error(`Consumer manifest does not pin exact ${packageName}@${expectedVersion}`);
  }
}

function main() {
  if (
    [process.env.npm_config_legacy_peer_deps, process.env.NPM_CONFIG_LEGACY_PEER_DEPS].some(enabled)
  ) {
    throw new Error('Modern consumer test refuses npm_config_legacy_peer_deps');
  }
  if ([process.env.npm_config_force, process.env.NPM_CONFIG_FORCE].some(enabled)) {
    throw new Error('Modern consumer test refuses npm_config_force');
  }

  const suppliedOutboxPackage = process.env.OUTBOX_PACKAGE;
  if (!suppliedOutboxPackage) {
    throw new Error(
      'OUTBOX_PACKAGE is required (use an Outbox 0.2.1 candidate tarball or exact published spec)',
    );
  }

  const localOutboxCandidate = path.isAbsolute(suppliedOutboxPackage);
  const exactPublishedSpec = `@nestarc/outbox@${expectedOutboxVersion}`;
  if (
    !localOutboxCandidate &&
    suppliedOutboxPackage !== exactPublishedSpec &&
    !isHttpsTarball(suppliedOutboxPackage)
  ) {
    throw new Error(
      `OUTBOX_PACKAGE must be an absolute candidate tarball, ${exactPublishedSpec}, or an HTTPS tarball URL`,
    );
  }
  const outboxPackage = localOutboxCandidate
    ? fs.realpathSync(suppliedOutboxPackage)
    : suppliedOutboxPackage;
  if (localOutboxCandidate) {
    const expectedTarballName = `nestarc-outbox-${expectedOutboxVersion}.tgz`;
    if (
      !fs.statSync(outboxPackage).isFile() ||
      path.basename(outboxPackage) !== expectedTarballName
    ) {
      throw new Error(`Local Outbox candidate must be the exact ${expectedTarballName} tarball`);
    }
  }
  const outboxSha256 = localOutboxCandidate ? sha256(outboxPackage) : undefined;
  const outboxIntegrity = localOutboxCandidate ? sriSha512(outboxPackage) : undefined;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-modern-consumer-'));

  try {
    if (!process.env.JOBS_TARBALL) run('npm', ['run', 'build']);
    const tarballName = process.env.JOBS_TARBALL ? path.basename(process.env.JOBS_TARBALL) : run(
      'npm',
      ['pack', '--ignore-scripts', '--silent', '--pack-destination', tempDir],
      { capture: true },
    )
      .split(/\r?\n/)
      .at(-1);
    if (!tarballName) throw new Error('npm pack did not report a Jobs tarball name');

    const jobsTarball = process.env.JOBS_TARBALL ? fs.realpathSync(process.env.JOBS_TARBALL) : path.join(tempDir, tarballName);
    const jobsSha256 = sha256(jobsTarball);
    const jobsIntegrity = sriSha512(jobsTarball);
    const consumerDir = path.join(tempDir, 'consumer');
    fs.mkdirSync(consumerDir);
    fs.writeFileSync(
      path.join(consumerDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'jobs-modern-outbox-consumer',
          private: true,
          version: '1.0.0',
        },
        null,
        2,
      )}\n`,
    );
    fs.copyFileSync(fixturePath, path.join(consumerDir, 'index.ts'));

    run(
      'npm',
      [
        'install',
        '--strict-peer-deps',
        '--legacy-peer-deps=false',
        '--force=false',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--save-exact',
        jobsTarball,
        outboxPackage,
        ...Object.entries(exactVersions).map(([name, version]) => `${name}@${version}`),
      ],
      { cwd: consumerDir },
    );
    run(
      'npm',
      [
        'ls',
        '@nestarc/jobs',
        '@nestarc/outbox',
        '@nestjs/common',
        '@nestjs/core',
        '@prisma/client',
        'prisma',
        '--all',
      ],
      { cwd: consumerDir },
    );

    const graph = JSON.parse(
      run('npm', ['ls', '--json', '--depth=0'], { cwd: consumerDir, capture: true }),
    );
    for (const [packageName, expectedVersion] of Object.entries(exactVersions)) {
      assertVersion(graph, packageName, expectedVersion);
    }
    assertVersion(graph, '@nestarc/outbox', expectedOutboxVersion);

    const jobsManifestPath = path.join(
      consumerDir,
      'node_modules',
      '@nestarc',
      'jobs',
      'package.json',
    );
    const outboxManifestPath = path.join(
      consumerDir,
      'node_modules',
      '@nestarc',
      'outbox',
      'package.json',
    );
    const jobsManifest = JSON.parse(fs.readFileSync(jobsManifestPath, 'utf8'));
    const outboxManifest = JSON.parse(fs.readFileSync(outboxManifestPath, 'utf8'));
    assertVersion(graph, '@nestarc/jobs', jobsManifest.version);
    if (jobsManifest.name !== '@nestarc/jobs') {
      throw new Error(`Packed Jobs artifact has unexpected name ${jobsManifest.name}`);
    }
    if (jobsManifest.peerDependencies?.['@nestarc/outbox'] !== '^0.2.1 || ^0.3.0') {
      throw new Error('Packed Jobs artifact no longer declares the verified Outbox ^0.2.1 || ^0.3.0 range');
    }
    if (outboxManifest.name !== '@nestarc/outbox') {
      throw new Error(`Outbox artifact has unexpected name ${outboxManifest.name}`);
    }
    if (outboxManifest.version !== expectedOutboxVersion) {
      throw new Error(
        `Expected Outbox artifact ${expectedOutboxVersion}, received ${outboxManifest.version}`,
      );
    }
    if (!outboxManifest.peerDependencies?.['@prisma/client']?.includes('^7.0.0')) {
      throw new Error('Outbox artifact does not declare the verified Prisma 7 peer range');
    }

    const packageLock = JSON.parse(
      fs.readFileSync(path.join(consumerDir, 'package-lock.json'), 'utf8'),
    );
    for (const [packageName, expectedVersion] of Object.entries(exactVersions)) {
      assertExactRegistryLock(packageLock, packageName, expectedVersion);
    }
    const lockedJobs = packageLock.packages?.['node_modules/@nestarc/jobs'];
    const lockedOutbox = packageLock.packages?.['node_modules/@nestarc/outbox'];
    if (!lockedJobs || lockedJobs.version !== jobsManifest.version) {
      throw new Error('package-lock.json does not bind the packed Jobs artifact');
    }
    if (!lockedJobs.resolved?.includes(path.basename(jobsTarball))) {
      throw new Error('package-lock.json did not resolve Jobs from the packed artifact path');
    }
    if (!lockedOutbox || lockedOutbox.version !== expectedOutboxVersion) {
      throw new Error('package-lock.json does not bind the expected Outbox artifact');
    }
    if (localOutboxCandidate && !lockedOutbox.resolved?.includes(path.basename(outboxPackage))) {
      throw new Error('package-lock.json did not resolve Outbox from the supplied candidate path');
    }
    if (isHttpsTarball(suppliedOutboxPackage) && lockedOutbox.resolved !== suppliedOutboxPackage) {
      throw new Error('package-lock.json did not preserve the supplied Outbox tarball URL');
    }
    if (lockedJobs.integrity !== jobsIntegrity) {
      throw new Error('Packed Jobs artifact lock integrity does not match its SHA-512 digest');
    }
    if (process.env.OUTBOX_EXPECTED_INTEGRITY && lockedOutbox.integrity !== process.env.OUTBOX_EXPECTED_INTEGRITY) throw new Error('Outbox artifact differs from candidate manifest integrity');
    if (localOutboxCandidate && lockedOutbox.integrity !== outboxIntegrity) {
      throw new Error('Outbox candidate lock integrity does not match its SHA-512 digest');
    }
    if (!localOutboxCandidate && !lockedOutbox.integrity?.startsWith('sha512-')) {
      throw new Error('Outbox artifact is missing lockfile integrity');
    }

    run(
      'npx',
      [
        '--no-install',
        'tsc',
        '--strict',
        '--skipLibCheck',
        'false',
        '--noEmitOnError',
        '--target',
        'ES2022',
        '--module',
        'commonjs',
        '--moduleResolution',
        'node',
        '--esModuleInterop',
        '--outDir',
        'dist',
        'index.ts',
      ],
      { cwd: consumerDir },
    );
    run(process.execPath, [path.join('dist', 'index.js')], { cwd: consumerDir });

    console.log(
      JSON.stringify(
        {
          tuple: {
            nest: exactVersions['@nestjs/common'],
            prisma: exactVersions['@prisma/client'],
          },
          artifacts: {
            jobs: {
              name: jobsManifest.name,
              version: jobsManifest.version,
              path: fs.realpathSync(path.dirname(jobsManifestPath)),
              source: jobsTarball,
              sha256: jobsSha256,
              integrity: lockedJobs.integrity,
            },
            outbox: {
              name: outboxManifest.name,
              version: outboxManifest.version,
              path: fs.realpathSync(path.dirname(outboxManifestPath)),
              source: outboxPackage,
              resolved: lockedOutbox.resolved,
              ...(outboxSha256 ? { sha256: outboxSha256 } : {}),
              integrity: lockedOutbox.integrity,
            },
          },
        },
        null,
        2,
      ),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
