import crypto from 'crypto';
import http from 'http';
import url from 'url';

const config = {
    host: '89.187.191.54',
    mac_address: '00:1A:79:00:00:44',
    serial_number: 'FB9673E993545',
    device_id: 'C9CB1802CB7821F8F5C7BF991022D4938E27C304C1B5801DBB90EA8A18215004',
    device_id_2: '6BB249F5401CAF10FB54F43C842BEF5800938E749BEED2ABC841A1BBC2063087',
    stb_type: 'MAG270',
    api_signature: '263',
    signature: '05500ADBF95D130335B2A1B4D806D7D6798CE4AE68B18BB92C7AFF89F755E366'
};

let hw_version = '';
let hw_version_2 = '';
let cachedToken = null;
let tokenExpiry = 0;
let cachedChannels = null;
let channelCacheTime = 0;

function calcMd5(s) {
    return crypto.createHash('md5').update(s || 'default').digest('hex');
}

function generateHardwareVersions() {
    hw_version = '1.7-BD-' + calcMd5(config.mac_address).substring(0, 2).toUpperCase();
    hw_version_2 = calcMd5((config.serial_number || '').toLowerCase() + config.mac_address.toLowerCase());
}

function getHeaders(token = '') {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250 stbapp ver: 2 rev: 250 Safari/533.3',
        'X-User-Agent': `Model: ${config.stb_type}; Link: WiFi`,
        'Referer': `http://${config.host}/stalker_portal/c/`,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Cookie': `mac=${config.mac_address}; stb_lang=en; timezone=GMT`,
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

function fetchUrl(urlStr, headers) {
    return new Promise((resolve, reject) => {
        const parsed = new url.URL(urlStr);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 80,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: headers,
            timeout: 10000
        };
        
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiry) {
        return cachedToken;
    }
    
    const params = new URLSearchParams({
        type: 'stb', action: 'handshake', JsHttpRequest: '1-xml',
        mac: config.mac_address, sn: config.serial_number,
        stb_type: config.stb_type, device_id: config.device_id, device_id2: config.device_id_2
    });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    
    try {
        const { data } = await fetchUrl(urlStr, getHeaders());
        const jsonData = JSON.parse(data);
        const token = jsonData.js?.token || jsonData.token;
        if (token) {
            cachedToken = token;
            tokenExpiry = Date.now() + 55 * 60 * 1000;
            console.log('Token obtained successfully');
        }
        return token;
    } catch (e) {
        console.error('Token error:', e.message);
        return null;
    }
}

async function getChannels(token) {
    if (cachedChannels && Date.now() - channelCacheTime < 60 * 60 * 1000) {
        return cachedChannels;
    }
    
    const params = new URLSearchParams({ type: 'itv', action: 'get_all_channels', JsHttpRequest: '1-xml' });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    
    try {
        const { data } = await fetchUrl(urlStr, getHeaders(token));
        const jsonData = JSON.parse(data);
        const channels = jsonData.js?.data || jsonData.js || [];
        cachedChannels = channels;
        channelCacheTime = Date.now();
        console.log(`Found ${channels.length} channels`);
        return channels;
    } catch (e) {
        console.error('Channels error:', e.message);
        return [];
    }
}

async function getStreamUrl(token, channelId) {
    const params = new URLSearchParams({ 
        type: 'itv', 
        action: 'create_link', 
        cmd: `ffrt http://localhost/ch/${channelId}`, 
        JsHttpRequest: '1-xml' 
    });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    
    try {
        const { data } = await fetchUrl(urlStr, getHeaders(token));
        const jsonData = JSON.parse(data);
        const streamUrl = (jsonData.js?.cmd || '').replace(/ffrt\s+/g, '').trim();
        return streamUrl || null;
    } catch (e) {
        return null;
    }
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    console.log(`${req.method} ${req.url}`);
    
    // Health check for Render
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200);
        res.end('OK');
        return;
    }
    
    // Stream proxy
    if (parsedUrl.pathname === '/stream' && parsedUrl.query.id) {
        try {
            generateHardwareVersions();
            const token = await getToken();
            if (!token) throw new Error('No token');
            const streamUrl = await getStreamUrl(token, parsedUrl.query.id);
            if (streamUrl && streamUrl.startsWith('http')) {
                res.writeHead(302, { 'Location': streamUrl });
                res.end();
            } else {
                res.writeHead(404);
                res.end('Stream not found');
            }
        } catch (e) {
            res.writeHead(500);
            res.end(`Error: ${e.message}`);
        }
        return;
    }
    
    // Main M3U endpoint
    try {
        generateHardwareVersions();
        const token = await getToken();
        if (!token) throw new Error('Failed to get token');
        
        const channels = await getChannels(token);
        
        let m3u = '#EXTM3U\n';
        let count = 0;
        
        for (const ch of channels) {
            const id = ch.id || ch.channel_id || ch.itv_id;
            if (!id) continue;
            const name = ch.name || ch.title || 'Unknown';
            const logo = ch.logo || '';
            
            m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${name}" tvg-logo="${logo}",${name}\n`;
            m3u += `https://${req.headers.host}/stream?id=${id}\n`;
            count++;
        }
        
        console.log(`Served ${count} channels`);
        res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' });
        res.end(m3u);
        
    } catch (e) {
        console.error(`Error: ${e.message}`);
        res.writeHead(500);
        res.end(`Error: ${e.message}`);
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`URL: https://your-app.onrender.com`);
});
