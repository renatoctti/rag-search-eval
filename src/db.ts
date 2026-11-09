import pg from "pg";
import pgvector from "pgvector/pg";
import { DIMENSIONS } from "./embed.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://rag:rag@127.0.0.1:5433/rag";

/** One connection is enough here, and it is all the PGlite socket server (no Docker) offers. */
export async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  // the extension must exist before the vector type can be registered with the driver
  await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pgvector.registerTypes(client);
  return client;
}

export async function createSchema(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS docs (
      id    text PRIMARY KEY,
      title text NOT NULL,
      body  text NOT NULL,
      tsv   tsvector GENERATED ALWAYS AS
              (to_tsvector('english', title || ' ' || body)) STORED,
      emb   vector(${DIMENSIONS})
    );
    CREATE INDEX IF NOT EXISTS docs_tsv ON docs USING gin (tsv);
    CREATE INDEX IF NOT EXISTS docs_emb ON docs USING hnsw (emb vector_cosine_ops);
  `);
}
