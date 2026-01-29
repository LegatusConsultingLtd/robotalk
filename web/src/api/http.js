const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8001";

export async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include", // REQUIRED for cookie auth
  });

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const message = data?.detail || data?.message || `${res.status} ${res.statusText}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }

  return data;
}
