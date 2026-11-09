/** Relevance judgements for one query: document id -> grade (above 0 means relevant). */
export type Qrels = Map<string, number>;

const discount = (rank: number) => 1 / Math.log2(rank + 2); // rank is 0-based

export function ndcgAt(k: number, ranked: string[], qrels: Qrels): number {
  const dcg = ranked.slice(0, k).reduce((sum, id, i) => sum + (qrels.get(id) ?? 0) * discount(i), 0);
  const ideal = [...qrels.values()].filter((g) => g > 0).sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((sum, grade, i) => sum + grade * discount(i), 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function recallAt(k: number, ranked: string[], qrels: Qrels): number {
  const relevant = [...qrels].filter(([, grade]) => grade > 0).map(([id]) => id);
  if (relevant.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}

export function mrrAt(k: number, ranked: string[], qrels: Qrels): number {
  const first = ranked.slice(0, k).findIndex((id) => (qrels.get(id) ?? 0) > 0);
  return first === -1 ? 0 : 1 / (first + 1);
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** A small seeded generator, so a confidence interval is the same on every run. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Interval = { mean: number; low: number; high: number };

/**
 * Bootstrap over queries: resample the queries with replacement and take the 2.5% and 97.5%
 * percentiles of the mean. With one value per query, `xs` is that metric for one method; with
 * the difference of two methods per query, it is a paired comparison.
 */
export function bootstrap(xs: number[], iterations = 10_000, seed = 1): Interval {
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < xs.length; i++) sum += xs[Math.floor(random() * xs.length)]!;
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  return {
    mean: mean(xs),
    low: means[Math.floor(0.025 * iterations)]!,
    high: means[Math.floor(0.975 * iterations)]!,
  };
}

/** The per-query difference a - b, with a bootstrap interval. If it spans 0, it is not a win. */
export function pairedDifference(a: number[], b: number[], iterations = 10_000, seed = 1): Interval {
  if (a.length !== b.length) throw new Error("the two methods must be scored on the same queries");
  return bootstrap(a.map((x, i) => x - b[i]!), iterations, seed);
}

export function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}
