# TriDung Discord Bot v14

Bản v14 lưu dữ liệu bằng `data/db.json`, không cần Supabase.

## Runtime variables
- `DISCORD_TOKEN` — token bot Discord
- `OWNER_ID` — Discord user ID của owner
- `MAIN_GUILD_ID` — tùy chọn, server chính cho báo cáo
- `MAIN_CHANNEL_ID` — tùy chọn, channel báo cáo
- `DATA_DIR` — tùy chọn; mặc định `./data`

## Lưu dữ liệu
TDĐ, user, admin, settings, mã redeem, lịch sử game và trạng thái lì xì được ghi vào `data/db.json`.

Lưu ý: `db.json` là lưu trên filesystem của service. Nếu nền tảng xoá/recreate filesystem khi deploy, dữ liệu local có thể mất. Bản v14 không dùng Supabase.
