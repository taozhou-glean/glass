import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class SttView extends LitElement {
    static styles = css`
        :host {
            display: block;
            width: 100%;
        }

        /* Inherit font styles from parent */

        .transcription-container {
            overflow-y: auto;
            padding: 12px 12px 16px 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            min-height: 150px;
            max-height: 600px;
            position: relative;
            z-index: 1;
            flex: 1;
        }

        /* Visibility handled by parent component */

        .transcription-container::-webkit-scrollbar {
            width: 8px;
        }
        .transcription-container::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.1);
            border-radius: 4px;
        }
        .transcription-container::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 4px;
        }
        .transcription-container::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.5);
        }

        .stt-message {
            padding: 8px 12px;
            border-radius: 12px;
            max-width: 80%;
            word-wrap: break-word;
            word-break: break-word;
            line-height: 1.5;
            font-size: 13px;
            margin-bottom: 4px;
            box-sizing: border-box;
        }

        .stt-message.them {
            background: rgba(255, 255, 255, 0.1);
            color: rgba(255, 255, 255, 0.9);
            align-self: flex-start;
            border-bottom-left-radius: 4px;
            margin-right: auto;
        }

        .stt-message.me {
            background: rgba(0, 122, 255, 0.8);
            color: white;
            align-self: flex-end;
            border-bottom-right-radius: 4px;
            margin-left: auto;
        }

        .empty-state {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100px;
            color: rgba(255, 255, 255, 0.6);
            font-size: 12px;
            font-style: italic;
        }

        /* Hover button styles */
        .stt-message.them.hoverable {
            position: relative;
            transition: background-color 0.2s ease;
        }

        .stt-message.them.hoverable:hover {
            background: rgba(255, 255, 255, 0.15);
        }

        .ask-button {
            position: absolute;
            top: 50%;
            right: 8px;
            transform: translateY(-50%);
            background: rgba(0, 122, 255, 0.9);
            color: white;
            border: none;
            border-radius: 12px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 500;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s ease, background-color 0.2s ease;
            z-index: 100;
            pointer-events: none;
            user-select: none;
        }

        .stt-message.them.hoverable:hover .ask-button {
            opacity: 1;
            pointer-events: auto;
        }

        .ask-button:hover {
            background: rgba(0, 122, 255, 1);
        }

        .ask-button:active {
            transform: translateY(-50%) scale(0.95);
        }
    `;

    static properties = {
        sttMessages: { type: Array },
        isVisible: { type: Boolean },
    };

    constructor() {
        super();
        this.sttMessages = [];
        this.isVisible = true;
        this.messageIdCounter = 0;
        this._shouldScrollAfterUpdate = false;

        this.handleSttUpdate = this.handleSttUpdate.bind(this);
    }

    connectedCallback() {
        super.connectedCallback();
        if (window.api) {
            window.api.sttView.onSttUpdate(this.handleSttUpdate);
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        if (window.api) {
            window.api.sttView.removeOnSttUpdate(this.handleSttUpdate);
        }
    }

    // Handle session reset from parent
    resetTranscript() {
        this.sttMessages = [];
        this.requestUpdate();
    }

    handleSttUpdate(event, { speaker, text, isFinal, isPartial }) {
        if (text === undefined) return;

        const container = this.shadowRoot.querySelector('.transcription-container');
        this._shouldScrollAfterUpdate = container ? container.scrollTop + container.clientHeight >= container.scrollHeight - 10 : false;

        const findLastPartialIdx = spk => {
            for (let i = this.sttMessages.length - 1; i >= 0; i--) {
                const m = this.sttMessages[i];
                if (m.speaker === spk && m.isPartial) return i;
            }
            return -1;
        };

        const newMessages = [...this.sttMessages];
        const targetIdx = findLastPartialIdx(speaker);

        if (isPartial) {
            if (targetIdx !== -1) {
                newMessages[targetIdx] = {
                    ...newMessages[targetIdx],
                    text,
                    isPartial: true,
                    isFinal: false,
                };
            } else {
                newMessages.push({
                    id: this.messageIdCounter++,
                    speaker,
                    text,
                    isPartial: true,
                    isFinal: false,
                });
            }
        } else if (isFinal) {
            if (targetIdx !== -1) {
                newMessages[targetIdx] = {
                    ...newMessages[targetIdx],
                    text,
                    isPartial: false,
                    isFinal: true,
                };
            } else {
                newMessages.push({
                    id: this.messageIdCounter++,
                    speaker,
                    text,
                    isPartial: false,
                    isFinal: true,
                });
            }
        }

        this.sttMessages = newMessages;
        
        // Notify parent component about message updates
        this.dispatchEvent(new CustomEvent('stt-messages-updated', {
            detail: { messages: this.sttMessages },
            bubbles: true
        }));
    }

    scrollToBottom() {
        setTimeout(() => {
            const container = this.shadowRoot.querySelector('.transcription-container');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }, 0);
    }

    getSpeakerClass(speaker) {
        return speaker.toLowerCase() === 'me' ? 'me' : 'them';
    }

    getTranscriptText() {
        return this.sttMessages.map(msg => `${msg.speaker}: ${msg.text}`).join('\n');
    }

    // Ask button methods
    async handleAskButtonClick(messageText, event) {
        event.stopPropagation();
        console.log('🔥 Ask button clicked for message:', messageText);

        if (window.api && window.api.askView && window.api.askView.sendMessage) {
            try {
                // Skip screenshot since we're asking about a specific transcript message
                const result = await window.api.askView.sendMessage(messageText, { skipScreenshot: true });
                if (result.success) {
                    console.log('✅ Message sent to Ask view successfully (without screenshot)');
                } else {
                    console.error('❌ Failed to send message to Ask view:', result.error);
                }
            } catch (error) {
                console.error('❌ Error sending message to Ask view:', error);
            }
        } else {
            console.error('❌ Ask view API not available');
        }
    }

    isThemMessage(speaker) {
        return speaker.toLowerCase() === 'them';
    }

    updated(changedProperties) {
        super.updated(changedProperties);

        if (changedProperties.has('sttMessages')) {
            if (this._shouldScrollAfterUpdate) {
                this.scrollToBottom();
                this._shouldScrollAfterUpdate = false;
            }
        }
    }

    render() {
        if (!this.isVisible) {
            return html`<div style="display: none;"></div>`;
        }

        return html`
            <div class="transcription-container">
                ${this.sttMessages.length === 0
                    ? html`<div class="empty-state">Waiting for speech...</div>`
                    : this.sttMessages.map(msg => html`
                        <div class="stt-message ${this.getSpeakerClass(msg.speaker)} ${this.isThemMessage(msg.speaker) && msg.isFinal ? 'hoverable' : ''}">
                            ${msg.text}
                            ${this.isThemMessage(msg.speaker) && msg.isFinal ? 
                                html`<button class="ask-button" @click=${(e) => this.handleAskButtonClick(msg.text, e)}>
                                    Ask
                                </button>` : ''}
                        </div>
                    `)
                }
            </div>
        `;
    }
}

customElements.define('stt-view', SttView); 