// Lightweight BM25 implementation — zero dependencies

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about',
  'this', 'that', 'these', 'those', 'it', 'its',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

export interface RankedResult<T> {
  item: T;
  score: number;
  index: number;
}

export function rankBM25<T>(
  items: T[],
  getText: (item: T) => string,
  query: string,
  k1 = 1.5,
  b = 0.75,
): RankedResult<T>[] {
  if (items.length === 0 || !query.trim()) {
    return items.map((item, i) => ({ item, score: 0, index: i }));
  }

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return items.map((item, i) => ({ item, score: 0, index: i }));
  }

  // Index documents
  const docs = items.map((item) => {
    const terms = tokenize(getText(item));
    const freqs = new Map<string, number>();
    for (const t of terms) {
      freqs.set(t, (freqs.get(t) ?? 0) + 1);
    }
    return { termFreqs: freqs, length: terms.length };
  });

  const N = docs.length;
  const avgDl = docs.reduce((s, d) => s + d.length, 0) / N;

  // Document frequency for query terms
  const df = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const doc of docs) {
      if (doc.termFreqs.has(term)) count++;
    }
    df.set(term, count);
  }

  // Score each document
  const results: RankedResult<T>[] = docs.map((doc, i) => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.termFreqs.get(term) ?? 0;
      if (tf === 0) continue;
      const docFreq = df.get(term) ?? 0;
      const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / avgDl)));
      score += idf * tfNorm;
    }
    return { item: items[i], score, index: i };
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}
