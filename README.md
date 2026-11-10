# rag-search-eval

The search half of RAG on Postgres + pgvector, **measured**: full-text, BM25, embeddings, hybrid
and reranked retrieval, scored on a public benchmark with confidence intervals, and a CI that
fails when a method gets worse.

Most RAG demos show one retriever and a good-looking answer. This project asks the question that
comes before: *which retriever finds the right documents, by how much, and is the difference
real or noise?*

## Result

[BEIR SciFact](https://github.com/beir-cellar/beir): 5,183 scientific abstracts and 300 test
claims, each with the abstracts that support or contradict it. Embeddings are
`bge-small-en-v1.5` (8-bit ONNX, on the CPU, no API key). These are the numbers of the CI run on
the real `pgvector/pgvector:pg17` image (a shared GitHub runner, so the latencies are only
indicative); a first run on a laptop with PGlite gave the same ranking and scores within 0.003.

| Method | nDCG@10 (95% CI) | recall@10 | recall@100 | p50 latency |
|---|---|---|---|---|
| Postgres full-text (`ts_rank_cd`) | 0.329 (0.286–0.371) | 0.501 | 0.761 | 30 ms |
| BM25 (in SQL) | 0.691 (0.647–0.732) | 0.833 | 0.922 | 5 ms |
| Embeddings (pgvector, HNSW) | 0.709 (0.667–0.752) | 0.836 | 0.947 | 20 ms |
| Embeddings, exact scan | 0.709 (0.667–0.752) | 0.836 | 0.947 | 19 ms |
| Hybrid, full-text + embeddings | 0.593 (0.545–0.640) | 0.727 | 0.952 | 58 ms |
| **Hybrid, BM25 + embeddings (RRF)** | **0.722 (0.681–0.763)** | 0.853 | **0.963** | 27 ms |
| Hybrid + cross-encoder rerank | 0.693 (0.650–0.736) | 0.828 | 0.963 | 1,274 ms |

The intervals come from a bootstrap over the 300 queries. Many of these differences are inside
them, so the comparison that matters is the paired one (same queries, difference per query):

| Comparison (nDCG@10) | Difference | 95% CI | Real? |
|---|---|---|---|
| BM25 − `ts_rank_cd` | +0.362 | 0.321 to 0.404 | yes |
| hybrid − BM25 | +0.031 | 0.009 to 0.053 | yes, small |
| hybrid − embeddings | +0.013 | −0.010 to 0.036 | **no** |
| embeddings − BM25 | +0.018 | −0.016 to 0.053 | **no** |
| hybrid (BM25) − hybrid (`ts_rank_cd`) | +0.129 | 0.098 to 0.161 | yes |
| rerank − hybrid | −0.029 | −0.056 to −0.002 | yes: the reranker is worse |
| exact − HNSW | 0.000 | 0.000 to 0.000 | identical |

## What I take from it

- **The lexical side decides the hybrid.** Postgres' own `ts_rank_cd` has no inverse document
  frequency and is not BM25: it scored 0.33, half of BM25, and fusing it with the embeddings made
  the hybrid *worse than embeddings alone* (0.59 against 0.71). The first run of this project
  showed exactly that, and I almost reported "hybrid hurts". The honest reading was that my
  baseline was weak, so I implemented BM25 in SQL on top of the `tsvector` and the hybrid went to
  the top.
- **Hybrid is better, but on this data it is a small and uncertain gain over embeddings alone.**
  It is clearly better than BM25 alone, and not distinguishable from embeddings. Its real
  advantage is recall@100 (0.963), which is what a reranking stage or an LLM sees.
- **The reranker did not pay for itself here.** `ms-marco-MiniLM-L-6` over the top 30 scored
  lower than the hybrid it reordered (the paired difference excludes 0 by a hair) and added more
  than a second per query on a CPU. That model is
  trained on web-search questions; SciFact is claim verification over abstracts. A different
  reranker or domain could change this, and I did not try others.
- **HNSW lost nothing** against the exact scan: the top-100 lists were the same. It also saved
  nothing: at 5,183 rows the planner's sequential scan is as fast (19 ms against 20 ms). The index
  matters on a corpus orders of magnitude larger, which this one is not.
- **Sanity check against the literature:** the embedding score (0.709) is close to the 0.713 that
  the original `bge-small-en-v1.5` gets on SciFact in MTEB, and the BM25 score (0.691) is in the
  range usually reported for BM25 on this dataset. I took these figures from memory of the public
  tables and did not recheck them against the sources. Mine are an 8-bit quantised model and
  Postgres' stemming, so a gap of a point or two is expected.

## Limits

- One dataset, in English, about science. A corpus of Portuguese support tickets could rank these
  methods differently, and I would not claim otherwise from this table.
- One embedding model and one reranker. Both are small so the project runs on a laptop.
- Reciprocal rank fusion uses the paper's `k = 60` and was not tuned; tuning it on the same
  300 queries would fit the test.
- The bootstrap resamples queries. It does not capture the variance from the choice of corpus.
- `npm run db:local` serves PGlite (Postgres compiled to WASM, with pgvector) for machines
  without Docker. Scores match the real image within 0.003; latencies do not, so only the CI
  figures are quoted here.
- `ts_rank_cd` is in the table on purpose, as the cautionary baseline. It is not a fair BM25.
- SciFact is CC BY-NC 2.0. The script downloads it (checksum pinned) and never commits it.

## How it works

```
src/dataset.ts     downloads SciFact (sha256 pinned), parses documents, queries, judgements
src/embed.ts       bge-small-en-v1.5 through transformers.js, on the CPU
src/ingest.ts      embeds (resumable cache), loads Postgres, builds the BM25 tables
src/db.ts          schema: tsvector + GIN, vector + HNSW, BM25 postings, in plain SQL
src/retrievers.ts  full-text, BM25, dense, exact, hybrid (RRF), cross-encoder rerank
src/fusion.ts      reciprocal rank fusion
src/metrics.ts     nDCG, recall, MRR, bootstrap and paired bootstrap
src/evaluate.ts    runs every method, prints the tables, writes the report, gates on a baseline
```

The gate (`--baseline results/scifact.json --max-drop 0.01`) exits 1 when any method's nDCG@10
falls more than 0.01 under the saved baseline, so a change to the schema, the tokenisation or the
fusion cannot quietly make search worse.

## Run it

```bash
# 1. a Postgres with pgvector on port 5433
docker compose up -d          # or, with no Docker:  npm run db:local

# 2. index SciFact (about 15 min the first time on a CPU, then cached)
npm ci
npm run ingest

# 3. score every retriever
npm run evaluate -- --report results/latest.json
npm run evaluate -- --methods bm25,hybrid --limit 50     # a quick run
```

Needs Node 24 (it runs the TypeScript directly). `npm test` runs the metric, fusion and parsing
tests with no database; `npm run typecheck` checks the types.
