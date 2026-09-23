"""Focused native CLI test: real downsampling, shared references, masks and unchanged pages.

Run with: python tests/test_resample_images.py <new-cli> <qpdf-cli> [api-test]
All generated PDFs stay in native/qpdf/tests/ during the test and are removed.
"""

import json
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path


def stream(dictionary, payload):
    return (f"<< {dictionary} /Length {len(payload)} >>\nstream\n".encode()
            + payload + b"\nendstream")


def fixture(path):
    width, height = 80, 40
    rgb = bytes((x * 13 + y * 3 + c * 59) % 256
                for y in range(height) for x in range(width) for c in range(3))
    gray = bytes((x * 17 + y * 11) % 256 for y in range(30) for x in range(60))
    mask = bytes((x + y) % 256 for y in range(height) for x in range(width))
    content = (b"q 80 0 0 40 0 0 cm /ImMain Do Q\n"
               b"q 80 0 0 40 0 50 cm /ImAlias Do Q\n"
               b"q 60 0 0 30 0 100 cm /ImGray Do Q\n"
               b"q 80 0 0 40 0 140 cm /ImMasked Do Q\n"
               b"BT /F1 12 Tf 20 210 Td (Original text) Tj ET\n"
               b"20 230 100 30 re S\n")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
         b"/Resources << /XObject << /ImMain 5 0 R /ImAlias 5 0 R "
         b"/ImGray 9 0 R /ImMasked 6 0 R >> "
         b"/Font << /F1 8 0 R >> >> /Contents 4 0 R >>"),
        stream("", content),
        stream("/Type /XObject /Subtype /Image /Width 80 /Height 40 "
               "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode", zlib.compress(rgb)),
        stream("/Type /XObject /Subtype /Image /Width 80 /Height 40 "
               "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 7 0 R",
               zlib.compress(rgb)),
        stream("/Type /XObject /Subtype /Image /Width 80 /Height 40 "
               "/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode",
               zlib.compress(mask)),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        stream("/Type /XObject /Subtype /Image /Width 60 /Height 30 "
               "/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode",
               zlib.compress(gray)),
    ]
    data = bytearray(b"%PDF-1.7\n")
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += f"{number} 0 obj\n".encode() + obj + b"\nendobj\n"
    start_xref = len(data)
    data += f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode()
    for offset in offsets[1:]:
        data += f"{offset:010d} 00000 n \n".encode()
    data += (f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n"
             f"{start_xref}\n%%EOF\n").encode()
    path.write_bytes(data)


def show(qpdf, pdf, object_number, filtered=False):
    args = [str(qpdf), f"--show-object={object_number}"]
    if filtered:
        args += ["--filtered-stream-data"]
    args += [str(pdf)]
    result = subprocess.run(args, capture_output=True, check=True)
    return result.stdout


def objects(qpdf, pdf):
    result = subprocess.run([str(qpdf), "--json", str(pdf)], capture_output=True, check=True)
    data = json.loads(result.stdout)
    values = data["qpdf"][1]
    page = values["obj:" + data["pages"][0]["object"]]["value"]
    return values, page["/Resources"]["/XObject"], int(page["/Contents"].split()[0])


def image(values, ref):
    return values["obj:" + ref]["stream"]["dict"]


def number(ref):
    return int(ref.split()[0])


def export(cli, input_file, output_file, max_edge):
    job = {"operation": "resample-images", "inputFile": str(input_file),
           "outputFile": str(output_file), "imageQuality": 70, "imageMaxEdge": max_edge}
    return subprocess.run([str(cli)], input=json.dumps(job).encode(), capture_output=True)


def main(cli, qpdf, api_test=None):
    with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
        src, dst, untouched = (Path(tmp) / name for name in ("input.pdf", "output.pdf", "none.pdf"))
        fixture(src)
        if api_test is not None:
            subprocess.run([str(api_test), str(src)], capture_output=True, check=True)
        result = export(cli, src, dst, 40)
        assert result.returncode == 0, result.stderr.decode(errors="replace")
        subprocess.run([str(qpdf), "--check", str(dst)], capture_output=True, check=True)
        before, refs_before, contents_before = objects(qpdf, src)
        after, refs_after, contents_after = objects(qpdf, dst)
        assert refs_after["/ImMain"] == refs_after["/ImAlias"]  # shared image remains shared
        assert (image(after, refs_after["/ImMain"])["/Width"],
                image(after, refs_after["/ImMain"])["/Height"]) == (40, 20)
        assert (image(after, refs_after["/ImGray"])["/Width"],
                image(after, refs_after["/ImGray"])["/Height"]) == (40, 20)
        assert image(after, refs_after["/ImMain"])["/Filter"] == "/DCTDecode"
        for name in ("/ImMasked",):  # transparent image and its soft mask
            old = image(before, refs_before[name])
            new = image(after, refs_after[name])
            assert new["/Width"] == old["/Width"] and new["/Height"] == old["/Height"]
            assert show(qpdf, dst, number(refs_after[name]), True) == show(
                qpdf, src, number(refs_before[name]), True)
            assert show(qpdf, dst, number(new["/SMask"]), True) == show(
                qpdf, src, number(old["/SMask"]), True)
        assert show(qpdf, dst, contents_after, True) == show(qpdf, src, contents_before, True)
        result = export(cli, src, untouched, 80)
        assert result.returncode == 3, result.stderr.decode(errors="replace")
        assert b"No supported opaque RGB/grayscale image exceeded" in result.stderr
        assert not untouched.exists()
    print("resampling reduced RGB and Gray dimensions; text/vector/masks/shared refs unchanged; no-op failed")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]) if len(sys.argv) > 3 else None)
