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
    cmyk = bytearray()
    for y in range(height):
        for x in range(width):
            if x < 40 and y < 20:
                cmyk.extend([255, 0, 0, 0])
            elif x >= 40 and y < 20:
                cmyk.extend([0, 255, 0, 0])
            elif x < 40 and y >= 20:
                cmyk.extend([0, 0, 255, 0])
            else:
                cmyk.extend([0, 0, 0, 255])
    icc_dummy = b"fake-icc-profile-stream-data"

    content = (b"q 80 0 0 40 0 0 cm /ImMain Do Q\n"
               b"q 80 0 0 40 0 50 cm /ImAlias Do Q\n"
               b"q 60 0 0 30 0 100 cm /ImGray Do Q\n"
               b"q 80 0 0 40 0 140 cm /ImMasked Do Q\n"
               b"q 80 0 0 40 0 180 cm /ImCmyk Do Q\n"
               b"q 80 0 0 40 0 220 cm /ImIccCmyk Do Q\n"
               b"BT /F1 12 Tf 20 270 Td (Original text) Tj ET\n"
               b"20 290 100 30 re S\n")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] "
         b"/Resources << /XObject << /ImMain 5 0 R /ImAlias 5 0 R "
         b"/ImMasked 6 0 R /ImGray 9 0 R /ImCmyk 10 0 R /ImIccCmyk 12 0 R >> "
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
        stream("/Type /XObject /Subtype /Image /Width 80 /Height 40 "
               "/ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode",
               zlib.compress(bytes(cmyk))),
        stream("/N 4", icc_dummy),
        stream("/Type /XObject /Subtype /Image /Width 80 /Height 40 "
               "/ColorSpace [/ICCBased 11 0 R] /BitsPerComponent 8 /Filter /FlateDecode",
               zlib.compress(bytes(cmyk))),
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
        assert (image(after, refs_after["/ImCmyk"])["/Width"],
                image(after, refs_after["/ImCmyk"])["/Height"]) == (40, 20)
        assert image(after, refs_after["/ImMain"])["/Filter"] == "/DCTDecode"
        assert image(after, refs_after["/ImCmyk"])["/Filter"] == "/DCTDecode"
        for name in ("/ImMasked", "/ImIccCmyk"):  # transparent image and ICCBased boundary
            old = image(before, refs_before[name])
            new = image(after, refs_after[name])
            assert new["/Width"] == old["/Width"] and new["/Height"] == old["/Height"]
            assert show(qpdf, dst, number(refs_after[name]), True) == show(
                qpdf, src, number(refs_before[name]), True)
        # Verify soft mask stream of ImMasked specifically
        masked_old = image(before, refs_before["/ImMasked"])
        masked_new = image(after, refs_after["/ImMasked"])
        assert show(qpdf, dst, number(masked_new["/SMask"]), True) == show(
            qpdf, src, number(masked_old["/SMask"]), True)
        assert show(qpdf, dst, contents_after, True) == show(qpdf, src, contents_before, True)

        # Real pixel visual verification for resampled CMYK
        img_prefix = Path(tmp) / "ppm_img"
        subprocess.run(["pdfimages", str(dst), str(img_prefix)], capture_output=True, check=True)
        listing = subprocess.run(["pdfimages", "-list", str(dst)], capture_output=True, check=True).stdout
        assert b"cmyk" in listing and b"jpeg" in listing, "Poppler did not find resampled CMYK JPEG"
        # Find the 40x20 CMYK PPM
        cmyk_ppm = None
        for p in sorted(Path(tmp).glob("ppm_img-*.ppm")):
            with p.open("rb") as f:
                magic = f.readline().strip()
                dims = f.readline().strip()
                if dims == b"40 20" and magic == b"P6":
                    # Check if this PPM has the CMYK quadrant colors
                    f.readline()
                    data = f.read()
                    tl = (5 * 40 + 5) * 3
                    if data[tl] < 50 and data[tl+1] > 140 and data[tl+2] > 200:
                        cmyk_ppm = data
                        break
        assert cmyk_ppm is not None, "CMYK image was not extracted with correct pixel dimensions"
        # Top-left Cyan: low R, high G & B
        tl = (5 * 40 + 5) * 3
        assert cmyk_ppm[tl] < 50 and cmyk_ppm[tl+1] > 140 and cmyk_ppm[tl+2] > 200, "Cyan pixel color incorrect"
        # Top-right Magenta: high R & B, low G
        tr = (5 * 40 + 35) * 3
        assert cmyk_ppm[tr] > 200 and cmyk_ppm[tr+1] < 50 and cmyk_ppm[tr+2] > 100, "Magenta pixel color incorrect"
        # Bottom-left Yellow: high R & G, low B
        bl = (15 * 40 + 5) * 3
        assert cmyk_ppm[bl] > 200 and cmyk_ppm[bl+1] > 200 and cmyk_ppm[bl+2] < 50, "Yellow pixel color incorrect"
        # Bottom-right Black: low R, G, B
        br = (15 * 40 + 35) * 3
        assert cmyk_ppm[br] < 60 and cmyk_ppm[br+1] < 60 and cmyk_ppm[br+2] < 60, "Black pixel color incorrect"

        # Test optimize-images (quality-only) on photographic CMYK: dimensions preserved, reencoded as DCTDecode
        cmyk_grad = bytearray()
        for y in range(128):
            for x in range(128):
                cmyk_grad.extend([(x * 2) % 256, (y * 2) % 256, (x + y) % 256, ((x * y) // 64) % 256])
        grad_content = b"q 128 0 0 128 0 0 cm /ImCmykGrad Do Q\n"
        grad_objs = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /ImCmykGrad 5 0 R >> >> /Contents 4 0 R >>",
            stream("", grad_content),
            stream("/Type /XObject /Subtype /Image /Width 128 /Height 128 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode", zlib.compress(bytes(cmyk_grad))),
        ]
        grad_data = bytearray(b"%PDF-1.7\n")
        grad_offsets = [0]
        for number_idx, obj in enumerate(grad_objs, 1):
            grad_offsets.append(len(grad_data))
            grad_data += f"{number_idx} 0 obj\n".encode() + obj + b"\nendobj\n"
        grad_xref = len(grad_data)
        grad_data += f"xref\n0 {len(grad_offsets)}\n0000000000 65535 f \n".encode()
        for offset in grad_offsets[1:]:
            grad_data += f"{offset:010d} 00000 n \n".encode()
        grad_data += f"trailer\n<< /Size {len(grad_offsets)} /Root 1 0 R >>\nstartxref\n{grad_xref}\n%%EOF\n".encode()
        grad_src = Path(tmp) / "grad_src.pdf"
        grad_src.write_bytes(grad_data)

        opt_dst = Path(tmp) / "opt_output.pdf"
        opt_job = {"operation": "optimize-images", "inputFile": str(grad_src),
                   "outputFile": str(opt_dst), "imageQuality": 65}
        opt_res = subprocess.run([str(cli)], input=json.dumps(opt_job).encode(), capture_output=True)
        assert opt_res.returncode == 0, opt_res.stderr.decode(errors="replace")
        subprocess.run([str(qpdf), "--check", str(opt_dst)], capture_output=True, check=True)
        opt_vals, opt_refs, _ = objects(qpdf, opt_dst)
        assert (image(opt_vals, opt_refs["/ImCmykGrad"])["/Width"],
                image(opt_vals, opt_refs["/ImCmykGrad"])["/Height"]) == (128, 128)
        assert image(opt_vals, opt_refs["/ImCmykGrad"])["/Filter"] == "/DCTDecode"
        assert opt_dst.stat().st_size < grad_src.stat().st_size

        result = export(cli, src, untouched, 80)
        assert result.returncode == 3, result.stderr.decode(errors="replace")
        assert b"No supported opaque RGB/grayscale/CMYK image exceeded" in result.stderr
        assert not untouched.exists()
    print("resampling and quality optimization reduced RGB, Gray and CMYK; real pixel visual verification passed; text/vector/masks/ICC/shared refs unchanged; no-op failed")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]) if len(sys.argv) > 3 else None)
