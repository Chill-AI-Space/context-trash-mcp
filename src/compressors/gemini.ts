import { log, logError } from '../logger.js';

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const COMPRESS_PROMPT = `You are a context compressor. Compress the following text while preserving ALL information that could be relevant to ANY downstream task.

Rules:
- Preserve all code blocks, file paths, URLs, error messages, and structured data (tables, lists) EXACTLY as-is
- Preserve all names, identifiers, numbers, dates, and specific values
- Remove only: redundant explanations, verbose prose, repeated information, boilerplate
- Maintain the original structure and ordering
- When in doubt, KEEP the information rather than removing it
- Do NOT add any commentary or meta-text about the compression
- Output ONLY the compressed text

Target: Reduce to approximately {TARGET} tokens.

TEXT TO COMPRESS:
`;

export async function compressWithGemini(
  text: string,
  targetTokens: number,
  apiKey: string,
): Promise<string | null> {
  const prompt = COMPRESS_PROMPT.replace('{TARGET}', targetTokens.toLocaleString()) + text;

  try {
    const response = await fetch(GEMINI_API_URL + `?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: Math.ceil(targetTokens * 1.2),
          temperature: 0.1,
        },
      }),
    });

    if (!response.ok) {
      logError(`Gemini API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const result = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!result) {
      logError('Gemini returned empty response');
      return null;
    }

    log(`Gemini compressed: ${text.length} chars → ${result.length} chars`);
    return result;
  } catch (err) {
    logError(`Gemini API call failed: ${err}`);
    return null;
  }
}
