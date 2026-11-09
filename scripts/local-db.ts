// A Postgres with pgvector for machines without Docker: PGlite (Postgres compiled to WASM) served
// over the Postgres wire protocol, so the code under src/ talks to it with the same `pg` driver it
// uses against the real image in docker-compose.yml. Data lives in memory and goes away on exit.
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const db = await PGlite.create({ extensions: { vector } });
const server = new PGLiteSocketServer({ db, port: 5433, host: "127.0.0.1" });
await server.start();
console.log("PGlite with pgvector on postgres://rag:rag@127.0.0.1:5433/rag (Ctrl+C to stop)");

process.on("SIGINT", async () => {
  await server.stop();
  await db.close();
  process.exit(0);
});
