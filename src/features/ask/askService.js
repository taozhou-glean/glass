const { BrowserWindow } = require('electron');
const { createStreamingLLM } = require('../common/ai/factory');
// Lazy require helper to avoid circular dependency issues
const getWindowManager = () => require('../../window/windowManager');
const internalBridge = require('../../bridge/internalBridge');
const { Glean } = require("@gleanwork/api-client");

const getWindowPool = () => {
    try {
        return getWindowManager().windowPool;
    } catch {
        return null;
    }
};

const sessionRepository = require('../common/repositories/session');
const askRepository = require('./repositories');
const { getSystemPrompt } = require('../common/prompts/promptBuilder');
const path = require('node:path');
const fs = require('node:fs');
const os = require('os');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);
const { desktopCapturer } = require('electron');
const modelStateService = require('../common/services/modelStateService');
const listenService = require('../listen/listenService');

// Try to load sharp, but don't fail if it's not available
let sharp;
try {
    sharp = require('sharp');
    console.log('[AskService] Sharp module loaded successfully');
} catch (error) {
    console.warn('[AskService] Sharp module not available:', error.message);
    console.warn('[AskService] Screenshot functionality will work with reduced image processing capabilities');
    sharp = null;
}
let lastScreenshot = null;

async function captureScreenshot(options = {}) {
    if (process.platform === 'darwin') {
        try {
            const tempPath = path.join(os.tmpdir(), `screenshot-${Date.now()}.jpg`);

            await execFile('screencapture', ['-x', '-C', '-t', 'jpg', tempPath]);

            const imageBuffer = await fs.promises.readFile(tempPath);
            await fs.promises.unlink(tempPath);

            if (sharp) {
                try {
                    // Try using sharp for optimal image processing
                    const resizedBuffer = await sharp(imageBuffer)
                        .resize({ height: 384 })
                        .jpeg({ quality: options.quality || 80 })
                        .toBuffer();

                    const base64 = resizedBuffer.toString('base64');
                    const metadata = await sharp(resizedBuffer).metadata();

                    lastScreenshot = {
                        base64,
                        width: metadata.width,
                        height: metadata.height,
                        timestamp: Date.now(),
                    };

                    return { success: true, base64, width: metadata.width, height: metadata.height };
                } catch (sharpError) {
                    console.warn('Sharp module failed, falling back to basic image processing:', sharpError.message);
                }
            }

            // Fallback: Return the original image without resizing
            console.log('[AskService] Using fallback image processing (no resize/compression)');
            const base64 = imageBuffer.toString('base64');

            lastScreenshot = {
                base64,
                width: null, // We don't have metadata without sharp
                height: null,
                timestamp: Date.now(),
            };

            return { success: true, base64, width: null, height: null };
        } catch (error) {
            console.error('Failed to capture screenshot:', error);
            return { success: false, error: error.message };
        }
    }

    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
                width: 1920,
                height: 1080,
            },
        });

        if (sources.length === 0) {
            throw new Error('No screen sources available');
        }
        const source = sources[0];
        const buffer = source.thumbnail.toJPEG(70);
        const base64 = buffer.toString('base64');
        const size = source.thumbnail.getSize();

        return {
            success: true,
            base64,
            width: size.width,
            height: size.height,
        };
    } catch (error) {
        console.error('Failed to capture screenshot using desktopCapturer:', error);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * @class
 * @description
 */
class AskService {
    constructor() {
        this.abortController = null;
        this.state = {
            isVisible: false,
            isLoading: false,
            isStreaming: false,
            currentQuestion: '',
            currentResponse: '',
            showTextInput: true,
        };
        console.log('[AskService] Service instance created.');
    }

    _broadcastState() {
        const askWindow = getWindowPool()?.get('ask');
        if (askWindow && !askWindow.isDestroyed()) {
            askWindow.webContents.send('ask:stateUpdate', this.state);
        }
    }

    async toggleAskButton(inputScreenOnly = false) {
        const askWindow = getWindowPool()?.get('ask');

        let shouldSendScreenOnly = false;
        if (inputScreenOnly && this.state.showTextInput && askWindow && askWindow.isVisible()) {
            shouldSendScreenOnly = true;
            await this.sendMessage('', []);
            return;
        }

        const hasContent = this.state.isLoading || this.state.isStreaming || (this.state.currentResponse && this.state.currentResponse.length > 0);

        if (askWindow && askWindow.isVisible() && hasContent) {
            this.state.showTextInput = !this.state.showTextInput;
            this._broadcastState();
        } else {
            if (askWindow && askWindow.isVisible()) {
                internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });
                this.state.isVisible = false;
            } else {
                console.log('[AskService] Showing hidden Ask window');
                internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
                this.state.isVisible = true;
            }
            if (this.state.isVisible) {
                this.state.showTextInput = true;
                this._broadcastState();
            }
        }
    }

    async closeAskWindow() {
        if (this.abortController) {
            this.abortController.abort('Window closed by user');
            this.abortController = null;
        }

        this.state = {
            isVisible: false,
            isLoading: false,
            isStreaming: false,
            currentQuestion: '',
            currentResponse: '',
            showTextInput: true,
        };
        this._broadcastState();

        internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });

        return { success: true };
    }


    /**
     * 
     * @param {string[]} conversationTexts
     * @param {number} maxTurns
     * @returns {string}
     * @private
     */
    _formatConversationForPrompt(conversationTexts, maxTurns = 30) {
        if (!conversationTexts || conversationTexts.length === 0) {
            return 'No conversation history available.';
        }
        return conversationTexts.slice(-maxTurns).join('\n');
    }

    /**
     * 
     * @param {string} userPrompt
     * @param {Array} conversationHistoryRaw
     * @param {boolean} skipScreenshot - If true, don't include screenshot (useful for text-based asks from transcript)
     * @returns {Promise<{success: boolean, response?: string, error?: string}>}
     */
    async sendMessage(userPrompt, conversationHistoryRaw = [], skipScreenshot = false) {
        const apiKeys = await modelStateService.getAllApiKeys();
        console.log("===== apiKeys", JSON.stringify(apiKeys, null, 2));
        internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
        this.state = {
            ...this.state,
            isLoading: true,
            isStreaming: false,
            currentQuestion: userPrompt,
            currentResponse: '',
            showTextInput: false,
        };
        this._broadcastState();

        if (this.abortController) {
            this.abortController.abort('New request received.');
        }
        this.abortController = new AbortController();
        const { signal } = this.abortController;


        let sessionId;

        try {
            console.log(`[AskService] 🤖 Processing message: ${userPrompt.substring(0, 50)}...`);

            sessionId = await sessionRepository.getOrCreateActive('ask');
            await askRepository.addAiMessage({ sessionId, role: 'user', content: userPrompt.trim() });
            console.log(`[AskService] DB: Saved user prompt to session ${sessionId}`);

            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) {
                throw new Error('AI model or API key not configured.');
            }
            console.log(`[AskService] Using model: ${modelInfo.model} for provider: ${modelInfo.provider}`);

            // Only capture screenshot if not explicitly skipped
            let screenshotBase64 = null;
            if (!skipScreenshot) {
                console.log(`[AskService] Capturing screenshot for analysis`);
                const screenshotResult = await captureScreenshot({ quality: 100 });
                screenshotBase64 = screenshotResult.success ? screenshotResult.base64 : null;
            } else {
                console.log(`[AskService] Skipping screenshot capture (text-based request)`);
            }

            const convHistory = listenService.getCurrentSessionData().conversationHistory;
            const conversationHistory = this._formatConversationForPrompt(convHistory, 50);

            const systemPrompt = getSystemPrompt('pickle_glass_analysis', conversationHistory, false);

            const messages = [
                { role: 'system', content: systemPrompt },
            ];

            // Create different message content based on whether screenshot is included
            if (skipScreenshot || !screenshotBase64) {
                messages.push({
                    role: 'user',
                    content: userPrompt
                });
            } else {
                messages.push({
                    role: 'user',
                    content: [
                        { type: 'text', text: `Here is the screenshot of user\'s screen, and here is user\s ask: "${userPrompt}"` },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } },
                    ],
                });
            }
            

            const streamingLLM = createStreamingLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                model: modelInfo.model,
                temperature: 0.7,
                maxTokens: 2048,
                usePortkey: modelInfo.provider === 'openai-glass',
                portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
            });

            const response = await streamingLLM.streamChat(messages);
            const askWin = getWindowPool()?.get('ask');

            if (!askWin || askWin.isDestroyed()) {
                console.error("[AskService] Ask window is not available to send stream to.");
                response.body.getReader().cancel();
                return { success: false, error: 'Ask window is not available.' };
            }

            const reader = response.body.getReader();
            signal.addEventListener('abort', () => {
                console.log(`[AskService] Aborting stream reader. Reason: ${signal.reason}`);
                reader.cancel(signal.reason).catch(() => { /* 이미 취소된 경우의 오류는 무시 */ });
            });

            await this._processStream(reader, askWin, sessionId, signal, userPrompt.trim(), skipScreenshot);

            return { success: true };

        } catch (error) {
            console.error('[AskService] Error during message processing:', error);
            this.state = {
                ...this.state,
                isLoading: false,
                isStreaming: false,
                showTextInput: true,
            };
            this._broadcastState();

            const askWin = getWindowPool()?.get('ask');
            if (askWin && !askWin.isDestroyed()) {
                const streamError = error.message || 'Unknown error occurred';
                askWin.webContents.send('ask-response-stream-error', { error: streamError });
            }

            return { success: false, error: error.message };
        }
    }

    /**
     * 
     * @param {ReadableStreamDefaultReader} reader
     * @param {BrowserWindow} askWin
     * @param {number} sessionId 
     * @param {AbortSignal} signal
     * @param {string} userPrompt
     * @param {boolean} skipScreenshot
     * @returns {Promise<void>}
     * @private
     */
    async _processStream(reader, askWin, sessionId, signal, userPrompt, skipScreenshot = false) {
        const decoder = new TextDecoder();
        let fullResponse = '';

        try {
            this.state.isLoading = false;
            this.state.isStreaming = true;
            if (!skipScreenshot) {
                this.state.currentResponse += "parsing screenshot...\n\n";
            }
            this._broadcastState();

            if (!skipScreenshot) {
                const parsingTicker = setInterval(() => {
                    this.state.currentResponse += ".";
                    this._broadcastState();
                }, 1000);

                let openAIResponse = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n').filter(line => line.trim() !== '');

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.substring(6);
                            if (data === '[DONE]') {
                                break;
                            }
                            try {
                                const json = JSON.parse(data);
                                const token = json.choices[0]?.delta?.content || '';
                                if (token) {
                                    fullResponse += token;
                                    openAIResponse = fullResponse;
                                    this.state.currentResponse = fullResponse;
                                    clearInterval(parsingTicker);
                                    this._broadcastState();
                                }
                            } catch (error) {
                            }
                        }
                    }
                }
            }

            // now openai finished, try glean

            if (this.state.currentResponse.includes("Asking Glean") || skipScreenshot) {
                this.state.currentResponse += "...\n\n";
                this._broadcastState();

                const apiKeys = await modelStateService.getAllApiKeys();
                const gleanApiKey = apiKeys.glean;
                console.log("===== gleanApiKey", gleanApiKey);
                const client = new Glean({
                    apiToken: gleanApiKey,
                    instance: 'scio-prod',
                });

                const thinkingTicker = setInterval(() => {
                    this.state.currentResponse += ".";
                    this._broadcastState();
                }, 1000);

                fetch('https://scio-prod-be.glean.com/api/v1/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${gleanApiKey}`,
                    },
                    body: JSON.stringify({
                        messages: [
                            {
                                fragments: [{ text: skipScreenshot ? userPrompt : `Here is the description of whats on user's screen: ${openAIResponse}\n\nHere is user's ask: ${userPrompt}` }],
                                author: "USER",
                            }]
                    })
                }).then(async response => {


                console.log("===== Glean response received, processing stream...", response.status);

                if (!response.ok) {
                    throw new Error(`Glean API request failed: ${response.status} ${response.statusText}`);
                }

                // Handle streaming response
                const gleanReader = response.body.getReader();
                const gleanDecoder = new TextDecoder();
                let buffer = '';

                this.state = {
                    ...this.state,
                    isLoading: false,
                    isStreaming: true,
                };
                this._broadcastState();

                try {
                    while (true) {
                        const { done, value } = await gleanReader.read();
                        
                        if (done) {
                            console.log("===== Glean stream completed");
                            break;
                        }

                        // Decode the chunk
                        const chunk = gleanDecoder.decode(value, { stream: true });
                        buffer += chunk;

                        // Process complete lines (newline-delimited JSON)
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || ''; // Keep incomplete line in buffer

                        for (const line of lines) {
                            if (line.trim()) {
                                try {
                                    const data = JSON.parse(line);
                                    console.log("===== Glean stream chunk:", data);
                                    
                                    // Extract text content from Glean response structure
                                    if (data.messages) {
                                        for (const message of data.messages) {
                                            if (message.messageType === "CONTENT" && message.fragments) {
                                                for (const fragment of message.fragments) {
                                                    if (fragment.text) {
                                                        this.state.currentResponse += fragment.text;
                                                        fullResponse += fragment.text;
                                                        this._broadcastState();
                                                    }
                                                }
                                            }
                                        }
                                    }
                                } catch (parseError) {
                                    console.warn("===== Failed to parse Glean stream chunk:", line, parseError);
                                }
                            }
                        }

                        // Check if we should abort
                        if (signal.aborted) {
                            gleanReader.cancel();
                            throw new Error('Request aborted by user.');
                        }
                    }

                    // Process any remaining buffer content
                    if (buffer.trim()) {
                        try {
                            const data = JSON.parse(buffer.trim());
                            if (data.messages) {
                                for (const message of data.messages) {
                                    if (message.messageType === "CONTENT" && message.fragments) {
                                        for (const fragment of message.fragments) {
                                            if (fragment.text) {
                                                this.state.currentResponse += fragment.text;
                                                fullResponse += fragment.text;
                                                this._broadcastState();
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (parseError) {
                            console.warn("===== Failed to parse final Glean buffer:", buffer, parseError);
                        }
                    }

                } finally {
                    gleanReader.releaseLock();
                }

                console.log("===== Final Glean response:", this.state.currentResponse);
                
                    clearInterval(thinkingTicker);
                // Set final state - streaming complete
                this.state = {
                    ...this.state,
                    isStreaming: false,
                    isLoading: false,
                };
                this._broadcastState();
                })
            }

        } catch (streamError) {
            if (signal.aborted) {
                console.log(`[AskService] Stream reading was intentionally cancelled. Reason: ${signal.reason}`);
            } else {
                console.error('[AskService] Error while processing stream:', streamError);
                if (askWin && !askWin.isDestroyed()) {
                    askWin.webContents.send('ask-response-stream-error', { error: streamError.message });
                }
            }
        } finally {
            this.state.isStreaming = false;
            this.state.currentResponse = fullResponse;
            this._broadcastState();
            if (fullResponse) {
                try {
                    await askRepository.addAiMessage({ sessionId, role: 'assistant', content: fullResponse });
                    console.log(`[AskService] DB: Saved partial or full assistant response to session ${sessionId} after stream ended.`);
                } catch (dbError) {
                    console.error("[AskService] DB: Failed to save assistant response after stream ended:", dbError);
                }
            }
        }
    }

    /**
     * 멀티모달 관련 에러인지 판단
     * @private
     */
    _isMultimodalError(error) {
        const errorMessage = error.message?.toLowerCase() || '';
        return (
            errorMessage.includes('vision') ||
            errorMessage.includes('image') ||
            errorMessage.includes('multimodal') ||
            errorMessage.includes('unsupported') ||
            errorMessage.includes('image_url') ||
            errorMessage.includes('400') ||  // Bad Request often for unsupported features
            errorMessage.includes('invalid') ||
            errorMessage.includes('not supported')
        );
    }

}

const askService = new AskService();

module.exports = askService;
