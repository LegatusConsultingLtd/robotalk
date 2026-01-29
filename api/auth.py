# auth.py
import uuid
import os
from typing import Optional, AsyncGenerator
from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from fastapi_users import FastAPIUsers
from fastapi_users_db_sqlalchemy import SQLAlchemyUserDatabase, SQLAlchemyBaseUserTableUUID
from fastapi_users.manager import BaseUserManager, UUIDIDMixin
from fastapi_users.authentication import CookieTransport, JWTStrategy, AuthenticationBackend

# -------------------------
# Database setup
# -------------------------
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "sqlite+aiosqlite:///./users.db"
)

engine = create_async_engine(DATABASE_URL)
async_session_maker = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

# -------------------------
# User model
# -------------------------
class User(SQLAlchemyBaseUserTableUUID, Base):
    __tablename__ = "user"

# -------------------------
# User Manager
# -------------------------

ENV = os.getenv("ENV", "dev")
JWT_SECRET = os.getenv("JWT_SECRET", "CHANGE_THIS_SECRET_BEFORE_DEPLOY")

class UserManager(UUIDIDMixin, BaseUserManager[User, uuid.UUID]):
    user_db_model = User
    reset_password_token_secret = JWT_SECRET
    verification_token_secret = JWT_SECRET

    async def on_after_register(self, user: User, request: Optional[Request] = None):
        print(f"✅ New user registered: {user.email}")

async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        yield session

async def get_user_db(session: AsyncSession = Depends(get_async_session)):
    yield SQLAlchemyUserDatabase(session, User)


# -------------------------
# Authentication backend
# -------------------------


COOKIE_SAMESITE = "none" if ENV == "production" else "lax"

cookie_transport = CookieTransport(
    cookie_name="robotalk_auth",
    cookie_max_age=3600,                  # 1 hour
    cookie_httponly=True,                 # JS cannot read auth cookie
    cookie_secure=(ENV == "production"),  # HTTPS only in prod
    cookie_samesite=COOKIE_SAMESITE,      # lax in dev, none in prod
)



def get_jwt_strategy() -> JWTStrategy:
    return JWTStrategy(secret=JWT_SECRET, lifetime_seconds=3600)

auth_backend = AuthenticationBackend(
    name="jwt",
    transport=cookie_transport,
    get_strategy=get_jwt_strategy,
)

# -------------------------
# FastAPI Users setup
# -------------------------
from fastapi_users import FastAPIUsers, schemas
import uuid
from fastapi import Depends

async def get_user_manager(user_db=Depends(get_user_db)):
    yield UserManager(user_db)

# ✅ Add these schema classes (needed for main.py imports)
class UserRead(schemas.BaseUser[uuid.UUID]):
    pass

class UserCreate(schemas.BaseUserCreate):
    pass

fastapi_users = FastAPIUsers[User, uuid.UUID](
    get_user_manager,
    [auth_backend],
)

current_user = fastapi_users.current_user(active=True)
current_superuser = fastapi_users.current_user(active=True, superuser=True)


# --------------------------------------
# Optional: Create database tables manually
# --------------------------------------
if __name__ == "__main__":
    from sqlalchemy import create_engine

    # Use a *sync* engine temporarily to create tables
    sync_engine = create_engine("sqlite:///./users.db", echo=True)
    Base.metadata.create_all(bind=sync_engine)
    print("✅ Database tables created successfully.")


