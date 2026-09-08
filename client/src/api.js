const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...JSON_HEADERS, ...(options.headers || {}) },
  });

  if (res.status === 401) {
    const redirectTo = window.location.pathname + window.location.search;
    window.location.href = `/login?redirectURL=${encodeURIComponent(redirectTo)}`;
    // Never resolves
    return new Promise(() => {});
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const message = data?.message || data?.error || `Request failed (${res.status})`;
    throw new Error(message);
  }

  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: (path, body) => request(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  del: (path) => request(path, { method: 'DELETE' }),
};
