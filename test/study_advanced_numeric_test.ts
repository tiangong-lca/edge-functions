import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert';
import { analysisConfigHash, parseRequest } from '../contracts/lca-study/v5/authoring_codec.ts';
import { sha256 } from '../contracts/lca-study/v3/canonical.ts';

const root = new URL('./fixtures/lca-study-v5/numeric/', import.meta.url);
type Vector = { bits: string; canonical: string; input?: string };
const bytes = (name: string) => Deno.readFile(new URL(name, root));
const read = async (name: string) => JSON.parse(new TextDecoder().decode(await bytes(name)));
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function bits(value: string): string {
  const b = new ArrayBuffer(8),
    v = new DataView(b);
  v.setFloat64(0, Number(value), false);
  return v.getBigUint64(0, false).toString(16).padStart(16, '0');
}

Deno.test(
  'V5 canonical config strings retain exact Worker values and hashes across all 4123 numeric vectors',
  async () => {
    const vectors: Vector[] = await read('vectors.json'),
      corpus: Vector[] = await read('corpus4096.json'),
      provenance = await read('corpus-provenance.json');
    assertEquals(vectors.length, 27);
    assertEquals(corpus.length, 4096);
    assertEquals(
      await sha256(await bytes('vectors.json')),
      '7eeb610269d5653f254a7796ea380acb48a5024eb0ca7dc0cf881d855e04a3bb',
    );
    assertEquals(await sha256(await bytes('corpus4096.json')), provenance.vectorsSha256);
    assertEquals(provenance.workerCommit, 'e39b20fe99173ea95d072273bdd06ce1ec3ce840');
    let index = 0;
    for (const vector of [...vectors, ...corpus]) {
      const value = vector.canonical;
      // These bounds use the original strings. Parsing is used only to check their IEEE representation.
      const low = value === '0' ? '-1' : value.startsWith('-') ? value : '0';
      const high = value === '0' ? '1' : value.startsWith('-') ? '0' : value;
      const config = {
        schemaVersion: 'lca.study-analysis-config.v2',
        kind: 'sensitivityOat',
        baselineRunId: '10000000-0000-4000-8000-000000000010',
        parameters: [
          { path: '/instances/a/exchanges/e/amount', unit: 'kg', baselineAmount: value, low, high },
        ],
      };
      const hash = await analysisConfigHash(config);
      const wire = {
        schemaVersion: 'lca.study-api.v5',
        requestId: `numeric-${index}`,
        idempotencyKey: `numeric-key-${index}`,
        operation: 'analysis.request',
        studyId: '10000000-0000-4000-8000-000000000001',
        profileId: 'lca.study-sensitivity-oat.v1',
        config,
        configHash: hash,
      };
      const parsed = parseRequest(wire);
      assert(parsed.operation === 'analysis.request');
      assertEquals(parsed.config.parameters[0].baselineAmount, value, vector.bits);
      assertEquals(parsed.config.parameters[0].low, low, vector.bits);
      assertEquals(parsed.config.parameters[0].high, high, vector.bits);
      assertEquals(bits(value), value === '0' ? '0000000000000000' : vector.bits, vector.bits);
      // Independent fixed-field canonical serialization: scientific strings stay untouched.
      const canonical = JSON.stringify({
        baselineRunId: config.baselineRunId,
        kind: config.kind,
        parameters: [
          { baselineAmount: value, high, low, path: config.parameters[0].path, unit: 'kg' },
        ],
        schemaVersion: config.schemaVersion,
      });
      const expected = hex(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(`study.analysis-config.v2\0${canonical}`),
          ),
        ),
      );
      assertEquals(hash, expected, vector.bits);
      index++;
    }
    assertEquals(index, 4123);
  },
);

Deno.test(
  'V5 catalog canonicalizes issued Worker raw numeric tokens without regenerating their digits',
  async () => {
    const module =
      (await import('../supabase/functions/_shared/study/advanced_catalog.ts')) as unknown as {
        canonicalWorkerToken: (raw: string) => string;
      };
    const canonicalWorkerToken = module.canonicalWorkerToken;
    assertEquals(typeof canonicalWorkerToken, 'function');
    for (const [raw, expected] of [
      ['1.0', '1'],
      ['1e+23', '1e23'],
      ['-0.0', '0'],
      ['0.0', '0'],
      ['1.0000000000000001e+18', '1.0000000000000001e18'],
      ['5e-324', '5e-324'],
    ])
      assertEquals(canonicalWorkerToken(raw), expected, raw);
    const vectors: Vector[] = await read('vectors.json'),
      corpus: Vector[] = await read('corpus4096.json');
    for (const vector of [...vectors, ...corpus])
      assertEquals(canonicalWorkerToken(vector.canonical), vector.canonical, vector.bits);
    const problematic = vectors.find((v) => v.input === '1000000000000000100');
    assert(problematic);
    // This helper receives already issued Worker JSON tokens, never arbitrary actor numeric input.
    // It must not reinterpret this external spelling through a binary64-to-string conversion.
    assertEquals(canonicalWorkerToken(problematic.input!), problematic.input!);
    assertNotEquals(canonicalWorkerToken(problematic.input!), problematic.canonical);
  },
);
