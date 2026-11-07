import { assert, assertEquals, assertMatch, assertRejects } from 'jsr:@std/assert';
import {
  InvokeEndpointCommand,
  SageMakerRuntimeClient,
  ValidationError,
} from '@aws-sdk/client-sagemaker-runtime';
import OpenAI from '@openai/openai';

import {
  buildPortalOpenAIChatParameters,
  portalOpenAIStructuredOutput,
  type PortalOpenAIStructuredRequest,
} from '../supabase/functions/_shared/portal_openai_structured.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const credentials = {
  accessKeyId: 'AKIDSDKWIREFIXTURE',
  secretAccessKey: 'synthetic-sdk-wire-secret',
  sessionToken: 'synthetic-sdk-wire-session',
};

interface SignedSdkRequest {
  method: string;
  protocol: string;
  hostname: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

function embeddingCommand() {
  return new InvokeEndpointCommand({
    EndpointName: 'offline-wire-fixture',
    ContentType: 'application/json',
    Accept: 'application/json',
    Body: encoder.encode(JSON.stringify({ inputs: 'steel 钢' })),
  });
}

// This exercises installed SDK middleware, not the application's kernel wiring.
Deno.test(
  'installed SageMaker SDK signs and serializes bytes and decodes endpoint bytes',
  async () => {
    let calls = 0;
    const expectedBody = encoder.encode(JSON.stringify({ embedding: [0.25, 0.5] }));
    const client = new SageMakerRuntimeClient({
      region: 'us-east-1',
      credentials,
      // OS user-agent discovery is outside this offline transport fixture.
      defaultUserAgentProvider: () => Promise.resolve([['sdk-wire-fixture', '1']]),
      maxAttempts: 1,
      requestHandler: {
        handle(request: SignedSdkRequest) {
          calls += 1;
          assertEquals(request.method, 'POST');
          assertEquals(request.protocol, 'https:');
          assertEquals(request.hostname, 'runtime.sagemaker.us-east-1.amazonaws.com');
          assertEquals(request.path, '/endpoints/offline-wire-fixture/invocations');
          assertEquals(request.headers['content-type'], 'application/json');
          assertEquals(request.headers.accept, 'application/json');
          assertEquals(request.headers['x-amz-security-token'], credentials.sessionToken);
          assertMatch(request.headers['x-amz-date'], /^\d{8}T\d{6}Z$/u);
          assertMatch(
            request.headers.authorization,
            /^AWS4-HMAC-SHA256 Credential=AKIDSDKWIREFIXTURE\/\d{8}\/us-east-1\/sagemaker\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[a-f0-9]{64}$/u,
          );
          assert(request.body instanceof Uint8Array);
          assertEquals(request.body, encoder.encode(JSON.stringify({ inputs: 'steel 钢' })));
          return Promise.resolve({
            response: {
              statusCode: 200,
              headers: { 'content-type': 'application/json', 'x-amzn-requestid': 'wire-success' },
              body: expectedBody,
            },
          });
        },
      },
    });
    try {
      const response = await client.send(embeddingCommand());
      assertEquals(calls, 1);
      assertEquals(response.$metadata.httpStatusCode, 200);
      assertEquals(response.$metadata.requestId, 'wire-success');
      assertEquals(response.ContentType, 'application/json');
      assert(response.Body instanceof Uint8Array);
      assertEquals(response.Body, expectedBody);
      assertEquals(JSON.parse(decoder.decode(response.Body)), { embedding: [0.25, 0.5] });
    } finally {
      client.destroy();
    }
  },
);

Deno.test('installed SageMaker SDK maps a modeled HTTP rejection without retrying', async () => {
  let calls = 0;
  const client = new SageMakerRuntimeClient({
    region: 'us-east-1',
    credentials,
    defaultUserAgentProvider: () => Promise.resolve([['sdk-wire-fixture', '1']]),
    maxAttempts: 1,
    requestHandler: {
      handle() {
        calls += 1;
        return Promise.resolve({
          response: {
            statusCode: 400,
            headers: {
              'content-type': 'application/json',
              'x-amzn-errortype': 'ValidationError',
              'x-amzn-requestid': 'wire-rejection',
            },
            body: encoder.encode(JSON.stringify({ Message: 'synthetic invalid endpoint input' })),
          },
        });
      },
    },
  });
  try {
    const error = await assertRejects(
      () => client.send(embeddingCommand()),
      ValidationError,
      'synthetic invalid endpoint input',
    );
    assertEquals(error.$metadata.httpStatusCode, 400);
    assertEquals(error.$metadata.requestId, 'wire-rejection');
    assertEquals(calls, 1);
  } finally {
    client.destroy();
  }
});

Deno.test('installed SageMaker SDK forwards cancellation to a pending transport', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let abortObserved = false;
  let calls = 0;
  const client = new SageMakerRuntimeClient({
    region: 'us-east-1',
    credentials,
    defaultUserAgentProvider: () => Promise.resolve([['sdk-wire-fixture', '1']]),
    maxAttempts: 1,
    requestHandler: {
      handle(_request: unknown, options?: { abortSignal?: unknown }): Promise<never> {
        calls += 1;
        const signal = options?.abortSignal;
        assert(signal instanceof AbortSignal);
        assertEquals(signal, controller.signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              abortObserved = true;
              reject(new DOMException('synthetic transport aborted', 'AbortError'));
            },
            { once: true },
          );
          started.resolve();
        });
      },
    },
  });
  try {
    const result = client.send(embeddingCommand(), { abortSignal: controller.signal });
    const rejected = assertRejects(() => result, Error);
    await Promise.race([
      started.promise,
      rejected.then(() => {
        throw new Error('SDK rejected before reaching the pending transport');
      }),
    ]);
    controller.abort();
    const error = await rejected;
    assertEquals(error.name, 'AbortError');
    assertEquals(abortObserved, true);
    assertEquals(calls, 1);
  } finally {
    controller.abort();
    client.destroy();
  }
});

const portalRequest: PortalOpenAIStructuredRequest = {
  schemaName: 'offline_wire_output',
  schema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  systemPrompt: 'Return the fixture value.',
  userPrompt: 'steel 钢',
};

function portalProvider(suffix: string) {
  return {
    apiKey: `sk-synthetic-wire-${suffix}`,
    model: 'configured-wire-model',
    baseUrl: `https://${suffix}.invalid/v1`,
  };
}

function responsesOutput(text: string) {
  return Response.json({
    id: 'offline-response',
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
  });
}

Deno.test(
  'Portal OpenAI helper uses real SDK wire auth and bounded Responses controls',
  async () => {
    const previousFetch = globalThis.fetch;
    const provider = portalProvider('portal-controls');
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      calls += 1;
      const request = new Request(input, init);
      assertEquals(request.url, `${provider.baseUrl}/responses`);
      assertEquals(request.method, 'POST');
      assertEquals(request.headers.get('authorization'), `Bearer ${provider.apiKey}`);
      assertEquals(request.headers.get('content-type'), 'application/json');
      const bodyText = await request.text();
      assertEquals(bodyText.includes(provider.apiKey), false);
      assertEquals(JSON.parse(bodyText), {
        model: provider.model,
        temperature: 0,
        store: false,
        max_output_tokens: 256,
        reasoning: { effort: 'none' },
        input: [
          { role: 'system', content: portalRequest.systemPrompt },
          { role: 'user', content: portalRequest.userPrompt },
        ],
        text: {
          verbosity: 'low',
          format: {
            type: 'json_schema',
            name: portalRequest.schemaName,
            schema: portalRequest.schema,
            strict: true,
          },
        },
      });
      return responsesOutput('{"value":"steel 钢"}');
    };
    try {
      assertEquals(await portalOpenAIStructuredOutput(portalRequest, provider), {
        value: 'steel 钢',
      });
      assertEquals(calls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);

Deno.test(
  'Portal OpenAI helper rejects HTTP and malformed output without API fallback',
  async () => {
    const previousFetch = globalThis.fetch;
    const paths: string[] = [];
    let mode: 'http' | 'malformed' | 'empty' = 'http';
    globalThis.fetch = (input, init) => {
      paths.push(new URL(new Request(input, init).url).pathname);
      if (mode === 'http') {
        return Promise.resolve(
          Response.json(
            {
              error: { message: 'synthetic unsupported input', type: 'invalid_request_error' },
            },
            { status: 400 },
          ),
        );
      }
      return Promise.resolve(responsesOutput(mode === 'malformed' ? 'not-json' : ''));
    };
    try {
      const provider = portalProvider('portal-errors');
      const error = await assertRejects(
        () => portalOpenAIStructuredOutput(portalRequest, provider),
        OpenAI.BadRequestError,
        'synthetic unsupported input',
      );
      assertEquals(error.status, 400);
      mode = 'malformed';
      await assertRejects(
        () => portalOpenAIStructuredOutput(portalRequest, provider),
        Error,
        'OpenAI output is not valid JSON',
      );
      mode = 'empty';
      await assertRejects(
        () => portalOpenAIStructuredOutput(portalRequest, provider),
        Error,
        'OpenAI response did not contain output text',
      );
      assertEquals(paths, ['/v1/responses', '/v1/responses', '/v1/responses']);
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);

Deno.test('Portal OpenAI helper aborts real SDK transport without Chat fallback', async () => {
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const paths: string[] = [];
  let abortObserved = false;
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    paths.push(new URL(request.url).pathname);
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener(
        'abort',
        () => {
          abortObserved = true;
          reject(new DOMException('synthetic fetch aborted', 'AbortError'));
        },
        { once: true },
      );
      started.resolve();
    });
  };
  try {
    const result = portalOpenAIStructuredOutput(
      { ...portalRequest, signal: controller.signal },
      portalProvider('portal-abort'),
    );
    const rejected = assertRejects(() => result, OpenAI.APIUserAbortError);
    await Promise.race([
      started.promise,
      rejected.then(() => {
        throw new Error('SDK rejected before reaching the pending transport');
      }),
    ]);
    controller.abort();
    await rejected;
    assertEquals(abortObserved, true);
    assertEquals(paths, ['/v1/responses']);
  } finally {
    controller.abort();
    globalThis.fetch = previousFetch;
  }
});

// Capability proof only: the installed SDK exposes Responses, so this does not
// claim execution of the helper's branch for SDKs without Responses.
Deno.test('installed OpenAI Chat capability serializes the Portal parameter builder', async () => {
  const provider = portalProvider('portal-chat-capability');
  let calls = 0;
  const client = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl,
    fetch: async (input, init) => {
      calls += 1;
      const request = new Request(input, init);
      assertEquals(request.url, `${provider.baseUrl}/chat/completions`);
      assertEquals(request.headers.get('authorization'), `Bearer ${provider.apiKey}`);
      assertEquals(JSON.parse(await request.text()), {
        model: provider.model,
        temperature: 0,
        store: false,
        max_completion_tokens: 256,
        reasoning_effort: 'none',
        verbosity: 'low',
        messages: [
          { role: 'system', content: portalRequest.systemPrompt },
          { role: 'user', content: portalRequest.userPrompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: portalRequest.schemaName,
            schema: portalRequest.schema,
            strict: true,
          },
        },
      });
      return Response.json({
        id: 'offline-chat',
        object: 'chat.completion',
        created: 0,
        model: provider.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '{"value":"steel"}' },
            finish_reason: 'stop',
          },
        ],
      });
    },
  });
  const result = await client.chat.completions.create(
    buildPortalOpenAIChatParameters(portalRequest, provider),
  );
  assertEquals(result.choices[0].message.content, '{"value":"steel"}');
  assertEquals(calls, 1);
});
