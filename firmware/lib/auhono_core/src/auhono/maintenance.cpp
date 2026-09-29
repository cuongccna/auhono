#include "auhono/maintenance.h"

namespace auhono {

const char* rebootReasonText(RebootReason r) {
  switch (r) {
    case RebootReason::None:         return "khong";
    case RebootReason::Planned:      return "dinh ky (uptime dai)";
    case RebootReason::LowHeap:      return "heap qua thap";
    case RebootReason::NoContact:    return "lau khong lien lac duoc server";
    case RebootReason::OtaInstalled: return "vua cai firmware moi";
    case RebootReason::Rollback:     return "quay ve firmware cu";
    case RebootReason::PortalFault:  return "loi cong cau hinh";
  }
  return "khong ro";
}

RebootReason decideReboot(const MaintenanceInputs& in) {
  if (in.otaBusy) return RebootReason::None;
  if (in.lowHeapStrikes >= kMaxLowHeapStrikes) return RebootReason::LowHeap;
  if (in.portalActive) return RebootReason::None;  // đang có người cấu hình: đừng cắt ngang
  if (in.wifiUp && in.sinceContactS >= kNoContactRebootS) return RebootReason::NoContact;

  const bool idle = in.bufferCount <= kPlannedRebootMaxBacklog && in.lastUploadOk && !in.breachActive &&
                    in.sinceContactS < kPlannedRebootMaxSinceContactS;
  if (in.uptimeS >= kForcedRebootAfterS && !in.breachActive) return RebootReason::Planned;
  if (in.uptimeS >= kPlannedRebootAfterS && idle) return RebootReason::Planned;
  return RebootReason::None;
}

RecoveryStep nextRecoveryStep(uint32_t sinceContactS, uint8_t& stage) {
  if (stage == 0 && sinceContactS >= kCycleWifiAfterS) { stage = 1; return RecoveryStep::CycleWifi; }
  if (stage == 1 && sinceContactS >= kRestartWifiAfterS) { stage = 2; return RecoveryStep::RestartWifiDriver; }
  return RecoveryStep::None;
}

}  // namespace auhono
