#!/usr/bin/env python3
"""Synthetic, local-only QPDF lossy export smoke: native + WASM + Poppler."""

import json
import re
import shutil
import subprocess
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "tmp" / "qpdf-image-test"
CLI = ROOT / "native/qpdf/artifacts/windows-x64/bin/pdf-editor-qpdf.exe"
QPDF = ROOT / "native/qpdf/artifacts/windows-x64/bin/qpdf.exe"
WASM = ROOT / "native/qpdf/artifacts/wasm/pdf-editor-qpdf.js"
PASSWORD = "synthetic-test-password"


def run(*args, input=None, expected=0):
    result = subprocess.run(args, input=input, capture_output=True, cwd=WORK)
    if result.returncode != expected:
        raise AssertionError(f"{args[0]}: expected exit {expected}, got {result.returncode}: {result.stderr.decode(errors='replace')}")
    return result.stdout


def make_pdf(opaque_reference=True):
    width = 256
    opaque = bytes((x * 73 + y * 19 + (x * y) % 59) % 256 for y in range(width) for x in range(width) for _ in range(3))
    mask = bytes((x + 2 * y) % 256 for y in range(64) for x in range(64))
    transparent = bytes((x * 17 + y * 29) % 256 for y in range(64) for x in range(64) for _ in range(3))
    draw_opaque = b"q 80 0 0 80 72 550 cm /Im1 Do Q " if opaque_reference else b""
    text_vector = b"10 10 100 80 re S BT /F1 16 Tf 72 720 Td (Keep searchable text) Tj ET\n"
    content = draw_opaque + b"q 64 0 0 64 200 550 cm /Im2 Do Q " + text_vector
    page_two_content = draw_opaque + text_vector
    images_one = b"/Im1 7 0 R /Im2 8 0 R" if opaque_reference else b"/Im2 8 0 R"
    images_two = b" /XObject << /Im1 7 0 R >>" if opaque_reference else b""

    def stream(dictionary, data):
        return dictionary + f" /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream"

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << " + images_one + b" >> >> /Contents 6 0 R >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >>" + images_two + b" >> /Contents 10 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        stream(b"<<", content),
        stream(b"<< /Type /XObject /Subtype /Image /Width 256 /Height 256 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode", zlib.compress(opaque)),
        stream(b"<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 9 0 R", zlib.compress(transparent)),
        stream(b"<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode", zlib.compress(mask)),
        stream(b"<<", page_two_content),
    ]
    output = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    output.extend(b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:]))
    output.extend(f"trailer\n<< /Root 1 0 R /Size {len(offsets)} >>\nstartxref\n{xref}\n%%EOF\n".encode())
    path = WORK / ("fixture.pdf" if opaque_reference else "masked-only.pdf")
    path.write_bytes(output)
    return path


def job(operation, source, target, **values):
    return run(str(CLI), input=json.dumps({"operation": operation, "inputFile": str(source), "outputFile": str(target), **values}).encode())


def reader_check(source, result):
    for path in (source, result):
        run(str(QPDF), "--check", str(path))
        text = run("pdftotext", str(path), "-")
        assert text.count(b"Keep searchable text") == 2, "Poppler lost text"
        listing = run("pdfimages", "-list", str(path))
        assert b"smask" in listing and listing.count(b"image") >= 3, "Poppler lost image/soft mask"
        qdf = WORK / (path.stem + ".qdf.pdf")
        run(str(QPDF), "--qdf", "--stream-data=uncompress", str(path), str(qdf))
        qdf_bytes = qdf.read_bytes()
        assert qdf_bytes.count(b"10 10 100 80 re S") == 2, "PDF vector path lost"
        references = re.findall(rb"/Im1 (\d+) 0 R", qdf_bytes)
        assert len(references) == 2 and references[0] == references[1], "Shared image object was split"
        run("pdfimages", "-f", "1", "-l", "1", "-png", str(path), str(WORK / path.stem))
    before = sorted(WORK.glob(source.stem + "-*.png"))
    after = sorted(WORK.glob(result.stem + "-*.png"))
    assert len(before) == len(after) == 3, (before, after)
    assert [p.read_bytes() for p in before[1:]] == [p.read_bytes() for p in after[1:]], "Transparent image/soft mask changed"
    assert before[0].read_bytes() != after[0].read_bytes(), "JPEG optimization was not lossy"
    assert result.stat().st_size < source.stat().st_size, "Optimized fixture did not shrink"


WASM_TEST = r'''import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [runtime, source, output] = process.argv.slice(2);
const create = (await import(pathToFileURL(runtime).href)).default;
const pdf = await create({locateFile: name => new URL(name, pathToFileURL(runtime).href).pathname.slice(1)});
if (pdf._pde_qpdf_abi_version() !== 2) throw new Error('WASM ABI mismatch');
const input = fs.readFileSync(source);
const ptr = pdf._malloc(input.length), outptr = pdf._malloc(4), outlen = pdf._malloc(4);
pdf.HEAPU8.set(input, ptr);
const status = pdf._pde_qpdf_optimize_images(ptr, input.length, 0, 65, outptr, outlen);
if (status !== 0) throw new Error(pdf.UTF8ToString(pdf._pde_qpdf_last_error()));
const address = pdf.HEAPU32[outptr >>> 2], size = pdf.HEAPU32[outlen >>> 2];
fs.writeFileSync(output, pdf.HEAPU8.slice(address, address + size));
pdf._pde_qpdf_free(address);
'''


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    original = make_pdf()
    native = WORK / "native-lossy.pdf"
    reencoded = WORK / "jpeg-reencoded.pdf"
    web = WORK / "wasm-lossy.pdf"
    encrypted = WORK / "encrypted.pdf"
    protected = WORK / "protected-lossy.pdf"
    for path in (native, reencoded, web, encrypted, protected):
        path.unlink(missing_ok=True)
    job("optimize-images", original, native, imageQuality=65)
    reader_check(original, native)
    job("optimize-images", native, reencoded, imageQuality=25)
    reader_check(native, reencoded)
    job("encrypt-aes256", original, encrypted, userPassword=PASSWORD, ownerPassword=PASSWORD)
    job("optimize-images", encrypted, protected, inputPassword=PASSWORD, imageQuality=65)
    encryption = run(str(QPDF), "--password-file=-", "--show-encryption", str(protected), input=(PASSWORD + "\n").encode())
    assert b"R = 6" in encryption and b"AESv3" in encryption, "AES-256 protection was lost"
    run(str(QPDF), "--password-file=-", "--check", str(protected), input=(PASSWORD + "\n").encode())
    assert run(str(QPDF), "--show-npages", str(protected), expected=2) == b"", "Protected output opened without password"
    no_gain = WORK / "no-gain.pdf"
    assert run(str(CLI), input=json.dumps({"operation":"optimize-images","inputFile":str(native),"outputFile":str(no_gain),"imageQuality":95}).encode(), expected=3) == b""
    masked_only = make_pdf(False)
    assert run(str(CLI), input=json.dumps({"operation":"optimize-images","inputFile":str(masked_only),"outputFile":str(no_gain),"imageQuality":65}).encode(), expected=3) == b""
    script = WORK / "wasm-image-test.mjs"
    script.write_text(WASM_TEST, encoding="utf-8")
    try:
        run("node", str(script), str(WASM), str(original), str(web))
    finally:
        script.unlink()
    reader_check(original, web)
    shutil.rmtree(WORK)
    print("PASS: Windows/WASM lossy export, shared image, transparent mask, text/vector, AES-256 preserve, no-gain rejection")


if __name__ == "__main__":
    main()
