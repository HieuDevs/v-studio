"""Smoke test for an installed V Studio: wait for the model, generate speech, check the app stays up.

Run after starting the app; it talks to the app's local port (127.0.0.1:17863).
"""
import json
import sys
import time
import urllib.request
import uuid

BASE = "http://127.0.0.1:17863"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.load(r)


def post_form(path, fields):
    boundary = uuid.uuid4().hex
    body = b"".join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()
    ) + f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(BASE + path, data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.status, r.read()


# 1. the app's server comes up (the window is created right after)
t0 = time.time()
st = None
while time.time() - t0 < 1500:   # first launch downloads ~1 GB of model files
    try:
        st = get("/api/status")
        if st.get("error"):
            sys.exit(f"FAIL: model error: {st['error']}")
        if st.get("loaded") and not st.get("loading"):
            break
    except Exception as e:  # noqa: BLE001
        if time.time() - t0 > 120 and st is None:
            sys.exit(f"FAIL: app did not start: {e}")
    time.sleep(5)
else:
    sys.exit(f"FAIL: model not loaded in time: {st}")
print(f"OK  model loaded after {time.time() - t0:.0f}s: {st.get('mode_label')} / {st.get('backend')} / {st.get('sample_rate')} Hz")

# 2. voices
v = get("/api/voices")
print(f"OK  voices: {len(v['voices'])} (default: {v.get('default')})")

# 3. speech
t1 = time.time()
code, pcm = post_form("/api/tts", {"text": "Xin chào, đây là bài kiểm tra tự động của V Studio.",
                                   "stream": "false", "sample_rate": "48000"})
secs = len(pcm) / 2 / 48000
if code != 200 or secs < 1.0:
    sys.exit(f"FAIL: tts http={code} audio={secs:.2f}s")
print(f"OK  speech: {secs:.2f}s of audio in {time.time() - t1:.1f}s")

# 4. the window process is still alive (the server dies with it)
time.sleep(10)
st = get("/api/status")
print("OK  app still running after 10s")
print("PASS")
