import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { getConfig } from './config.js';

const BATCH_SIZE = 50;
const EMBED_DIM  = 1536;

function tableToText(db, schema, table) {
  const fqn = `${db}.${schema}.${table.name}`;
  const cols = table.columns.map(c => {
    const nullable = c.nullable ? '' : ', NOT NULL';
    const comment  = c.comment ? ` — ${c.comment}` : '';
    return `  - ${c.name} (${c.type}${nullable})${comment}`;
  }).join('\n');

  return [
    `Table: ${fqn}`,
    `Type: ${table.kind}`,
    table.rows ? `Approximate Rows: ${table.rows}` : null,
    `Columns:`,
    cols,
  ].filter(Boolean).join('\n');
}

function tableToId(db, schema, table) {
  return `${db}.${schema}.${table}`;
}

async function ensureIndex(pc, cfg) {
  const { indexName, cloud, region } = cfg.pinecone;
  const list = await pc.listIndexes();
  if (list.indexes?.find(i => i.name === indexName)) return;

  console.log(`  creating Pinecone index "${indexName}" (${cloud}/${region}, dim=${EMBED_DIM})…`);
  await pc.createIndex({
    name: indexName,
    dimension: EMBED_DIM,
    metric: 'cosine',
    spec: { serverless: { cloud, region } },
    waitUntilReady: true,
  });
  console.log(`  ✓ index created`);
}

export async function indexTopology(topology) {
  const cfg = getConfig();

  if (!topology) {
    const raw = readFileSync('data/topology.json', 'utf-8');
    topology = JSON.parse(raw);
  }

  const namespace = topology.warehouseType || cfg.warehouseType;
  const openai = new OpenAI({ apiKey: cfg.openai.apiKey });
  const pc     = new Pinecone({ apiKey: cfg.pinecone.apiKey });
  await ensureIndex(pc, cfg);
  const index  = pc.index(cfg.pinecone.indexName).namespace(namespace);
  console.log(`  namespace: ${namespace}`);

  const records = [];
  for (const db of topology.databases) {
    for (const schema of db.schemas) {
      for (const table of schema.tables) {
        const ddl = tableToText(db.name, schema.name, table);
        records.push({
          id:       tableToId(db.name, schema.name, table.name),
          ddl,
          metadata: {
            database: db.name,
            schema:   schema.name,
            table:    table.name,
            kind:     table.kind,
            ddl,
          },
        });
      }
    }
  }

  console.log(`  ${records.length} table(s) to embed`);

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const texts = batch.map(r => r.ddl);

    const resp = await openai.embeddings.create({
      model: cfg.openai.embedModel,
      input: texts,
    });

    const vectors = batch.map((rec, j) => ({
      id:       rec.id,
      values:   resp.data[j].embedding,
      metadata: rec.metadata,
    }));

    await index.upsert(vectors);
    console.log(`  ✓ upserted ${i + batch.length}/${records.length}`);
  }

  console.log(`\n✓ Indexing complete — ${records.length} vectors in "${cfg.pinecone.indexName}"`);
}
