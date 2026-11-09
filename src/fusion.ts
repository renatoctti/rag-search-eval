/**
 * Reciprocal rank fusion: each list gives a document 1 / (k + rank), and the scores add up. It
 * needs only the ranks, so the full-text score and the cosine distance, which are on different
 * scales, never have to be normalised against each other. k = 60 is the value from the paper.
 */
export function reciprocalRankFusion(lists: string[][], k = 60): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  }
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}
