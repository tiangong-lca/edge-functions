import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.112.4';

import {
  executeReviewerContactCommand,
  parseReviewerContactCommand,
} from '../supabase/functions/_shared/commands/reviewer_contact.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONTACT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';

const validContact = {
  contactDataSet: {
    '@xmlns:common': 'http://lca.jrc.it/ILCD/Common',
    '@xmlns': 'http://lca.jrc.it/ILCD/Contact',
    '@xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    '@version': '1.1',
    '@xsi:schemaLocation': 'http://lca.jrc.it/ILCD/Contact ../../schemas/ILCD_ContactDataSet.xsd',
    contactInformation: {
      dataSetInformation: {
        'common:UUID': CONTACT_ID,
        'common:shortName': [{ '@xml:lang': 'en', '#text': 'Reviewer' }],
        'common:name': [{ '@xml:lang': 'en', '#text': 'Reviewer Profile' }],
        classificationInformation: {
          'common:classification': {
            'common:class': {
              '@level': '0',
              '@classId': '1',
              '#text': 'Group of organisations, project',
            },
          },
        },
      },
    },
    administrativeInformation: {
      dataEntryBy: {
        'common:timeStamp': '2026-09-24T00:00:00Z',
        'common:referenceToDataSetFormat': {
          '@refObjectId': 'a97a0155-0234-4b87-b4ce-a45da52f2a40',
          '@type': 'source data set',
          '@uri': '../sources/a97a0155-0234-4b87-b4ce-a45da52f2a40.xml',
          '@version': '03.00.003',
          'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'ILCD format' }],
        },
      },
      publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
    },
  },
};

class FakeSupabase {
  calls: Array<{ fn: string; args: any }> = [];
  rpc(fn: string, args: any) {
    this.calls.push({ fn, args: structuredClone(args) });
    return Promise.resolve({
      data: { ok: true, data: { dataset: { state_code: 100 }, bound: true } },
      error: null,
    });
  }
}

function actor(client: FakeSupabase) {
  return {
    userId: USER_ID,
    accessToken: 'token',
    supabase: client as unknown as SupabaseClient,
  };
}

Deno.test('reviewer contact parser requires source version for version creation', () => {
  const result = parseReviewerContactCommand({
    mode: 'createVersion',
    id: CONTACT_ID,
    jsonOrdered: validContact,
    operationId: OPERATION_ID,
  });
  assertEquals(result.ok, false);
});

Deno.test('reviewer contact activation validates and forces self ownership', async () => {
  const client = new FakeSupabase();
  const result = await executeReviewerContactCommand(
    {
      mode: 'create',
      id: CONTACT_ID,
      jsonOrdered: validContact,
      operationId: OPERATION_ID,
      expectedContact: null,
    },
    actor(client),
  );

  assertEquals(result.ok, true);
  assertEquals(client.calls[0].fn, 'cmd_review_contact_activate');
  assertEquals(
    client.calls[0].args.p_json_ordered.contactDataSet.administrativeInformation
      .publicationAndOwnership['common:referenceToOwnershipOfDataSet']['@refObjectId'],
    CONTACT_ID,
  );
  assertEquals(client.calls[0].args.p_bind, true);
});

Deno.test('reviewer contact activation rejects invalid contact before RPC', async () => {
  const client = new FakeSupabase();
  const result = await executeReviewerContactCommand(
    {
      mode: 'create',
      id: CONTACT_ID,
      jsonOrdered: { contactDataSet: {} },
      operationId: OPERATION_ID,
    },
    actor(client),
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, 'REVIEWER_CONTACT_INVALID');
  assertEquals(client.calls.length, 0);
});
