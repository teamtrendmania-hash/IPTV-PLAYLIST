const http = require('http');
const crypto = require('crypto');
const url = require('url');

const config = {
    host: 'tv.plat4k.tv',
    mac_address: '00:1A:79:00:04:04',
    serial_number: 'AF130C6FE418A',
    device_id: '2B07007A2490C046C0836093B982C8917DF263B1900AF6ACC936818D8500092F',
    device_id_2: '2B07007A2490C046C0836093B982C8917DF263B1900AF6ACC936818D8500092F',
    stb_type: 'MAG250',
    api_signature: '263',
};

let hw_version = '';
let hw_version_2 = '';

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
        'Connection': 'keep-alive',
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
            timeout: 15000
        };
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', (e) => reject(new Error(`Fetch error: ${e.message}`)));
        req.end();
    });
}

async function genToken() {
    const params = new URLSearchParams({
        type: 'stb', action: 'handshake', JsHttpRequest: '1-xml',
        mac: config.mac_address, sn: config.serial_number,
        stb_type: config.stb_type, device_id: config.device_id, device_id2: config.device_id_2
    });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    console.log(`[genToken] Requesting: ${urlStr.substring(0, 100)}...`);
    
    try {
        const { status, data } = await fetchUrl(urlStr, getHeaders());
        console.log(`[genToken] Response status: ${status}`);
        console.log(`[genToken] Response preview: ${data.substring(0, 200)}`);
        
        if (status !== 200) {
            console.error(`[genToken] HTTP ${status}`);
            return null;
        }
        
        const jsonData = JSON.parse(data);
        const token = jsonData.js?.token || jsonData.token;
        console.log(`[genToken] Token obtained: ${token ? token.substring(0, 20) + '...' : 'null'}`);
        return token;
    } catch (e) {
        console.error(`[genToken] Error: ${e.message}`);
        return null;
    }
}

async function auth(token) {
    const metrics = JSON.stringify({ mac: config.mac_address, sn: config.serial_number, model: config.stb_type, type: 'STB' });
    const params = new URLSearchParams({
        type: 'stb', action: 'get_profile', hd: '1', sn: config.serial_number,
        stb_type: config.stb_type, device_id: config.device_id, device_id2: config.device_id_2,
        hw_version: hw_version, hw_version_2: hw_version_2, api_signature: config.api_signature,
        metrics: metrics, JsHttpRequest: '1-xml'
    });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    console.log(`[auth] Authenticating...`);
    
    try {
        const { status, data } = await fetchUrl(urlStr, getHeaders(token));
        console.log(`[auth] Response status: ${status}`);
        console.log(`[auth] Response preview: ${data.substring(0, 200)}`);
        
        if (status !== 200) return false;
        const jsonData = JSON.parse(data);
        const hasId = !!(jsonData.js || jsonData).id;
        console.log(`[auth] Success: ${hasId}`);
        return hasId;
    } catch (e) {
        console.error(`[auth] Error: ${e.message}`);
        return false;
    }
}

async function getChannels(token) {
    const params = new URLSearchParams({ type: 'itv', action: 'get_all_channels', JsHttpRequest: '1-xml' });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    console.log(`[getChannels] Fetching channels...`);
    
    try {
        const { status, data } = await fetchUrl(urlStr, getHeaders(token));
        if (status !== 200) {
            console.error(`[getChannels] HTTP ${status}`);
            return [];
        }
        const jsonData = JSON.parse(data);
        const channels = jsonData.js?.data || jsonData.js || [];
        console.log(`[getChannels] Found ${channels.length} channels`);
        return channels;
    } catch (e) {
        console.error(`[getChannels] Error: ${e.message}`);
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

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    console.log(`[Request] ${req.method} ${req.url}`);
    
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200);
        res.end('OK');
        return;
    }
    
    try {
        generateHardwareVersions();
        
        const token = await genToken();
        if (!token) {
            console.error('[Error] Failed to get token');
            res.writeHead(500);
            res.end('Failed to authenticate with portal');
            return;
        }
        
        const authSuccess = await auth(token);
        if (!authSuccess) {
            console.error('[Error] Authentication failed');
            res.writeHead(500);
            res.end('Authentication failed');
            return;
        }
        
        const [channels, genres] = await Promise.all([
            getChannels(token),
            getGenres(token)
        ]);
        
        if (!channels || channels.length === 0) {
            console.error('[Error] No channels found');
            res.writeHead(500);
            res.end('No channels found from portal');
            return;
        }
        
        const categoryMap = {};
        genres.forEach(g => { if (g.id) categoryMap[String(g.id)] = g.title || g.alias; });
        
        let m3u = '#EXTM3U\n';
        let channelCount = 0;
        
        for (const ch of channels) {
            const id = ch.id || ch.channel_id || ch.itv_id;
            if (!id) continue;
            const name = ch.name || ch.title || 'Unknown';
            const genreId = String(ch.tv_genre_id || ch.genre_id || ch.category_id || '');
            const groupTitle = categoryMap[genreId] || ch.genre || ch.category || 'TV Channels';
            const logo = ch.logo || ch.tvg_logo || '';
            m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${name}" tvg-logo="${logo}" group-title="${groupTitle}",${name}\n`;
            m3u += `${process.env.RENDER_EXTERNAL_URL || `https://iptv-playlist-bbre.onrender.com`}/?play_id=${id}\n`;
            channelCount++;
        }
        
        console.log(`[Success] Generated playlist with ${channelCount} channels`);
        res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' });
        res.end(m3u);
        
    } catch (e) {
        console.error(`[Fatal Error] ${e.message}`);
        res.writeHead(500);
        res.end(`Error: ${e.message}`);
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
