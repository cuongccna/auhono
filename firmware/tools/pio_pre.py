# Chạy trước khi biên dịch (PlatformIO extra_scripts): kiểm tra các tệp/cờ bảo mật bắt buộc để
# lỗi cấu hình hiện ra ngay với thông báo dễ hiểu thay vì lỗi liên kết khó đọc.
Import("env")  # noqa: F821  (do PlatformIO/SCons cung cấp)
import os

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

# 2. Bộ CA gốc TLS.
if not os.path.isfile(os.path.join(proj, "certs", "roots.pem")):
    fail("Thieu certs/roots.pem. Tao bang: python3 tools/make_roots.py")

# 3. Cảnh báo cờ nguy hiểm / giá trị mẫu.
flags = " ".join(str(f) for f in env.get("BUILD_FLAGS", []))  # noqa: F821
if "ALLOW_INSECURE_TLS" in flags:
    print("\n!!! CANH BAO: ALLOW_INSECURE_TLS dang bat - KHONG xac thuc chung chi server. Chi dung khi phat trien !!!\n")
if "example.workers.dev" in flags:
    print("\n!!! CANH BAO: AUHONO_SERVER_URL van la gia tri mau (example.workers.dev). Sua trong platformio.ini !!!\n")
