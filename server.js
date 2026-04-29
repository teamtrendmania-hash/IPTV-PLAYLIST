import http from 'http';
import https from 'https';
import url from 'url';

// Your Xtream Codes credentials
const XTREAM_URL = 'http://servpremium.net:8880/get.php?username=luis747393&password=ZWxyWWjfvFfT&type=m3u_plus';

// Cache the playlist to avoid hitting the portal too often
let cachedPlaylist = null;
let cacheTime = 0;
const CACHE_DURATION = 300000; // 5 minutes

async function fetchPlaylist() {
    return new Promise((resolve, reject) => {
        const parsed = new url.URL(XTREAM_URL);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 80,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Connection': 'keep-alive'
            },
            timeout: 30000
        };
        
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(data);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            });
        });
        
        req.on('error', reject);
        req.end();
    });
}

async function getPlaylist() {
    const now = Date.now();
    if (cachedPlaylist && (now - cacheTime) < CACHE_DURATION) {
        console.log('Serving cached playlist');
        return cachedPlaylist;
    }
    
    console.log('Fetching fresh playlist from portal...');
    const playlist = await fetchPlaylist();
    cachedPlaylist = playlist;
    cacheTime = now;
    return playlist;
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    console.log(`${req.method} ${req.url}`);
    
    // Health check for Render
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }
    
    // Root endpoint - return M3U playlist
    try {
        const playlist = await getPlaylist();
        
        // Optional: Replace stream URLs to go through our proxy (helps with CORS)
        let finalPlaylist = playlist;
        
        // If streams are blocked, uncomment this to proxy them
        // finalPlaylist = playlist.replace(/http:\/\/[^\/]+\//g, `http://${req.headers.host}/proxy?url=`);
        
        res.writeHead(200, {
            'Content-Type': 'application/x-mpegurl',
            'Content-Disposition': 'inline; filename="playlist.m3u"',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(finalPlaylist);
        
    } catch (e) {
        console.error(`Error: ${e.message}`);
        res.writeHead(500);
        res.end(`Error: ${e.message}`);
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`XTREAM CODES PROXY RUNNING`);
    console.log(`========================================`);
    console.log(`Port: ${PORT}`);
    console.log(`\nAdd this URL to TiviMate / VLC:`);
    console.log(`https://your-app.onrender.com`);
    console.log(`========================================\n`);
});
