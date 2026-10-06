"""Fetch official, pinned OCR data; verify before publishing. Run only during installation."""
import gzip, hashlib, os, pathlib, sys, urllib.request
root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
for language, expected in {
    "eng": "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
    "tur": "7393381111e1152420fc4092cb44eef4237580d21b92bf30d7d221aad192c6b7",
}.items():
    with urllib.request.urlopen(f"https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/{language}.traineddata", timeout=60) as response:
        data = response.read(32 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"{language}: dil dosyası özeti uyuşmuyor; sürümü gözden geçirin.")
    destination = root / f"{language}.traineddata.gz"
    temporary = root / f"{language}.traineddata.gz.partial"
    with open(temporary, "wb") as out:
        out.write(gzip.compress(data, mtime=0))
    os.replace(temporary, destination)
print("Türkçe ve İngilizce yerel OCR dosyaları hazır.")
