export type Scene = {
  id?: string;
  name: string;
  order?: number;
};

export type CaseContext = {
  id: string;
  name?: string;
  location?: string;
  scenes?: Scene[];
  [key: string]: unknown;
};

export type ChatTurn = { role: "user" | "assistant"; text: string };

/** Estado de la entrevista pericial que lleva el servicio local (Ollama). */
export type InterviewState = {
  caseId: string;
  modalidad: string;
  vehiculos: Record<string, string>;
  estado: Record<string, unknown>;
  tema: string | null;
  pregunta: string | null;
  progress: number;
  answered: number;
  total: number;
  done: boolean;
  transcript: ChatTurn[];
  aviso?: string;
};

export type AssistantStatus = {
  available: boolean;
  model?: string;
  modalidades: Record<string, string>;
  hint?: string;
};

/** Valor que el servicio guarda cuando el perito escribe "saltar". */
export const INTERVIEW_SKIPPED = "__saltado__";

type ApiError = Error & { status?: number };

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");
const CASE_ID = import.meta.env.VITE_CASE_ID || "EXP-0248";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Spread `init` first so its `headers` cannot overwrite the merged headers below.
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    // Use the service's own message ({ error, hint }) when there is one.
    let detail = "";
    try {
      const payload = (await response.json()) as { error?: string; hint?: string };
      detail = [payload.error, payload.hint].filter(Boolean).join(" ");
    } catch {
      // The body was not JSON; fall back to the generic message.
    }
    const error: ApiError = new Error(
      detail || `API request failed with status ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  caseId: CASE_ID,

  getCase: () => request<CaseContext>(`/cases/${encodeURIComponent(CASE_ID)}`),

  getScenes: async () => {
    const payload = await request<Scene[] | { scenes: Scene[] }>(
      `/cases/${encodeURIComponent(CASE_ID)}/scenes`,
    );
    return Array.isArray(payload) ? payload : payload.scenes;
  },

  createScene: (name: string, order: number) =>
    request<Scene>(`/cases/${encodeURIComponent(CASE_ID)}/scenes`, {
      method: "POST",
      body: JSON.stringify({ name, order }),
    }),

  updateScene: (sceneId: string, name: string) =>
    request<Scene>(`/scenes/${encodeURIComponent(sceneId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  deleteScene: (sceneId: string) =>
    request<void>(`/scenes/${encodeURIComponent(sceneId)}`, { method: "DELETE" }),

  getAssistantStatus: () => request<AssistantStatus>("/ai/status"),

  getInterview: () => request<InterviewState>(`/ai/interview/${encodeURIComponent(CASE_ID)}`),

  startInterview: (modalidad: string, vehiculos: Record<string, string>) =>
    request<InterviewState>("/ai/interview/start", {
      method: "POST",
      body: JSON.stringify({ caseId: CASE_ID, modalidad, vehiculos }),
    }),

  answerInterview: (respuesta: string) =>
    request<InterviewState>("/ai/interview/answer", {
      method: "POST",
      body: JSON.stringify({ caseId: CASE_ID, respuesta }),
    }),

  resetInterview: () =>
    request<{ ok: boolean }>("/ai/interview/reset", {
      method: "POST",
      body: JSON.stringify({ caseId: CASE_ID }),
    }),

  sendAssistantMessage: async (
    message: string,
    context: Record<string, unknown>,
    onToken: (token: string) => void,
  ) => {
    const response = await fetch(`${API_BASE_URL}/ai/chat`, {
      method: "POST",
      headers: {
        Accept: "text/event-stream, application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ caseId: CASE_ID, message, context, stream: true }),
    });

    if (!response.ok) {
      throw new Error(`AI request failed with status ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!response.body || !contentType.includes("text/event-stream")) {
      const payload = (await response.json()) as { answer?: string; message?: string };
      const answer = payload.answer || payload.message || "";
      if (answer) onToken(answer);
      return answer;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";

    const consumeEvent = (event: string) => {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data) as { token?: string; answer?: string; content?: string };
        const token = parsed.token || parsed.content || parsed.answer || "";
        answer += token;
        if (token) onToken(token);
      } catch {
        answer += data;
        onToken(data);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      events.forEach(consumeEvent);
      if (done) break;
    }
    consumeEvent(buffer);

    return answer;
  },
};
