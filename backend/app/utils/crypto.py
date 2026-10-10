"""
Encryption at rest for biometric data (embeddings, photos, snapshots).

Enabled by setting FACE_DATA_KEY (a Fernet key). Encrypted values carry a
prefix so plaintext rows written before the key was set stay readable and
can be migrated with tools/encrypt_existing_data.py. With no key, new data
is stored in plaintext exactly as before.
"""
import logging
from functools import lru_cache

from flask import current_app

logger = logging.getLogger("app.crypto")

TEXT_PREFIX = "enc1:"
BYTES_PREFIX = b"ENC1"


class CryptoError(ValueError):
    """Encrypted data that can't be decrypted (missing or wrong key)."""


@lru_cache(maxsize=4)
def _fernet_for(key: str):
    from cryptography.fernet import Fernet
    return Fernet(key.encode())


def _fernet():
    key = current_app.config.get("FACE_DATA_KEY")
    return _fernet_for(key) if key else None


def encryption_enabled() -> bool:
    return bool(current_app.config.get("FACE_DATA_KEY"))


def is_encrypted(value) -> bool:
    if isinstance(value, str):
        return value.startswith(TEXT_PREFIX)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value[:4]) == BYTES_PREFIX
    return False


def encrypt_text(value: str) -> str:
    f = _fernet()
    return value if f is None else TEXT_PREFIX + f.encrypt(value.encode()).decode()


def decrypt_text(value: str) -> str:
    if not is_encrypted(value):
        return value
    return _decrypt(value[len(TEXT_PREFIX):].encode()).decode()


def encrypt_bytes(value: bytes | None) -> bytes | None:
    f = _fernet()
    if value is None or f is None:
        return value
    return BYTES_PREFIX + f.encrypt(bytes(value))


def decrypt_bytes(value: bytes | None) -> bytes | None:
    if value is None:
        return None
    value = bytes(value)
    if not is_encrypted(value):
        return value
    return _decrypt(value[len(BYTES_PREFIX):])


def _decrypt(token: bytes) -> bytes:
    from cryptography.fernet import InvalidToken
    f = _fernet()
    if f is None:
        raise CryptoError("Data is encrypted but FACE_DATA_KEY is not set.")
    try:
        return f.decrypt(token)
    except InvalidToken as exc:
        raise CryptoError("Could not decrypt data — wrong FACE_DATA_KEY?") from exc
