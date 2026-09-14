export const DEFAULT_TTS_INSTRUCTIONS = [
  "Habla en español latino neutro con una voz cálida, cercana y alegre.",
  "Suena como una narradora infantil amable: natural, paciente y expresiva, nunca robótica.",
  "Pronuncia con claridad, usa pausas breves y conserva una energía tranquila.",
].join(" ");

export class OpenAIRequestError extends Error {
  constructor(message, { status = 500, code = "openai_request_failed" } = {}) {
    super(message);
    this.name = "OpenAIRequestError";
    this.status = status;
    this.code = code;
  }
}

function normalizeApiError(status, payload) {
  const apiCode = payload?.error?.code || payload?.error?.type || "openai_request_failed";
  const message = payload?.error?.message || `OpenAI TTS request failed (${status})`;
  if (status === 429 && ["insufficient_quota", "credit_balance_exhausted"].includes(apiCode)) {
    return new OpenAIRequestError(
      "La cuenta de OpenAI API no tiene saldo disponible. Los créditos de ChatGPT no se usan en la API.",
      { status: 402, code: "openai_api_credit_required" },
    );
  }
  return new OpenAIRequestError(message, { status, code: apiCode });
}

export async function synthesizeSpeech({
  apiKey,
  input,
  model = "gpt-4o-mini-tts",
  voice = "marin",
  instructions = DEFAULT_TTS_INSTRUCTIONS,
  fetchImpl = fetch,
}) {
  if (!apiKey) {
    throw new OpenAIRequestError("OPENAI_API_KEY no está configurada.", {
      status: 503,
      code: "openai_api_not_configured",
    });
  }
  const narration = String(input || "").trim();
  if (!narration) {
    throw new OpenAIRequestError("La narración está vacía.", {
      status: 400,
      code: "empty_narration",
    });
  }
  if (narration.length > 4096) {
    throw new OpenAIRequestError("La narración supera el límite de 4096 caracteres por escena.", {
      status: 400,
      code: "narration_too_long",
    });
  }

  const response = await fetchImpl("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice,
      input: narration,
      instructions,
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Keep the normalized status-only error when the upstream body is not JSON.
    }
    throw normalizeApiError(response.status, payload);
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    model,
    voice,
  };
}
