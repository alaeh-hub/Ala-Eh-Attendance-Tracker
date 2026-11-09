"""Bounded image decoding and encoding.

Everything that turns uploaded bytes into pixels (and pixels back into JPEG
bytes) lives here, so the size limits that protect the server's memory are in
one place.
"""
import struct

import cv2
import numpy as np

from app.middleware.error_handler import AppError

# Frames with either dimension larger than this are downscaled on decode;
# a face at kiosk distance remains large enough for the alignment models.
MAX_FRAME_WIDTH = 1280
MAX_FRAME_PIXELS = 20_000_000
# A check-in keeps each usable decoded frame for face tracking and liveness.
# Bound the sum before decoding so a burst cannot multiply the per-frame cap
# into hundreds of megapixels of retained image data.
MAX_BURST_PIXELS = 32_000_000
THUMBNAIL_SIZE = 192

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# JPEG start-of-frame markers: the segments that carry the image dimensions.
_JPEG_SOF_MARKERS = frozenset({0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF})


def _jpeg_dimensions(data: bytes) -> tuple[int, int] | tuple[None, None]:
    """Walk JPEG segments until a start-of-frame marker provides (width, height)."""
    offset = 2
    while offset + 4 <= len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
            continue
        if offset + 2 > len(data):
            break
        segment_length = struct.unpack(">H", data[offset:offset + 2])[0]
        if segment_length < 2 or offset + segment_length > len(data):
            break
        if marker in _JPEG_SOF_MARKERS and segment_length >= 7:
            height, width = struct.unpack(">HH", data[offset + 3:offset + 7])
            return width, height
        offset += segment_length
    return None, None


def image_dimensions(image_bytes: bytes) -> tuple[int, int]:
    """Read JPEG/PNG dimensions from the header without allocating an image."""
    if not isinstance(image_bytes, (bytes, bytearray)) or not image_bytes:
        raise AppError("Image data is empty or invalid.", 400)

    data = bytes(image_bytes)
    if data.startswith(_PNG_SIGNATURE) and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
    elif data.startswith(b"\xff\xd8"):
        width, height = _jpeg_dimensions(data)
    else:
        raise AppError("Only JPEG and PNG images are supported.", 400)

    if not width or not height:
        raise AppError("Could not read image dimensions.", 400)
    return width, height


def validate_burst_pixel_budget(frames: list[bytes]) -> None:
    """Reject a burst whose decoded source frames exceed the memory budget."""
    total_pixels = 0
    for raw in frames:
        try:
            width, height = image_dimensions(raw)
        except AppError:
            # Malformed frames are ignored by recognize_burst, while valid
            # frames still get processed.
            continue
        total_pixels += width * height
        if total_pixels > MAX_BURST_PIXELS:
            raise AppError("The combined image dimensions are too large.", 413)


def decode_image(image_bytes: bytes) -> np.ndarray:
    """Decode a bounded JPEG/PNG frame, rejecting oversized dimensions before allocation."""
    width, height = image_dimensions(image_bytes)
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


def _encode_jpeg(image: np.ndarray) -> bytes | None:
    ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return buf.tobytes() if ok else None


def face_thumbnail(image_bgr: np.ndarray, face_box) -> bytes | None:
    """A square JPEG crop around the face, for the employee's profile photo."""
    top, right, bottom, left = face_box
    h, w = image_bgr.shape[:2]
    cx, cy = (left + right) / 2, (top + bottom) / 2
    half = max(bottom - top, right - left) * 0.8
    x0, y0 = int(max(cx - half, 0)), int(max(cy - half, 0))
    x1, y1 = int(min(cx + half, w)), int(min(cy + half, h))
    if x1 <= x0 or y1 <= y0:
        return None
    crop = cv2.resize(image_bgr[y0:y1, x0:x1], (THUMBNAIL_SIZE, THUMBNAIL_SIZE), interpolation=cv2.INTER_AREA)
    return _encode_jpeg(crop)


def snapshot_jpeg(image: np.ndarray, max_width: int = 640) -> bytes | None:
    """A downscaled JPEG of a whole frame, for the review snapshots."""
    h, w = image.shape[:2]
    if w > max_width:
        image = cv2.resize(image, (max_width, int(round(h * max_width / w))), interpolation=cv2.INTER_AREA)
    return _encode_jpeg(image)
