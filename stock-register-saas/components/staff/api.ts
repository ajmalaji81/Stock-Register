/** Small JSON fetch helper for the staff/import/adjustment/activity sections. Throws the API's error message. */
export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && typeof window !== "undefined") window.location.href = "/login";
  if (!res.ok) {
    const err = new Error(data.error ?? `Request failed (${res.status})`) as Error & { code?: string };
    err.code = data.code;
    throw err;
  }
  return data as T;
}
