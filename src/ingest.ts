import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import pgvector from "pgvector/pg";
import { loadSciFact } from "./dataset.ts";
import { buildBm25, connect, createSchema } from "./db.ts";
import { embedDocuments } from "./embed.ts";

const BATCH = 32;
const CACHE = ".cache/embeddings.jsonl"; // one {"id", "v"} per line, appended after every batch

// Stage 1: embed what the cache does not have. Slow on a CPU, so a crash must not lose the work,
// and the CI can keep the file between runs.
const { docs } = await loadSciFact();
mkdirSync(".cache", { recursive: true });
const vectors = new Map<string, number[]>();
if (existsSync(CACHE)) {
  for (const line of readFileSync(CACHE, "utf8").split("\n")) {
    if (line) {
      const { id, v } = JSON.parse(line) as { id: string; v: number[] };
      vectors.set(id, v);
    }
  }
}
// similar lengths in one batch keep the padding small, which is most of the cost
const todo = docs
  .filter((d) => !vectors.has(d.id))
  .sort((a, b) => a.title.length + a.text.length - (b.title.length + b.text.length));
const started = Date.now();
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const embedded = await embedDocuments(batch.map((d) => `${d.title}. ${d.text}`));
  const lines = batch.map((d, j) => {
    vectors.set(d.id, embedded[j]!);
    return JSON.stringify({ id: d.id, v: embedded[j]!.map((x) => Math.round(x * 1e6) / 1e6) }) + "\n";
  });
  appendFileSync(CACHE, lines.join(""));
  const seconds = (Date.now() - started) / 1000;
  console.log(`embedded ${Math.min(i + BATCH, todo.length)}/${todo.length} (${seconds.toFixed(0)} s)`);
}

// Stage 2: put every document and its vector in Postgres.
const client = await connect();
await createSchema(client);
const { rows } = await client.query("SELECT count(*)::int AS n FROM docs WHERE emb IS NOT NULL");
if (rows[0].n === docs.length) {
  console.log(`${docs.length} documents are already indexed`);
} else {
  for (let i = 0; i < docs.length; i += 200) {
    await client.query("BEGIN");
    for (const doc of docs.slice(i, i + 200)) {
      await client.query(
        `INSERT INTO docs (id, title, body, emb) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET emb = EXCLUDED.emb`,
        [doc.id, doc.title, doc.text, pgvector.toSql(vectors.get(doc.id)!)],
      );
    }
    await client.query("COMMIT");
  }
  console.log(`indexed ${docs.length} documents`);
}
await buildBm25(client);
console.log("built the BM25 tables");
await client.end();
