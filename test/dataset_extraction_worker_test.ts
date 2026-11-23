import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js@2';

import {
  type DatasetEntityKind,
  processDatasetExtractionJobs,
  type SupportedDatasetEntityKind,
} from '../supabase/functions/_shared/dataset_extraction_worker.ts';
import {
  generateFlowMarkdown,
  normalizeJsonOrdered,
} from '../supabase/functions/_shared/flow_extraction.ts';

import { handleExtractionWebhook } from '../supabase/functions/_shared/extraction_webhook.ts';
import { projectFlowSearchText } from '../supabase/functions/_shared/search_text_projection.ts';

type JsonRecord = Record<string, unknown>;
type Filter = { field: string; value: unknown };

function searchTextFragments(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((fragment) => typeof fragment !== 'string')) {
    throw new Error('Expected search_text to be a string[]');
  }
  return value;
}

const FIXTURES: Partial<Record<SupportedDatasetEntityKind, unknown>> = {
  process: {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          'common:UUID': '97000000-0000-0000-0000-000000000006',
          name: { baseName: [{ '@xml:lang': 'en', '#text': 'Test process' }] },
        },
      },
    },
  },
  flow: {
    flowDataSet: {
      flowInformation: {
        dataSetInformation: {
          'common:UUID': '97000000-0000-0000-0000-000000000001',
          name: { baseName: [{ '@xml:lang': 'en', '#text': 'Test flow' }] },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
      },
    },
  },
  contact: {
    contactDataSet: {
      contactInformation: {
        dataSetInformation: {
          'common:name': [{ '@xml:lang': 'en', '#text': 'Alice Example' }],
          email: 'alice@example.test',
        },
      },
    },
  },
  flowproperty: {
    flowPropertyDataSet: {
      flowPropertiesInformation: {
        dataSetInformation: {
          'common:name': [{ '@xml:lang': 'en', '#text': 'Mass' }],
        },
        quantitativeReference: {
          referenceToReferenceUnitGroup: {
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Units of mass' }],
          },
        },
      },
    },
  },
  source: {
    sourceDataSet: {
      sourceInformation: {
        dataSetInformation: {
          'common:shortName': [{ '@xml:lang': 'en', '#text': 'Reference source' }],
          sourceCitation: 'Example et al. 2026',
        },
      },
    },
  },
  unitgroup: {
    unitGroupDataSet: {
      unitGroupInformation: {
        dataSetInformation: {
          'common:name': [{ '@xml:lang': 'en', '#text': 'Units of length' }],
        },
        quantitativeReference: { referenceToReferenceUnit: '1' },
      },
      units: { unit: { '@dataSetInternalID': '1', name: 'm', meanValue: 1 } },
    },
  },
  lifecyclemodel: {
    lifeCycleModelDataSet: {
      lifeCycleModelInformation: {
        dataSetInformation: {
          'common:UUID': '97000000-0000-0000-0000-000000000007',
          name: { baseName: [{ '@xml:lang': 'en', '#text': 'Test lifecycle model' }] },
        },
      },
    },
  },
};

const TABLE_BY_KIND: Partial<Record<SupportedDatasetEntityKind, string>> = {
  process: 'processes',
  flow: 'flows',
  contact: 'contacts',
  flowproperty: 'flowproperties',
  source: 'sources',
  unitgroup: 'unitgroups',
  lifecyclemodel: 'lifecyclemodels',
};

class FakeSupabase {
  rows: Record<string, JsonRecord[]> = {};
  claimedJobs: JsonRecord[] = [];
  rpcCalls: Array<{ fn: string; args: unknown }> = [];
  selectCounts: Record<string, number> = {};
  updatePayloads: Array<{ table: string; values: JsonRecord }> = [];

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({ fn, args: structuredClone(args) });
    if (fn === 'cmd_dataset_extraction_claim') {
      return Promise.resolve({
        data: { ok: true, data: this.claimedJobs.map((job) => structuredClone(job)) },
        error: null,
      });
    }
    if (fn === 'cmd_dataset_extraction_ack') {
      const { p_msg_ids } = args as { p_msg_ids: number[] };
      return Promise.resolve({
        data: { ok: true, data: { deleted_msg_ids: p_msg_ids } },
        error: null,
      });
    }
    return Promise.resolve({ data: { ok: true }, error: null });
  }

  schema(schema: string): this {
    assertEquals(schema, 'public');
    return this;
  }

  from(table: string): FakeDatasetQuery {
    this.rows[table] ??= [];
    return new FakeDatasetQuery(
      this.rows[table],
      () => {
        this.selectCounts[table] = (this.selectCounts[table] ?? 0) + 1;
      },
      (values) => {
        this.updatePayloads.push({ table, values });
      },
    );
  }
}

class FakeDatasetQuery {
  private filters: Filter[] = [];
  private mode: 'select' | 'update' | null = null;
  private updateValues: JsonRecord = {};

  constructor(
    private readonly rows: JsonRecord[],
    private readonly onSelect: () => void,
    private readonly onUpdate: (values: JsonRecord) => void,
  ) {}

  select(_columns: string): this {
    if (this.mode !== 'update') {
      this.mode = 'select';
      this.onSelect();
    }
    return this;
  }

  update(values: JsonRecord): this {
    this.mode = 'update';
    this.updateValues = structuredClone(values);
    this.onUpdate(structuredClone(values));
    return this;
  }

  eq(field: string, value: unknown): this {
    this.filters.push({ field, value });
    return this;
  }

  maybeSingle() {
    const row = this.matchingRows()[0];
    if (row && this.mode === 'update') {
      Object.assign(row, structuredClone(this.updateValues));
      row.xmin = String(Number(row.xmin ?? 1) + 1);
    }
    return Promise.resolve({
      data: row ? structuredClone({ xmin: '1', ...row }) : null,
      error: null,
    });
  }

  private matchingRows(): JsonRecord[] {
    return this.rows.filter((row) =>
      this.filters.every(
        (filter) =>
          (filter.field === 'xmin' ? (row.xmin ?? '1') : row[filter.field]) === filter.value,
      ),
    );
  }
}

function buildJob(
  msgId: number,
  entityKind: DatasetEntityKind,
  table: string,
  id = `97000000-0000-0000-0000-${String(msgId).padStart(12, '0')}`,
  version = '01.00.000',
  extractionKind: string = 'extracted_md',
  readCt = 1,
): JsonRecord {
  return {
    msg_id: msgId,
    read_ct: readCt,
    message: {
      schema: 'public',
      table,
      id,
      version,
      entity_kind: entityKind,
      extraction_kind: extractionKind,
      created_at: '2026-07-27T00:00:00Z',
    },
  };
}

Deno.test('processDatasetExtractionJobs writes and ACKs all four foundation datasets', async () => {
  const supabase = new FakeSupabase();
  const kinds: SupportedDatasetEntityKind[] = ['contact', 'flowproperty', 'source', 'unitgroup'];
  kinds.forEach((kind, index) => {
    const msgId = index + 1;
    const id = `97000000-0000-0000-0000-${String(msgId).padStart(12, '0')}`;
    const table = TABLE_BY_KIND[kind]!;
    supabase.rows[table] = [{ id, version: '01.00.000', json_ordered: FIXTURES[kind]! }];
    supabase.claimedJobs.push(buildJob(msgId, kind, table, id));
  });

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
  });

  assertEquals(result.claimed, 4);
  assertEquals(result.acked, 4);
  assertEquals(
    result.results.map((item) => item.status),
    ['success', 'success', 'success', 'success'],
  );
  assertStringIncludes(String(supabase.rows.contacts[0].extracted_md), '**Entity:** Contact');
  assertStringIncludes(
    String(supabase.rows.flowproperties[0].extracted_md),
    '**Entity:** Flow Property',
  );
  assertStringIncludes(String(supabase.rows.sources[0].extracted_md), '**Entity:** Source');
  assertStringIncludes(String(supabase.rows.unitgroups[0].extracted_md), '**Entity:** Unit Group');
  assertEquals(
    searchTextFragments(supabase.rows.contacts[0].search_text).includes('Alice Example'),
    true,
  );
  assertEquals(
    searchTextFragments(supabase.rows.flowproperties[0].search_text).includes('Mass'),
    true,
  );
  assertEquals(
    searchTextFragments(supabase.rows.sources[0].search_text).includes('Reference source'),
    true,
  );
  assertEquals(
    searchTextFragments(supabase.rows.unitgroups[0].search_text).includes('Units of length'),
    true,
  );
  assertEquals(supabase.rpcCalls.at(-1), {
    fn: 'cmd_dataset_extraction_ack',
    args: { p_msg_ids: [1, 2, 3, 4] },
  });
});

Deno.test(
  'normal process and lifecyclemodel jobs atomically dual-write both projections',
  async () => {
    const supabase = new FakeSupabase();
    const jobs: Array<{
      msgId: number;
      kind: SupportedDatasetEntityKind;
      markdown: string;
    }> = [
      { msgId: 8, kind: 'process', markdown: '# process markdown' },
      { msgId: 9, kind: 'lifecyclemodel', markdown: '# lifecycle model markdown' },
    ];

    for (const job of jobs) {
      const id = `97000000-0000-0000-0000-${String(job.msgId).padStart(12, '0')}`;
      const table = TABLE_BY_KIND[job.kind]!;
      supabase.rows[table] = [{ id, version: '01.00.000', json_ordered: FIXTURES[job.kind] }];
      supabase.claimedJobs.push(buildJob(job.msgId, job.kind, table, id));
    }

    const result = await processDatasetExtractionJobs({
      supabase: supabase as unknown as SupabaseClient,
      markdownGenerators: {
        process: () => jobs[0].markdown,
        lifecyclemodel: () => jobs[1].markdown,
      },
    });

    assertEquals(
      result.results.map((item) => item.status),
      ['success', 'success'],
    );
    assertEquals(supabase.rows.processes[0].extracted_md, jobs[0].markdown);
    assertEquals(
      searchTextFragments(supabase.rows.processes[0].search_text).includes('Test process'),
      true,
    );
    assertEquals(supabase.rows.lifecyclemodels[0].extracted_md, jobs[1].markdown);
    assertEquals(
      searchTextFragments(supabase.rows.lifecyclemodels[0].search_text).includes(
        'Test lifecycle model',
      ),
      true,
    );
    assertEquals(supabase.selectCounts.processes, 1);
    assertEquals(supabase.selectCounts.lifecyclemodels, 1);
    assertEquals(
      supabase.updatePayloads.map(({ values }) => Object.keys(values).sort()),
      [
        ['extracted_md', 'search_text'],
        ['extracted_md', 'search_text'],
      ],
    );
    assertEquals(
      supabase.updatePayloads.map(({ values }) => Array.isArray(values.search_text)),
      [true, true],
    );
  },
);

Deno.test('dataset extraction updates only the exact id and version', async () => {
  const supabase = new FakeSupabase();
  const id = '97000000-0000-0000-0000-000000000010';
  supabase.rows.sources = [
    { id, version: '01.00.000', json_ordered: FIXTURES.source },
    { id, version: '01.01.000', json_ordered: FIXTURES.source },
  ];
  supabase.claimedJobs = [buildJob(10, 'source', 'sources', id, '01.01.000')];

  await processDatasetExtractionJobs({ supabase: supabase as unknown as SupabaseClient });

  assertEquals(supabase.rows.sources[0].extracted_md, undefined);
  assertStringIncludes(String(supabase.rows.sources[1].extracted_md), '# Reference source');
});

Deno.test('search_text replay writes only search_text and keeps extracted_md bytes', async () => {
  const supabase = new FakeSupabase();
  const id = '97000000-0000-0000-0000-000000000011';
  const markdownSnapshot = '# existing markdown bytes';
  supabase.rows.flows = [
    {
      id,
      version: '01.00.000',
      json_ordered: FIXTURES.flow,
      extracted_md: markdownSnapshot,
      modified_at: 'before-replay',
    },
  ];
  supabase.claimedJobs = [buildJob(11, 'flow', 'flows', id, '01.00.000', 'search_text')];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
  });

  assertEquals(result.results[0].status, 'success');
  assertEquals(supabase.rows.flows[0].extracted_md, markdownSnapshot);
  const searchText = searchTextFragments(supabase.rows.flows[0].search_text);
  assertEquals(searchText.includes('Test flow'), true);
  assertEquals(supabase.rows.flows[0].modified_at, 'before-replay');
  assertEquals(supabase.selectCounts.flows, 1);
  assertEquals(supabase.updatePayloads, [{ table: 'flows', values: { search_text: searchText } }]);
  assertEquals(
    supabase.rpcCalls.some(
      (call) =>
        call.fn === 'cmd_dataset_extraction_record_failure' ||
        call.fn.includes('embedding') ||
        (call.fn === 'cmd_dataset_extraction_ack' &&
          JSON.stringify(call.args).includes('extracted_md')),
    ),
    false,
  );
});

Deno.test('missing or expired dataset identities are ACKed as stale no-ops', async () => {
  const supabase = new FakeSupabase();
  supabase.rows.contacts = [
    {
      id: '97000000-0000-0000-0000-000000000020',
      version: '02.00.000',
      json_ordered: FIXTURES.contact,
    },
  ];
  supabase.claimedJobs = [
    buildJob(20, 'contact', 'contacts', '97000000-0000-0000-0000-000000000020', '01.00.000'),
  ];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
  });

  assertEquals(result.results[0].status, 'stale');
  assertEquals(result.acked, 1);
  assertEquals(
    supabase.rpcCalls.some((call) => call.fn === 'cmd_dataset_extraction_record_failure'),
    false,
  );
});

Deno.test('wrong table/entity combinations are terminal unsupported jobs', async () => {
  const supabase = new FakeSupabase();
  supabase.claimedJobs = [buildJob(30, 'source', 'contacts')];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
  });

  assertEquals(result.acked, 0);
  assertEquals(result.results[0].status, 'unsupported');
  assertEquals(result.results[0].error_code, 'UNSUPPORTED_ENTITY_KIND');
  assertEquals(supabase.rpcCalls.at(-1)?.fn, 'cmd_dataset_extraction_record_failure');
});

Deno.test('transient generator failures remain visible for retry', async () => {
  const supabase = new FakeSupabase();
  const id = '97000000-0000-0000-0000-000000000040';
  supabase.rows.sources = [{ id, version: '01.00.000', json_ordered: FIXTURES.source }];
  supabase.claimedJobs = [buildJob(40, 'source', 'sources', id)];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
    markdownGenerators: {
      source: () => {
        throw new Error('temporary failure');
      },
    },
  });

  assertEquals(result.results[0].status, 'retry');
  assertEquals(result.acked, 0);
  assertEquals(
    supabase.rpcCalls.some((call) => call.fn === 'cmd_dataset_extraction_record_failure'),
    false,
  );
});

Deno.test('max-read generator failures are recorded and removed', async () => {
  const supabase = new FakeSupabase();
  const id = '97000000-0000-0000-0000-000000000050';
  supabase.rows.unitgroups = [{ id, version: '01.00.000', json_ordered: FIXTURES.unitgroup }];
  supabase.claimedJobs = [
    buildJob(50, 'unitgroup', 'unitgroups', id, '01.00.000', 'extracted_md', 5),
  ];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
    maxReadCount: 5,
    markdownGenerators: {
      unitgroup: () => {
        throw new Error('terminal failure');
      },
    },
  });

  assertEquals(result.results[0].status, 'failed');
  assertEquals(supabase.rpcCalls.at(-1)?.fn, 'cmd_dataset_extraction_record_failure');
});

Deno.test(
  'unsupported extraction kinds fail; Process extracted_md jobs require an injected Markdown generator',
  async () => {
    const supabase = new FakeSupabase();
    supabase.claimedJobs = [
      buildJob(60, 'flow', 'flows', undefined, '01.00.000', 'legacy_kind'),
      buildJob(61, 'process', 'processes'),
    ];

    const result = await processDatasetExtractionJobs({
      supabase: supabase as unknown as SupabaseClient,
    });

    assertEquals(
      result.results.map((item) => item.status),
      ['unsupported', 'unsupported'],
    );
    assertEquals(
      result.results.map((item) => item.error_code),
      ['UNSUPPORTED_EXTRACTION_KIND', 'UNSUPPORTED_ENTITY_KIND'],
    );
    assertEquals(
      result.results[1].error_message,
      'No extracted_md generator registered for process',
    );
  },
);

Deno.test('flow extraction helpers retain string json_ordered compatibility', () => {
  const parsed = normalizeJsonOrdered(JSON.stringify(FIXTURES.flow));
  const markdown = generateFlowMarkdown(parsed);

  assertStringIncludes(markdown, '# Test flow');
  assertStringIncludes(markdown, '**Version:** 01.00.000');
});

Deno.test(
  'late generation loses the row-version race and reads the current body before ACK',
  async () => {
    const supabase = new FakeSupabase();
    const id = '97000000-0000-0000-0000-000000000001';
    const first = FIXTURES.flow!;
    const latest = JSON.parse(JSON.stringify(first).replaceAll('Test flow', 'Third edit'));
    const row = { id, version: '01.00.000', xmin: '11', json_ordered: first, extracted_md: '' };
    supabase.rows.flows = [row];
    supabase.claimedJobs = [buildJob(101, 'flow', 'flows', id)];
    const result = await processDatasetExtractionJobs({
      supabase: supabase as unknown as SupabaseClient,
      markdownGenerator: (input) => {
        if (row.xmin === '11') {
          row.json_ordered = latest;
          row.xmin = '13';
          row.extracted_md = generateFlowMarkdown(latest);
        }
        return generateFlowMarkdown(input);
      },
    });
    assertEquals(supabase.selectCounts.flows, 2);
    assertEquals(row.extracted_md, generateFlowMarkdown(latest));
    assertEquals(result.acked, 1);
    assertEquals(supabase.rpcCalls.at(-1)?.args, { p_msg_ids: [101] });
  },
);

Deno.test(
  'a late legacy webhook projects the stored version even when its payload body is obsolete',
  async () => {
    const client = new FakeSupabase();
    const id = '97000000-0000-0000-0000-000000000001';
    const version = '01.00.000';
    client.rows.flows = [{ id, version, json_ordered: FIXTURES.flow }];
    const previous = Deno.env.get('REMOTE_SERVICE_API_KEY');
    try {
      Deno.env.set('REMOTE_SERVICE_API_KEY', 'synthetic-extraction-service-key');
      const req = new Request('http://localhost/webhook_flow_embedding_ft', {
        method: 'POST',
        headers: { apikey: 'synthetic-extraction-service-key' },
        body: JSON.stringify({
          type: 'UPDATE',
          table: 'flows',
          record: { id, version, json_ordered: { obsolete: true } },
        }),
      });
      const response = await handleExtractionWebhook(
        req,
        'flows',
        generateFlowMarkdown,
        projectFlowSearchText,
        client as unknown as SupabaseClient,
      );
      assertEquals(response.status, 200);
      assertEquals(client.rows.flows[0].extracted_md, generateFlowMarkdown(FIXTURES.flow));
      assertEquals(client.rows.flows[0].search_text, projectFlowSearchText(FIXTURES.flow, id));
    } finally {
      if (previous === undefined) Deno.env.delete('REMOTE_SERVICE_API_KEY');
      else Deno.env.set('REMOTE_SERVICE_API_KEY', previous);
    }
  },
);
