#!/usr/bin/env bash
# Tạo cặp khóa ECDSA P-256 để ký firmware OTA.
#   - khóa BÍ MẬT  -> keys/private/ota_private.pem  (chmod 600, đã .gitignore; KHÔNG commit, sao lưu ở nơi an toàn)
#   - khóa CÔNG KHAI -> keys/ota_public.pem          (commit được; được nhúng vào firmware lúc build)
#
# Lưu ý: khóa công khai nhúng trong firmware đã giao cho khách không đổi được từ xa nếu không có
# OTA ký bằng khóa cũ. Mất khóa bí mật = không còn cách cập nhật OTA cho máy đã giao. Sao lưu cẩn thận.
set -euo pipefail

cd "$(dirname "$0")/.."
PRIV=keys/private/ota_private.pem
PUB=keys/ota_public.pem

if [[ -e "$PRIV" ]]; then
  echo "Đã có $PRIV. Từ chối ghi đè (sẽ làm mất khả năng OTA cho máy đã giao). Xóa thủ công nếu THỰC SỰ muốn tạo lại." >&2
  exit 1
fi

mkdir -p keys/private
chmod 700 keys/private
umask 077
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$PRIV"
chmod 600 "$PRIV"
openssl pkey -in "$PRIV" -pubout -out "$PUB"
chmod 644 "$PUB"  # công khai: ai cũng đọc được

echo "Đã tạo:"
echo "  khóa bí mật : $PRIV   (KHÔNG commit, sao lưu ngoại tuyến)"
echo "  khóa công khai: $PUB  (commit, build sẽ nhúng vào firmware)"
echo "Vân tay khóa công khai (sha256 của DER):"
openssl pkey -pubin -in "$PUB" -outform DER | openssl dgst -sha256 | sed 's/^.* //'
