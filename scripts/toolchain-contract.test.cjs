'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));
function findFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findFiles(absolutePath));
    } else {
      files.push(absolutePath);
    }
  }
  return files;
}
function collectFunctionsJsSpecifiers(source) {
  return new Set(
    [...source.matchAll(/['"]([^'"\r\n]*@supabase\/functions-js[^'"\r\n]*)['"]/gu)].map(
      (match) => match[1],
    ),
  );
}
const workflowSources = fs
  .readdirSync(path.join(repositoryRoot, '.github/workflows'))
  .filter((fileName) => fileName.endsWith('.yml'))
  .map((fileName) => ({ fileName, source: read(`.github/workflows/${fileName}`) }));

const expectedActions = new Map([
  ['actions/upload-artifact', 'cf430e030ddbb5b0abf93d22962f4752f3646cd9'],
  ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
  ['denoland/setup-deno', '22d081ff2d3a40755e97629de92e3bcbfa7cf2ed'],
  ['dtolnay/rust-toolchain', '4360b52568e2003a75bf9bc1d59f33a8e3fc893c'],
  ['pnpm/setup', 'a0881977cd8ea73b1ed212236c99ca10dcc80cf4'],
]);

test('keeps Supabase Edge Runtime-compatible Deno authoritative and auxiliary tooling exact', () => {
  const packageJson = readJson('package.json');

  assert.equal(packageJson.packageManager, 'pnpm@11.24.0');
  assert.deepEqual(packageJson.engines, { node: '24.19.0', pnpm: '11.24.0' });
  assert.equal(packageJson.config.denoVersion, '2.1.4');
  assert.equal(packageJson.config.denoTypeScriptVersion, '5.6.2');
  assert.equal(packageJson.config.supabaseCliVersion, '2.121.0');
  assert.equal(packageJson.config.supabaseEdgeRuntimeVersion, '1.77.4');
  assert.equal(packageJson.devDependencies.prettier, '3.9.10');
  assert.equal(packageJson.devDependencies.supabase, '2.121.0');
  assert.equal(packageJson.devDependencies.typescript, undefined);
  assert.equal(packageJson.devDependencies['prettier-plugin-organize-imports'], undefined);
  assert.equal(read('.nvmrc').trim(), '24.19.0');
  assert.equal(read('.tool-versions').trim(), 'deno 2.1.4');
  assert.doesNotMatch(read('.prettierrc.js'), /prettier-plugin-organize-imports/u);
});

test('pins the latest reviewed Edge-compatible runtime dependency graph', () => {
  const imports = readJson('supabase/functions/deno.json').imports;
  assert.deepEqual(imports, {
    '@aws-sdk/client-s3': 'npm:@aws-sdk/client-s3@3.1161.0',
    '@aws-sdk/s3-request-presigner': 'npm:@aws-sdk/s3-request-presigner@3.1161.0',
    '@aws-sdk/client-sagemaker-runtime': 'npm:@aws-sdk/client-sagemaker-runtime@3.1152.0',
    '@openai/openai': 'npm:openai@7.38.0',
    '@supabase/functions-js/edge-runtime.d.ts':
      'jsr:@supabase/functions-js@2.118.0/edge-runtime.d.ts',
    '@supabase/supabase-js@2': 'jsr:@supabase/supabase-js@2.118.0',
    '@upstash/redis': 'https://esm.sh/@upstash/redis@1.38.3',
    postgres: 'https://deno.land/x/postgresjs@v3.4.8/mod.js',
    redis: 'jsr:@db/redis@0.42.0',
    zod: 'npm:/zod@4.6.7',
  });

  const directSupabaseVersions = new Set();
  const directFunctionsJsSpecifiers = new Set();
  for (const root of ['supabase/functions', 'test', 'scripts']) {
    for (const filePath of findFiles(path.join(repositoryRoot, root))) {
      if (!filePath.endsWith('.ts')) continue;
      const source = fs.readFileSync(filePath, 'utf8');
      for (const match of source.matchAll(/jsr:@supabase\/supabase-js@([^/'"]+)/gu)) {
        directSupabaseVersions.add(match[1]);
      }
      for (const specifier of collectFunctionsJsSpecifiers(source)) {
        directFunctionsJsSpecifiers.add(specifier);
      }
    }
  }
  assert.deepEqual([...directSupabaseVersions], ['2.118.0']);
  for (const bypass of [
    'jsr:@supabase/functions-js/edge-runtime.d.ts',
    'jsr:@supabase/functions-js@2.118.0/edge-runtime.d.ts',
    'npm:@supabase/functions-js@2.118.0',
    'https://esm.sh/@supabase/functions-js@2.118.0/edge-runtime.d.ts',
  ]) {
    assert.deepEqual([...collectFunctionsJsSpecifiers(`import '${bypass}';`)], [bypass]);
  }
  assert.deepEqual([...directFunctionsJsSpecifiers], ['@supabase/functions-js/edge-runtime.d.ts']);
  assert.match(
    read('supabase/functions/_shared/redis_client.ts'),
    /@upstash\/redis@1\.38\.3[\s\S]*jsr:@db\/redis@0\.42\.0/u,
  );
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, 'supabase/functions/_shared/decode_api_key.ts')),
    false,
  );
});

test('binds the Supabase CLI image to reviewed Edge Runtime and Deno source evidence', () => {
  const packageJson = readJson('package.json');
  const fixture = readJson('test/fixtures/supabase-edge-runtime-v1.77.4-deno.json');

  assert.equal(fixture.schemaVersion, 'supabase.edge-runtime-deno-source.v1');
  assert.equal(fixture.cli.version, packageJson.config.supabaseCliVersion);
  assert.equal(fixture.cli.edgeRuntimeVersion, packageJson.config.supabaseEdgeRuntimeVersion);
  assert.equal(fixture.edgeRuntime.version, packageJson.config.supabaseEdgeRuntimeVersion);
  assert.equal(fixture.edgeRuntime.denoVersion, packageJson.config.denoVersion);
  assert.equal(fixture.deno.version, packageJson.config.denoVersion);
  assert.equal(fixture.deno.bundledTypeScriptVersion, packageJson.config.denoTypeScriptVersion);
  assert.deepEqual(
    [fixture.cli.source, fixture.edgeRuntime.source, fixture.deno.source].map(
      ({ repository, ref, path: sourcePath, gitBlobSha }) => ({
        repository,
        ref,
        path: sourcePath,
        gitBlobSha,
      }),
    ),
    [
      {
        repository: 'supabase/cli',
        ref: 'v2.121.0',
        path: 'apps/cli/src/shared/services/Dockerfile',
        gitBlobSha: '563c96ccd7ce0a7d1f4052750b391a1a46ca3836',
      },
      {
        repository: 'supabase/edge-runtime',
        ref: 'v1.77.4',
        path: 'deno/Cargo.toml',
        gitBlobSha: '7d9ff170f4a4ce3d82096705f9a97ee86984fb6b',
      },
      {
        repository: 'denoland/deno',
        ref: 'v2.1.4',
        path: 'cli/build.rs',
        gitBlobSha: '3d986612841584b764e9996aa861724b744017a7',
      },
    ],
  );
});

test('uses one frozen pnpm graph without npm-owned compiler tooling', () => {
  const lockfile = read('pnpm-lock.yaml');
  const workspace = read('pnpm-workspace.yaml');

  assert.match(lockfile, /^\s{2}prettier@3\.9\.10:/mu);
  assert.match(lockfile, /^\s{2}supabase@2\.121\.0:/mu);
  assert.doesNotMatch(lockfile, /^\s{2}typescript@/mu);
  assert.doesNotMatch(lockfile, /prettier-plugin-organize-imports/u);
  assert.match(workspace, /supabase:\s*true/u);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'package-lock.json')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'yarn.lock')), false);
});

test('makes canonical check run exact environment, graph, and behavior tests', () => {
  const scripts = readJson('package.json').scripts;

  assert.equal(scripts['check:env'], 'node scripts/check-env.cjs');
  assert.equal(scripts['check:types'], 'node scripts/deno-check-all.cjs');
  assert.equal(scripts['test:node'], 'node --test scripts/*.test.cjs');
  assert.equal(
    scripts['test:deno'],
    'deno test --config supabase/functions/deno.json --allow-env --allow-read --allow-net=127.0.0.1 test',
  );
  assert.equal(scripts.test, 'pnpm test:node && pnpm test:deno');
  assert.equal(scripts.check, 'pnpm check:env && pnpm check:types && pnpm test');
  assert.equal(
    scripts.lint,
    'pnpm exec prettier --check "**/*.{cjs,js,jsx,tsx,ts,less,md,json,yml,yaml}"',
  );
});

test('uses pnpm only across active repository automation', () => {
  const activeSources = [
    ['package.json', read('package.json')],
    ...fs
      .readdirSync(path.join(repositoryRoot, 'scripts'))
      .filter((fileName) => /\.(?:cjs|sh)$/u.test(fileName) && !fileName.endsWith('.test.cjs'))
      .map((fileName) => [`scripts/${fileName}`, read(`scripts/${fileName}`)]),
    ...fs
      .readdirSync(path.join(repositoryRoot, '.githooks'))
      .map((fileName) => [`.githooks/${fileName}`, read(`.githooks/${fileName}`)]),
    ...workflowSources.map(({ fileName, source }) => [`.github/workflows/${fileName}`, source]),
    ['AGENTS.md', read('AGENTS.md')],
    ['README.md', read('README.md')],
    ['docs/agents/repo-architecture.md', read('docs/agents/repo-architecture.md')],
    ['docs/agents/repo-validation.md', read('docs/agents/repo-validation.md')],
  ];

  for (const [relativePath, source] of activeSources) {
    assert.doesNotMatch(source, /(^|[\s"'`:])npx(?=$|[\s"'])/mu, relativePath);
    assert.doesNotMatch(
      source,
      /(^|[\s"'`:])npm\s+(?:exec|install|pack|publish|rebuild|run|test)(?=$|\s)/mu,
      relativePath,
    );
  }
});

test('pins every external action to a reviewed executable commit', () => {
  const observedActions = new Map();

  for (const { fileName, source } of workflowSources) {
    for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)) {
      const actionRef = match[1];
      if (actionRef.startsWith('./')) continue;

      assert.match(actionRef, /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/iu, fileName);
      const separator = actionRef.lastIndexOf('@');
      const action = actionRef.slice(0, separator);
      const commit = actionRef.slice(separator + 1);
      assert.equal(commit, expectedActions.get(action), `${fileName}: unexpected ${action} commit`);
      observedActions.set(action, commit);
    }
  }

  assert.deepEqual(observedActions, expectedActions);
  assert.equal(
    workflowSources.some(({ source }) => source.includes('actions/setup-node')),
    false,
  );
  assert.equal(
    workflowSources.some(({ source }) => source.includes('pnpm/action-setup')),
    false,
  );
});

test('binds CI to exact Deno and auxiliary Node runtimes', () => {
  const ci = read('.github/workflows/ci.yml');
  const supabaseConfig = read('supabase/config.toml');
  assert.match(ci, /version:\s*11\.24\.0/u);
  assert.match(ci, /runtime:\s*node@24\.19\.0/u);
  assert.match(ci, /deno-version-file:\s*\.tool-versions/u);
  assert.doesNotMatch(ci, /^\s+deno-version:/mu);
  assert.match(ci, /run:\s*pnpm install --frozen-lockfile/u);
  assert.match(ci, /run:\s*pnpm check/u);
  assert.match(supabaseConfig, /\[edge_runtime\][\s\S]*?deno_version\s*=\s*2/u);
});

test('both runtime fixtures bind the native image reader and separate binary version producers', () => {
  for (const [release, readerBlob, dockerfileBlob] of [
    [
      '1.74.3',
      'd9982ddf9f27524a5c1ded67adc7d875a004bb47',
      '8044ba168b46f28a03d846304cb490d956e384c4',
    ],
    [
      '1.77.4',
      '377f78a0344c2c004e24621f8f86f7f6e4084576',
      'ff1c4d68f27e76b09263e45a0cc4496fbf71a034',
    ],
  ]) {
    const fixture = readJson(`test/fixtures/supabase-edge-runtime-v${release}-deno.json`);
    assert.equal(fixture.cli.edgeRuntimeVersion, release);
    assert.equal(fixture.edgeRuntime.version, release);
    assert.equal(fixture.cli.source.repository, 'supabase/cli');
    assert.equal(fixture.cli.source.ref, `v${fixture.cli.version}`);
    assert.equal(
      fixture.cli.source.path,
      release === '1.74.3'
        ? 'apps/cli-go/pkg/config/templates/Dockerfile'
        : 'apps/cli/src/shared/services/Dockerfile',
    );
    assert.equal(
      fixture.cli.source.gitBlobSha,
      release === '1.74.3'
        ? 'f24a2d104363a974b44c0c6b711e12bd19b62376'
        : '563c96ccd7ce0a7d1f4052750b391a1a46ca3836',
    );
    assert.equal(fixture.cli.readerSource.repository, 'supabase/cli');
    assert.equal(fixture.cli.readerSource.ref, `v${fixture.cli.version}`);
    assert.equal(
      fixture.cli.readerSource.path,
      'apps/cli/src/shared/services/dockerfile-images.ts',
    );
    assert.equal(fixture.cli.readerSource.gitBlobSha, readerBlob);
    assert.equal(fixture.edgeRuntime.binary.version, '0.1.0');
    assert.equal(fixture.edgeRuntime.binary.profile, 'release');
    assert.equal(fixture.edgeRuntime.binary.target, 'x86_64-unknown-linux-gnu');
    assert.deepEqual(
      fixture.edgeRuntime.binary.sources.map(
        ({ repository, ref, path: sourcePath, gitBlobSha }) => ({
          repository,
          ref,
          path: sourcePath,
          gitBlobSha,
        }),
      ),
      [
        {
          repository: 'supabase/edge-runtime',
          ref: `v${release}`,
          path: 'cli/Cargo.toml',
          gitBlobSha: '73f582905c73d58481f0fec2311b4f8d1a0a544e',
        },
        {
          repository: 'supabase/edge-runtime',
          ref: `v${release}`,
          path: 'cli/src/flags.rs',
          gitBlobSha: '136b3e0a9793cea7fd0c463978446ad886ddbf9b',
        },
        {
          repository: 'supabase/edge-runtime',
          ref: `v${release}`,
          path: 'Dockerfile',
          gitBlobSha: dockerfileBlob,
        },
      ],
    );
  }
});

test('worker metadata has its own exact tagged producer and cannot redefine compiler versions', () => {
  const expectedSources = {
    '1.74.3': [
      'bc7b789a66667e3105f0ca5e0a020a6825ebe476',
      '3216531f9b8821fe6bb1ea1906d4e524f71393a8',
      '3798fef25ef6f2824520322bf089f70f72617a4d',
    ],
    '1.77.4': [
      '1a98593cee8882faa9206b8a274496b5e8166935',
      '0cf2d01e45c5c0e8d33ca741dd07dde73b20a873',
      'eb2014ed445e81118fc5cf4083e77fd228fc4e45',
    ],
  };
  for (const release of ['1.74.3', '1.77.4']) {
    const fixture = readJson(`test/fixtures/supabase-edge-runtime-v${release}-deno.json`);
    assert.deepEqual(fixture.edgeRuntime.worker.reportedVersion, {
      deno: `supabase-edge-runtime-${release} (compatible with Deno v2.1.4)`,
      v8: '11.6.189.12',
      typescript: '5.1.6',
    });
    assert.deepEqual(
      fixture.edgeRuntime.worker.sources.map(
        ({ repository, ref, path: sourcePath, gitBlobSha }) => ({
          repository,
          ref,
          path: sourcePath,
          gitBlobSha,
        }),
      ),
      ['ext/runtime/js/bootstrap.js', 'crates/base/src/runtime/mod.rs', 'deno/versions.rs'].map(
        (sourcePath, index) => ({
          repository: 'supabase/edge-runtime',
          ref: `v${release}`,
          path: sourcePath,
          gitBlobSha: expectedSources[release][index],
        }),
      ),
    );
    assert.equal(fixture.deno.version, '2.1.4');
    assert.equal(fixture.deno.bundledTypeScriptVersion, '5.6.2');
  }
});
