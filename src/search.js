import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { getConfig } from './config.js';

const DEFAULT_TOP_K = 5;
const KEYWORD_BOOST = 0.15;
const DATASET_SCORE_FLOOR = 0.40;
const FETCH_MULTIPLIER = 3;

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t.length > 2);
}

function keywordBoost(match, queryTokens) {
  const haystack = [match.database, match.schema, match.table]
    .join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ');

  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) hits++;
  }
  return hits > 0 ? (hits / queryTokens.length) * KEYWORD_BOOST : 0;
}

function detectDatasets(queryTokens, semanticMatches) {
  const knownSchemas = new Set();
  for (const m of semanticMatches) {
    if (m.metadata?.schema) knownSchemas.add(m.metadata.schema);
  }

  const matched = new Set();
  for (const schema of knownSchemas) {
    const schemaTokens = schema.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/);
    for (const qt of queryTokens) {
      for (const st of schemaTokens) {
        if (st.includes(qt) || qt.includes(st)) {
          matched.add(schema);
        }
      }
    }
  }
  return [...matched];
}

function toResult(m) {
  return {
    id:       m.id,
    score:    m.score,
    database: m.metadata?.database ?? m.database,
    schema:   m.metadata?.schema ?? m.schema,
    table:    m.metadata?.table ?? m.table,
    kind:     m.metadata?.kind ?? m.kind,
    ddl:      m.metadata?.ddl ?? m.ddl,
  };
}

export async function searchOntology(query, topK = DEFAULT_TOP_K) {
  const cfg    = getConfig();
  const openai = new OpenAI({ apiKey: cfg.openai.apiKey });
  const pc     = new Pinecone({ apiKey: cfg.pinecone.apiKey });
  const namespace = cfg.pinecone.namespace || cfg.warehouseType;
  const index  = pc.index(cfg.pinecone.indexName).namespace(namespace);

  const resp = await openai.embeddings.create({
    model: cfg.openai.embedModel,
    input: query,
  });
  const vector = resp.data[0].embedding;

  const semanticResults = await index.query({
    vector,
    topK: topK * FETCH_MULTIPLIER,
    includeMetadata: true,
  });

  const queryTokens = tokenize(query);
  const matches = semanticResults.matches || [];

  const detectedDatasets = detectDatasets(queryTokens, matches);

  let datasetMatches = [];
  if (detectedDatasets.length > 0) {
    const fetches = detectedDatasets.map(schema =>
      index.query({
        vector,
        topK: 20,
        filter: { schema: { $eq: schema } },
        includeMetadata: true,
      })
    );
    const dsResults = await Promise.all(fetches);
    for (const res of dsResults) {
      datasetMatches.push(...(res.matches || []));
    }
  }

  const seen = new Map();

  for (const m of matches) {
    const r = toResult(m);
    r.score = m.score + keywordBoost({
      database: r.database, schema: r.schema, table: r.table,
    }, queryTokens);
    seen.set(r.id, r);
  }

  for (const m of datasetMatches) {
    if (seen.has(m.id)) continue;
    const r = toResult(m);
    r.score = Math.max(m.score, DATASET_SCORE_FLOOR) + keywordBoost({
      database: r.database, schema: r.schema, table: r.table,
    }, queryTokens);
    seen.set(r.id, r);
  }

  const all = [...seen.values()];
  all.sort((a, b) => b.score - a.score);

  const adjustedTopK = detectedDatasets.length > 0
    ? Math.max(topK, topK + datasetMatches.filter(m => !matches.find(s => s.id === m.id)).length)
    : topK;

  return all.slice(0, Math.min(adjustedTopK, topK + 5));
}
