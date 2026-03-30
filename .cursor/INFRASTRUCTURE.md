# Infrastructure & Assets

| Name/ID            | Type        | Purpose                                    | Location/Path                  | Lifecycle  | Owner  | Date       | Notes                                      |
|--------------------|-------------|--------------------------------------------|--------------------------------|------------|--------|------------|--------------------------------------------|
| topology.json      | dataset     | Cached warehouse topology crawl            | data/topology.json             | temp       | —      | 2026-03-30 | Regenerate via `npm run crawl`             |
| semantic-compiler  | vector-index| Pinecone serverless index (cosine)         | Pinecone cloud (aws/us-east-1) | persistent | —      | 2026-03-30 | Created automatically on first `npm run index`. Dimension 1536 (text-embedding-3-small). |
| .env               | config      | Runtime credentials (never committed)      | .env                           | persistent | —      | 2026-03-30 | Copy from env.sample. Contains warehouse, Pinecone, OpenAI keys. |
| snowflake_key.p8   | key         | Snowflake key-pair auth private key        | snowflake_key.p8               | persistent | —      | 2026-03-30 | Gitignored. Generate via openssl. Register public key in Snowflake. |
| BQ SA key          | key         | BigQuery service account credentials       | (user-provided path)           | persistent | —      | 2026-03-30 | Set BIGQUERY_KEY_FILE in .env. Never commit. |
