"""
Best-effort 2D pose estimate from the 5 YuNet landmarks (right eye, left
eye, nose, mouth right, mouth left). This is a geometric heuristic, not a
3D head-pose model.

Two things make a fixed absolute threshold unreliable:
  1. The camera preview is CSS-mirrored for the employee (so turning
     "left" looks like a mirror), but the raw frame sent to the server is
     NOT mirrored â€” it's the true, unmirrored sensor image. Whether a
     given landmark layout means "turned toward the viewer's left" or
     "toward the viewer's right" in image-pixel-space is therefore not
     fixed; it can't be hardcoded as "positive yaw = left".
  2. What counts as "centered" varies slightly per face and per camera
     angle, so comparing against a universal zero is noisier than
     comparing against THIS employee's own frontal shot.

So instead of asserting an absolute direction, each pose is checked
relative to:
  - `baseline` (yaw0, pitch0): this employee's own frontal reading,
    used as their personal "centered" reference.
  - `reference`: the signed deviation measured during the PAIRED pose
    ("left" for a "right" check, "up" for a "down" check). The opposite
    pose must deviate from baseline in the opposite direction â€” that's
    what actually proves left and right are two different poses,
    instead of a magnitude-only check that both would satisfy.

Thresholds are rough starting points (POSE_YAW_MIN / POSE_PITCH_MIN /
frontal maxes below); tune them if "ready" trips too early or too late.
"""
import numpy as np

YAW_TURN_MIN = 0.08
PITCH_TILT_MIN = 0.07
# Chin-down barely moves the nose/eye ratio (the face foreshortens), so it
# needs a lower trigger than chin-up.
PITCH_DOWN_MIN = 0.035
PITCH_TILT_MAX = 0.22
# Applied to later frontal poses relative to the first frontal frame. This
# allows small movement between the neutral capture and final frontal sample.
YAW_FRONTAL_MAX = 0.16
PITCH_FRONTAL_MAX = 0.18


def _face_angles(landmarks: np.ndarray):
    eye_r, eye_l, nose, mouth_r, mouth_l = landmarks
    interocular = float(np.linalg.norm(eye_l - eye_r))
    if interocular < 1e-3:
        return None
    eye_mid = (eye_r + eye_l) / 2
    # Both normalised by interocular distance (stable across moderate
    # pitch/yaw, unlike the eye-to-mouth span which itself foreshortens
    # as the head tilts, confounding a pitch signal measured against it).
    yaw = float((nose[0] - eye_mid[0]) / interocular)
    pitch = float((nose[1] - eye_mid[1]) / interocular)
    return yaw, pitch


# With the chin known, pitch is the nose's place on the eye-to-chin line (0 = at the eyes,
# 1 = at the chin). That is a fraction of the face's own height, so it does not depend on how
# far the person stands, and the chin anchors the lower half of the face, which the five
# YuNet points cannot see. The eye-to-chin span is ~1.9x the interocular distance, so the
# thresholds above (in interocular units) are divided by that to keep the same feel.
CHIN_SPAN_RATIO = 1.9


def _chin_pitch(jaw: dict) -> float | None:
    span = float(jaw["chin"][1] - jaw["eye_mid"][1])
    if span < 1e-3:
        return None
    return float((jaw["nose_tip"][1] - jaw["eye_mid"][1]) / span)


def assess_pose(face, pose_label: str, baseline: tuple[float, float] | None = None,
                reference: float | None = None, image: np.ndarray | None = None) -> dict:
    """
    Returns {"ok", "progress" (0-1), "reason", "yaw", "pitch", "jaw"}.

    With `image`, pitch is measured from the chin (see _chin_pitch) instead of the five
    landmarks alone, and `jaw` carries the chin/jawline points for the debug overlay. Callers
    must use one source throughout a sequence (baseline/reference are in the same units), so
    when the chin cannot be found this reports "not ok" rather than silently switching.
    """
    if face.landmarks is None:
        return {"ok": True, "progress": 1.0, "reason": None, "yaw": None, "pitch": None, "jaw": None}

    angles = _face_angles(face.landmarks)
    if angles is None:
        return {"ok": True, "progress": 1.0, "reason": None, "yaw": None, "pitch": None, "jaw": None}
    yaw, pitch = angles
    jaw = None
    scale = 1.0
    if image is not None:
        from app.vision.liveness import jaw_landmarks

        jaw = jaw_landmarks(image, face.landmark_rect())
        chin_pitch = _chin_pitch(jaw) if jaw is not None else None
        if chin_pitch is None:
            return {"ok": False, "progress": 0.0, "reason": "Keep your whole face, including your chin, in view",
                    "yaw": None, "pitch": None, "jaw": None}
        pitch, scale = chin_pitch, 1.0 / CHIN_SPAN_RATIO
    base = (pose_label or "frontal").split("_")[0]

    # The nose is naturally well below the eye midpoint, so `pitch` is a
    # facial-proportion measurement, not an angle centered around zero. The
    # first frontal frame establishes this employee/camera's neutral landmark
    # baseline; subsequent poses are measured relative to that baseline.
    # Checking the first frame against (0, 0) rejected normal faces before the
    # frontend had a chance to record the baseline.
    if base == "frontal" and baseline is None:
        return {"ok": True, "progress": 1.0, "reason": None,
                "yaw": round(yaw, 4), "pitch": round(pitch, 4), "jaw": jaw}

    yaw0, pitch0 = baseline if baseline is not None else (0.0, 0.0)
    dyaw, dpitch = yaw - yaw0, pitch - pitch0
    if base in ("left", "right"):
        if base == "right" and reference is not None:
            ok = (dyaw * reference < 0) and abs(dyaw) >= YAW_TURN_MIN
        else:
            ok = abs(dyaw) >= YAW_TURN_MIN
        progress = min(1.0, abs(dyaw) / YAW_TURN_MIN)
        reason = None if ok else "Turn your head further to the side"
    elif base in ("up", "down"):
        tilt_min = (PITCH_DOWN_MIN if base == "down" else PITCH_TILT_MIN) * scale
        tilt_max = PITCH_TILT_MAX * scale
        # Signed movement toward this pose's side of baseline. For "down" the
        # side is opposite to the employee's own "up" deviation. Progress
        # grows smoothly with that movement, so slight wobble in the wrong
        # direction reads as 0% progress rather than a hard "wrong way" lock.
        if base == "down" and reference is not None and abs(reference) > 1e-6:
            toward = -dpitch * (1.0 if reference > 0 else -1.0)
        else:
            toward = abs(dpitch)
        in_range = tilt_min <= toward <= tilt_max
        ok = in_range
        if toward < tilt_min:
            progress = max(0.0, toward / tilt_min)
            reason = "Tilt your chin further down" if base == "down" else "Tilt your chin further up"
        elif toward > tilt_max:
            progress = min(1.0, tilt_max / toward)
            reason = "Tilt your chin back slightly"
        else:
            progress = 1.0
            reason = None
    else:
        pitch_max = PITCH_FRONTAL_MAX * scale
        ok = abs(dyaw) <= YAW_FRONTAL_MAX and abs(dpitch) <= pitch_max
        worst_off = max(abs(dyaw) / YAW_FRONTAL_MAX, abs(dpitch) / pitch_max, 1e-6)
        progress = 1.0 / worst_off if worst_off > 1.0 else 1.0
        reason = None if ok else "Look straight at the camera"

    return {"ok": ok, "progress": max(0.0, min(1.0, progress)), "reason": reason,
            "yaw": round(yaw, 4), "pitch": round(pitch, 4), "jaw": jaw}
