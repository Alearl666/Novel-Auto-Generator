/**
 * TXT to Worldbook Converter for SillyTavern
 * Converts TXT novel text to SillyTavern World Info format
 * 
 * Features:
 * - Uses SillyTavern's own API settings
 * - Real-time output display
 * - Smart memory splitting (only splits failed chunks)
 * - Multi-layer JSON parsing with fallback
 * - History tracking and rollback
 * - AI-powered worldbook optimization
 */

(function() {
    'use strict';

    // ========== Global State ==========
    let generatedWorldbook = {};
    let memoryQueue = [];
    let failedMemoryQueue = [];
    let currentFile = null;
    let currentFileHash = null;
    let isProcessingStopped = false;
    let isRepairingMemories = false;
    let currentProcessingIndex = 0;
    let incrementalOutputMode = true;
    let currentStreamContent = '';

    // ========== Default Settings ==========
    const defaultWorldbookPrompt = `You are a professional novel worldbook generation expert. Please carefully read the provided novel content, extract key information, and generate high-quality worldbook entries.

## Important Requirements
1. **Must be based on the specific novel content provided**, do not generate generic templates
2. **Only extract characters, locations, organizations etc. that explicitly appear in the text**
3. **Keywords must be actual names from the text**, separated by commas
4. **Content must be based on original descriptions**, do not add information not in the original
5. **Content uses markdown format**, can be nested or use numbered headings

## Output Format
Please generate standard JSON format that can be correctly parsed by JavaScript:

\`\`\`json
{
"Characters": {
"Character Real Name": {
"keywords": ["real name", "title1", "title2", "nickname"],
"content": "Character description based on original text, including but not limited to **Name**: (required), **Gender**:, **MBTI (required, explain changes if any)**:, **Apparent Age**:, **Age**:, **Identity**:, **Background**:, **Personality**:, **Appearance**:, **Skills**:, **Important Events**:, **Speech Examples**:, **Weaknesses**:, **Backstory**: etc."
}
},
"Locations": {
"Location Real Name": {
"keywords": ["location name", "alias", "common name"],
"content": "Location description based on original text, including but not limited to **Name**: (required), **Position**:, **Features**:, **Important Events**: etc."
}
},
"Organizations": {
"Organization Real Name": {
"keywords": ["org name", "abbreviation", "code name"],
"content": "Organization description based on original text, including but not limited to **Name**: (required), **Nature**:, **Members**:, **Goals**: etc."
}
}
}
\`\`\`

## Important Reminders
- Output JSON directly, do not include code block markers
- All information must come from the original text, do not fabricate
- Keywords must be words actually appearing in the text
- Content descriptions should be complete but concise`;

    const defaultPlotPrompt = `"PlotOutline": {
"MainPlot": {
"keywords": ["main plot", "core story", "storyline"],
"content": "## Main Story\\n**Core Conflict**: Central contradiction of the story\\n**Main Goal**: Protagonist's objective\\n**Obstacles**: Barriers to achieving the goal\\n\\n## Plot Stages\\n**Act 1 - Beginning**: Story opening, world building\\n**Act 2 - Development**: Escalating conflict, character growth\\n**Act 3 - Climax**: Final confrontation, conflict eruption\\n**Act 4 - Resolution**: [if completed] Story ending\\n\\n## Key Turning Points\\n1. **Turning Point 1**: Description and impact\\n2. **Turning Point 2**: Description and impact"
},
"Subplots": {
"keywords": ["subplot", "side story", "branch plot"],
"content": "## Main Subplots\\n**Subplot 1 Title**: Brief description\\n**Subplot 2 Title**: Brief description\\n\\n## Connection to Main Plot\\n**Intersection Points**: How subplots affect main plot"
}
}`;

    const defaultStylePrompt = `"WritingStyle": {
"Style": {
"keywords": ["writing style", "narrative style", "storytelling"],
"content": "## Narrative Perspective\\n**Perspective Type**: First person/Third person/Omniscient\\n**Narrator Traits**: Tone and attitude of narrator\\n\\n## Language Style\\n**Word Choice**: Elaborate/Concise/Colloquial/Formal\\n**Sentence Style**: Long/Short/Dialogue-heavy/Description-heavy\\n**Rhetoric**: Common rhetorical devices used\\n\\n## Emotional Tone\\n**Overall Atmosphere**: Light/Heavy/Suspenseful/Romantic\\n**Emotional Expression**: Direct/Subtle/Delicate/Bold"
}
}`;

    const defaultSettings = {
        useSTSettings: true,
        apiProvider: 'gemini',
        apiKey: '',
        apiEndpoint: '',
        apiModel: 'gemini-2.5-flash',
        chunkSize: 100000,
        enablePlotOutline: false,
        enableLiteraryStyle: false,
        language: 'zh',
        customWorldbookPrompt: '',
        customPlotPrompt: '',
        customStylePrompt: ''
    };

    let settings = { ...defaultSettings };

    // ========== SillyTavern API Integration ==========
    function getSTAPISettings() {
        try {
            // Try to get SillyTavern's API settings
            if (typeof window.SillyTavern !== 'undefined' && window.SillyTavern.getContext) {
                const context = window.SillyTavern.getContext();
                return {
                    apiKey: context.api_key || '',
                    apiEndpoint: context.api_server || '',
                    apiModel: context.model || '',
                    apiProvider: context.main_api || 'openai'
                };
            }
            
            // Fallback: try to access global variables
            if (typeof window.api_key !== 'undefined') {
                return {
                    apiKey: window.api_key || '',
                    apiEndpoint: window.api_server || window.oai_settings?.reverse_proxy || '',
                    apiModel: window.model_list?.[0] || window.oai_settings?.openai_model || '',
                    apiProvider: window.main_api || 'openai'
                };
            }

            // Try to get from oai_settings
            if (typeof window.oai_settings !== 'undefined') {
                return {
                    apiKey: window.oai_settings.api_key || window.oai_settings.api_key_openai || '',
                    apiEndpoint: window.oai_settings.reverse_proxy || window.oai_settings.chat_completion_source || '',
                    apiModel: window.oai_settings.openai_model || window.oai_settings.claude_model || '',
                    apiProvider: window.oai_settings.chat_completion_source || 'openai'
                };
            }

            // Try module exports
            if (typeof window.getRequestHeaders === 'function') {
                const headers = window.getRequestHeaders();
                return {
                    apiKey: headers.Authorization?.replace('Bearer ', '') || '',
                    apiEndpoint: window.api_server || '',
                    apiModel: window.selected_model || '',
                    apiProvider: window.main_api || 'openai'
                };
            }

            return null;
        } catch (error) {
            console.error('Failed to get ST API settings:', error);
            return null;
        }
    }

    function applySTSettings() {
        const stSettings = getSTAPISettings();
        if (stSettings) {
            console.log('📡 Detected SillyTavern API settings:', stSettings);
            if (stSettings.apiKey) settings.apiKey = stSettings.apiKey;
            if (stSettings.apiEndpoint) settings.apiEndpoint = stSettings.apiEndpoint;
            if (stSettings.apiModel) settings.apiModel = stSettings.apiModel;
            if (stSettings.apiProvider) {
                // Map ST API types to our provider types
                const providerMap = {
                    'openai': 'openai-compatible',
                    'claude': 'openai-compatible',
                    'google': 'gemini',
                    'kobold': 'openai-compatible',
                    'novel': 'openai-compatible',
                    'textgenerationwebui': 'openai-compatible'
                };
                settings.apiProvider = providerMap[stSettings.apiProvider] || 'openai-compatible';
            }
            return true;
        }
        return false;
    }

    // ========== IndexedDB Persistence ==========
    const MemoryHistoryDB = {
        dbName: 'TxtToWorldbookDB',
        storeName: 'history',
        metaStoreName: 'meta',
        stateStoreName: 'state',
        db: null,

        async openDB() {
            if (this.db) return this.db;
            
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(this.dbName, 3);
                
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(this.storeName)) {
                        const store = db.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
                        store.createIndex('timestamp', 'timestamp', { unique: false });
                        store.createIndex('memoryIndex', 'memoryIndex', { unique: false });
                    }
                    if (!db.objectStoreNames.contains(this.metaStoreName)) {
                        db.createObjectStore(this.metaStoreName, { keyPath: 'key' });
                    }
                    if (!db.objectStoreNames.contains(this.stateStoreName)) {
                        db.createObjectStore(this.stateStoreName, { keyPath: 'key' });
                    }
                };
                
                request.onsuccess = (event) => {
                    this.db = event.target.result;
                    resolve(this.db);
                };
                
                request.onerror = (event) => {
                    reject(event.target.error);
                };
            });
        },

        async saveHistory(memoryIndex, memoryTitle, previousWorldbook, newWorldbook, changedEntries) {
            const db = await this.openDB();
            
            const allowedDuplicates = ['Memory-Optimize', 'Memory-Evolution-Summary'];
            if (!allowedDuplicates.includes(memoryTitle)) {
                try {
                    const allHistory = await this.getAllHistory();
                    const duplicates = allHistory.filter(h => h.memoryTitle === memoryTitle);
                    
                    if (duplicates.length > 0) {
                        console.log(`🗑️ Deleting ${duplicates.length} duplicate records: "${memoryTitle}"`);
                        const deleteTransaction = db.transaction([this.storeName], 'readwrite');
                        const deleteStore = deleteTransaction.objectStore(this.storeName);
                        
                        for (const dup of duplicates) {
                            deleteStore.delete(dup.id);
                        }
                        
                        await new Promise((resolve, reject) => {
                            deleteTransaction.oncomplete = () => resolve();
                            deleteTransaction.onerror = () => reject(deleteTransaction.error);
                        });
                    }
                } catch (error) {
                    console.error('Failed to delete duplicate history:', error);
                }
            }
            
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                
                const record = {
                    timestamp: Date.now(),
                    memoryIndex: memoryIndex,
                    memoryTitle: memoryTitle,
                    previousWorldbook: JSON.parse(JSON.stringify(previousWorldbook || {})),
                    newWorldbook: JSON.parse(JSON.stringify(newWorldbook || {})),
                    changedEntries: changedEntries || [],
                    fileHash: currentFileHash || null
                };
                
                const request = store.add(record);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        },

        async getAllHistory() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.getAll();
                
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });
        },

        async getHistoryById(id) {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.get(id);
                
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        },

        async clearAllHistory() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.clear();
                
                request.onsuccess = () => {
                    console.log('📚 Memory history cleared');
                    resolve();
                };
                request.onerror = () => reject(request.error);
            });
        },

        async saveFileHash(hash) {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.metaStoreName], 'readwrite');
                const store = transaction.objectStore(this.metaStoreName);
                const request = store.put({ key: 'currentFileHash', value: hash });
                
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        },

        async getSavedFileHash() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.metaStoreName], 'readonly');
                const store = transaction.objectStore(this.metaStoreName);
                const request = store.get('currentFileHash');
                
                request.onsuccess = () => resolve(request.result?.value || null);
                request.onerror = () => reject(request.error);
            });
        },

        async saveState(processedIndex) {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.stateStoreName], 'readwrite');
                const store = transaction.objectStore(this.stateStoreName);
                
                const state = {
                    key: 'currentState',
                    processedIndex: processedIndex,
                    memoryQueue: JSON.parse(JSON.stringify(memoryQueue)),
                    generatedWorldbook: JSON.parse(JSON.stringify(generatedWorldbook)),
                    fileHash: currentFileHash,
                    timestamp: Date.now()
                };
                
                const request = store.put(state);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        },

        async loadState() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.stateStoreName], 'readonly');
                const store = transaction.objectStore(this.stateStoreName);
                const request = store.get('currentState');
                
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => reject(request.error);
            });
        },

        async clearState() {
            const db = await this.openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.stateStoreName], 'readwrite');
                const store = transaction.objectStore(this.stateStoreName);
                const request = store.delete('currentState');
                
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        },

        async rollbackToHistory(historyId) {
            const history = await this.getHistoryById(historyId);
            if (!history) {
                throw new Error('History record not found');
            }
            
            generatedWorldbook = JSON.parse(JSON.stringify(history.previousWorldbook));
            
            const db = await this.openDB();
            const allHistory = await this.getAllHistory();
            const toDelete = allHistory.filter(h => h.id >= historyId);
            
            const transaction = db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            
            for (const h of toDelete) {
                store.delete(h.id);
            }
            
            return history;
        },

        async cleanDuplicateHistory() {
            const db = await this.openDB();
            const allHistory = await this.getAllHistory();
            const allowedDuplicates = ['Memory-Optimize', 'Memory-Evolution-Summary'];
            
            const groupedByTitle = {};
            for (const record of allHistory) {
                const title = record.memoryTitle;
                if (!groupedByTitle[title]) {
                    groupedByTitle[title] = [];
                }
                groupedByTitle[title].push(record);
            }
            
            const toDelete = [];
            for (const title in groupedByTitle) {
                if (allowedDuplicates.includes(title)) continue;
                
                const records = groupedByTitle[title];
                if (records.length > 1) {
                    records.sort((a, b) => b.timestamp - a.timestamp);
                    toDelete.push(...records.slice(1));
                }
            }
            
            if (toDelete.length > 0) {
                console.log(`🗑️ Cleaning ${toDelete.length} duplicate history records`);
                const transaction = db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                
                for (const record of toDelete) {
                    store.delete(record.id);
                }
                
                await new Promise((resolve, reject) => {
                    transaction.oncomplete = () => resolve();
                    transaction.onerror = () => reject(transaction.error);
                });
                
                return toDelete.length;
            }
            
            return 0;
        }
    };

    // ========== Utility Functions ==========
    async function calculateFileHash(content) {
        const encoder = new TextEncoder();
        const data = encoder.encode(content);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function getLanguagePrefix() {
        return settings.language === 'zh' ? '请用中文回复。\n\n' : '';
    }

    // ========== File Encoding Detection ==========
    async function detectBestEncoding(file) {
        const encodings = ['UTF-8', 'GBK', 'GB2312', 'GB18030', 'Big5'];
        
        for (const encoding of encodings) {
            try {
                const content = await readFileWithEncoding(file, encoding);
                if (!content.includes('�') && !content.includes('\uFFFD')) {
                    return { encoding, content };
                }
            } catch (e) {
                continue;
            }
        }
        
        const content = await readFileWithEncoding(file, 'UTF-8');
        return { encoding: 'UTF-8', content };
    }

    function readFileWithEncoding(file, encoding) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file, encoding);
        });
    }

    // ========== Real-time Output Display ==========
    function updateStreamOutput(content, append = true) {
        const streamContainer = document.getElementById('ttw-stream-output');
        if (!streamContainer) return;
        
        if (append) {
            currentStreamContent += content;
        } else {
            currentStreamContent = content;
        }
        
        // Escape HTML and format
        let displayContent = currentStreamContent
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
        
        streamContainer.innerHTML = displayContent;
        streamContainer.scrollTop = streamContainer.scrollHeight;
    }

    function clearStreamOutput() {
        currentStreamContent = '';
        const streamContainer = document.getElementById('ttw-stream-output');
        if (streamContainer) {
            streamContainer.innerHTML = '<span style="color: #888;">Waiting for API response...</span>';
        }
    }

    // ========== API Call ==========
    async function callAPI(prompt, retryCount = 0) {
        const maxRetries = 3;
        let requestUrl, requestOptions;

        // If using ST settings, try to apply them first
        if (settings.useSTSettings) {
            applySTSettings();
        }

        clearStreamOutput();
        updateStreamOutput('📤 Sending request to API...\n\n', false);

        switch (settings.apiProvider) {
            case 'deepseek':
                if (!settings.apiKey) throw new Error('DeepSeek API Key not set');
                requestUrl = 'https://api.deepseek.com/chat/completions';
                requestOptions = {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json', 
                        'Authorization': `Bearer ${settings.apiKey}` 
                    },
                    body: JSON.stringify({ 
                        model: 'deepseek-chat', 
                        messages: [{ role: 'user', content: prompt }], 
                        temperature: 0.3, 
                        max_tokens: 8192
                    }),
                };
                break;
                
            case 'gemini':
                if (!settings.apiKey) throw new Error('Gemini API Key not set');
                const geminiModel = settings.apiModel || 'gemini-2.5-flash';
                requestUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${settings.apiKey}`;
                requestOptions = {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { maxOutputTokens: 63000, temperature: 0.3 },
                        safetySettings: [
                            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
                            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
                            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
                            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }
                        ]
                    }),
                };
                break;
                
            case 'gemini-proxy':
                if (!settings.apiEndpoint) throw new Error('Gemini Proxy Endpoint not set');
                if (!settings.apiKey) throw new Error('Gemini Proxy API Key not set');
                
                let proxyBaseUrl = settings.apiEndpoint;
                if (!proxyBaseUrl.startsWith('http')) proxyBaseUrl = 'https://' + proxyBaseUrl;
                if (proxyBaseUrl.endsWith('/')) proxyBaseUrl = proxyBaseUrl.slice(0, -1);
                
                const geminiProxyModel = settings.apiModel || 'gemini-2.5-flash';
                const useOpenAIFormat = proxyBaseUrl.endsWith('/v1');
                
                if (useOpenAIFormat) {
                    requestUrl = proxyBaseUrl + '/chat/completions';
                    requestOptions = {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${settings.apiKey}`
                        },
                        body: JSON.stringify({
                            model: geminiProxyModel,
                            messages: [{ role: 'user', content: prompt }],
                            temperature: 0.3,
                            max_tokens: 63000
                        }),
                    };
                } else {
                    const finalProxyUrl = `${proxyBaseUrl}/${geminiProxyModel}:generateContent`;
                    requestUrl = finalProxyUrl.includes('?') 
                        ? `${finalProxyUrl}&key=${settings.apiKey}`
                        : `${finalProxyUrl}?key=${settings.apiKey}`;
                    requestOptions = {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig: { maxOutputTokens: 63000, temperature: 0.3 }
                        }),
                    };
                }
                break;
                
            case 'openai-compatible':
            default:
                let openaiEndpoint = settings.apiEndpoint || 'http://127.0.0.1:5000/v1/chat/completions';
                const model = settings.apiModel || 'local-model';

                if (!openaiEndpoint.includes('/chat/completions')) {
                    if (openaiEndpoint.endsWith('/v1')) {
                        openaiEndpoint += '/chat/completions';
                    } else {
                        openaiEndpoint = openaiEndpoint.replace(/\/$/, '') + '/chat/completions';
                    }
                }

                if (!openaiEndpoint.startsWith('http')) {
                    openaiEndpoint = 'http://' + openaiEndpoint;
                }

                requestUrl = openaiEndpoint;
                const headers = { 'Content-Type': 'application/json' };
                if (settings.apiKey) {
                    headers['Authorization'] = `Bearer ${settings.apiKey}`;
                }

                requestOptions = {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({
                        model: model,
                        messages: [{ role: 'user', content: prompt }],
                        temperature: 0.3,
                        max_tokens: 63000
                    }),
                };
                break;
        }

        try {
            updateStreamOutput(`📡 Request URL: ${requestUrl}\n📋 Model: ${settings.apiModel || 'default'}\n\n`, false);
            
            const response = await fetch(requestUrl, requestOptions);
            
            if (!response.ok) {
                const errorText = await response.text();
                console.log('API Error Response:', errorText);
                updateStreamOutput(`\n❌ API Error: ${response.status}\n${errorText}`, true);
                
                if (response.status === 429 || errorText.includes('resource_exhausted') || errorText.includes('rate limit')) {
                    if (retryCount < maxRetries) {
                        const delay = Math.pow(2, retryCount) * 1000;
                        console.log(`Rate limited, retrying in ${delay}ms (${retryCount + 1}/${maxRetries})`);
                        updateStreamOutput(`\n⏳ Rate limited, retrying in ${delay/1000}s...`, true);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        return callAPI(prompt, retryCount + 1);
                    } else {
                        throw new Error(`API rate limit: max retries reached`);
                    }
                }
                
                throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
            }
            
            const data = await response.json();
            let responseText = '';
            
            // Parse different response formats
            if (settings.apiProvider === 'gemini') {
                responseText = data.candidates[0].content.parts[0].text;
            } else if (settings.apiProvider === 'gemini-proxy') {
                if (data.candidates) {
                    responseText = data.candidates[0].content.parts[0].text;
                } else if (data.choices) {
                    responseText = data.choices[0].message.content;
                }
            } else {
                responseText = data.choices[0].message.content;
            }
            
            if (!responseText) {
                throw new Error('Unknown API response format');
            }
            
            updateStreamOutput(`📥 Response received (${responseText.length} chars):\n\n${responseText}`, false);
            
            return responseText;
            
        } catch (networkError) {
            updateStreamOutput(`\n❌ Error: ${networkError.message}`, true);
            if (networkError.message.includes('fetch')) {
                throw new Error('Network connection failed, please check network settings');
            }
            throw networkError;
        }
    }

    // ========== Fetch Model List ==========
    async function fetchModelList() {
        const endpoint = settings.apiEndpoint || '';
        if (!endpoint) {
            throw new Error('Please set API Endpoint first');
        }

        let modelsUrl = endpoint;
        if (modelsUrl.endsWith('/chat/completions')) {
            modelsUrl = modelsUrl.replace('/chat/completions', '/models');
        } else if (modelsUrl.endsWith('/v1')) {
            modelsUrl = modelsUrl + '/models';
        } else if (!modelsUrl.endsWith('/models')) {
            modelsUrl = modelsUrl.replace(/\/$/, '') + '/models';
        }

        if (!modelsUrl.startsWith('http')) {
            modelsUrl = 'http://' + modelsUrl;
        }

        const headers = { 'Content-Type': 'application/json' };
        if (settings.apiKey) {
            headers['Authorization'] = `Bearer ${settings.apiKey}`;
        }

        console.log('📤 Fetching model list:', modelsUrl);

        const response = await fetch(modelsUrl, {
            method: 'GET',
            headers: headers
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch model list: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log('📥 Model list response:', data);

        let models = [];
        if (data.data && Array.isArray(data.data)) {
            models = data.data.map(m => m.id || m.name || m);
        } else if (Array.isArray(data)) {
            models = data.map(m => typeof m === 'string' ? m : (m.id || m.name || m));
        } else if (data.models && Array.isArray(data.models)) {
            models = data.models.map(m => typeof m === 'string' ? m : (m.id || m.name || m));
        }

        return models;
    }

    // ========== Quick Test ==========
    async function quickTestModel() {
        const endpoint = settings.apiEndpoint || '';
        const model = settings.apiModel || '';

        if (!endpoint) {
            throw new Error('Please set API Endpoint first');
        }
        if (!model) {
            throw new Error('Please set model name first');
        }

        let requestUrl = endpoint;
        if (!requestUrl.includes('/chat/completions')) {
            if (requestUrl.endsWith('/v1')) {
                requestUrl += '/chat/completions';
            } else {
                requestUrl = requestUrl.replace(/\/$/, '') + '/chat/completions';
            }
        }

        if (!requestUrl.startsWith('http')) {
            requestUrl = 'http://' + requestUrl;
        }

        const headers = { 'Content-Type': 'application/json' };
        if (settings.apiKey) {
            headers['Authorization'] = `Bearer ${settings.apiKey}`;
        }

        console.log('📤 Quick test:', requestUrl, 'Model:', model);

        const startTime = Date.now();

        const response = await fetch(requestUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                model: model,
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 50
            })
        });

        const elapsed = Date.now() - startTime;

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Test failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log('📥 Test response:', data);

        let responseText = '';
        if (data.choices && data.choices[0]) {
            responseText = data.choices[0].message?.content || data.choices[0].text || '';
        }

        if (!responseText || responseText.trim() === '') {
            throw new Error('API returned empty response, please check model configuration');
        }

        return {
            success: true,
            elapsed: elapsed,
            response: responseText.substring(0, 100)
        };
    }

    // ========== Worldbook Data Processing ==========
    function normalizeWorldbookEntry(entry) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        
        // Handle both Chinese and English field names
        if (entry.content !== undefined && entry['内容'] === undefined) {
            entry['内容'] = entry.content;
        }
        if (entry['内容'] !== undefined && entry.content === undefined) {
            entry.content = entry['内容'];
        }
        
        if (entry.keywords !== undefined && entry['关键词'] === undefined) {
            entry['关键词'] = entry.keywords;
        }
        if (entry['关键词'] !== undefined && entry.keywords === undefined) {
            entry.keywords = entry['关键词'];
        }
        
        return entry;
    }

    function normalizeWorldbookData(data) {
        if (!data || typeof data !== 'object') return data;
        
        for (const category in data) {
            if (typeof data[category] === 'object' && data[category] !== null && !Array.isArray(data[category])) {
                if (data[category]['关键词'] || data[category]['内容'] || data[category].content || data[category].keywords) {
                    normalizeWorldbookEntry(data[category]);
                } else {
                    for (const entryName in data[category]) {
                        if (typeof data[category][entryName] === 'object') {
                            normalizeWorldbookEntry(data[category][entryName]);
                        }
                    }
                }
            }
        }
        return data;
    }

    function mergeWorldbookData(target, source) {
        normalizeWorldbookData(source);

        for (const key in source) {
            if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
                if (!target[key]) target[key] = {};
                mergeWorldbookData(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
    }

    function mergeWorldbookDataIncremental(target, source) {
        normalizeWorldbookData(source);
        
        const stats = { updated: [], added: [] };
        
        for (const category in source) {
            if (typeof source[category] !== 'object' || source[category] === null) continue;
            
            if (!target[category]) {
                target[category] = {};
            }
            
            for (const entryName in source[category]) {
                const sourceEntry = source[category][entryName];
                
                if (typeof sourceEntry !== 'object' || sourceEntry === null) continue;
                
                if (target[category][entryName]) {
                    const targetEntry = target[category][entryName];
                    
                    // Merge keywords
                    const sourceKeywords = sourceEntry['关键词'] || sourceEntry.keywords || [];
                    const targetKeywords = targetEntry['关键词'] || targetEntry.keywords || [];
                    
                    if (Array.isArray(sourceKeywords) && Array.isArray(targetKeywords)) {
                        const mergedKeywords = [...new Set([...targetKeywords, ...sourceKeywords])];
                        targetEntry['关键词'] = mergedKeywords;
                        targetEntry.keywords = mergedKeywords;
                    } else if (Array.isArray(sourceKeywords)) {
                        targetEntry['关键词'] = sourceKeywords;
                        targetEntry.keywords = sourceKeywords;
                    }
                    
                    // Update content
                    const sourceContent = sourceEntry['内容'] || sourceEntry.content;
                    if (sourceContent) {
                        targetEntry['内容'] = sourceContent;
                        targetEntry.content = sourceContent;
                    }
                    
                    stats.updated.push(`[${category}] ${entryName}`);
                } else {
                    target[category][entryName] = sourceEntry;
                    stats.added.push(`[${category}] ${entryName}`);
                }
            }
        }
        
        if (stats.updated.length > 0) {
            console.log(`📝 Incrementally updated ${stats.updated.length} entries`);
        }
        if (stats.added.length > 0) {
            console.log(`➕ Incrementally added ${stats.added.length} entries`);
        }
    }

    function findChangedEntries(oldWorldbook, newWorldbook) {
        const changes = [];
        
        for (const category in newWorldbook) {
            const oldCategory = oldWorldbook[category] || {};
            const newCategory = newWorldbook[category];
            
            for (const entryName in newCategory) {
                const oldEntry = oldCategory[entryName];
                const newEntry = newCategory[entryName];
                
                if (!oldEntry) {
                    changes.push({
                        type: 'add',
                        category: category,
                        entryName: entryName,
                        oldValue: null,
                        newValue: newEntry
                    });
                } else if (JSON.stringify(oldEntry) !== JSON.stringify(newEntry)) {
                    changes.push({
                        type: 'modify',
                        category: category,
                        entryName: entryName,
                        oldValue: oldEntry,
                        newValue: newEntry
                    });
                }
            }
        }
        
        for (const category in oldWorldbook) {
            const oldCategory = oldWorldbook[category];
            const newCategory = newWorldbook[category] || {};
            
            for (const entryName in oldCategory) {
                if (!newCategory[entryName]) {
                    changes.push({
                        type: 'delete',
                        category: category,
                        entryName: entryName,
                        oldValue: oldCategory[entryName],
                        newValue: null
                    });
                }
            }
        }
        
        return changes;
    }

    async function mergeWorldbookDataWithHistory(target, source, memoryIndex, memoryTitle) {
        const previousWorldbook = JSON.parse(JSON.stringify(target));
        
        if (incrementalOutputMode) {
            mergeWorldbookDataIncremental(target, source);
        } else {
            mergeWorldbookData(target, source);
        }
        
        const changedEntries = findChangedEntries(previousWorldbook, target);
        
        if (changedEntries.length > 0) {
            await MemoryHistoryDB.saveHistory(
                memoryIndex,
                memoryTitle,
                previousWorldbook,
                target,
                changedEntries
            );
            console.log(`📚 Saved history: ${memoryTitle}, ${changedEntries.length} changes`);
        }
        
        return changedEntries;
    }

    // ========== Regex Fallback Parsing ==========
    function extractWorldbookDataByRegex(jsonString) {
        console.log('🔧 Starting regex extraction of worldbook data...');
        const result = {};
        
        const categories = ['Characters', 'Locations', 'Organizations', 'PlotOutline', 'KnowledgeBase', 'WritingStyle',
                          '角色', '地点', '组织', '剧情大纲', '知识书', '文风配置'];
        
        for (const category of categories) {
            const categoryPattern = new RegExp(`"${category}"\\s*:\\s*\\{`, 'g');
            const categoryMatch = categoryPattern.exec(jsonString);
            
            if (!categoryMatch) continue;
            
            const startPos = categoryMatch.index + categoryMatch[0].length;
            
            let braceCount = 1;
            let endPos = startPos;
            while (braceCount > 0 && endPos < jsonString.length) {
                if (jsonString[endPos] === '{') braceCount++;
                if (jsonString[endPos] === '}') braceCount--;
                endPos++;
            }
            
            if (braceCount !== 0) {
                console.log(`⚠️ Category "${category}" has mismatched braces, skipping`);
                continue;
            }
            
            const categoryContent = jsonString.substring(startPos, endPos - 1);
            result[category] = {};
            
            const entryPattern = /"([^"]+)"\s*:\s*\{/g;
            let entryMatch;
            
            while ((entryMatch = entryPattern.exec(categoryContent)) !== null) {
                const entryName = entryMatch[1];
                const entryStartPos = entryMatch.index + entryMatch[0].length;
                
                let entryBraceCount = 1;
                let entryEndPos = entryStartPos;
                while (entryBraceCount > 0 && entryEndPos < categoryContent.length) {
                    if (categoryContent[entryEndPos] === '{') entryBraceCount++;
                    if (categoryContent[entryEndPos] === '}') entryBraceCount--;
                    entryEndPos++;
                }
                
                if (entryBraceCount !== 0) continue;
                
                const entryContent = categoryContent.substring(entryStartPos, entryEndPos - 1);
                
                let keywords = [];
                const keywordsMatch = entryContent.match(/"(?:关键词|keywords)"\s*:\s*\[([\s\S]*?)\]/);
                if (keywordsMatch) {
                    const keywordStrings = keywordsMatch[1].match(/"([^"]+)"/g);
                    if (keywordStrings) {
                        keywords = keywordStrings.map(s => s.replace(/"/g, ''));
                    }
                }
                
                let content = '';
                const contentMatch = entryContent.match(/"(?:内容|content)"\s*:\s*"/);
                if (contentMatch) {
                    const contentStartPos = contentMatch.index + contentMatch[0].length;
                    let contentEndPos = contentStartPos;
                    let escaped = false;
                    while (contentEndPos < entryContent.length) {
                        const char = entryContent[contentEndPos];
                        if (escaped) {
                            escaped = false;
                        } else if (char === '\\') {
                            escaped = true;
                        } else if (char === '"') {
                            break;
                        }
                        contentEndPos++;
                    }
                    content = entryContent.substring(contentStartPos, contentEndPos);
                    try {
                        content = JSON.parse(`"${content}"`);
                    } catch (e) {
                        content = content.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                    }
                }
                
                if (content || keywords.length > 0) {
                    result[category][entryName] = {
                        '关键词': keywords,
                        'keywords': keywords,
                        '内容': content,
                        'content': content
                    };
                    console.log(`  ✓ Extracted entry: ${category} -> ${entryName}`);
                }
            }
            
            if (Object.keys(result[category]).length === 0) {
                delete result[category];
            }
        }
        
        const extractedCategories = Object.keys(result);
        const totalEntries = extractedCategories.reduce((sum, cat) => sum + Object.keys(result[cat]).length, 0);
        console.log(`🔧 Regex extraction complete: ${extractedCategories.length} categories, ${totalEntries} entries`);
        
        return result;
    }

    // ========== Memory Split (ONLY splits current failed chunk) ==========
    function splitMemoryIntoTwo(memoryIndex) {
        const memory = memoryQueue[memoryIndex];
        if (!memory) {
            console.error('❌ Cannot find memory to split');
            return null;
        }
        
        const content = memory.content;
        const halfLength = Math.floor(content.length / 2);
        
        let splitPoint = halfLength;
        
        // Try to find a good split point
        const paragraphBreak = content.indexOf('\n\n', halfLength);
        if (paragraphBreak !== -1 && paragraphBreak < halfLength + 5000) {
            splitPoint = paragraphBreak + 2;
        } else {
            const sentenceBreak = content.indexOf('。', halfLength);
            if (sentenceBreak !== -1 && sentenceBreak < halfLength + 1000) {
                splitPoint = sentenceBreak + 1;
            }
        }
        
        const content1 = content.substring(0, splitPoint);
        const content2 = content.substring(splitPoint);
        
        const originalTitle = memory.title;
        let baseName = originalTitle;
        let suffix1, suffix2;
        
        const splitMatch = originalTitle.match(/^(.+)-(\d+)$/);
        if (splitMatch) {
            baseName = splitMatch[1];
            const currentNum = parseInt(splitMatch[2]);
            suffix1 = `-${currentNum}-1`;
            suffix2 = `-${currentNum}-2`;
        } else {
            suffix1 = '-1';
            suffix2 = '-2';
        }
        
        const memory1 = {
            title: baseName + suffix1,
            content: content1,
            processed: false,
            failed: false,
            failedError: null
        };
        
        const memory2 = {
            title: baseName + suffix2,
            content: content2,
            processed: false,
            failed: false,
            failedError: null
        };
        
        // Only replace the current memory, don't touch others
        memoryQueue.splice(memoryIndex, 1, memory1, memory2);
        
        console.log(`🔀 Memory split complete: "${originalTitle}" -> "${memory1.title}" + "${memory2.title}"`);
        console.log(`📊 Queue size: ${memoryQueue.length} (split only this chunk, not subsequent ones)`);
        
        return { part1: memory1, part2: memory2 };
    }

    // ========== Memory Processing Core ==========
    async function processMemoryChunk(index, retryCount = 0) {
        if (isProcessingStopped) {
            console.log(`Processing paused, skipping memory chunk ${index + 1}`);
            return;
        }

        const memory = memoryQueue[index];
        const progress = ((index + 1) / memoryQueue.length) * 100;
        const maxRetries = 5;

        updateProgress(progress, `Processing: ${memory.title} (${index + 1}/${memoryQueue.length})${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''}`);

        let basePrompt = getSystemPrompt();
        let prompt = getLanguagePrefix() + basePrompt;

        let additionalReminders = '';
        if (settings.enablePlotOutline) {
            additionalReminders += '\n- Plot outline is required, must be generated';
        }
        if (settings.enableLiteraryStyle) {
            additionalReminders += '\n- Writing style field is optional, generate if clear style features can be analyzed';
        }
        if (additionalReminders) {
            prompt += additionalReminders;
        }

        prompt += '\n\n';

        if (index > 0) {
            prompt += `This is the ending of your previous reading:
---
${memoryQueue[index - 1].content.slice(-500)}
---

`;
            prompt += `This is your current memory of this work:
${JSON.stringify(generatedWorldbook, null, 2)}

`;
        }

        prompt += `This is the part you are reading now:
---
${memory.content}
---

`;

        if (index === 0) {
            prompt += `Now start analyzing the novel content, please focus on extracting information that actually appears in the text:

`;
        } else {
            if (incrementalOutputMode) {
                prompt += `Please **incrementally update** the worldbook based on new content, using **point-to-point override** mode:

**Incremental output rules**:
1. **Only output entries that need to change this time**, do not output the complete worldbook
2. **New entries**: Output complete content of new entries directly
3. **Modified entries**: Output complete new content of that entry (will override original content)
4. **Unchanged entries should not be output**, system will automatically retain them
5. **Keyword merge**: New keywords will automatically merge with original keywords, no need to repeat original keywords

**Example**: If only character "Zhang San" has new information, only output:
{"Characters": {"Zhang San": {"keywords": ["new title"], "content": "Updated complete description..."}}}

`;
            } else {
                prompt += `Please **accumulate and supplement** the worldbook based on new content:

**Important rules**:
1. **Existing characters**: If character exists, **append new information** to original content, do not delete or override existing descriptions
2. **New characters**: If newly appeared character, add as new entry
3. **Plot outline**: Continuously track main plot development, **append new plot progress** instead of rewriting
4. **Keywords**: Supplement new keywords for existing entries (like new titles, new relationships etc.)
5. **Maintain completeness**: Ensure important information extracted from previous chapters is not lost

`;
            }
        }

        prompt += `Please output JSON format result directly, do not add any code block markers or explanatory text.`;

        console.log(`=== Step ${index + 1} Prompt ===`);
        console.log(prompt);
        console.log('=====================');

        try {
            console.log(`Starting API call for memory chunk ${index + 1}...`);
            updateProgress(progress, `Calling API: ${memory.title} (${index + 1}/${memoryQueue.length})`);

            const response = await callAPI(prompt);

            if (isProcessingStopped) {
                console.log(`Pause detected after API call, skipping subsequent processing`);
                return;
            }

            console.log(`API call complete, response length: ${response.length}`);
            
            // Check if response contains token limit error
            const containsTokenError = /max|exceed|token.*limit|input.*token|INVALID_ARGUMENT/i.test(response);
            
            if (containsTokenError) {
                console.log(`⚠️ Response contains token limit error, splitting ONLY this memory chunk...`);
                updateProgress(progress, `🔀 Context overflow, splitting memory: ${memory.title}`);
                
                // ONLY split current chunk, not all subsequent ones
                const splitResult = splitMemoryIntoTwo(index);
                if (splitResult) {
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
                    
                    // Process the two new chunks
                    await processMemoryChunk(index, 0);
                    await processMemoryChunk(index + 1, 0);
                    return;
                }
            }
            
            // Clean and parse returned JSON
            let memoryUpdate;
            try {
                memoryUpdate = JSON.parse(response);
                console.log('✅ JSON parsed successfully');
            } catch (jsonError) {
                console.log('Direct JSON parse failed, starting cleanup...');
                let cleanResponse = response.trim();
                
                cleanResponse = cleanResponse.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
                
                if (!cleanResponse.startsWith('{')) {
                    const firstBrace = cleanResponse.indexOf('{');
                    const lastBrace = cleanResponse.lastIndexOf('}');
                    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                        cleanResponse = cleanResponse.substring(firstBrace, lastBrace + 1);
                    }
                }
                
                try {
                    memoryUpdate = JSON.parse(cleanResponse);
                    console.log('✅ JSON parsed after cleanup');
                } catch (secondError) {
                    console.error('❌ JSON parse still failed');
                    
                    const openBraces = (cleanResponse.match(/{/g) || []).length;
                    const closeBraces = (cleanResponse.match(/}/g) || []).length;
                    const missingBraces = openBraces - closeBraces;

                    if (missingBraces > 0) {
                        console.log(`⚠️ Incomplete content detected: missing ${missingBraces} closing braces`);
                        
                        try {
                            memoryUpdate = JSON.parse(cleanResponse + '}'.repeat(missingBraces));
                            console.log(`✅ Parsed after adding ${missingBraces} closing braces`);
                        } catch (autoFixError) {
                            console.log('❌ Still failed after adding braces, trying regex extraction...');
                            
                            const regexExtractedData = extractWorldbookDataByRegex(cleanResponse);
                            
                            if (regexExtractedData && Object.keys(regexExtractedData).length > 0) {
                                console.log('✅ Regex extraction successful!');
                                memoryUpdate = regexExtractedData;
                            } else {
                                console.log('🔧 Trying API correction for JSON format...');
                                updateProgress(progress, `JSON format error, calling AI correction: ${memory.title}`);
                                
                                try {
                                    const fixPrompt = getLanguagePrefix() + `You are a professional JSON repair expert. Please fix the following JSON text to valid JSON format.

## Core Requirements
1. **Only fix format**: Keep original data semantics unchanged
2. **Output must be a single JSON object**
3. **No extra output allowed**

## JSON text to fix
${cleanResponse}
`;

                                    const fixedResponse = await callAPI(fixPrompt);
                                    let cleanedFixedResponse = fixedResponse.trim();
                                    cleanedFixedResponse = cleanedFixedResponse.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

                                    const fb = cleanedFixedResponse.indexOf('{');
                                    const lb = cleanedFixedResponse.lastIndexOf('}');
                                    if (fb !== -1 && lb !== -1 && lb > fb) {
                                        cleanedFixedResponse = cleanedFixedResponse.substring(fb, lb + 1);
                                    }

                                    memoryUpdate = JSON.parse(cleanedFixedResponse);
                                    console.log('✅ JSON format correction successful!');

                                } catch (fixError) {
                                    console.error('❌ JSON format correction also failed');
                                    
                                    memoryUpdate = {
                                        'KnowledgeBase': {
                                            [`Memory_${index + 1}_ParseFailed`]: {
                                                'keywords': ['parse failed'],
                                                'content': `**Parse failure reason**: ${secondError.message}\n\n**Original response preview**:\n${cleanResponse.substring(0, 2000)}...`
                                            }
                                        }
                                    };
                                }
                            }
                        }
                    } else {
                        const regexExtractedData = extractWorldbookDataByRegex(cleanResponse);
                        
                        if (regexExtractedData && Object.keys(regexExtractedData).length > 0) {
                            console.log('✅ Regex extraction successful!');
                            memoryUpdate = regexExtractedData;
                        } else {
                            throw new Error(`JSON parse failed: ${secondError.message}`);
                        }
                    }
                }
            }
            
            // Merge to main worldbook
            const changedEntries = await mergeWorldbookDataWithHistory(generatedWorldbook, memoryUpdate, index, memory.title);
            
            if (incrementalOutputMode && changedEntries.length > 0) {
                console.log(`📝 Memory chunk ${index + 1} changed ${changedEntries.length} entries`);
            }
            
            memory.processed = true;
            updateMemoryQueueUI();
            console.log(`Memory chunk ${index + 1} processing complete`);
            
        } catch (error) {
            console.error(`Error processing memory chunk ${index + 1} (attempt ${retryCount + 1}):`, error);
            
            const errorMsg = error.message || '';
            const isTokenLimitError = errorMsg.includes('max_prompt_tokens') || 
                                       errorMsg.includes('exceeded') ||
                                       errorMsg.includes('input tokens') ||
                                       (errorMsg.includes('20015') && errorMsg.includes('limit'));
            
            if (isTokenLimitError) {
                console.log(`⚠️ Token limit error detected, splitting ONLY this memory: ${memory.title}`);
                updateProgress((index / memoryQueue.length) * 100, `🔀 Token limit exceeded, splitting memory: ${memory.title}`);
                
                // ONLY split current chunk
                const splitResult = splitMemoryIntoTwo(index);
                if (splitResult) {
                    console.log(`✅ Memory split successful`);
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    // Process split chunks
                    const part1Index = memoryQueue.indexOf(splitResult.part1);
                    await processMemoryChunk(part1Index, 0);
                    
                    const part2Index = memoryQueue.indexOf(splitResult.part2);
                    await processMemoryChunk(part2Index, 0);
                    
                    return;
                } else {
                    console.error(`❌ Memory split failed: ${memory.title}`);
                    memory.processed = true;
                    memory.failed = true;
                    memory.failedError = error.message;
                    if (!failedMemoryQueue.find(m => m.index === index)) {
                        failedMemoryQueue.push({ index, memory, error: error.message });
                    }
                    updateMemoryQueueUI();
                    return;
                }
            }
            
            // Non-token-limit errors use retry mechanism
            if (retryCount < maxRetries) {
                console.log(`Preparing to retry, current retry count: ${retryCount + 1}/${maxRetries}`);
                const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 10000);
                updateProgress((index / memoryQueue.length) * 100, `Processing failed, retrying in ${retryDelay/1000}s: ${memory.title}`);
                
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                
                return await processMemoryChunk(index, retryCount + 1);
            } else {
                console.error(`Memory chunk ${index + 1} failed after ${maxRetries} retries`);
                updateProgress((index / memoryQueue.length) * 100, `Processing failed (retried ${maxRetries} times): ${memory.title}`);
                
                memory.processed = true;
                memory.failed = true;
                memory.failedError = error.message;
                
                if (!failedMemoryQueue.find(m => m.index === index)) {
                    failedMemoryQueue.push({ index, memory, error: error.message });
                }
                
                updateMemoryQueueUI();
            }
        }

        if (memory.processed) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    async function startAIProcessing() {
        showProgressSection(true);
        showStreamSection(true);
        isProcessingStopped = false;

        generatedWorldbook = {
            Characters: {},
            Locations: {},
            Organizations: {},
            KnowledgeBase: {}
        };

        try {
            for (let i = 0; i < memoryQueue.length; i++) {
                if (isProcessingStopped) {
                    console.log('Processing stopped by user');
                    updateProgress((i / memoryQueue.length) * 100, `⏸️ Paused (${i}/${memoryQueue.length})`);
                    await MemoryHistoryDB.saveState(i);
                    alert(`Processing paused!\nCurrent progress: ${i}/${memoryQueue.length}\n\nProgress saved, refresh page to continue.`);
                    break;
                }
                
                if (isRepairingMemories) {
                    console.log(`Repair mode detected, pausing at index ${i}`);
                    currentProcessingIndex = i;
                    updateProgress((i / memoryQueue.length) * 100, `⏸️ Repairing memory, paused (${i}/${memoryQueue.length})`);
                    
                    while (isRepairingMemories) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                    
                    console.log(`Repair complete, continuing from index ${i}`);
                }
                
                await processMemoryChunk(i);
                
                await MemoryHistoryDB.saveState(i + 1);
            }
            
            const failedCount = memoryQueue.filter(m => m.failed === true).length;
            
            if (failedCount > 0) {
                updateProgress(100, `⚠️ Complete, but ${failedCount} memory chunks failed, click Repair`);
            } else {
                updateProgress(100, '✅ All memory chunks processed successfully!');
            }
            
            showResultSection(true);
            updateWorldbookPreview();
            
            console.log('AI Memory Master processing complete');
            
            if (!isProcessingStopped) {
                await MemoryHistoryDB.saveState(memoryQueue.length);
                console.log('✅ Conversion complete, state saved');
            }
            
        } catch (error) {
            console.error('Error during AI processing:', error);
            updateProgress(0, `❌ Processing error: ${error.message}`);
            alert(`Processing failed: ${error.message}\n\nProgress saved, can continue later.`);
        }
    }

    // ========== Repair Failed Memories ==========
    async function repairSingleMemory(index) {
        const memory = memoryQueue[index];

        let prompt = getLanguagePrefix() + `You are a professional novel worldbook generation expert. Please carefully read the provided novel content, extract key information, and generate worldbook entries.

## Output Format
Please generate standard JSON format:
{
"Characters": { "CharacterName": { "keywords": ["..."], "content": "..." } },
"Locations": { "LocationName": { "keywords": ["..."], "content": "..." } },
"Organizations": { "OrgName": { "keywords": ["..."], "content": "..." } }${settings.enablePlotOutline ? `,
"PlotOutline": { "MainPlot": { "keywords": ["main plot"], "content": "..." } }` : ''}${settings.enableLiteraryStyle ? `,
"WritingStyle": { "Style": { "keywords": ["style"], "content": "..." } }` : ''}
}

Output updated JSON directly, maintain consistency, do not include code block markers.
`;

        if (Object.keys(generatedWorldbook).length > 0) {
            prompt += `Current memory:\n${JSON.stringify(generatedWorldbook, null, 2)}\n\n`;
        }

        prompt += `Reading content:\n---\n${memory.content}\n---\n\nPlease update worldbook based on content, output JSON directly.`;

        console.log(`=== Repair Memory Step ${index + 1} Prompt ===`);
        console.log(prompt);

        const response = await callAPI(prompt);
        let memoryUpdate;

        try {
            memoryUpdate = JSON.parse(response);
        } catch (jsonError) {
            let cleanResponse = response.trim().replace(/```json\s*/gi, '').replace(/```\s*/g, '');
            const firstBrace = cleanResponse.indexOf('{');
            const lastBrace = cleanResponse.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                cleanResponse = cleanResponse.substring(firstBrace, lastBrace + 1);
            }
            
            try {
                memoryUpdate = JSON.parse(cleanResponse);
            } catch (secondError) {
                const openBraces = (cleanResponse.match(/{/g) || []).length;
                const closeBraces = (cleanResponse.match(/}/g) || []).length;
                if (openBraces > closeBraces) {
                    try {
                        memoryUpdate = JSON.parse(cleanResponse + '}'.repeat(openBraces - closeBraces));
                    } catch (e) {
                        const regexData = extractWorldbookDataByRegex(cleanResponse);
                        if (regexData && Object.keys(regexData).length > 0) {
                            memoryUpdate = regexData;
                        } else {
                            throw new Error(`JSON parse failed: ${secondError.message}`);
                        }
                    }
                } else {
                    const regexData = extractWorldbookDataByRegex(cleanResponse);
                    if (regexData && Object.keys(regexData).length > 0) {
                        memoryUpdate = regexData;
                    } else {
                        throw new Error(`JSON parse failed: ${secondError.message}`);
                    }
                }
            }
        }

        const memoryTitle = `Memory-Repair-${memory.title}`;
        await mergeWorldbookDataWithHistory(generatedWorldbook, memoryUpdate, index, memoryTitle);
        console.log(`Memory chunk ${index + 1} repair complete`);
    }

    async function repairMemoryWithSplit(memoryIndex, stats) {
        const memory = memoryQueue[memoryIndex];
        if (!memory) return;
        
        updateProgress((memoryIndex / memoryQueue.length) * 100, `Repairing: ${memory.title}`);
        
        try {
            await repairSingleMemory(memoryIndex);
            memory.failed = false;
            memory.failedError = null;
            memory.processed = true;
            stats.successCount++;
            console.log(`✅ Repair successful: ${memory.title}`);
            updateMemoryQueueUI();
            await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            const errorMsg = error.message || '';
            const isTokenLimitError = errorMsg.includes('max_prompt_tokens') || 
                                       errorMsg.includes('exceeded') ||
                                       errorMsg.includes('input tokens') ||
                                       (errorMsg.includes('20015') && errorMsg.includes('limit'));
            
            if (isTokenLimitError) {
                console.log(`⚠️ Token limit error detected, splitting memory: ${memory.title}`);
                updateProgress((memoryIndex / memoryQueue.length) * 100, `🔀 Splitting memory: ${memory.title}`);
                
                // ONLY split this memory
                const splitResult = splitMemoryIntoTwo(memoryIndex);
                if (splitResult) {
                    console.log(`✅ Memory split successful`);
                    updateMemoryQueueUI();
                    await MemoryHistoryDB.saveState(memoryQueue.filter(m => m.processed).length);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    const part1Index = memoryQueue.indexOf(splitResult.part1);
                    await repairMemoryWithSplit(part1Index, stats);
                    
                    const part2Index = memoryQueue.indexOf(splitResult.part2);
                    await repairMemoryWithSplit(part2Index, stats);
                } else {
                    stats.stillFailedCount++;
                    memory.failedError = error.message;
                    console.error(`❌ Memory split failed: ${memory.title}`);
                }
            } else {
                stats.stillFailedCount++;
                memory.failedError = error.message;
                console.error(`❌ Repair failed: ${memory.title}`, error);
                updateMemoryQueueUI();
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    async function startRepairFailedMemories() {
        const failedMemories = memoryQueue.filter(m => m.failed === true);
        if (failedMemories.length === 0) {
            alert('No memories to repair');
            return;
        }

        isRepairingMemories = true;
        console.log(`🔧 Starting repair of ${failedMemories.length} failed memories...`);

        showProgressSection(true);
        showStreamSection(true);
        updateProgress(0, `Repairing failed memories (0/${failedMemories.length})`);

        const stats = {
            successCount: 0,
            stillFailedCount: 0
        };

        for (let i = 0; i < failedMemories.length; i++) {
            const memory = failedMemories[i];
            const memoryIndex = memoryQueue.indexOf(memory);
            
            if (memoryIndex === -1) continue;
            
            updateProgress(((i + 1) / failedMemories.length) * 100, `Repairing: ${memory.title}`);
            
            await repairMemoryWithSplit(memoryIndex, stats);
        }

        failedMemoryQueue = failedMemoryQueue.filter(item => {
            const memory = memoryQueue[item.index];
            return memory && memory.failed === true;
        });

        updateProgress(100, `Repair complete: ${stats.successCount} successful, ${stats.stillFailedCount} still failed`);

        await MemoryHistoryDB.saveState(memoryQueue.length);

        isRepairingMemories = false;
        console.log(`🔧 Repair mode ended`);

        if (stats.stillFailedCount > 0) {
            alert(`Repair complete!\nSuccessful: ${stats.successCount}\nStill failed: ${stats.stillFailedCount}\n\nFailed memories still show ❗, can continue clicking Repair.`);
        } else {
            alert(`All repairs successful! Repaired ${stats.successCount} memory chunks.`);
        }
        
        updateMemoryQueueUI();
    }

    // ========== Export Functions ==========
    function convertToSillyTavernFormat(worldbook) {
        const entries = {};
        let entryId = 0;

        const triggerCategories = new Set(['Locations', 'PlotOutline', '地点', '剧情大纲']);

        for (const [category, categoryData] of Object.entries(worldbook)) {
            if (typeof categoryData !== 'object' || categoryData === null) continue;
            
            const isTriggerCategory = triggerCategories.has(category);
            const constant = !isTriggerCategory;
            const selective = isTriggerCategory;

            for (const [itemName, itemData] of Object.entries(categoryData)) {
                if (typeof itemData !== 'object' || itemData === null) continue;
                
                const keywords = itemData['关键词'] || itemData.keywords || [];
                const content = itemData['内容'] || itemData.content || '';
                
                if (Array.isArray(keywords) || content) {
                    const cleanKeywords = (Array.isArray(keywords) ? keywords : [itemName])
                        .map(keyword => String(keyword).trim().replace(/[-_\s]+/g, ''))
                        .filter(keyword => 
                            keyword.length > 0 && 
                            keyword.length <= 20 && 
                            !['的', '了', '在', '是', '有', '和', '与', '或', '但', 'the', 'a', 'an', 'is', 'are'].includes(keyword.toLowerCase())
                        );
                    
                    if (cleanKeywords.length === 0) {
                        cleanKeywords.push(itemName);
                    }
                    
                    const uniqueKeywords = [...new Set(cleanKeywords)];
                    
                    entries[entryId] = {
                        uid: entryId,
                        key: uniqueKeywords,
                        keysecondary: [],
                        comment: `${category} - ${itemName}`,
                        content: String(content).trim(),
                        constant,
                        selective,
                        selectiveLogic: 0,
                        addMemo: true,
                        order: entryId * 100,
                        position: 0,
                        disable: false,
                        excludeRecursion: false,
                        preventRecursion: false,
                        delayUntilRecursion: false,
                        probability: 100,
                        useProbability: true,
                        depth: 4,
                        group: category,
                        groupOverride: false,
                        groupWeight: 100,
                        scanDepth: null,
                        caseSensitive: false,
                        matchWholeWords: true,
                        useGroupScoring: null,
                        automationId: '',
                        role: 0,
                        vectorized: false,
                        sticky: null,
                        cooldown: null,
                        delay: null
                    };
                    entryId++;
                }
            }
        }

        if (Object.keys(entries).length === 0) {
            entries[0] = {
                uid: 0,
                key: ['default entry'],
                keysecondary: [],
                comment: 'Default entry generated during worldbook conversion',
                content: 'This is a worldbook entry automatically generated from a novel.',
                constant: false,
                selective: true,
                selectiveLogic: 0,
                addMemo: true,
                order: 100,
                position: 0,
                disable: false,
                excludeRecursion: false,
                preventRecursion: false,
                delayUntilRecursion: false,
                probability: 100,
                useProbability: true,
                depth: 4,
                group: 'Default',
                groupOverride: false,
                groupWeight: 100,
                scanDepth: null,
                caseSensitive: false,
                matchWholeWords: true,
                useGroupScoring: null,
                automationId: '',
                role: 0,
                vectorized: false,
                sticky: null,
                cooldown: null,
                delay: null
            };
        }

        return {
            entries: entries
        };
    }

    function exportWorldbook() {
        const timeString = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

        let fileName = 'converted-data';
        if (currentFile && currentFile.name) {
            const baseName = currentFile.name.replace(/\.[^/.]+$/, '');
            fileName = `${baseName}-worldbook-data-${timeString}`;
        } else {
            fileName = `converted-data-${timeString}`;
        }

        const blob = new Blob([JSON.stringify(generatedWorldbook, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName + '.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    function exportToSillyTavern() {
        const timeString = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

        try {
            const sillyTavernWorldbook = convertToSillyTavernFormat(generatedWorldbook);
            
            let fileName = 'st-worldbook';
            if (currentFile && currentFile.name) {
                const baseName = currentFile.name.replace(/\.[^/.]+$/, '');
                fileName = `${baseName}-st-worldbook-${timeString}`;
            } else {
                fileName = `st-worldbook-${timeString}`;
            }
            
            const blob = new Blob([JSON.stringify(sillyTavernWorldbook, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName + '.json';
            a.click();
            URL.revokeObjectURL(url);
            
            alert('Worldbook converted to SillyTavern format and downloaded. Please manually import the file in SillyTavern.');
        } catch (error) {
            console.error('Failed to convert to SillyTavern format:', error);
            alert('Conversion failed: ' + error.message);
        }
    }

    // ========== Help Modal ==========
    function showHelpModal() {
        const existingHelp = document.getElementById('ttw-help-modal');
        if (existingHelp) existingHelp.remove();

        const helpModal = document.createElement('div');
        helpModal.id = 'ttw-help-modal';
        helpModal.className = 'ttw-modal-container';
        helpModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 600px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">❓ TXT to Worldbook Help</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body" style="max-height: 70vh; overflow-y: auto;">
                    <div class="ttw-help-section">
                        <h4 style="color: #e67e22; margin: 0 0 10px 0;">📌 Basic Function</h4>
                        <p style="margin: 0 0 8px 0; line-height: 1.6; color: #ccc;">
                            Converts TXT format novel text to SillyTavern World Info format, automatically extracting characters, locations, organizations and other information.
                        </p>
                    </div>
                    
                    <div class="ttw-help-section" style="margin-top: 16px;">
                        <h4 style="color: #3498db; margin: 0 0 10px 0;">⚙️ API Settings</h4>
                        <ul style="margin: 0; padding-left: 20px; line-height: 1.8; color: #ccc;">
                            <li><b>Use ST Settings</b>: Automatically use SillyTavern's API configuration</li>
                            <li><b>Gemini</b>: Google official API, requires API Key</li>
                            <li><b>Gemini Proxy</b>: Third-party proxy service, requires Endpoint and Key</li>
                            <li><b>DeepSeek</b>: DeepSeek official API</li>
                            <li><b>OpenAI Compatible</b>: Supports local models (like LM Studio, Ollama) or other compatible interfaces</li>
                        </ul>
                    </div>
                    
                    <div class="ttw-help-section" style="margin-top: 16px;">
                        <h4 style="color: #9b59b6; margin: 0 0 10px 0;">📝 Incremental Output Mode</h4>
                        <p style="margin: 0 0 8px 0; line-height: 1.6; color: #ccc;">
                            When enabled, AI only outputs changed entries each time, not the complete worldbook. This can:
                        </p>
                        <ul style="margin: 0; padding-left: 20px; line-height: 1.8; color: #ccc;">
                            <li>Significantly reduce token consumption</li>
                            <li>Speed up processing</li>
                            <li>Avoid context length limits</li>
                        </ul>
                    </div>
                    
                    <div class="ttw-help-section" style="margin-top: 16px;">
                        <h4 style="color: #e74c3c; margin: 0 0 10px 0;">🔀 Smart Split Mechanism</h4>
                        <p style="margin: 0 0 8px 0; line-height: 1.6; color: #ccc;">
                            When token limit is detected, system automatically splits <b>ONLY the current failed chunk</b> into smaller parts for reprocessing, without affecting subsequent chunks.
                        </p>
                    </div>
                    
                    <div class="ttw-help-section" style="margin-top: 16px;">
                        <h4 style="color: #27ae60; margin: 0 0 10px 0;">👁️ Real-time Output</h4>
                        <p style="margin: 0 0 8px 0; line-height: 1.6; color: #ccc;">
                            The output panel shows API responses in real-time, making it easy to debug and track processing status.
                        </p>
                    </div>
                    
                    <div class="ttw-help-section" style="margin-top: 16px;">
                        <h4 style="color: #1abc9c; margin: 0 0 10px 0;">💡 Tips</h4>
                        <ul style="margin: 0; padding-left: 20px; line-height: 1.8; color: #ccc;">
                            <li>Recommended chunk size: 100k-200k characters (DeepSeek limit 100k, Gemini can set 200k)</li>
                            <li>Can pause during processing, refresh to continue</li>
                            <li>Failed memory chunks can be repaired with one click</li>
                            <li>Can use AI to optimize worldbook after generation</li>
                        </ul>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn ttw-btn-primary" id="ttw-close-help">Got it</button>
                </div>
            </div>
        `;

        document.body.appendChild(helpModal);

        helpModal.querySelector('.ttw-modal-close').addEventListener('click', () => helpModal.remove());
        helpModal.querySelector('#ttw-close-help').addEventListener('click', () => helpModal.remove());
        helpModal.addEventListener('click', (e) => {
            if (e.target === helpModal) helpModal.remove();
        });
    }

    // ========== UI Related ==========
    let modalContainer = null;

    function getSystemPrompt() {
        const worldbookPrompt = settings.customWorldbookPrompt?.trim() || defaultWorldbookPrompt;
        const additionalParts = [];

        if (settings.enablePlotOutline) {
            const plotPrompt = settings.customPlotPrompt?.trim() || defaultPlotPrompt;
            additionalParts.push(plotPrompt);
        }

        if (settings.enableLiteraryStyle) {
            const stylePrompt = settings.customStylePrompt?.trim() || defaultStylePrompt;
            additionalParts.push(stylePrompt);
        }

        if (additionalParts.length === 0) {
            return worldbookPrompt;
        }

        let fullPrompt = worldbookPrompt;
        const insertContent = ',\n' + additionalParts.join(',\n');
        fullPrompt = fullPrompt.replace(
            /(\}\s*)\n\`\`\`/,
            `${insertContent}\n$1\n\`\`\``
        );

        return fullPrompt;
    }

    function createModal() {
        if (modalContainer) {
            modalContainer.remove();
        }

        modalContainer = document.createElement('div');
        modalContainer.id = 'txt-to-worldbook-modal';
        modalContainer.className = 'ttw-modal-container';
        modalContainer.innerHTML = `
            <div class="ttw-modal">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📚 TXT to Worldbook</span>
                    <div class="ttw-header-actions">
                        <span class="ttw-help-btn" title="Help">❓</span>
                        <button class="ttw-modal-close" type="button">✕</button>
                    </div>
                </div>
                <div class="ttw-modal-body">
                    <!-- Settings Section -->
                    <div class="ttw-section ttw-settings-section">
                        <div class="ttw-section-header" data-section="settings">
                            <span>⚙️ API Settings</span>
                            <span class="ttw-collapse-icon">▼</span>
                        </div>
                        <div class="ttw-section-content" id="ttw-settings-content">
                            <div class="ttw-checkbox-group" style="margin-bottom: 12px;">
                                <label class="ttw-checkbox-label">
                                    <input type="checkbox" id="ttw-use-st-settings" checked>
                                    <span>🔗 Use SillyTavern API Settings</span>
                                </label>
                            </div>
                            <div id="ttw-custom-api-settings">
                                <div class="ttw-setting-item">
                                    <label>API Provider</label>
                                    <select id="ttw-api-provider">
                                        <option value="openai-compatible">OpenAI Compatible</option>
                                        <option value="gemini">Gemini</option>
                                        <option value="gemini-proxy">Gemini Proxy</option>
                                        <option value="deepseek">DeepSeek</option>
                                    </select>
                                </div>
                                <div class="ttw-setting-item">
                                    <label>API Key <span style="opacity: 0.6; font-size: 11px;">(optional for local models)</span></label>
                                    <input type="password" id="ttw-api-key" placeholder="Enter API Key">
                                </div>
                                <div class="ttw-setting-item" id="ttw-endpoint-container">
                                    <label>API Endpoint</label>
                                    <input type="text" id="ttw-api-endpoint" placeholder="https://... or http://127.0.0.1:5000/v1">
                                </div>
                                <div class="ttw-setting-item" id="ttw-model-input-container">
                                    <label>Model</label>
                                    <input type="text" id="ttw-api-model" value="gemini-2.5-flash" placeholder="Model name">
                                </div>
                                <div class="ttw-setting-item" id="ttw-model-select-container" style="display: none;">
                                    <label>Model</label>
                                    <select id="ttw-model-select">
                                        <option value="">-- Fetch model list first --</option>
                                    </select>
                                </div>
                                <div class="ttw-model-actions" id="ttw-model-actions">
                                    <button id="ttw-fetch-models" class="ttw-btn ttw-btn-small">🔄 Fetch Models</button>
                                    <button id="ttw-quick-test" class="ttw-btn ttw-btn-small">⚡ Quick Test</button>
                                    <span id="ttw-model-status" class="ttw-model-status"></span>
                                </div>
                            </div>
                            <div class="ttw-setting-item">
                                <label>Characters per Chunk</label>
                                <input type="number" id="ttw-chunk-size" value="100000" min="1000" max="500000">
                            </div>
                            <div class="ttw-checkbox-group">
                                <label class="ttw-checkbox-label">
                                    <input type="checkbox" id="ttw-incremental-mode" checked>
                                    <span>📝 Incremental Output Mode</span>
                                </label>
                                <label class="ttw-checkbox-label">
                                    <input type="checkbox" id="ttw-enable-plot">
                                    <span>📖 Extract Plot Outline</span>
                                </label>
                                <label class="ttw-checkbox-label">
                                    <input type="checkbox" id="ttw-enable-style">
                                    <span>🎨 Extract Writing Style</span>
                                </label>
                            </div>
                        </div>
                    </div>

                    <!-- File Upload Section -->
                    <div class="ttw-section ttw-upload-section">
                        <div class="ttw-section-header">
                            <span>📄 File Upload</span>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-upload-area" id="ttw-upload-area">
                                <div class="ttw-upload-icon">📁</div>
                                <div class="ttw-upload-text">Click or drag TXT file here</div>
                                <input type="file" id="ttw-file-input" accept=".txt" style="display: none;">
                            </div>
                            <div class="ttw-file-info" id="ttw-file-info" style="display: none;">
                                <span id="ttw-file-name"></span>
                                <span id="ttw-file-size"></span>
                                <button id="ttw-clear-file" class="ttw-btn-small">Clear</button>
                            </div>
                        </div>
                    </div>

                    <!-- Memory Queue Section -->
                    <div class="ttw-section ttw-queue-section" id="ttw-queue-section" style="display: none;">
                        <div class="ttw-section-header">
                            <span>📋 Memory Queue</span>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-memory-queue" id="ttw-memory-queue"></div>
                        </div>
                    </div>

                    <!-- Real-time Output Section -->
                    <div class="ttw-section ttw-stream-section" id="ttw-stream-section" style="display: none;">
                        <div class="ttw-section-header">
                            <span>👁️ Real-time Output</span>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-stream-output" id="ttw-stream-output">
                                <span style="color: #888;">Waiting for API response...</span>
                            </div>
                        </div>
                    </div>

                    <!-- Progress Section -->
                    <div class="ttw-section ttw-progress-section" id="ttw-progress-section" style="display: none;">
                        <div class="ttw-section-header">
                            <span>⏳ Processing Progress</span>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-progress-bar">
                                <div class="ttw-progress-fill" id="ttw-progress-fill"></div>
                            </div>
                            <div class="ttw-progress-text" id="ttw-progress-text">Preparing...</div>
                            <div class="ttw-progress-controls" id="ttw-progress-controls">
                                <button id="ttw-stop-btn" class="ttw-btn ttw-btn-secondary">⏸️ Pause</button>
                                <button id="ttw-repair-btn" class="ttw-btn ttw-btn-warning" style="display: none;">🔧 Repair Failed</button>
                            </div>
                        </div>
                    </div>

                    <!-- Result Section -->
                    <div class="ttw-section ttw-result-section" id="ttw-result-section" style="display: none;">
                        <div class="ttw-section-header">
                            <span>📊 Generated Result</span>
                        </div>
                        <div class="ttw-section-content">
                            <div class="ttw-result-preview" id="ttw-result-preview"></div>
                            <div class="ttw-result-actions">
                                <button id="ttw-view-worldbook" class="ttw-btn">📖 View Worldbook</button>
                                <button id="ttw-view-history" class="ttw-btn">📜 Edit History</button>
                                <button id="ttw-export-json" class="ttw-btn">📥 Export JSON</button>
                                <button id="ttw-export-st" class="ttw-btn ttw-btn-primary">📥 Export ST Format</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button id="ttw-start-btn" class="ttw-btn ttw-btn-primary" disabled>🚀 Start Conversion</button>
                </div>
            </div>
        `;

        document.body.appendChild(modalContainer);
        addModalStyles();
        bindModalEvents();
        loadSavedSettings();
        checkAndRestoreState();
    }

    function addModalStyles() {
        if (document.getElementById('ttw-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'ttw-styles';
        styles.textContent = `
            .ttw-modal-container {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 99999;
                padding: 20px;
                box-sizing: border-box;
            }

            .ttw-modal {
                background: var(--SmartThemeBlurTintColor, #1e1e2e);
                border: 1px solid var(--SmartThemeBorderColor, #555);
                border-radius: 12px;
                width: 100%;
                max-width: 800px;
                max-height: calc(100vh - 40px);
                display: flex;
                flex-direction: column;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
                overflow: hidden;
            }

            .ttw-modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 16px 20px;
                border-bottom: 1px solid var(--SmartThemeBorderColor, #444);
                background: rgba(0, 0, 0, 0.2);
            }

            .ttw-modal-title {
                font-weight: bold;
                font-size: 16px;
                color: #e67e22;
            }

            .ttw-header-actions {
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .ttw-help-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 28px;
                height: 28px;
                border-radius: 50%;
                background: rgba(231, 76, 60, 0.2);
                color: #e74c3c;
                font-size: 14px;
                cursor: pointer;
                transition: all 0.2s;
                border: 1px solid rgba(231, 76, 60, 0.4);
            }

            .ttw-help-btn:hover {
                background: rgba(231, 76, 60, 0.4);
                transform: scale(1.1);
            }

            .ttw-modal-close {
                background: rgba(255, 255, 255, 0.1);
                border: none;
                color: #fff;
                font-size: 18px;
                width: 36px;
                height: 36px;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.2s;
            }

            .ttw-modal-close:hover {
                background: rgba(255, 100, 100, 0.3);
                color: #ff6b6b;
            }

            .ttw-modal-body {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
            }

            .ttw-modal-footer {
                padding: 16px 20px;
                border-top: 1px solid var(--SmartThemeBorderColor, #444);
                background: rgba(0, 0, 0, 0.2);
                display: flex;
                justify-content: flex-end;
                gap: 10px;
            }

            .ttw-section {
                background: rgba(0, 0, 0, 0.2);
                border-radius: 8px;
                margin-bottom: 12px;
                overflow: hidden;
            }

            .ttw-section-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                background: rgba(0, 0, 0, 0.3);
                cursor: pointer;
                font-weight: bold;
                font-size: 14px;
            }

            .ttw-section-content {
                padding: 16px;
            }

            .ttw-collapse-icon {
                font-size: 10px;
                transition: transform 0.2s;
            }

            .ttw-section.collapsed .ttw-collapse-icon {
                transform: rotate(-90deg);
            }

            .ttw-section.collapsed .ttw-section-content {
                display: none;
            }

            .ttw-setting-item {
                margin-bottom: 12px;
            }

            .ttw-setting-item > label {
                display: block;
                margin-bottom: 6px;
                font-size: 12px;
                opacity: 0.9;
            }

            .ttw-setting-item input,
            .ttw-setting-item select {
                width: 100%;
                padding: 10px 12px;
                border: 1px solid var(--SmartThemeBorderColor, #555);
                border-radius: 6px;
                background: rgba(0, 0, 0, 0.3);
                color: #fff;
                font-size: 13px;
                box-sizing: border-box;
            }

            .ttw-setting-item select option {
                background: #2a2a2a;
            }

            .ttw-model-actions {
                display: flex;
                gap: 10px;
                align-items: center;
                margin-bottom: 12px;
                padding: 10px;
                background: rgba(52, 152, 219, 0.1);
                border: 1px solid rgba(52, 152, 219, 0.3);
                border-radius: 6px;
            }

            .ttw-model-status {
                font-size: 12px;
                margin-left: auto;
            }

            .ttw-model-status.success {
                color: #27ae60;
            }

            .ttw-model-status.error {
                color: #e74c3c;
            }

            .ttw-model-status.loading {
                color: #f39c12;
            }

            .ttw-checkbox-group {
                display: flex;
                flex-direction: column;
                gap: 8px;
                margin-top: 12px;
            }

            .ttw-checkbox-label {
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                font-size: 13px;
            }

            .ttw-checkbox-label input {
                width: 18px;
                height: 18px;
                accent-color: #e67e22;
            }

            .ttw-upload-area {
                border: 2px dashed var(--SmartThemeBorderColor, #555);
                border-radius: 8px;
                padding: 40px 20px;
                text-align: center;
                cursor: pointer;
                transition: all 0.2s;
            }

            .ttw-upload-area:hover {
                border-color: #e67e22;
                background: rgba(230, 126, 34, 0.1);
            }

            .ttw-upload-area.dragover {
                border-color: #e67e22;
                background: rgba(230, 126, 34, 0.2);
            }

            .ttw-upload-icon {
                font-size: 48px;
                margin-bottom: 12px;
            }

            .ttw-upload-text {
                font-size: 14px;
                opacity: 0.8;
            }

            .ttw-file-info {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 6px;
                margin-top: 12px;
            }

            .ttw-memory-queue {
                max-height: 200px;
                overflow-y: auto;
            }

            .ttw-memory-item {
                padding: 8px 12px;
                background: rgba(0, 0, 0, 0.2);
                border-radius: 4px;
                margin-bottom: 6px;
                font-size: 13px;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .ttw-memory-item.processed {
                opacity: 0.6;
            }

            .ttw-memory-item.failed {
                border-left: 3px solid #e74c3c;
            }

            .ttw-stream-output {
                background: rgba(0, 0, 0, 0.4);
                border: 1px solid var(--SmartThemeBorderColor, #444);
                border-radius: 6px;
                padding: 12px;
                height: 200px;
                overflow-y: auto;
                font-family: monospace;
                font-size: 11px;
                line-height: 1.5;
                white-space: pre-wrap;
                word-break: break-all;
            }

            .ttw-progress-bar {
                width: 100%;
                height: 8px;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 4px;
                overflow: hidden;
                margin-bottom: 12px;
            }

            .ttw-progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #e67e22, #f39c12);
                border-radius: 4px;
                transition: width 0.3s;
                width: 0%;
            }

            .ttw-progress-text {
                font-size: 13px;
                text-align: center;
                margin-bottom: 12px;
            }

            .ttw-progress-controls {
                display: flex;
                gap: 10px;
                justify-content: center;
            }

            .ttw-result-preview {
                max-height: 300px;
                overflow-y: auto;
                background: rgba(0, 0, 0, 0.3);
                border-radius: 6px;
                padding: 12px;
                margin-bottom: 12px;
                font-size: 12px;
            }

            .ttw-result-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
            }

            .ttw-btn {
                padding: 10px 16px;
                border: 1px solid var(--SmartThemeBorderColor, #555);
                border-radius: 6px;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                font-size: 13px;
                cursor: pointer;
                transition: all 0.2s;
            }

            .ttw-btn:hover {
                background: rgba(255, 255, 255, 0.2);
            }

            .ttw-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .ttw-btn-primary {
                background: linear-gradient(135deg, #e67e22, #d35400);
                border-color: #e67e22;
            }

            .ttw-btn-primary:hover {
                background: linear-gradient(135deg, #f39c12, #e67e22);
            }

            .ttw-btn-secondary {
                background: rgba(108, 117, 125, 0.5);
            }

            .ttw-btn-warning {
                background: rgba(255, 107, 53, 0.5);
                border-color: #ff6b35;
            }

            .ttw-btn-small {
                padding: 6px 12px;
                font-size: 12px;
                border: 1px solid var(--SmartThemeBorderColor, #555);
                border-radius: 4px;
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                cursor: pointer;
                transition: all 0.2s;
            }

            .ttw-btn-small:hover {
                background: rgba(255, 255, 255, 0.2);
            }

            .ttw-btn-small:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .ttw-category-card {
                margin-bottom: 12px;
                border: 1px solid #e67e22;
                border-radius: 8px;
                overflow: hidden;
            }

            .ttw-category-header {
                background: linear-gradient(135deg, #e67e22, #d35400);
                padding: 10px 14px;
                cursor: pointer;
                font-weight: bold;
                font-size: 14px;
                display: flex;
                justify-content: space-between;
            }

            .ttw-category-content {
                background: #2d2d2d;
                display: none;
            }

            .ttw-entry-card {
                margin: 8px;
                border: 1px solid #555;
                border-radius: 6px;
                overflow: hidden;
            }

            .ttw-entry-header {
                background: #3a3a3a;
                padding: 8px 12px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                border-left: 3px solid #3498db;
            }

            .ttw-entry-content {
                display: none;
                background: #1c1c1c;
                padding: 12px;
            }

            .ttw-keywords {
                margin-bottom: 8px;
                padding: 8px;
                background: #252525;
                border-left: 3px solid #9b59b6;
                border-radius: 4px;
            }

            .ttw-content-text {
                padding: 8px;
                background: #252525;
                border-left: 3px solid #27ae60;
                border-radius: 4px;
                line-height: 1.6;
            }
        `;

        document.head.appendChild(styles);
    }

    function bindModalEvents() {
        const modal = modalContainer.querySelector('.ttw-modal');
        modal.addEventListener('click', (e) => e.stopPropagation(), false);
        modal.addEventListener('mousedown', (e) => e.stopPropagation(), false);

        modalContainer.querySelector('.ttw-modal-close').addEventListener('click', (e) => {
            e.stopPropagation();
            closeModal();
        }, false);

        modalContainer.querySelector('.ttw-help-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            showHelpModal();
        }, false);

        modalContainer.addEventListener('click', (e) => {
            if (e.target === modalContainer) {
                closeModal();
            }
        }, false);

        document.addEventListener('keydown', handleEscKey, true);

        // Use ST settings toggle
        document.getElementById('ttw-use-st-settings').addEventListener('change', (e) => {
            settings.useSTSettings = e.target.checked;
            const customSettings = document.getElementById('ttw-custom-api-settings');
            if (e.target.checked) {
                customSettings.style.opacity = '0.5';
                applySTSettings();
            } else {
                customSettings.style.opacity = '1';
            }
            saveCurrentSettings();
        });

        document.getElementById('ttw-api-provider').addEventListener('change', handleProviderChange);

        ['ttw-api-provider', 'ttw-api-key', 'ttw-api-endpoint', 'ttw-api-model', 'ttw-chunk-size'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', saveCurrentSettings);
            }
        });

        ['ttw-incremental-mode', 'ttw-enable-plot', 'ttw-enable-style'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', saveCurrentSettings);
            }
        });

        document.getElementById('ttw-fetch-models').addEventListener('click', handleFetchModels);
        document.getElementById('ttw-quick-test').addEventListener('click', handleQuickTest);

        document.getElementById('ttw-model-select').addEventListener('change', (e) => {
            if (e.target.value) {
                document.getElementById('ttw-api-model').value = e.target.value;
                saveCurrentSettings();
            }
        });

        const uploadArea = document.getElementById('ttw-upload-area');
        const fileInput = document.getElementById('ttw-file-input');

        uploadArea.addEventListener('click', () => fileInput.click());
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });
        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) {
                handleFileSelect(e.dataTransfer.files[0]);
            }
        });
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleFileSelect(e.target.files[0]);
            }
        });

        document.getElementById('ttw-clear-file').addEventListener('click', clearFile);
        document.getElementById('ttw-start-btn').addEventListener('click', startConversion);
        document.getElementById('ttw-stop-btn').addEventListener('click', () => {
            isProcessingStopped = true;
        });
        document.getElementById('ttw-repair-btn').addEventListener('click', startRepairFailedMemories);

        document.getElementById('ttw-view-worldbook').addEventListener('click', showWorldbookView);
        document.getElementById('ttw-view-history').addEventListener('click', showHistoryView);
        document.getElementById('ttw-export-json').addEventListener('click', exportWorldbook);
        document.getElementById('ttw-export-st').addEventListener('click', exportToSillyTavern);

        document.querySelector('[data-section="settings"]').addEventListener('click', () => {
            document.querySelector('.ttw-settings-section').classList.toggle('collapsed');
        });
    }

    function handleEscKey(e) {
        if (e.key === 'Escape' && modalContainer) {
            e.stopPropagation();
            e.preventDefault();
            closeModal();
        }
    }

    function handleProviderChange() {
        const provider = document.getElementById('ttw-api-provider').value;
        const endpointContainer = document.getElementById('ttw-endpoint-container');
        const modelActionsContainer = document.getElementById('ttw-model-actions');
        const modelSelectContainer = document.getElementById('ttw-model-select-container');
        const modelInputContainer = document.getElementById('ttw-model-input-container');

        endpointContainer.style.display = (provider === 'gemini-proxy' || provider === 'openai-compatible') ? 'block' : 'none';
        
        modelInputContainer.style.display = 'block';
        modelSelectContainer.style.display = 'none';

        updateModelStatus('', '');
        saveCurrentSettings();
    }

    function updateModelStatus(text, type) {
        const statusEl = document.getElementById('ttw-model-status');
        statusEl.textContent = text;
        statusEl.className = 'ttw-model-status';
        if (type) {
            statusEl.classList.add(type);
        }
    }

    async function handleFetchModels() {
        const fetchBtn = document.getElementById('ttw-fetch-models');
        const modelSelect = document.getElementById('ttw-model-select');
        const modelSelectContainer = document.getElementById('ttw-model-select-container');
        const modelInputContainer = document.getElementById('ttw-model-input-container');

        saveCurrentSettings();

        fetchBtn.disabled = true;
        fetchBtn.textContent = '⏳ Fetching...';
        updateModelStatus('Fetching model list...', 'loading');

        try {
            const models = await fetchModelList();

            if (models.length === 0) {
                updateModelStatus('❌ No models found', 'error');
                modelInputContainer.style.display = 'block';
                modelSelectContainer.style.display = 'none';
                return;
            }

            modelSelect.innerHTML = '<option value="">-- Select model --</option>';
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                modelSelect.appendChild(option);
            });

            modelInputContainer.style.display = 'none';
            modelSelectContainer.style.display = 'block';

            const currentModel = document.getElementById('ttw-api-model').value;
            if (models.includes(currentModel)) {
                modelSelect.value = currentModel;
            } else if (models.length > 0) {
                modelSelect.value = models[0];
                document.getElementById('ttw-api-model').value = models[0];
                saveCurrentSettings();
            }

            updateModelStatus(`✅ Found ${models.length} models`, 'success');

        } catch (error) {
            console.error('Failed to fetch model list:', error);
            updateModelStatus(`❌ ${error.message}`, 'error');
            modelInputContainer.style.display = 'block';
            modelSelectContainer.style.display = 'none';
        } finally {
            fetchBtn.disabled = false;
            fetchBtn.textContent = '🔄 Fetch Models';
        }
    }

    async function handleQuickTest() {
        const testBtn = document.getElementById('ttw-quick-test');

        saveCurrentSettings();

        testBtn.disabled = true;
        testBtn.textContent = '⏳ Testing...';
        updateModelStatus('Testing connection...', 'loading');

        try {
            const result = await quickTestModel();
            
            updateModelStatus(`✅ Success (${result.elapsed}ms)`, 'success');
            
            if (result.response) {
                console.log('Quick test response:', result.response);
            }

        } catch (error) {
            console.error('Quick test failed:', error);
            updateModelStatus(`❌ ${error.message}`, 'error');
        } finally {
            testBtn.disabled = false;
            testBtn.textContent = '⚡ Quick Test';
        }
    }

    function saveCurrentSettings() {
        settings.useSTSettings = document.getElementById('ttw-use-st-settings').checked;
        settings.apiProvider = document.getElementById('ttw-api-provider').value;
        settings.apiKey = document.getElementById('ttw-api-key').value;
        settings.apiEndpoint = document.getElementById('ttw-api-endpoint').value;
        settings.apiModel = document.getElementById('ttw-api-model').value;
        settings.chunkSize = parseInt(document.getElementById('ttw-chunk-size').value) || 100000;
        incrementalOutputMode = document.getElementById('ttw-incremental-mode').checked;
        settings.enablePlotOutline = document.getElementById('ttw-enable-plot').checked;
        settings.enableLiteraryStyle = document.getElementById('ttw-enable-style').checked;

        try {
            localStorage.setItem('txtToWorldbookSettings', JSON.stringify(settings));
        } catch (e) {
            console.error('Failed to save settings:', e);
        }
    }

    function loadSavedSettings() {
        try {
            const saved = localStorage.getItem('txtToWorldbookSettings');
            if (saved) {
                const parsed = JSON.parse(saved);
                settings = { ...defaultSettings, ...parsed };
            }
        } catch (e) {
            console.error('Failed to load settings:', e);
        }

        document.getElementById('ttw-use-st-settings').checked = settings.useSTSettings;
        document.getElementById('ttw-api-provider').value = settings.apiProvider;
        document.getElementById('ttw-api-key').value = settings.apiKey;
        document.getElementById('ttw-api-endpoint').value = settings.apiEndpoint;
        document.getElementById('ttw-api-model').value = settings.apiModel;
        document.getElementById('ttw-chunk-size').value = settings.chunkSize;
        document.getElementById('ttw-incremental-mode').checked = incrementalOutputMode;
        document.getElementById('ttw-enable-plot').checked = settings.enablePlotOutline;
        document.getElementById('ttw-enable-style').checked = settings.enableLiteraryStyle;

        if (settings.useSTSettings) {
            document.getElementById('ttw-custom-api-settings').style.opacity = '0.5';
            applySTSettings();
        }

        handleProviderChange();
    }

    async function checkAndRestoreState() {
        try {
            const savedState = await MemoryHistoryDB.loadState();
            if (savedState && savedState.memoryQueue && savedState.memoryQueue.length > 0) {
                const shouldRestore = confirm(`Detected incomplete conversion task (${savedState.processedIndex}/${savedState.memoryQueue.length})\n\nRestore?`);
                
                if (shouldRestore) {
                    memoryQueue = savedState.memoryQueue;
                    generatedWorldbook = savedState.generatedWorldbook || {};
                    currentFileHash = savedState.fileHash;
                    
                    showQueueSection(true);
                    updateMemoryQueueUI();
                    
                    if (savedState.processedIndex >= savedState.memoryQueue.length) {
                        showResultSection(true);
                        updateWorldbookPreview();
                    } else {
                        document.getElementById('ttw-start-btn').disabled = false;
                        document.getElementById('ttw-start-btn').textContent = '▶️ Continue Conversion';
                    }
                } else {
                    await MemoryHistoryDB.clearState();
                }
            }
        } catch (e) {
            console.error('Failed to restore state:', e);
        }
    }

    async function handleFileSelect(file) {
        if (!file.name.endsWith('.txt')) {
            alert('Please select a TXT file');
            return;
        }

        try {
            const { encoding, content } = await detectBestEncoding(file);
            
            currentFile = file;
            
            const newHash = await calculateFileHash(content);
            const savedHash = await MemoryHistoryDB.getSavedFileHash();
            
            if (savedHash && savedHash !== newHash) {
                const historyList = await MemoryHistoryDB.getAllHistory();
                if (historyList.length > 0) {
                    const shouldClear = confirm(`New file detected, clear old history?\n\nCurrently have ${historyList.length} records.`);
                    if (shouldClear) {
                        await MemoryHistoryDB.clearAllHistory();
                        await MemoryHistoryDB.clearState();
                    }
                }
            }
            
            currentFileHash = newHash;
            await MemoryHistoryDB.saveFileHash(newHash);
            
            document.getElementById('ttw-upload-area').style.display = 'none';
            document.getElementById('ttw-file-info').style.display = 'flex';
            document.getElementById('ttw-file-name').textContent = file.name;
            document.getElementById('ttw-file-size').textContent = `(${(content.length / 1024).toFixed(1)} KB, ${encoding})`;
            
            splitContentIntoMemory(content);
            
            showQueueSection(true);
            updateMemoryQueueUI();
            
            document.getElementById('ttw-start-btn').disabled = false;
            
        } catch (error) {
            console.error('File processing failed:', error);
            alert('File processing failed: ' + error.message);
        }
    }

    function splitContentIntoMemory(content) {
        const chunkSize = settings.chunkSize;
        memoryQueue = [];
        
        const chapterRegex = /第[一二三四五六七八九十百千0-9]+[章节卷集回]|Chapter\s+\d+/gi;
        const chapters = [];
        const matches = [...content.matchAll(chapterRegex)];
        
        if (matches.length > 0) {
            for (let i = 0; i < matches.length; i++) {
                const startIndex = matches[i].index;
                const endIndex = i < matches.length - 1 ? matches[i + 1].index : content.length;
                chapters.push(content.slice(startIndex, endIndex));
            }
            
            let currentChunk = '';
            let chunkIndex = 1;
            
            for (const chapter of chapters) {
                if (currentChunk.length + chapter.length > chunkSize && currentChunk.length > 0) {
                    memoryQueue.push({
                        title: `Memory${chunkIndex}`,
                        content: currentChunk,
                        processed: false,
                        failed: false
                    });
                    currentChunk = '';
                    chunkIndex++;
                }
                currentChunk += chapter;
            }
            
            if (currentChunk.length > 0) {
                memoryQueue.push({
                    title: `Memory${chunkIndex}`,
                    content: currentChunk,
                    processed: false,
                    failed: false
                });
            }
        } else {
            for (let i = 0; i < content.length; i += chunkSize) {
                let endIndex = Math.min(i + chunkSize, content.length);
                
                if (endIndex < content.length) {
                    const paragraphBreak = content.lastIndexOf('\n\n', endIndex);
                    if (paragraphBreak > i) {
                        endIndex = paragraphBreak + 2;
                    }
                }
                
                memoryQueue.push({
                    title: `Memory${memoryQueue.length + 1}`,
                    content: content.slice(i, endIndex),
                    processed: false,
                    failed: false
                });
                
                i = endIndex - chunkSize;
            }
        }
        
        console.log(`Text split into ${memoryQueue.length} memory chunks`);
    }

    function clearFile() {
        currentFile = null;
        memoryQueue = [];
        generatedWorldbook = {};
        
        document.getElementById('ttw-upload-area').style.display = 'block';
        document.getElementById('ttw-file-info').style.display = 'none';
        document.getElementById('ttw-file-input').value = '';
        document.getElementById('ttw-start-btn').disabled = true;
        
        showQueueSection(false);
        showProgressSection(false);
        showStreamSection(false);
        showResultSection(false);
    }

    async function startConversion() {
        saveCurrentSettings();
        
        if (!settings.apiKey && settings.apiProvider !== 'openai-compatible' && !settings.useSTSettings) {
            alert('Please set API Key first');
            return;
        }
        
        if (memoryQueue.length === 0) {
            alert('Please upload a file first');
            return;
        }
        
        document.getElementById('ttw-start-btn').disabled = true;
        document.getElementById('ttw-start-btn').textContent = 'Converting...';
        
        await startAIProcessing();
        
        document.getElementById('ttw-start-btn').textContent = '🚀 Start Conversion';
    }

    function showQueueSection(show) {
        document.getElementById('ttw-queue-section').style.display = show ? 'block' : 'none';
    }

    function showProgressSection(show) {
        document.getElementById('ttw-progress-section').style.display = show ? 'block' : 'none';
    }

    function showStreamSection(show) {
        document.getElementById('ttw-stream-section').style.display = show ? 'block' : 'none';
    }

    function showResultSection(show) {
        document.getElementById('ttw-result-section').style.display = show ? 'block' : 'none';
    }

    function updateProgress(percent, text) {
        document.getElementById('ttw-progress-fill').style.width = `${percent}%`;
        document.getElementById('ttw-progress-text').textContent = text;
        
        const failedCount = memoryQueue.filter(m => m.failed === true).length;
        const repairBtn = document.getElementById('ttw-repair-btn');
        if (failedCount > 0) {
            repairBtn.style.display = 'inline-block';
            repairBtn.textContent = `🔧 Repair Failed (${failedCount})`;
        } else {
            repairBtn.style.display = 'none';
        }
    }

    function updateMemoryQueueUI() {
        const container = document.getElementById('ttw-memory-queue');
        container.innerHTML = '';

        memoryQueue.forEach((memory, index) => {
            const item = document.createElement('div');
            item.className = 'ttw-memory-item';
            if (memory.processed) item.classList.add('processed');
            if (memory.failed) item.classList.add('failed');
            
            let statusIcon = '⏳';
            if (memory.processed) statusIcon = '✅';
            if (memory.failed) statusIcon = '❗';
            
            item.innerHTML = `
                <span>${statusIcon}</span>
                <span>${memory.title}</span>
                <small>(${memory.content.length.toLocaleString()} chars)</small>
            `;
            container.appendChild(item);
        });
    }

    function updateWorldbookPreview() {
        const container = document.getElementById('ttw-result-preview');
        container.innerHTML = formatWorldbookAsCards(generatedWorldbook);
    }

    function formatWorldbookAsCards(worldbook) {
        if (!worldbook || Object.keys(worldbook).length === 0) {
            return '<div style="text-align: center; color: #888; padding: 20px;">No worldbook data</div>';
        }

        let html = '';
        let totalEntries = 0;

        for (const category in worldbook) {
            const entries = worldbook[category];
            const entryCount = typeof entries === 'object' ? Object.keys(entries).length : 0;
            
            if (entryCount === 0) continue;
            
            totalEntries += entryCount;

            html += `
            <div class="ttw-category-card" data-category="${category}">
                <div class="ttw-category-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
                    <span>📁 ${category}</span>
                    <span style="font-size: 12px;">${entryCount} entries</span>
                </div>
                <div class="ttw-category-content">`;

            if (typeof entries === 'object') {
                for (const entryName in entries) {
                    const entry = entries[entryName];

                    html += `
                    <div class="ttw-entry-card">
                        <div class="ttw-entry-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
                            <span>📄 ${entryName}</span>
                            <span style="font-size: 11px;">▼</span>
                        </div>
                        <div class="ttw-entry-content">`;

                    if (entry && typeof entry === 'object') {
                        const keywords = entry['关键词'] || entry.keywords;
                        const content = entry['内容'] || entry.content;
                        
                        if (keywords) {
                            const keywordsStr = Array.isArray(keywords) ? keywords.join(', ') : keywords;
                            html += `
                            <div class="ttw-keywords">
                                <div style="color: #9b59b6; font-size: 11px; margin-bottom: 4px;">🔑 Keywords</div>
                                <div style="font-size: 13px;">${keywordsStr}</div>
                            </div>`;
                        }

                        if (content) {
                            const contentHtml = String(content)
                                .replace(/</g, '&lt;')
                                .replace(/>/g, '&gt;')
                                .replace(/\*\*(.+?)\*\*/g, '<strong style="color: #3498db;">$1</strong>')
                                .replace(/\n/g, '<br>');
                            html += `
                            <div class="ttw-content-text">
                                <div style="color: #27ae60; font-size: 11px; margin-bottom: 4px;">📝 Content</div>
                                <div style="font-size: 13px;">${contentHtml}</div>
                            </div>`;
                        }
                    }

                    html += `
                        </div>
                    </div>`;
                }
            }

            html += `
                </div>
            </div>`;
        }

        return `<div style="margin-bottom: 12px; font-size: 13px;">Total ${Object.keys(worldbook).filter(k => Object.keys(worldbook[k]).length > 0).length} categories, ${totalEntries} entries</div>` + html;
    }

    function showWorldbookView() {
        const existingModal = document.getElementById('ttw-worldbook-view-modal');
        if (existingModal) existingModal.remove();

        const viewModal = document.createElement('div');
        viewModal.id = 'ttw-worldbook-view-modal';
        viewModal.className = 'ttw-modal-container';
        viewModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📖 Worldbook Detail View</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    ${formatWorldbookAsCards(generatedWorldbook)}
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn" id="ttw-close-worldbook-view">Close</button>
                </div>
            </div>
        `;

        document.body.appendChild(viewModal);

        viewModal.querySelector('.ttw-modal-close').addEventListener('click', () => viewModal.remove());
        viewModal.querySelector('#ttw-close-worldbook-view').addEventListener('click', () => viewModal.remove());
        viewModal.addEventListener('click', (e) => {
            if (e.target === viewModal) viewModal.remove();
        });
    }

    async function showHistoryView() {
        const existingModal = document.getElementById('ttw-history-modal');
        if (existingModal) existingModal.remove();

        let historyList = [];
        try {
            await MemoryHistoryDB.cleanDuplicateHistory();
            historyList = await MemoryHistoryDB.getAllHistory();
        } catch (e) {
            console.error('Failed to get history:', e);
        }

        const historyModal = document.createElement('div');
        historyModal.id = 'ttw-history-modal';
        historyModal.className = 'ttw-modal-container';
        historyModal.innerHTML = `
            <div class="ttw-modal" style="max-width: 900px;">
                <div class="ttw-modal-header">
                    <span class="ttw-modal-title">📜 Edit History (${historyList.length} records)</span>
                    <button class="ttw-modal-close" type="button">✕</button>
                </div>
                <div class="ttw-modal-body">
                    <div style="display: flex; gap: 15px; height: 400px;">
                        <div style="width: 250px; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 10px;">
                            ${generateHistoryListHTML(historyList)}
                        </div>
                        <div id="ttw-history-detail" style="flex: 1; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 8px; padding: 15px;">
                            <div style="text-align: center; color: #888; padding: 40px;">👈 Click history record on the left to view details</div>
                        </div>
                    </div>
                </div>
                <div class="ttw-modal-footer">
                    <button class="ttw-btn ttw-btn-warning" id="ttw-clear-history">🗑️ Clear History</button>
                    <button class="ttw-btn" id="ttw-close-history">Close</button>
                </div>
            </div>
        `;

        document.body.appendChild(historyModal);

        historyModal.querySelector('.ttw-modal-close').addEventListener('click', () => historyModal.remove());
        historyModal.querySelector('#ttw-close-history').addEventListener('click', () => historyModal.remove());
        historyModal.querySelector('#ttw-clear-history').addEventListener('click', async () => {
            if (confirm('Are you sure you want to clear all history?')) {
                await MemoryHistoryDB.clearAllHistory();
                historyModal.remove();
                showHistoryView();
            }
        });
        historyModal.addEventListener('click', (e) => {
            if (e.target === historyModal) historyModal.remove();
        });

        historyModal.querySelectorAll('.ttw-history-item').forEach(item => {
            item.addEventListener('click', async () => {
                const historyId = parseInt(item.dataset.historyId);
                await showHistoryDetail(historyId, historyModal);
                
                historyModal.querySelectorAll('.ttw-history-item').forEach(i => i.style.background = 'rgba(0,0,0,0.2)');
                item.style.background = 'rgba(0,0,0,0.4)';
            });
        });
    }

    function generateHistoryListHTML(historyList) {
        if (historyList.length === 0) {
            return '<div style="text-align: center; color: #888; padding: 20px;">No history records</div>';
        }

        const sortedList = [...historyList].sort((a, b) => b.timestamp - a.timestamp);
        
        let html = '';
        sortedList.forEach((history) => {
            const time = new Date(history.timestamp).toLocaleString('en-US', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
            const changeCount = history.changedEntries?.length || 0;
            
            html += `
            <div class="ttw-history-item" data-history-id="${history.id}" style="background: rgba(0,0,0,0.2); border-radius: 6px; padding: 10px; margin-bottom: 8px; cursor: pointer; border-left: 3px solid #9b59b6;">
                <div style="font-weight: bold; color: #e67e22; font-size: 13px; margin-bottom: 4px;">
                    📝 ${history.memoryTitle || `Memory ${history.memoryIndex + 1}`}
                </div>
                <div style="font-size: 11px; color: #888;">${time}</div>
                <div style="font-size: 11px; color: #aaa; margin-top: 4px;">${changeCount} changes</div>
            </div>`;
        });

        return html;
    }

    async function showHistoryDetail(historyId, modal) {
        const detailContainer = modal.querySelector('#ttw-history-detail');
        const history = await MemoryHistoryDB.getHistoryById(historyId);
        
        if (!history) {
            detailContainer.innerHTML = '<div style="text-align: center; color: #e74c3c; padding: 40px;">History record not found</div>';
            return;
        }

        const time = new Date(history.timestamp).toLocaleString('en-US');
        
        let html = `
        <div style="margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid #444;">
            <h4 style="color: #e67e22; margin: 0 0 10px 0;">📝 ${history.memoryTitle || `Memory ${history.memoryIndex + 1}`}</h4>
            <div style="font-size: 12px; color: #888;">Time: ${time}</div>
            <div style="margin-top: 10px;">
                <button class="ttw-btn ttw-btn-warning ttw-btn-small" onclick="window.TxtToWorldbook._rollbackToHistory(${historyId})">⏪ Rollback to this version</button>
            </div>
        </div>
        <div style="font-size: 14px; font-weight: bold; color: #9b59b6; margin-bottom: 10px;">Changes (${history.changedEntries?.length || 0})</div>
        `;

        if (history.changedEntries && history.changedEntries.length > 0) {
            history.changedEntries.forEach(change => {
                const typeIcon = change.type === 'add' ? '➕ Added' : change.type === 'modify' ? '✏️ Modified' : '❌ Deleted';
                const typeColor = change.type === 'add' ? '#27ae60' : change.type === 'modify' ? '#3498db' : '#e74c3c';
                
                html += `
                <div style="background: rgba(0,0,0,0.2); border-radius: 6px; padding: 12px; margin-bottom: 10px; border-left: 3px solid ${typeColor};">
                    <div style="margin-bottom: 8px;">
                        <span style="color: ${typeColor}; font-weight: bold;">${typeIcon}</span>
                        <span style="color: #e67e22; margin-left: 8px;">[${change.category}] ${change.entryName}</span>
                    </div>
                    <div style="font-size: 12px; color: #ccc; max-height: 100px; overflow-y: auto;">
                        ${change.newValue ? formatEntryForDisplay(change.newValue) : '<span style="color: #666;">None</span>'}
                    </div>
                </div>`;
            });
        } else {
            html += '<div style="color: #888; text-align: center; padding: 20px;">No change records</div>';
        }

        detailContainer.innerHTML = html;
    }

    function formatEntryForDisplay(entry) {
        if (!entry) return '';
        if (typeof entry === 'string') return entry.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        
        let html = '';
        const keywords = entry['关键词'] || entry.keywords;
        const content = entry['内容'] || entry.content;
        
        if (keywords) {
            const keywordsStr = Array.isArray(keywords) ? keywords.join(', ') : keywords;
            html += `<div style="color: #9b59b6; margin-bottom: 4px;"><strong>Keywords:</strong> ${keywordsStr}</div>`;
        }
        if (content) {
            const contentStr = String(content).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
            html += `<div><strong>Content:</strong> ${contentStr.substring(0, 200)}${contentStr.length > 200 ? '...' : ''}</div>`;
        }
        return html || JSON.stringify(entry);
    }

    async function rollbackToHistory(historyId) {
        if (!confirm('Are you sure you want to rollback to this version?\n\nPage will refresh to ensure correct state.')) {
            return;
        }

        try {
            const history = await MemoryHistoryDB.rollbackToHistory(historyId);
            console.log(`📚 Rolled back to history #${historyId}: ${history.memoryTitle}`);
            
            const rollbackMemoryIndex = history.memoryIndex;
            
            for (let i = 0; i < memoryQueue.length; i++) {
                if (i < rollbackMemoryIndex) {
                    memoryQueue[i].processed = true;
                } else {
                    memoryQueue[i].processed = false;
                    memoryQueue[i].failed = false;
                }
            }
            
            await MemoryHistoryDB.saveState(rollbackMemoryIndex);
            
            alert(`Rollback successful! Page will refresh.`);
            location.reload();
        } catch (error) {
            console.error('Rollback failed:', error);
            alert('Rollback failed: ' + error.message);
        }
    }

    function closeModal() {
        if (modalContainer) {
            modalContainer.remove();
            modalContainer = null;
        }
        document.removeEventListener('keydown', handleEscKey, true);
    }

    function open() {
        createModal();
    }

    // ========== Public API ==========
    window.TxtToWorldbook = {
        open: open,
        close: closeModal,
        _rollbackToHistory: rollbackToHistory,
        getWorldbook: () => generatedWorldbook,
        getMemoryQueue: () => memoryQueue
    };

    console.log('📚 TxtToWorldbook module loaded');
})();
