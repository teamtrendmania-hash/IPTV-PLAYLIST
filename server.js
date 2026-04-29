const http = require('http');
const https = require('https');
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
        req.on('error', reject);
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
    try {
        const { data } = await fetchUrl(urlStr, getHeaders());
        const jsonData = JSON.parse(data);
        return jsonData.js?.token || jsonData.token || null;
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
        metrics: metrics, JsHttpRequest: '1-xml'
    });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    try {
        const { data } = await fetchUrl(urlStr, getHeaders(token));
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
        const { data } = await fetchUrl(urlStr, getHeaders(token));
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
        const { data } = await fetchUrl(urlStr, getHeaders(token));
        const jsonData = JSON.parse(data);
        return jsonData.js || [];
    } catch (e) {
        return [];
    }
}

async function getStreamUrl(token, channelId) {
    const params = new URLSearchParams({ type: 'itv', action: 'create_link', cmd: `ffrt http://localhost/ch/${channelId}`, JsHttpRequest: '1-xml' });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    try {
        const { data } = await fetchUrl(urlStr, getHeaders(token));
        const jsonData = JSON.parse(data);
        return (jsonData.js?.cmd || '').replace(/ffrt\s+/g, '').trim();
    } catch (e) {
        return null;
    }
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200);
        res.end('OK');
        return;
    }
    
    if (parsedUrl.pathname === '/' && parsedUrl.query.play_id) {
        try {
            generateHardwareVersions();
            const token = await genToken();
            if (!token) { res.writeHead(401); res.end('Auth failed'); return; }
            await auth(token);
            const streamUrl = await getStreamUrl(token, parsedUrl.query.play_id);
            if (streamUrl) {
                res.writeHead(302, { 'Location': streamUrl });
                res.end();
            } else {
                res.writeHead(404);
                res.end('Stream not found');
            }
        } catch (e) {
            res.writeHead(500);
            res.end('Error');
        }
        return;
    }
    
    try {
        generateHardwareVersions();
        const token = await genToken();
        if (!token) { throw new Error('No token'); }
        await auth(token);
        const [channels, genres] = await Promise.all([getChannels(token), getGenres(token)]);
        
        const categoryMap = {};
        genres.forEach(g => { if (g.id) categoryMap[String(g.id)] = g.title || g.alias; });
        
        let m3u = '#EXTM3U\n';
        for (const ch of channels) {
            const id = ch.id || ch.channel_id || ch.itv_id;
            if (!id) continue;
            const name = ch.name || ch.title || 'Unknown';
            const genreId = String(ch.tv_genre_id || ch.genre_id || ch.category_id || '');
            const groupTitle = categoryMap[genreId] || ch.genre || ch.category || 'TV Channels';
            const logo = ch.logo || ch.tvg_logo || '';
            m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${name}" tvg-logo="${logo}" group-title="${groupTitle}",${name}\n`;
            m3u += `${process.env.RENDER_EXTERNAL_URL || `http://localhost:3000`}/?play_id=${id}\n`;
        }
        
        res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' });
        res.end(m3u);
    } catch (e) {
        res.writeHead(500);
        res.end(`Error: ${e.message}`);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));