import uuid
import json
from datetime import datetime
from app.extensions import db
from app.utils.crypto import decrypt_text, encrypt_text


class FaceEmbedding(db.Model):
    """
    One row per enrolled face sample (a 128-d L2-normalised dlib
    embedding). A user has several rows, one per captured pose. Vectors
    are stored as JSON for portability and cached as a numpy matrix in
    services/embedding_index.py for fast matching.
    """
    __tablename__ = "face_embeddings"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=False, index=True)

    vector_json = db.Column(db.Text, nullable=False)  # JSON-encoded list[float]
    pose_label = db.Column(db.String(30), nullable=True)  # e.g. "frontal", "left", "right"
    quality_score = db.Column(db.Float, nullable=True)
    # Engine that produced the vector ("sface" | "dlib"). NULL = legacy dlib row.
    model = db.Column(db.String(20), nullable=True, index=True)

    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    @staticmethod
    def decode(vector_json: str) -> list:
        return json.loads(decrypt_text(vector_json))

    @property
    def vector(self):
        return self.decode(self.vector_json)

    @vector.setter
    def vector(self, value):
        self.vector_json = encrypt_text(json.dumps([round(float(v), 7) for v in value]))
