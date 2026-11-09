import logging
from dataclasses import dataclass
from datetime import datetime
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
from app.vision.debug import add_jaw, detections_debug
from app.vision.embedding import normalize
from app.vision.enhance import enhance_for_embedding
from app.vision.engines import pick_single_face
from app.vision.imaging import (  # noqa: F401 - re-exported: callers and tests import these from here
    MAX_BURST_PIXELS,
    MAX_FRAME_PIXELS,
    MAX_FRAME_WIDTH,
    decode_image,
    face_thumbnail,
    image_dimensions,
    snapshot_jpeg,
    validate_burst_pixel_budget,
)
from app.vision.liveness import blink_candidate, frame_ear, get_eye_landmark_source, jaw_landmarks
from app.vision.matcher import classify_match
from app.vision.pose import assess_pose
from app.vision.quality import assess_quality
from app.vision.tracking import TRACK_MIN_IOU, box_iou as _box_iou, same_track as _same_track  # noqa: F401
from app.vision.zone import ENROLL_MIN_FACE_TO_OVAL, MOVE_CLOSER, MOVE_INTO_CIRCLE, faces_in_zone, inside_zone, too_small

logger = logging.getLogger("app.enrollment")


def setting(name: str):
    """Config value if explicitly set, else the active engine's calibrated default."""
    value = current_app.config.get(name)
    return value if value is not None else active_engine().DEFAULTS[name]


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _current_samples(user_id: str):
    return (
        FaceEmbedding.query.filter(FaceEmbedding.user_id == user_id, model_filter(active_engine().name))
        .order_by(FaceEmbedding.created_at.asc())
        .all()
    )


def _require_user(user_id: str) -> User:
    user = db.session.get(User, user_id)
    if not user:
        raise AppError("Employee not found.", 404)
    return user


# --------------------------------------------------------------------------
# Enrollment
# --------------------------------------------------------------------------

def get_enrollment_status(user_id: str) -> dict:
    user = _require_user(user_id)
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
    user = _require_user(user_id)
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


# --------------------------------------------------------------------------
# Development-only detection details (payload builders: app.vision.debug)
# --------------------------------------------------------------------------

def debug_allowed() -> bool:
    return current_app.config.get("APP_ENV") != "production"


def detect_for_debug(image_bytes: bytes, zone=None) -> dict:
    """
    Development only (see debug_allowed): what the detector sees in ONE frame and which face the
    kiosk would go on to scan, for the frontend's live debug overlay. Nothing is embedded, matched,
    stored or logged. The face is chosen by the same rules a kiosk scan uses.
    """
    started = time.perf_counter()
    image = decode_image(image_bytes)
    engine = active_engine()
    faces = engine.detect(image, current_app.config["DETECTION_WIDTH"])
    img_h, img_w = image.shape[:2]

    candidates, reason, chosen = faces, None, None
    if zone:
        candidates = faces_in_zone(zone, faces, img_w, img_h)
        if faces and not candidates:
            reason = MOVE_INTO_CIRCLE
    if reason is None:
        chosen, reason = pick_single_face(candidates, allow_dominant=True)
        if chosen is not None and zone and too_small(zone, chosen.box, img_h):
            chosen, reason = None, MOVE_CLOSER
    data = detections_debug(image, faces, chosen, zone, live=True, engine=engine.name, reason=reason, ms=_ms(started))
    if chosen is not None and chosen.landmarks is not None:
        add_jaw(data, jaw_landmarks(image, chosen.landmark_rect()))
    return data


def _enrollment_face(engine, image, zone, debug: dict | None = None):
    """The single face to enrol from a frame, honouring the guide oval:
    faces outside it are ignored, and the face must be big enough for it.
    Returns (face, error message). `debug`, when given, is filled with what was detected."""
    candidates = engine.detect(image, current_app.config["DETECTION_WIDTH"])
    detected = candidates
    img_h, img_w = image.shape[:2]
    if debug is not None:
        debug.update(detections_debug(image, detected, None, zone))
    if zone:
        inside = faces_in_zone(zone, candidates, img_w, img_h)
        if candidates and not inside:
            return None, MOVE_INTO_CIRCLE
        candidates = inside
    face, err = pick_single_face(candidates, allow_dominant=False)
    if err:
        return None, err
    if debug is not None:
        debug.update(detections_debug(image, detected, face, zone))
    if zone and too_small(zone, face.box, img_h, ENROLL_MIN_FACE_TO_OVAL):
        return None, MOVE_CLOSER
    return face, None


def _require_consent(user: User, consent: bool, actor_id: str | None) -> None:
    """Face data is biometric: an admin must confirm the employee agreed
    before the first sample is stored. Recorded once per employee."""
    if user.biometric_consent_at is not None:
        return
    if not consent:
        raise AppError("Record the employee's consent before capturing their face.", 428, {"code": "CONSENT_REQUIRED"})
    user.biometric_consent_at = datetime.utcnow()
    user.biometric_consent_by = actor_id


def _check_same_person(user: User, existing: list, embedding, pose_label: str | None) -> None:
    """Same person as the samples already captured for this employee?"""
    if not existing:
        return
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


def _check_not_enrolled_elsewhere(user: User, embedding, pose_label: str | None) -> None:
    """Already enrolled as someone else?"""
    ranked = embedding_index.rank(embedding, exclude_user_id=user.id)
    if not ranked or ranked[0][1] < setting("ENROLL_DUPLICATE_THRESHOLD"):
        return
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


def _maybe_update_photo(user: User, existing: list, pose_label: str | None, quality_score: float, image, face) -> None:
    """Keep the best frontal shot as the profile photo."""
    is_frontal = (pose_label or "").startswith("frontal")
    frontal_scores = [s.quality_score or 0 for s in existing if (s.pose_label or "").startswith("frontal")]
    if user.photo is None or (is_frontal and quality_score > max(frontal_scores, default=0)):
        user.photo = encrypt_bytes(face_thumbnail(image, face.box))


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
    user = _require_user(user_id)
    if not user.is_active:
        raise AppError("This employee is deactivated. Reactivate them before enrolling.", 409)
    _require_consent(user, consent, actor_id)

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

    _check_same_person(user, existing, embedding, pose_label)
    _check_not_enrolled_elsewhere(user, embedding, pose_label)

    record = FaceEmbedding(user_id=user.id, pose_label=pose_label, quality_score=quality["score"], model=engine.name)
    record.vector = embedding.tolist()
    db.session.add(record)
    _maybe_update_photo(user, existing, pose_label, quality["score"], image, face)

    db.session.commit()
    embedding_index.invalidate()
    logger.info("enroll accept user=%s pose=%s quality_score=%s sample_count=%s", user.id, pose_label, quality["score"], len(existing) + 1)
    return {"quality_score": quality["score"], "pose": pose_label, **get_enrollment_status(user.id)}


def assess_capture_readiness(image_bytes: bytes, pose_label: str | None,
                             baseline: tuple[float, float] | None = None,
                             reference: float | None = None, zone=None, debug: dict | None = None) -> dict:
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
    face, err = _enrollment_face(engine, image, zone, debug)
    if err:
        return {"ready": False, "score": 0.0, "reason": err, "yaw": None, "pitch": None}

    # Same floor as enroll_sample, or the preview would say "ready" and the capture would refuse.
    quality = assess_quality(image, face.box, min_blur=cfg.get("ENROLL_BLUR_THRESHOLD"))
    pose = assess_pose(face, pose_label or "frontal", baseline=baseline, reference=reference, image=image)
    score = round((0.5 * quality["score"] + 0.5 * pose["progress"]) if quality["ok"] else 0.0, 3)
    angles = {"yaw": pose["yaw"], "pitch": pose["pitch"]}
    if debug is not None:
        debug["quality"] = {"ok": bool(quality["ok"]), "score": round(float(quality["score"]), 3), "reason": quality["reason"]}
        debug["pose"] = {"ok": bool(pose["ok"]), "progress": round(float(pose["progress"]), 3), "reason": pose["reason"],
                         "yaw": pose["yaw"], "pitch": pose["pitch"], "label": pose_label or "frontal"}
        add_jaw(debug, pose.get("jaw"))

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


@dataclass
class _Observation:
    """One burst frame in which the kiosk face was found."""
    index: int                 # position in the burst
    image: np.ndarray
    face: object               # app.vision.engines.Face
    track: int                 # face-track id (continuity, see app.vision.tracking)
    ear: tuple | None          # (left, right) eye aspect ratio, None if landmarks failed
    quality: float | None      # quality score, None when the frame failed the quality gate


@dataclass(frozen=True)
class _MatchPolicy:
    """The thresholds one recognition burst is judged by, resolved once."""
    threshold: float
    margin: float
    band: float
    early_exit: float
    min_vote_ratio: float
    outlier_similarity: float

    @classmethod
    def resolve(cls, engine, cfg) -> "_MatchPolicy":
        return cls(
            threshold=setting("FACE_MATCH_THRESHOLD"),
            margin=setting("FACE_AMBIGUITY_MARGIN"),
            band=engine.DEFAULTS["LOW_CONFIDENCE_BAND"],
            early_exit=engine.DEFAULTS["EARLY_EXIT_MARGIN"],
            min_vote_ratio=cfg["RECOGNITION_MIN_VOTE_RATIO"],
            outlier_similarity=engine.DEFAULTS["OUTLIER_SIMILARITY"],
        )


@dataclass
class _BurstScan:
    """What scanning every frame of a burst found."""
    observations: list
    last_reason: str           # why the most recent face-less frame had no usable face
    quality_reason: str | None  # why the most recent low-quality frame failed the gate
    track_count: int


@dataclass
class _Identification:
    """The outcome of embedding the best frames and deciding who they show."""
    result: dict | None        # None when no frame could be embedded
    vote_ratio: float
    used: int                  # embeddings that took part in the decision
    embeddings: list
    embedded_obs: list         # observations that were embedded, in order
    embedded: dict             # frame index -> embedding (None when the model rejected it)


def _embed_frame(engine, cfg, obs: "_Observation"):
    """Unit-length kiosk embedding for one frame, or None if the model rejects it."""
    embedding = engine.embed(enhance_for_embedding(obs.image, obs.face.box, cfg["CLAHE_ENABLED"]), obs.face,
                             num_jitters=engine.DEFAULTS.get("KIOSK_JITTERS", 1))
    if embedding is None:
        return None
    embedding = np.asarray(embedding, dtype=np.float32)
    if embedding.ndim != 1 or embedding.size == 0 or not np.all(np.isfinite(embedding)):
        return None
    norm = float(np.linalg.norm(embedding))
    return embedding / norm if norm > 0 else None


def _locate_face(engine, cfg, image, previous, zone, debug: dict | None, index: int, total: int):
    """The kiosk face in one burst frame, as (face, None) — or (None, the reason there is none).

    The previous frame's face is tracked first (cheap); only when that fails
    (or it wandered out of the guide oval) is the whole frame searched again."""
    img_h, img_w = image.shape[:2]
    width = cfg["DETECTION_WIDTH"]
    face = engine.track(image, previous, width) if previous else None
    if face is not None and zone and not (inside_zone(zone, face.box, img_w, img_h) and not too_small(zone, face.box, img_h)):
        face = None  # the tracked face wandered out of the circle: look again from scratch
    seen = [face] if face is not None else []
    if face is None:
        candidates = engine.detect(image, width)
        seen = candidates
        if debug is not None:
            debug.update(detections_debug(image, seen, None, zone, frame=index, frames=total))
        if zone:
            inside = faces_in_zone(zone, candidates, img_w, img_h)
            if candidates and not inside:
                return None, MOVE_INTO_CIRCLE
            candidates = inside
        face, err = pick_single_face(candidates, allow_dominant=True)
        if err:
            return None, err
        if zone and too_small(zone, face.box, img_h):
            return None, MOVE_CLOSER
    if debug is not None:
        debug.update(detections_debug(image, seen, face, zone, frame=index, frames=total))
    return face, None


def _scan_frames(engine, cfg, frames: list[bytes], zone, debug: dict | None) -> _BurstScan:
    """Every frame: find the face, assign it to a face track, read the eyes and score the quality.

    A face whose box does not overlap the previous frame's face, changes size
    abruptly, or follows a frame without a usable face starts a new track."""
    min_iou = float(cfg.get("LIVENESS_TRACK_MIN_IOU", TRACK_MIN_IOU))
    landmark_source = get_eye_landmark_source(cfg.get("LIVENESS_LANDMARK_MODEL"))

    observations: list[_Observation] = []
    last_reason = "No frames processed."
    quality_reason = None
    previous = None      # face to track from (detector hint)
    track_box = None     # last face box of the current track; None = the track was broken
    track_id = -1
    for index, raw in enumerate(frames):
        try:
            image = decode_image(raw)
        except AppError:
            track_box = None
            continue
        face, reason = _locate_face(engine, cfg, image, previous, zone, debug, index, len(frames))
        if face is None:
            last_reason, previous, track_box = reason, None, None
            continue
        previous = face
        if not _same_track(track_box, face.box, min_iou):
            track_id += 1
        track_box = face.box
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        ear = frame_ear(gray, face.landmark_rect(), source=landmark_source)
        quality = assess_quality(image, face.box)
        if not quality["ok"]:
            quality_reason = quality["reason"]
        observations.append(_Observation(index, image, face, track_id, ear,
                                         quality["score"] if quality["ok"] else None))
    return _BurstScan(observations, last_reason, quality_reason, track_id + 1)


def _identify(engine, cfg, best_frames: list, policy: _MatchPolicy) -> _Identification:
    """Embed the best frames and decide who they show. Stops early once two
    frames clearly agree, so the common case costs only two embeddings."""
    embedded: dict = {}
    embeddings: list = []
    embedded_obs: list = []
    result, vote_ratio, used = None, 0.0, 0
    for obs in best_frames:
        embedding = _embed_frame(engine, cfg, obs)
        embedded[obs.index] = embedding
        if embedding is None:
            continue
        embeddings.append(embedding)
        embedded_obs.append(obs)
        if len(embeddings) < min(2, len(best_frames)):
            continue
        result, vote_ratio, used = _decide(embeddings, policy)
        clear_match = (result["status"] == "MATCHED" and vote_ratio == 1.0
                       and result["score"] >= policy.threshold + policy.early_exit)
        clear_stranger = result["status"] == "NO_MATCH" and result["score"] < policy.threshold - 2 * policy.band
        if clear_match or clear_stranger:
            break

    # A burst may contain only one usable embedding when another frame is
    # blurry or the model rejects it. Still classify the usable sample rather
    # than leaving result/used undefined and turning a recoverable scan into
    # a 500 response.
    if result is None and embeddings:
        result, vote_ratio, used = _decide(embeddings, policy)
    return _Identification(result, vote_ratio, used, embeddings, embedded_obs, embedded)


def recognize_burst(frames: list[bytes], zone=None, debug: dict | None = None) -> dict:
    """
    Recognises one person from a short burst of frames.

    1. Every frame: fast detection (or tracking) + eye landmarks (for blink
       liveness). Each face is assigned to a face *track* (_scan_frames).
    2. Only the track containing the best-quality frame is used, for BOTH
       identity and liveness, so a blink cannot be borrowed from another face
       shown in between (e.g. a photo of a coworker alternated with the
       attacker's own blinking face).
    3. The best frames of that track get an embedding; stops early once two
       frames clearly agree, so the common case costs only two embeddings
       (_identify).
    4. Embeddings are averaged (noise cancels, identity doesn't), outlier
       frames are dropped, and the average is matched against the index.
       Each frame also votes; the match is only accepted if enough
       individual frames agree on the same person (_decide).
    5. On a match, the burst's most closed-eye frame (if any) is embedded and
       must still look like the matched person (LIVENESS_VERIFY_BLINK_FRAME);
       otherwise the burst's EARs are discarded so it cannot satisfy liveness.
    6. Passive anti-spoof scores up to SPOOF_CHECK_FRAMES embedded frames and
       keeps the most suspicious reading.

    Cost: at most RECOGNITION_MAX_EMBED_FRAMES (3) embeddings for identity,
    plus at most 2 for the blink check, and only when a blink candidate exists.

    With a `zone` (the kiosk's guide oval, see app.vision.zone) faces outside
    it are ignored and a face that is too small for it is asked to come closer.

    `debug`, when given (development only, see debug_allowed), is filled with what the detector saw
    in the most recent frame that had a face to look at.
    """
    cfg = current_app.config
    validate_burst_pixel_budget(frames)
    engine = active_engine()
    started = time.perf_counter()

    scan = _scan_frames(engine, cfg, frames, zone, debug)
    observations = scan.observations
    face_count = len(observations)
    usable = [o for o in observations if o.quality is not None]
    if not usable:
        # No identity, so no EARs either: liveness samples are only ever
        # pooled for the person they were measured on.
        if scan.quality_reason:
            return {"status": "LOW_CONFIDENCE", "reason": scan.quality_reason, "score": 0.0,
                    "ears": [], "frames_with_face": face_count,
                    "frames_embedded": 0, "vote_ratio": 0.0, "engine": engine.name,
                    "elapsed_ms": _ms(started)}
        return {"status": "NO_FACE", "reason": scan.last_reason, "ears": [], "frames_with_face": 0,
                "elapsed_ms": _ms(started)}

    # The identity track is the one holding the best frame; every other track
    # is discarded for identity and liveness alike.
    identity_track = max(usable, key=lambda o: o.quality).track
    track_obs = [o for o in observations if o.track == identity_track]
    discarded = face_count - len(track_obs)
    if discarded:
        logger.warning("recognition burst: %d face track(s); kept track %d (%d frames), discarded %d frame(s) "
                       "from other tracks", scan.track_count, identity_track, len(track_obs), discarded)

    # Match only frames that pass the same size, blur and lighting gate used
    # by enrollment; prefer the overall best image instead of sharpness alone.
    best_frames = sorted((o for o in track_obs if o.quality is not None),
                         key=lambda o: o.quality, reverse=True)[: cfg["RECOGNITION_MAX_EMBED_FRAMES"]]
    policy = _MatchPolicy.resolve(engine, cfg)
    identified = _identify(engine, cfg, best_frames, policy)
    embed_calls = len(identified.embedded)

    if identified.result is None:
        return {"status": "LOW_CONFIDENCE", "reason": "Could not generate a valid face embedding.",
                "score": 0.0, "ears": [], "frames_with_face": face_count,
                "frames_embedded": 0, "embeddings_computed": embed_calls, "vote_ratio": 0.0,
                "engine": engine.name, "elapsed_ms": _ms(started)}
    result = identified.result

    ear_obs = [o for o in track_obs if o.ear is not None]
    ears = [o.ear for o in ear_obs]
    mismatch = False
    if (result["status"] == "MATCHED" and cfg.get("LIVENESS_REQUIRED", True)
            and cfg.get("LIVENESS_VERIFY_BLINK_FRAME", True)):
        verdict, extra_calls = _verify_blink_frame(
            engine, cfg, ear_obs, identified.embedded, result["user_id"], policy,
            float(cfg.get("LIVENESS_EAR_BLINK_DELTA", 0.06)))
        embed_calls += extra_calls
        if verdict != "ok":
            ears = []
            mismatch = verdict == "mismatch"

    spoof_count = max(1, int(cfg.get("SPOOF_CHECK_FRAMES", 3) or 1))
    result.update(_spoof_check(cfg, [(o.image, o.face) for o in identified.embedded_obs[:spoof_count]]))
    if cfg["SNAPSHOTS_ENABLED"]:
        result["snapshot_jpeg"] = snapshot_jpeg(best_frames[0].image)
    result.update({
        "ears": ears,
        "liveness_identity_mismatch": mismatch,
        "frames_with_face": face_count,
        "frames_discarded_other_tracks": discarded,
        "frames_embedded": identified.used,
        "embeddings_computed": embed_calls,
        "vote_ratio": round(identified.vote_ratio, 3),
        "engine": engine.name,
        "elapsed_ms": _ms(started),
    })
    return result


def _verify_blink_frame(engine, cfg, ear_obs: list, embedded: dict, user_id, policy: _MatchPolicy,
                        blink_delta: float) -> tuple[str, int]:
    """
    Confirm the burst's closed-eye frame shows the matched person.

    Returns (verdict, embeddings computed) where verdict is "ok" (no blink
    candidate, or it matches), "mismatch" (it shows someone else) or
    "unverified" (it could not be embedded). The closed-eye frame is held to
    a lenient bar (threshold - 2 * band) because closed eyes lower the score;
    an adjacent open-eye frame that was not already embedded for identity
    must reach the normal per-frame vote bar (threshold - band).
    """
    threshold, margin, band = policy.threshold, policy.margin, policy.band
    candidate = blink_candidate([o.ear for o in ear_obs], blink_delta)
    if candidate is None:
        return "ok", 0
    closed = ear_obs[candidate]
    calls = 0

    checks = [(closed, threshold - 2 * band, "closed-eye")]
    neighbours = [ear_obs[i] for i in (candidate - 1, candidate + 1)
                  if 0 <= i < len(ear_obs) and ear_obs[i].index not in embedded]
    if neighbours:
        # The more open of the frames just before/after the blink.
        checks.append((max(neighbours, key=lambda o: float(np.mean(o.ear))), threshold - band, "adjacent open-eye"))

    for obs, floor, label in checks:
        if obs.index not in embedded:
            calls += 1
            embedded[obs.index] = _embed_frame(engine, cfg, obs)
        embedding = embedded[obs.index]
        if embedding is None:
            logger.warning("liveness: %s frame %d could not be embedded; ignoring this burst's blink samples",
                           label, obs.index)
            return "unverified", calls
        ranked = embedding_index.rank(embedding)
        user_score = dict(ranked).get(user_id)
        top_user, top_score = ranked[0] if ranked else (None, 0.0)
        ok = (user_score is not None and user_score >= floor
              and (top_user == user_id or top_score - user_score < margin))
        if not ok:
            logger.warning(
                "liveness identity mismatch: %s frame %d of the burst does not match user=%s "
                "(score=%s floor=%.3f top_user=%s top_score=%.3f); blink samples discarded",
                label, obs.index, user_id, None if user_score is None else round(user_score, 4),
                floor, top_user, top_score)
            return "mismatch", calls
    return "ok", calls


def _spoof_check(cfg, frames: list) -> dict:
    """
    Passive anti-spoof reading over the given [(image, face)] frames. The most
    suspicious (lowest) score wins, so one replayed frame flags the burst.
    Never raises into a check-in.
    """
    try:
        spoof = get_antispoof()
        mode = resolve_mode(cfg["SPOOF_MODE"], spoof.has_model)
        if mode == "off" or not frames:
            return {"spoof_score": None, "spoof_suspected": False}
        readings = [spoof.score(image, face.box) for image, face in frames]
        reading = min(readings, key=lambda r: r["score"])
        threshold = cfg["SPOOF_THRESHOLD"] if cfg["SPOOF_THRESHOLD"] is not None else default_threshold(reading["method"])
        suspected = reading["score"] < threshold
        if suspected:
            logger.warning("anti-spoof flagged score=%s method=%s threshold=%s mode=%s frame_scores=%s",
                           reading["score"], reading["method"], threshold, mode, [r["score"] for r in readings])
        return {"spoof_score": reading["score"], "spoof_suspected": suspected and mode == "enforce"}
    except Exception:  # noqa: BLE001 - a broken optional check must not block attendance
        logger.exception("anti-spoof check failed")
        return {"spoof_score": None, "spoof_suspected": False}


def _decide(embeddings: list, policy: _MatchPolicy):
    """Average the burst embeddings (minus outliers), match, then check per-frame votes."""
    stack = np.vstack(embeddings)
    centroid = normalize(stack.mean(axis=0))
    if len(stack) > 2:
        keep = stack @ centroid >= policy.outlier_similarity
        if keep.any():
            stack = stack[keep]
            centroid = normalize(stack.mean(axis=0))

    ranked_centroid = embedding_index.rank(centroid)
    result = classify_match(ranked_centroid, policy.threshold, policy.margin, policy.band)
    result["candidate_user_id"] = ranked_centroid[0][0] if ranked_centroid else None
    votes = 0
    for emb in stack:
        ranked = embedding_index.rank(emb)
        if ranked and ranked[0][0] == result.get("user_id") and ranked[0][1] >= policy.threshold - policy.band:
            votes += 1
    vote_ratio = votes / len(stack)
    if result["status"] == "MATCHED" and vote_ratio < policy.min_vote_ratio:
        result = {**result, "status": "LOW_CONFIDENCE", "user_id": None}
    return result, vote_ratio, int(len(stack))
