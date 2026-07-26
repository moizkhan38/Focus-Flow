import fetch from 'node-fetch';

const FLASK_URL = process.env.FLASK_URL || 'http://localhost:5000';
const FETCH_TIMEOUT = 120000;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// Attach the shared internal-service key so Flask (when gated in production)
// accepts calls from this gateway. No-op locally when the key is unset.
//
// geminiKey is the caller's OPTIONAL per-org override (D5 keeps the platform
// key as the default). When omitted, Flask uses its own GEMINI_API_KEY, so
// existing behaviour is unchanged. It travels as a header rather than in the
// body to keep the JSON contract identical for both paths — and this hop is
// internal-only and already gated by INTERNAL_API_KEY.
function flaskHeaders(geminiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_API_KEY) headers['X-Internal-Key'] = INTERNAL_API_KEY;
  if (geminiKey) headers['X-Gemini-Key'] = geminiKey;
  return headers;
}

export async function generateEpics(description, geminiKey = null) {
  try {
    const response = await fetch(`${FLASK_URL}/api/generate`, {
      method: 'POST',
      headers: flaskHeaders(geminiKey),
      body: JSON.stringify({ description }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Flask service error: ${error}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error calling Flask service:', error);
    throw error;
  }
}

export async function regenerateComponent(type, projectDescription, context, geminiKey = null) {
  try {
    const response = await fetch(`${FLASK_URL}/api/regenerate`, {
      method: 'POST',
      headers: flaskHeaders(geminiKey),
      body: JSON.stringify({
        type,
        project_description: projectDescription,
        context
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Flask regeneration error: ${error}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error calling Flask regeneration:', error);
    throw error;
  }
}

export async function classifyEpic(epicTitle, epicDescription) {
  try {
    const response = await fetch(`${FLASK_URL}/api/classify`, {
      method: 'POST',
      headers: flaskHeaders(),
      body: JSON.stringify({
        epic_title: epicTitle,
        epic_description: epicDescription
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      // If classify endpoint doesn't exist yet, return null (will use rule-based fallback)
      if (response.status === 404) {
        return null;
      }
      const error = await response.text();
      throw new Error(`Flask classification error: ${error}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error calling Flask classification:', error);
    return null; // Fallback to rule-based
  }
}
