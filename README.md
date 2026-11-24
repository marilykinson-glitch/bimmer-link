# MyBMW & 1CR (`bimmer_link`) — BMW iDrive 7 / MGU Store

Ứng dụng **"MyBMW không cần ConnectedDrive"** tích hợp điều khiển **Đề nổ làm mát từ xa (`Option 1CR`)**, tự động gửi **Ảnh thẻ trạng thái / cam 360 & vị trí hầm khi đỗ xe** và **Giám sát chế độ Valet** qua **Telegram Bot cá nhân** (0 tốn máy chủ trung gian).

## Tính năng chính

1. **Đề nổ & Làm mát từ xa (`Option 1CR`):**
   - **Kích nổ trực tiếp (`Start 1CR`):** Tự động dò các giao diện `Climate / AuxiliaryConditioning / Preconditioning` trong `/etc/oap/someip/someip-interfaces.json` của xe, bật cờ cho phép đề nổ và kích hoạt ngay khi đầu MGU đang thức (hoặc trong ~10 phút đầu sau khi khoá xe).
   - **Hẹn giờ nổ máy lưu thẳng vào hộp `BDC_BODY3 / IHKA` (`Smart Departure Sync`):** Nạp giờ khởi hành (ví dụ `07:30` đi làm, `17:15` tan ca) xuống bộ đếm phần cứng của hộp BDC/IHKA. Khi đầu MGU tắt điện ngủ sâu (`0W`), **tự hộp BDC thức dậy đề nổ máy `1CR` làm lạnh cabin sẵn** mà không hao ắc quy lúc đỗ!
   - **Tab Chuyên sâu 1CR (`SOME/IP Inspector`):** Mở trên điện thoại qua mã QR để xem trực tiếp toàn bộ hàm/trường Climate của phiên bản phần mềm trên xe, bấm chạy thử từng lệnh và **ghim cố định cấu hình chuẩn** cho xe.

2. **Tự động báo vị trí hầm & Ảnh chụp khi tắt máy (`Park Snapshot`):**
   - Bắt khoảnh khắc tắt máy đỗ xe (`FAHREN → PARKEN`), đọc vị trí định vị hầm (`Positioning.currentLocation` vẫn nhớ toạ độ dưới hầm chung cư/TTTM), mức xăng, quãng đường còn lại, điện áp bình 12V (qua UDS `0x22 F442`), nhiệt độ máy/ngoài trời, kiểm tra cửa/cốp/khoá xe và tổng kết chuyến đi vừa chạy, gửi thẳng về **Telegram** kèm các nút bấm điều khiển nhanh.

3. **Chế độ Valet 1 chạm (`Gửi bãi / Rửa xe / Giao thợ garage`):**
   - Bật ngay trên màn hình xe hoặc trên Telegram trước khi giao chìa. Hễ xe chạy quá tốc độ cho phép (mặc định `45 km/h`), đạp tua máy cao (`> 3500 RPM`), hoặc chạy ra khỏi bán kính cho phép (`> 500m`), xe lập tức bắn cảnh báo đỏ kèm vị trí về Telegram.

---

## Cài đặt lên MGU Store

1. Đẩy thư mục này lên một repo GitHub của bạn (ví dụ `ten-tai-khoan/bimmer-link`).
2. Mở **MGU Store** trên xe → phần **Sources** → thêm `ten-tai-khoan/bimmer-link` (nhánh `main`).
3. Bấm cài đặt **MyBMW & 1CR** (Store sẽ tự cài kèm dịch vụ chạy ngầm **Trợ thủ MyBMW & 1CR** và cấp quyền ra mạng qua `mgu-uplink`).

## Kết nối Telegram trong 30 giây

1. Mở ứng dụng **MyBMW & 1CR** trên màn hình xe → màn hình hiện **Mã QR** và **Mã PIN 4 số** (điện thoại và xe nối chung Wi-Fi hoặc điểm phát sóng).
2. Trên Telegram, mở `@BotFather` → gõ `/newbot` để lấy **Bot Token**, sau đó bấm **Start** (nhắn `hi`) vào Bot vừa tạo.
3. Quét mã QR trên màn hình xe → qua tab **Telegram** → dán Token → bấm **🔍 Tự nhận Chat ID** → bấm **📨 Gửi ảnh Test ngay**!

## Kiểm tra mã nguồn trên máy tính

```sh
python3 tests/verify_all.py
# Hoặc nếu máy có cài Node.js:
node scripts/check_node8.js && node tests/bimmer_link_test.js
```
