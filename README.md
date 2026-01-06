# KnM Voicebot WebSocket & WebRTC Server

## Giới thiệu / Introduction

Dự án này là một Gateway Server hỗ trợ cả WebSocket và WebRTC cho hệ thống Voicebot. Nó đóng vai trò là cầu nối giữa Client (Web/Mobile) và AI Service (gRPC).
Server xử lý kết nối WebSocket/WebRTC từ client, xác thực, và chuyển tiếp dữ liệu âm thanh/tín hiệu tới AI Service thông qua gRPC stream hai chiều.

This project is a Gateway Server supporting both WebSocket and WebRTC for the Voicebot system. It acts as a bridge between Clients (Web/Mobile) and the AI Service (gRPC).
The server handles WebSocket/WebRTC connections, authentication, and forwards audio/signal data to the AI Service via a bidirectional gRPC stream.

## Architecture

Hệ thống sử dụng kiến trúc Microservices với Nginx làm Load Balancer.

The system uses a Microservices architecture with Nginx as a Load Balancer.

```ascii
+--------+       +-------+       +------------------+       +--------------+
|        |  WS   |       |  WS   |                  | gRPC  |              |
| Client | <---> | Nginx | <---> | Node.js Server   | <---> |  AI Service  |
| (Web)  |       |       |       | (Gateway)        |       |              |
+--------+       +-------+       +------------------+       +--------------+
    ^                ^                    ^                        ^
    |                |                    |                        |
WebSocket/       Load Balancer        Auth, Resampling,       Core Logic
WebRTC Mode      Sticky Session       Protocol Conversion     ASR/NLP/TTS
```

### Components

1.  **Client**: Ứng dụng phía người dùng (Web), gửi/nhận âm thanh qua WebSocket hoặc WebRTC signaling.
2.  **Nginx**: Reverse Proxy và Load Balancer. Sử dụng `ip_hash` để đảm bảo sticky session (một cuộc gọi luôn được xử lý bởi cùng một server instance).
3.  **Node.js Server**:
    - WebSocket Endpoint: `/live-call/websocket/{call_id}/{customer_phone_number}`
    - WebRTC Signaling Endpoint: `/live-call/webrtc/{call_id}/{customer_phone_number}`
    - Xác thực token.
    - Chuyển đổi giao thức: WebSocket/WebRTC (JSON) <-> gRPC (Protobuf).
    - Xử lý âm thanh: Resample âm thanh từ AI Service (24kHz) xuống 8kHz cho Client.
4.  **AI Service**: Xử lý logic chính (Speech-to-Text, NLP, Text-to-Speech).

## Connection Modes

### WebSocket Mode (Legacy)

- Traditional WebSocket connection
- Direct proto message format
- Backward compatible

### WebRTC Mode (New)

- WebRTC signaling over WebSocket
- Event-based message format
- Ready for future WebRTC media streams enhancement

## API Documentation

### WebSocket Endpoint

```
ws://<host>/live-call/websocket/{call_id}/{customer_phone_number}?token={token}
```

### WebRTC Signaling Endpoint

```
ws://<host>/live-call/webrtc/{call_id}/{customer_phone_number}?token={token}
```

**Parameters:**

- `call_id`: ID duy nhất của cuộc gọi.
- `customer_phone_number`: Số điện thoại khách hàng.
- `token`: Token xác thực (Hardcoded: `3k659sdg98gkn3d9ghhg977`).

### Message Format

Giao tiếp qua WebSocket sử dụng định dạng JSON.
WebSocket communication uses JSON format.

#### 1. Client -> Server (Request)

**A. Initial Info (Gửi ngay sau khi kết nối / Send immediately after connection)**

```json
{
  "initial_info": {
    "workspace_id": "workspace_001",
    "call_id": "call-123",
    "customer_phone_number": "+84987654321",
    "type_call": "inbound",
    "hotline": "+84987654321",
    "url_audio_file": "optional_url"
  }
}
```

**B. Play Audio (Gửi liên tục khi người dùng nói / Stream continuously when user speaks)**

```json
{
  "play_audio": {
    "sample_rate": 16000,
    "sample_width": 16,
    "num_channels": 1,
    "duration": 0.02,
    "audio_content": "<base64_encoded_pcm_audio>"
  }
}
```

**C. Disconnect (Gửi khi người dùng cúp máy / Send when user hangs up)**

```json
{
  "disconnect": {}
}
```

#### 2. Server -> Client (Response)

**A. Audio Output (Âm thanh phản hồi từ AI / Audio response from AI)**

Server sẽ gửi âm thanh đã được resample về 8kHz.
Server sends audio resampled to 8kHz.

```json
{
  "audio_output": {
    "audio_content": "<base64_encoded_pcm_audio>"
  }
}
```

**B. Signal: End Call (Yêu cầu kết thúc cuộc gọi / Request to end call)**

```json
{
  "signal": {
    "end_call": {
      "call_id": "call-123"
    }
  }
}
```

**C. Signal: Transfer Call (Chuyển cuộc gọi / Transfer call)**

```json
{
  "signal": {
    "transfer_call": {
      "call_id": "call-123",
      "customer_phone_number": "+84987654321",
      "target_staff": [
        {
          "name": "Staff Name",
          "phone_number": "123456"
        }
      ]
    }
  }
}
```

**D. Error (Lỗi / Error)**

```json
{
  "error": {
    "error_code": 500,
    "message": "Internal Server Error"
  }
}
```

## Development

### Prerequisites

- Docker & Docker Compose
- Node.js 18+ (for local development)

### Running with Docker

```bash
docker-compose up --build
```

Server sẽ chạy tại port `80` (qua Nginx) hoặc `8080` (trực tiếp).
The server will run on port `80` (via Nginx) or `8080` (directly).

### Project Structure

```
.
├── docker-compose.yml      # Docker composition
├── nginx/                  # Nginx configuration
│   └── nginx.conf
├── server/                 # Node.js Gateway Server
│   ├── index.js            # Main entry point
│   ├── grpc-client.js      # gRPC Client setup
│   ├── audio-processor.js  # Audio processing utils
│   ├── client.html         # Test client
│   └── proto/              # gRPC Protobuf definitions
│       └── voice.proto
└── mock-ai-service/        # Mock AI Service (for testing)
```
