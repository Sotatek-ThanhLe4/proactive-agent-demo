# Requirements Document

## Introduction

Tính năng **Proactive Event-Driven Agent** là một **App SotaAgents độc lập**
(repo này: `sotaagents-app-proactive-agent`) cho phép agent **chủ động phản hồi**
dựa trên Event, thay vì chỉ trả lời khi member gõ. Ví dụ: có việc xảy ra (event)
→ khi member mở app, agent tự xử lý event và phản hồi.

**Nguyên tắc cốt lõi (đã chốt): chỉ code trong App, KHÔNG sửa Core.** App tái
dùng API chat sẵn có của Core (`POST /workspace-chat`) làm bộ máy hội thoại; App
không tự chạy LLM loop, không sửa Gateway.

**Mô hình định danh & billing (đã chốt):**
- Mỗi member có **đúng một cuộc hội thoại** xuyên suốt với agent (không tạo
  nhiều conversation).
- Event **luôn gắn với subject là một member cụ thể** → để rót vào đúng hội
  thoại và **trừ đúng credit của member đó**.
- App gọi `POST /workspace-chat` **bằng session của chính member** (member đang
  mở app) → Core gắn conversation + trừ credit vào đúng member. Không dùng
  service account, không cần Core hỗ trợ "act on behalf of".

**Xử lý offline (đã chốt — phương án "ghi nhận + xử lý khi quay lại"):**
- Khi member **offline** (không mở app): App backend **chỉ GHI NHẬN** event vào
  hàng đợi của member — KHÔNG chạy agent, KHÔNG tốn credit.
- Khi member **quay lại** (mở app, có session): App lấy các event tồn đọng và
  cho agent xử lý qua `POST /workspace-chat` (trừ đúng credit member).
- Hệ quả: event không bao giờ mất; agent không chạy vô ích lúc không ai đọc.

**Ngoài phạm vi:** chạy agent + gửi thông báo ra ngoài (email/push) lúc member
offline (việc đó buộc sửa Core — không thuộc feature thuần-app này); đa kênh
(Telegram/Zalo).

## Glossary

- **App**: App SotaAgents độc lập trong repo này, gồm App_Backend + App_Surface.
  Là nơi DUY NHẤT chứa code của feature này.
- **App_Backend**: Dịch vụ backend của App (chạy ngoài Gateway) — nhận Event,
  lưu hàng đợi event theo member, phục vụ App_Surface.
- **App_Surface**: Giao diện App đóng góp vào workspace chat (native module) —
  nút mở ra màn hình chat của App; chạy trong trình duyệt member (có session).
- **Core**: SotaAgents API Gateway — KHÔNG sửa trong feature này; chỉ được App
  gọi qua API sẵn có.
- **Workspace_Chat_API**: API chat sẵn có của Core (`POST /workspace-chat`) mà
  App_Surface gọi bằng session member để chạy một lượt agent và nhận SSE.
- **Member**: Người dùng đã đăng nhập workspace; là subject của Event và là
  người chịu credit.
- **Subject**: Định danh member gắn với một Event (để rót đúng hội thoại + trừ
  đúng credit).
- **Conversation**: Cuộc hội thoại duy nhất giữa một member và agent.
- **Event**: Tín hiệu cho biết có việc xảy ra, gắn Subject; gồm `type` + payload
  nghiệp vụ.
- **Event_Queue**: Hàng đợi event theo member trong App_Backend, dùng khi member
  offline.
- **Online**: Member đang mở App_Surface (có session hoạt động).
- **Offline**: Member không mở App_Surface.
- **Context**: Nội dung App nạp từ Event để làm đầu vào cho lượt chat.

## Requirements

### Requirement 1: App độc lập, không sửa Core

**User Story:** Là kỹ sư nền tảng, tôi muốn feature này là một App riêng dùng
API Core sẵn có, để không phải sửa Core khi phát triển và onboard.

#### Acceptance Criteria

1. THE App SHALL chứa toàn bộ code của feature (App_Backend + App_Surface) trong
   repo `sotaagents-app-proactive-agent`.
2. THE App SHALL chạy một lượt agent bằng cách gọi Workspace_Chat_API sẵn có của
   Core, KHÔNG tự chạy LLM loop.
3. THE feature SHALL không yêu cầu thay đổi mã nguồn Core.

### Requirement 2: Nhận Event gắn Subject

**User Story:** Là App, tôi muốn mỗi Event xác định rõ member liên quan, để rót
đúng hội thoại và trừ đúng credit.

#### Acceptance Criteria

1. THE App_Backend SHALL cung cấp một endpoint nhận Event.
2. WHEN một Event được nhận, THE App_Backend SHALL đọc Subject (định danh member)
   gắn với Event.
3. IF một Event không có Subject hợp lệ, THEN THE App_Backend SHALL từ chối Event
   đó và không xử lý.
4. THE App_Backend SHALL không diễn giải nghiệp vụ ngoài phần cần để định tuyến
   theo Subject và loại Event.

### Requirement 3: Một hội thoại duy nhất mỗi member

**User Story:** Là member, tôi muốn mọi tương tác với agent nằm trong một cuộc
hội thoại liên tục, để agent luôn có ngữ cảnh về tôi.

#### Acceptance Criteria

1. THE App SHALL ánh xạ mỗi member tới đúng một Conversation.
2. WHEN App_Surface mở, THE App SHALL dùng lại Conversation hiện có của member
   thay vì tạo mới.
3. THE App SHALL suy ra Conversation của một member một cách tất định từ định
   danh member.

### Requirement 4: Chủ động khi member online

**User Story:** Là member đang mở app, tôi muốn agent tự phản hồi khi có event,
để được hỗ trợ chủ động mà không phải gõ.

#### Acceptance Criteria

1. WHILE member Online, WHEN một Event của member tới App_Backend, THE App SHALL
   đưa Event tới App_Surface.
2. WHEN App_Surface nhận một Event lúc Online, THE App_Surface SHALL nạp Context
   từ Event và gọi Workspace_Chat_API bằng session member.
3. WHEN agent trả lời qua Workspace_Chat_API, THE App_Surface SHALL hiển thị câu
   trả lời trong giao diện App.
4. THE App_Surface SHALL gọi Workspace_Chat_API mà không cần member gõ tin nhắn.

### Requirement 5: Ghi nhận Event khi member offline

**User Story:** Là member, tôi muốn các event xảy ra lúc tôi offline không bị
mất, để khi quay lại agent xử lý được.

#### Acceptance Criteria

1. WHILE member Offline, WHEN một Event của member tới App_Backend, THE
   App_Backend SHALL lưu Event vào Event_Queue của member.
2. WHILE member Offline, THE App SHALL KHÔNG chạy agent và KHÔNG tiêu credit cho
   Event đó.
3. THE App_Backend SHALL giữ Event trong Event_Queue cho tới khi được xử lý hoặc
   hết hạn theo chính sách lưu trữ đã cấu hình.

### Requirement 6: Xử lý Event tồn khi member quay lại

**User Story:** Là member, tôi muốn khi mở lại app thì agent xử lý những việc đã
xảy ra lúc tôi vắng, để không bỏ lỡ.

#### Acceptance Criteria

1. WHEN App_Surface mở và có Event trong Event_Queue của member, THE App_Surface
   SHALL lấy các Event tồn đọng.
2. WHEN xử lý Event tồn, THE App_Surface SHALL nạp Context và gọi
   Workspace_Chat_API bằng session member.
3. WHEN nhiều Event tồn đọng cho một member, THE App SHALL gộp hoặc xử lý chúng
   sao cho không tạo quá nhiều lượt agent cho một lần quay lại.
4. WHEN một Event tồn đã được xử lý, THE App_Backend SHALL đánh dấu Event đó đã
   xử lý và không xử lý lại.

### Requirement 7: Credit trừ đúng member

**User Story:** Là chủ org, tôi muốn mỗi lượt agent trừ đúng credit của member
liên quan, để chi phí minh bạch.

#### Acceptance Criteria

1. WHEN App gọi Workspace_Chat_API, THE App SHALL dùng session của đúng member
   là Subject của Event.
2. THE App SHALL KHÔNG dùng service account hay danh tính máy để chạy lượt agent
   thay member.
3. THE App SHALL dựa vào Core để trừ credit theo member đăng nhập của lượt gọi.

### Requirement 8: App Surface trong workspace chat

**User Story:** Là member, tôi muốn một nút trong workspace chat mở giao diện của
App, để dùng trợ lý chủ động ngay trong không gian làm việc.

#### Acceptance Criteria

1. THE App SHALL đóng góp một App_Surface hiển thị như một nút/điểm vào trong
   workspace chat.
2. WHEN member mở App_Surface, THE App SHALL hiển thị Conversation của member.
3. WHEN có Event được xử lý, THE App_Surface SHALL hiển thị lượt agent tương ứng
   trong giao diện App.
4. THE App_Surface SHALL nhận câu trả lời của agent qua stream trả về từ
   Workspace_Chat_API.

### Requirement 9: Đưa Event tới Surface khi online

**User Story:** Là App, tôi muốn đưa event tới giao diện member đang mở một cách
đáng tin cậy, để agent phản hồi kịp thời.

#### Acceptance Criteria

1. THE App SHALL cung cấp một cơ chế để App_Surface biết có Event mới cho member
   (poll hoặc kênh đẩy riêng của App).
2. WHEN App_Surface đang mở, THE App SHALL chuyển Event của member tới
   App_Surface trong thời gian hợp lý đã cấu hình.
3. IF cơ chế đưa Event tới App_Surface thất bại, THEN THE App SHALL giữ Event ở
   trạng thái chưa xử lý để thử lại hoặc xử lý ở lần mở sau.

### Requirement 10: Chống lạm dụng và kiểm soát nhịp

**User Story:** Là chủ sản phẩm, tôi muốn agent không phản hồi tràn lan khi nhiều
event dồn dập, để tránh phiền và tốn credit.

#### Acceptance Criteria

1. WHEN nhiều Event của một member tới gần nhau, THE App SHALL gộp chúng để chạy
   tối đa một lượt agent trong cửa sổ gộp đã cấu hình.
2. THE App SHALL áp một trần số lượt agent chủ động trên mỗi member trong cửa sổ
   thời gian đã cấu hình.
3. THE App SHALL chỉ chạy lượt agent cho các loại Event được cấu hình là "đáng
   phản hồi".
4. IF một Event không thuộc loại "đáng phản hồi", THEN THE App SHALL ghi nhận
   Event mà không chạy lượt agent.

### Requirement 11: Tái dùng cho nhiều khách hàng

**User Story:** Là kỹ sư tích hợp, tôi muốn thêm khách mới bằng cấu hình App, để
không phải viết lại từ đầu.

#### Acceptance Criteria

1. THE App SHALL là khung/mẫu dùng chung để nhiều khách tái dùng qua cấu hình.
2. THE App SHALL cho phép cấu hình danh sách loại Event "đáng phản hồi" theo từng
   khách/tenant.
3. THE App SHALL diễn giải payload Event theo nghiệp vụ riêng từng khách mà không
   yêu cầu Core hiểu payload.
