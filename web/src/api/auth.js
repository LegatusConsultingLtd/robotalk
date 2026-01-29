import { apiFetch } from "./http";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8001";

export async function login(email, password) {
  const body = new URLSearchParams();
  body.append("username", email);
  body.append("password", password);

  const res = await fetch(`${API_BASE}/auth/jwt/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    credentials: "include",
  });

  if (!res.ok) {
    let detail = "";
    try {
      const data = await res.json();
      detail = data?.detail ? JSON.stringify(data.detail) : "";
    } catch {}
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
}

export async function logout() {
  await fetch(`${API_BASE}/auth/jwt/logout`, {
    method: "POST",
    credentials: "include",
  });
}

export async function getMe() {
  return await apiFetch("/users/me", { method: "GET" });
}

