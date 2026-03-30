import 'dotenv/config';

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}. Copy env.sample → .env and fill it in.`);
  return val;
};

const optional = (key, fallback) => process.env[key] || fallback;

let _config;

export function getConfig() {
  if (_config) return _config;
  _config = {
    snowflake: {
      account:        required('SNOWFLAKE_ACCOUNT'),
      username:       required('SNOWFLAKE_USERNAME'),
      warehouse:      required('SNOWFLAKE_WAREHOUSE'),
      role:           optional('SNOWFLAKE_ROLE', 'SYSADMIN'),
      privateKeyPath: optional('SNOWFLAKE_PRIVATE_KEY_PATH', null),
      password:       optional('SNOWFLAKE_PASSWORD', null),
    },
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
    crawl: {
      databases: process.env.SNOWFLAKE_DATABASES
        ? process.env.SNOWFLAKE_DATABASES.split(',').map(d => d.trim()).filter(Boolean)
        : null,
    },
  };
  return _config;
}
