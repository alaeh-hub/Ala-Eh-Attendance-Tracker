import re

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def is_valid_email(email: str) -> bool:
    return isinstance(email, str) and len(email) <= 120 and bool(email and EMAIL_RE.fullmatch(email))


def is_valid_password(password: str) -> bool:
    if not isinstance(password, str) or len(password) < 8:
        return False
    # bcrypt only considers up to 72 bytes; rejecting longer values avoids
    # two different passwords authenticating as the same byte prefix.
    try:
        return len(password.encode("utf-8")) <= 72
    except UnicodeEncodeError:
        return False
