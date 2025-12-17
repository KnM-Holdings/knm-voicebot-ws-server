// server/index.js
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { client } = require('./grpc-client');
const crypto = require('crypto');
const url = require('url');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Audio resampling configuration
const INPUT_SAMPLE_RATE = 24000;  // gRPC server output rate
const OUTPUT_SAMPLE_RATE = 8000; // Target rate for WebSocket client

// Audio buffering configuration
const AUDIO_BUFFER_DURATION = 8.0; // Buffer audio until ~8 seconds before sending
const AUDIO_BUFFER_MIN_BYTES = OUTPUT_SAMPLE_RATE * 2 * AUDIO_BUFFER_DURATION; // 8000 samples/sec * 2 bytes/sample * 8 sec = 128000 bytes

/**
 * Resample Int16 PCM audio from one sample rate to another using linear interpolation
 * @param {Buffer|string} audioData - Base64 encoded Int16 PCM audio
 * @param {number} fromRate - Source sample rate (e.g., 24000)
 * @param {number} toRate - Target sample rate (e.g., 8000)
 * @returns {string} Base64 encoded resampled Int16 PCM audio
 */
function resampleAudio(audioData, fromRate, toRate) {
    // Decode base64 to buffer
    const inputBuffer = Buffer.from(audioData, 'base64');

    // Convert buffer to Int16Array
    const inputSamples = new Int16Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.length / 2);

    // Calculate output length
    const ratio = fromRate / toRate;
    const outputLength = Math.floor(inputSamples.length / ratio);
    const outputSamples = new Int16Array(outputLength);

    // Linear interpolation resampling
    for (let i = 0; i < outputLength; i++) {
        const srcIndex = i * ratio;
        const srcIndexFloor = Math.floor(srcIndex);
        const srcIndexCeil = Math.min(srcIndexFloor + 1, inputSamples.length - 1);
        const fraction = srcIndex - srcIndexFloor;

        // Linear interpolation between two adjacent samples
        const sample = inputSamples[srcIndexFloor] * (1 - fraction) + inputSamples[srcIndexCeil] * fraction;
        outputSamples[i] = Math.round(sample);
    }

    // Convert back to base64
    const outputBuffer = Buffer.from(outputSamples.buffer);
    return outputBuffer.toString('base64');
}

// Function to check gRPC connection
async function checkGrpcConnection() {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000; // 5 second timeout
        client.waitForReady(deadline, (error) => {
            if (error) {
                reject(new Error(`[gRPC Connection Error] Cannot connect to ${process.env.GRPC_SERVER || '192.168.1.36:50051'}: ${error.message}`));
            } else {
                resolve(true);
                console.log(`[gRPC Connection] ✓ Successfully connected to ${process.env.GRPC_SERVER || '192.168.1.36:50051'}`);
            }
        });
    });
}

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/client.html');
});

app.get('/audio-processor.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(__dirname + '/audio-processor.js');
});

server.on('upgrade', (request, socket, head) => {
    const parsedUrl = url.parse(request.url, true);
    const { pathname, query } = parsedUrl;
    console.log('[Server] Upgrade request for:', pathname);
    console.log('[Server] Query parameters:', query);

    // Path pattern: /api/asr/streaming
    if (pathname === '/api/asr/streaming' || pathname === '/api/asr/streaming/') {
        console.log('[Server] WebSocket upgrade matched for /api/asr/streaming');

        // Extract parameters from query string
        const tenantId = query.tenant_id;
        const hotline = query.hotline;
        const phone = query.phone;
        const callId = query.call_id;
        const speakerId = query.speaker_id;
        const env = query.env || 'dev';

        // Validate required parameters
        if (!tenantId || !callId) {
            console.error('[Server] Missing required parameters: tenant_id or call_id');
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
        }

        console.log('[Server] Call ID:', callId, 'Phone:', phone, 'Hotline:', hotline);

        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.callId = callId;
            ws.phone = phone;
            ws.hotline = hotline;
            ws.tenantId = tenantId;
            ws.speakerId = speakerId;
            ws.env = env;
            wss.emit('connection', ws, request);
        });
    } else {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
    }
});

wss.on('connection', (ws, request) => {
    // console.log('[WebSocket] Client connected');

    const connectionId = crypto.randomUUID();
    const callId = ws.callId || crypto.randomUUID();
    const phone = ws.phone || '';
    const hotline = ws.hotline || '';
    const tenantId = ws.tenantId || '';
    const speakerId = ws.speakerId || '';
    const env = ws.env || 'dev';
    let callInitialized = false;
    let audioChunkCount = 0;

    // Audio buffer for accumulating audio chunks before sending to client
    let audioBuffer = [];
    let audioBufferBytes = 0;
    let audioFlushTimeout = null; // Timeout to flush buffer if no new audio arrives

    // Function to flush audio buffer and send to client
    function flushAudioBuffer(force = false) {
        // Clear any pending flush timeout
        if (audioFlushTimeout) {
            clearTimeout(audioFlushTimeout);
            audioFlushTimeout = null;
        }

        if (audioBuffer.length === 0) return;
        if (!force && audioBufferBytes < AUDIO_BUFFER_MIN_BYTES) return;

        // Combine all buffered audio chunks into one
        const combinedBuffer = Buffer.concat(audioBuffer);
        const combinedBase64 = combinedBuffer.toString('base64');

        // Calculate total audio duration
        const numSamples = combinedBuffer.length / 2; // Int16 = 2 bytes per sample
        const audioDuration = numSamples / OUTPUT_SAMPLE_RATE;

        if (ws.readyState === 1) { // OPEN
            const responseMessage = {
                type: "playAudio",
                data: {
                    audioContentType: "raw",
                    sampleRate: OUTPUT_SAMPLE_RATE,
                    audioContent: combinedBase64,
                    audioDuration: parseFloat(audioDuration.toFixed(4)),
                    textContent: ""
                },
                final: 0,
                sip_number: "",
                send_at: Date.now()
            };
            ws.send(JSON.stringify(responseMessage));
            console.log(`[WebSocket] Sent buffered audio: ${combinedBuffer.length} bytes, duration=${audioDuration.toFixed(2)}s`);
        }

        // Clear buffer
        audioBuffer = [];
        audioBufferBytes = 0;
    }

    // Tạo gRPC bidirectional stream
    const stream = client.StreamCall((error, response) => {
        if (error) {
            console.error('[gRPC] Stream callback error:', error.message);
        }
    });

    // Auto-send initial_info to gRPC immediately upon WebSocket connection
    // Using parameters from URL query string
    console.log('[gRPC] Auto-sending initial_info to gRPC');
    const initialRequest = {
        status: true,
        initial_info: {
            workspace_id: tenantId,
            call_id: callId,
            customer_phone_number: phone,
            type_call: 'inbound',
            hotline: hotline,
            url_audio_file: ""
        }
    };

    console.log('[gRPC] InitialInfo request:', JSON.stringify(initialRequest, null, 2));
    stream.write(initialRequest);
    callInitialized = true;

    // Log stream events
    // stream.on('prolog', () => console.log('[gRPC] Stream prolog'));
    // stream.on('headers', (headers) => console.log('[gRPC] Stream headers received'));

    // Handle stream errors immediately
    stream.on('error', (err) => {
        console.error('[gRPC] Stream error event:', err.message);
        console.error('[gRPC] Error code:', err.code);
        console.error('[gRPC] Error details:', err.details);
        if (ws.readyState === 1) {
            ws.close(1011, `gRPC error: ${err.message}`);
        }
    });

    // gRPC → WebSocket (receive server responses)
    stream.on('data', (serverResponse) => {
        // console.log('[gRPC] Received ServerResponse - status:', serverResponse.status);

        if (!serverResponse.status) {
            // Error response
            if (serverResponse.error) {
                console.error('[gRPC] Error:', serverResponse.error.message);
                if (ws.readyState === 1) {
                    // Convert gRPC error to new WebSocket format
                    ws.send(JSON.stringify({
                        type: "error",
                        data: {
                            error_code: serverResponse.error.error_code || 80100,
                            internal_error_code: serverResponse.error.internal_error_code || 500,
                            message: serverResponse.error.message
                        },
                        send_at: Date.now()
                    }));

                    // Close connection if gRPC reports error (e.g. initial_info failed)
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
            const inputRate = audioChunk.sample_rate || INPUT_SAMPLE_RATE;

            if (ws.readyState === 1) { // OPEN
                try {
                    // Resample audio from gRPC rate (24kHz) to client rate (8kHz)
                    const resampledAudio = resampleAudio(audioChunk.audio_content, inputRate, OUTPUT_SAMPLE_RATE);
                    const resampledBuffer = Buffer.from(resampledAudio, 'base64');

                    // Add to buffer instead of sending immediately
                    audioBuffer.push(resampledBuffer);
                    audioBufferBytes += resampledBuffer.length;

                    // console.log(`[WebSocket] Buffered audio chunk: ${resampledBuffer.length} bytes, total buffer: ${audioBufferBytes} bytes`);

                    // Check if buffer is large enough to send (~2 seconds)
                    if (audioBufferBytes >= AUDIO_BUFFER_MIN_BYTES) {
                        flushAudioBuffer();
                    } else {
                        // Set timeout to flush buffer if no new audio arrives within 500ms
                        if (audioFlushTimeout) {
                            clearTimeout(audioFlushTimeout);
                        }
                        audioFlushTimeout = setTimeout(() => {
                            flushAudioBuffer(true); // force flush remaining audio
                        }, 500);
                    }
                } catch (err) {
                    console.error('[WebSocket] Error resampling audio:', err.message);
                }
            }
        } else if (serverResponse.text_output) {
            // Forward text output to client if present
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                    type: "text",
                    data: {
                        textContent: serverResponse.text_output.text || ""
                    },
                    send_at: Date.now()
                }));
            }
        } else if (serverResponse.signal) {
            const signal = serverResponse.signal;

            if (signal.end_call) {
                // console.log('[gRPC] Received end_call signal for:', signal.end_call.call_id);
                // Flush any remaining audio before ending
                flushAudioBuffer(true);

                if (ws.readyState === 1) {
                    // Convert gRPC signal to new WebSocket format
                    const disconnectMessage = {
                        type: "disconnect",
                        send_at: Date.now()
                    };
                    // console.log('[WebSocket] Sending disconnect signal to client');
                    ws.send(JSON.stringify(disconnectMessage));
                    // Close connection after sending the message
                    setTimeout(() => {
                        if (ws.readyState === 1) {
                            ws.close(1000, 'Call ended by server');
                        }
                    }, 100);
                }
            } else if (signal.transfer_call) {
                // console.log('[gRPC] Received transfer_call signal');
                // Flush any remaining audio before transfer
                flushAudioBuffer(true);

                if (ws.readyState === 1) {
                    // Get sip_number from target_staff (first staff's extension)
                    const targetStaff = signal.transfer_call.target_staff || [];
                    const sipNumber = targetStaff.length > 0 ? (targetStaff[0].extension || targetStaff[0].sip_number || "") : "";

                    // Convert gRPC signal to new WebSocket format
                    const transferMessage = {
                        type: "transfer",
                        // sip_number: sipNumber,
                        sip_number: 100,
                        send_at: Date.now()
                    };
                    // console.log('[WebSocket] Sending transfer signal to client');
                    ws.send(JSON.stringify(transferMessage));
                }
            } else if (signal.kill_audio) {
                // Flush any buffered audio and notify client to clear playback
                flushAudioBuffer(true);

                if (ws.readyState === 1) {
                    const killAudioMessage = {
                        type: "killAudio",
                        data: {
                            call_id: signal.kill_audio.call_id || callId
                        },
                        send_at: Date.now()
                    };
                    ws.send(JSON.stringify(killAudioMessage));
                }
            } else {
                // Other signal types - convert to appropriate format
                if (ws.readyState === 1) {
                    // For unknown signals, send as-is with type wrapper
                    ws.send(JSON.stringify({ type: "signal", data: signal, send_at: Date.now() }));
                }
            }
        }
    });

    // Audio configuration for binary input
    const CLIENT_SAMPLE_RATE = 8000;  // Client sends 8kHz audio
    const CLIENT_SAMPLE_WIDTH = 16;   // 16-bit audio
    const CLIENT_NUM_CHANNELS = 1;    // Mono

    // WebSocket → gRPC (receive client messages)
    ws.on('message', (data, isBinary) => {
        try {
            if (isBinary) {
                // Handle binary audio data (8kHz, 16-bit, mono PCM)
                const audioBuffer = Buffer.from(data);

                // Calculate duration based on audio data size
                // Size in bytes / 2 (16-bit = 2 bytes per sample) / sample_rate = duration in seconds
                const numSamples = audioBuffer.length / 2;
                const duration = numSamples / CLIENT_SAMPLE_RATE;

                // Convert to base64 for gRPC
                const base64Audio = audioBuffer.toString('base64');

                // Log first few chunks for debugging
                if (audioChunkCount < 3) {
                    console.log(`[WebSocket] Binary audio: ${audioBuffer.length} bytes, duration=${duration.toFixed(4)}s`);
                }

                // Send to gRPC
                const clientRequest = {
                    status: true,
                    play_audio: {
                        sample_rate: CLIENT_SAMPLE_RATE,
                        sample_width: CLIENT_SAMPLE_WIDTH,
                        num_channels: CLIENT_NUM_CHANNELS,
                        duration: duration,
                        audio_content: base64Audio
                    }
                };

                audioChunkCount++;
                stream.write(clientRequest);
            } else {
                // Handle JSON messages
                const message = JSON.parse(data.toString());
                // console.log('[WebSocket] Received message type:', Object.keys(message)[0]);

                // Handle disconnect message
                if (message.disconnect !== undefined || message.type === 'disconnect') {
                    console.log('[WebSocket] Received disconnect message from client');
                    const disconnectRequest = {
                        status: true,
                        disconnect: {}
                    };
                    stream.write(disconnectRequest);
                }
                // Handle initial_info message - IGNORED since server auto-sends it
                else if (message.initial_info) {
                    console.log('[WebSocket] Received initial_info from client - IGNORED (server already sent it automatically)');
                }
                else {
                    console.warn('[WebSocket] Unknown JSON message type:', Object.keys(message)[0]);
                }
            }
        } catch (err) {
            console.error('[WebSocket] Error processing message:', err.message);
        }
    });

    ws.on('close', () => {
        console.log('[WebSocket] Client disconnected');

        // Clear flush timeout
        if (audioFlushTimeout) {
            clearTimeout(audioFlushTimeout);
            audioFlushTimeout = null;
        }

        // Flush any remaining audio in buffer (client disconnected, so this won't be sent)
        // Just clear the buffer
        audioBuffer = [];
        audioBufferBytes = 0;

        // Send disconnect message if stream is still active and writable
        if (callInitialized && stream.writable) {
            const disconnectRequest = {
                status: true,
                disconnect: {}
            };

            // console.log('[gRPC] Sending disconnect message');
            try {
                stream.write(disconnectRequest);
            } catch (err) {
                console.error('[gRPC] Error sending disconnect message:', err.message);
            }
        }

        stream.end();
    });

    ws.on('error', (err) => {
        console.error('[WebSocket] Error:', err);
        stream.end();
    });
});

const PORT = process.env.PORT || 8080;

// Check gRPC connection before starting server
checkGrpcConnection()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`[Server] WebSocket server running on ws://localhost:${PORT}`);
            console.log(`[Server] gRPC client connecting to: ${process.env.GRPC_SERVER}`);
        });
    })
    .catch((error) => {
        console.error(error.message);
        process.exit(1);
    });