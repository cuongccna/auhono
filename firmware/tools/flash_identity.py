#!/usr/bin/env python3
"""Nạp danh tính (mã thiết bị + khóa 32 byte) vào phân vùng NVS "ident" của một chip.

Đầu vào là một dòng của devices.csv do `server/scripts/provision.ts` sinh ra:
    device_id,device_key_hex,activation_code,qr_payload

Cách làm: dựng ảnh NVS bằng `esp_idf_nvs_partition_gen` (công cụ chính thức của ESP-IDF, cài qua pip),
rồi ghi ảnh vào đúng địa chỉ phân vùng "ident" (đọc từ partitions.csv) bằng esptool. Phân vùng này
nằm NGOÀI ảnh firmware nên `pio run -t upload` và OTA không đụng tới nó.

Ví dụ:
    python3 tools/flash_identity.py --csv ../server/out/devices.csv --device AUH-000001 --port /dev/ttyUSB0
    python3 tools/flash_identity.py --csv ../server/out/devices.csv --device AUH-000001 --no-flash --out ident_AUH-000001.bin

Cần:  pip install esp-idf-nvs-partition-gen esptool
Khóa là BÍ MẬT: script không in khóa ra màn hình, tệp tạm được xóa; nếu dùng --out thì tệp có quyền 0600
(và khớp .gitignore: ident_*.bin). Đừng commit hay gửi qua kênh không an toàn.
"""
import argparse
import csv
import os
import re
import shutil
import subprocess
import sys
import tempfile

DEVICE_ID_RE = re.compile(r"^[A-Z0-9-]{3,32}$")  # khớp server/src/app.ts và auhono::isValidDeviceId
KEY_HEX_RE = re.compile(r"^[0-9a-fA-F]{64}$")
NAMESPACE = "id"  # khớp storage.cpp (loadIdentity)


def die(msg: str) -> None:
    print(f"LOI: {msg}", file=sys.stderr)
    sys.exit(1)


def read_row(csv_path: str, device_id: str) -> tuple[str, str]:
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("device_id") == device_id:
                key = (row.get("device_key_hex") or "").strip()
                if not DEVICE_ID_RE.match(device_id):
                    die(f"device_id không hợp lệ: {device_id!r}")
                if not KEY_HEX_RE.match(key):
                    die("device_key_hex phải là 64 ký tự hex (32 byte)")
                return device_id, key.lower()
    die(f"không tìm thấy {device_id} trong {csv_path}")
    raise AssertionError  # không tới đây


def ident_partition(partitions_csv: str) -> tuple[int, int]:
    """Đọc địa chỉ + kích thước phân vùng 'ident' từ partitions.csv (một nguồn sự thật duy nhất)."""
    with open(partitions_csv, encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            cols = [c.strip() for c in line.split(",")]
            if cols[0] == "ident":
                return int(cols[3], 0), int(cols[4], 0)
    die(f"không có phân vùng 'ident' trong {partitions_csv}")
    raise AssertionError


def build_image(device_id: str, key_hex: str, size: int, out_path: str) -> None:
    with tempfile.TemporaryDirectory(prefix="auhono-ident-") as tmp:
        os.chmod(tmp, 0o700)
        csv_path = os.path.join(tmp, "ident.csv")
        fd = os.open(csv_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("key,type,encoding,value\n")
            f.write(f"{NAMESPACE},namespace,,\n")
            f.write(f"device_id,data,string,{device_id}\n")
            f.write(f"device_key,data,hex2bin,{key_hex}\n")  # lưu dạng blob 32 byte
        tmp_bin = os.path.join(tmp, "ident.bin")
        cmd = [sys.executable, "-m", "esp_idf_nvs_partition_gen", "generate", csv_path, tmp_bin, hex(size)]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            die("esp_idf_nvs_partition_gen thất bại (đã cài chưa? pip install esp-idf-nvs-partition-gen):\n" + res.stderr[-500:])
        fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as out, open(tmp_bin, "rb") as src:
            shutil.copyfileobj(src, out)
        os.chmod(out_path, 0o600)


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True, help="devices.csv do server/scripts/provision.ts sinh ra")
    ap.add_argument("--device", required=True, help="mã thiết bị, ví dụ AUH-000001")
    ap.add_argument("--partitions", default=os.path.join(here, "..", "partitions.csv"))
    ap.add_argument("--port", help="cổng serial của chip, ví dụ /dev/ttyUSB0 hoặc COM5")
    ap.add_argument("--baud", default="460800")
    ap.add_argument("--no-flash", action="store_true", help="chỉ tạo ảnh NVS (dùng với --out)")
    ap.add_argument("--out", help="giữ ảnh NVS ở đường dẫn này (mặc định: tạo tạm rồi xóa)")
    args = ap.parse_args()

    device_id, key_hex = read_row(args.csv, args.device)
    offset, size = ident_partition(args.partitions)

    if args.no_flash and not args.out:
        die("--no-flash cần --out để biết ghi ảnh ra đâu")
    if not args.no_flash and not args.port:
        die("thiếu --port (hoặc dùng --no-flash --out ...)")

    if args.out:
        image_path, cleanup = args.out, False
    else:
        fd, image_path = tempfile.mkstemp(prefix="ident_", suffix=".bin")
        os.close(fd)
        cleanup = True
    try:
        build_image(device_id, key_hex, size, image_path)
        print(f"Đã tạo ảnh NVS cho {device_id} ({size} byte, phân vùng 'ident' tại {hex(offset)}).")
        if not args.no_flash:
            cmd = [sys.executable, "-m", "esptool", "--chip", "esp32c3", "--port", args.port, "--baud", args.baud,
                   "write_flash", hex(offset), image_path]  # esptool tự kiểm MD5 sau khi ghi
            print("Đang ghi vào chip...")
            if subprocess.run(cmd).returncode != 0:
                die("esptool ghi thất bại")
            print(f"Xong. Chip mang mã {device_id}. Dán nhãn/QR tương ứng lên hộp.")
    finally:
        if cleanup and os.path.exists(image_path):
            os.remove(image_path)


if __name__ == "__main__":
    main()
