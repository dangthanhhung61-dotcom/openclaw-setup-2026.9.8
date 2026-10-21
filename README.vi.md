<div align="center">

# 🦞 OpenClaw Setup

**Cài và vận hành trợ lý AI trên Zalo, Telegram, Messenger bằng giao diện web. Bot chạy thẳng trên máy, không cần gõ lệnh.**

OpenClaw **2026.9.8** · Windows · macOS · Linux · MIT

![Tiếng Việt](https://flagcdn.com/20x15/vn.png) **Tiếng Việt** · [![English](https://flagcdn.com/20x15/gb.png) English](README.md)

<img src="docs/screenshot-dashboard.png" alt="Bảng điều khiển OpenClaw Setup" width="90%" />

</div>

## Tính năng

- **Một giao diện cho cả vòng đời bot**: cài OpenClaw và 9Router, tạo bot, đăng nhập kênh chat, sửa tính cách, bật skill và plugin, xem nhật ký.
- **Nhiều kênh**: Zalo cá nhân (quét mã QR), Zalo Bot API, Telegram (một hoặc nhiều bot), Facebook Messenger (qua plugin).
- **Nhiều model qua 9Router**: Gemini, Claude, GPT… đăng nhập tài khoản thay vì dán API key. Combo `smart-route` tự chuyển sang model khác khi một model hết lượt.
- **Chạy trực tiếp trên máy**, không cần Docker. Có lối tắt **Khởi động Bot** trên Desktop.
- **Dữ liệu nằm trên máy bạn**: cấu hình, khoá, trí nhớ của bot đều ở trong thư mục của bot.

## Yêu cầu

- Windows 10/11, macOS hoặc Linux.
- [Node.js 24 LTS](https://nodejs.org).
- [Git](https://git-scm.com/downloads), để lệnh `npx` tải được mã từ GitHub.
- Trên Windows: mở PowerShell hoặc Command Prompt **bình thường**, **không** chọn "Run as administrator".

## Cài đặt

```bash
npx github:dangthanhhung61-dotcom/openclaw-setup-2026.9.8 --project-dir=C:\bot
```

Giao diện tự mở tại **http://127.0.0.1:51789**. Thư mục project tuỳ bạn đặt; bỏ `--project-dir` thì mặc định là `C:\openclaw-setup` (Windows) hoặc `~/openclaw-setup` (macOS, Linux).

Hoặc tải mã về rồi chạy, không cần `npm install`:

```bash
git clone https://github.com/dangthanhhung61-dotcom/openclaw-setup-2026.9.8.git
node openclaw-setup-2026.9.8/dist/cli.js --project-dir=C:\bot
```

## Các bước trên giao diện

1. **Cài đặt**: chọn hệ điều hành và thư mục project, bấm **Cài đặt**. Bộ cài cài OpenClaw, 9Router và tạo lối tắt trên Desktop. Lần đầu mất vài phút.
2. **Tài khoản model**: mở 9Router tại **http://127.0.0.1:20128** (mật khẩu mặc định `123456`), vào **Providers** và đăng nhập tài khoản model. Combo `smart-route` được tạo tự động.
3. **Tạo bot**: tab **Bot** → **Tạo bot**, chọn kênh, điền tên bot, tính cách và tên chủ bot.
4. **Kết nối kênh**: Zalo cá nhân thì quét mã QR bằng ứng dụng Zalo; Telegram thì dán token lấy từ `@BotFather`.
5. **Nhắn thử** cho bot.

<img src="docs/screenshot-bot.png" alt="Tab Bot của OpenClaw Setup" width="90%" />

## Dùng hằng ngày

- **Bật, tắt bot**: lối tắt **Khởi động Bot** trên Desktop, hoặc thư mục **Bot OpenClaw** trong Start Menu (có thêm **Dừng Bot** và **Mở giao diện quản trị**).
- **Mở lại giao diện**: chạy lại lệnh cài đặt ở trên, hoặc **Mở giao diện quản trị** trong Start Menu.
- **Sửa tính cách, quy tắc**: tab **Bot** → cây tệp (`SOUL.md`, `AGENTS.md`, `USER.md`), sửa xong bấm **Lưu**.
- **Cập nhật bộ cài**: khi có bản mới, giao diện hiện nút **Cập nhật x.y.z** ở thanh trên cùng. Nút này cài commit mới nhất của repo này (không phải gói npm `create-openclaw-bot`, đó là bản gốc của tác giả cũ). Chạy lại lệnh `npx github:…` ở trên cũng lấy được bản mới nhất.

## Câu hỏi thường gặp

<details>
<summary><b>Bot không trả lời?</b></summary>

Kiểm 9Router đã có tài khoản model và combo `smart-route` chưa (http://127.0.0.1:20128), rồi xem tab **Nhật ký** trong giao diện. Sau mỗi lần khởi động, bot cần khoảng 1–2 phút mới sẵn sàng nhận tin.
</details>

<details>
<summary><b>Hai bot dùng chung một tài khoản Zalo được không?</b></summary>

Không. Mỗi tài khoản Zalo chỉ chạy được một bot; bot thứ hai đăng nhập sẽ đẩy bot đầu tiên ra.
</details>

<details>
<summary><b>Vì sao không nên chạy bằng quyền Administrator?</b></summary>

Bot sẽ chạy lệnh với toàn quyền trên máy, và các skill điều khiển ứng dụng khác (ví dụ AutoCAD) không kết nối được tới ứng dụng mở bằng quyền thường.
</details>

<details>
<summary><b>Dữ liệu của bot nằm ở đâu?</b></summary>

Trong `C:\Users\<tên>\.openclaw` (Windows) hoặc `~/.openclaw` (macOS, Linux). Thư mục `.openclaw` trong project là đường liên kết trỏ tới đó. Sao lưu thư mục này là giữ được toàn bộ bot.
</details>

## Tài liệu thêm

- [Hướng dẫn chi tiết: bảng cổng, Linux/VPS, mở giao diện từ xa, lỗi thường gặp](docs/SETUP.vi.md)
- [Nhật ký thay đổi](CHANGELOG.vi.md)

## Giấy phép

MIT. Xem [LICENSE](LICENSE).
