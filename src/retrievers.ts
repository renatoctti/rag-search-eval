import pg from "pg";
import pgvector from "pgvector/pg";
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import { embedQuery } from "./embed.ts";
import { reciprocalRankFusion } from "./fusion.ts";

/** Ranked document ids for a query, best first. */
export type Retriever = (query: string, k: number) => Promise<string[]>;

const CANDIDATES = 100; // what each first-stage search hands to the fusion
const RERANK_TOP = 30; // how many of the fused candidates the cross-encoder reads
const RERANKER = "Xenova/ms-marco-MiniLM-L-6-v2";

export async function createRetrievers(client: pg.Client): Promise<Record<string, Retriever>> {
  // the default of 40 would cap a LIMIT 100 search at 40 rows
  await client.query("SET hnsw.ef_search = 200");

  // Full-text search: the words of the query joined with OR (plainto_tsquery joins them with
  // AND, which finds almost nothing for a sentence), ranked by ts_rank_cd. This is not BM25.
  const fts: Retriever = async (query, k) => {
    const { rows } = await client.query(
      `WITH q AS (SELECT replace(plainto_tsquery('english', $1)::text, '&', '|')::tsquery AS q)
       SELECT id FROM docs, q WHERE tsv @@ q.q ORDER BY ts_rank_cd(tsv, q.q) DESC, id LIMIT $2`,
      [query, k],
    );
    return rows.map((r) => r.id);
  };

  // BM25 with k1 = 1.2 and b = 0.75, the Elasticsearch defaults the BEIR benchmark used. The
  // query goes through the same 'english' text search configuration as the documents.
  const bm25: Retriever = async (query, k) => {
    const { rows } = await client.query(
      `WITH q AS (SELECT DISTINCT lexeme FROM unnest(to_tsvector('english', $1))),
            n AS (SELECT count(*)::float AS n, avg(len)::float AS avgdl FROM bm25_stats)
       SELECT p.doc_id AS id
       FROM postings p
       JOIN q ON q.lexeme = p.term
       JOIN bm25_terms t ON t.term = p.term
       JOIN bm25_stats s ON s.doc_id = p.doc_id
       CROSS JOIN n
       GROUP BY p.doc_id
       ORDER BY sum(ln(1 + (n.n - t.df + 0.5) / (t.df + 0.5))
                    * p.tf * 2.2 / (p.tf + 1.2 * (0.25 + 0.75 * s.len / n.avgdl))) DESC, p.doc_id
       LIMIT $2`,
      [query, k],
    );
    return rows.map((r) => r.id);
  };

  const dense: Retriever = async (query, k) => {
    const vector = pgvector.toSql(await embedQuery(query));
    const { rows } = await client.query("SELECT id FROM docs ORDER BY emb <=> $1 LIMIT $2", [vector, k]);
    return rows.map((r) => r.id);
  };

  // The same search with the HNSW index switched off, so the planner scans every row: the answer
  // the index is approximating.
  const denseExact: Retriever = async (query, k) => {
    await client.query("SET enable_indexscan = off");
    try {
      return await dense(query, k);
    } finally {
      await client.query("SET enable_indexscan = on");
    }
  };

  const fused = (lexical: Retriever): Retriever => async (query, k) =>
    reciprocalRankFusion([await lexical(query, CANDIDATES), await dense(query, CANDIDATES)]).slice(0, k);
  const hybrid = fused(bm25);
  const hybridFts = fused(fts);

  let reranker: Promise<[Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>, Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>]> | undefined;
  const loadReranker = () =>
    (reranker ??= Promise.all([
      AutoTokenizer.from_pretrained(RERANKER),
      AutoModelForSequenceClassification.from_pretrained(RERANKER, { dtype: "q8" }),
    ]));

  // A cross-encoder reads the query and one document together, which is more accurate than
  // comparing two vectors made apart, and too slow for the whole corpus: it only reorders the top.
  const rerank: Retriever = async (query, k) => {
    const candidates = await hybrid(query, CANDIDATES);
    const head = candidates.slice(0, RERANK_TOP);
    const { rows } = await client.query("SELECT id, title, body FROM docs WHERE id = ANY($1)", [head]);
    const text = new Map<string, string>(rows.map((r) => [r.id, `${r.title}. ${r.body}`]));
    const [tokenizer, model] = await loadReranker();
    const inputs = tokenizer(Array(head.length).fill(query), {
      text_pair: head.map((id) => text.get(id)!),
      padding: true,
      truncation: true,
      max_length: 512,
    });
    const { logits } = await model(inputs);
    const scores = Array.from(logits.data as Float32Array);
    const reordered = head
      .map((id, i) => ({ id, score: scores[i]! }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.id);
    return [...reordered, ...candidates.slice(RERANK_TOP)].slice(0, k);
  };

  return { fts, bm25, dense, "dense-exact": denseExact, "hybrid-fts": hybridFts, hybrid, rerank };
}
