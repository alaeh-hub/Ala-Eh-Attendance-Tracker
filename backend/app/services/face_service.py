import logging
from datetime import datetime
import struct
import time

import cv2
import numpy as np
from flask import current_app

from app.extensions import db
from app.middleware.error_handler import AppError
from app.models.face_embedding import FaceEmbedding
from app.models.user import User
from app.services.embedding_index import active_engine, embedding_index, model_filter
from app.utils.crypto import encrypt_bytes
from app.vision.antispoof import default_threshold, get_antispoof, resolve_mode
from app.vision.embedding import normalize
from app.vision.enhance import enhance_for_embedding
from app.vision.engines import pick_single_face
from app.vision.liveness import frame_ear
from app.vision.matcher import classify_match
from app.vision.pose import assess_pose
from app.vision.quality import assess_quality
from app.vision.zone import ENROLL_MIN_FACE_TO_OVAL, MOVE_CLOSER, MOVE_INTO_CIRCLE, faces_in_zone, inside_zone, too_small

logger = logging.getLogger("app.enrollment")

# Frames with either dimension larger than this are downscaled on decode;
# a face at kiosk distance remains large enough for the alignment models.
MAX_FRAME_WIDTH = 1280
MAX_FRAME_PIXELS = 20_000_000
THUMBNAIL_SIZE = 192


def setting(name: str):
    """Config value if explicitly set, else the active engine's calibrated default."""
    value = current_app.config.get(name)
    return value if value is not None else active_engine().DEFAULTS[name]


def decode_image(image_bytes: bytes) -> np.ndarray:
    """Decode a bounded JPEG/PNG frame, rejecting oversized dimensions before allocation."""
    if not isinstance(image_bytes, (bytes, bytearray)) or not image_bytes:
        raise AppError("Image data is empty or invalid.", 400)

    image_bytes = bytes(image_bytes)
    width = height = None
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n") and len(image_bytes) >= 24:
        width, height = struct.unpack(">II", image_bytes[16:24])
    elif image_bytes.startswith(b"\xff\xd8"):
        # Walk JPEG segments until a start-of-frame marker provides dimensions.
        offset = 2
        sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
        while offset + 4 <= len(image_bytes):
            if image_bytes[offset] != 0xFF:
                offset += 1
                continue
            while offset < len(image_bytes) and image_bytes[offset] == 0xFF:
                offset += 1
            if offset >= len(image_bytes):
                break
            marker = image_bytes[offset]
            offset += 1
            if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
                continue
            if offset + 2 > len(image_bytes):
                break
            segment_length = struct.unpack(">H", image_bytes[offset:offset + 2])[0]
            if segment_length < 2 or offset + segment_length > len(image_bytes):
                break
            if marker in sof_markers and segment_length >= 7:
                height, width = struct.unpack(">HH", image_bytes[offset + 3:offset + 7])
                break
            offset += segment_length
    else:
        raise AppError("Only JPEG and PNG images are supported.", 400)

    if not width or not height:
        raise AppError("Could not read image dimensions.", 400)
    if width * height > MAX_FRAME_PIXELS:
        raise AppError("Image dimensions are too large.", 413)

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    try:
        image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except cv2.error as exc:
        raise AppError("Could not decode image data.", 400) from exc
    if image is None:
        raise AppError("Could not decode image data.", 400)
    h, w = image.shape[:2]
    if max(w, h) > MAX_FRAME_WIDTH:
        scale = MAX_FRAME_WIDTH / float(max(w, h))
        image = cv2.resize(image, (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
                           interpolation=cv2.INTER_AREA)
    return image


def _face_thumbnail(image_bgr: np.ndarray, face_box) -> bytes | None:
    top, right, bottom, left = face_box
    h, w = image_bgr.shape[:2]
    cx, cy = (left + right) / 2, (top + bottom) / 2
    half = max(bottom - top, right - left) * 0.8
    x0, y0 = int(max(cx - half, 0)), int(max(cy - half, 0))
    x1, y1 = int(min(cx + half, w)), int(min(cy + half, h))
    if x1 <= x0 or y1 <= y0:
        return None
    crop = cv2.resize(image_bgr[y0:y1, x0:x1], (THUMBNAIL_SIZE, THUMBNAIL_SIZE), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return buf.tobytes() if ok else None


def _current_samples(user_id: str):
    return (
        FaceEmbedding.query.filter(FaceEmbedding.user_id == user_id, model_filter(active_engine().name))
        .order_by(FaceEmbedding.created_at.asc())
        .all()
    )


# --------------------------------------------------------------------------
# Enrollment
# --------------------------------------------------------------------------

def get_enrollment_status(user_id: str) -> dict:
    user = db.session.get(User, user_id)
    if not user:
        raise AppError("Employee not found.", 404)
    samples = _current_samples(user.id)
    total = FaceEmbedding.query.filter_by(user_id=user.id).count()
    cfg = current_app.config
    return {
        "user_id": user.id,
        "engine": active_engine().name,
        "sample_count": len(samples),
        # Samples from a previous recognition engine can't be matched and
        # should be cleared and re-captured.
        "outdated_samples": total - len(samples),
        "min_required": cfg["MIN_ENROLLMENT_SAMPLES"],
        "max_samples": cfg["MAX_ENROLLMENT_SAMPLES"],
        "enrollment_complete": len(samples) >= cfg["MIN_ENROLLMENT_SAMPLES"],
        "poses_captured": [s.pose_label for s in samples],
        "average_quality": round(float(np.mean([s.quality_score or 0 for s in samples])), 3) if samples else None,
        "has_photo": user.photo is not None,
        "consent_recorded": user.biometric_consent_at is not None,
    }


def reset_enrollment(user_id: str) -> dict:
    """Delete only the specified user's saved face samples and photo."""
    user = db.session.get(User, user_id)
    if not user:
        raise AppError("Employee not found.", 404)
    deleted_count = FaceEmbedding.query.filter_by(user_id=user_id).delete(synchronize_session=False)
    user.photo = None
    db.session.commit()
    embedding_index.invalidate()
    return {"deleted_count": deleted_count, **get_enrollment_status(user_id)}


def reset_all_enrollments() -> dict:
    """Delete every employee's saved face samples and profile photo."""
    deleted_count = FaceEmbedding.query.delete(synchronize_session=False)
    photos_cleared = User.query.filter(User.photo.isnot(None)).update({User.photo: None}, synchronize_session=False)
    db.session.commit()
    embedding_index.invalidate()
    return {"deleted_count": deleted_count, "photos_cleared": photos_cleared}


def _enrollment_face(engine, image, zone):
    """The single face to enrol from a frame, honouring the guide oval:
    faces outside it are ignored, and the face must be big enough for it.
    Returns (face, error message)."""
    cfg = current_app.config
    candidates = engine.detect(image, cfg["DETECTION_WIDTH"])
    img_h, img_w = image.shape[:2]
    if zone:
        inside = faces_in_zone(zone, candidates, img_w, img_h)
        if candidates and not inside:
            return None, MOVE_INTO_CIRCLE
        candidates = inside
    face, err = pick_single_face(candidates, allow_dominant=False)
    if err:
        return None, err
    if zone and too_small(zone, face.box, img_h, ENROLL_MIN_FACE_TO_OVAL):
        return None, MOVE_CLOSER
    return face, None


def enroll_sample(user_id: str, image_bytes: bytes, pose_label: str = None,
                  consent: bool = False, actor_id: str | None = None, zone=None) -> dict:
    """
    Full enrollment pipeline for ONE captured frame:
    detect -> quality gate -> embed -> identity checks -> store.
    Raises AppError with a human-readable reason on rejection so the
    frontend can show it directly (e.g. "Move closer").
    """
    cfg = current_app.config
    engine = active_engine()
    user = db.session.get(User, user_id)
    if not user:
        raise AppError("Employee not found.", 404)
    if not user.is_active:
        raise AppError("This employee is deactivated. Reactivate them before enrolling.", 409)

    # Face data is biometric: an admin must confirm the employee agreed
    # before the first sample is stored. Recorded once per employee.
    if user.biometric_consent_at is None:
        if not consent:
            raise AppError("Record the employee's consent before capturing their face.", 428, {"code": "CONSENT_REQUIRED"})
        user.biometric_consent_at = datetime.utcnow()
        user.biometric_consent_by = actor_id

    existing = _current_samples(user.id)
    if len(existing) >= cfg["MAX_ENROLLMENT_SAMPLES"]:
        raise AppError(f"Maximum of {cfg['MAX_ENROLLMENT_SAMPLES']} samples reached. Reset enrollment to start over.", 409)

    image = decode_image(image_bytes)
    face, err = _enrollment_face(engine, image, zone)
    if err:
        raise AppError(err, 422)

    quality = assess_quality(image, face.box, min_blur=cfg.get("ENROLL_BLUR_THRESHOLD"))
    if not quality["ok"]:
        logger.info("enroll reject user=%s pose=%s reason=%r quality_score=%s", user.id, pose_label, quality["reason"], quality["score"])
        raise AppError(quality["reason"], 422)

    embedding = engine.embed(enhance_for_embedding(image, face.box, cfg["CLAHE_ENABLED"]), face,
                             num_jitters=cfg["ENROLL_NUM_JITTERS"])
    if embedding is None or embedding.ndim != 1 or not np.all(np.isfinite(embedding)):
        logger.warning("enroll reject user=%s pose=%s reason=invalid_embedding", user.id, pose_label)
        raise AppError("Failed to generate a valid face embedding.", 422)

    # 1) Same person as the samples already captured for this employee?
    if existing:
        own_centroid = normalize(np.vstack([normalize(np.array(s.vector)) for s in existing]).mean(axis=0))
        consistency = float(own_centroid @ embedding)
        if consistency < setting("ENROLL_CONSISTENCY_THRESHOLD"):
            logger.warning("enroll reject user=%s pose=%s reason=inconsistent_face similarity=%s", user.id, pose_label, round(consistency, 4))
            raise AppError(
                "This face doesn't match the earlier samples for this employee. "
                "Make sure only the employee being enrolled is in front of the camera.",
                422,
                {"code": "INCONSISTENT_FACE", "similarity": round(consistency, 4)},
            )

    # 2) Already enrolled as someone else?
    ranked = embedding_index.rank(embedding, exclude_user_id=user.id)
    if ranked and ranked[0][1] >= setting("ENROLL_DUPLICATE_THRESHOLD"):
        other = db.session.get(User, ranked[0][0])
        label = other.full_name if other else "another employee"
        if other and other.employee_code:
            label += f" ({other.employee_code})"
        logger.warning(
            "enroll reject user=%s pose=%s reason=duplicate_face similarity=%s matched_user=%s",
            user.id, pose_label, round(ranked[0][1], 4), ranked[0][0],
        )
        raise AppError(
            f"This face is already enrolled as {label}.",
            409,
            {"code": "DUPLICATE_FACE", "similarity": round(ranked[0][1], 4)},
        )

    record = FaceEmbedding(user_id=user.id, pose_label=pose_label, quality_score=quality["score"], model=engine.name)
    record.vector = embedding.tolist()
    db.session.add(record)

    # Keep the best frontal shot as the profile photo.
    is_frontal = (pose_label or "").startswith("frontal")
    frontal_scores = [s.quality_score or 0 for s in existing if (s.pose_label or "").startswith("frontal")]
    if user.photo is None or (is_frontal and quality["score"] > max(frontal_scores, default=0)):
        user.photo = encrypt_bytes(_face_thumbnail(image, face.box))

    db.session.commit()
    embedding_index.invalidate()
    logger.info("enroll accept user=%s pose=%s quality_score=%s sample_count=%s", user.id, pose_label, quality["score"], len(existing) + 1)
    return {"quality_score": quality["score"], "pose": pose_label, **get_enrollment_status(user.id)}


def assess_capture_readiness(image_bytes: bytes, pose_label: str | None,
                             baseline: tuple[float, float] | None = None,
                             reference: float | None = None, zone=None) -> dict:
    """
    Lightweight preview check used while the employee is framing a shot:
    detects the face and scores quality + rough pose, WITHOUT running the
    slower embedding model and without saving anything. The enrollment UI
    polls this a few times a second so the person sees live "ready"
    feedback before a real capture is attempted, instead of the camera
    firing the instant a frame arrives.

    `baseline` / `reference` let the caller calibrate left-vs-right and
    up-vs-down against this employee's own earlier poses in the same
    sequence — see app.vision.pose for why that matters more than an
    absolute threshold.
    """
    cfg = current_app.config
    engine = active_engine()
    image = decode_image(image_bytes)
    face, err = _enrollment_face(engine, image, zone)
    if err:
        return {"ready": False, "score": 0.0, "reason": err, "yaw": None, "pitch": None}

    # Same floor as enroll_sample, or the preview would say "ready" and the capture would refuse.
    quality = assess_quality(image, face.box, min_blur=cfg.get("ENROLL_BLUR_THRESHOLD"))
    pose = assess_pose(face, pose_label or "frontal", baseline=baseline, reference=reference)
    score = round((0.5 * quality["score"] + 0.5 * pose["progress"]) if quality["ok"] else 0.0, 3)
    angles = {"yaw": pose["yaw"], "pitch": pose["pitch"]}

    if not quality["ok"]:
        return {"ready": False, "score": score, "reason": quality["reason"], **angles}
    if not pose["ok"]:
        return {"ready": False, "score": score, "reason": pose["reason"], **angles}
    return {"ready": True, "score": round(max(score, 0.9), 3), "reason": None, **angles}


# --------------------------------------------------------------------------
# Recognition
# --------------------------------------------------------------------------

def face_present(image_bytes: bytes, zone=None) -> bool:
    """Is somebody standing at the kiosk? Detection only: nothing is embedded,
    matched, stored or logged, which is what makes it cheap enough to poll while
    the kiosk sits on its idle screen. With a guide-oval `zone`, only a face inside
    the circle and close enough counts, so someone merely walking past does not."""
    try:
        image = decode_image(image_bytes)
    except AppError:
        return False
    faces = active_engine().detect(image, current_app.config["DETECTION_WIDTH"])
    img_h, img_w = image.shape[:2]
    if zone:
        faces = faces_in_zone(zone, faces, img_w, img_h)
    if not faces:
        return False
    nearest = max(faces, key=lambda f: f.area)
    return not (zone and too_small(zone, nearest.box, img_h))


def recognize_burst(frames: list[bytes], zone=None) -> dict:
    """
    Recognises one person from a short burst of frames.

    1. Every frame: fast detection + eye landmarks (for blink liveness).
    2. The sharpest frames get an embedding; stops early once two frames
       clearly agree, so the common case costs only two embeddings.
    3. Embeddings are averaged (noise cancels, identity doesn't), outlier
       frames are dropped, and the average is matched against the index.
    4. Each frame also votes; the match is only accepted if enough
       individual frames agree on the same person.

    With a `zone` (the kiosk's guide oval, see app.vision.zone) faces outside
    it are ignored and a face that is too small for it is asked to come closer.
    """
    cfg = current_app.config
    engine = active_engine()
    started = time.perf_counter()

    detected = []  # (image, face, quality score)
    ears = []
    face_count = 0
    last_reason = "No frames processed."
    quality_reason = None
    previous = None
    for raw in frames:
        try:
            image = decode_image(raw)
        except AppError:
            continue
        img_h, img_w = image.shape[:2]
        face = engine.track(image, previous, cfg["DETECTION_WIDTH"]) if previous else None
        if face is not None and zone and not (inside_zone(zone, face.box, img_w, img_h) and not too_small(zone, face.box, img_h)):
            face = None  # the tracked face wandered out of the circle: look again from scratch
        if face is None:
            candidates = engine.detect(image, cfg["DETECTION_WIDTH"])
            if zone:
                inside = faces_in_zone(zone, candidates, img_w, img_h)
                if candidates and not inside:
                    last_reason, previous = MOVE_INTO_CIRCLE, None
                    continue
                candidates = inside
            face, err = pick_single_face(candidates, allow_dominant=True)
            if err:
                last_reason, previous = err, None
                continue
            if zone and too_small(zone, face.box, img_h):
                last_reason, previous = MOVE_CLOSER, None
                continue
        previous = face
        face_count += 1
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        ear = frame_ear(gray, face.landmark_rect())
        if ear is not None:
            ears.append(ear)
        quality = assess_quality(image, face.box)
        if not quality["ok"]:
            quality_reason = quality["reason"]
            continue
        detected.append((image, face, quality["score"]))

    if not detected:
        if quality_reason:
            return {"status": "LOW_CONFIDENCE", "reason": quality_reason, "score": 0.0,
                    "ears": ears, "frames_with_face": face_count,
                    "frames_embedded": 0, "vote_ratio": 0.0, "engine": engine.name,
                    "elapsed_ms": _ms(started)}
        return {"status": "NO_FACE", "reason": last_reason, "ears": [], "frames_with_face": 0,
                "elapsed_ms": _ms(started)}

    # Match only frames that pass the same size, blur and lighting gate used
    # by enrollment; prefer the overall best image instead of sharpness alone.
    best_frames = sorted(detected, key=lambda d: d[2], reverse=True)[: cfg["RECOGNITION_MAX_EMBED_FRAMES"]]
    threshold, margin = setting("FACE_MATCH_THRESHOLD"), setting("FACE_AMBIGUITY_MARGIN")
    band, early_exit = engine.DEFAULTS["LOW_CONFIDENCE_BAND"], engine.DEFAULTS["EARLY_EXIT_MARGIN"]

    embeddings = []
    result = None
    vote_ratio = 0.0
    used = 0
    for image, face, _ in best_frames:
        embedding = engine.embed(enhance_for_embedding(image, face.box, cfg["CLAHE_ENABLED"]), face,
                                 num_jitters=engine.DEFAULTS.get("KIOSK_JITTERS", 1))
        if embedding is None:
            continue
        embedding = np.asarray(embedding, dtype=np.float32)
        if embedding.ndim != 1 or embedding.size == 0 or not np.all(np.isfinite(embedding)):
            continue
        norm = np.linalg.norm(embedding)
        if norm == 0:
            continue
        embeddings.append(embedding / norm)
        if len(embeddings) < min(2, len(best_frames)):
            continue
        result, vote_ratio, used = _decide(embeddings, threshold, margin, band,
                                           cfg["RECOGNITION_MIN_VOTE_RATIO"], engine.DEFAULTS["OUTLIER_SIMILARITY"])
        clear_match = result["status"] == "MATCHED" and vote_ratio == 1.0 and result["score"] >= threshold + early_exit
        clear_stranger = result["status"] == "NO_MATCH" and result["score"] < threshold - 2 * band
        if clear_match or clear_stranger:
            break

    if not embeddings:
        return {"status": "LOW_CONFIDENCE", "reason": "Could not generate a valid face embedding.",
                "score": 0.0, "ears": ears, "frames_with_face": face_count,
                "frames_embedded": 0, "vote_ratio": 0.0, "engine": engine.name,
                "elapsed_ms": _ms(started)}

    # A burst may contain only one usable embedding when another frame is
    # blurry or the model rejects it. Still classify the usable sample rather
    # than leaving result/used undefined and turning a recoverable scan into
    # a 500 response.
    if result is None:
        result, vote_ratio, used = _decide(embeddings, threshold, margin, band,
                                           cfg["RECOGNITION_MIN_VOTE_RATIO"], engine.DEFAULTS["OUTLIER_SIMILARITY"])

    best_image, best_face, _ = best_frames[0]
    result.update(_spoof_check(cfg, best_image, best_face))
    if cfg["SNAPSHOTS_ENABLED"]:
        result["snapshot_jpeg"] = _snapshot_jpeg(best_image)
    result.update({
        "ears": ears,
        "frames_with_face": face_count,
        "frames_embedded": used,
        "vote_ratio": round(vote_ratio, 3),
        "engine": engine.name,
        "elapsed_ms": _ms(started),
    })
    return result


def _spoof_check(cfg, image, face) -> dict:
    """Passive anti-spoof reading for the best frame; never raises into a check-in."""
    try:
        spoof = get_antispoof()
        mode = resolve_mode(cfg["SPOOF_MODE"], spoof.has_model)
        if mode == "off":
            return {"spoof_score": None, "spoof_suspected": False}
        reading = spoof.score(image, face.box)
        threshold = cfg["SPOOF_THRESHOLD"] if cfg["SPOOF_THRESHOLD"] is not None else default_threshold(reading["method"])
        suspected = reading["score"] < threshold
        if suspected:
            logger.warning("anti-spoof flagged score=%s method=%s threshold=%s mode=%s",
                           reading["score"], reading["method"], threshold, mode)
        return {"spoof_score": reading["score"], "spoof_suspected": suspected and mode == "enforce"}
    except Exception:  # noqa: BLE001 - a broken optional check must not block attendance
        logger.exception("anti-spoof check failed")
        return {"spoof_score": None, "spoof_suspected": False}


def _snapshot_jpeg(image, max_width: int = 640) -> bytes | None:
    h, w = image.shape[:2]
    if w > max_width:
        image = cv2.resize(image, (max_width, int(round(h * max_width / w))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return buf.tobytes() if ok else None


def _decide(embeddings: list, threshold: float, margin: float, band: float,
            min_vote_ratio: float, outlier_similarity: float):
    """Average the burst embeddings (minus outliers), match, then check per-frame votes."""
    stack = np.vstack(embeddings)
    centroid = normalize(stack.mean(axis=0))
    if len(stack) > 2:
        keep = stack @ centroid >= outlier_similarity
        if keep.any():
            stack = stack[keep]
            centroid = normalize(stack.mean(axis=0))

    ranked_centroid = embedding_index.rank(centroid)
    result = classify_match(ranked_centroid, threshold, margin, band)
    result["candidate_user_id"] = ranked_centroid[0][0] if ranked_centroid else None
    votes = 0
    for emb in stack:
        ranked = embedding_index.rank(emb)
        if ranked and ranked[0][0] == result.get("user_id") and ranked[0][1] >= threshold - band:
            votes += 1
    vote_ratio = votes / len(stack)
    if result["status"] == "MATCHED" and vote_ratio < min_vote_ratio:
        result = {**result, "status": "LOW_CONFIDENCE", "user_id": None}
    return result, vote_ratio, int(len(stack))


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)
