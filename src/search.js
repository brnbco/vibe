import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { getConfig } from './config.js';

const DEFAULT_TOP_K = 5;
const KEYWORD_BOOST = 0.15;
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

export async function searchOntology(query, topK = DEFAULT_TOP_K) {
  const cfg    = getConfig();
  const openai = new OpenAI({ apiKey: cfg.openai.apiKey });
  const pc     = new Pinecone({ apiKey: cfg.pinecone.apiKey });
  const index  = pc.index(cfg.pinecone.indexName).namespace(cfg.warehouseType);

  const resp = await openai.embeddings.create({
    model: cfg.openai.embedModel,
    input: query,
  });
  const vector = resp.data[0].embedding;

  const results = await index.query({
    vector,
    topK: topK * FETCH_MULTIPLIER,
    includeMetadata: true,
  });

  const queryTokens = tokenize(query);

  const ranked = (results.matches || []).map(m => {
    const base = m.score;
    const boost = keywordBoost({
      database: m.metadata.database,
      schema:   m.metadata.schema,
      table:    m.metadata.table,
    }, queryTokens);
    return {
      id:       m.id,
      score:    base + boost,
      database: m.metadata.database,
      schema:   m.metadata.schema,
      table:    m.metadata.table,
      kind:     m.metadata.kind,
      ddl:      m.metadata.ddl,
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, topK);
}
