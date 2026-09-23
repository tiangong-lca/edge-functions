export class HybridSearchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HybridSearchRequestError';
  }
}

export interface HybridSearchClientRequest {
  queryText: string;
  versionScope: 'latest' | 'matched';
  rpcOptions: HybridSearchRpcOptions;
  visibilityOptions: HybridSearchVisibilityOptions;
  entityFilterOptions: HybridSearchEntityFilterOptions;
  openDataOptions: HybridSearchOpenDataOptions;
  openDataFilterRequested: boolean;
}

export interface HybridSearchOpenDataOptions {
  source_filter: 'all' | 'literature' | 'enterprise';
  publication_filter: 'all' | 'published' | 'unpublished';
}

export interface HybridSearchRpcOptions {
  filter_condition: Record<string, unknown>;
  match_threshold: number;
  match_count: number;
  lexical_weight: number;
  semantic_weight: number;
  rrf_k: number;
  data_source: string;
  page_size: number;
  page_current: number;
}

export interface HybridSearchRpcRequest extends HybridSearchRpcOptions {
  query_text: string;
  query_terms: string[];
  query_embedding: string;
}

export interface HybridSearchVisibilityOptions {
  state_code_filter: number | null;
  team_id_filter: string | null;
}

export interface HybridSearchEntityFilterOptions {
  type_of_data_set_filter: string | null;
}

export type HybridSearchRpcPayload = HybridSearchRpcRequest &
  Partial<HybridSearchVisibilityOptions> &
  Partial<HybridSearchEntityFilterOptions>;

export type OpenDataHybridSearchRpcPayload = Omit<HybridSearchRpcRequest, 'data_source'> & {
  p_dataset_kind: string;
  source_filter: HybridSearchOpenDataOptions['source_filter'];
  publication_filter: HybridSearchOpenDataOptions['publication_filter'];
};

const VALID_DATA_SOURCES = new Set(['tg', 'co', 'my', 'te', 'ex']);
const VALID_OPEN_DATA_SOURCE_FILTERS = new Set(['all', 'literature', 'enterprise']);
const VALID_OPEN_DATA_PUBLICATION_FILTERS = new Set(['all', 'published', 'unpublished']);
const VALID_PROCESS_TYPES = new Set([
  'Unit process, single operation',
  'Unit process, black box',
  'LCI result',
  'Partly terminated system',
  'Avoided product system',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseNumber(value: unknown, fieldName: string, fallback: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;

  if (!Number.isFinite(parsed)) {
    throw new HybridSearchRequestError(`${fieldName} must be a finite number`);
  }

  return parsed;
}

function parsePositiveInteger(value: unknown, fieldName: string, fallback: number): number {
  const parsed = parseNumber(value, fieldName, fallback);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HybridSearchRequestError(`${fieldName} must be a positive integer`);
  }

  return parsed;
}

function parseNonNegativeNumber(value: unknown, fieldName: string, fallback: number): number {
  const parsed = parseNumber(value, fieldName, fallback);

  if (parsed < 0) {
    throw new HybridSearchRequestError(`${fieldName} must be greater than or equal to 0`);
  }

  return parsed;
}

function parseMatchThreshold(value: unknown): number {
  const parsed = parseNumber(value, 'match_threshold', 0.5);

  if (parsed < 0 || parsed > 1) {
    throw new HybridSearchRequestError('match_threshold must be between 0 and 1');
  }

  return parsed;
}

function parseDataSource(value: unknown): string {
  const dataSource = value === undefined || value === null || value === '' ? 'tg' : String(value);

  if (!VALID_DATA_SOURCES.has(dataSource)) {
    throw new HybridSearchRequestError('data_source must be one of tg, co, my, te, or ex');
  }

  return dataSource;
}

function parseNullableStateCode(value: unknown, dataSource: string): number | null {
  if (dataSource === 'ex') {
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      value === 'all' ||
      value === -1 ||
      value === '-1'
    ) {
      return -1;
    }
    throw new HybridSearchRequestError('example data requires state_code -1');
  }
  if (value === undefined || value === null || value === '' || value === 'all') {
    return null;
  }

  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HybridSearchRequestError('state_code must be a non-negative integer');
  }
  return parsed;
}

function parseNullableTeamId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const teamId = typeof value === 'string' ? value.trim() : '';
  if (!UUID_PATTERN.test(teamId)) {
    throw new HybridSearchRequestError('team_id must be a UUID');
  }
  return teamId;
}

function parseNullableProcessType(value: unknown): string | null {
  if (value === undefined || value === null || value === '' || value === 'all') {
    return null;
  }

  const processType = typeof value === 'string' ? value.trim() : '';
  if (!VALID_PROCESS_TYPES.has(processType)) {
    throw new HybridSearchRequestError('type_of_data_set is not a supported Process dataset type');
  }
  return processType;
}

function parseOpenDataSourceFilter(value: unknown): HybridSearchOpenDataOptions['source_filter'] {
  const normalized = value === undefined || value === null || value === '' ? 'all' : String(value);
  if (!VALID_OPEN_DATA_SOURCE_FILTERS.has(normalized)) {
    throw new HybridSearchRequestError(
      'source_filter must be one of all, literature, or enterprise',
    );
  }
  return normalized as HybridSearchOpenDataOptions['source_filter'];
}

function parseOpenDataPublicationFilter(
  value: unknown,
): HybridSearchOpenDataOptions['publication_filter'] {
  const normalized = value === undefined || value === null || value === '' ? 'all' : String(value);
  if (!VALID_OPEN_DATA_PUBLICATION_FILTERS.has(normalized)) {
    throw new HybridSearchRequestError(
      'publication_filter must be one of all, published, or unpublished',
    );
  }
  return normalized as HybridSearchOpenDataOptions['publication_filter'];
}

function normalizeFilterCondition(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === '') {
    return {};
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        throw new HybridSearchRequestError('filter_condition must be a JSON object');
      }
      return parsed;
    } catch (error) {
      if (error instanceof HybridSearchRequestError) {
        throw error;
      }
      throw new HybridSearchRequestError('filter_condition must be a valid JSON object string');
    }
  }

  if (!isRecord(value)) {
    throw new HybridSearchRequestError('filter_condition must be a JSON object');
  }

  return value;
}

export function parseHybridSearchClientRequest(body: unknown): HybridSearchClientRequest {
  if (!isRecord(body)) {
    throw new HybridSearchRequestError('request body must be a JSON object');
  }

  const query = body.query;
  if (query === undefined || query === null || query === '') {
    throw new HybridSearchRequestError('Missing query');
  }

  const queryText = typeof query === 'string' ? query.trim() : String(query).trim();
  if (!queryText) {
    throw new HybridSearchRequestError('Missing query');
  }

  const filterInput = body.filter_condition ?? body.filter;
  const versionScope = body.version_scope ?? 'latest';
  if (versionScope !== 'latest' && versionScope !== 'matched') {
    throw new HybridSearchRequestError('version_scope must be latest or matched');
  }
  const matchCount = parsePositiveInteger(
    body.match_count,
    'match_count',
    versionScope === 'matched' ? 200 : 20,
  );
  if (versionScope === 'matched' && matchCount !== 200) {
    throw new HybridSearchRequestError('matched version search uses 200 candidates per branch');
  }

  const dataSource = parseDataSource(body.data_source);
  const openDataFilterRequested =
    Object.hasOwn(body, 'source_filter') || Object.hasOwn(body, 'publication_filter');
  const openDataOptions: HybridSearchOpenDataOptions = {
    source_filter: parseOpenDataSourceFilter(body.source_filter),
    publication_filter: parseOpenDataPublicationFilter(body.publication_filter),
  };
  if (openDataFilterRequested && dataSource !== 'tg') {
    throw new HybridSearchRequestError('Open Data filters require data_source tg');
  }

  return {
    queryText,
    versionScope,
    rpcOptions: {
      filter_condition: normalizeFilterCondition(filterInput),
      match_threshold: parseMatchThreshold(body.match_threshold),
      match_count: matchCount,
      lexical_weight: parseNonNegativeNumber(body.lexical_weight, 'lexical_weight', 0.5),
      semantic_weight: parseNonNegativeNumber(body.semantic_weight, 'semantic_weight', 0.5),
      rrf_k: parsePositiveInteger(body.rrf_k, 'rrf_k', 10),
      data_source: dataSource,
      page_size: parsePositiveInteger(body.page_size, 'page_size', 10),
      page_current: parsePositiveInteger(body.page_current, 'page_current', 1),
    },
    visibilityOptions: {
      state_code_filter: parseNullableStateCode(body.state_code, dataSource),
      team_id_filter: parseNullableTeamId(body.team_id),
    },
    entityFilterOptions: {
      type_of_data_set_filter: parseNullableProcessType(body.type_of_data_set),
    },
    openDataOptions,
    openDataFilterRequested,
  };
}

export function buildOpenDataHybridSearchRpcRequest(
  datasetKind: string,
  queryText: string,
  queryTerms: string[],
  queryEmbedding: string,
  options: HybridSearchRpcOptions,
  openDataOptions: HybridSearchOpenDataOptions,
  entityFilterOptions?: HybridSearchEntityFilterOptions,
): OpenDataHybridSearchRpcPayload {
  const filterCondition = entityFilterOptions?.type_of_data_set_filter
    ? {
        ...options.filter_condition,
        typeOfDataSet: entityFilterOptions.type_of_data_set_filter,
      }
    : options.filter_condition;
  return {
    p_dataset_kind: datasetKind,
    query_text: queryText,
    query_terms: queryTerms,
    query_embedding: queryEmbedding,
    filter_condition: filterCondition,
    match_threshold: options.match_threshold,
    match_count: options.match_count,
    lexical_weight: options.lexical_weight,
    semantic_weight: options.semantic_weight,
    rrf_k: options.rrf_k,
    page_size: options.page_size,
    page_current: options.page_current,
    source_filter: openDataOptions.source_filter,
    publication_filter: openDataOptions.publication_filter,
  };
}

export function buildHybridSearchRpcRequest(
  queryText: string,
  queryTerms: string[],
  queryEmbedding: string,
  options: HybridSearchRpcOptions,
  visibilityOptions?: HybridSearchVisibilityOptions,
  entityFilterOptions?: HybridSearchEntityFilterOptions,
): HybridSearchRpcPayload {
  const request: HybridSearchRpcRequest = {
    query_text: queryText,
    query_terms: queryTerms,
    query_embedding: queryEmbedding,
    ...options,
  };
  return {
    ...request,
    ...(visibilityOptions ?? {}),
    ...(entityFilterOptions ?? {}),
  };
}
