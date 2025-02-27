import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';

// Config
const app = express();
const PORT = process.env.PORT || 3000;
const QWEN_API_URL = 'https://chat.qwenlm.ai/api/chat/completions';
const QWEN_MODELS_URL = 'https://chat.qwenlm.ai/api/models';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const TIMEOUT_DURATION = 30000;

// Middleware
app.use(express.json());
app.use(cors());

// Cache for models
let modelsCache = {
    data: null,
    timestamp: 0
};
const MODELS_CACHE_TTL = 3600000; // 1 hour

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
    let lastError;
    
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                ...options,
                timeout: TIMEOUT_DURATION
            });
            
            const contentType = response.headers.get('content-type') || '';
            const responseClone = response.clone();
            const responseText = await responseClone.text();
            
            if (contentType.includes('text/html') || response.status === 500) {
                lastError = {
                    status: response.status,
                    contentType,
                    responseText: responseText.slice(0, 1000)
                };
                
                if (i < retries - 1) {
                    await sleep(RETRY_DELAY * Math.pow(2, i));
                    continue;
                }
            }
            
            return {
                status: response.status,
                headers: { 'Content-Type': contentType || 'application/json' },
                text: async () => responseText
            };
        } catch (error) {
            lastError = error;
            if (i < retries - 1) {
                await sleep(RETRY_DELAY * Math.pow(2, i));
                continue;
            }
        }
    }
    
    throw new Error(JSON.stringify({
        error: true,
        message: 'All retry attempts failed',
        lastError,
        retries
    }));
}

async function getModels(authHeader) {
    const now = Date.now();
    if (modelsCache.data && (now - modelsCache.timestamp) < MODELS_CACHE_TTL) {
        return modelsCache.data;
    }
    
    const response = await fetchWithRetry(QWEN_MODELS_URL, {
        headers: { 'Authorization': authHeader }
    });
    
    const data = await response.text();
    modelsCache = {
        data,
        timestamp: now
    };
    return data;
}

// Models endpoint
app.get('/v1/models', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: true,
                message: 'Unauthorized'
            });
        }
        
        const modelsResponse = await getModels(authHeader);
        res.setHeader('Content-Type', 'application/json');
        res.send(modelsResponse);
    } catch (error) {
        console.error('Models error:', error);
        res.status(500).json({
            error: true,
            message: error.message
        });
    }
});

// Chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: true,
                message: 'Unauthorized'
            });
        }
        
        const { messages, stream = false, model, max_tokens } = req.body;
        
        if (!model) {
            return res.status(400).json({
                error: true,
                message: 'Model parameter is required'
            });
        }
        
        const qwenRequest = {
            model,
            messages,
            stream
        };
        
        if (max_tokens !== undefined) {
            qwenRequest.max_tokens = max_tokens;
        }
        
        const response = await fetch(QWEN_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(qwenRequest)
        });
        
        if (!response.ok) {
            throw new Error(`Qwen API error: ${response.status}`);
        }
        
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            
            const reader = response.body.getReader();
            let buffer = '';
            let previousContent = '';
            
            while (true) {
                const { done, value } = await reader.read();
                
                if (done) {
                    res.write('data: [DONE]\n\n');
                    res.end();
                    break;
                }
                
                const chunk = Buffer.from(value).toString('utf8');
                buffer += chunk;
                
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                for (const line of lines) {
                    if (line.trim().startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.choices?.[0]?.delta?.content) {
                                const currentContent = data.choices[0].delta.content;
                                let newContent = currentContent;
                                
                                if (currentContent.startsWith(previousContent) && previousContent.length > 0) {
                                    newContent = currentContent.slice(previousContent.length);
                                }
                                
                                const newData = {
                                    ...data,
                                    choices: [{
                                        ...data.choices[0],
                                        delta: {
                                            ...data.choices[0].delta,
                                            content: newContent
                                        }
                                    }]
                                };
                                
                                res.write(`data: ${JSON.stringify(newData)}\n\n`);
                                previousContent = currentContent;
                            } else {
                                res.write(`data: ${JSON.stringify(data)}\n\n`);
                            }
                        } catch (e) {
                            res.write(`${line}\n\n`);
                        }
                    }
                }
            }
        } else {
            const responseData = await response.text();
            res.setHeader('Content-Type', 'application/json');
            res.send(responseData);
        }
    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({
            error: true,
            message: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
