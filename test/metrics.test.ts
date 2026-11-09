import assert from "node:assert/strict";
import { test } from "node:test";
import { reciprocalRankFusion } from "../src/fusion.ts";
import { bootstrap, mrrAt, ndcgAt, pairedDifference, recallAt, type Qrels } from "../src/metrics.ts";

const qrels: Qrels = new Map([
  ["d2", 1],
  ["d3", 1],
]);

test("ndcg is 1 for the ideal order and discounts a late hit", () => {
  assert.equal(ndcgAt(10, ["d2", "d3", "x"], qrels), 1);
  // hits at ranks 2 and 3: (1/log2(3) + 1/log2(4)) / (1 + 1/log2(3))
  const expected = (1 / Math.log2(3) + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3));
  assert.ok(Math.abs(ndcgAt(10, ["d1", "d2", "d3"], qrels) - expected) < 1e-12);
});

test("ndcg counts only the top k and is 0 with no relevant document", () => {
  assert.equal(ndcgAt(1, ["d1", "d2"], qrels), 0);
  assert.equal(ndcgAt(10, ["d1"], new Map()), 0);
});

test("ndcg uses the grade as the gain", () => {
  const graded: Qrels = new Map([["a", 2], ["b", 1]]);
  assert.ok(ndcgAt(10, ["b", "a"], graded) < 1);
  assert.equal(ndcgAt(10, ["a", "b"], graded), 1);
});

test("recall is the share of relevant documents inside the top k", () => {
  assert.equal(recallAt(2, ["d1", "d2", "d3"], qrels), 0.5);
  assert.equal(recallAt(3, ["d1", "d2", "d3"], qrels), 1);
});

test("mrr is the reciprocal rank of the first relevant document", () => {
  assert.equal(mrrAt(10, ["d1", "d3"], qrels), 0.5);
  assert.equal(mrrAt(1, ["d1", "d3"], qrels), 0);
});

test("a bootstrap interval brackets the mean and is repeatable", () => {
  const xs = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : 0));
  const a = bootstrap(xs, 2000, 7);
  assert.equal(a.mean, 0.5);
  assert.ok(a.low < 0.5 && a.high > 0.5);
  assert.deepEqual(bootstrap(xs, 2000, 7), a);
});

test("a paired difference that is always positive excludes 0", () => {
  const worse = Array.from({ length: 50 }, () => 0.4);
  const better = worse.map((x, i) => x + 0.1 + (i % 3) * 0.01);
  const diff = pairedDifference(better, worse, 2000);
  assert.ok(diff.low > 0);
  assert.throws(() => pairedDifference([1], [1, 2]), /same queries/);
});

test("rank fusion puts a document that both lists like first", () => {
  assert.deepEqual(reciprocalRankFusion([["a", "b", "c"], ["c", "a", "d"]]).slice(0, 2), ["a", "c"]);
  assert.deepEqual(reciprocalRankFusion([["a"], []]), ["a"]);
});
