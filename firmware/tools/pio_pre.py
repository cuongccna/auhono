# Chạy trước khi biên dịch (PlatformIO extra_scripts): kiểm tra các tệp/cờ bảo mật bắt buộc để
# lỗi cấu hình hiện ra ngay với thông báo dễ hiểu thay vì lỗi liên kết khó đọc.
Import("env")  # noqa: F821  (do PlatformIO/SCons cung cấp)
import base64
import os
import re

proj = env["PROJECT_DIR"]  # noqa: F821


def fail(msg):
    print("\n*** LOI CAU HINH AUHONO ***\n" + msg + "\n")
    env.Exit(1)  # noqa: F821


# 1. Khóa công khai kiểm chữ ký OTA phải có, và tuyệt đối không được là khóa bí mật.
pem_path = os.path.join(proj, "keys", "ota_public.pem")
if not os.path.isfile(pem_path):
    fail("Thieu keys/ota_public.pem (khoa cong khai ECDSA P-256 kiem chu ky OTA).\n"
         "Tao cap khoa bang: tools/gen_ota_keys.sh  (khoa bi mat nam o keys/private/, da gitignore).")
pem = open(pem_path, "r", encoding="utf-8").read()
if "PRIVATE KEY" in pem:
    fail("keys/ota_public.pem chua KHOA BI MAT! Xoa ngay va tao lai khoa (khoa da coi nhu lo).")
if not pem.lstrip().startswith("-----BEGIN PUBLIC KEY-----"):
    fail("keys/ota_public.pem khong phai khoa cong khai PEM (\"BEGIN PUBLIC KEY\").")
# Phải đúng khóa ECDSA P-256 (SubjectPublicKeyInfo 91 byte, tiền tố cố định). Firmware chỉ kiểm chữ ký P-256/SHA-256;
# khóa loại khác thì mọi bản OTA đều bị từ chối và máy đã giao không cập nhật được nữa.
try:
    der = base64.b64decode("".join(l for l in pem.splitlines() if l and not l.startswith("-----")), validate=True)
except Exception:
    der = b""
P256_SPKI_PREFIX = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")
if len(der) != 91 or not der.startswith(P256_SPKI_PREFIX) or der[26] != 0x04:
    fail("keys/ota_public.pem khong phai khoa cong khai ECDSA P-256 (secp256r1).\n"
         "Tao bang tools/gen_ota_keys.sh (openssl ... ec_paramgen_curve:P-256).")

# 2. Bộ CA gốc TLS.
roots_path = os.path.join(proj, "certs", "roots.pem")
if not os.path.isfile(roots_path):
    fail("Thieu certs/roots.pem. Tao bang: python3 tools/make_roots.py")
roots = open(roots_path, "r", encoding="utf-8").read()
if roots.count("-----BEGIN CERTIFICATE-----") < 1 or roots.count("-----BEGIN CERTIFICATE-----") != roots.count("-----END CERTIFICATE-----"):
    fail("certs/roots.pem khong chua chung chi PEM hop le (BEGIN/END khong khop). Tao lai bang tools/make_roots.py")

# 3. Cảnh báo cờ nguy hiểm / giá trị mẫu.
flags = " ".join(str(f) for f in env.get("BUILD_FLAGS", []))  # noqa: F821
m = re.search(r'-DAUHONO_FW_VERSION=\\?"([^"\\]*)\\?"', flags)
if m:
    # Khớp auhono::compareVersions: thiết bị chỉ so sánh/cài được phiên bản dạng số.số[.số[.số][-pre|+build]].
    if not re.match(r"^[0-9]{1,9}(\.[0-9]{1,9}){0,3}([-+][0-9A-Za-z._+-]+)?$", m.group(1)) or len(m.group(1)) > 32:
        fail("AUHONO_FW_VERSION=%r khong hop le. Dung dang 1.0.1 (hoac 1.2.0-rc1), toi da 32 ky tu: OTA so sanh phien ban theo so." % m.group(1))
else:
    print("\n!!! CANH BAO: khong thay -DAUHONO_FW_VERSION trong build_flags; dung gia tri mac dinh 0.0.0-dev !!!\n")
if re.search(r"CORE_DEBUG_LEVEL=[1-9]", flags):
    print("\n!!! CANH BAO: CORE_DEBUG_LEVEL > 0: log cua thu vien Arduino co the in SSID/header HTTP (X-Signature). Khong dung cho ban giao khach !!!\n")
if "ALLOW_INSECURE_TLS" in flags:
    print("\n!!! CANH BAO: ALLOW_INSECURE_TLS dang bat - KHONG xac thuc chung chi server. Chi dung khi phat trien !!!\n")
if "example.workers.dev" in flags:
    print("\n!!! CANH BAO: AUHONO_SERVER_URL van la gia tri mau (example.workers.dev). Sua trong platformio.ini !!!\n")
