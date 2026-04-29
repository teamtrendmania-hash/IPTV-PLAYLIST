// server.js - Optimized for Render
import http from 'http';
import crypto from 'crypto';

const config = {
    host: 'tv.max4k.us',
    mac_address: '00:1A:79:00:E2:87',
    serial_number: 'C0E2388EC24FC',
    device_id: '542030086CB2522B38306E042E4682A0AB78641C64ECA9163453146DEF13582D',
    device_id_2: '542030086CB2522B38306E042E4682A0AB78641C64ECA9163453146DEF13582D',
    stb_type: 'MAG270',
    api_signature: '263',
};

let tokenCache = { token: null, expiry: 0 };
let channelCache = { data: null, expiry: 0 };

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // Health check for Render
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }
    
    // Stream proxy
    if (url.searchParams.has('play_id')) {
        return handleStreamRequest(url.searchParams.get('play_id'), res);
    }
    
    // Main M3U endpoint
    if (url.pathname === '/' || url.pathname === '/playlist.m3u') {
        return generatePlaylist(res, `http://${req.headers.host}`);
    }
    
    // Debug endpoint
    if (url.pathname === '/debug') {
        return debugEndpoint(res);
    }
    
    res.writeHead(404);
    res.end('Not Found. Try /debug for diagnostics.');
});

async function generatePlaylist(res, baseUrl) {
    try {
        const token = await getToken();
        if (!token) {
            res.writeHead(500);
            res.end('Failed to authenticate. Visit /debug for details.');
            return;
        }
        
        let channels = channelCache.data;
        if (!channels || Date.now() > channelCache.expiry) {
            channels = await getChannels(token);
            if (channels && channels.length > 0) {
                channelCache = {
                    data: channels,
                    expiry: Date.now() + 60 * 60 * 1000
                };
            }
        }
        
        if (!channels || channels.length === 0) {
            res.writeHead(404);
            res.end('No channels found');
            return;
        }
        
        let m3u = '#EXTM3U\n';
        let count = 0;
        
        for (const channel of channels) {
            const id = channel.id || channel.channel_id;
            if (!id) continue;
            const name = channel.name || channel.title || 'Unknown';
            const logo = channel.logo || '';
            
            m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${name}" tvg-logo="${logo}",${name}\n`;
            m3u += `${baseUrl}/?play_id=${id}\n`;
            count++;
        }
        
        res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' });
        res.end(m3u);
        
    } catch (error) {
        res.writeHead(500);
        res.end(`Error: ${error.message}`);
    }
}

async function getToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiry) {
        return tokenCache.token;
    }
    
    const url = `http://${config.host}/stalker_portal/server/load.php?type=stb&action=handshake&JsHttpRequest=1-xml&mac=${config.mac_address}&sn=${config.serial_number}&stb_type=${config.stb_type}&device_id=${config.device_id}&device_id2=${config.device_id_2}`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250 STB',
                'Cookie': `mac=${config.mac_address}; stb_lang=en; timezone=GMT`,
                'Referer': `http://${config.host}/stalker_portal/c/`,
                'Accept': 'application/json, text/javascript, */*; q=0.01'
            }
        });
        
        if (!response.ok) return null;
        
        const text = await response.text();
        
        if (text.includes('error code') || text.includes('cloudflare')) {
            console.log('Cloudflare protection detected');
            return null;
        }
        
        const data = JSON.parse(text);
        const token = data.js?.token || data.token;
        
        if (token) {
            tokenCache = {
                token: token,
                expiry: Date.now() + 55 * 60 * 1000
            };
            return token;
        }
    } catch (error) {
        console.log(`Token error: ${error.message}`);
    }
    
    return null;
}

async function getChannels(token) {
    const url = `http://${config.host}/stalker_portal/server/load.php?type=itv&action=get_all_channels&JsHttpRequest=1-xml`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250 STB',
                'Authorization': `Bearer ${token}`,
                'Cookie': `mac=${config.mac_address}; stb_lang=en; timezone=GMT`,
                'Referer': `http://${config.host}/stalker_portal/c/`,
            }
        });
        
        if (!response.ok) return [];
        
        const text = await response.text();
        
        if (text.includes('error code')) return [];
        
        const data = JSON.parse(text);
        return data.js?.data || data.js || [];
        
    } catch (error) {
        return [];
    }
}

async function handleStreamRequest(channelId, res) {
    const token = await getToken();
    if (!token) {
        res.writeHead(401);
        res.end('Authentication failed');
        return;
    }
    
    const url = `http://${config.host}/stalker_portal/server/load.php?type=itv&action=create_link&cmd=ffrt%20http://localhost/ch/${channelId}&JsHttpRequest=1-xml`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250 STB',
                'Authorization': `Bearer ${token}`,
                'Cookie': `mac=${config.mac_address}; stb_lang=en; timezone=GMT`,
            }
        });
        
        if (!response.ok) {
            res.writeHead(404);
            res.end('Stream not found');
            return;
        }
        
        const text = await response.text();
        const data = JSON.parse(text);
        const streamUrl = (data.js?.cmd || '').replace(/ffrt\s+/g, '').trim();
        
        if (streamUrl) {
            res.writeHead(302, { 'Location': streamUrl });
            res.end();
        } else {
            res.writeHead(404);
            res.end('No stream URL');
        }
    } catch (error) {
        res.writeHead(500);
        res.end(`Error: ${error.message}`);
    }
}

async function debugEndpoint(res) {
    const token = await getToken();
    let html = '<html><body><h1>Render Debug Info</h1><pre>';
    html += `Token obtained: ${token ? 'YES' : 'NO'}\n`;
    if (token) html += `Token: ${token.substring(0, 20)}...\n\n`;
    
    if (token) {
        const channels = await getChannels(token);
        html += `Channels found: ${channels.length}\n`;
        if (channels.length > 0) {
            html += `\nSample channels:\n`;
            for (let i = 0; i < Math.min(5, channels.length); i++) {
                html += `  - ${channels[i].name} (ID: ${channels[i].id})\n`;
            }
        }
    }
    
    html += '</pre></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Add to TiviMate: https://your-render-url.onrender.com`);
});
