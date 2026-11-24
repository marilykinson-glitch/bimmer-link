# MyBMW & 1CR (`bimmer_link` 0.2.0) — Trọn bộ MGU Store + iPhone App + Android APK

Hệ sinh thái **MyBMW không cần ConnectedDrive** dành cho xe **BMW iDrive 7 (MGU)** đã có hoặc độ **Option 1CR (Remote Engine Start)**:

1. **Trên đầu xe BMW (`bimmer_link` + dịch vụ nền `bimmer-link`):**
   - Đọc trực tiếp vị trí hầm (`Positioning.currentLocation`), % xăng, tầm chạy còn lại, ODO, điện áp bình 12V (qua UDS `0x22 F442`), nhiệt độ máy/ngoài trời, trạng thái cửa/cốp/khoá xe.
   - Tự động dò và điều khiển **Đề nổ làm mát từ xa (`Option 1CR`)** + nạp **Hẹn giờ khởi hành (`Departure Timer`)** thẳng xuống hộp `BDC_BODY3 / IHKA` (tự thức dậy đề nổ máy `1CR` kể cả khi đầu MGU đã tắt điện ngủ sâu `0W`).
   - Tự động chụp thẻ ảnh trạng thái khi tắt máy đỗ xe (`Park Snapshot`) và canh **Chế độ Valet** (giới hạn tốc độ, tua máy, bán kính GPS).
2. **Trên iPhone (`iOS Fullscreen PWA`):**
   - Giao diện chuẩn **MyBMW Dark UI**: https://marilykinson-glitch.github.io/bimmer-link/app/
   - Quét mã QR trên màn hình xe bằng Camera iPhone → mở Safari → bấm **Chia sẻ → Thêm vào MH chính** để dùng tràn viền như App hãng (không bao giờ hết hạn chứng chỉ 7 ngày, vẫn xem được vị trí đỗ, ảnh chụp, % xăng, bình 12V và lịch sử chuyến đi ngay cả khi xe đang ngủ `0W`).
3. **Trên Android (`MyBMW-MGU-0.2.0.apk`):**
   - Tải trực tiếp file `.apk` trong mục **Releases**: https://github.com/marilykinson-glitch/bimmer-link/releases/latest
   - Tích hợp sẵn **Widget 4×2 ngoài màn hình chính Android** và dịch vụ báo động Valet / đỗ xe chạy ngầm.
   - Quét cùng 1 mã QR trên xe là **cả iPhone lẫn Android đồng bộ song song theo thời gian thực** (qua mạng 4G/5G toàn cầu, không cần ngắt CarPlay không dây!).

---

## Cách cài đặt & Ghép nối nhanh

1. **Trên xe (MGU Store):**
   - Vào **MGU Store → Sources**, thêm nguồn: `marilykinson-glitch/bimmer-link` (nhánh `main`).
   - Cài đặt hoặc cập nhật **MyBMW & 1CR** lên bản `0.2.0`.
2. **Trên iPhone:**
   - Mở ứng dụng **MyBMW & 1CR** trên màn hình xe → đưa Camera iPhone quét mã QR bên trái → mở trong Safari → bấm **Chia sẻ → Thêm vào MH chính**.
3. **Trên Android:**
   - Tải và cài `MyBMW-MGU-0.2.0.apk` từ trang Releases → quét cùng mã QR trên màn hình xe (hoặc bấm *Sao chép link sang máy thứ 2* từ iPhone gửi qua) → nhấn giữ màn hình chính Android để lấy **Widget MyBMW** ra ngoài!
