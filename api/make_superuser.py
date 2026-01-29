import asyncio
import uuid
from getpass import getpass

from auth import async_session_maker, User
from fastapi_users.password import PasswordHelper


async def main():
    email = input("Admin email: ").strip().lower()
    password = getpass("Admin password (will not show): ").strip()

    if not email or not password:
        print("❌ Email and password are required.")
        return

    password_helper = PasswordHelper()
    hashed_password = password_helper.hash(password)

    async with async_session_maker() as session:
        # Try to fetch existing user by email
        result = await session.execute(
            User.__table__.select().where(User.email == email)
        )
        row = result.first()

        if row:
            user = row[0]
            # Update existing user
            await session.execute(
                User.__table__.update()
                .where(User.id == user.id)
                .values(
                    hashed_password=hashed_password,
                    is_superuser=True,
                    is_active=True,
                )
            )
            await session.commit()
            print(f"✅ Updated admin user + password: {email}")
        else:
            # Create new admin user
            new_id = uuid.uuid4()
            await session.execute(
                User.__table__.insert().values(
                    id=new_id,
                    email=email,
                    hashed_password=hashed_password,
                    is_active=True,
                    is_superuser=True,
                    is_verified=True,
                )
            )
            await session.commit()
            print(f"✅ Created admin user: {email}")


if __name__ == "__main__":
    asyncio.run(main())

