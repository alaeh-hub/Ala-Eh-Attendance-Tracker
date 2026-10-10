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

## Anti-spoofing models (optional, recommended)

The kiosk can reject photos and screens with the MiniFASNet models from
[Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing).
Export them to ONNX (80x80 input, 3-class softmax, class 1 = real face) and
place them here with these exact names:

| File | Crop scale |
|---|---|
| `2.7_80x80_MiniFASNetV2.onnx` | 2.7 |
| `4_0_0_80x80_MiniFASNetV1SE.onnx` | 4.0 |

One file is enough; two are averaged. With no files present the app only
logs a weak texture heuristic and never blocks anyone. With a model present,
`SPOOF_MODE=auto` switches to enforcing (`SPOOF_THRESHOLD`, default 0.55).
Test with a real photo and a phone screen on your own camera before relying
on it, and set `SPOOF_MODE=log` if it rejects real people.
