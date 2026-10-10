"""
One-off migration: encrypt biometric data that was stored before
FACE_DATA_KEY was set (embeddings, profile photos, scan snapshots).
Safe to re-run: already-encrypted rows are skipped.

    cd backend
    set FACE_DATA_KEY=<your key>
    .venv\\Scripts\\python tools\\encrypt_existing_data.py

Back up the database and the key first. Losing the key makes the data
unrecoverable.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402
from app.models.face_embedding import FaceEmbedding  # noqa: E402
from app.models.scan_snapshot import ScanSnapshot  # noqa: E402
from app.models.user import User  # noqa: E402
from app.utils.crypto import encrypt_bytes, encrypt_text, encryption_enabled, is_encrypted  # noqa: E402


def main():
    app = create_app()
    with app.app_context():
        if not encryption_enabled():
            sys.exit("FACE_DATA_KEY is not set. Generate one with:\n"
                     '  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"')
        counts = {"embeddings": 0, "photos": 0, "snapshots": 0}
        for row in FaceEmbedding.query.all():
            if not is_encrypted(row.vector_json):
                row.vector_json = encrypt_text(row.vector_json)
                counts["embeddings"] += 1
        for user in User.query.filter(User.photo.isnot(None)).all():
            if not is_encrypted(user.photo):
                user.photo = encrypt_bytes(user.photo)
                counts["photos"] += 1
        for snap in ScanSnapshot.query.all():
            if not is_encrypted(snap.image):
                snap.image = encrypt_bytes(snap.image)
                counts["snapshots"] += 1
        db.session.commit()
        print("Encrypted:", counts)


if __name__ == "__main__":
    main()
