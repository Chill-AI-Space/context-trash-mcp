import { log, logError } from '../logger.js';

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export async function compressWithGemini(
  text: string,
  targetTokens: number,
  apiKey: string,
  promptTemplate: string,
): Promise<string | null> {
  const prompt = promptTemplate.replace('{TARGET}', targetTokens.toLocaleString()) + '\n\n' + text;

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
