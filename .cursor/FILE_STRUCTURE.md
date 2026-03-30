# File Structure

```
.
├── src/
│   ├── index.js        CLI entry point & orchestrator (crawl | index | query | pipeline)
│   ├── config.js       Loads .env, exports validated config (warehouse-type-aware)
│   ├── snowflake.js    Snowflake connection helpers (key-pair / password auth)
│   ├── bigquery.js     BigQuery client helpers (service-account key auth)
│   ├── crawl.js        Topology crawler — dispatches to Snowflake or BigQuery
│   ├── embed.js        Vectorizes topology via OpenAI embeddings, upserts to Pinecone
│   ├── search.js       Semantic search against Pinecone — returns ontology context
│   ├── compile.js      Ontology context + question → executable SQL (dialect-aware)
│   └── execute.js      Runs generated SQL against active warehouse, formats results
├── data/
│   └── topology.json   (generated) Cached crawl output — gitignored
├── env.sample          Template for .env credentials
├── package.json        ESM project, deps: snowflake-sdk, @google-cloud/bigquery, pinecone, openai, dotenv
├── .nvmrc              Node 22.14.0
└── .gitignore
```

## Pipeline

```
crawl → topology.json → embed → Pinecone index → query → ontology matches → compile → SQL → execute → results
```

## Warehouse Support

| Feature          | Snowflake            | BigQuery               |
|------------------|----------------------|------------------------|
| Auth             | Key-pair or password | Service account key    |
| Crawl hierarchy  | DB → Schema → Table  | Project → Dataset → Table |
| SQL dialect      | Snowflake SQL        | BigQuery Standard SQL  |
| Config switch    | `WAREHOUSE_TYPE=snowflake` | `WAREHOUSE_TYPE=bigquery` |
