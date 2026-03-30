# File Structure

```
.
├── src/
│   ├── index.js        CLI entry point & orchestrator (crawl | index | query | pipeline)
│   ├── config.js       Loads .env, exports validated config object
│   ├── snowflake.js    Snowflake connection helpers (connect, execute, destroy)
│   ├── crawl.js        Warehouse topology crawler (databases → schemas → tables → columns)
│   ├── embed.js        Vectorizes topology via OpenAI embeddings, upserts to Pinecone
│   ├── search.js       Semantic search against Pinecone — returns ontology context
│   ├── compile.js      Ontology context + question → executable Snowflake SQL (via OpenAI)
│   └── execute.js      Runs generated SQL against Snowflake, formats results
├── data/
│   └── topology.json   (generated) Cached crawl output — gitignored
├── env.sample          Template for .env credentials
├── package.json        ESM project, dependencies: snowflake-sdk, pinecone, openai, dotenv
├── .nvmrc              Node 22.14.0
└── .gitignore
```

## Pipeline

```
crawl → topology.json → embed → Pinecone index → query → ontology matches → compile → SQL → execute → results
```
