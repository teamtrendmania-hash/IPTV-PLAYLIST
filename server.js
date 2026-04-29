const http = require('http');
const crypto = require('crypto');
const url = require('url');

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
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Charset': 'UTF-8,*;q=0.8',
        'Connection': 'keep-alive',
        'Cookie': `mac=${config.mac_address}; stb_lang=en; timezone=GMT`,
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

function fetchUrl(urlStr, headers, retries = 2) {
    return new Promise((resolve, reject) => {
        const parsed = new url.URL(urlStr);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 80,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: headers,
            timeout: 20000
        };
        
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve({ status: res.statusCode, data });
                } else if (retries > 0 && (res.statusCode === 403 || res.statusCode === 429)) {
                    setTimeout(() => {
                        fetchUrl(urlStr, headers, retries - 1).then(resolve).catch(reject);
                    }, 2000);
                } else {
                    resolve({ status: res.statusCode, data });
                }
            });
        });
        
        req.on('error', (e) => {
            if (retries > 0) {
                setTimeout(() => {
                    fetchUrl(urlStr, headers, retries - 1).then(resolve).catch(reject);
                }, 2000);
            } else {
                reject(e);
            }
        });
        
        req.end();
    });
}

async function genToken() {
    // Return cached token if still valid (55 minutes)
    if (cachedToken && Date.now() < tokenExpiry) {
        console.log('[Token] Using cached token');
        return cachedToken;
    }
    
    const params = new URLSearchParams({
        type: 'stb', action: 'handshake', JsHttpRequest: '1-xml',
        mac: config.mac_address, sn: config.serial_number,
        stb_type: config.stb_type, device_id: config.device_id, device_id2: config.device_id_2
    });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    
    try {
        const { status, data } = await fetchUrl(urlStr, getHeaders());
        if (status !== 200) return null;
        const jsonData = JSON.parse(data);
        const token = jsonData.js?.token || jsonData.token;
        if (token) {
            cachedToken = token;
            tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 minutes
            console.log(`[Token] New token obtained`);
        }
        return token;
    } catch (e) {
        return null;
    }
}

async function auth(token) {
    const metrics = JSON.stringify({ mac: config.mac_address, sn: config.serial_number, model: config.stb_type, type: 'STB' });
    const params = new URLSearchParams({
        type: 'stb', action: 'get_profile', hd: '1', sn: config.serial_number,
        stb_type: config.stb_type, device_id: config.device_id, device_id2: config.device_id_2,
        hw_version: hw_version, hw_version_2: hw_version_2, api_signature: config.api_signature,
        signature: config.signature, metrics: metrics, JsHttpRequest: '1-xml'
    });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    
    try {
        const { status, data } = await fetchUrl(urlStr, getHeaders(token));
        if (status !== 200) return false;
        const jsonData = JSON.parse(data);
        return !!(jsonData.js || jsonData).id;
    } catch (e) {
        return false;
    }
}

async function getChannels(token) {
    const params = new URLSearchParams({ type: 'itv', action: 'get_all_channels', JsHttpRequest: '1-xml' });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    
    try {
        const { status, data } = await fetchUrl(urlStr, getHeaders(token));
        if (status !== 200) return [];
        const jsonData = JSON.parse(data);
        return jsonData.js?.data || jsonData.js || [];
    } catch (e) {
        return [];
    }
}

async function getGenres(token) {
    const params = new URLSearchParams({ type: 'itv', action: 'get_genres', JsHttpRequest: '1-xml' });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    
    try {
        const { status, data } = await fetchUrl(urlStr, getHeaders(token));
        if (status !== 200) return [];
        const jsonData = JSON.parse(data);
        return jsonData.js || [];
    } catch (e) {
        return [];
    }
}

// Pre-fetch stream URLs for all channels and cache them
let streamUrlCache = new Map();
let isCaching = false;

async function getStreamUrl(token, channelId) {
    // Check cache
    if (streamUrlCache.has(channelId)) {
        return streamUrlCache.get(channelId);
    }
    
    const params = new URLSearchParams({ 
        type: 'itv', 
        action: 'create_link', 
        cmd: `ffrt http://localhost/ch/${channelId}`, 
        JsHttpRequest: '1-xml' 
    });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    
    try {
        const { status, data } = await fetchUrl(urlStr, getHeaders(token));
        if (status !== 200) return null;
        const jsonData = JSON.parse(data);
        const streamUrl = (jsonData.js?.cmd || '').replace(/ffrt\s+/g, '').trim();
        if (streamUrl) {
            streamUrlCache.set(channelId, streamUrl);
        }
        return streamUrl;
    } catch (e) {
        return null;
    }
}

// Cache for playlist
let cachedPlaylist = null;
let playlistCacheTime = 0;
const PLAYLIST_CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 hours

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    
    // Health check
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200);
        res.end('OK');
        return;
    }
    
    // Check if playlist is cached
    if (cachedPlaylist && Date.now() - playlistCacheTime < PLAYLIST_CACHE_DURATION) {
        console.log('[Cache] Serving cached playlist');
        res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' });
        res.end(cachedPlaylist);
        return;
    }
    
    try {
        generateHardwareVersions();
        
        const token = await genToken();
        if (!token) throw new Error('No token');
        
        const authSuccess = await auth(token);
        if (!authSuccess) throw new Error('Auth failed');
        
        const [channels, genres] = await Promise.all([
            getChannels(token),
            getGenres(token)
        ]);
        
        if (!channels || channels.length === 0) throw new Error('No channels');
        
        const categoryMap = {};
        genres.forEach(g => { if (g.id) categoryMap[String(g.id)] = g.title || g.alias; });
        
        // Build category to channel mapping
        const categoryChannels = new Map();
        
        for (const ch of channels) {
            const id = ch.id || ch.channel_id || ch.itv_id;
            if (!id) continue;
            const genreId = String(ch.tv_genre_id || ch.genre_id || ch.category_id || '');
            const groupTitle = categoryMap[genreId] || ch.genre || ch.category || 'TV Channels';
            
            if (!categoryChannels.has(groupTitle)) {
                categoryChannels.set(groupTitle, []);
            }
            categoryChannels.get(groupTitle).push(ch);
        }
        
        // Generate M3U with direct stream URLs (pre-fetch first 10 channels per category)
        let m3u = '#EXTM3U\n';
        let totalChannels = 0;
        
        for (const [groupTitle, groupChannels] of categoryChannels) {
            m3u += `\n# Genre: ${groupTitle}\n`;
            
            for (const ch of groupChannels.slice(0, 100)) { // Limit to 100 per category for performance
                const id = ch.id || ch.channel_id || ch.itv_id;
                const name = ch.name || ch.title || 'Unknown';
                const logo = ch.logo || ch.tvg_logo || '';
                
                // Get stream URL (will be cached)
                const streamUrl = await getStreamUrl(token, id);
                
                if (streamUrl) {
                    m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${name}" tvg-logo="${logo}" group-title="${groupTitle}",${name}\n`;
                    m3u += `${streamUrl}\n`;
                    totalChannels++;
                }
            }
        }
        
        console.log(`Generated ${totalChannels} channels`);
        
        // Cache the playlist
        cachedPlaylist = m3u;
        playlistCacheTime = Date.now();
        
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
    console.log(`URL: http://localhost:${PORT}`);
});
