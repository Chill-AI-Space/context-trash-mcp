interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface RefMapping {
  label: string;
  ref: string;
}

/**
 * Extracts ref mappings from DOM text before stripping them.
 * Captures patterns like: [ref=42] next to text labels.
 */
function extractRefMappings(text: string): RefMapping[] {
  const mappings: RefMapping[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    // Match patterns like: - button "Submit" [ref=42]
    // or: - link "Home" [ref=7]
    const match = line.match(/[-–]\s+(\w+)\s+"([^"]+)".*?\[ref=([\w]+)\]/);
    if (match) {
      mappings.push({ label: `${match[1]} "${match[2]}"`, ref: match[3] });
      continue;
    }
    // Match: - "Some text" [ref=X]
    const match2 = line.match(/[-–]\s+"([^"]+)".*?\[ref=([\w]+)\]/);
    if (match2) {
      mappings.push({ label: `"${match2[1]}"`, ref: match2[2] });
    }
  }

  return mappings;
}

function buildMappingTable(mappings: RefMapping[]): string {
  if (mappings.length === 0) return '';
  const rows = mappings.map((m) => `  ${m.label} → ref=${m.ref}`);
  return `\n[Element references]\n${rows.join('\n')}`;
}

export function compressDomCleanup(block: ContentBlock): ContentBlock {
  if (block.type !== 'text' || !block.text) return block;

  const text = block.text;

  // Extract ref mappings before stripping
  const mappings = extractRefMappings(text);

  let cleaned = text;

  // 1. Strip ref attributes: [ref=123] → remove
  cleaned = cleaned.replace(/\s*\[ref=[\w]+\]/g, '');

  // 2. Strip generic ARIA roles
  cleaned = cleaned.replace(/\s*role="(?:generic|none)"/g, '');

  // 3. Collapse empty generic nodes: lines with only "- role: generic" and no meaningful content
  cleaned = cleaned.replace(/^[\t ]*[-–]\s*(?:role:\s*generic|generic)\s*$/gm, '');

  // 4. Collapse multiple blank lines into one
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // 5. Deduplicate repeated nav blocks
  const navPattern = /(-\s+navigation\b.*?)(?=\n-\s+(?!navigation)|$)/gs;
  const navBlocks: string[] = [];
  cleaned = cleaned.replace(navPattern, (match) => {
    const normalized = match.trim();
    if (navBlocks.includes(normalized)) {
      return '[repeated nav block omitted]';
    }
    navBlocks.push(normalized);
    return match;
  });

  // Append mapping table
  cleaned = cleaned.trimEnd() + buildMappingTable(mappings);

  // Size guard: if cleanup made it bigger, return original
  if (cleaned.length >= text.length) {
    return block;
  }

  return { type: 'text', text: cleaned };
}
