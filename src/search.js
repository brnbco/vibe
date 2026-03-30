import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { getConfig } from './config.js';

const DEFAULT_TOP_K = 10;

export async function searchOntology(query, topK = DEFAULT_TOP_K) {
  const cfg    = getConfig();
  const openai = new OpenAI({ apiKey: cfg.openai.apiKey });
  const pc     = new Pinecone({ apiKey: cfg.pinecone.apiKey });
  const index  = pc.index(cfg.pinecone.indexName);

  const resp = await openai.embeddings.create({
    model: cfg.openai.embedModel,
    input: query,
  });
  const vector = resp.data[0].embedding;

  const results = await index.query({
    vector,
    topK,
    includeMetadata: true,
  });

  return (results.matches || []).map(m => ({
    id:       m.id,
    score:    m.score,
    database: m.metadata.database,
    schema:   m.metadata.schema,
    table:    m.metadata.table,
    kind:     m.metadata.kind,
    ddl:      m.metadata.ddl,
  }));
}
