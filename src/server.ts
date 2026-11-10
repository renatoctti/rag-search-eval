import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type pg from "pg";
import { connect } from "./db.ts";
import { embedQuery } from "./embed.ts";
import { createRetrievers } from "./retrievers.ts";

export type Hit = { id: string; title: string };
export type SearchFn = (query: string, k: number) => Promise<Hit[]>;
export type Log = (line: Record<string, unknown>) => void;

const MAX_BODY_BYTES = 4096;
const MAX_QUERY_CHARS = 500;
const MAX_K = 20;

class BadRequest extends Error {}

/**
 * One log line in CloudWatch's embedded metric format: CloudWatch Logs turns it into the metrics
 * named in `_aws` with no agent and no PutMetricData call, and the line stays readable as a log.
 */
export function metricLine(route: string, values: { LatencyMs: number; Errors: number; Results: number }) {
  return {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: "RagSearch",
          Dimensions: [["Route"]],
          Metrics: [
            { Name: "LatencyMs", Unit: "Milliseconds" },
            { Name: "Errors", Unit: "Count" },
            { Name: "Results", Unit: "Count" },
          ],
        },
      ],
    },
    Route: route,
    ...values,
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest("the body is too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("the body is not valid JSON");
  }
}

function parseSearch(body: unknown): { query: string; k: number } {
  const { query, k = 10 } = (body ?? {}) as { query?: unknown; k?: unknown };
  if (typeof query !== "string" || !query.trim() || query.length > MAX_QUERY_CHARS) {
    throw new BadRequest(`query must be a text of 1 to ${MAX_QUERY_CHARS} characters`);
  }
  if (!Number.isInteger(k) || (k as number) < 1 || (k as number) > MAX_K) {
    throw new BadRequest(`k must be an integer from 1 to ${MAX_K}`);
  }
  return { query: query.trim(), k: k as number };
}

/** The HTTP side. `search` is injected, so the routes are tested without a database. */
export function createApp(search: SearchFn, log: Log = (line) => console.log(JSON.stringify(line))): Server {
  return createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      response.end(text);
    };
    // the load balancer asks this; it must not touch the database, so a database outage does not
    // make the balancer kill healthy tasks
    if (request.method === "GET" && request.url === "/healthz") return send(200, { ok: true });
    if (request.url !== "/search") return send(404, { error: "not found" });
    if (request.method !== "POST") return send(405, { error: "use POST" });

    const started = performance.now();
    const requestId = randomUUID();
    try {
      const { query, k } = parseSearch(await readJson(request));
      const results = await search(query, k);
      const latency = Math.round(performance.now() - started);
      log({ ...metricLine("search", { LatencyMs: latency, Errors: 0, Results: results.length }), RequestId: requestId });
      send(200, { results, took_ms: latency });
    } catch (error) {
      const latency = Math.round(performance.now() - started);
      if (error instanceof BadRequest) return send(400, { error: error.message });
      // the cause goes to the log, never to the caller
      log({
        ...metricLine("search", { LatencyMs: latency, Errors: 1, Results: 0 }),
        RequestId: requestId,
        Error: error instanceof Error ? error.message : String(error),
      });
      send(503, { error: "search is unavailable" });
    }
  });
}

/** The hybrid retriever over Postgres, connected on the first request and again after a drop. */
export function postgresSearch(): SearchFn {
  let retrievers: Promise<{ client: pg.Client; hybrid: Awaited<ReturnType<typeof createRetrievers>>["hybrid"] }> | undefined;
  const open = () =>
    (retrievers ??= (async () => {
      const client = await connect();
      client.on("error", () => (retrievers = undefined));
      client.on("end", () => (retrievers = undefined));
      return { client, hybrid: (await createRetrievers(client)).hybrid };
    })().catch((error) => {
      retrievers = undefined;
      throw error;
    }));
  return async (query, k) => {
    const { client, hybrid } = await open();
    const ids = await hybrid(query, k);
    if (ids.length === 0) return [];
    const { rows } = await client.query("SELECT id, title FROM docs WHERE id = ANY($1)", [ids]);
    const titles = new Map<string, string>(rows.map((r) => [r.id, r.title]));
    return ids.map((id) => ({ id, title: titles.get(id) ?? "" }));
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  createApp(postgresSearch()).listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ message: "listening", port }));
    // load the embedding model now, not on the first customer's request
    void embedQuery("warm up");
  });
}
