// server/webrtc-server.js
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { client } = require('./grpc-client');
const crypto = require('crypto');
const url = require('url');

const HARDCODED_TOKEN = '3k659sdg98gkn3d9ghhg977';

// Audio configuration
const GRPC_AUDIO_SAMPLE_RATE = 24000; // gRPC server output sample rate
const CLIENT_AUDIO_SAMPLE_RATE = 8000; // Client playback sample rate

// Configuration
const WORKSPACE_ID = 'workspace_001';
const HOTLINE = '+84987654321';

// Resample Int16 PCM audio from sourceSampleRate to targetSampleRate
function resampleInt16Audio(inputBase64, sourceSampleRate, targetSampleRate) {
    // Decode base64 to buffer
    const inputBuffer = Buffer.from(inputBase64, 'base64');
    const inputSamples = new Int16Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.length / 2);

    const ratio = sourceSampleRate / targetSampleRate;
    const outputLength = Math.floor(inputSamples.length / ratio);
    const outputSamples = new Int16Array(outputLength);

    // Simple linear interpolation resampling
    for (let i = 0; i < outputLength; i++) {
        const srcIndex = i * ratio;
        const srcIndexFloor = Math.floor(srcIndex);
        const srcIndexCeil = Math.min(srcIndexFloor + 1, inputSamples.length - 1);
        const frac = srcIndex - srcIndexFloor;

        // Linear interpolation between two samples
        const sample = inputSamples[srcIndexFloor] * (1 - frac) + inputSamples[srcIndexCeil] * frac;
        outputSamples[i] = Math.round(sample);
    }

    // Convert back to base64
    return Buffer.from(outputSamples.buffer).toString('base64');
}

/**
 * Creates a WebRTC signaling server
 * Handles WebRTC signaling over WebSocket and maps to gRPC proto messages
 */
function createWebRTCServer(httpServer) {
    const wss = new WebSocketServer({ noServer: true });

    // Handle upgrade requests for WebRTC signaling
    httpServer.on('upgrade', (request, socket, head) => {
        const parsedUrl = url.parse(request.url, true);
        const { pathname, query } = parsedUrl;

        // Path pattern: /live-call/webrtc/{call_id}/{customer_phone_number}
        const match = pathname.match(/^\/live-call\/webrtc\/([^\/]+)\/([^\/]+)$/);

        if (match) {
            console.log('[WebRTC] Upgrade request matched. Call ID:', match[1], 'Customer Phone Number:', match[2]);
            const callId = match[1];
            const customerPhoneNumber = match[2];
            const token = query.token;

            // Hardcoded token check
            if (token === HARDCODED_TOKEN) {
                wss.handleUpgrade(request, socket, head, (ws) => {
                    ws.callId = callId;
                    ws.customerPhoneNumber = customerPhoneNumber;
                    wss.emit('connection', ws, request);
                });
            } else {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
            }
        }
    });

    wss.on('connection', (ws, request) => {
        console.log('[WebRTC Signaling] Client connected');

        const connectionId = crypto.randomUUID();
        const callId = ws.callId || crypto.randomUUID();
        const customerPhoneNumber = ws.customerPhoneNumber || '+84-987-654-321';
        let callInitialized = false;
        let audioChunkCount = 0;
        let peerConnectionActive = false;

        // Tạo gRPC bidirectional stream
        const stream = client.StreamCall((error, response) => {
            if (error) {
                console.error('[WebRTC-gRPC] Stream callback error:', error.message);
            }
        });

        // Handle stream errors
        stream.on('error', (err) => {
            console.error('[WebRTC-gRPC] Stream error event:', err.message);
            console.error('[WebRTC-gRPC] Error code:', err.code);
            console.error('[WebRTC-gRPC] Error details:', err.details);
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                    type: 'error',
                    error: err.message
                }));
                ws.close(1011, `gRPC error: ${err.message}`);
            }
        });

        // gRPC → WebRTC Signaling (receive server responses)
        stream.on('data', (serverResponse) => {
            if (!serverResponse.status) {
                // Error response
                if (serverResponse.error) {
                    console.error('[WebRTC-gRPC] Error:', serverResponse.error.message);
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            error: serverResponse.error
                        }));

                        setTimeout(() => {
                            if (ws.readyState === 1) {
                                ws.close(1008, `gRPC logic error: ${serverResponse.error.message}`);
                            }
                        }, 100);
                    }
                }
                return;
            }

            // Handle different response types
            if (serverResponse.audio_output) {
                const audioChunk = serverResponse.audio_output;

                if (ws.readyState === 1 && peerConnectionActive) {
                    // Resample audio from 24kHz to 8kHz before sending to client
                    const resampledAudio = resampleInt16Audio(
                        audioChunk.audio_content,
                        GRPC_AUDIO_SAMPLE_RATE,
                        CLIENT_AUDIO_SAMPLE_RATE
                    );

                    // Send audio via WebRTC data channel (mapped from proto)
                    ws.send(JSON.stringify({
                        type: 'audio',
                        audio_content: resampledAudio
                    }));
                }
            } else if (serverResponse.text_output) {
                const textChunk = serverResponse.text_output;

                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({
                        type: 'text',
                        text: textChunk.text
                    }));
                }
            } else if (serverResponse.signal) {
                const signal = serverResponse.signal;

                if (signal.end_call) {
                    console.log('[WebRTC-gRPC] Received end_call signal for:', signal.end_call.call_id);
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({
                            type: 'end_call',
                            call_id: signal.end_call.call_id
                        }));
                        ws.close(1000, 'Call ended by server');
                    }
                } else if (signal.transfer_call) {
                    console.log('[WebRTC-gRPC] Received transfer_call signal');
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({
                            type: 'transfer_call',
                            staff_info: signal.transfer_call.staff_info
                        }));
                    }
                } else if (signal.kill_audio) {
                    console.log('[WebRTC-gRPC] Received kill_audio signal for:', signal.kill_audio.call_id);
                    if (ws.readyState === 1) {
                        ws.send(JSON.stringify({
                            type: 'kill_audio',
                            call_id: signal.kill_audio.call_id
                        }));
                    }
                }
            }
        });

        stream.on('end', () => {
            console.log('[WebRTC-gRPC] Stream ended');
            if (ws.readyState === 1) {
                ws.close(1000, 'gRPC stream ended');
            }
        });

        // WebRTC Signaling → gRPC (receive client messages)
        ws.on('message', (rawMessage) => {
            let message;
            try {
                message = JSON.parse(rawMessage);
            } catch (err) {
                console.error('[WebRTC Signaling] Failed to parse message:', err.message);
                return;
            }

            // Map WebRTC signaling types to proto messages
            switch (message.type) {
                case 'offer':
                case 'answer':
                case 'ice-candidate':
                    // WebRTC signaling messages - handle peer connection setup
                    console.log(`[WebRTC Signaling] Received ${message.type}`);
                    // In production, you might want to handle these for actual WebRTC setup
                    // For now, we acknowledge and mark peer connection as active
                    if (message.type === 'answer') {
                        peerConnectionActive = true;
                        console.log('[WebRTC] Peer connection established');
                    }
                    break;

                case 'start':
                    // Map to InitialInfo proto message
                    console.log('[WebRTC] Received start signal');
                    if (!callInitialized) {
                        const initialInfo = {
                            status: true,
                            initial_info: {
                                workspace_id: WORKSPACE_ID,
                                call_id: callId,
                                customer_phone_number: customerPhoneNumber,
                                type_call: message.type_call || 'outbound',
                                hotline: HOTLINE,
                                url_audio_file: message.url_audio_file || ''
                            }
                        };

                        stream.write(initialInfo);
                        callInitialized = true;
                        peerConnectionActive = true;
                        console.log('[WebRTC] Initialized call with gRPC server');

                        // Send ready signal back to client
                        ws.send(JSON.stringify({
                            type: 'ready',
                            call_id: callId
                        }));
                    }
                    break;

                case 'audio':
                    // Map to ClientAudioChunk proto message
                    if (!callInitialized) {
                        console.warn('[WebRTC] Received audio before call initialization');
                        return;
                    }

                    audioChunkCount++;
                    const audioData = message.audio_content;

                    const audioChunk = {
                        status: true,
                        play_audio: {
                            sample_rate: message.sample_rate || 16000,
                            sample_width: message.sample_width || 2,
                            num_channels: message.num_channels || 1,
                            duration: message.duration || 0.0,
                            audio_content: audioData
                        }
                    };

                    stream.write(audioChunk);
                    break;

                case 'disconnect':
                    // Map to DisconnectMessage proto message
                    console.log('[WebRTC] Client requested disconnect');
                    const disconnectMsg = {
                        status: true,
                        disconnect: {}
                    };

                    stream.write(disconnectMsg);
                    break;

                default:
                    console.warn('[WebRTC Signaling] Unknown message type:', message.type);
            }
        });

        ws.on('close', (code, reason) => {
            console.log(`[WebRTC Signaling] Client disconnected. Code: ${code}, Reason: ${reason || 'N/A'}`);
            console.log(`[WebRTC Stats] Total audio chunks sent: ${audioChunkCount}`);
            stream.end();
        });

        ws.on('error', (error) => {
            console.error('[WebRTC Signaling] WebSocket error:', error.message);
        });

        // Send initial connection acknowledgment
        ws.send(JSON.stringify({
            type: 'connected',
            connection_id: connectionId,
            call_id: callId
        }));
    });

    console.log('[WebRTC Server] WebRTC signaling server initialized');
    return wss;
}

module.exports = { createWebRTCServer };
