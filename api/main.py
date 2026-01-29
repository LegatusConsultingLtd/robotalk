import os
import json
import re
from typing import Optional, Literal, List, Dict, Tuple
from dotenv import load_dotenv
load_dotenv()
from fastapi import FastAPI, Depends, File, UploadFile, HTTPException, Form, status, Request
from fastapi_users.exceptions import UserAlreadyExists, InvalidPasswordException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from openai import OpenAI
from sqlalchemy.exc import IntegrityError


from auth import fastapi_users, auth_backend, User, engine, Base, current_user, UserRead, UserCreate

current_active_user = fastapi_users.current_user(active=True)
current_superuser = fastapi_users.current_user(active=True, superuser=True)


# -------------------------
# Setup
# -------------------------
client = None

def get_openai_client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not set")
    return OpenAI(api_key=api_key)

from fastapi.openapi.utils import get_openapi

app = FastAPI(
    title="Robotalk API",
    openapi_url="/openapi.json",
    docs_url="/docs",
    redoc_url=None,
    swagger_ui_parameters={"defaultModelsExpandDepth": -1}  # disables model expansion
)

import logging
logger = logging.getLogger("robotalk")

@app.middleware("http")
async def log_exceptions(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception:
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        raise


from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_EXEMPT_PREFIXES = ("/auth",)
CSRF_EXEMPT_PATHS = {"/docs", "/openapi.json"}

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_EXEMPT_PREFIXES = ("/auth",)
CSRF_EXEMPT_PATHS = {"/docs", "/openapi.json"}

@app.middleware("http")
async def csrf_middleware(request: Request, call_next):
    path = request.url.path

    if request.method in SAFE_METHODS:
        return await call_next(request)

    if path in CSRF_EXEMPT_PATHS or path.startswith(CSRF_EXEMPT_PREFIXES):
        return await call_next(request)

    csrf_cookie = request.cookies.get("robotalk_csrf")
    csrf_header = request.headers.get("X-CSRF-Token")

    if not csrf_cookie or not csrf_header or csrf_cookie != csrf_header:
        return JSONResponse(status_code=403, content={"detail": "CSRF check failed"})

    return await call_next(request)


def custom_openapi():
    """
    Prevent FastAPI from hanging when building OpenAPI on Windows
    by fully excluding 'auth' and 'users' routes from schema generation.
    """
    if app.openapi_schema:
        return app.openapi_schema

    from fastapi.openapi.utils import get_openapi

    # Only include *non-auth* routes in the schema
    filtered_routes = [
        route for route in app.routes
        if not any(tag in ["auth", "users"] for tag in getattr(route, "tags", []))
    ]

    openapi_schema = get_openapi(
        title="Robotalk API",
        version="1.0.0",
        description="Robotalk API backend with authentication and drafting tools",
        routes=filtered_routes
    )
    app.openapi_schema = openapi_schema
    return app.openapi_schema

app.openapi = custom_openapi



FRONTEND_ORIGINS = os.getenv(
    "FRONTEND_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in FRONTEND_ORIGINS],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


import secrets
from fastapi import Response

@app.get("/auth/csrf")
def get_csrf(response: Response):
    token = secrets.token_urlsafe(32)
    env = os.getenv("ENV", "dev")
    secure = env == "production"
    csrf_samesite = "none" if env == "production" else "lax"

    response.set_cookie(
        key="robotalk_csrf",
        value=token,
        httponly=False,
        secure=secure,
        samesite=csrf_samesite,
        max_age=3600,
        path="/",
    )

    return {"csrf_token": token}


import asyncio
from sqlalchemy import create_engine

@app.on_event("startup")
async def on_startup():
    db_url = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./users.db")

    if db_url.startswith("sqlite"):
        # Ensure we create tables in the same sqlite file
        sync_db_url = db_url.replace("+aiosqlite", "")
        sync_engine = create_engine(sync_db_url, echo=False)
        Base.metadata.create_all(bind=sync_engine)
        sync_engine.dispose()
        print("✅ Database initialized (SQLite dev)")
    else:
        print("✅ Skipping auto-create tables (non-SQLite DB). Use migrations in prod.")




# -------------------------
# Transcript Normalization
# -------------------------
def normalize_transcript(text: str) -> Tuple[str, List[Dict]]:
    replacements = {
        "Robotoq": "Robotalk",
        "RoboTalk": "Robotalk",
        "Radburry": "Radbury",
        "Radberry": "Radbury",
    }

    changes: List[Dict] = []
    clean = text or ""

    for src, dst in replacements.items():
        if src in clean:
            clean = clean.replace(src, dst)
            changes.append({"from": src, "to": dst})

    return clean, changes


# -------------------------
# Models
# -------------------------
class DraftRequest(BaseModel):
    email_context: str = Field(..., description="The original inbound email/thread pasted in for context.")
    instruction: str = Field(..., description="What the MD said (voice transcript or typed).")

    mode: Literal["draft", "rewrite", "edit"] = "draft"
    selected_text: Optional[str] = Field(None, description="Highlighted portion to change when mode='edit'.")

    # NEW: allow the UI to send the existing draft back in for edit-mode precision
    current_draft: Optional[str] = Field(None, description="The current draft email body (for mode='edit').")

    tone: Literal["friendly", "professional", "firm", "warm", "direct"] = "professional"
    length: Literal["shorter", "same", "longer"] = "same"
    detail: Literal["less", "same", "more"] = "same"

    company_name: str = "Radbury Double Glazing"


class DraftResponse(BaseModel):
    subject_suggestion: str
    reply_draft: str
    assumptions: List[str]
    questions_to_confirm: List[str]


# -------------------------
# Helpers
# -------------------------
def _extract_json(text: str) -> dict:
    """
    Tries strict json.loads first, then falls back to extracting the first {...} block.
    """
    text = (text or "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Fallback: extract first JSON object block
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


# -------------------------
# Core Drafting Function
# -------------------------
def generate_draft(req: DraftRequest, client: OpenAI) -> DraftResponse:
    system = (
        "You are an expert executive assistant for a UK double glazing company. "
        "Draft clear, accurate, professional emails. Use UK spelling. "
        "Do NOT invent facts. If key info is missing, ask short questions at the end. "
        "Avoid admitting liability. Avoid promising refunds/replacements/compensation unless explicitly instructed. "
        "Return ONLY valid JSON. No markdown. No extra commentary."
    )

    style_controls = (
        f"\nSTYLE CONTROLS:\n"
        f"- Tone: {req.tone}\n"
        f"- Length: {req.length}\n"
        f"- Detail: {req.detail}\n"
        f"- Company: {req.company_name}\n"
    )

    if req.mode == "edit":
        if not req.selected_text:
            raise HTTPException(status_code=400, detail="mode='edit' requires selected_text")
        if not req.current_draft:
            raise HTTPException(status_code=400, detail="mode='edit' requires current_draft (the existing email body)")

        mode_instructions = (
            "You are editing an existing email draft.\n"
            "CRITICAL RULES:\n"
            "1) You MUST keep the email identical EXCEPT for the selected text.\n"
            "2) Do NOT rephrase or change anything outside the selected text.\n"
            "3) If the instruction implies removing something, remove ONLY within the selected text.\n"
            "4) Return the FULL updated email body.\n"
        )

        prompt = (
            f"{mode_instructions}\n"
            f"{style_controls}\n"
            f"\nEMAIL CONTEXT (INBOUND THREAD):\n---\n{req.email_context}\n---\n"
            f"\nCURRENT DRAFT (EMAIL BODY):\n---\n{req.current_draft}\n---\n"
            f"\nSELECTED TEXT TO CHANGE (EXACT SUBSTRING FROM CURRENT DRAFT):\n---\n{req.selected_text}\n---\n"
            f"\nEDIT INSTRUCTION:\n---\n{req.instruction}\n---\n"
            "Return STRICT JSON with keys:\n"
            "- subject_suggestion (string)\n"
            "- reply_draft (string, email body only)\n"
            "- assumptions (list of strings)\n"
            "- questions_to_confirm (list of strings)\n"
            "In edit mode, assumptions/questions should usually be empty unless the instruction introduces new unknowns.\n"
        )

    else:
        mode_instructions = (
            "Rewrite the reply from scratch using the context and instruction."
            if req.mode == "rewrite"
            else "Draft a reply from scratch using the context and instruction."
        )

        prompt = (
            f"{mode_instructions}\n"
            f"{style_controls}\n"
            f"\nEMAIL CONTEXT (INBOUND THREAD):\n---\n{req.email_context}\n---\n"
            f"\nMD INSTRUCTION (VOICE/TEXT):\n---\n{req.instruction}\n---\n"
            "Return STRICT JSON with keys:\n"
            "- subject_suggestion (string)\n"
            "- reply_draft (string, email body only)\n"
            "- assumptions (list of strings)\n"
            "- questions_to_confirm (list of strings)\n"
        )

    result = client.responses.create(
        model="gpt-4o-mini",
        input=[
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        temperature=0,
    )

    raw = (result.output_text or "").strip()

    try:
        parsed = _extract_json(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="Model returned invalid JSON. Raw output:\n" + raw)

    return DraftResponse(
        subject_suggestion=parsed.get("subject_suggestion", "") or "Re: Your email",
        reply_draft=parsed.get("reply_draft", "") or "",
        assumptions=parsed.get("assumptions", []) or [],
        questions_to_confirm=parsed.get("questions_to_confirm", []) or [],
    )


# -------------------------
# Routes
# -------------------------
@app.get("/health")
def health():
    return {"ok": True, "name": "Robotalk API"}

@app.get("/debug/routes")
def debug_routes():
    return sorted([getattr(r, "path", str(r)) for r in app.routes])


@app.post("/transcribe", response_model=None)
async def transcribe(audio: UploadFile = File(...),
                     user: User = Depends(current_user),):
    """
    Secure endpoint to handle audio file transcription.
    Requires an authenticated user.
    """
    try:
        audio_bytes = await audio.read()
        client = get_openai_client()
        transcript = client.audio.transcriptions.create(
            model="gpt-4o-mini-transcribe",
            file=(audio.filename, audio_bytes, audio.content_type or "application/octet-stream"),
        )

        raw_text = transcript.text or ""
        clean_text, changes = normalize_transcript(raw_text)

        return {
            "text": clean_text,
            "raw_text": raw_text,
            "normalization_changes": changes,
            
        }

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))



@app.post("/draft", response_model=DraftResponse)
async def draft_email(req: DraftRequest,
                      user: User = Depends(current_user),
):
    try:
        client = get_openai_client()
        return generate_draft(req, client)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/draft_form", response_model=DraftResponse)
def draft_email_form(
    user: User = Depends(current_user),
    email_context: str = Form(...),
    instruction: str = Form(...),
    mode: Literal["draft", "rewrite", "edit"] = Form("draft"),
    selected_text: Optional[str] = Form(None),
    current_draft: Optional[str] = Form(None),
    tone: Literal["friendly", "professional", "firm", "warm", "direct"] = Form("professional"),
    length: Literal["shorter", "same", "longer"] = Form("same"),
    detail: Literal["less", "same", "more"] = Form("same"),
    company_name: str = Form("Radbury Double Glazing"),
):
    try:
        req = DraftRequest(
            email_context=email_context,
            instruction=instruction,
            mode=mode,
            selected_text=selected_text,
            current_draft=current_draft,
            tone=tone,
            length=length,
            detail=detail,
            company_name=company_name,
        )
        client = get_openai_client()
        return generate_draft(req, client)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# -------------------------
# Auth routes
# -------------------------
from auth import fastapi_users, auth_backend, UserRead, UserCreate

# JWT login
app.include_router(
    fastapi_users.get_auth_router(auth_backend),
    prefix="/auth/jwt",
    tags=["auth"]
)


#Optional: enable user management routes (disable in prod if not needed)
app.include_router(
    fastapi_users.get_users_router(UserRead, UserCreate),
    prefix="/users",
    tags=["users"],
    include_in_schema=False
)

from pydantic import BaseModel
from fastapi import Depends
from fastapi_users.manager import BaseUserManager
from auth import current_superuser, User, get_user_manager

class AdminCreateUserRequest(BaseModel):
    email: str
    password: str

@app.post("/admin/create-user", status_code=status.HTTP_201_CREATED)
async def admin_create_user(
    payload: AdminCreateUserRequest,
    request: Request,
    admin: User = Depends(current_superuser),
    user_manager=Depends(get_user_manager),
):
    try:
        user = await user_manager.create(
            UserCreate(email=payload.email, password=payload.password),
            safe=False,
            request=request,
        )
        return {"id": str(user.id), "email": user.email}

    except UserAlreadyExists:
        raise HTTPException(status_code=409, detail="USER_ALREADY_EXISTS")

    except IntegrityError:
        # covers unique constraint violations that didn't get mapped to UserAlreadyExists
        raise HTTPException(status_code=409, detail="USER_ALREADY_EXISTS")

    except InvalidPasswordException as e:
        raise HTTPException(
            status_code=400,
            detail={"error": "INVALID_PASSWORD", "reason": e.reason},
        )







