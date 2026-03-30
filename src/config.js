import 'dotenv/config';

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}. Copy env.sample → .env and fill it in.`);
  return val;
};

const optional = (key, fallback) => process.env[key] || fallback;

function warehouseConfig(type) {
  if (type === 'snowflake') {
    return {
      account:        required('SNOWFLAKE_ACCOUNT'),
      username:       required('SNOWFLAKE_USERNAME'),
      warehouse:      required('SNOWFLAKE_WAREHOUSE'),
      role:           optional('SNOWFLAKE_ROLE', 'SYSADMIN'),
      privateKeyPath: optional('SNOWFLAKE_PRIVATE_KEY_PATH', null),
      password:       optional('SNOWFLAKE_PASSWORD', null),
      databases:      process.env.SNOWFLAKE_DATABASES
        ? process.env.SNOWFLAKE_DATABASES.split(',').map(d => d.trim()).filter(Boolean)
        : null,
    };
  }
  if (type === 'bigquery') {
    return {
      projectId: required('BIGQUERY_PROJECT_ID'),
      keyFile:   required('BIGQUERY_KEY_FILE'),
      datasets:  process.env.BIGQUERY_DATASETS
        ? process.env.BIGQUERY_DATASETS.split(',').map(d => d.trim()).filter(Boolean)
        : null,
    };
  }
  throw new Error(`Unknown WAREHOUSE_TYPE: "${type}". Use "snowflake" or "bigquery".`);
}

let _config;

export function getConfig() {
  if (_config) return _config;

  const warehouseType = optional('WAREHOUSE_TYPE', 'snowflake');

  _config = {
    warehouseType,
    warehouse: warehouseConfig(warehouseType),
    pinecone: {
      apiKey:    required('PINECONE_API_KEY'),
      indexName: optional('PINECONE_INDEX', 'semantic-compiler'),
      cloud:     optional('PINECONE_CLOUD', 'aws'),
      region:    optional('PINECONE_REGION', 'us-east-1'),
    },
    openai: {
      apiKey:     required('OPENAI_API_KEY'),
      embedModel: optional('OPENAI_EMBED_MODEL', 'text-embedding-3-small'),
      chatModel:  optional('OPENAI_CHAT_MODEL', 'gpt-4o'),
    },
  };
  return _config;
}
