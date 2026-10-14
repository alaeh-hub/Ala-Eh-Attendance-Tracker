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


# A real bcrypt hash (of a random value nobody knows) at the default cost.
# Checked against when the account does not exist or has no password, so
# a failed sign-in takes the same ~bcrypt time either way and response
# timing does not reveal which emails are registered.
_DUMMY_HASH = bcrypt.hashpw(b"timing-equaliser-not-a-password", bcrypt.gensalt()).decode("utf-8")


def burn_password_check(plain_password: str) -> None:
    """Spend the time of one real bcrypt check; always "fails"."""
    verify_password(plain_password if isinstance(plain_password, str) else "", _DUMMY_HASH)
