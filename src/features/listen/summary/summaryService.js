const { BrowserWindow } = require('electron');
const { getSystemPrompt } = require('../../common/prompts/promptBuilder.js');
const { createLLM } = require('../../common/ai/factory');
const sessionRepository = require('../../common/repositories/session');
const summaryRepository = require('./repositories');
const modelStateService = require('../../common/services/modelStateService');

class SummaryService {
    constructor() {
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        this.conversationHistory = [];
        this.currentSessionId = null;
        
        // Callbacks
        this.onAnalysisComplete = null;
        this.onStatusUpdate = null;
    }

    setCallbacks({ onAnalysisComplete, onStatusUpdate }) {
        this.onAnalysisComplete = onAnalysisComplete;
        this.onStatusUpdate = onStatusUpdate;
    }

    setSessionId(sessionId) {
        this.currentSessionId = sessionId;
    }

    sendToRenderer(channel, data) {
        const { windowPool } = require('../../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    addConversationTurn(speaker, text) {
        const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
        this.conversationHistory.push(conversationText);
        console.log(`💬 Added conversation text: ${conversationText}`);
        console.log(`📈 Total conversation history: ${this.conversationHistory.length} texts`);

        // Trigger analysis if needed
        this.triggerAnalysisIfNeeded();
    }

    getConversationHistory() {
        return this.conversationHistory;
    }

    resetConversationHistory() {
        this.conversationHistory = [];
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        console.log('🔄 Conversation history and analysis state reset');
    }

    /**
     * Converts conversation history into text to include in the prompt.
     * @param {Array<string>} conversationTexts - Array of conversation texts ["me: ~~~", "them: ~~~", ...]
     * @param {number} maxTurns - Maximum number of recent turns to include
     * @returns {string} - Formatted conversation string for the prompt
     */
    formatConversationForPrompt(conversationTexts, maxTurns = 30) {
        if (conversationTexts.length === 0) return '';
        return conversationTexts.slice(-maxTurns).join('\n');
    }

    async makeOutlineAndRequests(conversationTexts, maxTurns = 30) {
        console.log(`🔍 makeOutlineAndRequests called - conversationTexts: ${conversationTexts.length}`);

        if (conversationTexts.length === 0) {
            console.log('⚠️ No conversation texts available for analysis');
            return null;
        }

        try {
            if (this.currentSessionId) {
                await sessionRepository.touch(this.currentSessionId);
            }

            // Simple placeholder response since Glean insights have been moved to hover functionality
            const structuredData = {
                summary: ['Hover over messages in the transcript to get detailed insights'],
                topic: { 
                    header: 'Interactive Insights Available', 
                    bullets: ['Hover over any message to see contextual information'] 
                },
                actions: [],
                followUps: []
            };

            if (this.currentSessionId) {
                try {
                    summaryRepository.saveSummary({
                        sessionId: this.currentSessionId,
                        text: 'Interactive insights available via hover',
                        tldr: 'Interactive insights available via hover',
                        bullet_json: JSON.stringify([]), // Empty bullets
                        action_json: JSON.stringify([]), // Empty actions
                        model: 'interactive'
                    });
                } catch (err) {
                    console.error('[DB] Failed to save summary:', err);
                }
            }

            // Store analysis result
            this.previousAnalysisResult = structuredData;
            this.analysisHistory.push({
                timestamp: Date.now(),
                data: structuredData,
                conversationLength: conversationTexts.length,
            });

            if (this.analysisHistory.length > 10) {
                this.analysisHistory.shift();
            }

            return structuredData;
        } catch (error) {
            console.error('❌ Error during analysis generation:', error.message);
            return this.previousAnalysisResult || {
                summary: ['Interactive insights available via hover'],
                topic: { header: 'Interactive Insights Available', bullets: [] },
                actions: [],
                followUps: []
            };
        }
    }

    parseResponseText(responseText, previousResult) {
        const structuredData = {
            summary: [responseText], // Just display the raw response
            topic: { header: 'Response', bullets: [] },
            actions: [], // Empty actions array
            followUps: [], // Empty followUps array
        };

        console.log('📊 Raw response data:', responseText);
        return structuredData;
    }

    /**
     * Triggers analysis when conversation history reaches a certain threshold.
     * Now shows placeholder text encouraging hover interaction.
     */
    async triggerAnalysisIfNeeded() {
        console.log('🔍 triggerAnalysisIfNeeded called - conversationHistory:', this.conversationHistory);
        const maxTurns = 5; // Show message every 5 turns 
        if (this.conversationHistory.length >= maxTurns && this.conversationHistory.length % maxTurns === 0) {
            console.log(`Triggering placeholder analysis - ${this.conversationHistory.length} conversation texts accumulated`);

            const data = await this.makeOutlineAndRequests(this.conversationHistory);
            if (data) {
                console.log('Sending placeholder message to renderer');
                this.sendToRenderer('summary-update', data);
                
                // Notify callback
                if (this.onAnalysisComplete) {
                    this.onAnalysisComplete(data);
                }
            } else {
                console.log('No analysis data returned');
            }
        }
    }

    getCurrentAnalysisData() {
        return {
            previousResult: this.previousAnalysisResult,
            history: this.analysisHistory,
            conversationLength: this.conversationHistory.length,
        };
    }
}

module.exports = SummaryService; 