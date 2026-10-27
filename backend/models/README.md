# Face models

The default recognition engine (`FACE_ENGINE=auto` → `sface`) needs these two
files from the official [OpenCV Zoo](https://github.com/opencv/opencv_zoo):

| File | Model | Size |
|---|---|---|
| `face_detection_yunet_2023mar.onnx` | YuNet face detector | ~230 KB |
| `face_recognition_sface_2021dec.onnx` | SFace recogniser (99.60% LFW) | ~37 MB |

Re-download if missing:

```powershell
curl -L -o face_detection_yunet_2023mar.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
curl -L -o face_recognition_sface_2021dec.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx
```

If the files are absent the backend falls back to dlib automatically
(slower, and existing SFace enrollments would have to be re-captured).

## Anti-spoofing models

The kiosk uses the ONNX exports from
[QingHeYang/Silent-Face-Anti-Spoofing-onnx](https://github.com/QingHeYang/Silent-Face-Anti-Spoofing-onnx),
pinned at commit `584d4421d7ac42c59e640796f46e886b0095367a`. They are
distributed under Apache-2.0; see `MINIFASNET-LICENSE.txt`. The model output
is interpreted as 3-class logits with class 1 = real face.

| File | Crop scale |
|---|---|
| `2.7_80x80_MiniFASNetV2.onnx` | 2.7 |
| `4_0_0_80x80_MiniFASNetV1SE.onnx` | 4.0 |

Both files are included and averaged. In production, `SPOOF_MODE=auto` or
`enforce` refuses startup unless at least one model loads successfully.
`auto` enforces the model score using `SPOOF_THRESHOLD` (default 0.55).
Validate this threshold with representative live users, printed photos and
screen replays from the deployment camera before enabling attendance use.
