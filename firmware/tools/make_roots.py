#!/usr/bin/env python3
"""Tạo certs/roots.pem: bộ CA gốc TLS mà firmware tin cậy (cho API và tải OTA).

Vì sao có bộ riêng thay vì cả kho Mozilla (~140 CA): mỗi kết nối TLS phải nạp bộ này vào RAM
(~1,5 KB/CA). Ta chỉ giữ các CA gốc của những nhà cung cấp mà Cloudflare Workers / kho lưu trữ
firmware thường dùng. Nếu server của bạn dùng CA khác: thêm tên vào WANTED rồi chạy lại,
hoặc truyền --extra <file.pem> để ghép thêm.

Nguồn mặc định: kho CA của hệ thống (/etc/ssl/certs/ca-certificates.crt) hoặc --source <file.pem>
(ví dụ tải https://curl.se/ca/cacert.pem).

Cần: pip install cryptography
"""
import argparse
import os
import sys
import warnings

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization

warnings.filterwarnings("ignore")  # vài CA cổ trong kho hệ thống có serial không chuẩn; không ảnh hưởng

# Tên (CN hoặc O) của các CA gốc cần giữ, so khớp không phân biệt hoa thường.
WANTED = [
    "ISRG Root X1", "ISRG Root X2",                # Let's Encrypt
    "GTS Root R1", "GTS Root R4",                  # Google Trust Services (Cloudflare dùng)
    "GlobalSign Root CA", "GlobalSign Root R46",   # GlobalSign (bản chéo ký cho GTS)
    "DigiCert Global Root G2",
    "DigiCert Global Root CA",                     # G1: chuỗi của nhiều máy chủ tải file (vd. GitHub Releases: objects.githubusercontent.com); hết hạn 2031
    "USERTrust RSA Certification Authority", "USERTrust ECC Certification Authority",  # Sectigo
    "SSL.com TLS ECC Root CA 2022", "SSL.com TLS RSA Root CA 2022",  # SSL.com (Cloudflare dùng)
    "Amazon Root CA 1",                            # S3 / CloudFront (kho firmware)
]


def load_bundle(path: str) -> list[x509.Certificate]:
    data = open(path, "rb").read()
    certs, marker = [], b"-----END CERTIFICATE-----"
    for chunk in data.split(marker):
        if b"-----BEGIN CERTIFICATE-----" in chunk:
            pem = chunk[chunk.index(b"-----BEGIN CERTIFICATE-----"):] + marker + b"\n"
            certs.append(x509.load_pem_x509_certificate(pem))
    return certs


def names(cert: x509.Certificate) -> list[str]:
    out = []
    for oid in (x509.NameOID.COMMON_NAME, x509.NameOID.ORGANIZATION_NAME):
        out += [a.value for a in cert.subject.get_attributes_for_oid(oid)]
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="/etc/ssl/certs/ca-certificates.crt")
    ap.add_argument("--extra", action="append", default=[], help="tệp PEM CA gốc bổ sung (có thể lặp lại)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "certs", "roots.pem"))
    args = ap.parse_args()

    wanted = {w.lower() for w in WANTED}
    picked: dict[bytes, x509.Certificate] = {}
    for cert in load_bundle(args.source):
        # chỉ CA gốc (tự ký) và còn hiệu lực
        if cert.subject == cert.issuer and any(n.lower() in wanted for n in names(cert)):
            picked[cert.fingerprint(hashes.SHA256())] = cert
    for extra in args.extra:
        for cert in load_bundle(extra):
            picked[cert.fingerprint(hashes.SHA256())] = cert
    if not picked:
        sys.exit("Không chọn được CA nào; kiểm tra --source")

    certs = sorted(picked.values(), key=lambda c: names(c)[0].lower() if names(c) else "")
    with open(args.out, "wb") as f:
        for c in certs:
            label = (names(c) or ["?"])[0]
            f.write(f"# {label}\n".encode())
            f.write(c.public_bytes(serialization.Encoding.PEM))
    print(f"Đã ghi {len(certs)} CA gốc vào {os.path.normpath(args.out)}:")
    for c in certs:
        expires = getattr(c, "not_valid_after_utc", None) or c.not_valid_after
        print("  -", (names(c) or ["?"])[0], "(hết hạn", expires.date(), ")")


if __name__ == "__main__":
    main()
