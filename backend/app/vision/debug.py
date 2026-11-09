"""Development-only detection details for the frontend's debug overlay.

The enrollment check and the kiosk check-in can describe what the detector saw
(every face with its box and 5 landmarks, the one that was used, the guide
oval) so the overlay can draw it. A production server never produces it,
whatever the client asks for (see face_service.debug_allowed).
"""
from app.vision.zone import MARGIN as ZONE_MARGIN


def _points(points) -> list[list[float]]:
    return [[round(float(x), 1), round(float(y), 1)] for x, y in points]


def _face_debug(face, chosen) -> dict:
    top, right, bottom, left = face.box
    data = {"box": [int(left), int(top), int(right), int(bottom)], "score": round(float(face.score), 3),
            "chosen": face is chosen}
    if face.landmarks is not None:
        data["landmarks"] = _points(face.landmarks)
    return data


def _jaw_debug(jaw) -> dict | None:
    """The jawline (ear to ear) and chin from vision.liveness.jaw_landmarks, as plain JSON numbers."""
    if jaw is None:
        return None
    return {"jaw": _points(jaw["jaw"]), "chin": _points([jaw["chin"]])[0], "forehead": _points([jaw["forehead"]])[0]}


def add_jaw(data: dict, jaw) -> None:
    """Attach the jaw to the chosen face's entry of a debug payload (the only face it is measured for)."""
    extra = _jaw_debug(jaw)
    for entry in data.get("faces", []):
        if entry.get("chosen") and extra:
            entry.update(extra)


def detections_debug(image, faces, chosen, zone, **extra) -> dict:
    """What the detector saw in one frame, in that frame's own pixel coordinates."""
    img_h, img_w = image.shape[:2]
    return {
        "image": {"w": int(img_w), "h": int(img_h)},
        "faces": [_face_debug(f, chosen) for f in faces],
        "zone": {"cx": zone.cx, "cy": zone.cy, "rx": zone.rx, "ry": zone.ry, "margin": ZONE_MARGIN} if zone else None,
        **extra,
    }
