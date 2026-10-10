import bcrypt


def hash_password(plain_password: str) -> str:
    return bcrypt.hashpw(plain_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, hashed: str) -> bool:
    if not isinstance(plain_password, str) or not isinstance(hashed, str):
        return False
    try:
        if len(plain_password.encode("utf-8")) > 72:
            return False
        return bcrypt.checkpw(plain_password.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, UnicodeEncodeError):
        return False
