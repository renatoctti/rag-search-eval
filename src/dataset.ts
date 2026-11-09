import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import type { Qrels } from "./metrics.ts";

// SciFact from the BEIR benchmark: 5,183 scientific abstracts, 300 test claims, each with the
// abstracts that support or contradict it. CC BY-NC 2.0, so it is downloaded and never committed.
const SOURCE = "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip";
const SHA256 = "536e14446a0ba56ed1398ab1055f39fe852686ecad24a6306c80c490fa8e0165";

export type Doc = { id: string; title: string; text: string };
export type Query = { id: string; text: string };
export type Dataset = { docs: Doc[]; queries: Query[]; qrels: Map<string, Qrels> };

const jsonl = <T>(text: string): T[] =>
  text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T);

/** The BEIR files for the test split, as text. Only queries that have judgements are kept. */
export function parseDataset(files: { corpus: string; queries: string; qrels: string }): Dataset {
  const docs = jsonl<{ _id: string; title: string; text: string }>(files.corpus).map((d) => ({
    id: d._id,
    title: d.title,
    text: d.text,
  }));
  const qrels = new Map<string, Qrels>();
  for (const line of files.qrels.split("\n").slice(1)) {
    const [query, doc, score] = line.trim().split("\t");
    if (!query || !doc) continue;
    if (!qrels.has(query)) qrels.set(query, new Map());
    qrels.get(query)!.set(doc, Number(score));
  }
  const queries = jsonl<{ _id: string; text: string }>(files.queries)
    .filter((q) => qrels.has(q._id))
    .map((q) => ({ id: q._id, text: q.text }));
  return { docs, queries, qrels };
}

export async function loadSciFact(dir = "data"): Promise<Dataset> {
  const zipPath = `${dir}/scifact.zip`;
  if (!existsSync(zipPath)) {
    mkdirSync(dir, { recursive: true });
    const response = await fetch(SOURCE);
    if (!response.ok) throw new Error(`could not download SciFact: HTTP ${response.status}`);
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = readFileSync(zipPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (SHA256 && digest !== SHA256) {
    throw new Error(`${zipPath} has sha256 ${digest}, expected ${SHA256}; delete it and retry`);
  }
  const entries = unzipSync(new Uint8Array(bytes));
  const read = (name: string) => {
    const entry = entries[name];
    if (!entry) throw new Error(`${name} is not in ${zipPath}`);
    return strFromU8(entry);
  };
  return parseDataset({
    corpus: read("scifact/corpus.jsonl"),
    queries: read("scifact/queries.jsonl"),
    qrels: read("scifact/qrels/test.tsv"),
  });
}
