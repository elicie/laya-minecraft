import type { ApiError } from "../../../../packages/contracts/src";

export const API = "/api/v1";

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return "요청을 처리하지 못했습니다.";
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body || (options.method && options.method !== "GET"))
    headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") {
    headers.set("Idempotency-Key", crypto.randomUUID());
    headers.set("X-Laya-Control", "1");
  }
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers,
    signal: options.signal ?? AbortSignal.timeout(15_000),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = (body as Partial<ApiError>)?.error;
    throw new Error(
      typeof error === "string"
        ? error
        : (error?.message ?? "요청을 처리하지 못했습니다."),
    );
  }
  return body as T;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return request(path, { method: "PATCH", body: JSON.stringify(body) });
}
