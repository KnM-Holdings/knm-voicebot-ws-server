# WebRTC to Proto Mapping Documentation

## Overview

WebRTC server chạy song song với WebSocket server trên cùng một HTTP server và port. WebRTC sử dụng WebSocket cho signaling channel, và map các event WebRTC với proto messages đã có sẵn.

## Architecture

```
Client (Browser)
    ↓ (WebSocket or WebRTC mode)
    ↓
Nginx (Port 80)
    ↓ (proxy to backend)
    ↓
Node.js Server (Port 8080)
    ├── WebSocket Server (/live-call/websocket/...)
    │   └── Uses proto messages directly
    │
    └── WebRTC Signaling Server (/live-call/webrtc/...)
        └── Maps WebRTC events to proto messages
            ↓
        gRPC Client (StreamCall bidirectional stream)
            ↓
        AI Service (192.168.1.36:50051)
```

## Proto Messages Reference

### ClientRequest (Client → Server)

```protobuf
message ClientRequest {
  bool status = 1;
  oneof data {
    InitialInfo initial_info = 2;        // type: "info_call"
    ClientAudioChunk play_audio = 3;     // type: "play_audio"
    DisconnectMessage disconnect = 4;    // type: "disconnect"
  }
}
```

### ServerResponse (Server → Client)

```protobuf
message ServerResponse {
  bool status = 1;
  oneof data {
    ServerAudioChunk audio_output = 2;   // Audio from AI
    SignalMessage signal = 3;            // Control signals
    ErrorMessage error = 4;              // Error messages
    ServerTextChunk text_output = 5;     // Text responses
  }
}
```

## WebRTC Event Mapping

### Client → Server (WebRTC to Proto)

| WebRTC Event Type    | Proto Message       | Description                                                                                   |
| -------------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `type: 'start'`      | `InitialInfo`       | Khởi tạo cuộc gọi với workspace_id, call_id, customer_phone_number, type_call, hotline        |
| `type: 'audio'`      | `ClientAudioChunk`  | Gửi audio chunk với sample_rate, sample_width, num_channels, duration, audio_content (base64) |
| `type: 'disconnect'` | `DisconnectMessage` | Ngắt kết nối                                                                                  |

### Server → Client (Proto to WebRTC)

| Proto Message                 | WebRTC Event Type       | Description                                              |
| ----------------------------- | ----------------------- | -------------------------------------------------------- |
| `ServerAudioChunk`            | `type: 'audio'`         | Audio output từ AI service (đã resample từ 24kHz → 8kHz) |
| `ServerTextChunk`             | `type: 'text'`          | Text response từ AI                                      |
| `SignalMessage.end_call`      | `type: 'end_call'`      | Kết thúc cuộc gọi                                        |
| `SignalMessage.transfer_call` | `type: 'transfer_call'` | Chuyển cuộc gọi                                          |
| `SignalMessage.kill_audio`    | `type: 'kill_audio'`    | Dừng audio                                               |
| `ErrorMessage`                | `type: 'error'`         | Lỗi từ server                                            |

### System Messages (không map từ proto)

| WebRTC Event Type   | Description                                                 |
| ------------------- | ----------------------------------------------------------- |
| `type: 'connected'` | Xác nhận kết nối WebSocket, trả về connection_id và call_id |
| `type: 'ready'`     | Call đã được khởi tạo thành công với gRPC                   |

## URL Paths

### WebSocket (Legacy)

```
ws://localhost:8080/live-call/websocket/{call_id}/{customer_phone_number}?token={token}
```

### WebRTC Signaling

```
ws://localhost:8080/live-call/webrtc/{call_id}/{customer_phone_number}?token={token}
```

### Nginx Configuration

```nginx
# WebSocket path
location /live-call/websocket/ {
    proxy_pass http://websocket_servers;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
}

# WebRTC signaling path
location /live-call/webrtc/ {
    proxy_pass http://websocket_servers;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;
}
```

## Audio Flow

### WebSocket Mode

1. Client gửi `play_audio` với audio chunk (Int16 PCM, 8kHz)
2. Server forward đến gRPC service
3. gRPC trả về `audio_output` (Int16 PCM, 24kHz)
4. Server resample 24kHz → 8kHz
5. Server gửi `audio_output` cho client
6. Client decode và play audio

### WebRTC Mode

1. Client gửi `type: 'audio'` với audio chunk (Int16 PCM, 8kHz)
2. Server map sang `ClientAudioChunk` proto message
3. Server forward đến gRPC service
4. gRPC trả về `ServerAudioChunk` (Int16 PCM, 24kHz)
5. Server resample 24kHz → 8kHz
6. Server map sang `type: 'audio'` message
7. Client nhận và play audio

**Lưu ý:** Audio được gửi qua WebSocket signaling channel trong cả hai mode, không sử dụng WebRTC media streams.

## Example Messages

### Client Start (WebRTC Mode)

```json
{
  "type": "start",
  "type_call": "inbound",
  "url_audio_file": ""
}
```

Maps to proto:

```javascript
{
  status: true,
  initial_info: {
    workspace_id: "workspace_001",
    call_id: "call_123",
    customer_phone_number: "84987654321",
    type_call: "inbound",
    hotline: "+84987654321",
    url_audio_file: ""
  }
}
```

### Client Audio (WebRTC Mode)

```json
{
  "type": "audio",
  "sample_rate": 8000,
  "sample_width": 2,
  "num_channels": 1,
  "duration": 0.02,
  "audio_content": "base64_encoded_pcm..."
}
```

Maps to proto:

```javascript
{
  status: true,
  play_audio: {
    sample_rate: 8000,
    sample_width: 2,
    num_channels: 1,
    duration: 0.02,
    audio_content: "base64_encoded_pcm..."
  }
}
```

### Server Audio Response

Proto:

```javascript
{
  status: true,
  audio_output: {
    sample_rate: 8000,  // Already resampled
    sample_width: 2,
    num_channels: 1,
    duration: 0.5,
    audio_content: "base64_encoded_pcm..."
  }
}
```

Maps to WebRTC:

```json
{
  "type": "audio",
  "audio_content": "base64_encoded_pcm..."
}
```

## Key Differences

### WebSocket Mode (Legacy)

- Messages use proto structure directly: `{ play_audio: {...} }`
- Backward compatible với implementation cũ

### WebRTC Mode (New)

- Messages use event-based structure: `{ type: 'audio', ... }`
- Dễ mở rộng cho các tính năng mới
- Có thể thêm WebRTC peer connection sau này nếu cần

## Testing

### Test WebSocket Mode

```javascript
// In browser console
const mode = "websocket";
document.querySelector("#mode-websocket").checked = true;
document.getElementById("start").click();
```

### Test WebRTC Mode

```javascript
// In browser console
const mode = "webrtc";
document.querySelector("#mode-webrtc").checked = true;
document.getElementById("start").click();
```

## Future Enhancements

1. **True WebRTC Media Streams**: Thay vì gửi audio qua WebSocket, có thể sử dụng WebRTC data channels hoặc media streams
2. **Peer-to-Peer**: Có thể setup WebRTC peer-to-peer connection giữa client và AI service
3. **Better Codec Support**: Sử dụng Opus codec thay vì raw PCM
4. **NAT Traversal**: Sử dụng STUN/TURN servers cho WebRTC
