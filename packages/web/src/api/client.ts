const BASE_URL = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  // 204 No Content (and any other empty-body response) must not be parsed
  // as JSON. Return undefined so the caller's `data.success` / `.error`
  // path doesn't blow up.
  if (res.status === 204) {
    if (!res.ok) throw new Error('Request failed');
    return undefined as T;
  }
  // Some responses may legitimately have no body even without 204; guard
  // against "Unexpected end of JSON input" by checking content-length /
  // body presence before parsing.
  const text = await res.text();
  const data = text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
  if (!res.ok) {
    const errMsg =
      data && typeof data === 'object' && 'error' in data
        ? (data as { error?: string }).error
        : undefined;
    throw new Error(errMsg || 'Request failed');
  }
  return data;
}

export function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  return request<T>(url, signal ? { signal } : undefined);
}

export function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, { method: 'POST', body: JSON.stringify(body) });
}

export function put<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, { method: 'PUT', body: JSON.stringify(body) });
}

export function del<T = unknown>(url: string): Promise<T> {
  return request<T>(url, { method: 'DELETE' });
}
