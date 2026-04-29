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
                    console.log(`Retry ${retries}...`);
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
                console.log(`Retry ${retries}...`);
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
    const params = new URLSearchParams({
        type: 'stb', action: 'handshake', JsHttpRequest: '1-xml',
        mac: config.mac_address, sn: config.serial_number,
        stb_type: config.stb_type, device_id: config.device_id, device_id2: config.device_id_2
    });
    const urlStr = `http://${config.host}/stalker_portal/server/load.php?${params}`;
    console.log(`[Token] Requesting...`);
    
    try {
        const { status, data } = await fetchUrl(urlStr, getHeaders());
        console.log(`[Token] Status: ${status}`);
        
        if (status !== 200) {
            console.log(`[Token] Failed with status ${status}`);
            return null;
        }
        
        const jsonData = JSON.parse(data);
        const token = jsonData.js?.token || jsonData.token;
        console.log(`[Token] Success: ${token ? token.substring(0,20)+'...' : 'null'}`);
        return token;
    } catch (e) {
        console.error(`[Token] Error: ${e.message}`);
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

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    
    // Health check
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200);
        res.end('OK');
        return;
    }
    
    // Root endpoint - return M3U
    try {
        generateHardwareVersions();
        
        const token = await genToken();
        if (!token) throw new Error('No token - portal may be blocking');
        
        const authSuccess = await auth(token);
        if (!authSuccess) throw new Error('Authentication failed');
        
        const [channels, genres] = await Promise.all([
            getChannels(token),
            getGenres(token)
        ]);
        
        if (!channels || channels.length === 0) throw new Error('No channels found');
        
        const categoryMap = {};
        genres.forEach(g => { if (g.id) categoryMap[String(g.id)] = g.title || g.alias; });
        
        let m3u = '#EXTM3U\n';
        let count = 0;
        
        for (const ch of channels) {
            const id = ch.id || ch.channel_id || ch.itv_id;
            if (!id) continue;
            const name = ch.name || ch.title || 'Unknown';
            const genreId = String(ch.tv_genre_id || ch.genre_id || ch.category_id || '');
            const groupTitle = categoryMap[genreId] || ch.genre || ch.category || 'TV Channels';
            const logo = ch.logo || ch.tvg_logo || '';
            m3u += `#EXTINF:-1 tvg-id="${id}" tvg-name="${name}" tvg-logo="${logo}" group-title="${groupTitle}",${name}\n`;
            m3u += `http://${config.host}/stalker_portal/server/load.php?type=itv&action=create_link&cmd=ffrt%20http://localhost/ch/${id}&JsHttpRequest=1-xml&Authorization=Bearer%20${token}\n`;
            count++;
        }
        
        console.log(`Success: ${count} channels generated`);
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
