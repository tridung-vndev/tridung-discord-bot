# TriDung Discord Bot V2

Discord bot prefix `.` cho game, TD Đồng, moderation và tu tiên.

## Chạy

```bash
npm install
npm start
```

`.env`:

```env
DISCORD_TOKEN=TOKEN_BOT
OWNER_ID=ID_DISCORD_OWNER
```

Trong Discord Developer Portal phải bật **Message Content Intent** vì bot dùng prefix `.xxx`.

## Game

- `.game` — menu
- `.tx 1000 tai` — đặt Tài/Xỉu; phiên mở bát sau **35 giây**
- `.cau` — xem 20 kết quả gần nhất
- `.bc 1000 cua` — Bầu Cua
- `.nttv` — Nối từ tiếng Việt
- `.ntel` — English Word Chain
- `.ntstop` — dừng nối từ

Tài Xỉu hiển thị 3 xúc sắc, tổng điểm và kết quả. Lịch sử kết quả được lưu để soi cầu.

> Cầu chỉ là lịch sử, không phải dự đoán chắc chắn.

## TD Đồng

- `.tdcoin` — kiểm tra TDĐ
- `.tdcode TDFAMILY` — +50.000 TDĐ
- `.tdcode TD50K` — +50.000 TDĐ
- `.tddaily` — +500 TDĐ mỗi 24 giờ
- `.tdaddcoin @user 50000` — admin cộng TDĐ
- `.tdsubcoin @user 50000` — admin trừ TDĐ

Mỗi code chỉ được một tài khoản dùng một lần.

Owner và bot admin được đảm bảo tối thiểu `1.000.000.000 tỷ TDĐ = 10^18 TDĐ`.

## Admin

- `.tdadmin @user`
- `.tdunadmin @user`
- `.tdadmins`
- `.tdban @user [lý do]`
- `.tdmute @user 10m`
- `.tdchannel #kenh`
- `.tdchannel off`
- `.adtdtai` — ép kết quả ván kế tiếp về Tài
- `.adtdxiu` — ép kết quả ván kế tiếp về Xỉu

Các lệnh `adtdtai/adtdxiu` chỉ admin dùng được. Khi override được sử dụng, bot ghi rõ `Admin override` trong kết quả để không biến cơ chế game thành kết quả bí mật đối với người chơi.

## Nối từ

Mỗi từ nối đúng: **+1.000 TDĐ**.

Khi từ vừa nối đi vào ngõ cụt theo từ điển của bot, người nối cuối nhận thêm **+10.000 TDĐ** và ván kết thúc.

## Kênh game

Admin dùng `.tdchannel #ten-kenh` để giới hạn các lệnh game/tu tiên vào một kênh. `.tdchannel off` để mở lại mọi kênh.
