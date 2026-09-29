#!/usr/bin/env python3
"""Ký một file firmware (.bin) cho OTA và in câu lệnh SQL đăng ký bản phát hành lên server.

Định dạng chữ ký (khớp firmware, src/ota.cpp):
  - Thuật toán: ECDSA, đường cong P-256 (secp256r1), băm SHA-256.
  - Thông điệp được ký: TOÀN BỘ nội dung file .bin (tức là ký lên digest SHA-256 của nó).
  - Mã hóa: DER (ASN.1 SEQUENCE{r,s}, thường 70-72 byte), viết thành chuỗi hex thường 140-144 ký tự.
  - `sha256` trong manifest: hex thường 64 ký tự của SHA-256(file .bin).
Có thể tự kiểm bằng openssl:
    openssl dgst -sha256 -verify keys/ota_public.pem -signature <(echo -n SIG_HEX | xxd -r -p) firmware.bin

Ví dụ:
    python3 tools/ota_sign.py .pio/build/esp32c3/firmware.bin \\
        --key keys/private/ota_private.pem --pub keys/ota_public.pem \\
        --version 1.0.1 --url https://cdn.example.com/auhono/firmware-1.0.1.bin

Cần: pip install cryptography. Khóa bí mật chỉ đọc từ --key, không bao giờ được in ra.
"""
import argparse
import hashlib
import os
import re
import sys
import time

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, utils
except ImportError:
    sys.exit("Thiếu thư viện: pip install cryptography")

MAX_APP_BYTES = 0x1F0000  # kích thước mỗi khe OTA trong partitions.csv
VERSION_RE = re.compile(r"^[0-9A-Za-z._+-]{1,32}$")  # khớp parseOtaManifest


def die(msg: str) -> None:
    print(f"LOI: {msg}", file=sys.stderr)
    sys.exit(1)


def sql_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("firmware", help="file .bin (ảnh ứng dụng, ví dụ .pio/build/esp32c3/firmware.bin)")
    ap.add_argument("--key", required=True, help="khóa BÍ MẬT PEM (keys/private/ota_private.pem)")
    ap.add_argument("--pub", help="khóa công khai PEM để tự kiểm chữ ký sau khi ký (khuyến nghị)")
    ap.add_argument("--version", required=True, help="phiên bản, phải khớp AUHONO_FW_VERSION của bản build")
    ap.add_argument("--url", required=True, help="URL https:// nơi máy chủ file phục vụ .bin")
    args = ap.parse_args()

    if not VERSION_RE.match(args.version):
        die("version chỉ gồm chữ, số và . - _ + (tối đa 32 ký tự)")
    if not args.url.startswith("https://") or re.search(r"[\s\x00-\x1f\x7f]", args.url) or len(args.url) > 512:
        die("url phải bắt đầu bằng https://, không có khoảng trắng, tối đa 512 ký tự")

    data = open(args.firmware, "rb").read()
    if not data or data[0] != 0xE9:
        die("không phải ảnh ứng dụng ESP32 (byte đầu phải là 0xE9). Dùng firmware.bin, không dùng .elf/.factory.bin")
    if len(data) > MAX_APP_BYTES:
        die(f"file {len(data)} byte vượt khe OTA {MAX_APP_BYTES} byte")

    key = serialization.load_pem_private_key(open(args.key, "rb").read(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        die("khóa phải là ECDSA P-256 (secp256r1). Tạo bằng tools/gen_ota_keys.sh")

    digest = hashlib.sha256(data).digest()
    signature = key.sign(digest, ec.ECDSA(utils.Prehashed(hashes.SHA256())))  # DER
    sig_hex = signature.hex()

    if args.pub:
        pub = serialization.load_pem_public_key(open(args.pub, "rb").read())
        pub.verify(signature, data, ec.ECDSA(hashes.SHA256()))  # ném lỗi nếu khóa công khai không khớp
        derived = key.public_key().public_numbers()
        if derived != pub.public_numbers():
            die("--pub không phải khóa công khai của --key")
        print("# Đã tự kiểm chữ ký bằng khóa công khai: OK", file=sys.stderr)

    print(f"# file      : {os.path.basename(args.firmware)} ({len(data)} byte)")
    print(f"# version   : {args.version}")
    print(f"# sha256    : {digest.hex()}")
    print(f"# signature : {sig_hex}")
    print("#")
    print("# Chạy trên D1 sau khi đã tải file .bin lên URL trên:")
    print("#   wrangler d1 execute auhono --remote --command \"<câu lệnh dưới>\"")
    print(
        "INSERT INTO firmware_releases (version, url, sha256, signature, created_at) VALUES "
        f"({sql_quote(args.version)}, {sql_quote(args.url)}, {sql_quote(digest.hex())}, {sql_quote(sig_hex)}, {int(time.time())});"
    )


if __name__ == "__main__":
    main()
