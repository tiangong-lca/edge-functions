#!/usr/bin/env node
'use strict';
// Qualification only. This command never reads a user .env or links a remote project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { terminateOwnedGroup } = require('./stack-qualification/process.cjs');
const { boundedBody, waitForFixture } = require('./stack-qualification/http.cjs');
const { collectFailureDiagnostics } = require('./stack-qualification/diagnostics.cjs');
const { cancellationEvidence } = require('./stack-qualification/cancellation.cjs');
const {
  captureGatewayBaseline,
  waitForNativeStartup,
} = require('./stack-qualification/startup.cjs');
const {
  ownedRelayTarget,
  createOwnedRelay,
  assertLoopbackReleased,
} = require('./stack-qualification/relay.cjs');
const { createRequire } = require('node:module');
const {
  assertOwner,
  ownedEnvironment,
  requireHostedLinux,
  hash,
  jwt,
  signedHeaders,
  functionsRoute,
  chunkedPost,
  freePort,
  runtimeWorkingDirectory,
  runtimeBinaryIdentity,
  workerVersionIdentity,
  serveExitIdentity,
  assertNativeStopped,
  signingFixture,
  asymmetricJwt,
} = require('./stack-qualification/contracts.cjs');
const repo = path.resolve(__dirname, '..');
const variants = require('../test/fixtures/stack-qualification/cli3-case.json');
const excludes =
  'gotrue,realtime,storage-api,imgproxy,mailpit,postgrest,postgres-meta,studio,logflare,vector,supavisor';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  requireHostedLinux();
  const variant = process.argv[2];
  assert.ok(Object.hasOwn(variants, variant), 'Select baseline or candidate explicitly');
  const selected = variants[variant];
  const parent = process.env.EDGE_STACK_QUALIFICATION_ROOT;
  assert.ok(parent && path.isAbsolute(parent));
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, `${variant}-`));
  const evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence);
  const owner = assertOwner(`edge496-${crypto.randomBytes(12).toString('hex')}`);
  const project = owner.replaceAll('-', '');
  const env = ownedEnvironment(path.join(root, 'state'));
  const ledger = {
    owner,
    project,
    variant,
    selected,
    root,
    source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    networks: [],
    created: [],
    commands: [],
    outcomes: [],
    images: {},
    complete: false,
  };
  let serve;
  let lifecycle;
  const relays = [];
  let dockerReady = false;
  const persist = () =>
    fs.writeFileSync(
      path.join(root, 'lease.json'),
      JSON.stringify(
        {
          owner,
          project,
          root,
          servePid: serve?.pid,
          lifecyclePid: lifecycle?.pid,
          relayPorts: relays.map((relay) => relay.snapshot().port),
        },
        null,
        2,
      ) + '\n',
    );
  persist();
  const write = (name, value) =>
    fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + '\n');
  const synthetic = {
    secret: `synthetic-${crypto.randomBytes(32).toString('hex')}`,
    publishable: `sb_publishable_${crypto.randomBytes(24).toString('base64url')}`,
    service: `sb_secret_${crypto.randomBytes(24).toString('base64url')}`,
  };
  const asymmetric = signingFixture();
  const now = Math.floor(Date.now() / 1000);
  const anon = jwt(synthetic.secret, { role: 'anon', iss: 'supabase', iat: now, exp: now + 3600 });
  const serviceRole = jwt(synthetic.secret, {
    role: 'service_role',
    iss: 'supabase',
    iat: now,
    exp: now + 3600,
  });
  const redact = (value) =>
    [
      synthetic.secret,
      synthetic.publishable,
      synthetic.service,
      anon,
      serviceRole,
      ...['d', 'p', 'q', 'dp', 'dq', 'qi'].map((key) => asymmetric.signingKey[key]).filter(Boolean),
    ].reduce((s, key) => s.replaceAll(key, `[synthetic:${hash(key).slice(0, 12)}]`), value);
  function run(command, args, options = {}) {
    const { returnStreams = false, ...spawnOptions } = options;
    const index = ledger.commands.length;
    const started = Date.now();
    try {
      const child = spawnSync(command, args, {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 20 * 1024 * 1024,
        ...spawnOptions,
      });
      const output = child.stdout ?? '';
      fs.writeFileSync(
        path.join(evidence, `command-${index}.stderr.log`),
        redact(child.stderr ?? ''),
      );
      if (child.error || child.status !== 0) {
        const error = child.error ?? new Error(`Command exited ${child.status}`);
        error.stdout = output;
        error.stderr = child.stderr;
        error.status = child.status;
        throw error;
      }
      fs.writeFileSync(path.join(evidence, `command-${index}.log`), redact(output));
      ledger.commands.push({
        command,
        args,
        exit: 0,
        milliseconds: Date.now() - started,
        stdoutSha256: hash(output),
      });
      persist();
      return returnStreams ? { stdout: output, stderr: child.stderr ?? '' } : output;
    } catch (error) {
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      fs.writeFileSync(path.join(evidence, `command-${index}.log`), redact(output));
      ledger.commands.push({
        command,
        args,
        exit: error.status ?? null,
        milliseconds: Date.now() - started,
        outputSha256: hash(output),
      });
      throw new Error(`${command} failed; see command-${index}.log`, { cause: error });
    }
  }
  const docker = (args, options) => run('docker', args, options);
  // Async lifecycle commands reserve their command-log index. Diagnostic and
  // relay inspections use separate receipts rather than mutating that ledger.
  const inspect = (kind, name) =>
    JSON.parse(
      execFileSync('docker', [kind, 'inspect', name], {
        env,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }),
    )[0];
  async function relayTo(name, networkName, kind, containerPort, hostPort = 0) {
    const relay = await createOwnedRelay({
      port: hostPort,
      resolveTarget: () => {
        const container = inspect('container', name);
        const target = ownedRelayTarget(container, inspect('network', networkName), {
          name,
          owner,
          project,
          kind,
          port: containerPort,
        });
        write(`relay-${name}-target.json`, {
          target,
          image: container.Image,
          requestedPortBindings: container.HostConfig.PortBindings,
          actualPortBindings: container.NetworkSettings.Ports,
        });
        return target;
      },
    });
    relays.push(relay);
    persist();
    return relay;
  }
  const ids = (kind) =>
    docker([
      kind,
      'ls',
      ...(kind === 'container' ? ['-a'] : []),
      '-q',
      '--filter',
      `label=com.supabase.cli.project=${project}`,
    ])
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
  async function cleanup() {
    const errors = [];
    if (!dockerReady) {
      write('cleanup.json', {
        owner,
        complete: true,
        resourcesCreated: false,
        reason: 'Docker preflight did not complete; no resource creation attempted',
      });
      return;
    }
    try {
      ledger.processCleanup = await terminateOwnedGroup({ root, servePid: serve?.pid });
      ledger.lifecycleCleanup = await terminateOwnedGroup({ root, servePid: lifecycle?.pid });
    } catch (error) {
      errors.push(error.message);
    }
    for (const relay of relays) {
      try {
        await relay.close();
      } catch (error) {
        errors.push(error.message);
      }
    }
    try {
      ledger.relayCleanup = await assertLoopbackReleased(
        relays.map((relay) => relay.snapshot().port),
      );
      write(
        'relays.json',
        relays.map((relay) => relay.snapshot()),
      );
    } catch (error) {
      errors.push(error.message);
    }
    // Discovery is bound to a fresh UUID project whose label inventory was empty before creation.
    for (const id of ids('container')) {
      try {
        docker(['container', 'rm', '-f', id]);
      } catch (error) {
        errors.push(error.message);
      }
    }
    for (const id of docker(['container', 'ls', '-aq', '--filter', `label=edge496.owner=${owner}`])
      .trim()
      .split(/\s+/u)
      .filter(Boolean)) {
      try {
        docker(['container', 'rm', '-f', id]);
      } catch (error) {
        errors.push(error.message);
      }
    }
    for (const item of ledger.created.toReversed()) {
      try {
        const exists = docker([
          'container',
          'ls',
          '-aq',
          '--filter',
          `name=^/${item.name}$`,
        ]).trim();
        if (exists) {
          const info = JSON.parse(docker(['container', 'inspect', exists]))[0];
          assert.equal(info.Config.Labels['edge496.owner'], owner);
          docker(['container', 'rm', '-f', exists]);
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
    for (const id of ids('volume')) {
      try {
        docker(['volume', 'rm', id]);
      } catch (error) {
        errors.push(error.message);
      }
    }
    for (const name of ledger.networks.toReversed()) {
      try {
        const remaining = docker(['network', 'ls', '-q', '--filter', `name=^${name}$`]).trim();
        if (remaining) {
          const info = JSON.parse(docker(['network', 'inspect', name]))[0];
          assert.equal(info.Labels['edge496.owner'], owner);
          docker(['network', 'rm', name]);
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
    const remaining = {
      containers: ids('container'),
      volumes: ids('volume'),
      ownedContainers: docker([
        'container',
        'ls',
        '-aq',
        '--filter',
        `label=edge496.owner=${owner}`,
      ]).trim(),
      networks: docker(['network', 'ls', '-q', '--filter', `label=edge496.owner=${owner}`]).trim(),
    };
    write('cleanup.json', {
      owner,
      errors,
      remaining,
      complete: errors.length === 0 && Object.values(remaining).every((v) => v.length === 0),
    });
    assert.equal(errors.length, 0, 'Owned cleanup failed');
    for (const value of Object.values(remaining))
      assert.equal(value.length, 0, 'Owned resources remain');
  }
  try {
    const memory = os.totalmem();
    const disk = fs.statfsSync(root);
    const free = Number(disk.bavail) * Number(disk.bsize);
    write('preflight.json', {
      platform: process.platform,
      arch: process.arch,
      cpus: os.availableParallelism(),
      memoryBytes: memory,
      freeBytes: free,
      docker: docker(['version', '--format', '{{json .}}']),
    });
    dockerReady = true;
    assert.ok(
      memory >= 3 * 1024 ** 3 && free >= 8 * 1024 ** 3,
      'Runner lacks measured minimum qualification capacity',
    );
    for (const kind of ['container', 'volume'])
      assert.deepEqual(ids(kind), [], 'Fresh fixture project already has resources');
    const tooling = path.join(root, 'tooling');
    fs.mkdirSync(tooling);
    fs.writeFileSync(path.join(tooling, 'package.json'), '{"private":true}\n');
    run('pnpm', [
      '--dir',
      tooling,
      'add',
      '--save-exact',
      '--ignore-scripts',
      'supabase@' + selected.cli,
    ]);
    const shim = path.join(tooling, 'node_modules/supabase/dist/supabase.js');
    const req = createRequire(
      fs.realpathSync(path.join(tooling, 'node_modules/supabase/package.json')),
    );
    const binary = path.join(
      path.dirname(req.resolve('@supabase/cli-linux-x64/package.json')),
      'bin/supabase',
    );
    const cli = async (args) => {
      const index = ledger.commands.length;
      const started = Date.now();
      lifecycle = spawn(process.execPath, [shim, ...args], {
        cwd: fixture,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      persist();
      let stdout = '';
      let stderr = '';
      let timer;
      lifecycle.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      lifecycle.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      try {
        const exit = await Promise.race([
          new Promise((resolve, reject) => {
            lifecycle.once('error', reject);
            lifecycle.once('exit', (code, signal) => resolve({ code, signal }));
          }),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Owned CLI lifecycle timed out')), 180000);
          }),
        ]);
        ledger.commands.push({
          command: process.execPath,
          args: [shim, ...args],
          exit: exit.code,
          signal: exit.signal,
          milliseconds: Date.now() - started,
        });
        assert.equal(exit.code, 0, 'Actual CLI lifecycle failed');
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (ledger.commands.length === index)
          ledger.commands.push({
            command: process.execPath,
            args: [shim, ...args],
            exit: null,
            milliseconds: Date.now() - started,
            error: 'Lifecycle did not produce a terminal exit receipt',
          });
        fs.writeFileSync(path.join(evidence, `command-${index}.log`), redact(stdout));
        fs.writeFileSync(path.join(evidence, `command-${index}.stderr.log`), redact(stderr));
        persist();
      }
    };
    const metaResponse = await fetch(
      `https://registry.npmjs.org/@supabase%2fcli-linux-x64/${selected.cli}`,
    );
    assert.equal(metaResponse.status, 200);
    const meta = await metaResponse.json();
    assert.equal(meta.version, selected.cli);
    const archiveResponse = await fetch(meta.dist.tarball);
    assert.equal(archiveResponse.status, 200);
    const archiveBytes = Buffer.from(await archiveResponse.arrayBuffer());
    assert.equal(
      'sha512-' + crypto.createHash('sha512').update(archiveBytes).digest('base64'),
      meta.dist.integrity,
    );
    const archivePath = path.join(root, 'cli-platform.tgz');
    fs.writeFileSync(archivePath, archiveBytes);
    const officialBinary = execFileSync('tar', ['-xOf', archivePath, 'package/bin/supabase'], {
      maxBuffer: 256 * 1024 * 1024,
    });
    assert.equal(hash(officialBinary), hash(fs.readFileSync(binary)));
    write('cli-artifact-binding.json', {
      url: meta.dist.tarball,
      integrity: meta.dist.integrity,
      archiveSha256: hash(archiveBytes),
      officialBinarySha256: hash(officialBinary),
    });
    const sourceFixture = JSON.parse(
      fs.readFileSync(
        path.join(repo, `test/fixtures/supabase-cli-v${selected.cli}-functions-transport.json`),
        'utf8',
      ),
    );
    const runtimeFixture = JSON.parse(
      fs.readFileSync(
        path.join(repo, `test/fixtures/supabase-edge-runtime-v${selected.runtime}-deno.json`),
        'utf8',
      ),
    );
    const bindings = [];
    for (const source of [
      ...sourceFixture.sources.map((x) => ({
        ...x,
        repository: 'supabase/cli',
        ref: sourceFixture.ref,
      })),
      runtimeFixture.cli.source,
      runtimeFixture.cli.readerSource,
      runtimeFixture.edgeRuntime.source,
      ...runtimeFixture.edgeRuntime.binary.sources,
      ...runtimeFixture.edgeRuntime.worker.sources,
      runtimeFixture.deno.source,
    ]) {
      const url = `https://raw.githubusercontent.com/${source.repository}/${source.ref}/${source.path}`;
      const response = await fetch(url);
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      const blob = crypto
        .createHash('sha1')
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest('hex');
      assert.equal(blob, source.gitBlobSha);
      bindings.push({ url, gitBlobSha: blob, sha256: hash(bytes) });
    }
    write('official-source-bindings.json', bindings);
    const cliVersion = run(process.execPath, [shim, '--version']).trim();
    assert.equal(cliVersion, selected.cli);
    write('cli-identity.json', {
      version: cliVersion,
      shimSha256: hash(fs.readFileSync(shim)),
      binarySha256: hash(fs.readFileSync(binary)),
      platformPackage: '@supabase/cli-linux-x64',
      toolingLockSha256: hash(fs.readFileSync(path.join(tooling, 'pnpm-lock.yaml'))),
    });
    run(process.execPath, [shim, '--help']);
    run(process.execPath, [shim, 'start', '--help']);
    run(process.execPath, [shim, 'functions', 'serve', '--help']);
    run(process.execPath, [shim, 'stop', '--help']);
    const imageRefs = {
      postgres: `supabase/postgres:${selected.postgres}`,
      kong: 'library/kong:2.8.1',
      runtime: `supabase/edge-runtime:v${selected.runtime}`,
    };
    for (const [kind, image] of Object.entries(imageRefs)) {
      docker(['pull', image], { timeout: 600000 });
      const info = JSON.parse(docker(['image', 'inspect', image]))[0];
      assert.ok(info.RepoDigests.length > 0);
      ledger.images[kind] = {
        reference: image,
        id: info.Id,
        digests: info.RepoDigests,
        bytes: info.Size,
      };
    }
    const fixture = path.join(root, 'fixture');
    const supabase = path.join(fixture, 'supabase');
    fs.mkdirSync(path.join(supabase, 'functions/portal'), { recursive: true });
    fs.mkdirSync(path.join(supabase, 'functions/jwt'), { recursive: true });
    fs.mkdirSync(path.join(supabase, 'functions/_shared'), { recursive: true });
    for (const name of ['portal_hmac.ts', 'portal_public_transport.ts'])
      fs.copyFileSync(
        path.join(repo, 'supabase/functions/_shared', name),
        path.join(supabase, 'functions/_shared', name),
      );
    const portalSource = fs
      .readFileSync(path.join(repo, 'test/fixtures/stack-qualification/portal.ts'), 'utf8')
      .replaceAll('../../../supabase/functions/_shared/', '../_shared/');
    fs.writeFileSync(path.join(supabase, 'functions/portal/index.ts'), portalSource);
    fs.copyFileSync(
      path.join(repo, 'test/fixtures/stack-qualification/jwt.ts'),
      path.join(supabase, 'functions/jwt/index.ts'),
    );
    const apiPort = await freePort();
    const dbPort = await freePort();
    const shadowPort = await freePort();
    const config = `project_id = "${project}"\n[api]\nport = ${apiPort}\n[db]\nport = ${dbPort}\nshadow_port = ${shadowPort}\nmajor_version = 17\n[db.seed]\nenabled = false\n[auth]\nenabled = true\njwt_secret = "${synthetic.secret}"\nsigning_keys_path = "./signing-keys.json"\npublishable_key = "${synthetic.publishable}"\nsecret_key = "${synthetic.service}"\nanon_key = "${anon}"\nservice_role_key = "${serviceRole}"\n[edge_runtime]\nenabled = true\ndeno_version = 2\n[functions.portal]\nverify_jwt = false\n[functions.jwt]\nverify_jwt = true\n`;
    fs.writeFileSync(path.join(supabase, 'config.toml'), config);
    fs.writeFileSync(
      path.join(supabase, 'signing-keys.json'),
      JSON.stringify([asymmetric.signingKey]) + '\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(root, 'synthetic.env'),
      `PORTAL_SUPABASE_PUBLISHABLE_KEY=${synthetic.publishable}\n`,
    );
    const network = `${owner}-cli`;
    docker(['network', 'create', '--internal', '--label', `edge496.owner=${owner}`, network]);
    ledger.networks.push(network);
    // Internal bridges intentionally suppress Docker host publishing. These
    // host-only byte relays do not add a container route or permit any egress.
    const dbName = `supabase_db_${project}`;
    const dbRelay = await relayTo(dbName, network, 'cli', 5432, dbPort);
    const apiRelay = await relayTo(`supabase_kong_${project}`, network, 'cli', 8000, apiPort);
    let startupSequence = 0;
    let startupFailure;
    function captureDatabaseStartup() {
      if (startupSequence >= 256) return;
      const sequence = startupSequence++;
      const result = spawnSync('docker', ['container', 'inspect', dbName], {
        env,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0) {
        write(`startup-db-${sequence}.json`, {
          observedAt: new Date().toISOString(),
          present: false,
          inspectExit: result.status,
        });
        return;
      }
      try {
        const info = JSON.parse(result.stdout)[0];
        assert.equal(info.Config.Labels['com.supabase.cli.project'], project);
        assert.equal(info.Name, '/' + dbName);
        write(`startup-db-${sequence}.json`, {
          observedAt: new Date().toISOString(),
          present: true,
          id: info.Id,
          name: info.Name,
          image: info.Image,
          state: info.State,
          requestedPortBindings: info.HostConfig.PortBindings,
          actualPortBindings: info.NetworkSettings.Ports,
          networks: info.NetworkSettings.Networks,
        });
        const logs = spawnSync('docker', ['logs', '--tail', '100', info.Id], {
          env,
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 256 * 1024,
        });
        fs.writeFileSync(
          path.join(evidence, `startup-db-${sequence}.log`),
          redact(`${logs.stdout ?? ''}\n${logs.stderr ?? ''}`),
        );
      } catch (error) {
        startupFailure = error;
        write(`startup-db-${sequence}-failure.json`, { message: error.message });
      }
    }
    const startupTimer = setInterval(captureDatabaseStartup, 1000);
    try {
      await cli(['start', '--debug', '--exclude', excludes, '--network-id', network]);
    } finally {
      clearInterval(startupTimer);
      captureDatabaseStartup();
    }
    assert.equal(startupFailure, undefined, 'Owned startup capture identity failed');
    const runtimeName = `supabase_edge_runtime_${project}`;
    const kongName = `supabase_kong_${project}`;
    const runtime = JSON.parse(docker(['container', 'inspect', runtimeName]))[0];
    const kong = JSON.parse(docker(['container', 'inspect', kongName]))[0];
    const workingDirectory = runtimeWorkingDirectory(runtime, fixture);
    assert.equal(runtime.Image, ledger.images.runtime.id);
    assert.equal(kong.Image, ledger.images.kong.id);
    const runtimeEnv = Object.fromEntries(
      runtime.Config.Env.map((value) => {
        const i = value.indexOf('=');
        return [value.slice(0, i), value.slice(i + 1)];
      }),
    );
    assert.equal(runtimeEnv.SUPABASE_URL, 'http://kong:8000');
    assert.ok(runtimeEnv.SUPABASE_INTERNAL_FUNCTIONS_CONFIG);
    const inlineJwks = JSON.parse(runtimeEnv.SUPABASE_JWKS);
    assert.ok(inlineJwks.keys.some((key) => key.kid === asymmetric.kid && key.kty === 'RSA'));
    for (const key of inlineJwks.keys)
      assert.equal(key.d, undefined, 'Runtime JWKS must contain public material only');
    write('synthetic-jwks-binding.json', {
      kid: asymmetric.kid,
      publicJwkSha256: hash(JSON.stringify(asymmetric.publicKey)),
      runtimeJwksSha256: hash(runtimeEnv.SUPABASE_JWKS),
    });
    runtimeEnv.PORTAL_SUPABASE_PUBLISHABLE_KEY = synthetic.publishable;
    // First config retains the JWT-enabled companion. Capture the actual CLI's bundled artifact.
    docker(['cp', `${runtimeName}:/root/index.ts`, path.join(root, 'bootstrap.ts')]);
    docker(['cp', `${kongName}:/home/kong/kong.yml`, path.join(root, 'kong-full.yml')]);
    const runtimeVersion = docker(['exec', runtimeName, 'edge-runtime', '--version']);
    write('runtime-binary-identity.json', {
      ...runtimeBinaryIdentity(runtimeVersion, runtimeFixture),
      stdout: runtimeVersion,
      stdoutSha256: hash(runtimeVersion),
      image: ledger.images.runtime,
    });
    const bootstrap = fs.readFileSync(path.join(root, 'bootstrap.ts'));
    const fullKong = fs.readFileSync(path.join(root, 'kong-full.yml'), 'utf8');
    fs.writeFileSync(path.join(evidence, 'bootstrap.ts'), bootstrap);
    fs.writeFileSync(path.join(evidence, 'kong-rendered.sanitized.yml'), redact(fullKong));
    write('actual-cli-artifacts.json', {
      workingDirectory,
      bootstrapSha256: hash(bootstrap),
      renderedKongSha256: hash(fullKong),
      configSha256: hash(config),
      runtimeEnvSha256: hash(JSON.stringify(runtimeEnv)),
      images: ledger.images,
    });
    const gatewayBaselineCommand = ledger.commands.length;
    const gatewayBaseline = captureGatewayBaseline(
      kong,
      docker(['logs', kong.Id], { returnStreams: true, timeout: 1000, maxBuffer: 1024 * 1024 }),
      { id: kong.Id, name: kongName, image: ledger.images.kong.id, project, network },
    );
    // Actual CLI serve lifecycle, no fake database prerequisite; source is a disposable fixture.
    const log = fs.openSync(path.join(evidence, 'serve.raw.log'), 'w');
    serve = spawn(
      process.execPath,
      [
        shim,
        'functions',
        'serve',
        '--no-verify-jwt',
        '--env-file',
        path.join(root, 'synthetic.env'),
        '--network-id',
        network,
      ],
      { cwd: fixture, env, detached: true, stdio: ['ignore', log, log] },
    );
    fs.closeSync(log);
    persist();
    write('native-startup-baseline.json', {
      ...gatewayBaseline.receipt,
      commandIndex: gatewayBaselineCommand,
      servePid: serve.pid,
      preRuntimeId: runtime.Id,
    });
    const portalUrl = `http://127.0.0.1:${apiPort}/functions/v1/portal`;
    const startupObservations = [];
    let probeFirstCommand;
    await waitForNativeStartup({
      baseline: gatewayBaseline,
      runtime: { beforeId: runtime.Id, name: runtimeName, image: ledger.images.runtime.id },
      alive: () => serve.exitCode === null && serve.signalCode === null,
      probe(remaining) {
        // All native/gateway observations share one 1s probe budget.
        probeFirstCommand = ledger.commands.length;
        const current = docker(
          ['container', 'ls', '-aq', '--no-trunc', '--filter', `name=^/${runtimeName}$`],
          { timeout: remaining() },
        ).trim();
        assert.ok(current === '' || /^[a-f0-9]{64}$/u.test(current), 'Ambiguous runtime inventory');
        const replacing = current !== '' && current !== runtime.Id;
        const inspected = JSON.parse(
          docker(['container', 'inspect', kong.Id, ...(replacing ? [current] : [])], {
            timeout: remaining(),
          }),
        );
        const logs = docker(['logs', kong.Id], {
          returnStreams: true,
          timeout: remaining(),
          maxBuffer: 1024 * 1024,
        });
        const serveFile = path.join(evidence, 'serve.raw.log');
        assert.ok(fs.statSync(serveFile).size <= 1024 * 1024, 'Native startup log limit exceeded');
        return {
          kong: inspected[0],
          runtime: replacing ? inspected[1] : null,
          logs,
          serveLog: fs.readFileSync(serveFile, 'utf8'),
        };
      },
      record(observation) {
        startupObservations.push({
          ...observation,
          commandRange: { first: probeFirstCommand, last: ledger.commands.length - 1 },
        });
        write('native-startup-observations.json', startupObservations);
      },
    });
    await ready(portalUrl, 'native');
    const served = JSON.parse(docker(['container', 'inspect', runtimeName]))[0];
    assert.ok(
      served.Config.Env.some((value) => value.includes('PORTAL_SUPABASE_PUBLISHABLE_KEY=')),
    );
    const servedConfig = JSON.parse(
      served.Config.Env.find((value) => value.startsWith('SUPABASE_INTERNAL_FUNCTIONS_CONFIG='))
        .split('=')
        .slice(1)
        .join('='),
    );
    for (const value of Object.values(servedConfig))
      assert.equal(value.verifyJWT, false, '--no-verify-jwt must select the documented override');
    await portalCases(portalUrl, 'actual-cli-serve', false);
    assert.equal(serve.exitCode, null, 'Native serve exited before requested shutdown');
    assert.equal(serve.signalCode, null, 'Native serve signalled before requested shutdown');
    assert.equal(serve.kill('SIGINT'), true);
    for (let i = 0; i < 100 && serve.exitCode === null && serve.signalCode === null; i++)
      await delay(100);
    write('serve-exit.json', serveExitIdentity(serve.exitCode, serve.signalCode));
    await cli(['stop', '--no-backup']);
    const stopped = { containers: ids('container'), volumes: ids('volume') };
    write('native-stop.json', stopped);
    assertNativeStopped(stopped);
    await dbRelay.close();
    await apiRelay.close();
    // Real offline two-container slice reuses the exact CLI-produced bootstrap/config, without DB.
    const pairNetwork = `${owner}-pair`;
    docker(['network', 'create', '--internal', '--label', `edge496.owner=${owner}`, pairNetwork]);
    ledger.networks.push(pairNetwork);
    const pairRuntime = `${owner}-runtime`;
    const pairKong = `${owner}-kong`;
    const route = functionsRoute(fullKong);
    fs.writeFileSync(path.join(root, 'kong-functions.yml'), route);
    write('pair-bindings.json', {
      workingDirectory,
      bootstrapSha256: hash(bootstrap),
      renderedFunctionsRouteSha256: hash(route),
      sourceKongSha256: hash(fullKong),
      offlineNetwork: pairNetwork,
    });
    const envFile = path.join(root, 'runtime.env');
    fs.writeFileSync(
      envFile,
      Object.entries(runtimeEnv)
        .map(([key, value]) => {
          assert.ok(!value.includes('\n'));
          return `${key}=${value}`;
        })
        .join('\n') + '\n',
    );
    docker([
      'run',
      '-d',
      '--name',
      pairRuntime,
      '--label',
      `edge496.owner=${owner}`,
      '--network',
      pairNetwork,
      '--network-alias',
      runtimeName,
      '--memory',
      '768m',
      '--env-file',
      envFile,
      '--workdir',
      workingDirectory,
      '-v',
      `${fixture}:${fixture}:ro`,
      '-v',
      `${path.join(root, 'bootstrap.ts')}:/root/index.ts:ro`,
      '--entrypoint',
      'edge-runtime',
      ledger.images.runtime.digests[0],
      'start',
      '--main-service=/root',
      '--port=8081',
    ]);
    ledger.created.push({ name: pairRuntime });
    docker([
      'run',
      '-d',
      '--name',
      pairKong,
      '--label',
      `edge496.owner=${owner}`,
      '--network',
      pairNetwork,
      '--network-alias',
      'kong',
      '--memory',
      '384m',
      '-e',
      'KONG_DATABASE=off',
      '-e',
      'KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml',
      '-e',
      'KONG_PLUGINS=request-transformer,cors',
      '-e',
      'KONG_NGINX_WORKER_PROCESSES=1',
      '-v',
      `${path.join(root, 'kong-functions.yml')}:/home/kong/kong.yml:ro`,
      ledger.images.kong.digests[0],
      'kong',
      'docker-start',
    ]);
    ledger.created.push({ name: pairKong });
    const pairRelay = await relayTo(pairKong, pairNetwork, 'pair', 8000);
    const port = `127.0.0.1:${pairRelay.snapshot().port}`;
    const pairUrl = `http://${port}/functions/v1/portal`;
    await ready(pairUrl, 'offline-pair');
    await portalCases(pairUrl, 'offline-pair', true);
    const jwtUrl = `http://${port}/functions/v1/jwt`;
    const requestTime = Math.floor(Date.now() / 1000);
    const valid = asymmetricJwt(asymmetric, {
      sub: '11111111-1111-4111-8111-111111111111',
      role: 'authenticated',
      iat: requestTime,
      exp: requestTime + 300,
    });
    for (const [label, token, expected] of [
      ['valid', valid, 200],
      ['bad', valid.slice(0, -5) + 'wrong', 401],
      ['expired', asymmetricJwt(asymmetric, { sub: 'test', exp: requestTime - 60 }), 401],
    ]) {
      const response = await fetch(jwtUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, apikey: synthetic.publishable },
        body: 'native-jwt',
      });
      await recordResponse(response, 'gateway-jwt', label);
      assert.equal(response.status, expected);
      ledger.outcomes.push({ case: `gateway-jwt-${label}`, status: response.status });
    }
    const cancelBody = Buffer.from('{"stream":"owned"}');
    const headers = signedHeaders(cancelBody, {
      apikey: synthetic.publishable,
      'x-fixture-stream': 'true',
    });
    const abort = new AbortController();
    // The nonce is public request identity. Never persist the signed headers or keys.
    const cancellationRequest = {
      nonce: headers['x-portal-nonce'],
      fetchStarted: false,
      responseStatus: null,
      readCompleted: false,
      firstReadDone: null,
      firstReadBytes: null,
      abortCalled: false,
      signalAborted: false,
      readerCancelSettled: false,
      readerCancelRejected: false,
    };
    const recordCancellationRequest = () => write('cancellation-request.json', cancellationRequest);
    recordCancellationRequest();
    const pendingResponse = fetch(pairUrl, {
      method: 'POST',
      headers,
      body: cancelBody,
      signal: abort.signal,
    });
    cancellationRequest.fetchStarted = true;
    recordCancellationRequest();
    const response = await pendingResponse;
    cancellationRequest.responseStatus = response.status;
    recordCancellationRequest();
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    cancellationRequest.readCompleted = true;
    cancellationRequest.firstReadDone = first.done;
    cancellationRequest.firstReadBytes = first.value?.byteLength ?? 0;
    recordCancellationRequest();
    assert.equal(first.done, false);
    abort.abort();
    cancellationRequest.abortCalled = true;
    cancellationRequest.signalAborted = abort.signal.aborted;
    recordCancellationRequest();
    await reader.cancel().catch(() => {
      cancellationRequest.readerCancelRejected = true;
    });
    cancellationRequest.readerCancelSettled = true;
    recordCancellationRequest();
    let cancellation;
    for (let i = 0; i < 50; i++) {
      const streams = docker(['logs', pairRuntime], { returnStreams: true });
      cancellation = cancellationEvidence(streams, headers['x-portal-nonce']);
      write('cancellation-events.json', {
        poll: i + 1,
        commandIndex: ledger.commands.length - 1,
        stdoutSha256: hash(streams.stdout),
        stderrSha256: hash(streams.stderr),
        ...cancellation,
      });
      if (cancellation.requestAbort && cancellation.responseCancel) break;
      await delay(100);
    }
    assert.ok(
      cancellation.requestAbort && cancellation.responseCancel,
      'Actual worker cancellation evidence missing',
    );
    ledger.outcomes.push({ case: 'worker-cancellation', requestAbort: true, responseCancel: true });
    for (const name of [pairKong, pairRuntime]) docker(['logs', name]);
    ledger.complete = true;
    async function ready(url, phase) {
      const observations = [];
      await waitForFixture(url, {
        record(observation) {
          observations.push({
            ...observation,
            body: observation.body === undefined ? undefined : redact(observation.body),
          });
          write(`readiness-${phase}.json`, observations);
        },
      });
    }
    async function recordResponse(response, phase, label) {
      const payload = await boundedBody(response);
      write(`response-${phase}-${label}.json`, {
        phase,
        case: label,
        status: response.status,
        bytes: payload.bytes,
        body: redact(payload.body),
        truncated: payload.truncated,
      });
      assert.equal(payload.truncated, false, 'Fixture response exceeded diagnostic body limit');
      return payload.body;
    }
    async function portalCases(url, phase, cancellationPhase) {
      const body = Buffer.from('{ "text": "steel 钢", "exact": true }\n');
      for (const [label, additional, expected] of [
        ['publishable-only', {}, 200],
        ['legacy-local-anon', { authorization: `Bearer ${anon}` }, 200],
        ['wrong-key', { apikey: 'sb_publishable_other_project' }, 400],
        ['missing-key', { apikey: '' }, 400],
        ['user-bearer', { authorization: 'Bearer synthetic-user' }, 400],
        ['secret-bearer', { authorization: `Bearer ${synthetic.service}` }, 400],
        ['cookie', { cookie: 'synthetic=1' }, 400],
        ['foreign-bearer', { authorization: 'Bearer foreign.issuer.token' }, 400],
      ]) {
        const r = await fetch(url, {
          method: 'POST',
          headers: signedHeaders(body, { apikey: synthetic.publishable, ...additional }),
          body,
        });
        const data = JSON.parse(await recordResponse(r, phase, label));
        assert.equal(r.status, expected, `${phase}:${label}`);
        if (expected === 200) {
          assert.equal(data.bodyHash, crypto.createHash('sha256').update(body).digest('base64url'));
          assert.equal(data.bodyBytes, body.length);
          assert.equal(data.pathname, '/portal');
          assert.equal(data.compatibilityHeaderPresent, false);
          assert.equal(data.authorizationPresent, label === 'legacy-local-anon');
          workerVersionIdentity(data.deno, runtimeFixture);
        }
        ledger.outcomes.push({ phase, case: label, status: r.status });
      }
      const chunked = await chunkedPost(
        url,
        body,
        signedHeaders(body, { apikey: synthetic.publishable }),
      );
      write(`response-${phase}-chunked.json`, {
        status: chunked.status,
        body: redact(JSON.stringify(chunked.body)).slice(0, 16384),
      });
      assert.equal(chunked.status, 200);
      assert.equal(
        chunked.body.bodyHash,
        crypto.createHash('sha256').update(body).digest('base64url'),
      );
      ledger.outcomes.push({ phase, case: 'chunked-raw-body', status: chunked.status });
      const changed = await fetch(url, {
        method: 'POST',
        headers: signedHeaders(body, { apikey: synthetic.publishable }),
        body: Buffer.concat([body, Buffer.from(' ')]),
      });
      await recordResponse(changed, phase, 'changed-body');
      assert.equal(changed.status, 400);
      const suffix = await fetch(url + '/extra', {
        method: 'POST',
        headers: signedHeaders(body, { apikey: synthetic.publishable }),
        body,
      });
      await recordResponse(suffix, phase, 'cross-path');
      assert.equal(suffix.status, 400);
      ledger.outcomes.push({
        phase,
        case: 'changed-body-and-cross-path',
        rejected: true,
        isolated: cancellationPhase,
      });
    }
  } catch (error) {
    if (dockerReady) {
      try {
        collectFailureDiagnostics({
          owner,
          project,
          write,
          sanitize: redact,
          execute: (args) =>
            spawnSync('docker', args, {
              env,
              encoding: 'utf8',
              timeout: 5000,
              maxBuffer: args[0] === 'logs' ? 256 * 1024 : 1024 * 1024,
            }),
        });
      } catch (diagnosticError) {
        ledger.diagnosticFailure = redact(diagnosticError.message);
      }
    }
    ledger.failure = { message: error.message, stack: redact(error.stack ?? '') };
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      ledger.complete = false;
      ledger.cleanupFailure = error.message;
      throw error;
    } finally {
      const rawServeLog = path.join(evidence, 'serve.raw.log');
      if (fs.existsSync(rawServeLog)) {
        fs.writeFileSync(
          path.join(evidence, 'serve.log'),
          redact(fs.readFileSync(rawServeLog, 'utf8')),
        );
        fs.rmSync(rawServeLog);
      }
      write('receipt.json', ledger);
      fs.writeFileSync(path.join(parent, `${variant}-latest.txt`), evidence + '\n');
    }
  }
}
module.exports = { variants, excludes };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
