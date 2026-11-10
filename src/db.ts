import pg from "pg";
import pgvector from "pgvector/pg";
import { DIMENSIONS } from "./embed.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://rag:rag@127.0.0.1:5433/rag";

/**
 * On AWS the database is described by the standard PGHOST, PGUSER, PGPASSWORD and PGDATABASE
 * variables (so the password can come from Secrets Manager and never sits in a URL), and RDS only
 * accepts TLS. Anywhere else it is DATABASE_URL, or the local default.
 */
function clientConfig(): pg.ClientConfig {
  if (!process.env.PGHOST) return { connectionString: DATABASE_URL };
  // ponytail: encrypted but the server certificate is not verified, because that needs the RDS CA
  // bundle in the image; traffic stays inside the VPC. Bundle the CA and verify when this matters.
  return { ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false } };
}

/** One connection is enough here, and it is all the PGlite socket server (no Docker) offers. */
export async function connect(): Promise<pg.Client> {
  const client = new pg.Client(clientConfig());
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

/**
 * BM25 in plain SQL, from Postgres' own tsvector: one row per (term, document) with the term
 * frequency, the document frequency of every term and the document lengths. Rebuilt from scratch
 * after each ingestion. ts_rank_cd cannot stand in for it: it has no inverse document frequency.
 */
export async function buildBm25(client: pg.Client): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS postings;
    DROP TABLE IF EXISTS bm25_terms;
    DROP TABLE IF EXISTS bm25_stats;
    CREATE TABLE postings AS
      SELECT d.id AS doc_id, u.lexeme AS term, cardinality(u.positions)::float AS tf
      FROM docs d, unnest(d.tsv) AS u;
    CREATE INDEX postings_term ON postings (term);
    CREATE TABLE bm25_terms AS SELECT term, count(*)::float AS df FROM postings GROUP BY term;
    CREATE UNIQUE INDEX bm25_terms_term ON bm25_terms (term);
    CREATE TABLE bm25_stats AS
      SELECT doc_id, sum(tf) AS len FROM postings GROUP BY doc_id;
    CREATE UNIQUE INDEX bm25_stats_doc ON bm25_stats (doc_id);
  `);
}
