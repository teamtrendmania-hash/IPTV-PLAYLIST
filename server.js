// ============ RENDER COMPATIBLE STALKER PROXY ============
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
    signature: '542030086CB2522B38306E042E4682A0AB78641C64ECA9163453146DEF13582D',
};

// Cache to reduce requests
let cachedToken = null;
let tokenExpiry = 0;
let cachedChannels = null;
let channelsExpiry = 0;
let cachedPlaylist = null;
let playlistExpiry = 0;

// MD5 hash for Node.js
function calculateMD5(message) {
    return crypto.createHash('md5').update(message).digest('hex');
}

function generateHardwareVersion(mac) {
    const macClean = mac.replace(/:/g, '');
    const hash = calculateMD5(macClean);
    return `1.7-BD-${hash.substring(0, 2).toUpperCase()}`;
}

function generateHardwareVersion2(serial, mac) {
    const combined = (serial + mac).toLowerCase();
    return calculateMD5(combined);
}

async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.status === 429 && i < retries - 1) {
                await new Promise(r => setTimeout(r, 2000 * (i + 1)));
                continue;
            }
            return response;
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

async function getToken() {
    // Check cache
    if (cachedToken && Date.now() < tokenExpiry) {
        return cachedToken;
    }
    
    const hw_version = generateHardwareVersion(config.mac_address);
    const hw_version_2 = generateHardwareVersion2(config.serial_number, config.mac_address);
    
    const handshakeUrl = `http://${config.host}/stalker_portal/server/load.php?type=stb&action=handshake&JsHttpRequest=1-xml&mac=${config.mac_address}&sn=${config.serial_number}&stb_type=${config.stb_type}&device_id=${config.device_id}&device_id2=${config.device_id_2}`;
    
    const response = await fetchWithRetry(handshakeUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250 STB',
            'Cookie': `mac=${config.mac_address}; stb_lang=en; timezone=GMT`,
            'Referer': `http://${config.host}/stalker_portal/c/`,
        }
    });
    
    const text = await response.text();
    let token = null;
    
    try {
        const data = JSON.parse(text);
        token = data.js?.token || data.token;
    } catch(e) {
        console.error('Token parse error:', e.message);
        return null;
    }
    
    if (!token) {
        return null;
    }
    
    // Authenticate with profile
    const metrics = JSON.stringify({
        mac: config.mac_address,
        sn: config.serial_number,
        model: config.stb_type,
        type: 'STB'
    });
    
    const profileUrl = `http://${config.host}/stalker_portal/server/load.php?type=stb&action=get_profile&hd=1&sn=${config.serial_number}&stb_type=${config.stb_type}&device_id=${config.device_id}&device_id2=${config.device_id_2}&hw_version=${hw_version}&hw_version_2=${hw_version_2}&api_signature=${config.api_signature}&signature=${config.signature}&metrics=${encodeURIComponent(metrics)}&JsHttpRequest=1-xml`;
    
    await fetchWithRetry(profileUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250 STB',
            'Authorization': `Bearer ${token}`,
            'Cookie': `mac=${config.mac_address}; stb_lang=en; timezone=GMT`,
            'Referer': `http://${config.host}/stalker_portal/c/`,
        }
    });
    
    // Cache token for 50 minutes
    cachedToken = token;
    tokenExpiry = Date.now() + 50 * 60 * 1000;
    
    return token;
}

async function getGenres(token) {
    const url = `http://${config.host}/stalker_portal/server/load.php?type=itv&action=get_genres&JsHttpRequest=1-xml`;
    
    const response = await fetchWithRetry(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250 STB',
            'Authorization': `Bearer ${token}`,
            'Cookie': `mac=${config.mac_address}; stb_lang=en; timezone=GMT`,
            'Referer': `http://${config.host}/stalker_portal/c/`,
        }
    });
    
    const text = await response.text();
    const data = JSON.parse(text);
    return data.js || [];
}

async function getChannels(token) {
    // Check cache
    if (cachedChannels && Date.now() < channelsExpiry) {
        return cachedChannels;
    }
    
    const url = `http://${config.host}/stalker_portal/server/load.php?type=itv&action=get_all_channels&JsHttpRequest=1-xml`;
    
    const response = await fetchWithRetry(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250 STB',
            'Authorization': `Bearer ${token}`,
            'Cookie': `mac=${config.mac_address}; stb_lang=en; timezone=GMT`,
            'Referer': `http://${config.host}/stalker_portal/c/`,
            'X-User-Agent': `Model: ${config.stb_type}; Link: WiFi`,
        }
    });
    
    const text = await response.text();
    
    if (text.includes('Unauthorized')) {
        // Token expired, clear cache
        cachedToken = null;
        tokenExpiry = 0;
        return [];
    }
    
    const data = JSON.parse(text);
    const channels = data.js?.data || data.js || [];
    
    // Add categories to channels
    const genres = await getGenres(token);
    const categoryMap = {};
    if (Array.isArray(genres)) {
        genres.forEach(g => {
            if (g.id) categoryMap[String(g.id)] = g.title || g.alias;
        });
    }
    
    for (const channel of channels) {
        const genreId = String(channel.tv_genre_id || channel.genre_id || channel.category_id || '');
        channel.category = categoryMap[genreId] || channel.genre || 'Uncategorized';
    }
    
    // Cache for 1 hour
    cachedChannels = channels;
    channelsExpiry = Date.now() + 60 * 60 * 1000;
    
    return channels;
}

async function generatePlaylistResponse(baseUrl) {
    // Check cached playlist
    if (cachedPlaylist && Date.now() < playlistExpiry) {
        return cachedPlaylist;
    }
    
    const token = await getToken();
    if (!token) {
        return null;
    }
    
    const channels = await getChannels(token);
    if (channels.length === 0) {
        return null;
    }
    
    let m3u = '#EXTM3U\n';
    
    // Add custom channel
    m3u += `#EXTINF:-1 group-title="Created By Roman Mujahid: Bufferless Streams",Credits To Roman Mujahid\n`;
    m3u += `https://dl.dropboxusercontent.com/scl/fi/o86dfayl0zbc106lsm14m/Untitled-design.ts?rlkey=0w7t77ixlbhw5s7h7xb9bi656&st=qbjkvvho&raw=1\n`;
    
    // Add separator
    if (channels.length > 0) {
        m3u += `\n#EXTINF:-1 group-title="────────── IPTV Channels ──────────",────────── IPTV Channels ──────────\n`;
    }
    
    // Add all channels
    for (const channel of channels) {
        const id = channel.id || channel.channel_id;
        if (!id) continue;
        const name = channel.name || channel.title || 'Unknown';
        const logo = channel.logo || '';
        const category = channel.category || 'Uncategorized';
        
        m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${name}" tvg-logo="${logo}" group-title="${category}",${name}\n`;
        m3u += `${baseUrl}/?play_id=${id}\n`;
    }
    
    // Cache for 5 minutes
    cachedPlaylist = m3u;
    playlistExpiry = Date.now() + 5 * 60 * 1000;
    
    return m3u;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
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
    
    // Debug endpoint
    if (url.pathname === '/debug') {
        const token = await getToken();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            token: token ? `${token.substring(0, 20)}...` : null,
            channels: cachedChannels ? cachedChannels.length : 0,
            cacheValid: cachedChannels && Date.now() < channelsExpiry
        }));
        return;
    }
    
    // Stream request
    if (url.searchParams.has('play_id')) {
        const token = await getToken();
        if (!token) {
            res.writeHead(401);
            res.end('Auth failed');
            return;
        }
        
        const streamUrl = `http://${config.host}/stalker_portal/server/load.php?type=itv&action=create_link&cmd=ffrt%20http://localhost/ch/${url.searchParams.get('play_id')}&JsHttpRequest=1-xml`;
        
        const response = await fetchWithRetry(streamUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250 STB',
                'Authorization': `Bearer ${token}`,
                'Cookie': `mac=${config.mac_address}; stb_lang=en; timezone=GMT`,
                'Referer': `http://${config.host}/stalker_portal/c/`,
            }
        });
        
        if (!response.ok) {
            res.writeHead(404);
            res.end('Stream not found');
            return;
        }
        
        const text = await response.text();
        try {
            const data = JSON.parse(text);
            const streamUrlResult = (data.js?.cmd || '').replace(/ffrt\s+/g, '').trim();
            if (streamUrlResult) {
                res.writeHead(302, { 'Location': streamUrlResult });
                res.end();
                return;
            }
        } catch(e) {}
        
        res.writeHead(404);
        res.end('No stream URL');
        return;
    }
    
    // Main playlist endpoint
    if (url.pathname === '/' || url.pathname === '/playlist.m3u') {
        const m3u = await generatePlaylistResponse(`http://${req.headers.host}`);
        
        if (!m3u) {
            res.writeHead(500);
            res.end('Authentication failed. Visit /debug');
            return;
        }
        
        res.writeHead(200, {
            'Content-Type': 'application/x-mpegurl',
            'Cache-Control': 'public, max-age=3600'
        });
        res.end(m3u);
        return;
    }
    
    res.writeHead(404);
    res.end('Not Found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`STALKER PROXY RUNNING`);
    console.log(`========================================`);
    console.log(`Port: ${PORT}`);
    console.log(`URL: http://localhost:${PORT}`);
    console.log(`\nAdd to TiviMate: http://localhost:${PORT}`);
    console.log(`========================================\n`);
});
