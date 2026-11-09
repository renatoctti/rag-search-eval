import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadSciFact } from "./dataset.ts";
import { connect } from "./db.ts";
import { EMBEDDING_MODEL } from "./embed.ts";
import { bootstrap, mrrAt, ndcgAt, pairedDifference, percentile, recallAt, mean } from "./metrics.ts";
import type { Interval } from "./metrics.ts";
import { createRetrievers } from "./retrievers.ts";

const { values: args } = parseArgs({
  options: {
    methods: { type: "string", default: "fts,dense,dense-exact,hybrid,rerank" },
    limit: { type: "string" },
    report: { type: "string" },
    baseline: { type: "string" },
    "max-drop": { type: "string", default: "0.01" },
  },
});

const COMPARISONS: [string, string][] = [
  ["dense", "fts"],
  ["hybrid", "dense"],
  ["hybrid", "fts"],
  ["rerank", "hybrid"],
  ["dense-exact", "dense"],
];

type Row = {
  ndcg10: Interval;
  recall10: number;
  recall100: number;
  mrr10: number;
  p50Ms: number;
  p95Ms: number;
};

const data = await loadSciFact();
const queries = data.queries.slice(0, args.limit ? Number(args.limit) : undefined);
const client = await connect();
const retrievers = await createRetrievers(client);
const names = args.methods!.split(",").map((m) => m.trim());

const perQuery: Record<string, number[]> = {};
const rows: Record<string, Row> = {};
for (const name of names) {
  const retrieve = retrievers[name];
  if (!retrieve) throw new Error(`unknown method ${name}; choose from ${Object.keys(retrievers).join(", ")}`);
  await retrieve(queries[0]!.text, 10); // the first call loads the models and warms the plan cache
  const ndcg: number[] = [], recall10: number[] = [], recall100: number[] = [], mrr: number[] = [], ms: number[] = [];
  for (const query of queries) {
    const qrels = data.qrels.get(query.id)!;
    const started = performance.now();
    const ranked = await retrieve(query.text, 100);
    ms.push(performance.now() - started);
    ndcg.push(ndcgAt(10, ranked, qrels));
    recall10.push(recallAt(10, ranked, qrels));
    recall100.push(recallAt(100, ranked, qrels));
    mrr.push(mrrAt(10, ranked, qrels));
  }
  perQuery[name] = ndcg;
  rows[name] = {
    ndcg10: bootstrap(ndcg),
    recall10: mean(recall10),
    recall100: mean(recall100),
    mrr10: mean(mrr),
    p50Ms: percentile(ms, 0.5),
    p95Ms: percentile(ms, 0.95),
  };
  console.error(`${name}: nDCG@10 ${rows[name]!.ndcg10.mean.toFixed(3)}`);
}
await client.end();

const f = (x: number) => x.toFixed(3);
console.log(`\n${queries.length} SciFact test queries over ${data.docs.length} documents, embeddings ${EMBEDDING_MODEL}\n`);
console.log("| Method | nDCG@10 (95% CI) | recall@10 | recall@100 | MRR@10 | p50 / p95 ms |");
console.log("|---|---|---|---|---|---|");
for (const name of names) {
  const r = rows[name]!;
  console.log(
    `| ${name} | ${f(r.ndcg10.mean)} (${f(r.ndcg10.low)}-${f(r.ndcg10.high)}) | ${f(r.recall10)} | ${f(r.recall100)} | ${f(r.mrr10)} | ${r.p50Ms.toFixed(0)} / ${r.p95Ms.toFixed(0)} |`,
  );
}

const comparisons = COMPARISONS.filter(([a, b]) => perQuery[a] && perQuery[b]).map(([a, b]) => {
  const diff = pairedDifference(perQuery[a]!, perQuery[b]!);
  return { a, b, ...diff, significant: diff.low > 0 || diff.high < 0 };
});
console.log("\nPaired difference in nDCG@10 (bootstrap over queries; a CI that spans 0 is not a result):\n");
for (const c of comparisons) {
  console.log(`- ${c.a} - ${c.b}: ${c.mean >= 0 ? "+" : ""}${f(c.mean)} (${f(c.low)} to ${f(c.high)})${c.significant ? "" : "  not distinguishable from 0"}`);
}

const report = { dataset: "BEIR/SciFact test", model: EMBEDDING_MODEL, queries: queries.length, methods: rows, comparisons };
if (args.report) writeFileSync(args.report, JSON.stringify(report, null, 2) + "\n");

if (args.baseline) {
  const baseline = JSON.parse(readFileSync(args.baseline, "utf8")) as typeof report;
  const maxDrop = Number(args["max-drop"]);
  const problems = names.flatMap((name) => {
    const before = baseline.methods[name]?.ndcg10.mean;
    const now = rows[name]!.ndcg10.mean;
    return before !== undefined && now < before - maxDrop
      ? [`${name}: nDCG@10 ${f(now)} is more than ${maxDrop} under the baseline ${f(before)}`]
      : [];
  });
  if (problems.length) {
    console.error("\nGATE FAILED\n" + problems.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`\ngate passed: no method is more than ${maxDrop} nDCG@10 under ${args.baseline}`);
  }
}
