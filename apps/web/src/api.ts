export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export async function api<T>(path: string, body?: unknown, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const error: { error?: string } = await response.json().catch(() => ({}));
    throw new ApiError(response.status, error.error ?? 'REQUEST_FAILED');
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}
