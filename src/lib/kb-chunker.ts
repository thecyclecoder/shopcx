// Document chunking for knowledge base articles
// Splits content into ~500 token chunks (~2000 chars) with 50 token overlap (~200 chars)

interface Chunk {
  chunk_text: string;
  chunk_index: number;
}

const CHUNK_SIZE = 2000; // ~500 tokens
const CHUNK_OVERLAP = 200; // ~50 tokens

export function chunkDocument(content: string): Chunk[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  // If content fits in one chunk, return as-is
  if (trimmed.length <= CHUNK_SIZE) {
    return [{ chunk_text: trimmed, chunk_index: 0 }];
  }

  const chunks: Chunk[] = [];
  let offset = 0;

  while (offset < trimmed.length) {
    let end = offset + CHUNK_SIZE;

    if (end < trimmed.length) {
      // Try to break at paragraph boundary
      const paragraphBreak = trimmed.lastIndexOf("\n\n", end);
      if (paragraphBreak > offset + CHUNK_SIZE * 0.5) {
        end = paragraphBreak;
      } else {
        // Try sentence boundary
        const sentenceBreak = trimmed.lastIndexOf(". ", end);
        if (sentenceBreak > offset + CHUNK_SIZE * 0.5) {
          end = sentenceBreak + 1; // include the period
        }
      }
    } else {
      end = trimmed.length;
    }

    chunks.push({
      chunk_text: trimmed.slice(offset, end).trim(),
      chunk_index: chunks.length,
    });

    // Advance with overlap
    offset = end - CHUNK_OVERLAP;
    if (offset <= chunks[chunks.length - 1].chunk_index && offset + CHUNK_OVERLAP >= trimmed.length) break;
    if (end >= trimmed.length) break;
  }

  return chunks;
}
