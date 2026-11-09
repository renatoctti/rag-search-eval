import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// bge-small-en-v1.5 (384 dimensions), 8-bit quantised ONNX, runs on the CPU with no API key.
export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
export const DIMENSIONS = 384;
// bge asks for this prefix on the search query, and none on the documents.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

env.cacheDir = ".cache/models";

let extractor: Promise<FeatureExtractionPipeline> | undefined;
function load() {
  extractor ??= pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" });
  return extractor;
}

async function embed(texts: string[]): Promise<number[][]> {
  const model = await load();
  const output = await model(texts, { pooling: "cls", normalize: true });
  return output.tolist() as number[][];
}

export const embedDocuments = (texts: string[]) => embed(texts);
export async function embedQuery(text: string): Promise<number[]> {
  return (await embed([QUERY_PREFIX + text]))[0]!;
}
