import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  createScene,
  findSceneAcrossCases,
  getCase,
  renameScene,
  updateScenes,
} from "./_store";

type JsonRecord = Record<string, unknown>;

const sendJson = (response: VercelResponse, status: number, body: unknown) => {
  response.status(status).json(body);
};

const requestBody = (request: VercelRequest): JsonRecord => {
  if (!request.body) return {};
  if (typeof request.body === "object") return request.body as JsonRecord;
  try {
    return JSON.parse(String(request.body)) as JsonRecord;
  } catch {
    return {};
  }
};

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
};

const pathParts = (request: VercelRequest) => {
  const rawPath = Array.isArray(request.query.path)
    ? request.query.path.join("/")
    : String(request.query.path ?? "");
  // A malformed escape such as "%E0" would make decodeURIComponent throw outside the try/catch.
  const safeDecode = (part: string) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  return rawPath.split("/").filter(Boolean).map(safeDecode);
};

// Servicio local del asistente pericial (chatbot-service/server.py, que usa Ollama).
const CHATBOT_URL = (process.env.CHATBOT_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const CHATBOT_TIMEOUT_MS = 300_000; // la primera respuesta carga el modelo en memoria

const forwardToChatbot = async (
  response: VercelResponse,
  upstreamPath: string,
  body?: JsonRecord,
) => {
  let upstream: Response;
  try {
    upstream = await fetch(`${CHATBOT_URL}${upstreamPath}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(CHATBOT_TIMEOUT_MS),
    });
  } catch {
    sendJson(response, 503, {
      error: "El servicio local del chatbot no está activo.",
      hint: "Ejecuta en otra terminal: python chatbot-service/server.py",
    });
    return;
  }
  const text = await upstream.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: text.slice(0, 200) || "Respuesta inválida del chatbot" };
  }
  sendJson(response, upstream.status, payload);
};

const writeAssistantStream = (response: VercelResponse, answer: string) => {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders?.();

  const tokens = answer.match(/\S+\s*/g) ?? [answer];
  for (const token of tokens) {
    response.write(`data: ${JSON.stringify({ token })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  response.end();
};

export default async function handler(request: VercelRequest, response: VercelResponse) {
  // "*" cannot be combined with Access-Control-Allow-Credentials: browsers reject that pair.
  // The API uses no cookies, so credentials are not allowed.
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  const [resource, resourceId, subresource] = pathParts(request);
  const method = request.method ?? "GET";

  try {
    if (resource === "cases" && resourceId) {
      const record = getCase(resourceId);

      if (subresource === "scenes" && method === "GET") {
        sendJson(response, 200, record.scenes);
        return;
      }

      if (subresource === "scenes" && method === "POST") {
        const body = requestBody(request);
        const name = requiredString(body.name, "name");
        const order = typeof body.order === "number" ? body.order : record.scenes.length;
        sendJson(response, 201, createScene(resourceId, name, order));
        return;
      }

      if (!subresource && method === "GET") {
        sendJson(response, 200, record);
        return;
      }
    }

    if (resource === "scenes" && resourceId && method === "PATCH") {
      const body = requestBody(request);
      const match = findSceneAcrossCases(resourceId);
      if (!match) {
        sendJson(response, 404, { error: "Scene not found" });
        return;
      }
      const name = requiredString(body.name, "name");
      sendJson(response, 200, renameScene(match.caseId, resourceId, name));
      return;
    }

    if (resource === "scenes" && resourceId && method === "DELETE") {
      const match = findSceneAcrossCases(resourceId);
      if (!match) {
        sendJson(response, 404, { error: "Scene not found" });
        return;
      }
      const record = getCase(match.caseId);
      updateScenes(
        match.caseId,
        record.scenes.filter((scene) => scene.id !== resourceId),
      );
      response.status(204).end();
      return;
    }

    // --- Entrevista pericial (modelo de Ollama, vía chatbot-service) ---
    if (resource === "ai" && resourceId === "status" && method === "GET") {
      await forwardToChatbot(response, "/health");
      return;
    }

    if (resource === "ai" && resourceId === "interview") {
      if (method === "GET" && subresource) {
        await forwardToChatbot(response, `/interview/${encodeURIComponent(subresource)}`);
        return;
      }
      if (method === "POST" && ["start", "answer", "reset"].includes(subresource ?? "")) {
        await forwardToChatbot(response, `/interview/${subresource}`, requestBody(request));
        return;
      }
    }

    // Respuesta simulada: se usa cuando el servicio del chatbot no está disponible.
    if (resource === "ai" && resourceId === "chat" && method === "POST") {
      const body = requestBody(request);
      const message = requiredString(body.message, "message");
      const answer =
        `He recibido tu consulta: "${message}". ` +
        "Puedo ayudarte a documentar la escena, revisar posiciones y organizar la reconstrucción. " +
        "Este asistente local está listo para conectarse a un proveedor de IA cuando se configure una credencial.";
      if (body.stream === true) {
        writeAssistantStream(response, answer);
      } else {
        sendJson(response, 200, { answer });
      }
      return;
    }

    sendJson(response, 404, { error: "Route not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    sendJson(response, 400, { error: message });
  }
}
