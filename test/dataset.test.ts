import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDataset } from "../src/dataset.ts";

test("the BEIR files become documents, judged queries and judgements", () => {
  const data = parseDataset({
    corpus: '{"_id":"1","title":"A","text":"alpha"}\n{"_id":"2","title":"B","text":"beta"}\n',
    queries: '{"_id":"7","text":"is alpha true"}\n{"_id":"8","text":"never judged"}\n',
    qrels: "query-id\tcorpus-id\tscore\n7\t1\t1\n7\t2\t0\n",
  });
  assert.deepEqual(data.docs.map((d) => d.id), ["1", "2"]);
  assert.deepEqual(data.queries, [{ id: "7", text: "is alpha true" }]);
  assert.deepEqual([...data.qrels.get("7")!], [["1", 1], ["2", 0]]);
});
