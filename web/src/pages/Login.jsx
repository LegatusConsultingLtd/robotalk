import { useState } from "react";
import { login } from "../api/auth";

export default function Login({ onLoginSuccess }) {
  console.log("Login component rendered");  
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    console.log("handleSubmit fired");
    console.log("Submitting login for:", email);
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
    console.log("Calling login()");
    await login(email, password);
    console.log("Login success, calling onLoginSuccess()");
    await onLoginSuccess();
    } catch (err) {

      console.error("Login failed:", err);  
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "60px auto", padding: 20 }}>
      <h1>Robotalk</h1>

      <form onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && <div style={{ color: "red" }}>{error}</div>}

        <button type="submit" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
