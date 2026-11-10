import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createApp, metricLine, type Hit } from "../src/server.ts";

const lines: Record<string, unknown>[] = [];
let broken = false;
let server: Server;
let base: string;

before(async () => {
  server = createApp(
    async (query, k): Promise<Hit[]> => {
      if (broken) throw new Error("connection refused");
      return Array.from({ length: Math.min(k, 2) }, (_, i) => ({ id: String(i), title: `${query} ${i}` }));
    },
    (line) => lines.push(line),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (body: string) =>
  fetch(`${base}/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body });

test("the health check answers without a database", async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("a search returns the hits and logs one metric line", async () => {
  lines.length = 0;
  const response = await post(JSON.stringify({ query: "aspirin", k: 5 }));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { results: Hit[] };
  assert.deepEqual(body.results.map((r) => r.title), ["aspirin 0", "aspirin 1"]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.Errors, 0);
  assert.equal(lines[0]!.Results, 2);
});

test("bad input is a 400 and does not count as a server error", async () => {
  lines.length = 0;
  for (const body of ["not json", "{}", '{"query":"  "}', '{"query":"a","k":0}', '{"query":"a","k":21}', '{"query":"a","k":1.5}']) {
    assert.equal((await post(body)).status, 400, body);
  }
  assert.equal((await post(JSON.stringify({ query: "x".repeat(501) }))).status, 400);
  assert.equal((await post("x".repeat(5000))).status, 400);
  assert.equal(lines.length, 0);
});

test("a database failure is a 503 that hides the cause and logs it as an error", async () => {
  lines.length = 0;
  broken = true;
  const response = await post(JSON.stringify({ query: "aspirin" }));
  broken = false;
  assert.equal(response.status, 503);
  assert.ok(!JSON.stringify(await response.json()).includes("refused"));
  assert.equal(lines[0]!.Errors, 1);
  assert.equal(lines[0]!.Error, "connection refused");
});

test("unknown routes and methods are refused", async () => {
  assert.equal((await fetch(`${base}/other`)).status, 404);
  assert.equal((await fetch(`${base}/search`)).status, 405);
});

test("the metric line names the metrics CloudWatch should extract", () => {
  const line = metricLine("search", { LatencyMs: 12, Errors: 0, Results: 3 });
  const directive = line._aws.CloudWatchMetrics[0]!;
  assert.equal(directive.Namespace, "RagSearch");
  for (const metric of directive.Metrics) assert.ok(metric.Name in line, metric.Name);
  assert.ok(directive.Dimensions[0]!.every((dimension) => dimension in line));
});
