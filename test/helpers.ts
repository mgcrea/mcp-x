import type { vi } from "vitest";

/** A JSON `Response`, the shape every mocked `fetch` in these tests returns. */
export const json = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });

export const jsonResponse = json;

type Mock = ReturnType<typeof vi.fn>;

/** The URL a mocked fetch was called with. */
export const urlOf = (mock: Mock, call = 0): string => String(mock.mock.calls[call]?.[0]);

/** The `RequestInit` a mocked fetch was called with. */
export const initOf = (mock: Mock, call = 0): RequestInit =>
  (mock.mock.calls[call]?.[1] ?? {}) as RequestInit;
