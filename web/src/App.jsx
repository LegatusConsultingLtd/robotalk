import { useEffect, useMemo, useRef, useState } from "react";
import { ensureCsrf, apiFetch } from "./api/http";
const legatusLogo = "/legatus-logo.png"; // from /public
import Login from "./pages/Login";
import { getMe, logout } from "./api/auth";


const LS_KEY = "robotalk_versions_v1";

function MicIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M19 11a7 7 0 0 1-14 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12 18v3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M8 21h8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MailIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="m5 7 7 6 7-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function App() {
  const [composeMode, setComposeMode] = useState("reply"); // "reply" | "compose"

  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const [emailContext, setEmailContext] = useState("");
  const [instruction, setInstruction] = useState("");

  const [authStatus, setAuthStatus] = useState("loading"); // loading | authed | unauthed
  const [me, setMe] = useState(null);

  async function refreshSession() {
    setAuthStatus("loading");
    try {
      const user = await getMe();
      setMe(user);
      setAuthStatus("authed");
    } catch {
      setMe(null);
      setAuthStatus("unauthed");
    }
  }

  async function handleLogout() {
    try {
      await logout();
    } finally {
      await refreshSession();
    }
  }

// 1️⃣ On app load: check if we already have a valid login session
useEffect(() => {
  refreshSession();
}, []);

// 2️⃣ Once authenticated: fetch CSRF token
useEffect(() => {
  if (authStatus === "authed") {
    ensureCsrf();
  }
}, [authStatus]);


  // Draft output is editable
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");

  // Voice edit
  const [editInstruction, setEditInstruction] = useState("");
  const [selectedText, setSelectedText] = useState("");

  // Version history
  const [versions, setVersions] = useState([]);
  const [activeVersionId, setActiveVersionId] = useState(null);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const draftBodyRef = useRef(null);

  const canDraft = useMemo(() => {
    return emailContext.trim().length > 0 && instruction.trim().length > 0;
  }, [emailContext, instruction]);

  const canApplyEdit = useMemo(() => {
    return draftBody.trim().length > 0 && selectedText.trim().length > 0 && editInstruction.trim().length > 0;
  }, [draftBody, selectedText, editInstruction]);

  // Load versions
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
      setVersions(saved);
      if (saved?.[0]?.id) setActiveVersionId(saved[0].id);
    } catch {
      // ignore
    }
  }, []);

  // Persist versions
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(versions));
  }, [versions]);

  function pushVersion(type, snapshot) {
    const id = crypto.randomUUID();
    const v = {
      id,
      type, // "draft" | "edit"
      ts: Date.now(),
      snapshot,
    };
    setVersions((prev) => [v, ...prev].slice(0, 50));
    setActiveVersionId(id);
  }

  function openVersion(v) {
    setActiveVersionId(v.id);
    const s = v.snapshot;
    setComposeMode(s.composeMode || "reply");
    setEmailContext(s.emailContext || "");
    setInstruction(s.instruction || "");
    setDraftSubject(s.draftSubject || "");
    setDraftBody(s.draftBody || "");
    setEditInstruction("");
    setSelectedText("");
    setStatus(`Loaded ${v.type} from history ✅`);
    setError("");
  }

  async function startRecording(target = "instruction") {
    setError("");
    setStatus("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = { recorder, stream, target };
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        await transcribeBlob(blob, target);
      };

      recorder.start();
      setIsRecording(true);
      setStatus(target === "instruction" ? "Recording instruction…" : "Recording edit instruction…");
    } catch (e) {
      setError(`Mic error: ${e?.message || String(e)}`);
    }
  }

  function stopRecording() {
    setError("");
    setStatus("Stopping…");
    try {
      const handle = mediaRecorderRef.current;
      handle?.recorder?.stop();
      setIsRecording(false);
    } catch (e) {
      setError(`Stop error: ${e?.message || String(e)}`);
    }
  }

  async function transcribeBlob(blob, target) {
    setError("");
    setStatus("Transcribing…");

    try {
      const fd = new FormData();
      fd.append("audio", blob, "recording.webm");

      const res = await apiFetch("/transcribe", {
        method: "POST",
        body: fd,
      });


      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Transcribe failed (${res.status}): ${txt}`);
      }

      const data = await res.json();
      const text = data.text || "";

      if (target === "edit") {
        setEditInstruction(text);
        setStatus("Edit instruction transcribed ✅");
      } else {
        setInstruction(text);
        setStatus("Instruction transcribed ✅ (you can edit the text if you want).");
      }
    } catch (e) {
      setError(e?.message || String(e));
      setStatus("");
    }
  }

  async function draftEmail() {
    setError("");
    setStatus("Drafting…");

    try {
      const payload = {
        email_context: emailContext,
        instruction,
        mode: "draft",
        tone: "professional",
        length: "same",
        detail: "more",
        company_name: "Radbury Double Glazing",
      };

      const res = await apiFetch("/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });


      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Draft failed (${res.status}): ${txt}`);
      }

      const data = await res.json();
      setDraftSubject(data.subject_suggestion || "");
      setDraftBody(data.reply_draft || "");
      setStatus("Draft ready ✅");

      pushVersion("draft", {
        composeMode,
        emailContext,
        instruction,
        draftSubject: data.subject_suggestion || "",
        draftBody: data.reply_draft || "",
      });
    } catch (e) {
      setError(e?.message || String(e));
      setStatus("");
    }
  }

  function captureSelectedText() {
    const el = draftBodyRef.current;
    if (!el) return;

    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const sel = (el.value || "").slice(start, end);
    setSelectedText(sel.trim());
  }

  async function applyEdit() {
    setError("");
    setStatus("Applying edit…");

    try {
      const payload = {
        email_context: emailContext,
        instruction: editInstruction,
        mode: "edit",
        selected_text: selectedText,
        current_draft: draftBody,
        tone: "professional",
        length: "same",
        detail: "same",
        company_name: "Radbury Double Glazing",
      };

      const res = await apiFetch("/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Edit failed (${res.status}): ${txt}`);
      }

      const data = await res.json();
      // Model returns updated email body in reply_draft (full email body)
      setDraftBody(data.reply_draft || draftBody);
      setStatus("Edit applied ✅");

      pushVersion("edit", {
        composeMode,
        emailContext,
        instruction,
        draftSubject,
        draftBody: data.reply_draft || draftBody,
      });
    } catch (e) {
      setError(e?.message || String(e));
      setStatus("");
    }
  }

  async function copyToClipboard() {
    setError("");
    try {
      const full = `Subject: ${draftSubject}\n\n${draftBody}`;
      await navigator.clipboard.writeText(full);
      setStatus("Copied ✅");
    } catch (e) {
      setError(`Copy failed: ${e?.message || String(e)}`);
    }
  }

  function openInEmail() {
    const subj = encodeURIComponent(draftSubject || "");
    const body = encodeURIComponent(draftBody || "");
    window.location.href = `mailto:?subject=${subj}&body=${body}`;
  }

  function clearAll() {
    setComposeMode("reply");
    setEmailContext("");
    setInstruction("");
    setDraftSubject("");
    setDraftBody("");
    setEditInstruction("");
    setSelectedText("");
    setStatus("");
    setError("");
  }
  
    if (authStatus === "loading") {
    return <div style={{ padding: 20 }}>Loading…</div>;
  }

  if (authStatus === "unauthed") {
    return <Login onLoginSuccess={refreshSession} />;
  }

  return (
    <div className="appShell">
      <div className="topNav">
        <div className="brand">
          <div style={{ display: "flex", alignItems: "center", marginRight: "8px" }}>
            <img className="brandLogoWide" src={legatusLogo} alt="Legatus Consulting Ltd" />
          </div>

          <div className="brandText">
            <div className="brandTitle">Robotalk</div>
            <div className="brandSub">Legatus • email drafting assistant</div>
          </div>
        </div>

        <div className="navRight">
          <span className="pill">{composeMode === "reply" ? "REPLY" : "COMPOSE"}</span>
        </div>

      </div>
      <div className="dividerGold" />

      <div className="mainGrid">
        {/* LEFT: Versions */}
        <div className="panel">
          <div className="panelHeader versionsHeader">
          <div className="panelTitle">Versions</div>
          <div className="historyPillWrapper">
            <span className="pill historyPill">HISTORY</span>
          </div>
        </div>



          <div className="panelBody">
            {versions.length === 0 ? (
              <div style={{ color: "rgba(255,255,255,0.55)" }}>No drafts yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {versions.map((v) => {
                  const d = new Date(v.ts);
                  const active = v.id === activeVersionId;
                  return (
                    <button
                      key={v.id}
                      className="listItem"
                      onClick={() => openVersion(v)}
                      style={{
                        borderColor: active ? "rgba(212,175,55,0.45)" : undefined,
                      }}
                      title="Load this version"
                    >
                      <div className="listMeta">
                        <div className="listTop">
                          {v.type === "edit" ? "Edit" : "Draft"} •{" "}
                          {d.toLocaleDateString()} {d.toLocaleTimeString()}
                        </div>
                        <div className="listSub">
                          {v.snapshot?.draftSubject ? v.snapshot.draftSubject : "No subject"}
                        </div>
                      </div>
                      <div style={{ color: "rgba(255,255,255,0.55)", fontWeight: 800 }}>
                        Open
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* MIDDLE: Inputs */}
        <div className="panel">
          <div className="panelHeader">
            <div className="panelTitle">Inputs</div>

            <div className="panelHeaderRight">
              <button
                className="btn btnPrimary"
                onClick={() => setComposeMode((m) => (m === "reply" ? "compose" : "reply"))}
                title="Toggle Reply / Compose"
              >
                ⏱️ Toggle: {composeMode === "reply" ? "Reply" : "Compose"}
              </button>

              {!isRecording ? (
                <button className="btn" onClick={() => startRecording("instruction")}>
                  <MicIcon /> Start Instruction
                </button>
              ) : (
                <button className="btn btnDanger" onClick={stopRecording}>
                  <MicIcon /> Stop
                </button>
              )}

              <button className="btn btnPrimary" onClick={draftEmail} disabled={!canDraft}>
                <MailIcon /> Draft
              </button>

              <button className="btn" onClick={clearAll}>
                🧽 Clear
              </button>
            </div>
          </div>

          <div className="panelBody">
            {status && <div className={`toast ok`}>{status}</div>}
            {error && <div className={`toast err`}>{error}</div>}

            <div className="sectionLabel">
              <span>{composeMode === "reply" ? "Inbound email thread" : "Compose brief"}</span>
              <span className="kbd">Ctrl + V works fine too</span>
            </div>

            <textarea
              className="textArea"
              value={emailContext}
              onChange={(e) => setEmailContext(e.target.value)}
              placeholder={
                composeMode === "reply"
                  ? "Paste the inbound email thread here…"
                  : "Describe who you’re emailing, what you want to say, and any constraints (tone, deadline, quote refs, attachments)…"
              }
              rows={25}
            />

            <div className="sectionLabel">
              <span>Instruction (from mic, editable)</span>
              <span style={{ color: "rgba(255,255,255,0.52)" }}>
                Tip: keep it short & specific
              </span>
            </div>

            <textarea
              className="textArea"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Speak or type your instruction…"
              rows={6}
            />

            <div className="smallNote">
              <span style={{ color: "var(--goldSoft)", fontWeight: 800 }}>Pro tip:</span>{" "}
              In <b>Compose</b> mode, paste recipient + purpose + constraints in the context box — Robotalk can draft from that without extra fields.
            </div>
          </div>
        </div>

        {/* RIGHT: Draft + Edit */}
        <div className="panel rightCol">
          <div className="panelHeader">
            <div className="panelTitle">Draft</div>

            <div className="panelHeaderRight">
              <button className="btn" onClick={copyToClipboard} disabled={!draftBody}>
                📋 Copy
              </button>
              <button className="btn btnPrimary" onClick={openInEmail} disabled={!draftBody}>
                ✉️ Open in Email
              </button>
            </div>
          </div>

          <div className="panelBody">
            <div className="sectionLabel">Subject</div>
            <input
              className="textInput"
              value={draftSubject}
              onChange={(e) => setDraftSubject(e.target.value)}
              placeholder="Subject will appear here…"
            />

            <div className="sectionLabel" style={{ marginTop: 12 }}>
              <span>Email body (editable)</span>
              <span className="labelRight">
                <span className="badge">Select text to voice-edit</span>
              </span>
            </div>


            <textarea
              ref={draftBodyRef}
              className="textArea"
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              onMouseUp={captureSelectedText}
              onKeyUp={captureSelectedText}
              placeholder="Your draft will appear here after you click Draft."
              rows={12}
            />

            <div className="smallNote">
              Select text in the draft above to edit via voice.
            </div>

            <div className="sectionLabel" style={{ marginTop: 14 }}>
              <span>Voice edit selected text</span>
            </div>

            <div className="labelRight" style={{ marginBottom: 10 }}>
              <span className="badge">Selected</span>
              <span className="badge badgeGold" title={selectedText || ""}>
                {selectedText
                  ? `${selectedText.slice(0, 60)}${selectedText.length > 60 ? "…" : ""}`
                  : "—"}
              </span>
            </div>



            <textarea
              className="textArea"
              value={editInstruction}
              onChange={(e) => setEditInstruction(e.target.value)}
              placeholder="E.g. Remove this question — she already confirmed supply & fit."
              rows={4}
            />

            <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
              {!isRecording ? (
                <button className="btn" onClick={() => startRecording("edit")} disabled={!draftBody}>
                  <MicIcon /> Record Edit
                </button>
              ) : (
                <button className="btn btnDanger" onClick={stopRecording}>
                  <MicIcon /> Stop
                </button>
              )}

              <button className="btn btnPrimary" onClick={applyEdit} disabled={!canApplyEdit}>
                ✨ Apply Edit
              </button>
            </div>
          </div>

          <div className="footerLine">A Legatus Consulting Ltd product.</div>
        </div>
      </div>
    </div>
  );
}
